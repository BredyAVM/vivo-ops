-- Counter Block 3: lightweight, exact, on-demand read model.
--
-- This migration intentionally creates no tables and no indexes. It reuses:
--   - orders_counter_operational_idx
--   - idx_order_items_order_id_id
--   - idx_orders_order_number_trgm
--   - clients name/phone trigram indexes
--   - money movement, closure and baseline indexes
--
-- All public API functions are SECURITY DEFINER with an empty search_path,
-- an explicit authenticated role check, and narrow execute grants.

begin;

create or replace function public.counter_read_configuration()
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

  select jsonb_build_object(
    'fullName',
      coalesce(
        nullif(trim((select p.full_name from public.profiles p where p.id = (select auth.uid()))), ''),
        'Mostrador'
      ),
    'activeBsRate',
      coalesce((
        select er.rate_bs_per_usd
        from public.exchange_rates er
        where er.is_active = true
        order by er.effective_at desc, er.id desc
        limit 1
      ), 0),
    'paymentAccounts',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'accountId', ma.id,
            'accountName', coalesce(nullif(trim(ma.name), ''), 'Cuenta ' || ma.id::text),
            'accountKind', ma.account_kind::text,
            'currencyCode', ma.currency_code::text,
            'paymentMethodCode', rule.payment_method_code,
            'canReportPayment', coalesce(rule.can_report_payment, false),
            'canConfirmPayment', coalesce(rule.can_confirm_payment, false),
            'autoConfirmsReport', coalesce(rule.auto_confirms_report, false),
            'reviewRequired', coalesce(rule.review_required, false)
          )
          order by ma.id, rule.payment_method_code
        )
        from public.money_account_payment_rules rule
        join public.money_accounts ma on ma.id = rule.money_account_id
        where rule.role::text = 'counter'
          and rule.is_active = true
          and ma.is_active = true
          and ma.currency_code::text in ('USD', 'VES')
          and (
            coalesce(rule.can_report_payment, false)
            or coalesce(rule.can_confirm_payment, false)
            or coalesce(rule.auto_confirms_report, false)
          )
      ), '[]'::jsonb)
  )
  into v_payload;

  return v_payload;
end;
$function$;

