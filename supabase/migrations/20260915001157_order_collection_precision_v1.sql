-- Precise debt coverage is separate from the native cash/bank movement.
-- Existing orders with financial history are not enrolled retrospectively.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Do not overwrite a concurrent financial implementation from another release.
do $$ begin
  if (select md5(replace(prosrc,chr(13),'')) from pg_proc
      where oid='public.get_order_financial_state(bigint,date,numeric)'::regprocedure)
      <> 'b181407fb3302c0e36e5408053e9f643' then
    raise exception 'Canonical financial function changed; review before applying precision migration';
  end if;
end $$;

create table public.order_collection_precision_enrollments (
  order_id bigint primary key references public.orders(id),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  rule_version text not null default 'precise_collection_v1'
);
create table public.order_payment_precision_allocations (
  movement_id bigint primary key references public.money_movements(id) deferrable initially deferred,
  order_id bigint not null references public.order_collection_precision_enrollments(order_id),
  applied_usd numeric not null check (applied_usd >= 0),
  cash_equivalent_usd numeric not null check (cash_equivalent_usd >= 0),
  rounding_usd numeric not null,
  pending_before_usd numeric not null check (pending_before_usd >= 0),
  pending_before_bs numeric not null check (pending_before_bs >= 0),
  native_amount numeric not null check (native_amount > 0),
  currency_code public.currency_code not null,
  coverage_rate numeric not null check (coverage_rate > 0),
  operation_date date not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);
create index order_payment_precision_allocations_order_idx
  on public.order_payment_precision_allocations(order_id);
create index order_collection_precision_enrollments_actor_idx
  on public.order_collection_precision_enrollments(created_by);
create index order_payment_precision_allocations_actor_idx
  on public.order_payment_precision_allocations(created_by);
alter table public.order_collection_precision_enrollments enable row level security;
alter table public.order_payment_precision_allocations enable row level security;
revoke all on public.order_collection_precision_enrollments,
  public.order_payment_precision_allocations from public, anon, authenticated;
grant select on public.order_collection_precision_enrollments,
  public.order_payment_precision_allocations to authenticated,service_role;
create policy order_collection_precision_read on public.order_collection_precision_enrollments
  for select to authenticated using (exists (select 1 from public.orders o
    where o.id=order_collection_precision_enrollments.order_id
      and ((select public.is_master_or_admin()) or (select public.has_role('counter'))
        or ((select public.has_role('advisor')) and o.attributed_advisor_id=(select auth.uid())))));
create policy order_payment_precision_read on public.order_payment_precision_allocations
  for select to authenticated using (exists (select 1 from public.orders o
    where o.id=order_payment_precision_allocations.order_id
      and ((select public.is_master_or_admin()) or (select public.has_role('counter'))
        or ((select public.has_role('advisor')) and o.attributed_advisor_id=(select auth.uid())))));

-- Pure arithmetic: no cash mutation, no order access, no arbitrary epsilon.
create function app_private.collection_payment_allocation_v1(
  p_pending_usd numeric, p_pending_bs numeric, p_currency text,
  p_amount numeric, p_coverage_rate numeric, p_cash_rate numeric default null
) returns table(applied_usd numeric, rounding_usd numeric)
language plpgsql immutable security invoker set search_path = '' as $$
declare v_quote numeric; v_converted numeric; v_applied numeric; v_remaining numeric;
  v_cash_rate numeric:=coalesce(p_cash_rate,p_coverage_rate);
begin
  if p_pending_usd is null or p_pending_usd < 0 or p_pending_bs is null or p_pending_bs < 0
    or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount,2)
    or p_coverage_rate is null or p_coverage_rate <= 0
    or v_cash_rate <= 0 or v_cash_rate::text in ('NaN','Infinity','-Infinity')
    or p_currency is null or p_currency not in ('USD','VES')
    or p_pending_usd::text in ('NaN','Infinity','-Infinity')
    or p_pending_bs::text in ('NaN','Infinity','-Infinity')
    or p_amount::text in ('NaN','Infinity','-Infinity')
    or p_coverage_rate::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Invalid precise payment allocation' using errcode='22023';
  end if;
  v_quote := case when p_currency='USD' then round(p_pending_usd,2) else p_pending_bs end;
  v_converted := case when p_currency='USD' then p_amount else p_amount/p_coverage_rate end;
  if v_quote > 0 and p_amount >= v_quote then
    -- Paying the complete native quote covers the debt exactly. Only native
    -- tender above that quote is an overpayment; conversion noise is not cash.
    v_applied := p_pending_usd + case when p_currency='USD' then p_amount-v_quote
      else (p_amount-v_quote)/v_cash_rate end;
    v_converted := case when p_currency='USD' then p_amount
      else v_quote/p_coverage_rate+(p_amount-v_quote)/v_cash_rate end;
  else
    v_applied := v_converted;
    v_remaining := p_pending_usd-v_applied;
    if v_remaining > 0 and v_remaining < 0.01 then
      v_applied := p_pending_usd;
    end if;
  end if;
  return query select v_applied, v_applied-v_converted;
