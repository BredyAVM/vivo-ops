-- Estado financiero canonico por orden - VIVO Ops
-- Fecha: 2026-06-04
--
-- Objetivo:
-- - Una sola fuente de lectura para saldos de orden.
-- - Respetar snapshot Bs antes/durante el dia de entrega.
-- - Usar tasa activa solo cuando la cobranza ya esta dolarizada.
-- - Contar solo dinero real confirmado desde money_movements.
--
-- Uso:
--   select * from public.get_order_financial_state(28);
--   select * from public.get_order_financial_state(28, '2026-06-02', 540.00);

create or replace function public.get_order_financial_state(
  p_order_id bigint,
  p_operation_date date default null,
  p_active_bs_rate numeric default null
)
returns table (
  order_id bigint,
  order_number text,
  order_status text,
  total_usd numeric,
  total_bs numeric,
  snapshot_rate_bs_per_usd numeric,
  confirmed_paid_usd numeric,
  confirmed_paid_bs_snapshot numeric,
  pending_reports_usd numeric,
  pending_reports_bs_snapshot numeric,
  rejected_reports_usd numeric,
  voided_movements_count integer,
  rejected_reports_count integer,
  pending_reports_count integer,
  confirmed_reports_count integer,
  client_fund_used_usd numeric,
  pending_usd numeric,
  pending_bs numeric,
  overpaid_usd numeric,
  collection_mode text,
  payment_status text,
  delivery_reference_date date,
  effective_operation_date date
)
language sql
stable
as $$
with base_order as (
  select
    o.id,
    o.order_number,
    o.status,
    o.total_usd,
    o.total_bs_snapshot,
    o.extra_fields,
    round(coalesce(
      nullif(o.extra_fields->'pricing'->>'total_usd', '')::numeric,
      o.total_usd,
      0
    ), 2) as effective_total_usd,
    round(coalesce(
      nullif(o.extra_fields->'pricing'->>'total_bs', '')::numeric,
      o.total_bs_snapshot,
      0
    ), 2) as effective_total_bs,
    round(coalesce(
      nullif(o.extra_fields->'payment'->>'client_fund_used_usd', '')::numeric,
      0
    ), 2) as stored_client_fund_used_usd,
    case
      when o.extra_fields->'delivery'->>'completed_at' is not null
        and trim(o.extra_fields->'delivery'->>'completed_at') <> ''
        then ((o.extra_fields->'delivery'->>'completed_at')::timestamptz at time zone 'America/Caracas')::date
      when o.extra_fields->'schedule'->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
        then (o.extra_fields->'schedule'->>'date')::date
      else null
    end as delivery_reference_date
  from public.orders o
  where o.id = p_order_id
),
effective_dates as (
  select
    bo.*,
    coalesce(p_operation_date, (now() at time zone 'America/Caracas')::date) as effective_operation_date
  from base_order bo
),
movement_totals as (
  select
    mm.order_id,
    round(sum(
      case
        when mm.status = 'confirmed' and mm.direction = 'inflow' then coalesce(mm.amount_usd_equivalent, 0)
        when mm.status = 'confirmed'
          and mm.direction = 'outflow'
          and mm.movement_type = 'change_given'
          then -coalesce(mm.amount_usd_equivalent, 0)
        else 0
      end
    )::numeric, 2) as confirmed_paid_usd,
    count(*) filter (where mm.status = 'voided')::integer as voided_movements_count
  from public.money_movements mm
  where mm.order_id = p_order_id
  group by mm.order_id
),
report_totals as (
  select
    pr.order_id,
    round(coalesce(sum(coalesce(pr.reported_amount_usd_equivalent, 0)) filter (where pr.status = 'pending'), 0)::numeric, 2) as pending_reports_usd,
    round(coalesce(sum(coalesce(pr.reported_amount_usd_equivalent, 0)) filter (where pr.status = 'rejected'), 0)::numeric, 2) as rejected_reports_usd,
    count(*) filter (where pr.status = 'pending')::integer as pending_reports_count,
    count(*) filter (where pr.status = 'confirmed')::integer as confirmed_reports_count,
    count(*) filter (where pr.status = 'rejected')::integer as rejected_reports_count
  from public.payment_reports pr
  where pr.order_id = p_order_id
  group by pr.order_id
),
confirmed_report_bs as (
  select
    pr.order_id,
    round(sum(
      case
        when pr.status <> 'confirmed' then 0
        when upper(coalesce(pr.reported_currency_code::text, '')) = 'VES' then coalesce(pr.reported_amount, 0)
        when ed.effective_total_usd > 0 and ed.effective_total_bs > 0
          then coalesce(pr.reported_amount_usd_equivalent, 0) * (ed.effective_total_bs / ed.effective_total_usd)
        else 0
      end
    )::numeric, 2) as confirmed_report_paid_bs_snapshot,
    round(sum(
      case
        when pr.status <> 'confirmed' then 0
        else coalesce(pr.reported_amount_usd_equivalent, 0)
      end
    )::numeric, 2) as confirmed_report_paid_usd
  from public.payment_reports pr
  join effective_dates ed on ed.id = pr.order_id
  where pr.order_id = p_order_id
  group by pr.order_id
),
pending_report_bs as (
  select
    pr.order_id,
    round(sum(
      case
        when pr.status <> 'pending' then 0
        when upper(coalesce(pr.reported_currency_code::text, '')) = 'VES' then coalesce(pr.reported_amount, 0)
        when ed.effective_total_usd > 0 and ed.effective_total_bs > 0
          then coalesce(pr.reported_amount_usd_equivalent, 0) * (ed.effective_total_bs / ed.effective_total_usd)
        else 0
      end
    )::numeric, 2) as pending_reports_bs_snapshot
  from public.payment_reports pr
  join effective_dates ed on ed.id = pr.order_id
  where pr.order_id = p_order_id
  group by pr.order_id
),
fund_ledger_for_order as (
  select
    cfm.order_id,
    round(sum(
      case
        when cfm.movement_type = 'debit'
          and coalesce(cfm.reason_code, '') = 'order_fund_applied'
          then coalesce(cfm.amount_usd, 0)
        when cfm.movement_type = 'credit'
          and coalesce(cfm.reason_code, '') = 'order_fund_restore'
          then -coalesce(cfm.amount_usd, 0)
        else 0
      end
    )::numeric, 2) as fund_used_usd_from_ledger,
    round(sum(
      case
        when cfm.movement_type = 'credit'
          and coalesce(cfm.reason_code, '') in ('payment_overage_stored', 'retention_overage_stored')
          then coalesce(cfm.amount_usd, 0)
        when cfm.movement_type = 'debit'
          and coalesce(cfm.reason_code, '') = 'payment_void_fund_reversal'
          then -coalesce(cfm.amount_usd, 0)
        else 0
      end
    )::numeric, 2) as fund_stored_usd_from_ledger
  from public.client_fund_movements cfm
  where cfm.order_id = p_order_id
  group by cfm.order_id
),
calculated as (
  select
    ed.id as order_id,
    ed.order_number,
    ed.status as order_status,
    ed.effective_total_usd as total_usd,
    ed.effective_total_bs as total_bs,
    case
      when ed.effective_total_usd > 0 and ed.effective_total_bs > 0
        then round(ed.effective_total_bs / ed.effective_total_usd, 6)
      else 0
    end as snapshot_rate_bs_per_usd,
    coalesce(mt.confirmed_paid_usd, 0) as confirmed_money_usd,
    coalesce(crb.confirmed_report_paid_usd, 0) as confirmed_report_paid_usd,
    coalesce(crb.confirmed_report_paid_bs_snapshot, 0) as confirmed_report_paid_bs_snapshot,
    coalesce(fl.fund_used_usd_from_ledger, ed.stored_client_fund_used_usd, 0) as client_fund_used_usd,
    coalesce(fl.fund_stored_usd_from_ledger, 0) as fund_stored_usd,
    coalesce(rt.pending_reports_usd, 0) as pending_reports_usd,
    coalesce(prb.pending_reports_bs_snapshot, 0) as pending_reports_bs_snapshot,
    coalesce(rt.rejected_reports_usd, 0) as rejected_reports_usd,
    coalesce(mt.voided_movements_count, 0) as voided_movements_count,
    coalesce(rt.rejected_reports_count, 0) as rejected_reports_count,
    coalesce(rt.pending_reports_count, 0) as pending_reports_count,
    coalesce(rt.confirmed_reports_count, 0) as confirmed_reports_count,
    ed.delivery_reference_date,
    ed.effective_operation_date
  from effective_dates ed
  left join movement_totals mt on mt.order_id = ed.id
  left join report_totals rt on rt.order_id = ed.id
  left join confirmed_report_bs crb on crb.order_id = ed.id
  left join pending_report_bs prb on prb.order_id = ed.id
  left join fund_ledger_for_order fl on fl.order_id = ed.id
),
balances as (
  select
    c.*,
    greatest(0, round((c.confirmed_money_usd - c.fund_stored_usd + c.client_fund_used_usd)::numeric, 2)) as applied_paid_usd,
    greatest(0, round((c.total_usd - (c.confirmed_money_usd - c.fund_stored_usd + c.client_fund_used_usd))::numeric, 2)) as pending_usd,
    greatest(0, round(((c.confirmed_money_usd - c.fund_stored_usd + c.client_fund_used_usd) - c.total_usd)::numeric, 2)) as overpaid_usd,
    greatest(0, round((
      c.confirmed_report_paid_bs_snapshot
      + greatest(0, c.confirmed_money_usd - c.confirmed_report_paid_usd) * c.snapshot_rate_bs_per_usd
      + c.client_fund_used_usd * c.snapshot_rate_bs_per_usd
      - c.fund_stored_usd * c.snapshot_rate_bs_per_usd
    )::numeric, 2)) as confirmed_paid_bs_snapshot
  from calculated c
)
select
  b.order_id,
  b.order_number::text,
  b.order_status::text,
  b.total_usd,
  b.total_bs,
  b.snapshot_rate_bs_per_usd,
  b.applied_paid_usd as confirmed_paid_usd,
  b.confirmed_paid_bs_snapshot,
  b.pending_reports_usd,
  b.pending_reports_bs_snapshot,
  b.rejected_reports_usd,
  b.voided_movements_count,
  b.rejected_reports_count,
  b.pending_reports_count,
  b.confirmed_reports_count,
  b.client_fund_used_usd,
  b.pending_usd,
  case
    when b.pending_usd <= 0.005 then 0
    when b.delivery_reference_date is not null
      and b.effective_operation_date > b.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then round((b.pending_usd * p_active_bs_rate)::numeric, 2)
    when b.total_bs > 0
      then greatest(0, round((b.total_bs - b.confirmed_paid_bs_snapshot)::numeric, 2))
    when coalesce(p_active_bs_rate, 0) > 0
      then round((b.pending_usd * p_active_bs_rate)::numeric, 2)
    else 0
  end as pending_bs,
  b.overpaid_usd,
  case
    when b.pending_usd <= 0.005 then 'closed'
    when b.delivery_reference_date is not null
      and b.effective_operation_date > b.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then 'post_delivery_usd'
    else 'snapshot_quote'
  end as collection_mode,
  case
    when b.order_status = 'cancelled' then 'cancelled'
    when b.overpaid_usd > 0.005 then 'overpaid'
    when b.pending_reports_count > 0 then 'pending_review'
    when b.pending_usd <= 0.005 then 'paid'
    when b.applied_paid_usd > 0.005 then 'partial'
    else 'unpaid'
  end as payment_status,
  b.delivery_reference_date,
  b.effective_operation_date
