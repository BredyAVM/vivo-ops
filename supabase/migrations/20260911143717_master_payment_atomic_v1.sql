-- Version aligned with the applied Supabase migration history.
begin;
set local lock_timeout = '5s';

-- One immutable receipt per confirmed report. Protected writes are needed here
-- so neither an API client nor a caller-supplied actor can forge a retry result.
create table public.payment_confirmation_operations (
  report_id bigint primary key references public.payment_reports(id),
  order_id bigint not null references public.orders(id),
  movement_id bigint not null unique references public.money_movements(id),
  movement_group_id uuid not null unique,
  fund_movement_id bigint unique references public.client_fund_movements(id),
  adjustment_id bigint unique references public.order_admin_adjustments(id),
  event_id bigint not null unique references public.order_timeline_events(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  request jsonb not null,
  result jsonb not null
);
create index payment_confirmation_operations_order_idx on public.payment_confirmation_operations(order_id);
alter table public.payment_confirmation_operations enable row level security;
revoke all on public.payment_confirmation_operations from public, anon, authenticated, service_role;
grant select on public.payment_confirmation_operations to authenticated;
create policy payment_confirmation_operations_read on public.payment_confirmation_operations
  for select to authenticated using (public.is_master_or_admin() or (created_by=(select auth.uid()) and public.has_role('counter')));

create function app_private.confirm_payment_report_atomic_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_admin boolean;
  v_master boolean;
  v_report_id bigint;
  v_report public.payment_reports%rowtype;
  v_order public.orders%rowtype;
  v_prior public.payment_confirmation_operations%rowtype;
  v_account public.money_accounts%rowtype;
  v_account_id bigint;
  v_currency public.currency_code;
  v_amount numeric;
  v_rate numeric;
  v_usd numeric;
  v_date date;
  v_handling text;
  v_notes text;
  v_changes jsonb;
  v_line jsonb;
  v_line_account bigint;
  v_line_currency public.currency_code;
  v_line_amount numeric;
  v_line_rate numeric;
  v_line_usd numeric;
  v_change_total numeric := 0;
  v_fund numeric := 0;
  v_fund_id bigint;
  v_excess numeric;
  v_before record;
  v_after record;
  v_movement_id bigint;
  v_change_id bigint;
  v_movement_ids jsonb;
  v_group uuid := gen_random_uuid();
  v_event_id bigint;
  v_adjustment_id bigint;
  v_extra jsonb;
  v_pricing jsonb;
  v_payment jsonb;
  v_total_bs numeric;
  v_fx numeric;
  v_payload jsonb;
  v_result jsonb;
  v_now timestamptz := statement_timestamp();
begin
  v_admin := exists(select 1 from public.user_roles where user_id=v_uid and role='admin');
  v_master := v_admin or exists(select 1 from public.user_roles where user_id=v_uid and role='master');
  if v_uid is null or not (v_master or public.has_role('counter')) then
    raise exception 'No tienes permiso para confirmar pagos.' using errcode='42501';
  end if;
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'Datos de confirmación inválidos.' using errcode='22023';
  end if;
  v_report_id := (p_input->>'reportId')::bigint;
  v_account_id := (p_input->>'accountId')::bigint;
  v_currency := (p_input->>'currency')::public.currency_code;
  v_amount := (p_input->>'amount')::numeric;
  v_rate := (p_input->>'rate')::numeric;
  v_handling := p_input->>'handling';
  v_notes := nullif(btrim(p_input->>'notes'),'');
  v_changes := coalesce(p_input->'changeLines','[]'::jsonb);
  if v_report_id is null or v_report_id<=0 or v_account_id is null or v_account_id<=0
    or v_currency is null or v_currency not in ('USD','VES')
    or v_amount is null or not(v_amount>0 and v_amount<=1000000000) or round(v_amount,2)<>v_amount
    or (v_currency='USD' and v_rate is not null)
    or (v_currency='VES' and (v_rate is null or not(v_rate>0 and v_rate<=1000000000)))
    or (v_handling is not null and v_handling not in ('change_given','store_fund','close_difference'))
    or (p_input->>'paymentKind' is not null and p_input->>'paymentKind'<>'retention')
    or jsonb_typeof(v_changes) is distinct from 'array' then
    raise exception 'Revisa el importe, moneda, tasa y decisión sobre el excedente.' using errcode='22023';
  end if;
  if jsonb_array_length(v_changes)>12 or (jsonb_array_length(v_changes)>0 and v_handling is distinct from 'change_given') then
    raise exception 'Líneas de cambio inválidas.' using errcode='22023';
  end if;
  if v_handling='close_difference' and not v_admin then
    raise exception 'Solo admin puede cerrar excedentes por redondeo.' using errcode='42501';
  end if;
  v_usd := round(case when v_currency='VES' then v_amount/v_rate else v_amount end,2);
  if v_usd<=0 then raise exception 'El importe convertido es menor a 0,01 USD.' using errcode='22023'; end if;

  -- The report itself is the stable intent identity; no new user field is needed.
  perform pg_advisory_xact_lock(hashtextextended('payment-confirmation:'||v_report_id::text,0));
  select * into v_prior from public.payment_confirmation_operations where report_id=v_report_id;
  if found then
    if v_prior.created_by<>v_uid or v_prior.request<>p_input then
      raise exception 'Este pago ya fue confirmado con otros datos. Actualiza la pantalla.' using errcode='22023';
    end if;
    if not exists(select 1 from public.payment_reports where id=v_report_id and status='confirmed' and confirmed_movement_id=v_prior.movement_id)
      or exists(select 1 from jsonb_array_elements_text(v_prior.result->'movementIds') ids(value)
        left join public.money_movements m on m.id=ids.value::bigint where m.status is distinct from 'confirmed') then
      raise exception 'El pago fue anulado o modificado; no se puede reenviar.' using errcode='22023';
    end if;
    return v_prior.result || jsonb_build_object('replayed',true);
  end if;
  select * into v_report from public.payment_reports where id=v_report_id;
  if not found then raise exception 'No se encontró el reporte de pago.' using errcode='22023'; end if;
  if not v_master and (v_report.created_by_user_id<>v_uid or v_report.reported_money_account_id<>v_account_id
    or v_report.reported_currency_code<>v_currency or v_report.reported_amount<>v_amount
    or not public.is_counter_direct_money_account(v_account_id)) then
    raise exception 'No tienes permiso para confirmar este reporte.' using errcode='42501';
  end if;
  -- Same lock order as Counter: order, accounts (ascending), report, client.
  select * into v_order from public.orders where id=v_report.order_id for update;
  if not found or v_order.status='cancelled' then
    raise exception 'La orden no existe o está cancelada.' using errcode='22023';
  end if;
  if ((p_input->>'orderId')::bigint is not null and (p_input->>'orderId')::bigint<>v_order.id)
    or ((p_input->>'clientId')::bigint is not null and (p_input->>'clientId')::bigint is distinct from v_order.client_id) then
    raise exception 'El reporte, la orden y el cliente no coinciden.' using errcode='22023';
  end if;
  for v_line_account in
    select distinct id from (
      select v_account_id as id union all
      select (line->>'accountId')::bigint from jsonb_array_elements(v_changes) line
    ) ids order by id
  loop
    select * into v_account from public.money_accounts where id=v_line_account for update;
    if not found or not v_account.is_active then
      raise exception 'Selecciona cuentas activas para el pago y el cambio.' using errcode='22023';
    end if;
    if not v_master and not exists(select 1 from public.money_account_payment_rules r
      join public.user_roles ur on ur.role=r.role and ur.user_id=v_uid
      where r.money_account_id=v_line_account and r.is_active and (r.can_confirm_payment or r.auto_confirms_report)) then
      raise exception 'No tienes permiso para operar con una de estas cuentas.' using errcode='42501';
    end if;
  end loop;
  select * into v_report from public.payment_reports where id=v_report_id for update;
  if v_report.status<>'pending' or v_report.order_id<>v_order.id then
    raise exception 'Este reporte ya fue revisado o cambió de orden.' using errcode='22023';
  end if;
  if coalesce((p_input->>'overrideOperationDate')::boolean,false) then
    if not v_master then raise exception 'No puedes modificar la fecha del reporte.' using errcode='42501'; end if;
    v_date := (p_input->>'date')::date;
  else
    v_date := coalesce(v_report.operation_date,(p_input->>'date')::date,(v_now at time zone 'America/Caracas')::date);
  end if;
  if v_date is null or not isfinite(v_date) then raise exception 'Fecha de operación inválida.' using errcode='22023'; end if;
  select * into v_before from public.get_order_financial_state(v_order.id,v_date,v_rate);
  if not found then raise exception 'No se pudo calcular el saldo de la orden.' using errcode='22023'; end if;
  update public.payment_reports set operation_date=v_date where id=v_report_id;
  v_movement_id := public.confirm_payment_report(v_report_id,v_account_id,v_currency,v_amount,v_date,v_rate,
    p_input->>'reviewNotes',p_input->>'reference',p_input->>'counterparty',p_input->>'description');
  update public.money_movements set movement_group_id=v_group where id=v_movement_id;
  v_movement_ids := jsonb_build_array(v_movement_id);
  select * into v_after from public.get_order_financial_state(v_order.id,v_date,v_rate);
  -- Never assign old unresolved overpayments to this report or credit more than
  -- the amount actually confirmed (which may differ from the reported amount).
  v_excess := least(v_usd,greatest(0,round(v_after.overpaid_usd-v_before.overpaid_usd,2)));
  if v_excess>0 and v_handling is null then
    if coalesce((p_input->>'requireExplicitHandling')::boolean,false) then
      raise exception 'Debes decidir qué hacer con el excedente antes de confirmar.' using errcode='22023';
    end if;
    v_handling := 'store_fund';
  end if;
  if v_handling='change_given' then
    if v_excess<=0 or jsonb_array_length(v_changes)=0 then
      raise exception 'No hay excedente disponible o faltan las líneas de cambio.' using errcode='22023';
    end if;
    for v_line in select value from jsonb_array_elements(v_changes) loop
      v_line_account := (v_line->>'accountId')::bigint;
      v_line_currency := (v_line->>'currency')::public.currency_code;
      v_line_rate := (v_line->>'rate')::numeric;
      if v_line_currency is null or v_line_currency not in ('USD','VES')
        or not exists(select 1 from public.money_accounts where id=v_line_account and currency_code=v_line_currency)
        or (v_line_currency='USD' and v_line_rate is not null)
        or (v_line_currency='VES' and (v_line_rate is null or not(v_line_rate>0 and v_line_rate<=1000000000))) then
        raise exception 'Cuenta, moneda o tasa del cambio inválida.' using errcode='22023';
      end if;
      v_line_amount := coalesce((v_line->>'amount')::numeric,
        case when jsonb_array_length(v_changes)=1 then round(v_excess*coalesce(v_line_rate,1),2) end);
      if v_line_amount is null or not(v_line_amount>0 and v_line_amount<=1000000000) or round(v_line_amount,2)<>v_line_amount then
        raise exception 'Monto del cambio inválido.' using errcode='22023';
      end if;
      v_line_usd := round(v_line_amount/coalesce(v_line_rate,1),2);
      if v_line_usd<=0 then raise exception 'Monto convertido del cambio inválido.' using errcode='22023'; end if;
      v_change_total := v_change_total+v_line_usd;
      if v_change_total>v_excess then
        raise exception 'El cambio supera el excedente disponible de USD %.',v_excess using errcode='22023';
      end if;
      insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,status,
        direction,movement_type,money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,
        reference_code,counterparty_name,description,notes,order_id,movement_group_id)
      values(v_date,v_uid,v_now,v_uid,'confirmed','outflow',
        case when p_input->>'paymentKind'='retention' then 'withdrawal'::public.movement_type else 'change_given'::public.movement_type end,
        v_line_account,v_line_currency,v_line_amount,v_line_rate,v_line_usd,p_input->>'reference',p_input->>'counterparty',
        case when p_input->>'paymentKind'='retention' then 'Devolución de retención' else 'Cambio entregado' end
          ||' · orden '||v_order.id||' · reporte '||v_report_id,
        coalesce(nullif(btrim(v_line->>'notes'),''),v_notes),v_order.id,v_group) returning id into v_change_id;
      v_movement_ids := v_movement_ids || jsonb_build_array(v_change_id);
    end loop;
    if coalesce((p_input->>'requireExactChange')::boolean,false) and abs(v_change_total-v_excess)>0.01 then
      raise exception 'El cambio debe coincidir con el excedente calculado.' using errcode='22023';
    end if;
    v_fund := v_excess-v_change_total;
  elsif v_handling='store_fund' then v_fund := v_excess;
  end if;
  if v_fund>0 then
    if v_order.client_id is null then raise exception 'La orden necesita un cliente para guardar el saldo a favor.' using errcode='22023'; end if;
    update public.clients set fund_balance_usd=round(fund_balance_usd+v_fund,2) where id=v_order.client_id;
    if not found then raise exception 'No se pudo guardar el saldo a favor.' using errcode='22023'; end if;
    insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,money_account_id,
      order_id,payment_report_id,reason_code,notes,created_by_user_id,movement_group_id)
    values(v_order.client_id,'credit',v_currency::text,round(v_fund*coalesce(v_rate,1),2),v_fund,v_account_id,
      v_order.id,v_report_id,case when p_input->>'paymentKind'='retention' then 'retention_overage_stored' else 'payment_overage_stored' end,
      v_notes,v_uid,v_group) returning id into v_fund_id;
  end if;
  if v_handling='close_difference' and v_excess>0 then
    if v_after.overpaid_usd>1 then raise exception 'Solo se pueden cerrar diferencias de hasta 1,00 USD.' using errcode='22023'; end if;
    v_extra := coalesce(v_order.extra_fields,'{}'::jsonb);
    v_pricing := coalesce(v_extra->'pricing','{}'::jsonb);
    v_payment := coalesce(v_extra->'payment','{}'::jsonb);
    v_fx := coalesce(nullif(v_pricing->>'fx_rate','')::numeric,0);
    v_total_bs := case when v_fx>0 then round(v_after.confirmed_paid_usd*v_fx,2)
      when v_after.total_usd>0 then round(v_after.total_bs/v_after.total_usd*v_after.confirmed_paid_usd,2) else v_after.total_bs end;
    v_pricing := v_pricing || jsonb_build_object('total_usd',v_after.confirmed_paid_usd,'total_bs',v_total_bs,
      'rounding_gain_closed_usd',v_after.overpaid_usd,'rounding_gain_close_applied_at',v_now,'rounding_gain_close_applied_by',v_uid);
    v_payment := v_payment || jsonb_build_object('rounding_gain_close',jsonb_build_object('closed_balance_usd',v_after.overpaid_usd,
      'previous_total_usd',v_after.total_usd,'next_total_usd',v_after.confirmed_paid_usd,'applied_at',v_now,'applied_by',v_uid,'notes',v_notes));
    update public.orders set total_usd=v_after.confirmed_paid_usd,total_bs_snapshot=v_total_bs,
      extra_fields=v_extra || jsonb_build_object('pricing',v_pricing,'payment',v_payment),last_modified_at=v_now,last_modified_by=v_uid where id=v_order.id;
    insert into public.order_admin_adjustments(order_id,adjustment_type,reason,notes,payload,created_by_user_id)
    values(v_order.id,'other','Cierre de excedente por redondeo',v_notes,jsonb_build_object('kind','rounding_gain_close',
      'delta_usd',v_after.overpaid_usd,'original_unit_price_usd',v_after.total_usd,'override_unit_price_usd',v_after.confirmed_paid_usd,
      'product_name','Cierre por redondeo','qty',1,'closed_balance_usd',v_after.overpaid_usd,
      'previous_total_usd',v_after.total_usd,'previous_total_bs',v_after.total_bs,'confirmed_paid_usd',v_after.confirmed_paid_usd,
      'next_total_usd',v_after.confirmed_paid_usd,'next_total_bs',v_total_bs,'payment_report_id',v_report_id,
      'previous_pricing',v_extra->'pricing','previous_payment',v_extra->'payment'),v_uid) returning id into v_adjustment_id;
  end if;
  v_payload := jsonb_build_object('report_id',v_report_id,'confirmed_money_account_id',v_account_id,'confirmed_currency',v_currency,
    'confirmed_amount',v_amount,'movement_date',v_date,'exchange_rate_ves_per_usd',v_rate,'movement_group_id',v_group,
    'movement_ids',v_movement_ids,'change_usd',v_change_total,'fund_credit_usd',v_fund,'fund_movement_id',v_fund_id,
    'adjustment_id',v_adjustment_id,'handling',v_handling,'atomic_version',1);
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
  values(v_order.id,v_order.order_number,'payment_confirmed','payment','Pago confirmado','El pago reportado fue confirmado.',
    'info',v_uid,v_payload) returning id into v_event_id;
  v_result := jsonb_build_object('orderId',v_order.id,'eventId',v_event_id,'movementId',v_movement_id,'movementIds',v_movement_ids,
    'movementGroupId',v_group,'payload',v_payload,'replayed',false);
  insert into public.payment_confirmation_operations(report_id,order_id,movement_id,movement_group_id,fund_movement_id,
    adjustment_id,event_id,created_by,request,result)
  values(v_report_id,v_order.id,v_movement_id,v_group,v_fund_id,v_adjustment_id,v_event_id,v_uid,p_input,v_result);
  return v_result;
