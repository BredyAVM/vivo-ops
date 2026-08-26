begin;

-- Counter creates a temporary client-fund credit before converting the same
-- overpayment into cash change. That reversal should only increase the paid
-- amount while the originating payment/change group is still confirmed.
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
        else movement.amount_usd_equivalent * coalesce(base.snapshot_rate_bs_per_usd, 0)
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
    ), 0), 2) as change_fund_reversal_usd
  from base
  left join public.money_movements movement
    on movement.order_id = base.order_id
  group by base.snapshot_rate_bs_per_usd
),
adjusted as (
  select
    base.*,
    greatest(
      0,
      round(
        base.confirmed_paid_usd
        + adjustments.change_fund_reversal_usd
        - adjustments.refund_usd,
        2
      )
    ) as adjusted_paid_usd,
    greatest(
      0,
      round(
        base.confirmed_paid_bs_snapshot
        + adjustments.change_fund_reversal_usd * base.snapshot_rate_bs_per_usd
        - adjustments.refund_bs_snapshot,
        2
      )
    ) as adjusted_paid_bs
  from base
  cross join adjustments
),
balances as (
  select
    adjusted.*,
    greatest(0, round(adjusted.total_usd - adjusted.adjusted_paid_usd, 2)) as adjusted_pending_usd,
    greatest(0, round(adjusted.adjusted_paid_usd - adjusted.total_usd, 2)) as adjusted_overpaid_usd
  from adjusted
)
select
  balances.order_id,
  balances.order_number,
  balances.order_status,
  balances.total_usd,
  balances.total_bs,
  balances.snapshot_rate_bs_per_usd,
  balances.adjusted_paid_usd,
  balances.adjusted_paid_bs,
  balances.pending_reports_usd,
  balances.pending_reports_bs_snapshot,
  balances.rejected_reports_usd,
  balances.voided_movements_count,
  balances.rejected_reports_count,
  balances.pending_reports_count,
  balances.confirmed_reports_count,
  balances.client_fund_used_usd,
  balances.adjusted_pending_usd,
  case
    when balances.adjusted_pending_usd <= 0.005 then 0
    when balances.delivery_reference_date is not null
      and balances.effective_operation_date > balances.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then round(balances.adjusted_pending_usd * p_active_bs_rate, 2)
    when balances.total_bs > 0
      then greatest(0, round(balances.total_bs - balances.adjusted_paid_bs, 2))
    when coalesce(p_active_bs_rate, 0) > 0
      then round(balances.adjusted_pending_usd * p_active_bs_rate, 2)
    else 0
  end,
  balances.adjusted_overpaid_usd,
  case
    when balances.adjusted_pending_usd <= 0.005 then 'closed'
    when balances.delivery_reference_date is not null
      and balances.effective_operation_date > balances.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then 'post_delivery_usd'
    else 'snapshot_quote'
  end,
  case
    when balances.order_status = 'cancelled' then 'cancelled'
    when balances.adjusted_overpaid_usd > 0.005 then 'overpaid'
    when balances.pending_reports_count > 0 then 'pending_review'
    when balances.adjusted_pending_usd <= 0.005 then 'paid'
    when balances.adjusted_paid_usd > 0.005 then 'partial'
    else 'unpaid'
  end,
  balances.delivery_reference_date,
  balances.effective_operation_date
from balances;
$function$;

comment on function public.get_order_financial_state(bigint, date, numeric)
is 'Estado financiero canonico por orden. Cuenta reembolsos Counter confirmados y reversiones temporales de fondo por cambio solo si el grupo pago/cambio sigue confirmado.';

revoke all on function public.get_order_financial_state(bigint, date, numeric)
  from public, anon;
grant execute on function public.get_order_financial_state(bigint, date, numeric)
  to authenticated, service_role;

commit;
