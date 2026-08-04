
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.delivery_settlement_entries
  add column source_line_key text null;

alter table public.delivery_settlement_entries
  add constraint delivery_settlement_entries_source_line_key_ck
  check (
    source_line_key is null
    or nullif(btrim(source_line_key), '') is not null
  );

create unique index delivery_settlement_entries_source_line_uk
  on public.delivery_settlement_entries(
    settlement_id,
    entry_type,
    source_line_key
  )
  where source_line_key is not null;

alter table public.order_change_obligations
  add column delivery_settlement_id bigint null
    references public.delivery_settlements(id)
    on update restrict
    on delete restrict,
  add column delivery_settlement_entry_id bigint null
    references public.delivery_settlement_entries(id)
    on update restrict
    on delete restrict;

alter table public.order_change_obligations
  add constraint order_change_obligations_delivery_link_ck
  check (
    (
      delivery_settlement_id is null
      and delivery_settlement_entry_id is null
    )
    or
    (
      delivery_settlement_id is not null
      and delivery_settlement_entry_id is not null
    )
  );

create index order_change_obligations_delivery_settlement_idx
  on public.order_change_obligations(
    delivery_settlement_id,
    status,
    created_at desc,
    id desc
  )
  where delivery_settlement_id is not null;

create unique index order_change_obligations_delivery_entry_uk
  on public.order_change_obligations(delivery_settlement_entry_id)
  where delivery_settlement_entry_id is not null;

alter function public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) rename to counter_dispatch_delivery_block2;

revoke all on function public.counter_dispatch_delivery_block2(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) from public, anon, authenticated;

grant execute on function public.counter_dispatch_delivery_block2(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) to service_role;