from balances b;
$$;

comment on function public.get_order_financial_state(bigint, date, numeric)
is 'Devuelve el estado financiero canonico de una orden. Respeta snapshot Bs antes/durante entrega y usa tasa activa solo para cobranza dolarizada posterior.';

create or replace function public.get_orders_financial_state(
  p_order_ids bigint[],
  p_operation_date date default null,
  p_active_bs_rate numeric default null
)
returns table (
  order_id bigint,
  order_number text,
  order_status text,
  total_usd numeric,
  total_bs numeric,
  snapshot_rate_bs_per_usd numeric,
  confirmed_paid_usd numeric,
  confirmed_paid_bs_snapshot numeric,
  pending_reports_usd numeric,
  pending_reports_bs_snapshot numeric,
  rejected_reports_usd numeric,
  voided_movements_count integer,
  rejected_reports_count integer,
  pending_reports_count integer,
  confirmed_reports_count integer,
  client_fund_used_usd numeric,
  pending_usd numeric,
  pending_bs numeric,
  overpaid_usd numeric,
  collection_mode text,
  payment_status text,
  delivery_reference_date date,
  effective_operation_date date
)
language sql
stable
as $$
  select fs.*
  from unnest(coalesce(p_order_ids, array[]::bigint[])) as ids(order_id)
  cross join lateral public.get_order_financial_state(ids.order_id, p_operation_date, p_active_bs_rate) fs;
$$;

comment on function public.get_orders_financial_state(bigint[], date, numeric)
is 'Devuelve el estado financiero canonico para varias ordenes en una sola llamada.';