end;
$fn$;

create function public.confirm_payment_report_atomic_v1(p_input jsonb)
returns jsonb language sql security invoker set search_path=''
as $fn$ select app_private.confirm_payment_report_atomic_v1(p_input); $fn$;
revoke all on function app_private.confirm_payment_report_atomic_v1(jsonb) from public,anon,service_role;
revoke all on function public.confirm_payment_report_atomic_v1(jsonb) from public,anon,service_role;
grant execute on function app_private.confirm_payment_report_atomic_v1(jsonb), public.confirm_payment_report_atomic_v1(jsonb) to authenticated;
comment on function app_private.confirm_payment_report_atomic_v1(jsonb) is
  'Narrow privileged payment command: persisted roles, report ownership, locked order/accounts, atomic funds and protected replay evidence. No caller-supplied actor.';
CREATE OR REPLACE FUNCTION public.get_order_financial_state_block3(p_order_id bigint, p_operation_date date DEFAULT NULL::date, p_active_bs_rate numeric DEFAULT NULL::numeric)
 RETURNS TABLE(order_id bigint, order_number text, order_status text, total_usd numeric, total_bs numeric, snapshot_rate_bs_per_usd numeric, confirmed_paid_usd numeric, confirmed_paid_bs_snapshot numeric, pending_reports_usd numeric, pending_reports_bs_snapshot numeric, rejected_reports_usd numeric, voided_movements_count integer, rejected_reports_count integer, pending_reports_count integer, confirmed_reports_count integer, client_fund_used_usd numeric, pending_usd numeric, pending_bs numeric, overpaid_usd numeric, collection_mode text, payment_status text, delivery_reference_date date, effective_operation_date date)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with confirmed_report_input as (
  -- Preserve reported evidence; only new certified confirmations substitute the
  -- actual movement for snapshot coverage. Historical reports are not revalued.
  select r.order_id,r.status,r.operation_date,r.created_at,
    coalesce(m.currency_code,r.reported_currency_code) as reported_currency_code,
    coalesce(m.amount,r.reported_amount) as reported_amount,
    coalesce(m.amount_usd_equivalent,r.reported_amount_usd_equivalent) as reported_amount_usd_equivalent
  from public.payment_reports r
  left join public.payment_confirmation_operations op on op.report_id=r.id
  left join public.money_movements m on m.id=op.movement_id
    and r.status='confirmed' and m.status='confirmed'
),
base_order_raw as (
  select
    order_row.id,
    order_row.order_number,
    order_row.status,
    order_row.extra_fields,
    round(coalesce(
      nullif(order_row.extra_fields->'pricing'->>'total_usd', '')::numeric,
      order_row.total_usd,
      0
    ), 2) as effective_total_usd,
    round(coalesce(
      nullif(order_row.extra_fields->'pricing'->>'total_bs', '')::numeric,
      order_row.total_bs_snapshot,
      0
    ), 2) as effective_total_bs,
    nullif(order_row.extra_fields->'pricing'->>'fx_rate', '')::numeric
      as stored_snapshot_rate,
    round(coalesce(
      nullif(order_row.extra_fields->'payment'->>'client_fund_used_usd', '')::numeric,
      0
    ), 2) as stored_client_fund_used_usd,
    case
      when order_row.extra_fields->'delivery'->>'completed_at' is not null
        and btrim(order_row.extra_fields->'delivery'->>'completed_at') <> ''
        then (
          (order_row.extra_fields->'delivery'->>'completed_at')::timestamptz
          at time zone 'America/Caracas'
        )::date
      when order_row.extra_fields->'schedule'->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
        then (order_row.extra_fields->'schedule'->>'date')::date
      else null
    end as delivery_reference_date
  from public.orders order_row
  where order_row.id = p_order_id
),
base_order as (
  select
    raw.*,
    case
      when coalesce(raw.stored_snapshot_rate, 0) > 0
        then round(raw.stored_snapshot_rate, 6)
      when raw.effective_total_usd > 0 and raw.effective_total_bs > 0
        then round(raw.effective_total_bs / raw.effective_total_usd, 6)
      else 0
    end as effective_snapshot_rate
  from base_order_raw raw
),
effective_dates as (
  select
    base.*,
    coalesce(
      p_operation_date,
      (now() at time zone 'America/Caracas')::date
    ) as effective_operation_date
  from base_order base
),
movement_totals as (
  select
    movement.order_id,
    round(sum(
      case
        when movement.status = 'confirmed' and movement.direction = 'inflow'
          then coalesce(movement.amount_usd_equivalent, 0)
        when movement.status = 'confirmed'
          and movement.direction = 'outflow'
          and movement.movement_type = 'change_given'
          then -coalesce(movement.amount_usd_equivalent, 0)
        else 0
      end
    )::numeric, 2) as confirmed_paid_usd,
    count(*) filter (where movement.status = 'voided')::integer
      as voided_movements_count
  from public.money_movements movement
  where movement.order_id = p_order_id
  group by movement.order_id
),
report_totals as (
  select
    report.order_id,
    round(coalesce(sum(
      coalesce(report.reported_amount_usd_equivalent, 0)
    ) filter (where report.status = 'pending'), 0)::numeric, 2)
      as pending_reports_usd,
    round(coalesce(sum(
      coalesce(report.reported_amount_usd_equivalent, 0)
    ) filter (where report.status = 'rejected'), 0)::numeric, 2)
      as rejected_reports_usd,
    count(*) filter (where report.status = 'pending')::integer
      as pending_reports_count,
    count(*) filter (where report.status = 'confirmed')::integer
      as confirmed_reports_count,
    count(*) filter (where report.status = 'rejected')::integer
      as rejected_reports_count
  from confirmed_report_input report
  where report.order_id = p_order_id
  group by report.order_id
),
confirmed_report_bs as (
  select
    report.order_id,
    round(sum(
      case
        when report.status <> 'confirmed' then 0
        when upper(coalesce(report.reported_currency_code::text, '')) = 'VES'
          then coalesce(report.reported_amount, 0)
        when dates.effective_snapshot_rate > 0
          then coalesce(report.reported_amount_usd_equivalent, 0)
            * dates.effective_snapshot_rate
        else 0
      end
    )::numeric, 2) as confirmed_report_paid_bs_snapshot,
    round(sum(
      case
        when report.status <> 'confirmed' then 0
        else coalesce(report.reported_amount_usd_equivalent, 0)
      end
    )::numeric, 2) as confirmed_report_paid_usd
  from confirmed_report_input report
  join effective_dates dates on dates.id = report.order_id
  where report.order_id = p_order_id
  group by report.order_id
),
pending_report_bs as (
  select
    report.order_id,
    round(sum(
      case
        when report.status <> 'pending' then 0
        when upper(coalesce(report.reported_currency_code::text, '')) = 'VES'
          then coalesce(report.reported_amount, 0)
        when dates.effective_snapshot_rate > 0
          then coalesce(report.reported_amount_usd_equivalent, 0)
            * dates.effective_snapshot_rate
        else 0
      end
    )::numeric, 2) as pending_reports_bs_snapshot
  from confirmed_report_input report
  join effective_dates dates on dates.id = report.order_id
  where report.order_id = p_order_id
  group by report.order_id
),
fund_ledger_for_order as (
  select
    fund.order_id,
    round(sum(
      case
        when fund.movement_type = 'debit'
          and coalesce(fund.reason_code, '') = 'order_fund_applied'
          then coalesce(fund.amount_usd, 0)
        when fund.movement_type = 'credit'
          and coalesce(fund.reason_code, '') = 'order_fund_restore'
          then -coalesce(fund.amount_usd, 0)
        else 0
      end
    )::numeric, 2) as fund_used_usd_from_ledger,
    round(sum(
      case
        when fund.movement_type = 'credit'
          and coalesce(fund.reason_code, '') in (
            'payment_overage_stored',
            'retention_overage_stored'
          )
          then coalesce(fund.amount_usd, 0)
        when fund.movement_type = 'debit'
          and coalesce(fund.reason_code, '') = 'payment_void_fund_reversal'
          then -coalesce(fund.amount_usd, 0)
        else 0
      end
    )::numeric, 2) as fund_stored_usd_from_ledger
  from public.client_fund_movements fund
  where fund.order_id = p_order_id
  group by fund.order_id
),
calculated as (
  select
    dates.id as order_id,
    dates.order_number,
    dates.status as order_status,
    dates.effective_total_usd as total_usd,
    dates.effective_total_bs as total_bs,
    dates.effective_snapshot_rate as snapshot_rate_bs_per_usd,
    coalesce(movement.confirmed_paid_usd, 0) as confirmed_money_usd,
    coalesce(confirmed.confirmed_report_paid_usd, 0)
      as confirmed_report_paid_usd,
    coalesce(confirmed.confirmed_report_paid_bs_snapshot, 0)
      as confirmed_report_paid_bs_snapshot,
    coalesce(
      fund.fund_used_usd_from_ledger,
      dates.stored_client_fund_used_usd,
      0
    ) as client_fund_used_usd,
    coalesce(fund.fund_stored_usd_from_ledger, 0) as fund_stored_usd,
    coalesce(reports.pending_reports_usd, 0) as pending_reports_usd,
    coalesce(pending.pending_reports_bs_snapshot, 0)
      as pending_reports_bs_snapshot,
    coalesce(reports.rejected_reports_usd, 0) as rejected_reports_usd,
    coalesce(movement.voided_movements_count, 0) as voided_movements_count,
    coalesce(reports.rejected_reports_count, 0) as rejected_reports_count,
    coalesce(reports.pending_reports_count, 0) as pending_reports_count,
    coalesce(reports.confirmed_reports_count, 0) as confirmed_reports_count,
    dates.delivery_reference_date,
    dates.effective_operation_date
  from effective_dates dates
  left join movement_totals movement on movement.order_id = dates.id
  left join report_totals reports on reports.order_id = dates.id
  left join confirmed_report_bs confirmed on confirmed.order_id = dates.id
  left join pending_report_bs pending on pending.order_id = dates.id
  left join fund_ledger_for_order fund on fund.order_id = dates.id
),
balances as (
  select
    calculated.*,
    greatest(0, round((
      calculated.confirmed_money_usd
      - calculated.fund_stored_usd
      + calculated.client_fund_used_usd
    )::numeric, 2)) as applied_paid_usd,
    greatest(0, round((
      calculated.total_usd
      - (
        calculated.confirmed_money_usd
        - calculated.fund_stored_usd
        + calculated.client_fund_used_usd
      )
    )::numeric, 2)) as pending_usd,
    greatest(0, round((
      (
        calculated.confirmed_money_usd
        - calculated.fund_stored_usd
        + calculated.client_fund_used_usd
      )
      - calculated.total_usd
    )::numeric, 2)) as overpaid_usd,
    greatest(0, round((
      calculated.confirmed_report_paid_bs_snapshot
      + greatest(
        0,
        calculated.confirmed_money_usd
          - calculated.confirmed_report_paid_usd
      ) * calculated.snapshot_rate_bs_per_usd
      + calculated.client_fund_used_usd
        * calculated.snapshot_rate_bs_per_usd
      - calculated.fund_stored_usd
        * calculated.snapshot_rate_bs_per_usd
    )::numeric, 2)) as confirmed_paid_bs_snapshot
  from calculated
)
select
  balances.order_id,
  balances.order_number::text,
  balances.order_status::text,
  balances.total_usd,
  balances.total_bs,
  balances.snapshot_rate_bs_per_usd,
  balances.applied_paid_usd as confirmed_paid_usd,
  balances.confirmed_paid_bs_snapshot,
  balances.pending_reports_usd,
  balances.pending_reports_bs_snapshot,
  balances.rejected_reports_usd,
  balances.voided_movements_count,
  balances.rejected_reports_count,
  balances.pending_reports_count,
  balances.confirmed_reports_count,
  balances.client_fund_used_usd,
  balances.pending_usd,
  case
    when balances.pending_usd <= 0.005 then 0
    when balances.delivery_reference_date is not null
      and balances.effective_operation_date > balances.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then round(balances.pending_usd * p_active_bs_rate, 2)
    when balances.total_bs > 0
      then greatest(
        0,
        round(balances.total_bs - balances.confirmed_paid_bs_snapshot, 2)
      )
    when coalesce(p_active_bs_rate, 0) > 0
      then round(balances.pending_usd * p_active_bs_rate, 2)
    else 0
  end as pending_bs,
  balances.overpaid_usd,
  case
    when balances.pending_usd <= 0.005 then 'closed'
    when balances.delivery_reference_date is not null
      and balances.effective_operation_date > balances.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then 'post_delivery_usd'
    else 'snapshot_quote'
  end as collection_mode,
  case
    when balances.order_status = 'cancelled' then 'cancelled'
    when balances.overpaid_usd > 0.005 then 'overpaid'
    when balances.pending_reports_count > 0 then 'pending_review'
    when balances.pending_usd <= 0.005 then 'paid'
    when balances.applied_paid_usd > 0.005 then 'partial'
    else 'unpaid'
  end as payment_status,
  balances.delivery_reference_date,
  balances.effective_operation_date