create or replace function public.counter_read_active_queue(
  p_limit integer default 120
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 120), 1), 120);
  v_active_rate numeric;
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  select er.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates er
  where er.is_active = true
  order by er.effective_at desc, er.id desc
  limit 1;

  with selected_orders as materialized (
    select o.*
    from public.orders o
    where o.status in ('confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
       or (o.status = 'created' and o.source = 'walk_in')
    order by o.ready_at asc nulls last, o.created_at asc, o.id asc
    limit v_limit
  ),
  financial as materialized (
    select fs.*
    from public.get_orders_financial_state(
      coalesce((select array_agg(so.id) from selected_orders so), array[]::bigint[]),
      null,
      v_active_rate
    ) fs
  ),
  shaped as (
    select
      so.ready_at,
      so.created_at,
      so.id,
      jsonb_build_object(
        'id', so.id,
        'order_number', so.order_number,
        'status', so.status::text,
        'source', so.source::text,
        'fulfillment', so.fulfillment::text,
        'delivery_address', so.delivery_address,
        'delivery_mode', so.delivery_mode::text,
        'external_driver_name', so.external_driver_name,
        'external_reference', so.external_reference,
        'total_usd', so.total_usd,
        'total_bs_snapshot', so.total_bs_snapshot,
        'notes', so.notes,
        'created_at', so.created_at,
        'ready_at', so.ready_at,
        'extra_fields', coalesce(so.extra_fields, '{}'::jsonb),
        'client_name', coalesce(nullif(trim(c.full_name), ''), 'Cliente'),
        'client_phone', c.phone,
        'advisor_name', nullif(trim(advisor.full_name), ''),
        'delivery_assignee_kind',
          case
            when so.internal_driver_user_id is not null then 'internal'
            when so.external_partner_id is not null or nullif(trim(so.external_driver_name), '') is not null then 'external'
            else null
          end,
        'delivery_assignee_name',
          coalesce(
            nullif(trim(driver.full_name), ''),
            nullif(trim(partner.name), ''),
            nullif(trim(so.external_driver_name), '')
          ),
        'confirmed_paid_usd', coalesce(fs.confirmed_paid_usd, 0),
        'pending_usd', coalesce(fs.pending_usd, greatest(coalesce(so.total_usd, 0), 0)),
        'pending_reports_count', coalesce(fs.pending_reports_count, 0),
        'confirmed_reports_count', coalesce(fs.confirmed_reports_count, 0),
        'rejected_reports_count', coalesce(fs.rejected_reports_count, 0)
      ) as payload
    from selected_orders so
    left join financial fs on fs.order_id = so.id
    left join public.clients c on c.id = so.client_id
    left join public.profiles advisor on advisor.id = so.attributed_advisor_id
    left join public.profiles driver on driver.id = so.internal_driver_user_id
    left join public.delivery_partners partner on partner.id = so.external_partner_id
  )
  select coalesce(
    jsonb_agg(shaped.payload order by shaped.ready_at asc nulls last, shaped.created_at asc, shaped.id asc),
    '[]'::jsonb
  )
  into v_payload
  from shaped;

  return v_payload;
end;
$function$;

create or replace function public.counter_read_order_detail(
  p_order_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_active_rate numeric;
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

  select er.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates er
  where er.is_active = true
  order by er.effective_at desc, er.id desc
  limit 1;

  select jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'status', o.status::text,
    'source', o.source::text,
    'fulfillment', o.fulfillment::text,
    'delivery_address', o.delivery_address,
    'delivery_mode', o.delivery_mode::text,
    'external_driver_name', o.external_driver_name,
    'external_reference', o.external_reference,
    'total_usd', o.total_usd,
    'total_bs_snapshot', o.total_bs_snapshot,
    'notes', o.notes,
    'created_at', o.created_at,
    'ready_at', o.ready_at,
    'extra_fields', coalesce(o.extra_fields, '{}'::jsonb),
    'client_name', coalesce(nullif(trim(c.full_name), ''), 'Cliente'),
    'client_phone', c.phone,
    'advisor_name', nullif(trim(advisor.full_name), ''),
    'delivery_assignee_kind',
      case
        when o.internal_driver_user_id is not null then 'internal'
        when o.external_partner_id is not null or nullif(trim(o.external_driver_name), '') is not null then 'external'
        else null
      end,
    'delivery_assignee_name',
      coalesce(
        nullif(trim(driver.full_name), ''),
        nullif(trim(partner.name), ''),
        nullif(trim(o.external_driver_name), '')
      ),
    'confirmed_paid_usd', coalesce(fs.confirmed_paid_usd, 0),
    'pending_usd', coalesce(fs.pending_usd, greatest(coalesce(o.total_usd, 0), 0)),
    'pending_reports_count', coalesce(fs.pending_reports_count, 0),
    'confirmed_reports_count', coalesce(fs.confirmed_reports_count, 0),
    'rejected_reports_count', coalesce(fs.rejected_reports_count, 0),
    'items',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', oi.id,
            'qty', oi.qty,
            'name', coalesce(nullif(trim(oi.product_name_snapshot), ''), 'Producto'),
            'lineTotalUsd', coalesce(oi.line_total_usd, 0),
            'lineTotalBs', coalesce(oi.line_total_bs_snapshot, 0),
            'notes', oi.notes
          )
          order by oi.id
        )
        from public.order_items oi
        where oi.order_id = o.id
      ), '[]'::jsonb)
  )
  into v_payload
  from public.orders o
  left join public.clients c on c.id = o.client_id
  left join public.profiles advisor on advisor.id = o.attributed_advisor_id
  left join public.profiles driver on driver.id = o.internal_driver_user_id
  left join public.delivery_partners partner on partner.id = o.external_partner_id
  left join lateral public.get_order_financial_state(o.id, null, v_active_rate) fs on true
  where o.id = p_order_id;

  if v_payload is null then
    raise exception 'counter_order_not_found';
  end if;

  return v_payload;
end;
$function$;

