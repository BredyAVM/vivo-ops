-- A confirmed payment that covers the exact commercial VES snapshot on or
-- before delivery must close the order even when its rounded USD equivalent is
-- one or more cents below the independently rounded order total.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
set search_path = ''
as $function$
with base as (
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
      from public.payment_reports report
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

comment on function public.get_order_financial_state(bigint, date, numeric)
is 'Estado financiero canonico: un pago confirmado antes/durante entrega que cubre el snapshot VES exacto cierra tambien el equivalente USD sin residuo de redondeo.';

revoke all on function public.get_order_financial_state(bigint, date, numeric)
  from public, anon;
grant execute on function public.get_order_financial_state(bigint, date, numeric)
  to authenticated, service_role;

commit;
