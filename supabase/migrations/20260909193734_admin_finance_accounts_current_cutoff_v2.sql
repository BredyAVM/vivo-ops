begin;

-- The original v1 read model accepted a caller-provided cutoff even though the
-- underlying operational tables only retain their current status plus a small
-- set of transition timestamps. Preserve those implementations as private
-- compatibility helpers, then expose a strictly-current statement snapshot.

alter function app_private.admin_finance_account_snapshots_v1(timestamptz)
  rename to admin_finance_account_snapshots_legacy_v1;

alter function public.admin_finance_accounts_overview_v1(boolean, timestamptz)
  set schema app_private;
alter function app_private.admin_finance_accounts_overview_v1(boolean, timestamptz)
  rename to admin_finance_accounts_overview_legacy_v1;

alter function public.admin_finance_account_detail_v1(bigint, text, date, date, text, integer, integer, timestamptz)
  set schema app_private;
alter function app_private.admin_finance_account_detail_v1(bigint, text, date, date, text, integer, integer, timestamptz)
  rename to admin_finance_account_detail_legacy_v1;

revoke all on function app_private.admin_finance_account_snapshots_legacy_v1(timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function app_private.admin_finance_accounts_overview_legacy_v1(boolean, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function app_private.admin_finance_account_detail_legacy_v1(bigint, text, date, date, text, integer, integer, timestamptz)
  from public, anon, authenticated, service_role;

-- Keep the existing result type and RPC contract. Recalculate every position
-- with the canonical Counter rule: after an anchor, include every confirmed
-- movement whose confirmation timestamp is later than anchor_at, including
-- movements on the anchor's calendar day. At this strictly-current cutoff,
-- valuation requires exactly one active rate; it never falls back silently.
create function app_private.admin_finance_account_snapshots_v2(
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
    select count(*)::integer as active_rate_count
    from active_rate_candidates
  ),
  rate_at_cutoff as (
    select rate.rate_bs_per_usd, rate.effective_at
    from active_rate_candidates rate
    order by rate.effective_at desc, rate.created_at desc, rate.id desc
    limit 1
  ),
  legacy_snapshot as (
    select snapshot.*
    from cutoff
    cross join lateral app_private.admin_finance_account_snapshots_legacy_v1(cutoff.as_of) snapshot
  ),
  recalculated as (
    select
      snapshot.*,
      pg_catalog.round(
        snapshot.anchor_amount + coalesce(movement_delta.native_delta, 0),
        2
      ) as recalculated_balance_native,
      pg_catalog.round(
        case
          when snapshot.account_kind = 'pos' or snapshot.closure_kind = 'pos' then 0
          when snapshot.anchor_kind = 'closure' then coalesce(anchor_closure.counted_amount_usd, 0)
          when snapshot.anchor_kind = 'baseline' then coalesce(anchor_baseline.counted_amount_usd, 0)
          else 0
        end + coalesce(movement_delta.usd_delta, 0),
        2
      ) as recalculated_ledger_value_usd
    from legacy_snapshot snapshot
    cross join cutoff
    left join public.money_account_closures anchor_closure
      on snapshot.anchor_kind = 'closure'
      and anchor_closure.id = snapshot.anchor_id
      and anchor_closure.money_account_id = snapshot.account_id
    left join public.money_account_closure_baselines anchor_baseline
      on snapshot.anchor_kind = 'baseline'
      and anchor_baseline.id = snapshot.anchor_id
      and anchor_baseline.money_account_id = snapshot.account_id
    left join lateral (
      select
        coalesce(sum(case
          when movement.direction = 'inflow' then movement.amount
          when movement.direction = 'outflow' then -movement.amount
          else 0
        end), 0) as native_delta,
        coalesce(sum(case
          when movement.direction = 'inflow' then movement.amount_usd_equivalent
          when movement.direction = 'outflow' then -movement.amount_usd_equivalent
          else 0
        end), 0) as usd_delta
      from public.money_movements movement
      where movement.money_account_id = snapshot.account_id
        and movement.status = 'confirmed'
        and movement.movement_date <= cutoff.local_date
        and coalesce(movement.confirmed_at, movement.created_at) <= cutoff.as_of
        and (
          snapshot.anchor_kind = 'none'
          or coalesce(movement.confirmed_at, movement.created_at) > snapshot.anchor_at
        )
        and not (
          (snapshot.account_kind = 'pos' or snapshot.closure_kind = 'pos')
          and movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
          and movement.reference_code ~ '^closure-[0-9]+$'
          and exists (
            select 1
            from public.money_account_closures settled_closure
            where settled_closure.id = substring(
              movement.reference_code from '^closure-([0-9]+)$'
            )::bigint
              and settled_closure.money_account_id = snapshot.account_id
              and settled_closure.status in ('recorded', 'approved')
              and settled_closure.created_at <= cutoff.as_of
              and settled_closure.closure_at <= cutoff.as_of
          )
        )
    ) movement_delta on true
  )
  select
    snapshot.account_id,
    snapshot.account_name,
    snapshot.currency_code,
    snapshot.account_kind,
    snapshot.institution_name,
    snapshot.owner_name,
    snapshot.is_active,
    snapshot.closure_kind,
    snapshot.baseline_required,
    snapshot.recalculated_balance_native,
    snapshot.recalculated_ledger_value_usd,
    case
      when snapshot.currency_code = 'USD' then snapshot.recalculated_balance_native
      when rate_state.active_rate_count = 1 and rate.rate_bs_per_usd > 0 then pg_catalog.round(
        snapshot.recalculated_balance_native / rate.rate_bs_per_usd,
        2
      )
      else null
    end as current_value_usd,
    snapshot.anchor_kind,
    snapshot.anchor_id,
    snapshot.anchor_date,
    snapshot.anchor_at,
    snapshot.anchor_amount,
    snapshot.latest_closure_id,
    snapshot.latest_closure_date,
    snapshot.latest_closure_at,
    snapshot.latest_closure_status,
    snapshot.latest_closure_difference,
    snapshot.latest_closure_difference_usd,
    snapshot.open_reconciliations,
    snapshot.open_reconciliation_native,
    snapshot.open_reconciliation_usd,
    snapshot.orphaned_reconciliations,
    snapshot.pending_movement_operations,
    snapshot.pending_movement_native,
    snapshot.pending_movement_usd,
    case
      when snapshot.currency_code = 'VES' and rate_state.active_rate_count <> 1 then 'Q4_blocked'
      when snapshot.anchor_kind = 'none' then 'Q3_incomplete'
      when snapshot.account_kind = 'pos' or snapshot.closure_kind = 'pos' then 'Q2_derived'
      else 'Q1_exact'
    end as quality,
    rate.rate_bs_per_usd as active_rate_bs_per_usd,
    rate.effective_at as active_rate_effective_at,
    cutoff.as_of as calculated_at
  from recalculated snapshot
  cross join cutoff
  cross join active_rate_state rate_state
  left join rate_at_cutoff rate on true;
$function$;

revoke all on function app_private.admin_finance_account_snapshots_v2(timestamptz)
  from public, anon, authenticated, service_role;

-- The private legacy detail function resolves this name internally. Keep a
-- private-only alias so its pagination code uses the corrected v2 position.
create function app_private.admin_finance_account_snapshots_v1(
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
  select *
  from app_private.admin_finance_account_snapshots_v2(
    coalesce(p_as_of, pg_catalog.statement_timestamp())
  );
$function$;

revoke all on function app_private.admin_finance_account_snapshots_v1(timestamptz)
  from public, anon, authenticated, service_role;

create function public.admin_finance_accounts_overview_v2(
  p_include_inactive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_as_of timestamptz := pg_catalog.statement_timestamp();
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesion para consultar las cuentas financieras.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_uid
      and role_row.role = 'admin'
  ) then
    raise exception 'Solo Administracion puede consultar las cuentas financieras.'
      using errcode = '42501';
  end if;

  with snapshots as (
    select *
    from app_private.admin_finance_account_snapshots_v2(v_as_of)
  ),
  visible as (
    select *
    from snapshots
    where coalesce(p_include_inactive, false) or is_active
  ),
  summary as (
    select
      count(*) filter (where is_active)::integer as active_accounts,
      count(*) filter (where not is_active)::integer as inactive_accounts,
      count(*) filter (where is_active and anchor_kind <> 'none')::integer
        as anchored_accounts,
      count(*) filter (
        where is_active
          and (
            anchor_kind = 'none'
            or open_reconciliations > 0
            or pending_movement_operations > 0
            or orphaned_reconciliations > 0
          )
      )::integer as attention_accounts,
      pg_catalog.round(coalesce(sum(balance_native) filter (
        where is_active and currency_code = 'USD'
      ), 0), 2) as native_usd_total,
      pg_catalog.round(coalesce(sum(balance_native) filter (
        where is_active and currency_code = 'VES'
      ), 0), 2) as native_ves_total,
      coalesce(sum(open_reconciliations) filter (where is_active), 0)::integer
        as open_reconciliations,
      count(*) filter (where is_active and currency_code = 'USD')::integer
        as native_usd_total_accounts,
      count(*) filter (
        where is_active and currency_code = 'USD' and anchor_kind <> 'none'
      )::integer as native_usd_covered_accounts,
      pg_catalog.round(coalesce(sum(balance_native) filter (
        where is_active and currency_code = 'USD' and anchor_kind <> 'none'
      ), 0), 2) as native_usd_covered_total,
      pg_catalog.round(coalesce(sum(balance_native) filter (
        where is_active and currency_code = 'USD' and anchor_kind = 'none'
      ), 0), 2) as native_usd_uncovered_total,
      count(*) filter (
        where is_active and currency_code = 'USD' and quality = 'Q1_exact'
      )::integer as native_usd_q1_accounts,
      count(*) filter (
        where is_active and currency_code = 'USD' and quality = 'Q2_derived'
      )::integer as native_usd_q2_accounts,
      count(*) filter (
        where is_active and currency_code = 'USD' and quality = 'Q3_incomplete'
      )::integer as native_usd_q3_accounts,
      count(*) filter (
        where is_active and currency_code = 'USD' and quality = 'Q4_blocked'
      )::integer as native_usd_q4_accounts,
      count(*) filter (where is_active and currency_code = 'VES')::integer
        as native_ves_total_accounts,
      count(*) filter (
        where is_active and currency_code = 'VES' and anchor_kind <> 'none'
      )::integer as native_ves_covered_accounts,
      pg_catalog.round(coalesce(sum(balance_native) filter (
        where is_active and currency_code = 'VES' and anchor_kind <> 'none'
      ), 0), 2) as native_ves_covered_total,
      pg_catalog.round(coalesce(sum(balance_native) filter (
        where is_active and currency_code = 'VES' and anchor_kind = 'none'
      ), 0), 2) as native_ves_uncovered_total,
      count(*) filter (
        where is_active and currency_code = 'VES' and quality = 'Q1_exact'
      )::integer as native_ves_q1_accounts,
      count(*) filter (
        where is_active and currency_code = 'VES' and quality = 'Q2_derived'
      )::integer as native_ves_q2_accounts,
      count(*) filter (
        where is_active and currency_code = 'VES' and quality = 'Q3_incomplete'
      )::integer as native_ves_q3_accounts,
      count(*) filter (
        where is_active and currency_code = 'VES' and quality = 'Q4_blocked'
      )::integer as native_ves_q4_accounts
    from visible
  ),
  pending_global as (
    select count(distinct coalesce(
      movement.movement_group_id::text,
      'movement:' || movement.id::text
    ))::integer as pending_movement_operations
    from public.money_movements movement
    join public.money_accounts account on account.id = movement.money_account_id
    where account.is_active
      and movement.status = 'pending'
      and movement.created_at <= v_as_of
  ),
  active_rate as (
    select
      count(*)::integer as active_rate_count,
      (pg_catalog.array_agg(
        rate.rate_bs_per_usd
        order by rate.effective_at desc, rate.created_at desc, rate.id desc
      ))[1] as rate_bs_per_usd,
      (pg_catalog.array_agg(
        rate.effective_at
        order by rate.effective_at desc, rate.created_at desc, rate.id desc
      ))[1] as effective_at
    from public.exchange_rates rate
    where rate.is_active = true
      and rate.effective_at <= v_as_of
      and rate.created_at <= v_as_of
  )
  select pg_catalog.jsonb_build_object(
    'definitionVersion', 'admin-finance-accounts-v2',
    'asOf', v_as_of,
    'cutoffMode', 'current_statement',
    'rateBasis', 'single_active_at_current_statement',
    'activeRateCount', active_rate.active_rate_count,
    'rateQuality', case
      when active_rate.active_rate_count = 1 then 'Q1_exact'
      else 'Q4_blocked'
    end,
    'activeRateBsPerUsd', case
      when active_rate.active_rate_count = 1 then active_rate.rate_bs_per_usd
      else null
    end,
    'activeRateEffectiveAt', case
      when active_rate.active_rate_count = 1 then active_rate.effective_at
      else null
    end,
    'summary', pg_catalog.jsonb_build_object(
      'activeAccounts', summary.active_accounts,
      'inactiveAccounts', summary.inactive_accounts,
      'anchoredAccounts', summary.anchored_accounts,
      'attentionAccounts', summary.attention_accounts,
      'nativeUsdTotal', summary.native_usd_total,
      'nativeVesTotal', summary.native_ves_total,
      'openReconciliations', summary.open_reconciliations,
      'pendingMovementOperations', pending_global.pending_movement_operations,
      'nativeUsdCoveredTotal', summary.native_usd_covered_total,
      'nativeUsdUncoveredTotal', summary.native_usd_uncovered_total,
      'nativeUsdCoveredAccounts', summary.native_usd_covered_accounts,
      'nativeUsdTotalAccounts', summary.native_usd_total_accounts,
      'nativeUsdCoveragePct', case
        when summary.native_usd_total_accounts = 0 then null
        else pg_catalog.round(
          100.0 * summary.native_usd_covered_accounts / summary.native_usd_total_accounts,
          1
        )
      end,
      'nativeUsdQuality', case
        when summary.native_usd_q4_accounts > 0 then 'Q4_blocked'
        when summary.native_usd_q3_accounts > 0 then 'Q3_incomplete'
        when summary.native_usd_q2_accounts > 0 then 'Q2_derived'
        else 'Q1_exact'
      end,
      'nativeUsdQ1Accounts', summary.native_usd_q1_accounts,
      'nativeUsdQ2Accounts', summary.native_usd_q2_accounts,
      'nativeUsdQ3Accounts', summary.native_usd_q3_accounts,
      'nativeUsdQ4Accounts', summary.native_usd_q4_accounts,
      'nativeVesCoveredTotal', summary.native_ves_covered_total,
      'nativeVesUncoveredTotal', summary.native_ves_uncovered_total,
      'nativeVesCoveredAccounts', summary.native_ves_covered_accounts,
      'nativeVesTotalAccounts', summary.native_ves_total_accounts,
      'nativeVesCoveragePct', case
        when summary.native_ves_total_accounts = 0 then null
        else pg_catalog.round(
          100.0 * summary.native_ves_covered_accounts / summary.native_ves_total_accounts,
          1
        )
      end,
      'nativeVesQuality', case
        when summary.native_ves_q4_accounts > 0 then 'Q4_blocked'
        when summary.native_ves_q3_accounts > 0 then 'Q3_incomplete'
        when summary.native_ves_q2_accounts > 0 then 'Q2_derived'
        else 'Q1_exact'
      end,
      'nativeVesQ1Accounts', summary.native_ves_q1_accounts,
      'nativeVesQ2Accounts', summary.native_ves_q2_accounts,
      'nativeVesQ3Accounts', summary.native_ves_q3_accounts,
      'nativeVesQ4Accounts', summary.native_ves_q4_accounts,
      'nativeTotalsQuality', case
        when summary.native_usd_q4_accounts + summary.native_ves_q4_accounts > 0 then 'Q4_blocked'
        when summary.native_usd_q3_accounts + summary.native_ves_q3_accounts > 0 then 'Q3_incomplete'
        when summary.native_usd_q2_accounts + summary.native_ves_q2_accounts > 0 then 'Q2_derived'
        else 'Q1_exact'
      end
    ),
    'accounts', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', snapshot.account_id,
          'name', snapshot.account_name,
          'currencyCode', snapshot.currency_code,
          'accountKind', snapshot.account_kind,
          'institutionName', snapshot.institution_name,
          'ownerName', snapshot.owner_name,
          'isActive', snapshot.is_active,
          'closureKind', snapshot.closure_kind,
          'baselineRequired', snapshot.baseline_required,
          'balanceNative', snapshot.balance_native,
          'ledgerValueUsd', snapshot.ledger_value_usd,
          'currentValueUsd', snapshot.current_value_usd,
          'anchorKind', snapshot.anchor_kind,
          'anchorDate', snapshot.anchor_date,
          'anchorAt', snapshot.anchor_at,
          'anchorAmount', snapshot.anchor_amount,
          'latestClosureId', snapshot.latest_closure_id,
          'latestClosureDate', snapshot.latest_closure_date,
          'latestClosureAt', snapshot.latest_closure_at,
          'latestClosureStatus', snapshot.latest_closure_status,
          'latestClosureDifference', snapshot.latest_closure_difference,
          'latestClosureDifferenceUsd', snapshot.latest_closure_difference_usd,
          'openReconciliations', snapshot.open_reconciliations,
          'openReconciliationNative', snapshot.open_reconciliation_native,
          'openReconciliationUsd', snapshot.open_reconciliation_usd,
          'orphanedReconciliations', snapshot.orphaned_reconciliations,
          'pendingMovementOperations', snapshot.pending_movement_operations,
          'pendingMovementNative', snapshot.pending_movement_native,
          'pendingMovementUsd', snapshot.pending_movement_usd,
          'quality', snapshot.quality
        )
        order by snapshot.is_active desc, snapshot.account_name, snapshot.account_id
      )
      from visible snapshot
    ), '[]'::jsonb)
  )
  into v_result
  from summary
  cross join pending_global
  cross join active_rate;

  return v_result;
