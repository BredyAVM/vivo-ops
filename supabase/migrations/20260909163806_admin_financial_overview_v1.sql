begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function app_private.admin_finance_period_v1(
  p_period text,
  p_as_of timestamptz
)
returns table (
  period_key text,
  period_start date,
  period_end_exclusive date,
  full_period_end_exclusive date,
  previous_start date,
  previous_end_exclusive date,
  today date
)
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_period text := lower(coalesce(nullif(btrim(p_period), ''), 'today'));
  v_today date := (coalesce(p_as_of, pg_catalog.now()) at time zone 'America/Caracas')::date;
  v_start date;
  v_end date;
  v_full_end date;
  v_previous_start date;
  v_previous_end date;
  v_elapsed_days integer;
begin
  if v_period not in ('today', 'week', 'month') then
    raise exception 'Periodo financiero no soportado.' using errcode = '22023';
  end if;

  v_end := v_today + 1;

  if v_period = 'today' then
    v_start := v_today;
    v_full_end := v_end;
    v_previous_start := v_today - 1;
    v_previous_end := v_today;
  elsif v_period = 'week' then
    v_start := v_today - (extract(isodow from v_today)::integer - 1);
    v_full_end := v_start + 7;
    v_elapsed_days := v_end - v_start;
    v_previous_start := v_start - 7;
    v_previous_end := v_previous_start + v_elapsed_days;
  else
    v_start := pg_catalog.date_trunc('month', v_today::timestamp)::date;
    v_full_end := (v_start + interval '1 month')::date;
    v_elapsed_days := v_end - v_start;
    v_previous_start := (v_start - interval '1 month')::date;
    v_previous_end := least(v_start, v_previous_start + v_elapsed_days);
  end if;

  return query
  select
    v_period,
    v_start,
    v_end,
    v_full_end,
    v_previous_start,
    v_previous_end,
    v_today;
end;
$function$;