create or replace function public.counter_read_catalog()
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

  select jsonb_build_object(
    'products',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'sku', p.sku,
            'name', coalesce(nullif(trim(p.name), ''), 'Producto'),
            'type', p.type::text,
            'sourcePriceCurrency', coalesce(p.source_price_currency::text, 'USD'),
            'sourcePriceAmount', coalesce(p.source_price_amount, 0),
            'basePriceUsd', coalesce(p.base_price_usd, 0),
            'basePriceBs', coalesce(p.base_price_bs, 0),
            'unitsPerService', coalesce(p.units_per_service, 0),
            'isDetailEditable', coalesce(p.is_detail_editable, false),
            'detailUnitsLimit', coalesce(p.detail_units_limit, 0),
            'isComboComponentSelectable', coalesce(p.is_combo_component_selectable, false)
          )
          order by p.name, p.id
        )
        from public.products p
        where p.is_active = true
      ), '[]'::jsonb),
    'components',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', pc.id,
            'parentProductId', pc.parent_product_id,
            'componentProductId', pc.component_product_id,
            'componentMode', pc.component_mode::text,
            'quantity', coalesce(pc.quantity, 0),
            'countsTowardDetailLimit', coalesce(pc.counts_toward_detail_limit, false),
            'isRequired', coalesce(pc.is_required, false),
            'sortOrder', coalesce(pc.sort_order, 0),
            'notes', pc.notes,
            'parentSku', parent.sku,
            'parentName', parent.name,
            'componentSku', component.sku,
            'componentName', coalesce(nullif(trim(component.name), ''), 'Componente'),
            'componentType', component.type::text
          )
          order by pc.parent_product_id, pc.sort_order, pc.id
        )
        from public.product_components pc
        join public.products parent
          on parent.id = pc.parent_product_id
         and parent.is_active = true
        join public.products component on component.id = pc.component_product_id
      ), '[]'::jsonb)
  )
  into v_payload;

  return v_payload;
end;
$function$;

