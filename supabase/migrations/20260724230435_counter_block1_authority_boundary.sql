-- Counter Block 1: authority and security boundary.
--
-- Scope:
-- - harden role helpers and executable grants;
-- - expose only the operational reads required by a pure Counter user;
-- - keep order and money writes behind narrowly authorized RPCs;
-- - align direct Counter payments with active account/payment rules;
-- - preserve Master/Admin authority without granting it to Counter.

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------

create or replace function public.has_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.role::text = p_role
  );
$function$;

create or replace function public.get_my_roles()
returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(array_agg(ur.role::text order by ur.role::text), '{}'::text[])
  from public.user_roles ur
  where ur.user_id = (select auth.uid());
$function$;

create or replace function public.is_master_or_admin()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is not null then exists (
      select 1
      from public.user_roles ur
      where ur.user_id = (select auth.uid())
        and ur.role in ('master', 'admin')
    )
    else current_user in ('postgres', 'supabase_admin')
  end;
$function$;

revoke all on function public.has_role(text) from public, anon;
revoke all on function public.get_my_roles() from public, anon;
revoke all on function public.is_master_or_admin() from public, anon;

grant execute on function public.has_role(text) to authenticated, service_role;
grant execute on function public.get_my_roles() to authenticated, service_role;
grant execute on function public.is_master_or_admin() to authenticated, service_role;

-- A direct Counter account is configured data, not a UI name check:
-- it is active and has an active Counter rule that confirms automatically
-- without a review step.
create or replace function public.is_counter_direct_money_account(p_money_account_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.money_accounts ma
    join public.money_account_payment_rules rule
      on rule.money_account_id = ma.id
    where ma.id = p_money_account_id
      and ma.is_active = true
      and rule.role = 'counter'
      and rule.is_active = true
      and rule.can_confirm_payment = true
      and rule.auto_confirms_report = true
      and rule.review_required = false
  );
$function$;

revoke all on function public.is_counter_direct_money_account(bigint) from public, anon;
grant execute on function public.is_counter_direct_money_account(bigint)
  to authenticated, service_role;

-- Floresta is outside Counter's cash perimeter. The update is data-driven and
-- intentionally avoids generated rule ids.
update public.money_account_payment_rules rule
set
  is_active = false,
  updated_at = now(),
  notes = case
    when coalesce(rule.notes, '') ilike '%counter block 1:%' then rule.notes
    else concat_ws(
      E'\n',
      nullif(rule.notes, ''),
      'Counter Block 1: cuenta Floresta fuera del perimetro operativo de Counter.'
    )
  end
from public.money_accounts account
where account.id = rule.money_account_id
  and rule.role = 'counter'
  and account.name ilike '%floresta%'
  and rule.is_active = true;

-- ---------------------------------------------------------------------------
-- Operational read perimeter
-- ---------------------------------------------------------------------------