revoke all on function app_private.admin_finance_period_v1(text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function app_private.admin_finance_safe_numeric_v1(p_value text)
returns numeric
language plpgsql
immutable
strict
set search_path = ''
as $function$
begin
  if p_value !~ '^-?[0-9]+([.][0-9]+)?$' then
    return null;
  end if;
  return p_value::numeric;
exception
  when others then
    return null;
end;
$function$;

create or replace function app_private.admin_finance_safe_date_v1(p_value text)
returns date
language plpgsql
immutable
strict
set search_path = ''
as $function$
begin
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return p_value::date;
exception
  when others then
    return null;
end;
$function$;

revoke all on function app_private.admin_finance_safe_numeric_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function app_private.admin_finance_safe_date_v1(text)
  from public, anon, authenticated, service_role;

create or replace function public.admin_finance_commercial_overview_v1(
  p_period text default 'today',
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.now());
  v_period record;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesion para consultar el resumen financiero.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_uid
      and role_row.role = 'admin'
  ) then
    raise exception 'Solo Administracion puede consultar el resumen financiero.'
      using errcode = '42501';
  end if;

  select *
  into v_period
  from app_private.admin_finance_period_v1(p_period, v_as_of);

  with delivered_events as (
    select
      event_row.order_id,
      max(event_row.created_at) as delivered_at
    from public.order_events event_row
    where event_row.event = 'delivered'
      and event_row.created_at <= v_as_of
      and event_row.created_at >= (
        v_period.previous_start::timestamp at time zone 'America/Caracas'
      )
      and event_row.created_at < (
        v_period.period_end_exclusive::timestamp at time zone 'America/Caracas'
      )
    group by event_row.order_id
  ),
  delivered as (
    select
      order_row.id,
      (delivery.delivered_at at time zone 'America/Caracas')::date as commercial_date,
      case
        when app_private.admin_finance_safe_numeric_v1(
          order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
        ) is not null
          then round(app_private.admin_finance_safe_numeric_v1(
            order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
          ), 2)
        else round(greatest(
          coalesce(
            app_private.admin_finance_safe_numeric_v1(
              order_row.extra_fields #>> '{pricing,total_usd}'
            ),
            order_row.total_usd,
            0
          ) - coalesce(
            app_private.admin_finance_safe_numeric_v1(
              order_row.extra_fields #>> '{pricing,invoice_tax_amount_usd}'
            ),
            0
          ),
          0
        ), 2)
      end as net_sales_usd,
      (
        app_private.admin_finance_safe_numeric_v1(
          order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
        ) is not null
      ) as has_exact_pricing
    from delivered_events delivery
    join public.orders order_row on order_row.id = delivery.order_id
    where order_row.status = 'delivered'
  ),
  current_summary as (
    select
      count(*)::integer as delivered_orders,
      round(coalesce(sum(delivered.net_sales_usd), 0), 2) as delivered_sales_usd,
      count(*) filter (where delivered.has_exact_pricing)::integer as exact_pricing_orders
    from delivered
    where delivered.commercial_date >= v_period.period_start
      and delivered.commercial_date < v_period.period_end_exclusive
  ),
  previous_summary as (
    select
      count(*)::integer as delivered_orders,
      round(coalesce(sum(delivered.net_sales_usd), 0), 2) as delivered_sales_usd
    from delivered
    where delivered.commercial_date >= v_period.previous_start
      and delivered.commercial_date < v_period.previous_end_exclusive
  ),
  scheduled_candidates as (
    select
      order_row.id,
      coalesce(order_row.queued_needs_reapproval, false) as needs_reapproval,
      app_private.admin_finance_safe_date_v1(
        order_row.extra_fields #>> '{schedule,date}'
      ) as scheduled_date,
      app_private.admin_finance_safe_numeric_v1(
        order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
      ) is not null as has_exact_pricing,
      case
        when app_private.admin_finance_safe_numeric_v1(
          order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
        ) is not null
          then round(app_private.admin_finance_safe_numeric_v1(
            order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
          ), 2)
        else round(greatest(
          coalesce(
            app_private.admin_finance_safe_numeric_v1(
              order_row.extra_fields #>> '{pricing,total_usd}'
            ),
            order_row.total_usd,
            0
          ) - coalesce(
            app_private.admin_finance_safe_numeric_v1(
              order_row.extra_fields #>> '{pricing,invoice_tax_amount_usd}'
            ),
            0
          ),
          0
        ), 2)
      end as net_sales_usd
    from public.orders order_row
    where order_row.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
  ),
  scheduled_summary as (
    select
      count(*) filter (where not scheduled.needs_reapproval)::integer as scheduled_orders,
      round(coalesce(sum(scheduled.net_sales_usd) filter (
        where not scheduled.needs_reapproval
      ), 0), 2) as scheduled_sales_usd,
      count(*) filter (
        where not scheduled.needs_reapproval
          and scheduled.has_exact_pricing
      )::integer as scheduled_exact_pricing_orders,
      count(*) filter (where scheduled.needs_reapproval)::integer as blocked_orders
    from scheduled_candidates scheduled
    where scheduled.scheduled_date >= greatest(
        v_period.today,
        v_period.period_start
      )
      and scheduled.scheduled_date < v_period.full_period_end_exclusive
  ),
  daily_series as (
    select
      day_row.day::date as date_key,
      round(coalesce(sum(delivered.net_sales_usd), 0), 2) as sales_usd
    from pg_catalog.generate_series(
      v_period.period_start::timestamp,
      (v_period.period_end_exclusive - 1)::timestamp,
      interval '1 day'
    ) as day_row(day)
    left join delivered on delivered.commercial_date = day_row.day::date
    group by day_row.day
    order by day_row.day
  )
  select pg_catalog.jsonb_build_object(
    'definitionVersion', 'admin-finance-v1',
    'asOf', v_as_of,
    'periodStart', v_period.period_start,
    'periodEndExclusive', v_period.period_end_exclusive,
    'deliveredOrders', current_summary.delivered_orders,
    'deliveredSalesUsd', current_summary.delivered_sales_usd,
    'previousDeliveredOrders', previous_summary.delivered_orders,
    'previousDeliveredSalesUsd', previous_summary.delivered_sales_usd,
    'scheduledOrders', scheduled_summary.scheduled_orders,
    'scheduledSalesUsd', scheduled_summary.scheduled_sales_usd,
    'blockedScheduledOrders', scheduled_summary.blocked_orders,
    'scheduledQuality', case
      when scheduled_summary.scheduled_orders = scheduled_summary.scheduled_exact_pricing_orders
        then 'Q1_exact'
      else 'Q2_derived'
    end,
    'scheduledExactPricingOrders', scheduled_summary.scheduled_exact_pricing_orders,
    'quality', case
      when current_summary.delivered_orders = current_summary.exact_pricing_orders then 'Q1_exact'
      else 'Q2_derived'
    end,
    'exactPricingOrders', current_summary.exact_pricing_orders,
    'totalPricingOrders', current_summary.delivered_orders,
    'series', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'dateKey', daily_series.date_key,
          'salesUsd', daily_series.sales_usd
        )
        order by daily_series.date_key
      )
      from daily_series
    ), '[]'::jsonb)
  )
  into v_result
  from current_summary
  cross join previous_summary
  cross join scheduled_summary;

  return v_result;