create or replace function public.counter_read_cash_snapshot(
  p_movement_limit integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_movement_limit, 12), 1), 50);
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  with allowed_accounts as materialized (
    select
      ma.id,
      ma.name,
      ma.account_kind::text as account_kind,
      ma.currency_code::text as currency_code,
      array_agg(distinct rule.payment_method_code order by rule.payment_method_code)
        filter (where rule.payment_method_code is not null) as methods
    from public.money_accounts ma
    join public.money_account_payment_rules rule on rule.money_account_id = ma.id
    where ma.is_active = true
      and ma.currency_code::text in ('USD', 'VES')
      and rule.role::text = 'counter'
      and rule.is_active = true
      and (
        coalesce(rule.can_confirm_payment, false)
        or coalesce(rule.auto_confirms_report, false)
      )
      and (
        ma.account_kind::text = 'pos'
        or (
          ma.account_kind::text = 'cash'
          and (
            lower(coalesce(ma.name, '')) like '%dar%'
            or lower(coalesce(ma.name, '')) like '%dark%'
          )
        )
      )
    group by ma.id, ma.name, ma.account_kind, ma.currency_code
  ),
  anchors as materialized (
    select
      aa.*,
      closure_row.closure_date,
      coalesce(closure_row.closure_at, closure_row.created_at) as closure_anchor_at,
      closure_row.counted_amount as closure_amount,
      baseline_row.baseline_date,
      baseline_row.baseline_at,
      baseline_row.counted_amount as baseline_amount
    from allowed_accounts aa
    left join lateral (
      select
        mc.closure_date,
        mc.closure_at,
        mc.created_at,
        mc.counted_amount
      from public.money_account_closures mc
      where mc.money_account_id = aa.id
        and mc.status in ('recorded', 'approved')
      order by mc.closure_date desc, mc.closure_at desc nulls last, mc.created_at desc, mc.id desc
      limit 1
    ) closure_row on true
    left join lateral (
      select
        mb.baseline_date,
        mb.baseline_at,
        mb.counted_amount
      from public.money_account_closure_baselines mb
      where mb.money_account_id = aa.id
        and mb.status = 'active'
      order by mb.baseline_at desc, mb.id desc
      limit 1
    ) baseline_row on closure_row.closure_date is null
  ),
  balances as materialized (
    select
      a.id,
      round((
        coalesce(a.closure_amount, a.baseline_amount, 0)
        + coalesce(sum(
          case when mm.direction::text = 'inflow' then mm.amount else -mm.amount end
        ) filter (
          where
            case
              when a.closure_date is not null then
                mm.movement_date > a.closure_date
                or (
                  mm.movement_date = a.closure_date
                  and a.closure_anchor_at is not null
                  and coalesce(mm.confirmed_at, mm.created_at) > a.closure_anchor_at
                )
              when a.baseline_date is not null then mm.movement_date > a.baseline_date
              else true
            end
        ), 0)
      )::numeric, 2) as balance
    from anchors a
    left join public.money_movements mm
      on mm.money_account_id = a.id
     and mm.status::text = 'confirmed'
     and (
       a.closure_date is null
       or mm.movement_date >= a.closure_date
     )
     and (
       a.closure_date is not null
       or a.baseline_date is null
       or mm.movement_date > a.baseline_date
     )
    group by a.id, a.closure_date, a.closure_anchor_at, a.closure_amount, a.baseline_date, a.baseline_amount
  ),
  today_totals as materialized (
    select
      aa.id,
      round(coalesce(sum(mm.amount) filter (where mm.direction::text = 'inflow'), 0)::numeric, 2) as inflow,
      round(coalesce(sum(mm.amount) filter (where mm.direction::text = 'outflow'), 0)::numeric, 2) as outflow
    from allowed_accounts aa
    left join public.money_movements mm
      on mm.money_account_id = aa.id
     and mm.status::text = 'confirmed'
     and mm.movement_date = v_today
    group by aa.id
  ),
  shaped as (
    select
      a.account_kind,
      a.name,
      a.id,
      jsonb_build_object(
        'accountId', a.id,
        'accountName', coalesce(nullif(trim(a.name), ''), 'Cuenta ' || a.id::text),
        'accountKind', a.account_kind,
        'currencyCode', a.currency_code,
        'methods', coalesce(to_jsonb(a.methods), '[]'::jsonb),
        'inflow', coalesce(tt.inflow, 0),
        'outflow', coalesce(tt.outflow, 0),
        'net', round((coalesce(tt.inflow, 0) - coalesce(tt.outflow, 0))::numeric, 2),
        'balance', coalesce(b.balance, 0),
        'movements',
          coalesce((
            select jsonb_agg(recent.payload order by recent.created_at desc, recent.id desc)
            from (
              select
                mm.created_at,
                mm.id,
                jsonb_build_object(
                  'id', mm.id,
                  'movementDate', mm.movement_date,
                  'createdAt', mm.created_at,
                  'direction', mm.direction::text,
                  'movementType', mm.movement_type::text,
                  'amount', mm.amount,
                  'amountUsdEquivalent', mm.amount_usd_equivalent,
                  'currencyCode', mm.currency_code::text,
                  'referenceCode', mm.reference_code,
                  'counterpartyName', mm.counterparty_name,
                  'description', mm.description,
                  'orderId', mm.order_id,
                  'createdByName', nullif(trim(creator.full_name), '')
                ) as payload
              from public.money_movements mm
              left join public.profiles creator on creator.id = mm.created_by_user_id
              where mm.money_account_id = a.id
                and mm.status::text = 'confirmed'
                and mm.movement_date = v_today
              order by mm.created_at desc, mm.id desc
              limit v_limit
            ) recent
          ), '[]'::jsonb)
      ) as payload
    from anchors a
    join balances b on b.id = a.id
    join today_totals tt on tt.id = a.id
  )
  select coalesce(
    jsonb_agg(
      shaped.payload
      order by
        case shaped.account_kind when 'cash' then 1 when 'pos' then 2 else 3 end,
        shaped.name,
        shaped.id
    ),
    '[]'::jsonb
  )
  into v_payload
  from shaped;

  return v_payload;
end;
$function$;

