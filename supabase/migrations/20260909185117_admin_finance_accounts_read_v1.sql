begin;

create schema if not exists app_private;

create or replace function app_private.admin_finance_account_snapshots_v1(
  p_as_of timestamptz default pg_catalog.now()
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
  with input as (
    select
      coalesce(p_as_of, pg_catalog.now()) as as_of,
      (coalesce(p_as_of, pg_catalog.now()) at time zone 'America/Caracas')::date as local_date
  ),
  active_rate as (
    select rate.rate_bs_per_usd, rate.effective_at
    from public.exchange_rates rate
    cross join input
    where rate.is_active = true
      and rate.effective_at <= input.as_of
      and rate.created_at <= input.as_of
    order by rate.effective_at desc, rate.id desc
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
      end as anchor_amount_usd,
      case
        when valid_closure.id is null then true
        when account.account_kind in ('cash', 'pos') or account.closure_kind in ('cash', 'pos') then false
        else true
      end as uses_daily_cutoff
    from account_meta account
    cross join input
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
        and closure.closure_date <= input.local_date
        and coalesce(closure.closure_at, closure.created_at) <= input.as_of
      order by
        closure.closure_date desc,
        coalesce(closure.closure_at, closure.created_at) desc,
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
        and baseline.baseline_date <= input.local_date
        and baseline.baseline_at <= input.as_of
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
      round(account.anchor_amount + coalesce(movement_delta.native_delta, 0), 2) as balance_native,
      round(account.anchor_amount_usd + coalesce(movement_delta.usd_delta, 0), 2) as ledger_value_usd,
      coalesce(reconciliation.open_count, 0)::integer as open_reconciliations,
      round(coalesce(reconciliation.native_amount, 0), 2) as open_reconciliation_native,
      round(coalesce(reconciliation.usd_amount, 0), 2) as open_reconciliation_usd,
      coalesce(reconciliation.orphaned_count, 0)::integer as orphaned_reconciliations,
      coalesce(pending.pending_operations, 0)::integer as pending_movement_operations,
      round(coalesce(pending.native_amount, 0), 2) as pending_movement_native,
      round(coalesce(pending.usd_amount, 0), 2) as pending_movement_usd
    from account_anchors account
    cross join input
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
        and closure.closure_date <= input.local_date
        and coalesce(closure.closure_at, closure.created_at) <= input.as_of
      order by
        closure.closure_date desc,
        coalesce(closure.closure_at, closure.created_at) desc,
        closure.id desc
      limit 1
    ) latest_closure on true
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
      where movement.money_account_id = account.id
        and movement.status = 'confirmed'
        and movement.movement_date <= input.local_date
        and coalesce(movement.confirmed_at, movement.created_at) <= input.as_of
        and (
          account.anchor_kind = 'none'
          or (
            account.uses_daily_cutoff
            and movement.movement_date > account.anchor_date
          )
          or (
            not account.uses_daily_cutoff
            and (
              movement.movement_date > account.anchor_date
              or (
                movement.movement_date = account.anchor_date
                and coalesce(movement.confirmed_at, movement.created_at) > account.anchor_at
              )
            )
          )
        )
        and not (
          (account.account_kind = 'pos' or account.closure_kind = 'pos')
          and movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
          and movement.reference_code ~ '^closure-[0-9]+$'
          and exists (
            select 1
            from public.money_account_closures settled_closure
            where settled_closure.id = substring(movement.reference_code from '^closure-([0-9]+)$')::bigint
              and settled_closure.money_account_id = account.id
              and settled_closure.status in ('recorded', 'approved')
              and coalesce(settled_closure.closure_at, settled_closure.created_at) <= input.as_of
          )
        )
    ) movement_delta on true
    left join lateral (
      select
        count(*)::integer as open_count,
        coalesce(sum(abs(item.amount)), 0) as native_amount,
        coalesce(sum(abs(item.amount_usd_equivalent)), 0) as usd_amount,
        count(*) filter (
          where (
            item.source_kind = 'closure'
            and not exists (
              select 1
              from public.money_account_closures source_closure
              where source_closure.id = item.source_id
                and source_closure.money_account_id = account.id
                and source_closure.status in ('recorded', 'approved')
                and coalesce(source_closure.closure_at, source_closure.created_at) <= input.as_of
            )
          ) or (
            item.source_kind = 'baseline'
            and not exists (
              select 1
              from public.money_account_closure_baselines source_baseline
              where source_baseline.id = item.source_id
                and source_baseline.money_account_id = account.id
                and source_baseline.status = 'active'
                and source_baseline.baseline_at <= input.as_of
            )
          )
        )::integer as orphaned_count
      from public.money_account_reconciliation_items item
      where item.money_account_id = account.id
        and item.created_at <= input.as_of
        and (item.resolved_at is null or item.resolved_at > input.as_of)
        and (item.voided_at is null or item.voided_at > input.as_of)
    ) reconciliation on true
    left join lateral (
      select
        count(distinct coalesce(
          movement.movement_group_id::text,
          'movement:' || movement.id::text
        ))::integer as pending_operations,
        coalesce(sum(abs(movement.amount)), 0) as native_amount,
        coalesce(sum(abs(movement.amount_usd_equivalent)), 0) as usd_amount
      from public.money_movements movement
      where movement.money_account_id = account.id
        and movement.created_at <= input.as_of
        and (movement.confirmed_at is null or movement.confirmed_at > input.as_of)
        and (movement.rejected_at is null or movement.rejected_at > input.as_of)
        and (movement.voided_at is null or movement.voided_at > input.as_of)
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
      when active_rate.rate_bs_per_usd > 0 then round(account.balance_native / active_rate.rate_bs_per_usd, 2)
      else null
    end as current_value_usd,
    account.anchor_kind,
    account.anchor_id,
    account.anchor_date,
    account.anchor_at,
    round(account.anchor_amount, 2) as anchor_amount,
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
      when account.currency_code = 'VES' and active_rate.rate_bs_per_usd is null then 'Q4_blocked'
      when account.anchor_kind = 'none' then 'Q3_incomplete'
      when account.account_kind = 'pos' or account.closure_kind = 'pos' then 'Q2_derived'
      else 'Q1_exact'
    end as quality,
    active_rate.rate_bs_per_usd as active_rate_bs_per_usd,
    active_rate.effective_at as active_rate_effective_at,
    input.as_of as calculated_at
  from account_position account
  cross join input
  left join active_rate on true;
$function$;

revoke all on function app_private.admin_finance_account_snapshots_v1(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.admin_finance_accounts_overview_v1(
  p_include_inactive boolean default false,
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

  if v_as_of < pg_catalog.now() - interval '15 minutes'
    or v_as_of > pg_catalog.now() + interval '1 minute' then
    raise exception 'El corte de cuentas debe representar la posicion actual.'
      using errcode = '22023';
  end if;

  with snapshots as (
    select *
    from app_private.admin_finance_account_snapshots_v1(v_as_of)
  ),
  visible as (
    select *
    from snapshots
    where p_include_inactive or is_active
  ),
  summary as (
    select
      count(*) filter (where is_active)::integer as active_accounts,
      count(*) filter (where not is_active)::integer as inactive_accounts,
      count(*) filter (where is_active and anchor_kind <> 'none')::integer as anchored_accounts,
      count(*) filter (
        where is_active
          and (
            anchor_kind = 'none'
            or open_reconciliations > 0
            or pending_movement_operations > 0
            or orphaned_reconciliations > 0
          )
      )::integer as attention_accounts,
      round(coalesce(sum(balance_native) filter (where is_active and currency_code = 'USD'), 0), 2) as native_usd_total,
      round(coalesce(sum(balance_native) filter (where is_active and currency_code = 'VES'), 0), 2) as native_ves_total,
      coalesce(sum(open_reconciliations) filter (where is_active), 0)::integer as open_reconciliations
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
      and movement.created_at <= v_as_of
      and (movement.confirmed_at is null or movement.confirmed_at > v_as_of)
      and (movement.rejected_at is null or movement.rejected_at > v_as_of)
      and (movement.voided_at is null or movement.voided_at > v_as_of)
  )
  select pg_catalog.jsonb_build_object(
    'definitionVersion', 'admin-finance-accounts-v1',
    'asOf', v_as_of,
    'activeRateBsPerUsd', (select max(active_rate_bs_per_usd) from visible),
    'activeRateEffectiveAt', (select max(active_rate_effective_at) from visible),
    'summary', pg_catalog.jsonb_build_object(
      'activeAccounts', summary.active_accounts,
      'inactiveAccounts', summary.inactive_accounts,
      'anchoredAccounts', summary.anchored_accounts,
      'attentionAccounts', summary.attention_accounts,
      'nativeUsdTotal', summary.native_usd_total,
      'nativeVesTotal', summary.native_ves_total,
      'openReconciliations', summary.open_reconciliations,
      'pendingMovementOperations', pending_global.pending_movement_operations
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
  cross join pending_global;

  return v_result;
end;
$function$;

revoke all on function public.admin_finance_accounts_overview_v1(boolean, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_accounts_overview_v1(boolean, timestamptz)
  to authenticated;

create or replace function public.admin_finance_account_detail_v1(
  p_account_id bigint,
  p_section text default 'movements',
  p_from_date date default null,
  p_to_date date default null,
  p_status text default 'all',
  p_limit integer default 40,
  p_offset integer default 0,
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
  v_local_date date := (coalesce(p_as_of, pg_catalog.now()) at time zone 'America/Caracas')::date;
  v_from_date date;
  v_to_date date;
  v_section text := coalesce(nullif(pg_catalog.btrim(p_section), ''), 'movements');
  v_status text := coalesce(nullif(pg_catalog.btrim(p_status), ''), 'all');
  v_limit integer := greatest(1, least(coalesce(p_limit, 40), 100));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 10000));
  v_account record;
  v_rows jsonb := '[]'::jsonb;
  v_total_rows integer := 0;
  v_inflow numeric := 0;
  v_outflow numeric := 0;
  v_pending numeric := 0;
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

  if v_as_of < pg_catalog.now() - interval '15 minutes'
    or v_as_of > pg_catalog.now() + interval '1 minute' then
    raise exception 'El corte de cuentas debe representar la posicion actual.'
      using errcode = '22023';
  end if;

  if v_section not in ('movements', 'closures', 'reconciliation', 'configuration') then
    raise exception 'Seccion financiera no valida.' using errcode = '22023';
  end if;

  if v_status not in (
    'all', 'pending', 'confirmed', 'rejected', 'voided',
    'recorded', 'approved', 'open', 'resolved'
  ) then
    raise exception 'Estado financiero no valido.' using errcode = '22023';
  end if;

  v_from_date := coalesce(p_from_date, v_local_date - 30);
  v_to_date := least(coalesce(p_to_date, v_local_date), v_local_date);
  if v_from_date > v_to_date then
    raise exception 'El rango de fechas no es valido.' using errcode = '22023';
  end if;

  select *
  into v_account
  from app_private.admin_finance_account_snapshots_v1(v_as_of) snapshot
  where snapshot.account_id = p_account_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'definitionVersion', 'admin-finance-accounts-v1',
      'asOf', v_as_of,
      'found', false
    );
  end if;

  select
    round(coalesce(sum(movement.amount) filter (
      where movement.status = 'confirmed' and movement.direction = 'inflow'
    ), 0), 2),
    round(coalesce(sum(movement.amount) filter (
      where movement.status = 'confirmed' and movement.direction = 'outflow'
    ), 0), 2),
    round(coalesce(sum(abs(movement.amount)) filter (
      where movement.status = 'pending'
    ), 0), 2)
  into v_inflow, v_outflow, v_pending
  from public.money_movements movement
  where movement.money_account_id = p_account_id
    and movement.created_at <= v_as_of
    and movement.movement_date between v_from_date and v_to_date;

  if v_section = 'movements' then
    select count(*)::integer
    into v_total_rows
    from public.money_movements movement
    where movement.money_account_id = p_account_id
      and movement.created_at <= v_as_of
      and movement.movement_date between v_from_date and v_to_date
      and (v_status = 'all' or movement.status::text = v_status);

    select coalesce(pg_catalog.jsonb_agg(row_payload order by movement_date desc, recorded_at desc, row_id desc), '[]'::jsonb)
    into v_rows
    from (
      select
        movement.id as row_id,
        movement.movement_date,
        coalesce(movement.confirmed_at, movement.created_at) as recorded_at,
        pg_catalog.jsonb_build_object(
          'kind', 'movement',
          'id', movement.id,
          'movementDate', movement.movement_date,
          'createdAt', movement.created_at,
          'direction', movement.direction,
          'movementType', movement.movement_type,
          'currencyCode', movement.currency_code,
          'amount', movement.amount,
          'amountUsdEquivalent', movement.amount_usd_equivalent,
          'exchangeRateVesPerUsd', movement.exchange_rate_ves_per_usd,
          'referenceCode', movement.reference_code,
          'counterpartyName', movement.counterparty_name,
          'description', movement.description,
          'orderId', movement.order_id,
          'status', movement.status,
          'approvalRequired', movement.approval_required
        ) as row_payload
      from public.money_movements movement
      where movement.money_account_id = p_account_id
        and movement.created_at <= v_as_of
        and movement.movement_date between v_from_date and v_to_date
        and (v_status = 'all' or movement.status::text = v_status)
      order by movement.movement_date desc, coalesce(movement.confirmed_at, movement.created_at) desc, movement.id desc
      limit v_limit offset v_offset
    ) page_rows;
  elsif v_section = 'closures' then
    select count(*)::integer
    into v_total_rows
    from public.money_account_closures closure
    where closure.money_account_id = p_account_id
      and coalesce(closure.closure_at, closure.created_at) <= v_as_of
      and closure.closure_date between v_from_date and v_to_date
      and (v_status = 'all' or closure.status = v_status);

    select coalesce(pg_catalog.jsonb_agg(row_payload order by closure_at desc, row_id desc), '[]'::jsonb)
    into v_rows
    from (
      select
        closure.id as row_id,
        coalesce(closure.closure_at, closure.created_at) as closure_at,
        pg_catalog.jsonb_build_object(
          'kind', 'closure',
          'id', closure.id,
          'closureDate', closure.closure_date,
          'closureAt', coalesce(closure.closure_at, closure.created_at),
          'currencyCode', closure.currency_code,
          'expectedAmount', closure.expected_amount,
          'countedAmount', closure.counted_amount,
          'differenceAmount', closure.difference_amount,
          'expectedAmountUsd', closure.expected_amount_usd,
          'countedAmountUsd', closure.counted_amount_usd,
          'differenceAmountUsd', closure.difference_amount_usd,
          'exchangeRateVesPerUsd', closure.exchange_rate_ves_per_usd,
          'status', closure.status,
          'reason', closure.reason
        ) as row_payload
      from public.money_account_closures closure
      where closure.money_account_id = p_account_id
        and coalesce(closure.closure_at, closure.created_at) <= v_as_of
        and closure.closure_date between v_from_date and v_to_date
        and (v_status = 'all' or closure.status = v_status)
      order by coalesce(closure.closure_at, closure.created_at) desc, closure.id desc
      limit v_limit offset v_offset
    ) page_rows;
  elsif v_section = 'reconciliation' then
    select count(*)::integer
    into v_total_rows
    from public.money_account_reconciliation_items item
    where item.money_account_id = p_account_id
      and item.created_at <= v_as_of
      and coalesce(item.operation_date, (item.created_at at time zone 'America/Caracas')::date)
        between v_from_date and v_to_date
      and (v_status = 'all' or item.status = v_status);

    select coalesce(pg_catalog.jsonb_agg(row_payload order by open_first, created_at desc, row_id desc), '[]'::jsonb)
    into v_rows
    from (
      select
        item.id as row_id,
        case when item.status = 'open' then 0 else 1 end as open_first,
        item.created_at,
        pg_catalog.jsonb_build_object(
          'kind', 'reconciliation',
          'id', item.id,
          'operationDate', item.operation_date,
          'createdAt', item.created_at,
          'sourceKind', item.source_kind,
          'sourceId', item.source_id,
          'itemType', item.item_type,
          'direction', item.direction,
          'currencyCode', item.currency_code,
          'amount', item.amount,
          'amountUsdEquivalent', item.amount_usd_equivalent,
          'referenceCode', item.reference_code,
          'counterpartyName', item.counterparty_name,
          'description', item.description,
          'status', item.status,
          'orphanedSource', case
            when item.source_kind = 'closure' then not exists (
              select 1
              from public.money_account_closures source_closure
              where source_closure.id = item.source_id
                and source_closure.money_account_id = item.money_account_id
                and source_closure.status in ('recorded', 'approved')
            )
            when item.source_kind = 'baseline' then not exists (
              select 1
              from public.money_account_closure_baselines source_baseline
              where source_baseline.id = item.source_id
                and source_baseline.money_account_id = item.money_account_id
                and source_baseline.status = 'active'
            )
            else false
          end
        ) as row_payload
      from public.money_account_reconciliation_items item
      where item.money_account_id = p_account_id
        and item.created_at <= v_as_of
        and coalesce(item.operation_date, (item.created_at at time zone 'America/Caracas')::date)
          between v_from_date and v_to_date
        and (v_status = 'all' or item.status = v_status)
      order by case when item.status = 'open' then 0 else 1 end, item.created_at desc, item.id desc
      limit v_limit offset v_offset
    ) page_rows;
  end if;

  return pg_catalog.jsonb_build_object(
    'definitionVersion', 'admin-finance-accounts-v1',
    'asOf', v_as_of,
    'found', true,
    'account', pg_catalog.jsonb_build_object(
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
    'section', v_section,
    'fromDate', v_from_date,
    'toDate', v_to_date,
    'status', v_status,
    'page', (v_offset / v_limit) + 1,
    'pageSize', v_limit,
    'totalRows', v_total_rows,
    'period', pg_catalog.jsonb_build_object(
      'inflowNative', v_inflow,
      'outflowNative', v_outflow,
      'netNative', round(v_inflow - v_outflow, 2),
      'pendingNative', v_pending
    ),
    'rows', v_rows
  );
end;
$function$;

revoke all on function public.admin_finance_account_detail_v1(bigint, text, date, date, text, integer, integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_account_detail_v1(bigint, text, date, date, text, integer, integer, timestamptz)
  to authenticated;

comment on function public.admin_finance_accounts_overview_v1(boolean, timestamptz)
is 'Admin-only current account positions. Returns native totals separately and never publishes an uncertified global treasury total.';

comment on function public.admin_finance_account_detail_v1(bigint, text, date, date, text, integer, integer, timestamptz)
is 'Admin-only paginated read model for one financial account. Pending movements and reconciliation items never affect the account balance.';

commit;