end;
$function$;

revoke all on function public.admin_finance_commercial_overview_v1(text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_commercial_overview_v1(text, timestamptz)
  to authenticated;

create or replace function public.admin_finance_treasury_overview_v1(
  p_period text default 'today',
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.now());
  v_period record;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesion para consultar el resumen financiero.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_uid
      and role_row.role = 'admin'
  ) then
    raise exception 'Solo Administracion puede consultar el resumen financiero.'
      using errcode = '42501';
  end if;

  select *
  into v_period
  from app_private.admin_finance_period_v1(p_period, v_as_of);

  with movement_window as (
    select movement.*
    from public.money_movements movement
    where movement.confirmed_at is not null
      and movement.confirmed_at <= v_as_of
      and (movement.rejected_at is null or movement.rejected_at > v_as_of)
      and (movement.voided_at is null or movement.voided_at > v_as_of)
      and movement.movement_date >= v_period.previous_start
      and movement.movement_date < v_period.period_end_exclusive
  ),
  candidate_groups as (
    select distinct movement.movement_group_id
    from movement_window movement
    where movement.movement_group_id is not null
  ),
  transfer_group_facts as (
    select
      movement.movement_group_id,
      count(*) filter (
        where movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
      )::integer as source_leg_count,
      count(*) filter (
        where movement.direction = 'inflow'
          and movement.movement_type = 'other_income'
      )::integer as target_leg_count,
      count(*) filter (
        where movement.confirmed_at is not null
          and movement.confirmed_at <= v_as_of
          and movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
      )::integer as confirmed_source_leg_count,
      count(*) filter (
        where movement.confirmed_at is not null
          and movement.confirmed_at <= v_as_of
          and movement.direction = 'inflow'
          and movement.movement_type = 'other_income'
      )::integer as confirmed_target_leg_count,
      coalesce(sum(movement.amount_usd_equivalent) filter (
        where movement.confirmed_at is not null
          and movement.confirmed_at <= v_as_of
          and movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
      ), 0) as confirmed_source_usd,
      coalesce(sum(movement.amount_usd_equivalent) filter (
        where movement.confirmed_at is not null
          and movement.confirmed_at <= v_as_of
          and movement.direction = 'inflow'
          and movement.movement_type = 'other_income'
      ), 0) as confirmed_target_usd,
      bool_or(
        coalesce(movement.description, '') ilike 'Traspaso salida%'
        or coalesce(movement.description, '') ilike 'Traspaso entrada%'
      ) as has_transfer_marker
    from public.money_movements movement
    join candidate_groups candidate
      on candidate.movement_group_id = movement.movement_group_id
    where movement.created_at <= v_as_of
      and (movement.rejected_at is null or movement.rejected_at > v_as_of)
      and (movement.voided_at is null or movement.voided_at > v_as_of)
    group by movement.movement_group_id
  ),
  transfer_group_health as (
    select
      facts.movement_group_id,
      (
        facts.source_leg_count = 1
        and facts.target_leg_count = 1
        and facts.confirmed_source_leg_count = 1
        and facts.confirmed_target_leg_count = 1
      ) as is_internal_transfer,
      (
        (
          facts.has_transfer_marker
          or (facts.source_leg_count > 0 and facts.target_leg_count > 0)
        )
        and (
          not (
            facts.source_leg_count = 1
            and facts.target_leg_count = 1
            and facts.confirmed_source_leg_count = 1
            and facts.confirmed_target_leg_count = 1
          )
          or abs(facts.confirmed_source_usd - facts.confirmed_target_usd) > 0.005
        )
      ) as is_incomplete_transfer
    from transfer_group_facts facts
  ),
  classified as (
    select
      movement.*,
      coalesce(transfer_group.is_internal_transfer, false) as is_internal_transfer,
      coalesce(transfer_group.is_incomplete_transfer, false) as is_incomplete_transfer
    from movement_window movement
    left join transfer_group_health transfer_group
      on transfer_group.movement_group_id = movement.movement_group_id
  ),
  current_summary as (
    select
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.direction = 'inflow'
          and classified.movement_type = 'order_payment'
      ), 0), 2) as confirmed_collections_usd,
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.direction = 'inflow'
          and classified.movement_type = 'other_income'
          and not classified.is_internal_transfer
      ), 0), 2) as other_external_income_usd,
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.direction = 'outflow'
          and (
            classified.movement_type in ('expense_payment', 'change_given', 'fee_charge')
            or (
              classified.movement_type = 'withdrawal'
              and not classified.is_internal_transfer
            )
          )
      ), 0), 2) as external_outflows_usd,
      count(*) filter (
        where classified.direction = 'outflow'
          and classified.movement_type = 'withdrawal'
          and not classified.is_internal_transfer
      )::integer as derived_withdrawal_count,
      count(*) filter (
        where classified.movement_type in ('adjustment', 'cash_count_adjustment')
      )::integer as unclassified_adjustment_count,
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.movement_type in ('adjustment', 'cash_count_adjustment')
      ), 0), 2) as unclassified_adjustment_usd,
      count(distinct classified.movement_group_id) filter (
        where classified.is_incomplete_transfer
      )::integer as incomplete_transfer_groups,
      count(distinct classified.movement_group_id) filter (
        where classified.is_internal_transfer
      )::integer as internal_transfer_groups_excluded
    from classified
    where classified.movement_date >= v_period.period_start
      and classified.movement_date < v_period.period_end_exclusive
  ),
  previous_summary as (
    select
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.direction = 'inflow'
          and classified.movement_type = 'order_payment'
      ), 0), 2) as confirmed_collections_usd,
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.direction = 'inflow'
          and classified.movement_type = 'other_income'
          and not classified.is_internal_transfer
      ), 0), 2) as other_external_income_usd,
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.direction = 'outflow'
          and (
            classified.movement_type in ('expense_payment', 'change_given', 'fee_charge')
            or (
              classified.movement_type = 'withdrawal'
              and not classified.is_internal_transfer
            )
          )
      ), 0), 2) as external_outflows_usd,
      count(*) filter (
        where classified.movement_type in ('adjustment', 'cash_count_adjustment')
      )::integer as unclassified_adjustment_count,
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.movement_type in ('adjustment', 'cash_count_adjustment')
      ), 0), 2) as unclassified_adjustment_usd,
      count(distinct classified.movement_group_id) filter (
        where classified.is_incomplete_transfer
      )::integer as incomplete_transfer_groups
    from classified
    where classified.movement_date >= v_period.previous_start
      and classified.movement_date < v_period.previous_end_exclusive
  ),
  pending_reports as (
    select
      count(*)::integer as pending_payment_reports,
      round(coalesce(sum(report.reported_amount_usd_equivalent), 0), 2)
        as pending_payment_reports_usd
    from public.payment_reports report
    where report.created_at <= v_as_of
      and (report.reviewed_at is null or report.reviewed_at > v_as_of)
  ),
  pending_movements as (
    select count(distinct coalesce(
      movement.movement_group_id::text,
      'movement:' || movement.id::text
    ))::integer as pending_movement_operations
    from public.money_movements movement
    where movement.created_at <= v_as_of
      and (movement.confirmed_at is null or movement.confirmed_at > v_as_of)
      and (movement.rejected_at is null or movement.rejected_at > v_as_of)
      and (movement.voided_at is null or movement.voided_at > v_as_of)
  ),
  daily_series as (
    select
      day_row.day::date as date_key,
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.direction = 'inflow'
          and classified.movement_type = 'order_payment'
      ), 0), 2) as collections_usd,
      round(coalesce(sum(classified.amount_usd_equivalent) filter (
        where classified.direction = 'outflow'
          and (
            classified.movement_type in ('expense_payment', 'change_given', 'fee_charge')
            or (
              classified.movement_type = 'withdrawal'
              and not classified.is_internal_transfer
            )
          )
      ), 0), 2) as external_outflows_usd
    from pg_catalog.generate_series(
      v_period.period_start::timestamp,
      (v_period.period_end_exclusive - 1)::timestamp,
      interval '1 day'
    ) as day_row(day)
    left join classified on classified.movement_date = day_row.day::date
    group by day_row.day
    order by day_row.day
  )
  select pg_catalog.jsonb_build_object(
    'definitionVersion', 'admin-finance-v1',
    'asOf', v_as_of,
    'periodStart', v_period.period_start,
    'periodEndExclusive', v_period.period_end_exclusive,
    'confirmedCollectionsUsd', current_summary.confirmed_collections_usd,
    'otherExternalIncomeUsd', current_summary.other_external_income_usd,
    'externalOutflowsUsd', current_summary.external_outflows_usd,
    'netExternalCashFlowUsd', case
      when current_summary.unclassified_adjustment_count > 0
        or current_summary.incomplete_transfer_groups > 0
        then null
      else round(
        current_summary.confirmed_collections_usd
        + current_summary.other_external_income_usd
        - current_summary.external_outflows_usd,
        2
      )
    end,
    'previousConfirmedCollectionsUsd', previous_summary.confirmed_collections_usd,
    'previousExternalOutflowsUsd', previous_summary.external_outflows_usd,
    'previousNetExternalCashFlowUsd', case
      when previous_summary.unclassified_adjustment_count > 0
        or previous_summary.incomplete_transfer_groups > 0
        then null
      else round(
        previous_summary.confirmed_collections_usd
        + previous_summary.other_external_income_usd
        - previous_summary.external_outflows_usd,
        2
      )
    end,
    'outflowQuality', case
      when current_summary.unclassified_adjustment_count > 0
        or current_summary.incomplete_transfer_groups > 0
        then 'Q3_incomplete'
      when current_summary.derived_withdrawal_count > 0 then 'Q2_derived'
      else 'Q1_exact'
    end,
    'netCashFlowQuality', case
      when current_summary.unclassified_adjustment_count > 0
        or current_summary.incomplete_transfer_groups > 0
        then 'Q4_blocked'
      when current_summary.derived_withdrawal_count > 0 then 'Q2_derived'
      else 'Q1_exact'
    end,
    'derivedWithdrawalCount', current_summary.derived_withdrawal_count,
    'unclassifiedAdjustmentCount', current_summary.unclassified_adjustment_count,
    'unclassifiedAdjustmentUsd', current_summary.unclassified_adjustment_usd,
    'incompleteTransferGroups', current_summary.incomplete_transfer_groups,
    'previousUnclassifiedAdjustmentCount', previous_summary.unclassified_adjustment_count,
    'previousUnclassifiedAdjustmentUsd', previous_summary.unclassified_adjustment_usd,
    'previousIncompleteTransferGroups', previous_summary.incomplete_transfer_groups,
    'internalTransferGroupsExcluded', current_summary.internal_transfer_groups_excluded,
    'pendingPaymentReports', pending_reports.pending_payment_reports,
    'pendingPaymentReportsUsd', pending_reports.pending_payment_reports_usd,
    'pendingMovementOperations', pending_movements.pending_movement_operations,
    'series', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'dateKey', daily_series.date_key,
          'collectionsUsd', daily_series.collections_usd,
          'externalOutflowsUsd', daily_series.external_outflows_usd
        )
        order by daily_series.date_key
      )
      from daily_series
    ), '[]'::jsonb)
  )
  into v_result
  from current_summary
  cross join previous_summary
  cross join pending_reports
  cross join pending_movements;

  return v_result;