drop policy if exists "Counter reads operational orders" on public.orders;
drop policy if exists "orders_select_policy" on public.orders;
create policy "orders_select_policy"
  on public.orders
  for select
  to authenticated
  using (
    public.is_master_or_admin()
    or (
      (select public.has_role('advisor'))
      and attributed_advisor_id = (select auth.uid())
    )
    or (
      (select public.has_role('counter'))
      and (
        status in ('confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
        or (status = 'created' and source = 'walk_in')
      )
    )
  );

drop policy if exists "Counter reads operational order items" on public.order_items;
drop policy if exists "order_items_select" on public.order_items;
create policy "order_items_select"
  on public.order_items
  for select
  to authenticated
  using (
    public.is_master_or_admin()
    or (
      (select public.has_role('advisor'))
      and exists (
        select 1
        from public.orders order_row
        where order_row.id = order_items.order_id
          and order_row.attributed_advisor_id = (select auth.uid())
      )
    )
    or (
      (select public.has_role('kitchen'))
      and exists (
        select 1
        from public.orders order_row
        where order_row.id = order_items.order_id
          and order_row.status in ('confirmed', 'in_kitchen', 'ready')
      )
    )
    or (
      (select public.has_role('counter'))
      and exists (
        select 1
        from public.orders order_row
        where order_row.id = order_items.order_id
          and (
            order_row.status in ('confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
            or (order_row.status = 'created' and order_row.source = 'walk_in')
          )
      )
    )
  );

drop policy if exists "Profiles are readable by their owner" on public.profiles;
drop policy if exists "Counter reads active operational profiles" on public.profiles;
drop policy if exists "profiles_select_master_admin" on public.profiles;
drop policy if exists "profiles_select_by_role" on public.profiles;
create policy "profiles_select_by_role"
  on public.profiles
  for select
  to authenticated
  using (
    public.is_master_or_admin()
    or id = (select auth.uid())
    or (
      (select public.has_role('counter'))
      and is_active = true
    )
  );

drop policy if exists "Counter reads own payment reports" on public.payment_reports;
drop policy if exists "pr_read_advisor_own_orders" on public.payment_reports;
drop policy if exists "pr_read_master_admin_all" on public.payment_reports;
drop policy if exists "payment_reports_select_by_role" on public.payment_reports;
create policy "payment_reports_select_by_role"
  on public.payment_reports
  for select
  to authenticated
  using (
    public.is_master_or_admin()
    or (
      (select public.has_role('advisor'))
      and exists (
        select 1
        from public.orders order_row
        where order_row.id = payment_reports.order_id
          and order_row.attributed_advisor_id = (select auth.uid())
      )
    )
    or (
      (select public.has_role('counter'))
      and created_by_user_id = (select auth.uid())
    )
  );

drop policy if exists "Counter reads confirmed direct account movements" on public.money_movements;
drop policy if exists "mm_read_advisor_by_order" on public.money_movements;
drop policy if exists "mm_read_master_admin_all" on public.money_movements;
drop policy if exists "money_movements_select_by_role" on public.money_movements;
create policy "money_movements_select_by_role"
  on public.money_movements
  for select
  to authenticated
  using (
    public.is_master_or_admin()
    or (
      (select public.has_role('advisor'))
      and order_id is not null
      and exists (
        select 1
        from public.orders order_row
        where order_row.id = money_movements.order_id
          and order_row.attributed_advisor_id = (select auth.uid())
      )
    )
    or (
      (select public.has_role('counter'))
      and status = 'confirmed'
      and public.is_counter_direct_money_account(money_account_id)
    )
  );

drop policy if exists "Counter reads direct account closures" on public.money_account_closures;
drop policy if exists "Money account closures are readable by master admins"
  on public.money_account_closures;
drop policy if exists "Money account closures are readable by operators"
  on public.money_account_closures;
create policy "Money account closures are readable by operators"
  on public.money_account_closures
  for select
  to authenticated
  using (
    public.is_master_or_admin()
    or (
      (select public.has_role('counter'))
      and public.is_counter_direct_money_account(money_account_id)
    )
  );

drop policy if exists "Money account closures are writable by master admins"
  on public.money_account_closures;
drop policy if exists "Money account closures are insertable by master admins"
  on public.money_account_closures;
create policy "Money account closures are insertable by master admins"
  on public.money_account_closures
  for insert
  to authenticated
  with check (public.is_master_or_admin());
drop policy if exists "Money account closures are updatable by master admins"
  on public.money_account_closures;
create policy "Money account closures are updatable by master admins"
  on public.money_account_closures
  for update
  to authenticated
  using (public.is_master_or_admin())
  with check (public.is_master_or_admin());
drop policy if exists "Money account closures are deletable by master admins"
  on public.money_account_closures;
create policy "Money account closures are deletable by master admins"
  on public.money_account_closures
  for delete
  to authenticated
  using (public.is_master_or_admin());

drop policy if exists "Counter reads direct account closure baselines"
  on public.money_account_closure_baselines;
drop policy if exists "Money account baselines are readable by master admins"
  on public.money_account_closure_baselines;
drop policy if exists "Money account baselines are readable by operators"
  on public.money_account_closure_baselines;
create policy "Money account baselines are readable by operators"
  on public.money_account_closure_baselines
  for select
  to authenticated
  using (
    public.is_master_or_admin()
    or (
      (select public.has_role('counter'))
      and public.is_counter_direct_money_account(money_account_id)
    )
  );

drop policy if exists "Money account baselines are writable by master admins"
  on public.money_account_closure_baselines;
drop policy if exists "Money account baselines are insertable by master admins"
  on public.money_account_closure_baselines;
create policy "Money account baselines are insertable by master admins"
  on public.money_account_closure_baselines
  for insert
  to authenticated
  with check (public.is_master_or_admin());
drop policy if exists "Money account baselines are updatable by master admins"
  on public.money_account_closure_baselines;
create policy "Money account baselines are updatable by master admins"
  on public.money_account_closure_baselines
  for update
  to authenticated
  using (public.is_master_or_admin())
  with check (public.is_master_or_admin());
drop policy if exists "Money account baselines are deletable by master admins"
  on public.money_account_closure_baselines;
create policy "Money account baselines are deletable by master admins"
  on public.money_account_closure_baselines
  for delete
  to authenticated
  using (public.is_master_or_admin());

alter table public.money_account_closure_profiles enable row level security;

drop policy if exists "Closure profiles are readable by operators"
  on public.money_account_closure_profiles;
create policy "Closure profiles are readable by operators"
  on public.money_account_closure_profiles
  for select
  to authenticated
  using (
    public.is_master_or_admin()
    or (
      (select public.has_role('counter'))
      and public.is_counter_direct_money_account(money_account_id)
    )
  );

drop policy if exists "Closure profiles are writable by master admins"
  on public.money_account_closure_profiles;
drop policy if exists "Closure profiles are insertable by master admins"
  on public.money_account_closure_profiles;
create policy "Closure profiles are insertable by master admins"
  on public.money_account_closure_profiles
  for insert
  to authenticated
  with check (public.is_master_or_admin());
drop policy if exists "Closure profiles are updatable by master admins"
  on public.money_account_closure_profiles;
create policy "Closure profiles are updatable by master admins"
  on public.money_account_closure_profiles
  for update
  to authenticated
  using (public.is_master_or_admin())
  with check (public.is_master_or_admin());
drop policy if exists "Closure profiles are deletable by master admins"
  on public.money_account_closure_profiles;
create policy "Closure profiles are deletable by master admins"
  on public.money_account_closure_profiles
  for delete
  to authenticated
  using (public.is_master_or_admin());

grant select on public.orders to authenticated;
grant select on public.order_items to authenticated;
grant select on public.profiles to authenticated;
grant select on public.payment_reports to authenticated;
grant select on public.money_movements to authenticated;
grant select on public.money_account_closures to authenticated;
grant select on public.money_account_closure_baselines to authenticated;
grant select on public.money_account_closure_profiles to authenticated;

-- Indexes that support the new policy predicates and Counter's bounded reads.
create index if not exists orders_counter_operational_idx
  on public.orders(status, ready_at, created_at)
  where status in ('confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
     or (status = 'created' and source = 'walk_in');

create index if not exists payment_reports_counter_owner_status_account_idx
  on public.payment_reports(created_by_user_id, status, reported_money_account_id);

-- ---------------------------------------------------------------------------
-- Payment report commands
-- ---------------------------------------------------------------------------

create or replace function public.create_payment_report(
  p_order_id bigint,
  p_reported_money_account_id bigint,
  p_reported_currency public.currency_code,
  p_reported_amount numeric,
  p_reported_exchange_rate_ves_per_usd numeric default null,
  p_reference_code text default null,
  p_payer_name text default null,
  p_notes text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid;
  v_ok boolean;
  v_equiv numeric(12,2);
  v_report_id bigint;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_reported_amount is null or p_reported_amount <= 0 then
    raise exception 'reported_amount must be > 0';
  end if;

  select exists (
    select 1
    from public.money_accounts account
    where account.id = p_reported_money_account_id
      and account.is_active = true
      and account.currency_code = p_reported_currency
  ) into v_ok;

  if not v_ok then
    raise exception 'Payment account is inactive, missing, or uses another currency';
  end if;

  if public.is_master_or_admin() then
    select exists (
      select 1
      from public.orders order_row
      where order_row.id = p_order_id
    ) into v_ok;

    if not v_ok then
      raise exception 'Order not found';
    end if;
  elsif public.has_role('counter') then
    select
      exists (
        select 1
        from public.orders order_row
        where order_row.id = p_order_id
      )
      and exists (
        select 1
        from public.money_account_payment_rules rule
        where rule.money_account_id = p_reported_money_account_id
          and rule.role = 'counter'
          and rule.can_report_payment = true
          and rule.is_active = true
      )
    into v_ok;

    if not v_ok then
      raise exception 'Counter cannot report payments for this order/account';
    end if;
  elsif public.has_role('advisor') then
    select exists (
      select 1
      from public.orders order_row
      where order_row.id = p_order_id
        and order_row.attributed_advisor_id = v_uid
    ) into v_ok;

    if not v_ok then
      raise exception 'Advisor cannot report payments for this order';
    end if;
  else
    raise exception 'Insufficient role to create payment report';
  end if;

  if p_reported_currency = 'USD' then
    if p_reported_exchange_rate_ves_per_usd is not null then
      raise exception 'exchange_rate must be NULL when currency=USD';
    end if;
    v_equiv := round(p_reported_amount, 2);
  else
    if p_reported_exchange_rate_ves_per_usd is null
       or p_reported_exchange_rate_ves_per_usd <= 0 then
      raise exception 'exchange_rate_ves_per_usd is required and must be > 0 when currency=VES';
    end if;
    v_equiv := round(p_reported_amount / p_reported_exchange_rate_ves_per_usd, 2);
  end if;

  insert into public.payment_reports (
    order_id,
    status,
    created_by_user_id,
    reported_currency_code,
    reported_amount,
    reported_exchange_rate_ves_per_usd,
    reported_amount_usd_equivalent,
    reported_money_account_id,
    reference_code,
    payer_name,
    notes
  ) values (
    p_order_id,
    'pending',
    v_uid,
    p_reported_currency,
    round(p_reported_amount, 2),
    p_reported_exchange_rate_ves_per_usd,
    v_equiv,
    p_reported_money_account_id,
    nullif(btrim(p_reference_code), ''),
    nullif(btrim(p_payer_name), ''),
    nullif(btrim(p_notes), '')
  )
  returning id into v_report_id;

  return v_report_id;
end;
$function$;

create or replace function public.confirm_payment_report(
  p_report_id bigint,
  p_confirmed_money_account_id bigint,
  p_confirmed_currency public.currency_code,
  p_confirmed_amount numeric,
  p_movement_date date,
  p_confirmed_exchange_rate_ves_per_usd numeric default null,
  p_review_notes text default null,
  p_reference_code text default null,
  p_counterparty_name text default null,
  p_description text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid;
  v_equiv numeric(12,2);
  v_order_id bigint;
  v_status public.payment_report_status;
  v_created_by_user_id uuid;
  v_reported_money_account_id bigint;
  v_reported_currency public.currency_code;
  v_reported_amount numeric(12,2);
  v_movement_id bigint;
  v_duplicate record;
  v_is_master_or_admin boolean;
  v_is_counter boolean;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_is_master_or_admin := public.is_master_or_admin();
  v_is_counter := public.has_role('counter');

  if not v_is_master_or_admin and not v_is_counter then
    raise exception 'Insufficient role to confirm payment reports';
  end if;

  if p_movement_date is null then
    raise exception 'movement_date is required';
  end if;

  if p_confirmed_amount is null or p_confirmed_amount <= 0 then
    raise exception 'confirmed_amount must be > 0';
  end if;

  select
    report.order_id,
    report.status,
    report.created_by_user_id,
    report.reported_money_account_id,
    report.reported_currency_code,
    report.reported_amount
  into
    v_order_id,
    v_status,
    v_created_by_user_id,
    v_reported_money_account_id,
    v_reported_currency,
    v_reported_amount
  from public.payment_reports report
  where report.id = p_report_id
  for update;

  if not found then
    raise exception 'Payment report not found';
  end if;

  if v_status <> 'pending' then
    raise exception 'Only pending reports can be confirmed (current status: %)', v_status;
  end if;

  if not v_is_master_or_admin then
    if v_created_by_user_id <> v_uid
       or v_reported_money_account_id <> p_confirmed_money_account_id
       or v_reported_currency <> p_confirmed_currency
       or v_reported_amount <> round(p_confirmed_amount, 2)
       or not public.is_counter_direct_money_account(p_confirmed_money_account_id) then
      raise exception 'Counter can only auto-confirm its own unchanged report on a direct account';
    end if;
  end if;

  select exists (
    select 1
    from public.money_accounts account
    where account.id = p_confirmed_money_account_id
      and account.is_active = true
      and account.currency_code = p_confirmed_currency
  ) into v_is_counter;

  if not v_is_counter then
    raise exception 'Confirmed account is inactive, missing, or uses another currency';
  end if;

  if p_confirmed_currency = 'USD' then
    if p_confirmed_exchange_rate_ves_per_usd is not null then
      raise exception 'exchange_rate must be NULL when currency=USD';
    end if;
    v_equiv := round(p_confirmed_amount, 2);
  else
    if p_confirmed_exchange_rate_ves_per_usd is null
       or p_confirmed_exchange_rate_ves_per_usd <= 0 then
      raise exception 'exchange_rate_ves_per_usd is required and must be > 0 when currency=VES';
    end if;
    v_equiv := round(p_confirmed_amount / p_confirmed_exchange_rate_ves_per_usd, 2);
  end if;

  select *
  into v_duplicate
  from public.find_active_payment_duplicate(
    p_confirmed_money_account_id,
    p_movement_date,
    p_confirmed_currency,
    round(p_confirmed_amount, 2),
    p_reference_code,
    p_report_id
  )
  limit 1;

  if found then
    raise exception
      'Posible pago duplicado: ya existe un pago activo con la misma cuenta, fecha, monto y referencia en la orden % (%).',
      coalesce(v_duplicate.order_number, '#' || v_duplicate.order_id::text),
      coalesce(v_duplicate.client_name, 'cliente sin nombre');
  end if;

  insert into public.money_movements (
    movement_date,
    created_by_user_id,
    confirmed_at,
    confirmed_by_user_id,
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
    payment_report_id,
    order_id,
    status
  ) values (
    p_movement_date,
    v_uid,
    now(),
    v_uid,
    'inflow',
    'order_payment',
    p_confirmed_money_account_id,
    p_confirmed_currency,
    round(p_confirmed_amount, 2),
    p_confirmed_exchange_rate_ves_per_usd,
    v_equiv,
    nullif(btrim(p_reference_code), ''),
    nullif(btrim(p_counterparty_name), ''),
    nullif(btrim(p_description), ''),
    p_report_id,
    v_order_id,
    'confirmed'
  )
  returning id into v_movement_id;

  update public.payment_reports
  set
    status = 'confirmed',
    operation_date = coalesce(operation_date, p_movement_date),
    reviewed_at = now(),
    reviewed_by_user_id = v_uid,
    review_notes = nullif(btrim(p_review_notes), ''),
    confirmed_movement_id = v_movement_id
  where id = p_report_id;

  return v_movement_id;
end;
$function$;

revoke all on function public.create_payment_report(
  bigint, bigint, public.currency_code, numeric, numeric, text, text, text
) from public, anon;
revoke all on function public.confirm_payment_report(
  bigint, bigint, public.currency_code, numeric, date, numeric, text, text, text, text
) from public, anon;

grant execute on function public.create_payment_report(
  bigint, bigint, public.currency_code, numeric, numeric, text, text, text
) to authenticated, service_role;
grant execute on function public.confirm_payment_report(
  bigint, bigint, public.currency_code, numeric, date, numeric, text, text, text, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Financial state: aggregate access without exposing unrestricted movements
-- ---------------------------------------------------------------------------

create or replace function public.get_orders_financial_state(
  p_order_ids bigint[],
  p_operation_date date default null,
  p_active_bs_rate numeric default null
)
returns table(
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
security definer
set search_path = ''
as $function$
  with requested as (
    select distinct requested_id as order_id
    from unnest(coalesce(p_order_ids, array[]::bigint[])) requested_id
    where requested_id is not null
  ),
  authorized as (
    select requested.order_id
    from requested
    join public.orders order_row on order_row.id = requested.order_id
    where public.is_master_or_admin()
       or public.has_role('counter')
       or (
         public.has_role('advisor')
         and order_row.attributed_advisor_id = (select auth.uid())
       )
  )
  select financial_state.*
  from authorized
  cross join lateral public.get_order_financial_state(
    authorized.order_id,
    p_operation_date,
    p_active_bs_rate
  ) financial_state;
$function$;

revoke all on function public.get_orders_financial_state(bigint[], date, numeric)
  from public, anon;
grant execute on function public.get_orders_financial_state(bigint[], date, numeric)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Narrow dispatch command
-- ---------------------------------------------------------------------------

create or replace function public.counter_dispatch_order(
  p_order_id bigint,
  p_eta_minutes integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid;
  v_order_number text;
  v_fulfillment public.fulfillment_type;
  v_status public.order_status;
  v_delivery_mode text;
  v_internal_driver_user_id uuid;
  v_external_partner_id bigint;
  v_advisor_user_id uuid;
  v_event_id bigint;
  v_now timestamptz := now();
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_master_or_admin()
    or public.has_role('counter')
  ) then
    raise exception 'Only Counter or Master/Admin can dispatch an order';
  end if;

  if p_eta_minutes is not null
     and (p_eta_minutes < 1 or p_eta_minutes > 1440) then
    raise exception 'ETA must be between 1 and 1440 minutes';
  end if;

  select
    order_row.order_number,
    order_row.fulfillment,
    order_row.status,
    order_row.delivery_mode::text,
    order_row.internal_driver_user_id,
    order_row.external_partner_id,
    order_row.attributed_advisor_id
  into
    v_order_number,
    v_fulfillment,
    v_status,
    v_delivery_mode,
    v_internal_driver_user_id,
    v_external_partner_id,
    v_advisor_user_id
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment <> 'delivery' then
    raise exception 'Order % is not a delivery order', p_order_id;
  end if;

  if v_status <> 'ready' then
    raise exception 'Order % can only be dispatched from ready', p_order_id;
  end if;

  if v_delivery_mode = 'internal' and v_internal_driver_user_id is null then
    raise exception 'Order % has no internal driver assigned', p_order_id;
  end if;

  if v_delivery_mode = 'external' and v_external_partner_id is null then
    raise exception 'Order % has no external partner assigned', p_order_id;
  end if;

  if v_delivery_mode is null then
    raise exception 'Order % has no delivery assignment', p_order_id;
  end if;

  update public.orders
  set
    status = 'out_for_delivery',
    eta_minutes = p_eta_minutes,
    extra_fields = coalesce(extra_fields, '{}'::jsonb)
      || jsonb_build_object(
        'delivery',
        coalesce(extra_fields -> 'delivery', '{}'::jsonb)
          || jsonb_build_object(
            'eta_minutes', p_eta_minutes,
            'eta_recorded_at', v_now
          )
      )
  where id = p_order_id;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'out_for_delivery',
    v_uid,
    jsonb_build_object(
      'delivery_mode', v_delivery_mode,
      'internal_driver_user_id', v_internal_driver_user_id,
      'external_partner_id', v_external_partner_id,
      'eta_minutes', p_eta_minutes
    )
  );

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  ) values (
    p_order_id,
    v_order_number,
    'out_for_delivery',
    'delivery',
    'Orden en camino',
    case
      when p_eta_minutes is null then 'La orden saliÃ³ en camino.'
      else format('La orden saliÃ³ en camino con ETA de %s min.', p_eta_minutes)
    end,
    'info',
    v_uid,
    jsonb_build_object('delivery_eta_minutes', p_eta_minutes)
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  values (v_event_id, 'master', null, false);

  if v_advisor_user_id is not null then
    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    )
    values (v_event_id, null, v_advisor_user_id, false);
  end if;

  if v_internal_driver_user_id is not null
     and v_internal_driver_user_id is distinct from v_advisor_user_id then
    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    )
    values (v_event_id, null, v_internal_driver_user_id, false);
  end if;
end;
$function$;

revoke all on function public.counter_dispatch_order(bigint, integer)
  from public, anon;
grant execute on function public.counter_dispatch_order(bigint, integer)
  to authenticated, service_role;

-- Existing generic delivery functions remain Master/Admin paths. Their grants
-- are explicit, and their search paths are no longer mutable.
alter function public.out_for_delivery(bigint) set search_path = '';
revoke all on function public.out_for_delivery(bigint) from public, anon;
grant execute on function public.out_for_delivery(bigint) to authenticated, service_role;

create or replace function public.mark_delivered(p_order_id bigint)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  v_fulfillment public.fulfillment_type;
  v_status public.order_status;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only Master/Admin can use the legacy delivery completion command';
  end if;

  select order_row.fulfillment, order_row.status
  into v_fulfillment, v_status
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment = 'delivery' and v_status <> 'out_for_delivery' then
    raise exception 'Delivery order % can only be completed from out_for_delivery', p_order_id;
  elsif v_fulfillment = 'pickup' and v_status <> 'ready' then
    raise exception 'Pickup order % can only be completed from ready', p_order_id;
  elsif v_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Unsupported fulfillment type for order %', p_order_id;
  end if;

  update public.orders
  set status = 'delivered'
  where id = p_order_id;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'delivered',
    (select auth.uid()),
    jsonb_build_object(
      'fulfillment', v_fulfillment,
      'delivered_by_role', 'master_or_admin'
    )
  );
end;
$function$;

revoke all on function public.mark_delivered(bigint) from public, anon;
grant execute on function public.mark_delivered(bigint) to authenticated, service_role;

-- Client search is a read command for authenticated operators only.
revoke all on function public.search_clients_unaccent(text, integer)
  from public, anon;
grant execute on function public.search_clients_unaccent(text, integer)
  to authenticated, service_role;
