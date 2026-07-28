-- Counter Block 9: operational cash, POS and zero-difference closures.
--
-- No tables are created. The canonical ledger, account profiles, baselines,
-- closures and command receipts remain the only persistence sources.

begin;

create or replace function public.is_counter_direct_money_account(
  p_money_account_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.money_accounts account
    join public.money_account_payment_rules rule
      on rule.money_account_id = account.id
    where account.id = p_money_account_id
      and account.is_active = true
      and account.currency_code::text in ('USD', 'VES')
      and (
        account.account_kind::text = 'pos'
        or (
          account.account_kind::text = 'cash'
          and (
            lower(coalesce(account.name, '')) like '%dar%'
            or lower(coalesce(account.name, '')) like '%dark%'
          )
        )
      )
      and rule.role::text = 'counter'
      and rule.is_active = true
      and coalesce(rule.can_confirm_payment, false)
      and coalesce(rule.auto_confirms_report, false)
      and not coalesce(rule.review_required, false)
  );
$function$;

revoke all on function public.is_counter_direct_money_account(bigint)
  from public, anon;
grant execute on function public.is_counter_direct_money_account(bigint)
  to authenticated, service_role;

create index if not exists money_movements_counter_manual_expense_window_idx
  on public.money_movements(
    created_by_user_id,
    money_account_id,
    created_at desc
  )
  where direction = 'outflow'
    and movement_type = 'expense_payment'
    and order_id is null
    and payment_report_id is null
    and status in ('pending', 'confirmed');

