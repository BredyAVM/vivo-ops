create or replace function public.counter_close_money_account(
  p_idempotency_key uuid,
  p_money_account_id bigint,
  p_closure_at timestamptz,
  p_counted_amount numeric,
  p_exchange_rate_ves_per_usd numeric default null,
  p_reason text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_is_supervisor boolean;
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_account record;
  v_profile record;
  v_previous_closure record;
  v_baseline record;
  v_anchor_at timestamptz;
  v_closure_date date;
  v_counted_amount numeric(12,2);
  v_counted_usd numeric(12,2);
  v_expected_amount numeric(12,2);
  v_expected_usd numeric(12,2);
  v_difference_amount numeric(12,2);
  v_difference_usd numeric(12,2);
  v_rate numeric(18,6);
  v_closure_id bigint;
  v_is_pos_closure boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_is_supervisor := public.is_master_or_admin();
  if not v_is_supervisor and not public.has_role('counter') then
    raise exception 'Only Counter or Master/Admin can close a Counter money account';
  end if;

  if p_closure_at is null then
    raise exception 'closure_at is required';
  end if;

  if p_counted_amount is null or p_counted_amount < 0 then
    raise exception 'counted_amount must be >= 0';
  end if;

  if nullif(btrim(p_reason), '') is null then
    raise exception 'Closure reason is required';
  end if;

  v_request_payload := jsonb_build_object(
    'money_account_id', p_money_account_id,
    'closure_at', p_closure_at,
    'counted_amount', p_counted_amount,
    'exchange_rate_ves_per_usd', p_exchange_rate_ves_per_usd,
    'reason', p_reason,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'close_money_account',
    null,
    p_money_account_id,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select account.*
  into v_account
  from public.money_accounts account
  where account.id = p_money_account_id
  for update;

  if not found or not v_account.is_active then
    raise exception 'Money account is missing or inactive';
  end if;

  if not v_is_supervisor and not public.is_counter_direct_money_account(p_money_account_id) then
    raise exception 'Counter can only close an active direct Counter account';
  end if;

  select
    profile.closure_kind,
    profile.requires_zero_difference,
    profile.allows_classified_difference,
    profile.baseline_required
  into v_profile
  from public.money_account_closure_profiles profile
  where profile.money_account_id = p_money_account_id;

  if not found then
    raise exception 'Money account has no closure profile';
  end if;
  v_is_pos_closure := v_account.account_kind::text = 'pos' or v_profile.closure_kind::text = 'pos';

  v_closure_date := (p_closure_at at time zone 'America/Caracas')::date;
  v_counted_amount := round(p_counted_amount, 2);
  v_rate := case
    when v_account.currency_code = 'VES'
      then round(p_exchange_rate_ves_per_usd, 6)
    else null
  end;

  if v_account.currency_code = 'VES'
     and (v_rate is null or v_rate <= 0) then
    raise exception 'A valid exchange rate is required to close a VES account';
  end if;

  v_counted_usd := case
    when v_counted_amount = 0 then 0
    else public.counter_amount_usd(v_account.currency_code, v_counted_amount, v_rate)
  end;

  if exists (
    select 1
    from public.money_account_closures closure
    where closure.money_account_id = p_money_account_id
      and closure.closure_at = p_closure_at
      and closure.status in ('recorded', 'approved')
  ) then
    raise exception 'An active closure already exists for this account and timestamp';
  end if;

  select
    closure.id,
    closure.closure_at,
    closure.counted_amount,
    closure.counted_amount_usd
  into v_previous_closure
  from public.money_account_closures closure
  where closure.money_account_id = p_money_account_id
    and closure.status in ('recorded', 'approved')
    and closure.closure_at < p_closure_at
  order by closure.closure_at desc, closure.created_at desc, closure.id desc
  limit 1;

  if found then
    v_anchor_at := v_previous_closure.closure_at;
    v_expected_amount := case
      when v_is_pos_closure then 0
      else round(v_previous_closure.counted_amount, 2)
    end;
    v_expected_usd := case
      when v_is_pos_closure then 0
      else round(v_previous_closure.counted_amount_usd, 2)
    end;
  else
    select
      baseline.id,
      baseline.baseline_at,
      baseline.counted_amount,
      baseline.counted_amount_usd
    into v_baseline
    from public.money_account_closure_baselines baseline
    where baseline.money_account_id = p_money_account_id
      and baseline.status = 'active'
      and baseline.baseline_at <= p_closure_at
    order by baseline.baseline_at desc, baseline.created_at desc, baseline.id desc
    limit 1;

    if not found then
      if v_profile.baseline_required then
        raise exception 'Money account requires a baseline before its first closure';
      end if;
      v_anchor_at := '-infinity'::timestamptz;
      v_expected_amount := 0;
      v_expected_usd := 0;
    else
      v_anchor_at := v_baseline.baseline_at;
      v_expected_amount := case
        when v_is_pos_closure then 0
        else round(v_baseline.counted_amount, 2)
      end;
      v_expected_usd := case
        when v_is_pos_closure then 0
        else round(v_baseline.counted_amount_usd, 2)
      end;
    end if;
  end if;

  select
    round(
      v_expected_amount
      + coalesce(sum(
        case
          when v_is_pos_closure
           and movement.direction = 'outflow'
           and movement.movement_type = 'withdrawal'
           and settled_closure.id is not null
            then 0
          when movement.direction = 'inflow' then movement.amount
          else -movement.amount
        end
      ), 0),
      2
    ),
    round(
      v_expected_usd
      + coalesce(sum(
        case
          when v_is_pos_closure
           and movement.direction = 'outflow'
           and movement.movement_type = 'withdrawal'
           and settled_closure.id is not null
            then 0
          when movement.direction = 'inflow' then movement.amount_usd_equivalent
          else -movement.amount_usd_equivalent
        end
      ), 0),
      2
    )
  into v_expected_amount, v_expected_usd
  from public.money_movements movement
  left join public.money_account_closures settled_closure
    on v_is_pos_closure
   and movement.direction = 'outflow'
   and movement.movement_type = 'withdrawal'
   and movement.reference_code ~ '^closure-[0-9]+$'
   and settled_closure.id = substring(movement.reference_code from '^closure-([0-9]+)$')::bigint
   and settled_closure.money_account_id = p_money_account_id
   and settled_closure.status in ('recorded', 'approved')
  where movement.money_account_id = p_money_account_id
    and movement.status = 'confirmed'
    and movement.movement_date <= v_closure_date
    and coalesce(movement.confirmed_at, movement.created_at) > v_anchor_at
    and coalesce(movement.confirmed_at, movement.created_at) <= p_closure_at;

  v_difference_amount := round(v_counted_amount - v_expected_amount, 2);
  v_difference_usd := round(v_counted_usd - v_expected_usd, 2);

  if v_profile.requires_zero_difference
     and abs(v_difference_amount) > 0.009 then
    raise exception
      'This account requires zero difference; counted %, expected %, difference %. Record an adjustment before closing',
      v_counted_amount,
      v_expected_amount,
      v_difference_amount;
  end if;

  insert into public.money_account_closures (
    money_account_id,
    closure_date,
    closure_at,
    expected_amount,
    counted_amount,
    difference_amount,
    expected_amount_usd,
    counted_amount_usd,
    difference_amount_usd,
    currency_code,
    exchange_rate_ves_per_usd,
    reason,
    notes,
    status,
    created_by_user_id
  ) values (
    p_money_account_id,
    v_closure_date,
    p_closure_at,
    v_expected_amount,
    v_counted_amount,
    v_difference_amount,
    v_expected_usd,
    v_counted_usd,
    v_difference_usd,
    v_account.currency_code,
    v_rate,
    format('Counter - %s', btrim(p_reason)),
    nullif(btrim(p_notes), ''),
    'recorded',
    v_uid
  )
  returning id into v_closure_id;

  if v_profile.allows_classified_difference
     and abs(v_difference_amount) > 0.009 then
    insert into public.money_account_reconciliation_items (
      money_account_id,
      source_kind,
      source_id,
      item_type,
      direction,
      currency_code,
      amount,
      amount_usd_equivalent,
      operation_date,
      reference_code,
      counterparty_name,
      description,
      status,
      created_by_user_id
    ) values (
      p_money_account_id,
      'closure',
      v_closure_id,
      'other_pending',
      case when v_difference_amount > 0 then 'surplus' else 'shortage' end,
      v_account.currency_code::text,
      abs(v_difference_amount),
      abs(v_difference_usd),
      v_closure_date,
      format('closure-%s', v_closure_id),
      null,
      case
        when v_difference_amount > 0
          then format('Excedente pendiente por identificar en cierre de %s', v_account.name)
        else format('Faltante pendiente por explicar en cierre de %s', v_account.name)
      end,
      'open',
      v_uid
    );
  end if;

  v_result := jsonb_build_object(
    'ok', true,
    'closure_id', v_closure_id,
    'money_account_id', p_money_account_id,
    'closure_at', p_closure_at,
    'closure_date', v_closure_date,
    'expected_amount', v_expected_amount,
    'counted_amount', v_counted_amount,
    'difference_amount', v_difference_amount,
    'currency_code', v_account.currency_code,
    'expected_amount_usd', v_expected_usd,
    'counted_amount_usd', v_counted_usd,
    'difference_amount_usd', v_difference_usd
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_close_money_account(
  uuid,
  bigint,
  timestamptz,
  numeric,
  numeric,
  text,
  text
) from public, anon;

grant execute on function public.counter_close_money_account(
  uuid,
  bigint,
  timestamptz,
  numeric,
  numeric,
  text,
  text
) to authenticated, service_role;
