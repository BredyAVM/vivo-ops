-- Preserve the commercial VES snapshot when Counter quotes or applies a
-- payment. The ratio total_bs / total_usd is not an exchange rate because the
-- USD total already contains per-line rounding, especially for VES-origin
-- products. Partial payments must use the fx_rate captured with the order.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_order_financial_state_block3(
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
set search_path = ''
as $function$
with base_order_raw as (
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
  from public.payment_reports report
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
  from public.payment_reports report
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
  from public.payment_reports report
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

comment on function public.get_order_financial_state_block3(bigint, date, numeric)
is 'Base financiera: conserva total VES y fx_rate del snapshot; nunca infiere la tasa dividiendo totales redondeados salvo compatibilidad con ordenes legacy sin fx_rate.';

comment on function public.get_order_financial_state(bigint, date, numeric)
is 'Estado financiero canonico por orden. Counter y otros modulos consumen el snapshot VES exacto antes/durante entrega y solo usan tasa activa despues.';

comment on function public.counter_read_payment_quote(bigint, date)
is 'Cotizacion canonica de Counter: Punto/efectivo VES reciben pendingBs exacto; no reconstruye precios nacidos en VES desde equivalentes USD redondeados.';

revoke all on function public.get_order_financial_state_block3(bigint, date, numeric)
  from public, anon, authenticated;
grant execute on function public.get_order_financial_state_block3(bigint, date, numeric)
  to service_role;

commit;