create or replace function public.counter_search_clients(
  p_query text,
  p_cursor_id bigint default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_query text := trim(coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  if length(v_query) < 2 then
    return jsonb_build_object('results', '[]'::jsonb, 'nextCursorId', null);
  end if;

  with matched as materialized (
    select c.*
    from public.clients c
    where c.is_active = true
      and (p_cursor_id is null or c.id < p_cursor_id)
      and (
        public.search_normalize(c.full_name)
          like '%' || public.search_normalize(v_query) || '%'
        or c.phone ilike '%' || v_query || '%'
        or (
          regexp_replace(v_query, '[^0-9]', '', 'g') <> ''
          and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
              like '%' || regexp_replace(v_query, '[^0-9]', '', 'g') || '%'
        )
      )
    order by c.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from matched
    order by id desc
    limit v_limit
  )
  select jsonb_build_object(
    'results',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'fullName', coalesce(nullif(trim(p.full_name), ''), 'Cliente'),
            'phone', p.phone,
            'clientType', p.client_type,
            'fundBalanceUsd', coalesce(p.fund_balance_usd, 0)
          )
          order by p.id desc
        )
        from page p
      ), '[]'::jsonb),
    'nextCursorId',
      case
        when (select count(*) from matched) > v_limit
          then (select min(p.id) from page p)
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

create or replace function public.counter_read_pending_settlements(
  p_cursor_dispatched_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  with matched as materialized (
    select
      ds.*,
      o.order_number,
      o.fulfillment::text as fulfillment,
      c.full_name as client_name,
      c.phone as client_phone,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'expected_collection'
      ), 0) as expected_collection_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'customer_collection'
      ), 0) as customer_collection_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'cash_change_out'
      ), 0) as cash_change_out_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'cash_change_returned'
      ), 0) as cash_change_returned_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'cash_return'
      ), 0) as cash_return_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'digital_change_due'
      ), 0) as digital_change_due_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'digital_change_completed'
      ), 0) as digital_change_completed_usd
    from public.delivery_settlements ds
    join public.orders o on o.id = ds.order_id
    left join public.clients c on c.id = o.client_id
    left join public.delivery_settlement_entries dse on dse.settlement_id = ds.id
    where ds.status in ('open', 'partial', 'discrepancy')
      and (
        p_cursor_dispatched_at is null
        or p_cursor_id is null
        or (ds.dispatched_at, ds.id) < (p_cursor_dispatched_at, p_cursor_id)
      )
    group by ds.id, o.id, c.id
    order by ds.dispatched_at desc, ds.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from matched
    order by dispatched_at desc, id desc
    limit v_limit
  )
  select jsonb_build_object(
    'results',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'orderId', p.order_id,
            'displayNumber', lpad(p.order_id::text, 2, '0'),
            'orderNumber', p.order_number,
            'status', p.status,
            'fulfillment', p.fulfillment,
            'clientName', coalesce(nullif(trim(p.client_name), ''), 'Cliente'),
            'clientPhone', p.client_phone,
            'responsibleName', p.responsible_name,
            'dispatchedAt', p.dispatched_at,
            'expectedCollectionUsd', round(p.expected_collection_usd::numeric, 2),
            'customerCollectionUsd', round(p.customer_collection_usd::numeric, 2),
            'cashChangeOutstandingUsd',
              round(greatest(0, p.cash_change_out_usd - p.cash_change_returned_usd)::numeric, 2),
            'cashReturnedUsd', round(p.cash_return_usd::numeric, 2),
            'digitalChangeOutstandingUsd',
              round(greatest(0, p.digital_change_due_usd - p.digital_change_completed_usd)::numeric, 2),
            'version', p.version
          )
          order by p.dispatched_at desc, p.id desc
        )
        from page p
      ), '[]'::jsonb),
    'nextCursor',
      case
        when (select count(*) from matched) > v_limit then (
          select jsonb_build_object('dispatchedAt', p.dispatched_at, 'id', p.id)
          from page p
          order by p.dispatched_at asc, p.id asc
          limit 1
        )
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

