begin;

-- Keep the v2 RPC result contract unchanged, but choose the accounting anchor
-- by the real event timestamp. closure_date is descriptive business metadata;
-- it must never outrank a later closure event when selecting the current anchor.
create or replace function app_private.admin_finance_account_snapshots_v2(
  p_as_of timestamptz default pg_catalog.statement_timestamp()
)
returns table (
  account_id bigint,
  account_name text,
  currency_code text,
  account_kind text,
  institution_name text,
  owner_name text,
  is_active boolean,
  closure_kind text,
  baseline_required boolean,
  balance_native numeric,
  ledger_value_usd numeric,
  current_value_usd numeric,
  anchor_kind text,
  anchor_id bigint,
  anchor_date date,
  anchor_at timestamptz,
  anchor_amount numeric,
  latest_closure_id bigint,
  latest_closure_date date,
  latest_closure_at timestamptz,
  latest_closure_status text,
  latest_closure_difference numeric,
  latest_closure_difference_usd numeric,
  open_reconciliations integer,
  open_reconciliation_native numeric,
  open_reconciliation_usd numeric,
  orphaned_reconciliations integer,
  pending_movement_operations integer,
  pending_movement_native numeric,
  pending_movement_usd numeric,
  quality text,
  active_rate_bs_per_usd numeric,
  active_rate_effective_at timestamptz,
  calculated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  with cutoff as (
    select
      coalesce(p_as_of, pg_catalog.statement_timestamp()) as as_of,
      (
        coalesce(p_as_of, pg_catalog.statement_timestamp())
          at time zone 'America/Caracas'
      )::date as local_date
  ),
  active_rate_candidates as (
    select
      rate.id,
      rate.rate_bs_per_usd,
      rate.effective_at,
      rate.created_at
    from public.exchange_rates rate
    cross join cutoff
    where rate.is_active = true
      and rate.effective_at <= cutoff.as_of
      and rate.created_at <= cutoff.as_of
  ),
  active_rate_state as (
    select pg_catalog.count(*)::integer as active_rate_count
    from active_rate_candidates
  ),
  rate_at_cutoff as (
    select rate.rate_bs_per_usd, rate.effective_at
    from active_rate_candidates rate
    order by rate.effective_at desc, rate.created_at desc, rate.id desc
    limit 1
  ),
  account_meta as (
    select
      account.id,
      account.name,
      account.currency_code::text as currency_code,
      account.account_kind::text as account_kind,
      account.institution_name,
      account.owner_name,
      account.is_active,
      profile.closure_kind,
      coalesce(profile.baseline_required, false) as baseline_required
    from public.money_accounts account
    left join public.money_account_closure_profiles profile
      on profile.money_account_id = account.id
  ),
  account_anchors as (
    select
      account.*,
      case
        when valid_closure.id is not null then 'closure'
        when valid_baseline.id is not null then 'baseline'
        else 'none'
      end as anchor_kind,
      coalesce(valid_closure.id, valid_baseline.id) as anchor_id,
      coalesce(valid_closure.closure_date, valid_baseline.baseline_date) as anchor_date,
      coalesce(valid_closure.closure_at, valid_baseline.baseline_at) as anchor_at,
      case
        when account.account_kind = 'pos' or account.closure_kind = 'pos' then 0::numeric
        else coalesce(valid_closure.counted_amount, valid_baseline.counted_amount, 0)
      end as anchor_amount,
      case
        when account.account_kind = 'pos' or account.closure_kind = 'pos' then 0::numeric
        else coalesce(valid_closure.counted_amount_usd, valid_baseline.counted_amount_usd, 0)
      end as anchor_amount_usd
    from account_meta account
    cross join cutoff
    left join lateral (
      select
        closure.id,
        closure.closure_date,
        coalesce(closure.closure_at, closure.created_at) as closure_at,
        closure.counted_amount,
        closure.counted_amount_usd
      from public.money_account_closures closure
      where closure.money_account_id = account.id
        and closure.status in ('recorded', 'approved')
        and coalesce(closure.closure_at, closure.created_at) <= cutoff.as_of
      order by
        coalesce(closure.closure_at, closure.created_at) desc,
        closure.created_at desc,
        closure.id desc
      limit 1
    ) valid_closure on true
    left join lateral (
      select
        baseline.id,
        baseline.baseline_date,
        baseline.baseline_at,
        baseline.counted_amount,
        baseline.counted_amount_usd
      from public.money_account_closure_baselines baseline
      where baseline.money_account_id = account.id
        and baseline.status = 'active'
        and baseline.baseline_at <= cutoff.as_of
      order by baseline.baseline_at desc, baseline.id desc
      limit 1
    ) valid_baseline on valid_closure.id is null
  ),
  account_position as (
    select
      account.*,
      latest_closure.id as latest_closure_id,
      latest_closure.closure_date as latest_closure_date,
      latest_closure.closure_at as latest_closure_at,
      latest_closure.status as latest_closure_status,
      latest_closure.difference_amount as latest_closure_difference,
      latest_closure.difference_amount_usd as latest_closure_difference_usd,
      pg_catalog.round(
        account.anchor_amount + coalesce(movement_delta.native_delta, 0),
        2
      ) as balance_native,
      pg_catalog.round(
        account.anchor_amount_usd + coalesce(movement_delta.usd_delta, 0),
        2
      ) as ledger_value_usd,
      coalesce(reconciliation.open_count, 0)::integer as open_reconciliations,
      pg_catalog.round(coalesce(reconciliation.native_amount, 0), 2) as open_reconciliation_native,
      pg_catalog.round(coalesce(reconciliation.usd_amount, 0), 2) as open_reconciliation_usd,
      coalesce(reconciliation.orphaned_count, 0)::integer as orphaned_reconciliations,
      coalesce(pending.pending_operations, 0)::integer as pending_movement_operations,
      pg_catalog.round(coalesce(pending.native_amount, 0), 2) as pending_movement_native,
      pg_catalog.round(coalesce(pending.usd_amount, 0), 2) as pending_movement_usd
    from account_anchors account
    cross join cutoff
    left join lateral (
      select
        closure.id,
        closure.closure_date,
        coalesce(closure.closure_at, closure.created_at) as closure_at,
        closure.status,
        closure.difference_amount,
        closure.difference_amount_usd
      from public.money_account_closures closure
      where closure.money_account_id = account.id
        and coalesce(closure.closure_at, closure.created_at) <= cutoff.as_of
      order by
        coalesce(closure.closure_at, closure.created_at) desc,
        closure.created_at desc,
        closure.id desc
      limit 1
    ) latest_closure on true
    left join lateral (
      select
        coalesce(pg_catalog.sum(case
          when movement.direction = 'inflow' then movement.amount
          when movement.direction = 'outflow' then -movement.amount
          else 0
        end), 0) as native_delta,
        coalesce(pg_catalog.sum(case
          when movement.direction = 'inflow' then movement.amount_usd_equivalent
          when movement.direction = 'outflow' then -movement.amount_usd_equivalent
          else 0
        end), 0) as usd_delta
      from public.money_movements movement
      where movement.money_account_id = account.id
        and movement.status = 'confirmed'
        and movement.movement_date <= cutoff.local_date
        and coalesce(movement.confirmed_at, movement.created_at) <= cutoff.as_of
        and (
          account.anchor_kind = 'none'
          or coalesce(movement.confirmed_at, movement.created_at) > account.anchor_at
        )
        and not (
          (account.account_kind = 'pos' or account.closure_kind = 'pos')
          and movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
          and movement.reference_code ~ '^closure-[0-9]+$'
          and exists (
            select 1
            from public.money_account_closures settled_closure
            where settled_closure.id = substring(
              movement.reference_code from '^closure-([0-9]+)$'
            )::bigint
              and settled_closure.money_account_id = account.id
              and settled_closure.status in ('recorded', 'approved')
              and coalesce(settled_closure.closure_at, settled_closure.created_at) <= cutoff.as_of
          )
        )
    ) movement_delta on true
    left join lateral (
      select
        pg_catalog.count(*)::integer as open_count,
        coalesce(pg_catalog.sum(pg_catalog.abs(item.amount)), 0) as native_amount,
        coalesce(pg_catalog.sum(pg_catalog.abs(item.amount_usd_equivalent)), 0) as usd_amount,
        pg_catalog.count(*) filter (
          where (
            item.source_kind = 'closure'
            and not exists (
              select 1
              from public.money_account_closures source_closure
              where source_closure.id = item.source_id
                and source_closure.money_account_id = account.id
                and source_closure.status in ('recorded', 'approved')
                and coalesce(source_closure.closure_at, source_closure.created_at) <= cutoff.as_of
            )
          ) or (
            item.source_kind = 'baseline'
            and not exists (
              select 1
              from public.money_account_closure_baselines source_baseline
              where source_baseline.id = item.source_id
                and source_baseline.money_account_id = account.id
                and source_baseline.status = 'active'
                and source_baseline.baseline_at <= cutoff.as_of
            )
          )
        )::integer as orphaned_count
      from public.money_account_reconciliation_items item
      where item.money_account_id = account.id
        and item.created_at <= cutoff.as_of
        and (item.resolved_at is null or item.resolved_at > cutoff.as_of)
        and (item.voided_at is null or item.voided_at > cutoff.as_of)
    ) reconciliation on true
    left join lateral (
      select
        pg_catalog.count(distinct coalesce(
          movement.movement_group_id::text,
          'movement:' || movement.id::text
        ))::integer as pending_operations,
        coalesce(pg_catalog.sum(pg_catalog.abs(movement.amount)), 0) as native_amount,
        coalesce(pg_catalog.sum(pg_catalog.abs(movement.amount_usd_equivalent)), 0) as usd_amount
      from public.money_movements movement
      where movement.money_account_id = account.id
        and movement.created_at <= cutoff.as_of
        and (movement.confirmed_at is null or movement.confirmed_at > cutoff.as_of)
        and (movement.rejected_at is null or movement.rejected_at > cutoff.as_of)
        and (movement.voided_at is null or movement.voided_at > cutoff.as_of)
    ) pending on true
  )
  select
    account.id as account_id,
    account.name as account_name,
    account.currency_code,
    account.account_kind,
    account.institution_name,
    account.owner_name,
    account.is_active,
    account.closure_kind,
    account.baseline_required,
    account.balance_native,
    account.ledger_value_usd,
    case
      when account.currency_code = 'USD' then account.balance_native
      when rate_state.active_rate_count = 1 and rate.rate_bs_per_usd > 0 then pg_catalog.round(
        account.balance_native / rate.rate_bs_per_usd,
        2
      )
      else null
    end as current_value_usd,
    account.anchor_kind,
    account.anchor_id,
    account.anchor_date,
    account.anchor_at,
    pg_catalog.round(account.anchor_amount, 2) as anchor_amount,
    account.latest_closure_id,
    account.latest_closure_date,
    account.latest_closure_at,
    account.latest_closure_status,
    account.latest_closure_difference,
    account.latest_closure_difference_usd,
    account.open_reconciliations,
    account.open_reconciliation_native,
    account.open_reconciliation_usd,
    account.orphaned_reconciliations,
    account.pending_movement_operations,
    account.pending_movement_native,
    account.pending_movement_usd,
    case
      when account.currency_code = 'VES' and rate_state.active_rate_count <> 1 then 'Q4_blocked'
      when account.anchor_kind = 'none' then 'Q3_incomplete'
      when account.account_kind = 'pos' or account.closure_kind = 'pos' then 'Q2_derived'
      else 'Q1_exact'
    end as quality,
    rate.rate_bs_per_usd as active_rate_bs_per_usd,
    rate.effective_at as active_rate_effective_at,
    cutoff.as_of as calculated_at
  from account_position account
  cross join cutoff
  cross join active_rate_state rate_state
  left join rate_at_cutoff rate on true;
$function$;

revoke all on function app_private.admin_finance_account_snapshots_v2(timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.admin_finance_account_snapshots_v2(timestamptz)
  is 'Current account positions with canonical timestamp-ordered closure anchors, baseline fallback, strict active-rate valuation, and operational exceptions kept separate from confirmed balance.';

commit;