end;
$function$;

revoke all on function public.admin_finance_treasury_overview_v1(text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_treasury_overview_v1(text, timestamptz)
  to authenticated;

create or replace function public.admin_finance_position_overview_v1(
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.now());
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesion para consultar el resumen financiero.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_uid
      and role_row.role = 'admin'
  ) then
    raise exception 'Solo Administracion puede consultar el resumen financiero.'
      using errcode = '42501';
  end if;

  with active_rate as (
    select
      rate.rate_bs_per_usd,
      rate.effective_at,
      rate.previous_rate_bs_per_usd
    from public.exchange_rates rate
    where rate.effective_at <= v_as_of
      and rate.created_at <= v_as_of
    order by rate.effective_at desc, rate.id desc
    limit 1
  ),
  active_rate_count as (
    select count(*)::integer as rate_count
    from public.exchange_rates rate
    where rate.effective_at = (
      select max(candidate.effective_at)
      from public.exchange_rates candidate
      where candidate.effective_at <= v_as_of
        and candidate.created_at <= v_as_of
    )
      and rate.created_at <= v_as_of
  ),
  active_accounts as (
    select account.id
    from public.money_accounts account
    where account.is_active = true
  ),
  valid_baselines as (
    select baseline.money_account_id, baseline.baseline_date as anchor_date
    from public.money_account_closure_baselines baseline
    join active_accounts account on account.id = baseline.money_account_id
    where baseline.status = 'active'
      and baseline.baseline_at <= v_as_of
  ),
  valid_closures as (
    select closure.money_account_id, closure.closure_date as anchor_date
    from public.money_account_closures closure
    join active_accounts account on account.id = closure.money_account_id
    where closure.status in ('recorded', 'approved')
      and coalesce(closure.closure_at, closure.created_at) <= v_as_of
  ),
  valid_anchors as (
    select baseline.money_account_id, baseline.anchor_date
    from valid_baselines baseline

    union all

    select closure.money_account_id, closure.anchor_date
    from valid_closures closure
  ),
  account_health as (
    select
      count(*)::integer as active_accounts,
      count(*) filter (where exists (
        select 1
        from valid_anchors anchor
        where anchor.money_account_id = account.id
      ))::integer as anchored_accounts,
      (select max(closure.anchor_date) from valid_closures closure) as latest_closure_date
    from active_accounts account
  ),
  client_fund_cache as (
    select round(coalesce(sum(client.fund_balance_usd), 0), 2) as balance_usd
    from public.clients client
  ),
  client_fund_ledger as (
    select round(coalesce(sum(
      case
        when movement.movement_type = 'credit' then movement.amount_usd
        when movement.movement_type = 'debit' then -movement.amount_usd
        else 0
      end
    ), 0), 2) as balance_usd
    from public.client_fund_movements movement
    where movement.created_at <= v_as_of
  ),
  client_fund_post_cutoff as (
    select count(*)::integer as movement_count
    from public.client_fund_movements movement
    where movement.created_at > v_as_of
  ),
  reconciliation_health as (
    select
      count(*)::integer as open_reconciliations,
      round(coalesce(sum(abs(item.amount_usd_equivalent)), 0), 2) as open_reconciliations_usd,
      count(*) filter (
        where item.source_kind = 'closure'
          and exists (
            select 1
            from public.money_account_closures closure
            where closure.id = item.source_id
              and closure.status = 'rejected'
          )
      )::integer as orphaned_reconciliations
    from public.money_account_reconciliation_items item
    where item.created_at <= v_as_of
      and (item.resolved_at is null or item.resolved_at > v_as_of)
      and (item.voided_at is null or item.voided_at > v_as_of)
  )
  select pg_catalog.jsonb_build_object(
    'definitionVersion', 'admin-finance-v1',
    'asOf', v_as_of,
    'activeRateBsPerUsd', active_rate.rate_bs_per_usd,
    'activeRateEffectiveAt', active_rate.effective_at,
    'previousRateBsPerUsd', active_rate.previous_rate_bs_per_usd,
    'activeRateCount', active_rate_count.rate_count,
    'activeAccounts', account_health.active_accounts,
    'anchoredAccounts', account_health.anchored_accounts,
    'latestClosureDate', account_health.latest_closure_date,
    'accountCoverageQuality', case
      when account_health.active_accounts = 0 then 'Q4_blocked'
      when account_health.active_accounts = account_health.anchored_accounts then 'Q1_exact'
      else 'Q3_incomplete'
    end,
    'clientFundsUsd', case
      when client_fund_post_cutoff.movement_count > 0 then null
      else client_fund_cache.balance_usd
    end,
    'clientFundLedgerUsd', client_fund_ledger.balance_usd,
    'clientFundDifferenceUsd', case
      when client_fund_post_cutoff.movement_count > 0 then null
      else round(
        client_fund_cache.balance_usd - client_fund_ledger.balance_usd,
        2
      )
    end,
    'clientFundsQuality', case
      when client_fund_post_cutoff.movement_count > 0 then 'Q4_blocked'
      when abs(client_fund_cache.balance_usd - client_fund_ledger.balance_usd) <= 0.01
        then 'Q1_exact'
      else 'Q3_incomplete'
    end,
    'openReconciliations', reconciliation_health.open_reconciliations,
    'openReconciliationsUsd', reconciliation_health.open_reconciliations_usd,
    'orphanedReconciliations', reconciliation_health.orphaned_reconciliations,
    'treasuryPositionUsd', null,
    'treasuryAfterClientFundsUsd', null,
    'treasuryQuality', 'Q4_blocked'
  )
  into v_result
  from active_rate_count
  cross join account_health
  cross join client_fund_cache
  cross join client_fund_ledger
  cross join client_fund_post_cutoff
  cross join reconciliation_health
  left join active_rate on true;

  return v_result;
end;
$function$;

revoke all on function public.admin_finance_position_overview_v1(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_position_overview_v1(timestamptz)
  to authenticated;

comment on function public.admin_finance_commercial_overview_v1(text, timestamptz)
is 'Admin-only commercial overview. Uses delivered events in America/Caracas and returns aggregates only.';

comment on function public.admin_finance_treasury_overview_v1(text, timestamptz)
is 'Admin-only treasury overview. Uses movements confirmed by as_of on movement_date, excludes paired internal transfers, blocks unclassified FX differences and returns aggregates only.';

comment on function public.admin_finance_position_overview_v1(timestamptz)
is 'Admin-only current position health. Reconciles client-fund cache/ledger and reports account-anchor coverage.';

commit;