create function public.counter_dispatch_delivery(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_eta_minutes integer,
  p_expected_collection_lines jsonb default '[]'::jsonb,
  p_cash_change_lines jsonb default '[]'::jsonb,
  p_digital_change_lines jsonb default '[]'::jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_request_payload jsonb;
  v_existing public.counter_command_receipts%rowtype;
  v_order public.orders%rowtype;
  v_state record;
  v_active_rate numeric(18,6);
  v_expected_usd numeric(12,2) := 0;
  v_cash_change_usd numeric(12,2) := 0;
  v_digital_change_usd numeric(12,2) := 0;
  v_allocated_change_usd numeric(12,2) := 0;
  v_required_change_usd numeric(12,2) := 0;
  v_pending_usd numeric(12,2) := 0;
  v_result jsonb;
  v_settlement_id bigint;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.has_role('counter')
    or public.is_master_or_admin()
  ) then
    raise exception 'Only Counter or Master/Admin can dispatch a delivery';
  end if;

  if p_idempotency_key is null then
    raise exception 'idempotency_key is required';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  if p_eta_minutes is null
     or p_eta_minutes < 1
     or p_eta_minutes > 1440 then
    raise exception 'ETA is required and must be between 1 and 1440 minutes';
  end if;

  p_expected_collection_lines :=
    coalesce(p_expected_collection_lines, '[]'::jsonb);
  p_cash_change_lines :=
    coalesce(p_cash_change_lines, '[]'::jsonb);
  p_digital_change_lines :=
    coalesce(p_digital_change_lines, '[]'::jsonb);

  if jsonb_typeof(p_expected_collection_lines) <> 'array'
     or jsonb_array_length(p_expected_collection_lines) > 12
     or jsonb_typeof(p_cash_change_lines) <> 'array'
     or jsonb_array_length(p_cash_change_lines) > 12
     or jsonb_typeof(p_digital_change_lines) <> 'array'
     or jsonb_array_length(p_digital_change_lines) > 12 then
    raise exception
      'Delivery settlement lines must be arrays with at most 12 lines each';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'eta_minutes', p_eta_minutes,
    'expected_collection_lines', p_expected_collection_lines,
    'cash_change_lines', p_cash_change_lines,
    'digital_change_lines', p_digital_change_lines,
    'notes', p_notes
  );

  select receipt.*
  into v_existing
  from public.counter_command_receipts receipt
  where receipt.actor_user_id = v_uid
    and receipt.command_type = 'dispatch_delivery'
    and receipt.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_payload is distinct from v_request_payload
       or v_existing.order_id is distinct from p_order_id then
      raise exception
        'Idempotency key was already used with a different request';
    end if;

    if v_existing.status <> 'completed'
       or v_existing.result_payload is null then
      raise exception 'Idempotent command is still in progress';
    end if;

    return v_existing.result_payload;
  end if;

  select order_row.*
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.fulfillment <> 'delivery' then
    raise exception 'Only a delivery order can be dispatched';
  end if;

  if v_order.status <> 'ready' then
    raise exception 'Delivery can only be dispatched from ready';
  end if;

  if v_order.delivery_mode = 'internal' then
    if v_order.internal_driver_user_id is null then
      raise exception 'Delivery has no internal driver assigned';
    end if;
  elsif v_order.delivery_mode = 'external' then
    if v_order.external_partner_id is null
       and nullif(btrim(coalesce(v_order.external_driver_name, '')), '') is null
    then
      raise exception 'Delivery has no external partner or driver assigned';
    end if;
  else
    raise exception 'Delivery has no valid internal or external assignment';
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

  v_pending_usd := round(
    coalesce(v_state.pending_usd, v_order.total_usd, 0),
    2
  );

  select round(coalesce(sum(public.counter_amount_usd(
    upper(btrim(line ->> 'currency_code'))::public.currency_code,
    round((line ->> 'amount')::numeric, 2),
    case
      when upper(btrim(line ->> 'currency_code')) = 'VES'
        then round((line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end
  )), 0), 2)
  into v_expected_usd
  from jsonb_array_elements(p_expected_collection_lines) line;

  select round(coalesce(sum(public.counter_amount_usd(
    upper(btrim(line ->> 'currency_code'))::public.currency_code,
    round((line ->> 'amount')::numeric, 2),
    case
      when upper(btrim(line ->> 'currency_code')) = 'VES'
        then round((line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end
  )), 0), 2)
  into v_cash_change_usd
  from jsonb_array_elements(p_cash_change_lines) line;

  select round(coalesce(sum(public.counter_amount_usd(
    upper(btrim(line ->> 'currency_code'))::public.currency_code,
    round((line ->> 'amount')::numeric, 2),
    case
      when upper(btrim(line ->> 'currency_code')) = 'VES'
        then round((line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end
  )), 0), 2)
  into v_digital_change_usd
  from jsonb_array_elements(p_digital_change_lines) line;

  v_allocated_change_usd :=
    round(v_cash_change_usd + v_digital_change_usd, 2);
  v_required_change_usd :=
    round(greatest(v_expected_usd - v_pending_usd, 0), 2);

  if v_expected_usd <= 0.005
     and v_allocated_change_usd > 0.005 then
    raise exception
      'Expected customer collection is required when delivery change is sent';
  end if;

  if abs(v_allocated_change_usd - v_required_change_usd) > 0.02 then
    raise exception
      'Delivery change allocation must equal the expected collection minus the current order balance';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_digital_change_lines) line
    where coalesce(
      nullif(btrim(line ->> 'payment_method_code'), ''),
      'payment_mobile'
    ) not in ('payment_mobile', 'transfer', 'zelle', 'other')
  ) then
    raise exception 'Digital change method is not valid';
  end if;

  v_result := public.counter_dispatch_delivery_block2(
    p_idempotency_key,
    p_order_id,
    p_eta_minutes,
    p_expected_collection_lines,
    p_cash_change_lines,
    p_digital_change_lines,
    p_notes
  );

  v_settlement_id :=
    nullif(v_result ->> 'delivery_settlement_id', '')::bigint;

  if v_settlement_id is null then
    raise exception 'Delivery dispatch did not return a settlement';
  end if;

  with payload_entries as (
    select
      entry.ordinality,
      entry.value ->> 'line_key' as line_key
    from jsonb_array_elements(v_result -> 'entries')
      with ordinality entry(value, ordinality)
  ),
  stored_entries as (
    select
      settlement_entry.id,
      row_number() over (order by settlement_entry.id) as ordinality
    from public.delivery_settlement_entries settlement_entry
    where settlement_entry.settlement_id = v_settlement_id
  )
  update public.delivery_settlement_entries settlement_entry
  set source_line_key = payload.line_key
  from stored_entries stored
  join payload_entries payload
    on payload.ordinality = stored.ordinality
  where settlement_entry.id = stored.id
    and settlement_entry.source_line_key is null;

  insert into public.order_change_obligations (
    order_id,
    command_idempotency_key,
    line_key,
    requested_by_user_id,
    responsible_user_id,
    responsible_role,
    status,
    payment_method_code,
    currency_code,
    amount,
    exchange_rate_ves_per_usd,
    amount_usd_equivalent,
    notes,
    delivery_settlement_id,
    delivery_settlement_entry_id
  )
  select
    p_order_id,
    p_idempotency_key,
    btrim(line ->> 'line_key'),
    v_uid,
    v_order.attributed_advisor_id,
    case
      when v_order.attributed_advisor_id is null then 'master'
      else 'advisor'
    end,
    'pending',
    coalesce(
      nullif(btrim(line ->> 'payment_method_code'), ''),
      'payment_mobile'
    ),
    upper(btrim(line ->> 'currency_code'))::public.currency_code,
    round((line ->> 'amount')::numeric, 2),
    case
      when upper(btrim(line ->> 'currency_code')) = 'VES'
        then round((line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end,
    public.counter_amount_usd(
      upper(btrim(line ->> 'currency_code'))::public.currency_code,
      round((line ->> 'amount')::numeric, 2),
      case
        when upper(btrim(line ->> 'currency_code')) = 'VES'
          then round((line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
        else null
      end
    ),
    coalesce(
      nullif(btrim(line ->> 'notes'), ''),
      nullif(btrim(coalesce(p_notes, '')), ''),
      format('Cambio digital de delivery. Liquidacion %s.', v_settlement_id)
    ),
    v_settlement_id,
    settlement_entry.id
  from jsonb_array_elements(p_digital_change_lines) line
  join public.delivery_settlement_entries settlement_entry
    on settlement_entry.settlement_id = v_settlement_id
   and settlement_entry.entry_type = 'digital_change_due'
   and settlement_entry.source_line_key = btrim(line ->> 'line_key')
  on conflict (command_idempotency_key, line_key) do nothing;

  return v_result || jsonb_build_object(
    'eta_minutes', p_eta_minutes,
    'expected_collection_usd', v_expected_usd,
    'cash_change_usd', v_cash_change_usd,
    'digital_change_usd', v_digital_change_usd,
    'required_change_usd', v_required_change_usd
  );
end;
$function$;

revoke all on function public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) from public, anon;

grant execute on function public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) to authenticated, service_role;

commit;