end;
$function$;

revoke all on function public.admin_finance_accounts_overview_v2(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_accounts_overview_v2(boolean)
  to authenticated;

create function public.admin_finance_account_detail_v2(
  p_account_id bigint,
  p_section text default 'movements',
  p_from_date date default null,
  p_to_date date default null,
  p_status text default 'all',
  p_limit integer default 40,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_as_of timestamptz := pg_catalog.statement_timestamp();
  v_section text := coalesce(nullif(pg_catalog.btrim(p_section), ''), 'movements');
  v_status text := coalesce(nullif(pg_catalog.btrim(p_status), ''), 'all');
  v_result jsonb;
  v_account record;
  v_active_rate_count integer := 0;
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesion para consultar una cuenta financiera.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_uid
      and role_row.role = 'admin'
  ) then
    raise exception 'Solo Administracion puede consultar una cuenta financiera.'
      using errcode = '42501';
  end if;

  if v_section not in ('movements', 'closures', 'reconciliation', 'configuration') then
    raise exception 'Seccion financiera no valida.' using errcode = '22023';
  end if;

  if (
    v_section = 'movements'
    and v_status not in ('all', 'pending', 'confirmed', 'rejected', 'voided')
  ) or (
    v_section = 'closures'
    and v_status not in ('all', 'recorded', 'approved', 'rejected')
  ) or (
    v_section = 'reconciliation'
    and v_status not in ('all', 'open', 'resolved', 'voided')
  ) or (
    v_section = 'configuration'
    and v_status <> 'all'
  ) then
    raise exception 'Estado financiero no valido para la seccion.' using errcode = '22023';
  end if;

  -- Reuse only the legacy pagination projection. Its private snapshot alias now
  -- resolves to v2, and the account payload is explicitly replaced below.
  v_result := app_private.admin_finance_account_detail_legacy_v1(
    p_account_id,
    v_section,
    p_from_date,
    p_to_date,
    v_status,
    p_limit,
    p_offset,
    v_as_of
  );

  select *
  into v_account
  from app_private.admin_finance_account_snapshots_v2(v_as_of) snapshot
  where snapshot.account_id = p_account_id;

  if found then
    v_result := pg_catalog.jsonb_set(
      v_result,
      '{account}',
      pg_catalog.jsonb_build_object(
        'id', v_account.account_id,
        'name', v_account.account_name,
        'currencyCode', v_account.currency_code,
        'accountKind', v_account.account_kind,
        'institutionName', v_account.institution_name,
        'ownerName', v_account.owner_name,
        'isActive', v_account.is_active,
        'closureKind', v_account.closure_kind,
        'baselineRequired', v_account.baseline_required,
        'balanceNative', v_account.balance_native,
        'ledgerValueUsd', v_account.ledger_value_usd,
        'currentValueUsd', v_account.current_value_usd,
        'anchorKind', v_account.anchor_kind,
        'anchorDate', v_account.anchor_date,
        'anchorAt', v_account.anchor_at,
        'anchorAmount', v_account.anchor_amount,
        'latestClosureId', v_account.latest_closure_id,
        'latestClosureDate', v_account.latest_closure_date,
        'latestClosureAt', v_account.latest_closure_at,
        'latestClosureStatus', v_account.latest_closure_status,
        'latestClosureDifference', v_account.latest_closure_difference,
        'latestClosureDifferenceUsd', v_account.latest_closure_difference_usd,
        'openReconciliations', v_account.open_reconciliations,
        'openReconciliationNative', v_account.open_reconciliation_native,
        'openReconciliationUsd', v_account.open_reconciliation_usd,
        'orphanedReconciliations', v_account.orphaned_reconciliations,
        'pendingMovementOperations', v_account.pending_movement_operations,
        'pendingMovementNative', v_account.pending_movement_native,
        'pendingMovementUsd', v_account.pending_movement_usd,
        'quality', v_account.quality
      ),
      true
    );
  end if;

  select count(*)::integer
  into v_active_rate_count
  from public.exchange_rates rate
  where rate.is_active = true
    and rate.effective_at <= v_as_of
    and rate.created_at <= v_as_of;

  return v_result || pg_catalog.jsonb_build_object(
    'definitionVersion', 'admin-finance-accounts-v2',
    'asOf', v_as_of,
    'cutoffMode', 'current_statement',
    'rateBasis', 'single_active_at_current_statement',
    'activeRateCount', v_active_rate_count,
    'rateQuality', case
      when v_active_rate_count = 1 then 'Q1_exact'
      else 'Q4_blocked'
    end
  );
end;
$function$;

revoke all on function public.admin_finance_account_detail_v2(bigint, text, date, date, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_account_detail_v2(bigint, text, date, date, text, integer, integer)
  to authenticated;

comment on function app_private.admin_finance_account_snapshots_v2(timestamptz)
is 'Private current account snapshot. Uses the canonical timestamp-after-anchor balance rule and requires exactly one active exchange rate for VES valuation.';

comment on function public.admin_finance_accounts_overview_v2(boolean)
is 'Admin-only current account positions at statement_timestamp(). Native totals remain operational totals and include explicit anchored coverage, quality counts, and active-rate quality.';

comment on function public.admin_finance_account_detail_v2(bigint, text, date, date, text, integer, integer)
is 'Admin-only current, paginated account detail at statement_timestamp(). Current statuses and transition timestamps are never combined into a synthetic historical state.';

commit;