from balances;
$function$;

CREATE OR REPLACE FUNCTION public.get_order_financial_state(p_order_id bigint, p_operation_date date DEFAULT NULL::date, p_active_bs_rate numeric DEFAULT NULL::numeric)
 RETURNS TABLE(order_id bigint, order_number text, order_status text, total_usd numeric, total_bs numeric, snapshot_rate_bs_per_usd numeric, confirmed_paid_usd numeric, confirmed_paid_bs_snapshot numeric, pending_reports_usd numeric, pending_reports_bs_snapshot numeric, rejected_reports_usd numeric, voided_movements_count integer, rejected_reports_count integer, pending_reports_count integer, confirmed_reports_count integer, client_fund_used_usd numeric, pending_usd numeric, pending_bs numeric, overpaid_usd numeric, collection_mode text, payment_status text, delivery_reference_date date, effective_operation_date date)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with confirmed_report_input as (
  -- Preserve reported evidence; only new certified confirmations substitute the
  -- actual movement for snapshot coverage. Historical reports are not revalued.
  select r.order_id,r.status,r.operation_date,r.created_at,
    coalesce(m.currency_code,r.reported_currency_code) as reported_currency_code,
    coalesce(m.amount,r.reported_amount) as reported_amount,
    coalesce(m.amount_usd_equivalent,r.reported_amount_usd_equivalent) as reported_amount_usd_equivalent
  from public.payment_reports r
  left join public.payment_confirmation_operations op on op.report_id=r.id
  left join public.money_movements m on m.id=op.movement_id
    and r.status='confirmed' and m.status='confirmed'
),
base as (
  select *
  from public.get_order_financial_state_block3(
    p_order_id,
    p_operation_date,
    p_active_bs_rate
  )
),
snapshot_payment_coverage as (
  select
    base.order_id,
    round(coalesce((
      select sum(
        case
          when report.reported_currency_code = 'VES'
            then coalesce(report.reported_amount, 0)
          else coalesce(report.reported_amount_usd_equivalent, 0)
            * coalesce(base.snapshot_rate_bs_per_usd, 0)
        end
      )
      from confirmed_report_input report
      where report.order_id = base.order_id
        and report.status = 'confirmed'
        and (
          base.delivery_reference_date is null
          or coalesce(
            report.operation_date,
            (report.created_at at time zone 'America/Caracas')::date
          ) <= base.delivery_reference_date
        )
    ), 0), 2) as eligible_confirmed_bs
  from base
),
adjustments as (
  select
    round(coalesce(sum(movement.amount_usd_equivalent) filter (
      where movement.status = 'confirmed'
        and movement.direction = 'outflow'
        and movement.movement_type = 'withdrawal'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          where receipt.command_type = 'request_refund'
            and receipt.order_id = movement.order_id
            and receipt.idempotency_key = movement.movement_group_id
        )
    ), 0), 2) as refund_usd,
    round(coalesce(sum(
      case
        when movement.currency_code = 'VES' then movement.amount
        else movement.amount_usd_equivalent
          * coalesce(base.snapshot_rate_bs_per_usd, 0)
      end
    ) filter (
      where movement.status = 'confirmed'
        and movement.direction = 'outflow'
        and movement.movement_type = 'withdrawal'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          where receipt.command_type = 'request_refund'
            and receipt.order_id = movement.order_id
            and receipt.idempotency_key = movement.movement_group_id
        )
    ), 0), 2) as refund_bs_snapshot,
    round(coalesce((
      select sum(fund.amount_usd)
      from public.client_fund_movements fund
      where fund.order_id = p_order_id
        and fund.movement_type = 'debit'
        and fund.reason_code = 'counter_change_fund_reversal'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          where receipt.order_id = fund.order_id
            and receipt.command_type = 'apply_order_payments'
            and receipt.status = 'completed'
            and receipt.created_at = fund.created_at
            and exists (
              select 1
              from public.money_movements payment
              where payment.order_id = fund.order_id
                and payment.movement_group_id = receipt.idempotency_key
                and payment.status = 'confirmed'
                and payment.direction = 'inflow'
                and payment.movement_type = 'order_payment'
            )
            and exists (
              select 1
              from public.money_movements change_movement
              where change_movement.order_id = fund.order_id
                and change_movement.movement_group_id = receipt.idempotency_key
                and change_movement.status = 'confirmed'
                and change_movement.direction = 'outflow'
                and change_movement.movement_type = 'change_given'
            )
        )
    ), 0), 2) as legacy_change_usd,
    round(coalesce((
      select sum(fund.amount_usd)
      from public.client_fund_movements fund
      where fund.order_id = p_order_id
        and fund.movement_type = 'debit'
        and fund.reason_code = 'counter_change_given'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          join public.money_movements change_movement
            on change_movement.order_id = receipt.order_id
           and change_movement.movement_group_id = receipt.idempotency_key
           and change_movement.status = 'confirmed'
           and change_movement.direction = 'outflow'
           and change_movement.movement_type = 'change_given'
          where receipt.command_type = 'give_order_change'
            and receipt.status = 'completed'
            and receipt.order_id = fund.order_id
            and receipt.idempotency_key = fund.movement_group_id
        )
    ), 0), 2) as independent_change_usd
  from base
  left join public.money_movements movement
    on movement.order_id = base.order_id
  group by base.snapshot_rate_bs_per_usd
),
adjusted as (
  select
    base.*,
    coverage.eligible_confirmed_bs,
    greatest(0, round(
      base.confirmed_paid_usd
      + adjustments.legacy_change_usd
      + adjustments.independent_change_usd
      - adjustments.refund_usd,
      2
    )) as adjusted_paid_usd,
    greatest(0, round(
      base.confirmed_paid_bs_snapshot
      + (
        adjustments.legacy_change_usd
        + adjustments.independent_change_usd
      ) * base.snapshot_rate_bs_per_usd
      - adjustments.refund_bs_snapshot,
      2
    )) as adjusted_paid_bs
  from base
  cross join snapshot_payment_coverage coverage
  cross join adjustments
),
raw_balances as (
  select
    adjusted.*,
    greatest(
      0,
      round(adjusted.total_usd - adjusted.adjusted_paid_usd, 2)
    ) as raw_pending_usd,
    greatest(
      0,
      round(adjusted.adjusted_paid_usd - adjusted.total_usd, 2)
    ) as raw_overpaid_usd
  from adjusted
),
balances as (
  select
    raw.*,
    (
      raw.total_bs > 0
      and raw.adjusted_paid_usd < raw.total_usd
      and raw.adjusted_paid_bs + 0.01 >= raw.total_bs
      and raw.eligible_confirmed_bs + 0.01 >= raw.total_bs
    ) as closes_by_exact_snapshot_bs
  from raw_balances raw
),
canonical as (
  select
    balances.*,
    case
      when balances.closes_by_exact_snapshot_bs then balances.total_usd
      else balances.adjusted_paid_usd
    end as canonical_paid_usd,
    case
      when balances.closes_by_exact_snapshot_bs then 0
      else balances.raw_pending_usd
    end as canonical_pending_usd
  from balances
)
select
  canonical.order_id,
  canonical.order_number,
  canonical.order_status,
  canonical.total_usd,
  canonical.total_bs,
  canonical.snapshot_rate_bs_per_usd,
  canonical.canonical_paid_usd,
  canonical.adjusted_paid_bs,
  canonical.pending_reports_usd,
  canonical.pending_reports_bs_snapshot,
  canonical.rejected_reports_usd,
  canonical.voided_movements_count,
  canonical.rejected_reports_count,
  canonical.pending_reports_count,
  canonical.confirmed_reports_count,
  canonical.client_fund_used_usd,
  canonical.canonical_pending_usd,
  case
    when canonical.canonical_pending_usd <= 0.005 then 0
    when canonical.delivery_reference_date is not null
      and canonical.effective_operation_date > canonical.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then round(canonical.canonical_pending_usd * p_active_bs_rate, 2)
    when canonical.total_bs > 0
      then greatest(
        0,
        round(canonical.total_bs - canonical.adjusted_paid_bs, 2)
      )
    when coalesce(p_active_bs_rate, 0) > 0
      then round(canonical.canonical_pending_usd * p_active_bs_rate, 2)
    else 0
  end,
  canonical.raw_overpaid_usd,
  case
    when canonical.canonical_pending_usd <= 0.005 then 'closed'
    when canonical.delivery_reference_date is not null
      and canonical.effective_operation_date > canonical.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then 'post_delivery_usd'
    else 'snapshot_quote'
  end,
  case
    when canonical.order_status = 'cancelled' then 'cancelled'
    when canonical.raw_overpaid_usd > 0.005 then 'overpaid'
    when canonical.pending_reports_count > 0 then 'pending_review'
    when canonical.canonical_pending_usd <= 0.005 then 'paid'
    when canonical.canonical_paid_usd > 0.005 then 'partial'
    else 'unpaid'
  end,
  canonical.delivery_reference_date,
  canonical.effective_operation_date
from canonical;
$function$;

commit;