end $$;
revoke all on function app_private.collection_payment_allocation_v1(numeric,numeric,text,numeric,numeric,numeric)
  from public, anon, authenticated;

-- Uses only immutable order snapshots, never today's catalog or a rate inferred
-- from rounded totals. NULL means legacy/incomplete evidence: retain old rules.
create function public.order_collection_precision_basis_v1(p_order_id bigint)
returns table(total_precise_usd numeric, paid_delta_usd numeric)
language sql stable security invoker set search_path = '' as $$
with o as (
  select o.*, o.extra_fields->'pricing' as pricing,
    nullif(o.extra_fields#>>'{pricing,fx_rate}','')::numeric as fx,
    exists(select 1 from public.order_collection_precision_enrollments e where e.order_id=o.id) as enrolled
  from public.orders o where o.id=p_order_id
    and (current_user in ('postgres','service_role') or public.is_master_or_admin() or public.has_role('counter')
      or (public.has_role('advisor') and o.attributed_advisor_id=auth.uid()))
), lines as (
  select count(*) as n,
    bool_and(i.pricing_origin_currency in ('USD','VES') and i.line_total_bs_snapshot is not null
      and i.line_total_usd is not null and i.line_total_usd >= 0 and i.line_total_bs_snapshot >= 0) as valid,
    bool_and(i.pricing_origin_currency='VES' and i.override_unit_price_usd is null
      and i.admin_price_override_usd is null) filter(where i.line_total_usd>0 or i.line_total_bs_snapshot>0) as all_ves,
    sum(i.line_total_usd) as usd, sum(i.line_total_bs_snapshot) as bs,
    sum(case when i.pricing_origin_currency='VES' and i.override_unit_price_usd is null
      and i.admin_price_override_usd is null then i.line_total_bs_snapshot/nullif(o.fx,0)
      else i.line_total_usd end) as precise
  from o join public.order_items i on i.order_id=o.id
), amounts as (
  select o.*, lines.*,
    coalesce(nullif(pricing->>'total_usd','')::numeric,o.total_usd) as header_usd,
    coalesce(nullif(pricing->>'total_bs','')::numeric,o.total_bs_snapshot) as header_bs,
    coalesce(nullif(pricing->>'discount_amount_usd','')::numeric,0) as discount_usd,
    coalesce(nullif(pricing->>'discount_amount_bs','')::numeric,0) as discount_bs,
    coalesce(nullif(pricing->>'invoice_tax_amount_usd','')::numeric,0) as tax_usd,
    coalesce(nullif(pricing->>'invoice_tax_amount_bs','')::numeric,0) as tax_bs
  from o cross join lines
)
select greatest(0,case when header_usd=0 and header_bs=0 then 0
  when all_ves then header_bs/fx else precise-discount_usd+tax_usd end),
  coalesce((select sum(a.applied_usd-a.cash_equivalent_usd)
    from public.order_payment_precision_allocations a join public.money_movements m on m.id=a.movement_id
    where a.order_id=p_order_id and m.status='confirmed'),0)
from amounts a
where fx>0 and fx::text not in ('NaN','Infinity','-Infinity') and n>0 and valid
  and round(usd-discount_usd+tax_usd,2)=header_usd
  and round(bs-discount_bs+tax_bs,2)=header_bs
  and (enrolled or (
    not exists(select 1 from public.money_movements m where m.order_id=p_order_id)
    and not exists(select 1 from public.client_fund_movements f where f.order_id=p_order_id)
    and coalesce(nullif(extra_fields#>>'{payment,client_fund_used_usd}','')::numeric,0)=0
  ));
$$;
revoke all on function public.order_collection_precision_basis_v1(bigint) from public,anon;
grant execute on function public.order_collection_precision_basis_v1(bigint) to authenticated,service_role;

-- The common canonical state and payment hook are added below after the pure
-- calculator; all application entry points keep their existing signatures.

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
precise_adjusted as (
  select adjusted.*, precision.total_precise_usd,
    adjusted.adjusted_paid_usd + coalesce(precision.paid_delta_usd,0) as precise_paid_usd
  from adjusted
  left join lateral public.order_collection_precision_basis_v1(p_order_id) precision on true
),
raw_balances as (
  select
    adjusted.*,
    greatest(
      0,
      case when adjusted.total_precise_usd is not null
        then adjusted.total_precise_usd-adjusted.precise_paid_usd
        else round(adjusted.total_usd-adjusted.adjusted_paid_usd,2) end
    ) as raw_pending_usd,
    greatest(
      0,
      round(case when adjusted.total_precise_usd is not null
        then adjusted.precise_paid_usd-adjusted.total_precise_usd
        else adjusted.adjusted_paid_usd-adjusted.total_usd end,2)
    ) as raw_overpaid_usd
  from precise_adjusted adjusted
),
balances as (
  select
    raw.*,
    (
      raw.total_precise_usd is null
      and raw.total_bs > 0
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
      when balances.total_precise_usd is not null then
        case when balances.raw_pending_usd=0 and balances.raw_overpaid_usd=0 then balances.total_usd
          else round(balances.precise_paid_usd,2) end
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
    when canonical.total_precise_usd is not null
      and p_active_bs_rate=canonical.snapshot_rate_bs_per_usd
      then greatest(0,round(canonical.total_bs-canonical.precise_paid_usd*canonical.snapshot_rate_bs_per_usd,2))
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

create function app_private.capture_order_payment_precision_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_state record; v_basis record; v_allocation record; v_rate numeric; v_uid uuid:=auth.uid();
begin
  if new.status<>'confirmed' or new.direction<>'inflow' or new.movement_type<>'order_payment'
    or new.order_id is null then return new; end if;
  if tg_op='UPDATE' then
    if old.status='confirmed' then return new; end if;
    -- Historical confirmations retain their original accounting treatment.
    -- A voided precision payment cannot be silently resurrected or re-priced.
    if exists(select 1 from public.order_payment_precision_allocations a where a.movement_id=new.id) then
      raise exception 'Registra un nuevo pago; no se puede reactivar un pago anulado.' using errcode='22023';
    end if;
  end if;
  if v_uid is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  perform 1 from public.orders o where o.id=new.order_id for update;
  select * into v_basis from public.order_collection_precision_basis_v1(new.order_id);
  if not found then return new; end if;
  select * into v_state from public.get_order_financial_state(new.order_id,new.movement_date,new.exchange_rate_ves_per_usd);
  if not found then raise exception 'Order financial state unavailable'; end if;
  v_rate:=case when new.currency_code='USD' then 1
    when v_state.delivery_reference_date is null or new.movement_date<=v_state.delivery_reference_date
      then v_state.snapshot_rate_bs_per_usd else new.exchange_rate_ves_per_usd end;
  select * into v_allocation from app_private.collection_payment_allocation_v1(
    v_state.pending_usd,v_state.pending_bs,new.currency_code::text,new.amount,v_rate,
    case when new.currency_code='USD' then 1 else new.exchange_rate_ves_per_usd end);
  insert into public.order_collection_precision_enrollments(order_id,created_by)
    values(new.order_id,v_uid) on conflict(order_id) do nothing;
  insert into public.order_payment_precision_allocations(
    movement_id,order_id,applied_usd,cash_equivalent_usd,rounding_usd,
    pending_before_usd,pending_before_bs,native_amount,currency_code,coverage_rate,operation_date,created_by
  ) values(new.id,new.order_id,v_allocation.applied_usd,new.amount_usd_equivalent,v_allocation.rounding_usd,
    v_state.pending_usd,v_state.pending_bs,new.amount,new.currency_code,v_rate,new.movement_date,v_uid);
  return new;
end $$;
revoke all on function app_private.capture_order_payment_precision_v1() from public,anon,authenticated;
create trigger capture_order_payment_precision before insert or update of status on public.money_movements
  for each row execute function app_private.capture_order_payment_precision_v1();

create function app_private.guard_order_payment_precision_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.order_payment_precision_allocations a where a.movement_id=old.id) then
    if auth.uid() is null then raise exception 'Not authenticated' using errcode='42501'; end if;
    if tg_op='DELETE' then
      raise exception 'Anula el pago; no se puede borrar su historial.' using errcode='22023';
    end if;
    if (new.order_id,new.currency_code,new.amount,new.amount_usd_equivalent,
        new.exchange_rate_ves_per_usd,new.movement_date,new.payment_report_id,new.direction,new.movement_type)
      is distinct from (old.order_id,old.currency_code,old.amount,old.amount_usd_equivalent,
        old.exchange_rate_ves_per_usd,old.movement_date,old.payment_report_id,old.direction,old.movement_type) then
      raise exception 'Anula y registra el pago correcto; su conversión confirmada es inmutable.' using errcode='22023';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function app_private.guard_order_payment_precision_v1() from public,anon,authenticated;
create trigger guard_order_payment_precision before update or delete on public.money_movements
  for each row execute function app_private.guard_order_payment_precision_v1();

-- Preserve the financial lock hierarchy (order before report) in the direct
-- confirmation primitive too. Counter/Master atomic commands already do this.
do $patch$
declare v_definition text; v_anchor text := E'  select\n    report.order_id,\n    report.status,';
begin
  v_definition:=pg_get_functiondef('public.confirm_payment_report(bigint,bigint,public.currency_code,numeric,date,numeric,text,text,text,text)'::regprocedure);
  if position(v_anchor in v_definition)=0 then raise exception 'Payment confirmation lock anchor changed'; end if;
  v_definition:=replace(v_definition,v_anchor,
    E'  perform o.id from public.orders o join public.payment_reports r on r.order_id=o.id\n  where r.id=p_report_id for update of o;\n\n' || v_anchor);
  execute v_definition;
end $patch$;

commit;
