-- Counter Block 5: pickup operation
-- Date: 2026-07-26
--
-- Scope:
-- - correct a pickup schedule before it is ready;
-- - send a scheduled Counter pickup to kitchen exactly once;
-- - add, reduce or remove pickup items with canonical repricing;
-- - require Master/Admin approval when the pickup is already ready/packed;
-- - complete the physical pickup with the canonical financial blocking rules.

begin;

create table public.counter_pickup_change_requests (
  id bigint generated always as identity primary key,
  order_id bigint not null
    references public.orders(id) on update restrict on delete restrict,
  requested_by_user_id uuid not null
    references auth.users(id) on delete restrict,
  reason text not null,
  request_payload jsonb not null,
  base_signature text not null,
  status text not null default 'pending',
  requested_at timestamptz not null default now(),
  reviewed_by_user_id uuid null
    references auth.users(id) on delete restrict,
  reviewed_at timestamptz null,
  review_notes text null,
  applied_at timestamptz null,
  result_payload jsonb null,
  constraint counter_pickup_change_requests_reason_ck
    check (char_length(btrim(reason)) between 4 and 1200),
  constraint counter_pickup_change_requests_payload_ck
    check (jsonb_typeof(request_payload) = 'object'),
  constraint counter_pickup_change_requests_signature_ck
    check (nullif(btrim(base_signature), '') is not null),
  constraint counter_pickup_change_requests_status_ck
    check (status in ('pending', 'approved', 'rejected', 'stale')),
  constraint counter_pickup_change_requests_lifecycle_ck
    check (
      (
        status = 'pending'
        and reviewed_by_user_id is null
        and reviewed_at is null
        and applied_at is null
        and result_payload is null
      )
      or (
        status = 'approved'
        and reviewed_by_user_id is not null
        and reviewed_at is not null
        and applied_at is not null
        and result_payload is not null
      )
      or (
        status in ('rejected', 'stale')
        and reviewed_by_user_id is not null
        and reviewed_at is not null
        and applied_at is null
        and result_payload is not null
      )
    )
);

comment on table public.counter_pickup_change_requests
is 'Autorizacion operacional para modificar un pickup listo, empacado o protegido por precio.';

create unique index counter_pickup_change_requests_one_pending_order_uk
  on public.counter_pickup_change_requests(order_id)
  where status = 'pending';

create index counter_pickup_change_requests_order_requested_idx
  on public.counter_pickup_change_requests(order_id, requested_at desc, id desc);

alter table public.counter_pickup_change_requests enable row level security;

revoke all on public.counter_pickup_change_requests
  from public, anon, authenticated;
grant select on public.counter_pickup_change_requests to authenticated;
grant select, insert, update, delete on public.counter_pickup_change_requests
  to service_role;

revoke all on sequence public.counter_pickup_change_requests_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.counter_pickup_change_requests_id_seq
  to service_role;

create policy counter_pickup_change_requests_operational_read
on public.counter_pickup_change_requests
for select
to authenticated
using (
  public.has_role('counter')
  or public.is_master_or_admin()
);

alter table public.counter_command_receipts
  drop constraint counter_command_receipts_type_ck;

alter table public.counter_command_receipts
  add constraint counter_command_receipts_type_ck
  check (
    command_type in (
      'apply_order_payments',
      'record_manual_movement',
      'request_refund',
      'decide_authorization',
      'execute_refund',
      'dispatch_delivery',
      'record_delivery_return',
      'complete_delivery_digital_change',
      'close_money_account',
      'update_pickup_schedule',
      'change_pickup_items',
      'decide_pickup_change',
      'complete_pickup'
    )
  );

create function public.counter_pickup_order_signature(
  p_order_id bigint
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select md5(
    jsonb_build_object(
      'id', order_row.id,
      'status', order_row.status::text,
      'fulfillment', order_row.fulfillment::text,
      'total_usd', order_row.total_usd,
      'total_bs_snapshot', order_row.total_bs_snapshot,
      'ready_at', order_row.ready_at,
      'pricing', coalesce(order_row.extra_fields -> 'pricing', '{}'::jsonb),
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', item.id,
              'product_id', item.product_id,
              'qty', item.qty,
              'unit_usd', item.unit_price_usd_snapshot,
              'unit_bs', item.unit_price_bs_snapshot,
              'line_usd', item.line_total_usd,
              'line_bs', item.line_total_bs_snapshot,
              'notes', item.notes
            )
            order by item.id
          )
          from public.order_items item
          where item.order_id = order_row.id
        ),
        '[]'::jsonb
      )
    )::text
  )
  from public.orders order_row
  where order_row.id = p_order_id;
$function$;

revoke all on function public.counter_pickup_order_signature(bigint)
  from public, anon, authenticated;
grant execute on function public.counter_pickup_order_signature(bigint)
  to service_role;

