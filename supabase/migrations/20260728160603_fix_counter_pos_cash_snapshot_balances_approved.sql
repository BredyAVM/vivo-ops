create or replace function public.counter_read_cash_snapshot(
  p_movement_limit integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_movement_limit, 12), 1), 25);
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  with allowed_accounts as materialized (
    select
      account.id,
      account.name,
      account.account_kind::text as account_kind,
      account.currency_code::text as currency_code,
      profile.closure_kind,
      profile.baseline_required,
      array_agg(
        distinct rule.payment_method_code
        order by rule.payment_method_code
      ) filter (where rule.payment_method_code is not null) as methods
    from public.money_accounts account
    join public.money_account_payment_rules rule
      on rule.money_account_id = account.id
    left join public.money_account_closure_profiles profile
      on profile.money_account_id = account.id
    where public.is_counter_direct_money_account(account.id)
      and rule.role::text = 'counter'
      and rule.is_active = true
      and (
        coalesce(rule.can_confirm_payment, false)
        or coalesce(rule.auto_confirms_report, false)
      )
    group by
      account.id,
      account.name,
      account.account_kind,
      account.currency_code,
      profile.closure_kind,
      profile.baseline_required
  ),
  anchors as materialized (
    select
      allowed.*,
      closure_row.id as closure_id,
      closure_row.closure_date,
      closure_row.closure_at,
      closure_row.created_at as closure_created_at,
      closure_row.expected_amount as closure_expected_amount,
      closure_row.counted_amount as closure_counted_amount,
      closure_row.difference_amount as closure_difference_amount,
      closure_creator.full_name as closure_created_by_name,
      baseline_row.baseline_date,
      baseline_row.baseline_at,
      baseline_row.counted_amount as baseline_amount
    from allowed_accounts allowed
    left join lateral (
      select
        closure.id,
        closure.closure_date,
        coalesce(closure.closure_at, closure.created_at) as closure_at,
        closure.created_at,
        closure.expected_amount,
        closure.counted_amount,
        closure.difference_amount,
        closure.created_by_user_id
      from public.money_account_closures closure
      where closure.money_account_id = allowed.id
        and closure.status in ('recorded', 'approved')
      order by
        closure.closure_at desc nulls last,
        closure.created_at desc,
        closure.id desc
      limit 1
    ) closure_row on true
    left join public.profiles closure_creator
      on closure_creator.id = closure_row.created_by_user_id
    left join lateral (
      select
        baseline.baseline_date,
        baseline.baseline_at,
        baseline.counted_amount
      from public.money_account_closure_baselines baseline
      where baseline.money_account_id = allowed.id
        and baseline.status = 'active'
      order by baseline.baseline_at desc, baseline.id desc
      limit 1
    ) baseline_row on closure_row.id is null
  ),
  balances as materialized (
    select
      anchor.id,
      round((
        case
          when anchor.account_kind = 'pos' then 0
          else coalesce(anchor.closure_counted_amount, anchor.baseline_amount, 0)
        end
        + coalesce(sum(
          case
            when anchor.account_kind = 'pos'
             and movement.direction::text = 'outflow'
             and movement.movement_type::text = 'withdrawal'
             and settled_closure.id is not null
              then 0
            when movement.direction::text = 'inflow' then movement.amount
            else -movement.amount
          end
        ), 0)
      )::numeric, 2) as balance
    from anchors anchor
    left join public.money_movements movement
      on movement.money_account_id = anchor.id
     and movement.status::text = 'confirmed'
     and movement.movement_date <= v_today
     and (
       case
         when anchor.closure_id is not null then
           movement.movement_date > anchor.closure_date
           or (
             movement.movement_date = anchor.closure_date
             and coalesce(movement.confirmed_at, movement.created_at) > anchor.closure_at
           )
         when anchor.baseline_date is not null then
           movement.movement_date > anchor.baseline_date
           or (
             movement.movement_date = anchor.baseline_date
             and coalesce(movement.confirmed_at, movement.created_at) > anchor.baseline_at
           )
         else true
       end
     )
    left join public.money_account_closures settled_closure
      on anchor.account_kind = 'pos'
     and movement.direction::text = 'outflow'
     and movement.movement_type::text = 'withdrawal'
     and movement.reference_code ~ '^closure-[0-9]+$'
     and settled_closure.id = substring(movement.reference_code from '^closure-([0-9]+)$')::bigint
     and settled_closure.money_account_id = anchor.id
     and settled_closure.status in ('recorded', 'approved')
    group by
      anchor.id,
      anchor.account_kind,
      anchor.closure_id,
      anchor.closure_date,
      anchor.closure_at,
      anchor.closure_counted_amount,
      anchor.baseline_date,
      anchor.baseline_at,
      anchor.baseline_amount
  ),
  today_totals as materialized (
    select
      allowed.id,
      round(coalesce(sum(movement.amount) filter (
        where movement.direction::text = 'inflow'
      ), 0)::numeric, 2) as inflow,
      round(coalesce(sum(movement.amount) filter (
        where movement.direction::text = 'outflow'
      ), 0)::numeric, 2) as outflow,
      count(movement.id) as movement_count
    from allowed_accounts allowed
    left join public.money_movements movement
      on movement.money_account_id = allowed.id
     and movement.status::text = 'confirmed'
     and movement.movement_date = v_today
    group by allowed.id
  ),
  shaped as (
    select
      anchor.account_kind,
      anchor.name,
      anchor.id,
      jsonb_build_object(
        'accountId', anchor.id,
        'accountName', coalesce(
          nullif(trim(anchor.name), ''),
          'Cuenta ' || anchor.id::text
        ),
        'accountKind', anchor.account_kind,
        'closureKind', anchor.closure_kind,
        'currencyCode', anchor.currency_code,
        'methods', coalesce(to_jsonb(anchor.methods), '[]'::jsonb),
        'inflow', coalesce(totals.inflow, 0),
        'outflow', coalesce(totals.outflow, 0),
        'net', round((
          coalesce(totals.inflow, 0) - coalesce(totals.outflow, 0)
        )::numeric, 2),
        'balance', coalesce(balance.balance, 0),
        'closureExpectedAmount', coalesce(balance.balance, 0),
        'closureReady',
          (
            anchor.closure_id is not null
            or anchor.baseline_date is not null
            or not coalesce(anchor.baseline_required, false)
          )
          and coalesce(balance.balance, 0) >= 0,
        'movementCount', coalesce(totals.movement_count, 0),
        'lastClosure',
          case
            when anchor.closure_id is null then null
            else jsonb_build_object(
              'id', anchor.closure_id,
              'closureAt', anchor.closure_at,
              'expectedAmount', anchor.closure_expected_amount,
              'countedAmount', anchor.closure_counted_amount,
              'differenceAmount', anchor.closure_difference_amount,
              'createdByName', nullif(trim(anchor.closure_created_by_name), '')
            )
          end,
        'pendingRequestCount', (
          select count(*)
          from public.money_movements pending
          where pending.money_account_id = anchor.id
            and pending.status::text = 'pending'
            and pending.approval_required = true
            and pending.movement_type::text = 'expense_payment'
            and pending.order_id is null
        ),
        'pendingRequests', coalesce((
          select jsonb_agg(
            request.payload
            order by request.created_at desc, request.id desc
          )
          from (
            select
              pending.created_at,
              pending.id,
              jsonb_build_object(
                'id', pending.id,
                'movementGroupId', pending.movement_group_id,
                'movementDate', pending.movement_date,
                'createdAt', pending.created_at,
                'amount', pending.amount,
                'amountUsdEquivalent', pending.amount_usd_equivalent,
                'currencyCode', pending.currency_code::text,
                'referenceCode', pending.reference_code,
                'counterpartyName', pending.counterparty_name,
                'description', pending.description,
                'approvalReason', pending.approval_required_reason,
                'createdByName', nullif(trim(creator.full_name), '')
              ) as payload
            from public.money_movements pending
            left join public.profiles creator
              on creator.id = pending.created_by_user_id
            where pending.money_account_id = anchor.id
              and pending.status::text = 'pending'
              and pending.approval_required = true
              and pending.movement_type::text = 'expense_payment'
              and pending.order_id is null
            order by pending.created_at desc, pending.id desc
            limit 8
          ) request
        ), '[]'::jsonb),
        'movements', coalesce((
          select jsonb_agg(
            recent.payload
            order by recent.created_at desc, recent.id desc
          )
          from (
            select
              movement.created_at,
              movement.id,
              jsonb_build_object(
                'id', movement.id,
                'movementDate', movement.movement_date,
                'createdAt', movement.created_at,
                'direction', movement.direction::text,
                'movementType', movement.movement_type::text,
                'amount', movement.amount,
                'amountUsdEquivalent', movement.amount_usd_equivalent,
                'currencyCode', movement.currency_code::text,
                'referenceCode', movement.reference_code,
                'counterpartyName', movement.counterparty_name,
                'description', movement.description,
                'orderId', movement.order_id,
                'createdByName', nullif(trim(creator.full_name), '')
              ) as payload
            from public.money_movements movement
            left join public.profiles creator
              on creator.id = movement.created_by_user_id
            where movement.money_account_id = anchor.id
              and movement.status::text = 'confirmed'
              and movement.movement_date = v_today
            order by movement.created_at desc, movement.id desc
            limit v_limit
          ) recent
        ), '[]'::jsonb)
      ) as payload
    from anchors anchor
    join balances balance on balance.id = anchor.id
    join today_totals totals on totals.id = anchor.id
  )
  select coalesce(
    jsonb_agg(
      shaped.payload
      order by
        case shaped.account_kind when 'cash' then 1 when 'pos' then 2 else 3 end,
        shaped.name,
        shaped.id
    ),
    '[]'::jsonb
  )
  into v_payload
  from shaped;

  return v_payload;
end;
$function$;

revoke all on function public.counter_read_cash_snapshot(integer)
  from public, anon;
grant execute on function public.counter_read_cash_snapshot(integer)
  to authenticated, service_role;