create or replace function public.counter_search_orders(
  p_query text,
  p_cursor_created_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_query text := trim(coalesce(p_query, ''));
  v_digits text := regexp_replace(trim(coalesce(p_query, '')), '[^0-9]', '', 'g');
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  if length(v_query) < 2 then
    return jsonb_build_object('results', '[]'::jsonb, 'nextCursor', null);
  end if;

  with matched as materialized (
    select o.*, c.full_name as client_name, c.phone as client_phone
    from public.orders o
    left join public.clients c on c.id = o.client_id
    where (
      p_cursor_created_at is null
      or p_cursor_id is null
      or (o.created_at, o.id) < (p_cursor_created_at, p_cursor_id)
    )
      and (
        o.order_number ilike '%' || v_query || '%'
        or public.search_normalize(c.full_name)
          like '%' || public.search_normalize(v_query) || '%'
        or c.phone ilike '%' || v_query || '%'
        or (
          v_digits <> ''
          and (
            o.id = case when length(v_digits) <= 18 then v_digits::bigint else null end
            or regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%'
          )
        )
      )
    order by o.created_at desc, o.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from matched
    order by created_at desc, id desc
    limit v_limit
  )
  select jsonb_build_object(
    'results',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'displayNumber', lpad(p.id::text, 2, '0'),
            'orderNumber', p.order_number,
            'status', p.status::text,
            'fulfillment', p.fulfillment::text,
            'clientName', coalesce(nullif(trim(p.client_name), ''), 'Cliente'),
            'clientPhone', p.client_phone,
            'scheduledDate', p.extra_fields->'schedule'->>'date',
            'scheduledTime',
              case
                when coalesce((p.extra_fields->'schedule'->>'asap')::boolean, false) then 'Lo antes posible'
                else coalesce(
                  p.extra_fields->'schedule'->>'time_12',
                  p.extra_fields->'schedule'->>'time_24'
                )
              end,
            'totalUsd',
              round(coalesce(
                nullif(p.extra_fields->'pricing'->>'total_usd', '')::numeric,
                p.total_usd,
                0
              ), 2),
            'totalBs',
              round(coalesce(
                nullif(p.extra_fields->'pricing'->>'total_bs', '')::numeric,
                p.total_bs_snapshot,
                0
              ), 2),
            'note', p.notes,
            'createdAt', p.created_at
          )
          order by p.created_at desc, p.id desc
        )
        from page p
      ), '[]'::jsonb),
    'nextCursor',
      case
        when (select count(*) from matched) > v_limit then (
          select jsonb_build_object('createdAt', p.created_at, 'id', p.id)
          from page p
          order by p.created_at asc, p.id asc
          limit 1
        )
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

revoke all on function public.counter_read_configuration() from public;
revoke all on function public.counter_read_configuration() from anon;
grant execute on function public.counter_read_configuration() to authenticated;
grant execute on function public.counter_read_configuration() to service_role;

revoke all on function public.counter_read_active_queue(integer) from public;
revoke all on function public.counter_read_active_queue(integer) from anon;
grant execute on function public.counter_read_active_queue(integer) to authenticated;
grant execute on function public.counter_read_active_queue(integer) to service_role;

revoke all on function public.counter_read_order_detail(bigint) from public;
revoke all on function public.counter_read_order_detail(bigint) from anon;
grant execute on function public.counter_read_order_detail(bigint) to authenticated;
grant execute on function public.counter_read_order_detail(bigint) to service_role;

revoke all on function public.counter_read_catalog() from public;
revoke all on function public.counter_read_catalog() from anon;
grant execute on function public.counter_read_catalog() to authenticated;
grant execute on function public.counter_read_catalog() to service_role;

revoke all on function public.counter_read_cash_snapshot(integer) from public;
revoke all on function public.counter_read_cash_snapshot(integer) from anon;
grant execute on function public.counter_read_cash_snapshot(integer) to authenticated;
grant execute on function public.counter_read_cash_snapshot(integer) to service_role;

revoke all on function public.counter_read_pending_settlements(timestamptz, bigint, integer) from public;
revoke all on function public.counter_read_pending_settlements(timestamptz, bigint, integer) from anon;
grant execute on function public.counter_read_pending_settlements(timestamptz, bigint, integer) to authenticated;
grant execute on function public.counter_read_pending_settlements(timestamptz, bigint, integer) to service_role;

revoke all on function public.counter_search_clients(text, bigint, integer) from public;
revoke all on function public.counter_search_clients(text, bigint, integer) from anon;
grant execute on function public.counter_search_clients(text, bigint, integer) to authenticated;
grant execute on function public.counter_search_clients(text, bigint, integer) to service_role;

revoke all on function public.counter_search_orders(text, timestamptz, bigint, integer) from public;
revoke all on function public.counter_search_orders(text, timestamptz, bigint, integer) from anon;
grant execute on function public.counter_search_orders(text, timestamptz, bigint, integer) to authenticated;
grant execute on function public.counter_search_orders(text, timestamptz, bigint, integer) to service_role;

commit;