create or replace function public.counter_record_manual_movement(
  p_idempotency_key uuid,
  p_direction public.movement_direction,
  p_money_account_id bigint,
  p_amount numeric,
  p_movement_date date,
  p_exchange_rate_ves_per_usd numeric default null,
  p_reference_code text default null,
  p_counterparty_name text default null,
  p_description text default null,
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
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_equiv numeric(12,2);
  v_recent_total numeric(12,2) := 0;
  v_same_signature_total numeric(12,2) := 0;
  v_reference_key text := lower(btrim(coalesce(p_reference_code, '')));
  v_counterparty_key text := public.search_normalize(coalesce(p_counterparty_name, ''));
  v_description_key text := public.search_normalize(coalesce(p_description, ''));
  v_movement_type public.movement_type;
  v_status public.money_movement_status;
  v_approval_reason text;
  v_movement_id bigint;
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_command_at timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_is_supervisor := public.is_master_or_admin();
  if not v_is_supervisor and not public.has_role('counter') then
    raise exception 'Only Counter or Master/Admin can record a Counter manual movement';
  end if;

  if p_idempotency_key is null then
    raise exception 'idempotency_key is required';
  end if;

  if p_movement_date is null then
    raise exception 'movement_date is required';
  end if;

  if not v_is_supervisor and p_movement_date <> v_today then
    raise exception 'Counter manual movements must use the current Caracas business date';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;

  if nullif(btrim(p_description), '') is null then
    raise exception 'Movement description is required';
  end if;

  v_amount := round(p_amount, 2);
  if v_amount <= 0 then
    raise exception 'amount rounds to zero';
  end if;

  v_request_payload := jsonb_build_object(
    'direction', p_direction,
    'money_account_id', p_money_account_id,
    'amount', p_amount,
    'movement_date', p_movement_date,
    'exchange_rate_ves_per_usd', p_exchange_rate_ves_per_usd,
    'reference_code', p_reference_code,
    'counterparty_name', p_counterparty_name,
    'description', p_description,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'record_manual_movement',
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

  if not v_is_supervisor
     and not public.is_counter_direct_money_account(p_money_account_id) then
    raise exception 'Counter can only use active DAR cash and POS accounts';
  end if;

  if not v_is_supervisor and v_account.account_kind::text <> 'cash' then
    raise exception 'Counter manual movements are limited to DAR cash accounts';
  end if;

  if v_account.currency_code::text not in ('USD', 'VES') then
    raise exception 'Money account currency is not supported by Counter';
  end if;

  if v_account.currency_code::text = 'VES' then
    select round(rate.rate_bs_per_usd, 6)
    into v_rate
    from public.exchange_rates rate
    where rate.is_active = true
      and rate.rate_bs_per_usd > 0
    order by rate.effective_at desc, rate.id desc
    limit 1;

    if v_rate is null or v_rate <= 0 then
      raise exception 'counter_exchange_rate_unavailable';
    end if;
  else
    v_rate := null;
  end if;

  v_equiv := public.counter_amount_usd(
    v_account.currency_code,
    v_amount,
    v_rate
  );
  v_movement_type := case
    when p_direction = 'inflow' then 'other_income'::public.movement_type
    else 'expense_payment'::public.movement_type
  end;

  if p_direction = 'outflow' and not v_is_supervisor then
    select round(coalesce(sum(movement.amount_usd_equivalent), 0), 2)
    into v_recent_total
    from public.money_movements movement
    where movement.created_by_user_id = v_uid
      and movement.money_account_id = p_money_account_id
      and movement.movement_date = p_movement_date
      and movement.direction = 'outflow'
      and movement.movement_type = 'expense_payment'
      and movement.order_id is null
      and movement.payment_report_id is null
      and movement.status in ('pending', 'confirmed')
      and movement.created_at >= v_command_at - interval '30 minutes';

    select round(coalesce(sum(movement.amount_usd_equivalent), 0), 2)
    into v_same_signature_total
    from public.money_movements movement
    where movement.created_by_user_id = v_uid
      and movement.money_account_id = p_money_account_id
      and movement.movement_date = p_movement_date
      and movement.direction = 'outflow'
      and movement.movement_type = 'expense_payment'
      and movement.order_id is null
      and movement.payment_report_id is null
      and movement.status in ('pending', 'confirmed')
      and (
        (
          v_reference_key <> ''
          and lower(btrim(coalesce(movement.reference_code, ''))) = v_reference_key
        )
        or (
          v_description_key <> ''
          and public.search_normalize(coalesce(movement.description, '')) = v_description_key
          and (
            v_counterparty_key = ''
            or public.search_normalize(coalesce(movement.counterparty_name, '')) = v_counterparty_key
          )
        )
      );

    if v_equiv > 20.00 then
      v_status := 'pending';
      v_approval_reason :=
        'Gasto operativo Counter superior a USD 20 o su equivalente';
    elsif v_recent_total + v_equiv > 20.00
       or v_same_signature_total + v_equiv > 20.00 then
      v_status := 'pending';
      v_approval_reason :=
        'Acumulado de gastos manuales relacionado supera USD 20; requiere revisión para evitar fraccionamiento';
    else
      v_status := 'confirmed';
      v_approval_reason := null;
    end if;
  else
    v_status := 'confirmed';
    v_approval_reason := null;
  end if;

  insert into public.money_movements (
    movement_date,
    created_by_user_id,
    confirmed_at,
    confirmed_by_user_id,
    status,
    approval_required,
    approval_required_reason,
    direction,
    movement_type,
    money_account_id,
    currency_code,
    amount,
    exchange_rate_ves_per_usd,
    amount_usd_equivalent,
    reference_code,
    counterparty_name,
    description,
    notes,
    order_id,
    payment_report_id,
    movement_group_id
  ) values (
    p_movement_date,
    v_uid,
    case when v_status = 'confirmed' then v_command_at else null end,
    case when v_status = 'confirmed' then v_uid else null end,
    v_status,
    v_status = 'pending',
    v_approval_reason,
    p_direction,
    v_movement_type,
    p_money_account_id,
    v_account.currency_code,
    v_amount,
    v_rate,
    v_equiv,
    nullif(btrim(p_reference_code), ''),
    nullif(btrim(p_counterparty_name), ''),
    nullif(btrim(p_description), ''),
    nullif(btrim(p_notes), ''),
    null,
    null,
    p_idempotency_key
  )
  returning id into v_movement_id;

  v_result := jsonb_build_object(
    'ok', true,
    'movement_id', v_movement_id,
    'movement_group_id', p_idempotency_key,
    'status', v_status,
    'approval_required', v_status = 'pending',
    'approval_required_reason', v_approval_reason,
    'amount', v_amount,
    'currency_code', v_account.currency_code,
    'exchange_rate_ves_per_usd', v_rate,
    'amount_usd_equivalent', v_equiv
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_record_manual_movement(
  uuid,
  public.movement_direction,
  bigint,
  numeric,
  date,
  numeric,
  text,
  text,
  text,
  text
) from public, anon;
grant execute on function public.counter_record_manual_movement(
  uuid,
  public.movement_direction,
  bigint,
  numeric,
  date,
  numeric,
  text,
  text,
  text,
  text
) to authenticated, service_role;

-- The shared decision command still handles order-linked refunds for Master/Admin.
-- Manual Counter expenses are stricter: only Administration may decide them.
create or replace function public.counter_decide_authorization(
  p_idempotency_key uuid,
  p_movement_group_id uuid,
  p_decision text,
  p_decision_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_group record;
  v_movement_id bigint;
  v_account_id bigint;
  v_movement_ids jsonb;
  v_command_at timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_master_or_admin() then
    raise exception 'Only Master/Admin can decide Counter authorizations';
  end if;

  p_decision := lower(btrim(p_decision));
  if p_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject';
  end if;

  select
    min(movement.order_id) as order_id,
    count(*) as movement_count,
    count(distinct movement.order_id) filter (where movement.order_id is not null)
      as order_count,
    count(distinct movement.movement_type) as movement_type_count,
    min(movement.movement_type::text) as movement_type
  into v_group
  from public.money_movements movement
  where movement.movement_group_id = p_movement_group_id;

  if v_group.movement_count = 0 then
    raise exception 'Authorization movement group not found';
  end if;

  if v_group.order_count > 1
     or v_group.movement_type_count <> 1
     or v_group.movement_type not in ('expense_payment', 'withdrawal') then
    raise exception 'Movement group is not a valid Counter authorization';
  end if;

  if v_group.movement_type = 'expense_payment'
     and not public.has_role('admin') then
    raise exception 'Only Administration can decide Counter manual expenses';
  end if;

  v_request_payload := jsonb_build_object(
    'movement_group_id', p_movement_group_id,
    'decision', p_decision,
    'decision_notes', p_decision_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'decide_authorization',
    v_group.order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  if v_group.order_id is not null then
    perform order_row.id
    from public.orders order_row
    where order_row.id = v_group.order_id
    for update;
  end if;

  for v_account_id in
    select distinct movement.money_account_id
    from public.money_movements movement
    where movement.movement_group_id = p_movement_group_id
    order by movement.money_account_id
  loop
    perform account.id
    from public.money_accounts account
    where account.id = v_account_id
    for update;
  end loop;

  perform movement.id
  from public.money_movements movement
  where movement.movement_group_id = p_movement_group_id
  order by movement.id
  for update;

  select
    min(movement.order_id) as order_id,
    count(*) as movement_count,
    count(distinct movement.order_id) filter (where movement.order_id is not null)
      as order_count,
    count(distinct movement.movement_type) as movement_type_count,
    min(movement.movement_type::text) as movement_type,
    bool_and(
      movement.status = 'pending'
      and movement.approval_required
      and movement.reviewed_at is null
      and movement.reviewed_by_user_id is null
    ) as awaits_decision
  into v_group
  from public.money_movements movement
  where movement.movement_group_id = p_movement_group_id;

  if v_group.movement_count = 0
     or v_group.order_count > 1
     or v_group.movement_type_count <> 1
     or v_group.movement_type not in ('expense_payment', 'withdrawal') then
    raise exception 'Movement group is not a valid Counter authorization';
  end if;

  if v_group.movement_type = 'expense_payment'
     and not public.has_role('admin') then
    raise exception 'Only Administration can decide Counter manual expenses';
  end if;

  if not v_group.awaits_decision then
    raise exception 'Only pending authorization movements can be decided';
  end if;

  if v_group.movement_type = 'expense_payment'
     and (v_group.movement_count <> 1 or v_group.order_id is not null) then
    raise exception 'Counter expense authorization must contain one unlinked movement';
  end if;

  if v_group.movement_type = 'withdrawal'
     and v_group.order_id is null then
    raise exception 'Counter refund authorization must be linked to one order';
  end if;

  if p_decision = 'reject' then
    update public.money_movements
    set
      status = 'rejected',
      reviewed_at = v_command_at,
      reviewed_by_user_id = v_uid,
      rejected_at = v_command_at,
      rejected_by_user_id = v_uid,
      rejection_reason = coalesce(
        nullif(btrim(p_decision_notes), ''),
        case
          when v_group.movement_type = 'expense_payment'
            then 'Solicitud rechazada por Administración'
          else 'Solicitud rechazada por Master/Admin'
        end
      ),
      approval_required = false,
      approval_required_reason = null
    where movement_group_id = p_movement_group_id
      and status = 'pending';

    v_result := jsonb_build_object(
      'ok', true,
      'movement_group_id', p_movement_group_id,
      'status', 'rejected'
    );
  elsif v_group.movement_type = 'expense_payment' then
    update public.money_movements
    set
      status = 'confirmed',
      confirmed_at = v_command_at,
      confirmed_by_user_id = v_uid,
      reviewed_at = v_command_at,
      reviewed_by_user_id = v_uid,
      approval_required = false,
      approval_required_reason = null
    where movement_group_id = p_movement_group_id
      and status = 'pending'
    returning id into v_movement_id;

    if not found then
      raise exception 'Pending expense movement not found';
    end if;

    v_result := jsonb_build_object(
      'ok', true,
      'movement_group_id', p_movement_group_id,
      'status', 'executed',
      'movement_id', v_movement_id
    );
  else
    update public.money_movements
    set
      reviewed_at = v_command_at,
      reviewed_by_user_id = v_uid,
      approval_required = false,
      approval_required_reason = null
    where movement_group_id = p_movement_group_id
      and status = 'pending';

    select coalesce(jsonb_agg(movement.id order by movement.id), '[]'::jsonb)
    into v_movement_ids
    from public.money_movements movement
    where movement.movement_group_id = p_movement_group_id;

    v_result := jsonb_build_object(
      'ok', true,
      'movement_group_id', p_movement_group_id,
      'status', 'approved',
      'movement_ids', v_movement_ids
    );
  end if;

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_decide_authorization(uuid, uuid, text, text)
  from public, anon;
grant execute on function public.counter_decide_authorization(uuid, uuid, text, text)
  to authenticated, service_role;

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

create or replace function public.counter_read_cash_movements(
  p_money_account_id bigint,
  p_cursor_created_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
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

  if not public.is_counter_direct_money_account(p_money_account_id) then
    raise exception 'counter_cash_account_not_allowed' using errcode = '42501';
  end if;

  with page_plus_one as materialized (
    select
      movement.id,
      movement.movement_date,
      movement.created_at,
      movement.direction::text as direction,
      movement.movement_type::text as movement_type,
      movement.amount,
      movement.amount_usd_equivalent,
      movement.currency_code::text as currency_code,
      movement.reference_code,
      movement.counterparty_name,
      movement.description,
      movement.order_id,
      nullif(trim(creator.full_name), '') as created_by_name
    from public.money_movements movement
    left join public.profiles creator
      on creator.id = movement.created_by_user_id
    where movement.money_account_id = p_money_account_id
      and movement.status::text = 'confirmed'
      and movement.movement_date = v_today
      and (
        p_cursor_created_at is null
        or p_cursor_id is null
        or (movement.created_at, movement.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by movement.created_at desc, movement.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from page_plus_one
    order by created_at desc, id desc
    limit v_limit
  )
  select jsonb_build_object(
    'results', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', row.id,
          'movementDate', row.movement_date,
          'createdAt', row.created_at,
          'direction', row.direction,
          'movementType', row.movement_type,
          'amount', row.amount,
          'amountUsdEquivalent', row.amount_usd_equivalent,
          'currencyCode', row.currency_code,
          'referenceCode', row.reference_code,
          'counterpartyName', row.counterparty_name,
          'description', row.description,
          'orderId', row.order_id,
          'createdByName', row.created_by_name
        )
        order by row.created_at desc, row.id desc
      )
      from page row
    ), '[]'::jsonb),
    'nextCursor',
      case
        when (select count(*) from page_plus_one) > v_limit then (
          select jsonb_build_object(
            'createdAt', row.created_at,
            'id', row.id
          )
          from page row
          order by row.created_at asc, row.id asc
          limit 1
        )
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

revoke all on function public.counter_read_cash_movements(
  bigint,
  timestamptz,
  bigint,
  integer
) from public, anon;
grant execute on function public.counter_read_cash_movements(
  bigint,
  timestamptz,
  bigint,
  integer
) to authenticated, service_role;

commit;