create function public.counter_build_pickup_item_plan(
  p_order_id bigint,
  p_existing_items jsonb,
  p_added_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_rate numeric(18,6);
  v_existing_plan jsonb;
  v_added_plan jsonb;
  v_existing_count integer;
  v_had_reduction boolean := false;
  v_had_existing_increase boolean := false;
  v_subtotal_usd numeric(12,2);
  v_subtotal_bs numeric(12,2);
  v_discount_enabled boolean;
  v_discount_pct numeric(9,4);
  v_discount_usd numeric(12,2);
  v_discount_bs numeric(12,2);
  v_after_discount_usd numeric(12,2);
  v_after_discount_bs numeric(12,2);
  v_invoice_tax_pct numeric(9,4);
  v_invoice_tax_usd numeric(12,2);
  v_invoice_tax_bs numeric(12,2);
  v_total_usd numeric(12,2);
  v_total_bs numeric(12,2);
begin
  p_existing_items := coalesce(p_existing_items, '[]'::jsonb);
  p_added_items := coalesce(p_added_items, '[]'::jsonb);

  if jsonb_typeof(p_existing_items) <> 'array'
     or jsonb_array_length(p_existing_items) > 200 then
    raise exception 'existing_items must be an array with at most 200 lines';
  end if;

  if jsonb_typeof(p_added_items) <> 'array'
     or jsonb_array_length(p_added_items) > 100 then
    raise exception 'added_items must be an array with at most 100 lines';
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  select count(*)::integer
  into v_existing_count
  from public.order_items item
  where item.order_id = p_order_id;

  if jsonb_array_length(p_existing_items) <> v_existing_count then
    raise exception 'existing_items must include every current order line exactly once';
  end if;

  if exists (
    select 1
    from (
      select requested.item_id, count(*) as uses
      from jsonb_to_recordset(p_existing_items)
        as requested(item_id bigint, qty numeric)
      group by requested.item_id
    ) duplicate
    where duplicate.item_id is null or duplicate.uses <> 1
  ) then
    raise exception 'Every existing item requires one unique item_id';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_existing_items)
      as requested(item_id bigint, qty numeric)
    left join public.order_items item
      on item.id = requested.item_id
     and item.order_id = p_order_id
    where item.id is null
       or requested.qty is null
       or requested.qty < 0
       or requested.qty > 999
  ) then
    raise exception 'An existing item or quantity is invalid';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_added_items)
      as requested(product_id bigint, qty numeric, notes text)
    left join public.products product
      on product.id = requested.product_id
     and product.is_active = true
    where product.id is null
       or requested.qty is null
       or requested.qty <= 0
       or requested.qty > 999
       or char_length(coalesce(requested.notes, '')) > 4000
  ) then
    raise exception 'An added product or quantity is invalid';
  end if;

  select rate.rate_bs_per_usd
  into v_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  if coalesce(v_rate, 0) <= 0 then
    raise exception 'There is no active exchange rate';
  end if;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'itemId', item.id,
          'productId', item.product_id,
          'name', item.product_name_snapshot,
          'sku', item.sku_snapshot,
          'previousQty', item.qty,
          'qty', requested.qty,
          'notes', item.notes,
          'pricingOriginCurrency', item.pricing_origin_currency,
          'pricingOriginAmount', item.pricing_origin_amount,
          'unitUsd', item.unit_price_usd_snapshot,
          'unitBs', coalesce(
            item.unit_price_bs_snapshot,
            round(item.unit_price_usd_snapshot * v_rate, 2)
          ),
          'lineUsd', round(item.unit_price_usd_snapshot * requested.qty, 2),
          'lineBs', round(
            coalesce(
              item.unit_price_bs_snapshot,
              item.unit_price_usd_snapshot * v_rate
            ) * requested.qty,
            2
          )
        )
        order by item.id
      ),
      '[]'::jsonb
    ),
    coalesce(bool_or(requested.qty < item.qty), false),
    coalesce(bool_or(requested.qty > item.qty), false)
  into
    v_existing_plan,
    v_had_reduction,
    v_had_existing_increase
  from public.order_items item
  join jsonb_to_recordset(p_existing_items)
    as requested(item_id bigint, qty numeric)
    on requested.item_id = item.id
  where item.order_id = p_order_id;

  with requested as (
    select
      value,
      ordinality,
      (value ->> 'product_id')::bigint as product_id,
      (value ->> 'qty')::numeric as qty,
      nullif(btrim(value ->> 'notes'), '') as notes
    from jsonb_array_elements(p_added_items) with ordinality
  ),
  priced as (
    select
      requested.ordinality,
      requested.product_id,
      requested.qty,
      requested.notes,
      product.name,
      product.sku,
      product.base_price_usd,
      case
        when product.source_price_currency = 'VES' then 'VES'
        else 'USD'
      end as source_currency,
      case
        when product.source_price_currency = 'VES'
          then coalesce(nullif(product.source_price_amount, 0), product.base_price_bs, 0)
        else coalesce(nullif(product.source_price_amount, 0), product.base_price_usd, 0)
      end as source_amount
    from requested
    join public.products product
      on product.id = requested.product_id
     and product.is_active = true
  ),
  snapshots as (
    select
      priced.*,
      round(priced.base_price_usd, 2) as unit_usd,
      case
        when priced.source_currency = 'VES'
          then round(priced.source_amount, 2)
        else round(priced.source_amount * v_rate, 2)
      end as unit_bs
    from priced
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'productId', snapshots.product_id,
        'name', snapshots.name,
        'sku', snapshots.sku,
        'qty', snapshots.qty,
        'notes', snapshots.notes,
        'pricingOriginCurrency', snapshots.source_currency,
        'pricingOriginAmount', snapshots.source_amount,
        'unitUsd', snapshots.unit_usd,
        'unitBs', snapshots.unit_bs,
        'lineUsd', round(snapshots.unit_usd * snapshots.qty, 2),
        'lineBs', round(snapshots.unit_bs * snapshots.qty, 2)
      )
      order by snapshots.ordinality
    ),
    '[]'::jsonb
  )
  into v_added_plan
  from snapshots;

  if not v_had_reduction
     and not v_had_existing_increase
     and jsonb_array_length(v_added_plan) = 0 then
    raise exception 'The pickup item plan does not contain changes';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_existing_plan) item
    where (item ->> 'qty')::numeric > 0
  )
  and jsonb_array_length(v_added_plan) = 0 then
    raise exception 'A pickup order must keep at least one item';
  end if;

  select
    round(coalesce(sum((item ->> 'lineUsd')::numeric), 0), 2),
    round(coalesce(sum((item ->> 'lineBs')::numeric), 0), 2)
  into v_subtotal_usd, v_subtotal_bs
  from (
    select item
    from jsonb_array_elements(v_existing_plan) item
    where (item ->> 'qty')::numeric > 0
    union all
    select item
    from jsonb_array_elements(v_added_plan) item
  ) lines;

  v_discount_enabled :=
    coalesce(nullif(v_order.extra_fields #>> '{pricing,discount_enabled}', '')::boolean, false)
    or coalesce(nullif(v_order.extra_fields #>> '{pricing,discount_amount_usd}', '')::numeric, 0) > 0
    or coalesce(nullif(v_order.extra_fields #>> '{pricing,discount_amount_bs}', '')::numeric, 0) > 0;
  v_discount_pct := case
    when v_discount_enabled
      then greatest(
        0,
        least(
          100,
          coalesce(nullif(v_order.extra_fields #>> '{pricing,discount_pct}', '')::numeric, 0)
        )
      )
    else 0
  end;
  v_invoice_tax_pct := greatest(
    0,
    coalesce(nullif(v_order.extra_fields #>> '{pricing,invoice_tax_pct}', '')::numeric, 0)
  );

  v_discount_usd := round(v_subtotal_usd * v_discount_pct / 100, 2);
  v_discount_bs := round(v_subtotal_bs * v_discount_pct / 100, 2);
  v_after_discount_usd := round(greatest(v_subtotal_usd - v_discount_usd, 0), 2);
  v_after_discount_bs := round(greatest(v_subtotal_bs - v_discount_bs, 0), 2);
  v_invoice_tax_usd := round(v_after_discount_usd * v_invoice_tax_pct / 100, 2);
  v_invoice_tax_bs := round(v_after_discount_bs * v_invoice_tax_pct / 100, 2);
  v_total_usd := round(v_after_discount_usd + v_invoice_tax_usd, 2);
  v_total_bs := round(v_after_discount_bs + v_invoice_tax_bs, 2);

  return jsonb_build_object(
    'existingItems', v_existing_plan,
    'addedItems', v_added_plan,
    'hadReduction', v_had_reduction,
    'hadExistingIncrease', v_had_existing_increase,
    'hasAdditions', jsonb_array_length(v_added_plan) > 0,
    'needsKitchen',
      v_had_existing_increase or jsonb_array_length(v_added_plan) > 0,
    'pricing', jsonb_build_object(
      'fx_rate', v_rate,
      'discount_enabled', v_discount_enabled,
      'discount_pct', v_discount_pct,
      'discount_amount_usd', v_discount_usd,
      'discount_amount_bs', v_discount_bs,
      'subtotal_usd', v_subtotal_usd,
      'subtotal_bs', v_subtotal_bs,
      'subtotal_after_discount_usd', v_after_discount_usd,
      'subtotal_after_discount_bs', v_after_discount_bs,
      'invoice_tax_pct', v_invoice_tax_pct,
      'invoice_tax_amount_usd', v_invoice_tax_usd,
      'invoice_tax_amount_bs', v_invoice_tax_bs,
      'total_usd', v_total_usd,
      'total_bs', v_total_bs
    )
  );
end;
$function$;

revoke all on function public.counter_build_pickup_item_plan(
  bigint,
  jsonb,
  jsonb
) from public, anon, authenticated;
grant execute on function public.counter_build_pickup_item_plan(
  bigint,
  jsonb,
  jsonb
) to service_role;

create function public.counter_apply_pickup_item_plan(
  p_order_id bigint,
  p_plan jsonb,
  p_actor_user_id uuid,
  p_reason text,
  p_return_to_kitchen boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_item jsonb;
  v_pricing jsonb;
  v_extra_fields jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if jsonb_typeof(p_plan) <> 'object'
     or jsonb_typeof(p_plan -> 'existingItems') <> 'array'
     or jsonb_typeof(p_plan -> 'addedItems') <> 'array'
     or jsonb_typeof(p_plan -> 'pricing') <> 'object' then
    raise exception 'The pickup item plan is invalid';
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_plan -> 'existingItems')
  loop
    if (v_item ->> 'qty')::numeric = 0 then
      delete from public.order_items
      where id = (v_item ->> 'itemId')::bigint
        and order_id = p_order_id;
    else
      update public.order_items
      set
        qty = (v_item ->> 'qty')::numeric,
        unit_price_bs_snapshot = (v_item ->> 'unitBs')::numeric,
        line_total_bs_snapshot = (v_item ->> 'lineBs')::numeric
      where id = (v_item ->> 'itemId')::bigint
        and order_id = p_order_id;
    end if;

    if not found then
      raise exception 'The pickup changed while the item plan was being applied';
    end if;
  end loop;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    unit_price_usd_snapshot,
    line_total_usd,
    product_name_snapshot,
    sku_snapshot,
    notes,
    unit_price_bs_snapshot,
    line_total_bs_snapshot,
    pricing_origin_currency,
    pricing_origin_amount
  )
  select
    p_order_id,
    (item ->> 'productId')::bigint,
    (item ->> 'qty')::numeric,
    (item ->> 'unitUsd')::numeric,
    (item ->> 'lineUsd')::numeric,
    item ->> 'name',
    nullif(item ->> 'sku', ''),
    nullif(item ->> 'notes', ''),
    (item ->> 'unitBs')::numeric,
    (item ->> 'lineBs')::numeric,
    item ->> 'pricingOriginCurrency',
    (item ->> 'pricingOriginAmount')::numeric
  from jsonb_array_elements(p_plan -> 'addedItems') item;

  v_pricing := p_plan -> 'pricing';
  v_extra_fields := jsonb_set(
    coalesce(v_order.extra_fields, '{}'::jsonb),
    '{pricing}',
    coalesce(v_order.extra_fields -> 'pricing', '{}'::jsonb) || v_pricing,
    true
  );
  v_extra_fields := jsonb_set(
    v_extra_fields,
    '{counter}',
    coalesce(v_extra_fields -> 'counter', '{}'::jsonb)
      || jsonb_build_object(
        'last_pickup_item_change_at', v_now,
        'last_pickup_item_change_by', p_actor_user_id,
        'last_pickup_item_change_reason', btrim(p_reason)
      ),
    true
  );

  update public.orders
  set
    total_usd = (v_pricing ->> 'total_usd')::numeric,
    total_bs_snapshot = (v_pricing ->> 'total_bs')::numeric,
    extra_fields = v_extra_fields,
    status = case
      when p_return_to_kitchen then 'confirmed'::public.order_status
      else status
    end,
    ready_at = case
      when p_return_to_kitchen then null
      else ready_at
    end,
    sent_to_kitchen_at = case
      when p_return_to_kitchen then v_now
      else sent_to_kitchen_at
    end,
    sent_to_kitchen_by = case
      when p_return_to_kitchen then p_actor_user_id
      else sent_to_kitchen_by
    end,
    kitchen_started_at = case
      when p_return_to_kitchen then null
      else kitchen_started_at
    end,
    kitchen_operator_id = case
      when p_return_to_kitchen then null
      else kitchen_operator_id
    end,
    last_modified_at = v_now,
    last_modified_by = p_actor_user_id
  where id = p_order_id;

  return jsonb_build_object(
    'totalUsd', (v_pricing ->> 'total_usd')::numeric,
    'totalBs', (v_pricing ->> 'total_bs')::numeric,
    'returnedToKitchen', p_return_to_kitchen,
    'hadReduction', coalesce((p_plan ->> 'hadReduction')::boolean, false),
    'hasAdditions', coalesce((p_plan ->> 'hasAdditions')::boolean, false),
    'changedAt', v_now
  );
end;
$function$;

revoke all on function public.counter_apply_pickup_item_plan(
  bigint,
  jsonb,
  uuid,
  text,
  boolean
) from public, anon, authenticated;
grant execute on function public.counter_apply_pickup_item_plan(
  bigint,
  jsonb,
  uuid,
  text,
  boolean
) to service_role;

create function public.counter_update_pickup_schedule(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_schedule_date date,
  p_schedule_time time without time zone,
  p_reason text,
  p_send_to_kitchen boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_receipt_id bigint;
  v_existing_result jsonb;
  v_request_payload jsonb;
  v_result jsonb;
  v_extra_fields jsonb;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Only Counter or Master/Admin can update a pickup schedule';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  if p_schedule_date is null or p_schedule_time is null then
    raise exception 'A pickup date and time are required';
  end if;

  if char_length(btrim(coalesce(p_reason, ''))) < 4 then
    raise exception 'A clear schedule correction reason is required';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'schedule_date', p_schedule_date,
    'schedule_time', to_char(p_schedule_time, 'HH24:MI'),
    'reason', btrim(p_reason),
    'send_to_kitchen', coalesce(p_send_to_kitchen, false)
  );

  select claim.receipt_id, claim.existing_result
  into v_receipt_id, v_existing_result
  from public.counter_claim_command(
    p_idempotency_key,
    'update_pickup_schedule',
    p_order_id,
    null,
    v_request_payload
  ) claim;

  if v_existing_result is not null then
    return v_existing_result;
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_order.fulfillment <> 'pickup' then
    raise exception 'Counter cannot change the schedule of a delivery order';
  end if;

  if v_order.status not in ('created', 'queued', 'confirmed', 'in_kitchen') then
    raise exception 'A pickup schedule can only be changed before the order is ready';
  end if;

  if coalesce(p_send_to_kitchen, false)
     and v_order.status not in ('created', 'queued') then
    raise exception 'This pickup is already in the kitchen flow';
  end if;

  v_extra_fields := jsonb_set(
    coalesce(v_order.extra_fields, '{}'::jsonb),
    '{schedule}',
    jsonb_build_object(
      'asap', false,
      'date', to_char(p_schedule_date, 'YYYY-MM-DD'),
      'time_24', to_char(p_schedule_time, 'HH24:MI'),
      'time_12', to_char(p_schedule_time, 'FMHH12:MI AM')
    ),
    true
  );
  v_extra_fields := jsonb_set(
    v_extra_fields,
    '{counter}',
    coalesce(v_extra_fields -> 'counter', '{}'::jsonb)
      || jsonb_build_object(
        'last_schedule_correction_at', v_now,
        'last_schedule_correction_by', v_uid,
        'last_schedule_correction_reason', btrim(p_reason)
      ),
    true
  );

  update public.orders
  set
    extra_fields = v_extra_fields,
    status = case
      when coalesce(p_send_to_kitchen, false)
        then 'confirmed'::public.order_status
      else status
    end,
    sent_to_kitchen_at = case
      when coalesce(p_send_to_kitchen, false) then v_now
      else sent_to_kitchen_at
    end,
    sent_to_kitchen_by = case
      when coalesce(p_send_to_kitchen, false) then v_uid
      else sent_to_kitchen_by
    end,
    needs_reapproval = case
      when coalesce(p_send_to_kitchen, false) then false
      else needs_reapproval
    end,
    queued_needs_reapproval = case
      when coalesce(p_send_to_kitchen, false) then false
      else queued_needs_reapproval
    end,
    last_modified_at = v_now,
    last_modified_by = v_uid
  where id = p_order_id;

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  ) values (
    p_order_id,
    v_order.order_number,
    case
      when coalesce(p_send_to_kitchen, false)
        then 'counter_pickup_sent_to_kitchen'
      else 'counter_pickup_schedule_corrected'
    end,
    'kitchen',
    case
      when coalesce(p_send_to_kitchen, false)
        then 'Mostrador corrigio el pickup y lo envio a cocina'
      else 'Mostrador corrigio la fecha del pickup'
    end,
    btrim(p_reason),
    'warning',
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'schedule_date', p_schedule_date,
      'schedule_time', to_char(p_schedule_time, 'HH24:MI'),
      'sent_to_kitchen', coalesce(p_send_to_kitchen, false)
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  select v_event_id, 'kitchen', null::uuid, false
  union all
  select v_event_id, 'advisor', v_order.attributed_advisor_id, false
  where v_order.attributed_advisor_id is not null;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    case
      when coalesce(p_send_to_kitchen, false)
        then 'sent_to_kitchen'
      else 'pickup_schedule_corrected'
    end,
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'reason', btrim(p_reason),
      'schedule_date', p_schedule_date,
      'schedule_time', to_char(p_schedule_time, 'HH24:MI')
    )
  );

  v_result := jsonb_build_object(
    'status',
      case
        when coalesce(p_send_to_kitchen, false) then 'sent_to_kitchen'
        else 'schedule_updated'
      end,
    'orderId', p_order_id,
    'scheduleDate', to_char(p_schedule_date, 'YYYY-MM-DD'),
    'scheduleTime', to_char(p_schedule_time, 'HH24:MI'),
    'sentToKitchen', coalesce(p_send_to_kitchen, false)
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_update_pickup_schedule(
  uuid,
  bigint,
  date,
  time without time zone,
  text,
  boolean
) from public, anon;
grant execute on function public.counter_update_pickup_schedule(
  uuid,
  bigint,
  date,
  time without time zone,
  text,
  boolean
) to authenticated, service_role;

create function public.counter_change_pickup_items(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_existing_items jsonb,
  p_added_items jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_receipt_id bigint;
  v_existing_result jsonb;
  v_request_payload jsonb;
  v_plan jsonb;
  v_apply_result jsonb;
  v_result jsonb;
  v_change_request_id bigint;
  v_event_id bigint;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_signature text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Only Counter or Master/Admin can change pickup items';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  p_existing_items := coalesce(p_existing_items, '[]'::jsonb);
  p_added_items := coalesce(p_added_items, '[]'::jsonb);

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'existing_items', p_existing_items,
    'added_items', p_added_items,
    'reason', nullif(v_reason, '')
  );

  select claim.receipt_id, claim.existing_result
  into v_receipt_id, v_existing_result
  from public.counter_claim_command(
    p_idempotency_key,
    'change_pickup_items',
    p_order_id,
    null,
    v_request_payload
  ) claim;

  if v_existing_result is not null then
    return v_existing_result;
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_order.fulfillment <> 'pickup' then
    raise exception 'Counter cannot modify delivery order items';
  end if;

  if v_order.status not in ('created', 'queued', 'confirmed', 'in_kitchen', 'ready') then
    raise exception 'This pickup can no longer be modified from Counter';
  end if;

  if exists (
    select 1
    from public.counter_pickup_change_requests request
    where request.order_id = p_order_id
      and request.status = 'pending'
  ) then
    raise exception 'This pickup already has a change awaiting Master approval';
  end if;

  v_plan := public.counter_build_pickup_item_plan(
    p_order_id,
    p_existing_items,
    p_added_items
  );

  if coalesce((v_plan ->> 'hadReduction')::boolean, false)
     and char_length(v_reason) < 4 then
    raise exception 'A clear reason is required to reduce or remove products';
  end if;

  if (v_order.status = 'ready' or v_order.is_price_locked)
     and char_length(v_reason) < 4 then
    raise exception 'A clear reason is required to request this protected pickup change';
  end if;

  if v_order.status = 'ready' or v_order.is_price_locked then
    v_signature := public.counter_pickup_order_signature(p_order_id);

    insert into public.counter_pickup_change_requests (
      order_id,
      requested_by_user_id,
      reason,
      request_payload,
      base_signature
    ) values (
      p_order_id,
      v_uid,
      v_reason,
      v_plan,
      v_signature
    )
    returning id into v_change_request_id;

    insert into public.order_timeline_events (
      order_id,
      order_number,
      event_type,
      event_group,
      title,
      message,
      severity,
      actor_user_id,
      payload
    ) values (
      p_order_id,
      v_order.order_number,
      'counter_pickup_change_requested',
      'approval',
      'Cambio de pickup protegido requiere autorizacion',
      v_reason,
      'warning',
      v_uid,
      jsonb_build_object(
        'source', 'counter',
        'request_id', v_change_request_id,
        'total_usd', v_plan #> '{pricing,total_usd}',
        'had_reduction', v_plan -> 'hadReduction',
        'has_additions', v_plan -> 'hasAdditions',
        'needs_kitchen', v_plan -> 'needsKitchen'
      )
    )
    returning id into v_event_id;

    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    )
    select v_event_id, 'master', null::uuid, true
    union all
    select v_event_id, 'advisor', v_order.attributed_advisor_id, false
    where v_order.attributed_advisor_id is not null;

    v_result := jsonb_build_object(
      'status', 'pending_approval',
      'orderId', p_order_id,
      'requestId', v_change_request_id,
      'returnedToKitchen', false,
      'totalUsd', (v_plan #>> '{pricing,total_usd}')::numeric,
      'totalBs', (v_plan #>> '{pricing,total_bs}')::numeric
    );

    return public.counter_complete_command(v_receipt_id, v_result);
  end if;

  v_apply_result := public.counter_apply_pickup_item_plan(
    p_order_id,
    v_plan,
    v_uid,
    coalesce(nullif(v_reason, ''), 'Cambio solicitado por cliente en mostrador'),
    false
  );

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  ) values (
    p_order_id,
    v_order.order_number,
    'counter_pickup_items_changed',
    case
      when v_order.status in ('confirmed', 'in_kitchen') then 'kitchen'
      else 'order'
    end,
    'Mostrador modifico un pickup activo',
    nullif(v_reason, ''),
    case
      when v_order.status in ('confirmed', 'in_kitchen') then 'warning'
      else 'info'
    end,
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'total_usd', v_apply_result -> 'totalUsd',
      'had_reduction', v_plan -> 'hadReduction',
      'has_additions', v_plan -> 'hasAdditions'
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  select v_event_id, 'kitchen', null::uuid, false
  where v_order.status in ('confirmed', 'in_kitchen')
  union all
  select v_event_id, 'advisor', v_order.attributed_advisor_id, false
  where v_order.attributed_advisor_id is not null;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'counter_pickup_items_changed',
    v_uid,
    jsonb_build_object(
      'reason', nullif(v_reason, ''),
      'total_usd', v_apply_result -> 'totalUsd'
    )
  );

  v_result := jsonb_build_object(
    'status', 'applied',
    'orderId', p_order_id,
    'requestId', null,
    'returnedToKitchen', false,
    'totalUsd', v_apply_result -> 'totalUsd',
    'totalBs', v_apply_result -> 'totalBs'
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) from public, anon;
grant execute on function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) to authenticated, service_role;

create function public.counter_decide_pickup_change(
  p_idempotency_key uuid,
  p_request_id bigint,
  p_decision text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_request public.counter_pickup_change_requests%rowtype;
  v_order public.orders%rowtype;
  v_receipt_id bigint;
  v_existing_result jsonb;
  v_request_payload jsonb;
  v_result jsonb;
  v_apply_result jsonb;
  v_event_id bigint;
  v_current_signature text;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_return_to_kitchen boolean;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_master_or_admin() then
    raise exception 'Only Master/Admin can decide a ready pickup change';
  end if;

  if p_request_id is null or p_request_id <= 0 then
    raise exception 'A valid request_id is required';
  end if;

  p_decision := lower(btrim(coalesce(p_decision, '')));
  if p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject';
  end if;

  select *
  into v_request
  from public.counter_pickup_change_requests request
  where request.id = p_request_id
  for update;

  if not found then
    raise exception 'Pickup change request % not found', p_request_id;
  end if;

  v_request_payload := jsonb_build_object(
    'request_id', p_request_id,
    'decision', p_decision,
    'notes', v_notes
  );

  select claim.receipt_id, claim.existing_result
  into v_receipt_id, v_existing_result
  from public.counter_claim_command(
    p_idempotency_key,
    'decide_pickup_change',
    v_request.order_id,
    null,
    v_request_payload
  ) claim;

  if v_existing_result is not null then
    return v_existing_result;
  end if;

  if v_request.status <> 'pending' then
    raise exception 'This pickup change request is no longer pending';
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = v_request.order_id
  for update;

  if not found then
    raise exception 'Order % not found', v_request.order_id;
  end if;

  if p_decision = 'reject' then
    v_result := jsonb_build_object(
      'status', 'rejected',
      'requestId', p_request_id,
      'orderId', v_request.order_id,
      'returnedToKitchen', false
    );

    update public.counter_pickup_change_requests
    set
      status = 'rejected',
      reviewed_by_user_id = v_uid,
      reviewed_at = v_now,
      review_notes = v_notes,
      result_payload = v_result
    where id = p_request_id;

    insert into public.order_timeline_events (
      order_id,
      order_number,
      event_type,
      event_group,
      title,
      message,
      severity,
      actor_user_id,
      payload
    ) values (
      v_request.order_id,
      v_order.order_number,
      'counter_pickup_change_rejected',
      'approval',
      'Master rechazo el cambio del pickup',
      coalesce(v_notes, v_request.reason),
      'warning',
      v_uid,
      jsonb_build_object('request_id', p_request_id)
    )
    returning id into v_event_id;

    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    )
    select v_event_id, 'counter', null::uuid, false
    union all
    select v_event_id, 'advisor', v_order.attributed_advisor_id, false
    where v_order.attributed_advisor_id is not null;

    return public.counter_complete_command(v_receipt_id, v_result);
  end if;

  v_current_signature := public.counter_pickup_order_signature(v_request.order_id);
  if v_current_signature is distinct from v_request.base_signature then
    v_result := jsonb_build_object(
      'status', 'stale',
      'requestId', p_request_id,
      'orderId', v_request.order_id,
      'returnedToKitchen', false
    );

    update public.counter_pickup_change_requests
    set
      status = 'stale',
      reviewed_by_user_id = v_uid,
      reviewed_at = v_now,
      review_notes = coalesce(v_notes, 'La orden cambio despues de la solicitud.'),
      result_payload = v_result
    where id = p_request_id;

    insert into public.order_timeline_events (
      order_id,
      order_number,
      event_type,
      event_group,
      title,
      message,
      severity,
      actor_user_id,
      payload
    ) values (
      v_request.order_id,
      v_order.order_number,
      'counter_pickup_change_stale',
      'approval',
      'La solicitud de cambio ya no coincide con el pickup',
      'La orden cambio despues de que Counter solicito la autorizacion.',
      'warning',
      v_uid,
      jsonb_build_object('request_id', p_request_id)
    );

    return public.counter_complete_command(v_receipt_id, v_result);
  end if;

  v_return_to_kitchen :=
    v_order.status = 'ready'
    and coalesce(
      (v_request.request_payload ->> 'needsKitchen')::boolean,
      false
    );
  v_apply_result := public.counter_apply_pickup_item_plan(
    v_request.order_id,
    v_request.request_payload,
    v_uid,
    v_request.reason,
    v_return_to_kitchen
  );
  v_result := jsonb_build_object(
    'status', 'approved',
    'requestId', p_request_id,
    'orderId', v_request.order_id,
    'returnedToKitchen', v_return_to_kitchen,
    'totalUsd', v_apply_result -> 'totalUsd',
    'totalBs', v_apply_result -> 'totalBs'
  );

  update public.counter_pickup_change_requests
  set
    status = 'approved',
    reviewed_by_user_id = v_uid,
    reviewed_at = v_now,
    review_notes = v_notes,
    applied_at = v_now,
    result_payload = v_result
  where id = p_request_id;

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  ) values (
    v_request.order_id,
    v_order.order_number,
    'counter_pickup_change_approved',
    case when v_return_to_kitchen then 'kitchen' else 'approval' end,
    case
      when v_return_to_kitchen
        then 'Master aprobo el cambio y el pickup regreso a cocina'
      else 'Master aprobo el cambio del pickup listo'
    end,
    coalesce(v_notes, v_request.reason),
    case when v_return_to_kitchen then 'warning' else 'info' end,
    v_uid,
    jsonb_build_object(
      'request_id', p_request_id,
      'returned_to_kitchen', v_return_to_kitchen,
      'total_usd', v_apply_result -> 'totalUsd'
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  select v_event_id, 'counter', null::uuid, false
  union all
  select v_event_id, 'kitchen', null::uuid, false
  where v_return_to_kitchen
  union all
  select v_event_id, 'advisor', v_order.attributed_advisor_id, false
  where v_order.attributed_advisor_id is not null;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    v_request.order_id,
    'counter_pickup_change_approved',
    v_uid,
    jsonb_build_object(
      'request_id', p_request_id,
      'returned_to_kitchen', v_return_to_kitchen
    )
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_decide_pickup_change(
  uuid,
  bigint,
  text,
  text
) from public, anon;
grant execute on function public.counter_decide_pickup_change(
  uuid,
  bigint,
  text,
  text
) to authenticated, service_role;

create function public.counter_complete_pickup(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_state record;
  v_active_rate numeric;
  v_payment_method text;
  v_has_advisor boolean;
  v_receipt_id bigint;
  v_existing_result jsonb;
  v_request_payload jsonb;
  v_result jsonb;
  v_extra_fields jsonb;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Only Counter or Master/Admin can complete a pickup';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'notes', nullif(btrim(coalesce(p_notes, '')), '')
  );

  select claim.receipt_id, claim.existing_result
  into v_receipt_id, v_existing_result
  from public.counter_claim_command(
    p_idempotency_key,
    'complete_pickup',
    p_order_id,
    null,
    v_request_payload
  ) claim;

  if v_existing_result is not null then
    return v_existing_result;
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_order.fulfillment <> 'pickup' then
    raise exception 'This command only completes pickup orders';
  end if;

  if v_order.status <> 'ready' then
    raise exception 'A pickup can only be delivered from ready';
  end if;

  if exists (
    select 1
    from public.counter_pickup_change_requests request
    where request.order_id = p_order_id
      and request.status = 'pending'
  ) then
    raise exception 'Resolve the pending pickup change before delivery';
  end if;

  if exists (
    select 1
    from public.order_change_obligations obligation
    where obligation.order_id = p_order_id
      and obligation.status = 'pending'
  ) then
    raise exception 'Complete the pending customer change before pickup delivery';
  end if;

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  select *
  into v_state
  from public.get_order_financial_state(
    p_order_id,
    null,
    v_active_rate
  );

  v_payment_method := coalesce(
    nullif(v_order.extra_fields #>> '{payment,method}', ''),
    'pending'
  );
  v_has_advisor := v_order.attributed_advisor_id is not null;

  if v_payment_method in ('pos', 'cash_usd', 'cash_ves')
     and coalesce(v_state.pending_usd, v_order.total_usd) > 0.005 then
    raise exception 'Counter must collect the expected cash or POS balance before pickup';
  end if;

  if not v_has_advisor
     and (
       coalesce(v_state.pending_usd, v_order.total_usd) > 0.005
       or coalesce(v_state.pending_reports_count, 0) > 0
     ) then
    raise exception 'Master must confirm payment before delivering a pickup without advisor';
  end if;

  v_extra_fields := jsonb_set(
    coalesce(v_order.extra_fields, '{}'::jsonb),
    '{pickup}',
    coalesce(v_order.extra_fields -> 'pickup', '{}'::jsonb)
      || jsonb_build_object(
        'collected_at', v_now,
        'collected_by_user_id', v_uid,
        'notes', nullif(btrim(coalesce(p_notes, '')), '')
      ),
    true
  );

  update public.orders
  set
    status = 'delivered',
    extra_fields = v_extra_fields,
    last_modified_at = v_now,
    last_modified_by = v_uid
  where id = p_order_id;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'delivered',
    v_uid,
    jsonb_build_object(
      'fulfillment', 'pickup',
      'delivered_by_role', 'counter',
      'payment_status', v_state.payment_status,
      'pending_usd', v_state.pending_usd,
      'pending_reports_count', v_state.pending_reports_count
    )
  );

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  ) values (
    p_order_id,
    v_order.order_number,
    'counter_pickup_delivered',
    'delivery',
    'Pickup entregado en mostrador',
    nullif(btrim(coalesce(p_notes, '')), ''),
    'info',
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'payment_status', v_state.payment_status,
      'pending_usd', v_state.pending_usd,
      'pending_reports_count', v_state.pending_reports_count,
      'advisor_responsible_for_collection',
        v_has_advisor
        and (
          coalesce(v_state.pending_usd, 0) > 0.005
          or coalesce(v_state.pending_reports_count, 0) > 0
        )
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  select v_event_id, 'master', null::uuid, false
  union all
  select
    v_event_id,
    'advisor',
    v_order.attributed_advisor_id,
    coalesce(v_state.pending_usd, 0) > 0.005
      or coalesce(v_state.pending_reports_count, 0) > 0
  where v_order.attributed_advisor_id is not null;

  v_result := jsonb_build_object(
    'status', 'delivered',
    'orderId', p_order_id,
    'deliveredAt', v_now,
    'paymentStatus', v_state.payment_status,
    'pendingUsd', v_state.pending_usd,
    'pendingReportsCount', v_state.pending_reports_count,
    'advisorResponsibleForCollection',
      v_has_advisor
      and (
        coalesce(v_state.pending_usd, 0) > 0.005
        or coalesce(v_state.pending_reports_count, 0) > 0
      )
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_complete_pickup(
  uuid,
  bigint,
  text
) from public, anon;
grant execute on function public.counter_complete_pickup(
  uuid,
  bigint,
  text
) to authenticated, service_role;

create function public.counter_read_pickup_change_requests(
  p_order_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'counter_order_invalid';
  end if;

  if not exists (
    select 1
    from public.orders order_row
    where order_row.id = p_order_id
  ) then
    raise exception 'counter_order_not_found';
  end if;

  select coalesce(
    jsonb_agg(requests.payload order by requests.requested_at desc, requests.id desc),
    '[]'::jsonb
  )
  into v_payload
  from (
    select
      request.id,
      request.requested_at,
      jsonb_build_object(
        'id', request.id,
        'status', request.status,
        'reason', request.reason,
        'requestedAt', request.requested_at,
        'requestedByName', coalesce(nullif(btrim(requester.full_name), ''), 'Usuario'),
        'reviewedAt', request.reviewed_at,
        'reviewedByName',
          case
            when request.reviewed_by_user_id is null then null
            else coalesce(nullif(btrim(reviewer.full_name), ''), 'Usuario')
          end,
        'reviewNotes', request.review_notes,
        'appliedAt', request.applied_at,
        'preview', jsonb_build_object(
          'totalUsd', (request.request_payload #>> '{pricing,total_usd}')::numeric,
          'totalBs', (request.request_payload #>> '{pricing,total_bs}')::numeric,
          'hadReduction',
            coalesce((request.request_payload ->> 'hadReduction')::boolean, false),
          'hadExistingIncrease',
            coalesce((request.request_payload ->> 'hadExistingIncrease')::boolean, false),
          'hasAdditions',
            coalesce((request.request_payload ->> 'hasAdditions')::boolean, false),
          'needsKitchen',
            coalesce((request.request_payload ->> 'needsKitchen')::boolean, false),
          'existingItems',
            coalesce(request.request_payload -> 'existingItems', '[]'::jsonb),
          'addedItems',
            coalesce(request.request_payload -> 'addedItems', '[]'::jsonb)
        )
      ) as payload
    from public.counter_pickup_change_requests request
    left join public.profiles requester
      on requester.id = request.requested_by_user_id
    left join public.profiles reviewer
      on reviewer.id = request.reviewed_by_user_id
    where request.order_id = p_order_id
    order by request.requested_at desc, request.id desc
    limit 20
  ) requests;

  return v_payload;
end;
$function$;

revoke all on function public.counter_read_pickup_change_requests(bigint)
  from public, anon;
grant execute on function public.counter_read_pickup_change_requests(bigint)
  to authenticated, service_role;

commit;
