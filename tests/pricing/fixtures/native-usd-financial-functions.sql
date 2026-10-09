-- Read-only extraction of installed production definitions, 2026-10-09.
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
  where r.order_id = p_order_id -- scoped payment evidence
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
change_accounting as (
  select
    coalesce((select sum(op.difference_usd) from public.client_fund_payout_operations op
      where op.order_id=p_order_id and op.voided_at is null),0) as payout_difference_usd,
    coalesce((select sum(m.amount_usd_equivalent)
      from public.payment_confirmation_operations op
      join public.money_movements m on m.movement_group_id=op.movement_group_id
      where op.order_id=p_order_id and op.request ? 'expectedChangeDebtUsd'
        and m.direction='outflow' and m.movement_type='change_given' and m.status='confirmed'),0) as certified_change_usd
),
calculated as (
  select
    dates.id as order_id,
    dates.order_number,
    dates.status as order_status,
    dates.effective_total_usd as total_usd,
    dates.effective_total_bs as total_bs,
    dates.effective_snapshot_rate as snapshot_rate_bs_per_usd,
    coalesce(movement.confirmed_paid_usd, 0) - (select payout_difference_usd from change_accounting) as confirmed_money_usd,
    (select payout_difference_usd+certified_change_usd from change_accounting) as snapshot_change_usd,
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
          + calculated.snapshot_change_usd
      ) * calculated.snapshot_rate_bs_per_usd
      - calculated.snapshot_change_usd * calculated.snapshot_rate_bs_per_usd
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
$function$
;

CREATE OR REPLACE FUNCTION public.order_collection_precision_basis_v1(p_order_id bigint)
 RETURNS TABLE(total_precise_usd numeric, paid_delta_usd numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
    + coalesce((select sum(d.rounding_usd) from public.delivery_debt_allocations d where d.order_id=p_order_id and d.reversed_at is null),0)

from amounts a
where fx>0 and fx::text not in ('NaN','Infinity','-Infinity') and n>0 and valid
  and round(usd-discount_usd+tax_usd,2)=header_usd
  and round(bs-discount_bs+tax_bs,2)=header_bs
  and (enrolled or (
    not exists(select 1 from public.money_movements m where m.order_id=p_order_id)
    and not exists(select 1 from public.client_fund_movements f where f.order_id=p_order_id)
    and coalesce(nullif(extra_fields#>>'{payment,client_fund_used_usd}','')::numeric,0)=0
  ));
$function$
;

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
  where r.order_id = p_order_id -- scoped payment evidence
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
    -- Snapshot-day VES quotes use the native confirmed balance below.
    -- Only post-delivery collection may reuse certified USD coverage here.
    when canonical.total_precise_usd is not null
      and canonical.delivery_reference_date is not null
      and canonical.effective_operation_date > canonical.delivery_reference_date
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
$function$
;

CREATE OR REPLACE FUNCTION app_private.capture_order_payment_precision_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.counter_read_payment_quote(p_order_id bigint, p_operation_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_operation_date date := coalesce(
    p_operation_date,
    (now() at time zone 'America/Caracas')::date
  );
  v_rate numeric(18,6);
  v_state record;
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

  perform order_row.id
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'counter_order_not_found';
  end if;

  select rate.rate_bs_per_usd
  into v_rate
  from public.exchange_rates rate
  where rate.effective_at < ((v_operation_date + 1)::timestamp at time zone 'America/Caracas')
  order by rate.effective_at desc, rate.id desc
  limit 1;

  select *
  into v_state
  from public.get_order_financial_state(
    p_order_id,
    v_operation_date,
    v_rate
  );

  if v_state.collection_mode = 'post_delivery_usd'
     and coalesce(v_rate, 0) <= 0 then
    raise exception 'counter_operation_rate_not_found';
  end if;

  return jsonb_build_object(
    'operationDate', v_operation_date,
    'pendingUsd', coalesce(v_state.pending_usd, 0),
    'pendingBs', coalesce(v_state.pending_bs, 0),
    'exchangeRate', coalesce(v_rate, 0),
    'collectionMode', coalesce(v_state.collection_mode, 'closed'),
    'snapshotRate', coalesce(v_state.snapshot_rate_bs_per_usd, 0)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.reserve_draft_conversion_prices_v1(p_order bigint, p_draft bigint, p_items jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare line jsonb; agreement app_private.advisor_draft_price_agreements_v1%rowtype; parent public.orders%rowtype;
begin
  if auth.uid() is null or public.has_role('advisor') is not true then
    raise exception 'Asesor no autorizado.' using errcode='42501'; end if;
  select * into parent from public.orders where id=p_order and created_by_user_id=auth.uid()
    and attributed_advisor_id=auth.uid() and status::text='created';
  if not found or not exists(select 1 from public.advisor_order_drafts
    where id=p_draft and advisor_user_id=auth.uid() and status in ('draft','quoted')) then
    raise exception 'No se puede verificar este presupuesto.' using errcode='42501'; end if;
  if exists(select 1 from public.order_items where order_id=p_order) then
    raise exception 'La conversión requiere una orden nueva sin ítems.' using errcode='42501'; end if;
  perform 1 from public.advisor_order_drafts where id=p_draft and advisor_user_id=auth.uid()
    and status in ('draft','quoted') for update;
  if not found then raise exception 'Este presupuesto ya fue convertido.' using errcode='22023'; end if;
  delete from app_private.draft_conversion_price_context_v1 where order_id=p_order;
  for line in select value from jsonb_array_elements(p_items) loop
    select * into agreement from app_private.advisor_draft_price_agreements_v1
      where draft_id=p_draft and line_key=line->>'draft_price_agreement_key'
        and advisor_user_id=auth.uid();
    if not found then
      if exists(select 1 from public.advisor_order_drafts d,
        lateral jsonb_array_elements(d.payload->'items') i where d.id=p_draft
        and i->>'localId'=line->>'draft_price_agreement_key'
        and (i->'crm_benefit' is null or i->'crm_benefit'='null'::jsonb)) then
        raise exception 'No se pudieron verificar las condiciones guardadas de este ítem. Revisa el presupuesto antes de convertirlo.' using errcode='22023';
      end if;
      continue;
    end if;
    if agreement.client_id is not null and agreement.client_id is distinct from parent.client_id then
      raise exception 'El presupuesto pertenece a otro cliente. Crea uno nuevo para este cliente.' using errcode='42501'; end if;
    if nullif(parent.extra_fields#>>'{pricing,fx_rate}','')::numeric
      is distinct from (agreement.terms->>'pricing_fx_rate_snapshot')::numeric then
      raise exception 'La conversión debe conservar la tasa acordada del presupuesto.' using errcode='22023'; end if;
    if exists(select 1 from jsonb_each(agreement.terms) term
      where term.key<>'pricing_fx_rate_snapshot' and line->term.key is distinct from term.value)
      or line->>'crm_play_member_id' is not null or line->>'crm_play_benefit_id' is not null
      or line->>'crm_play_benefit_upgrade_id' is not null then
      raise exception 'El ítem del presupuesto cambió. Conserva la cantidad acordada y agrega lo nuevo por separado.' using errcode='22023';
    end if;
    insert into app_private.draft_conversion_price_context_v1(order_id,line_key,transaction_id,terms)
      values(p_order,agreement.line_key,txid_current(),agreement.terms);
  end loop;
  update public.advisor_order_drafts set status='converted',converted_order_id=p_order,
    converted_at=statement_timestamp() where id=p_draft and advisor_user_id=auth.uid();
end;
$function$
;
