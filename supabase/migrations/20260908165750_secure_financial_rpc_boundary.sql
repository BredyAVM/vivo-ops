begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Preserve the existing exchange-rate history while adding the missing
-- operational audit context for every future change.
alter table public.exchange_rates
  add column if not exists previous_rate_id bigint null,
  add column if not exists previous_rate_bs_per_usd numeric null,
  add column if not exists change_reason text null,
  add column if not exists operation_id uuid null;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'exchange_rates_previous_rate_id_fkey'
      and conrelid = 'public.exchange_rates'::regclass
  ) then
    alter table public.exchange_rates
      add constraint exchange_rates_previous_rate_id_fkey
      foreign key (previous_rate_id)
      references public.exchange_rates(id)
      on delete set null;
  end if;
end
$block$;

create unique index if not exists exchange_rates_operation_id_uk
  on public.exchange_rates(operation_id)
  where operation_id is not null;

comment on column public.exchange_rates.previous_rate_id
is 'Previous active exchange-rate row at the time this rate was created.';

comment on column public.exchange_rates.previous_rate_bs_per_usd
is 'Previous active Bs/USD value captured for a self-contained audit trail.';

comment on column public.exchange_rates.change_reason
is 'Operational reason for the exchange-rate change.';

comment on column public.exchange_rates.operation_id
is 'Idempotency key supplied by the application to prevent duplicate submissions.';

-- Quarantine legacy Studio helpers. The application no longer calls them;
-- the owner can still execute them from controlled database maintenance.
revoke all on function public.confirm_payment_report_as_user(
  uuid,
  bigint,
  bigint,
  public.currency_code,
  numeric,
  date,
  numeric,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;

revoke all on function public.reject_payment_report_as_user(uuid, bigint, text)
  from public, anon, authenticated, service_role;

alter function public.confirm_payment_report_as_user(
  uuid,
  bigint,
  bigint,
  public.currency_code,
  numeric,
  date,
  numeric,
  text,
  text,
  text,
  text
) set search_path = '';

alter function public.reject_payment_report_as_user(uuid, bigint, text)
  set search_path = '';

-- Replace the publicly executable legacy rate setter with a role-aware,
-- atomic and idempotent command. All product repricing happens in the same
-- database transaction as the rate change.
revoke all on function public.set_active_exchange_rate(numeric)
  from public, anon, authenticated, service_role;

drop function public.set_active_exchange_rate(numeric);

create function public.set_active_exchange_rate(
  p_rate_bs_per_usd numeric,
  p_operation_id uuid,
  p_reason text default 'Actualizacion diaria de la tasa general.'
)
returns public.exchange_rates
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_operation_id uuid := coalesce(p_operation_id, gen_random_uuid());
  v_reason text := coalesce(nullif(btrim(p_reason), ''), 'Actualizacion diaria de la tasa general.');
  v_previous public.exchange_rates;
  v_existing public.exchange_rates;
  v_created public.exchange_rates;
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesion para actualizar la tasa.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles ur
    where ur.user_id = v_uid
      and ur.role in ('master', 'admin')
  ) then
    raise exception 'Solo Master o Administracion puede actualizar la tasa.'
      using errcode = '42501';
  end if;

  if p_rate_bs_per_usd is null or p_rate_bs_per_usd <= 0 then
    raise exception 'La tasa debe ser mayor a 0.';
  end if;

  -- Rate changes are infrequent and this short lock guarantees that two
  -- simultaneous saves cannot leave more than one active row.
  lock table public.exchange_rates in share row exclusive mode;

  select er.*
  into v_existing
  from public.exchange_rates er
  where er.operation_id = v_operation_id;

  if found then
    if v_existing.created_by is distinct from v_uid
      or v_existing.rate_bs_per_usd is distinct from p_rate_bs_per_usd then
      raise exception 'El identificador de esta operacion ya fue utilizado.';
    end if;

    return v_existing;
  end if;

  select er.*
  into v_previous
  from public.exchange_rates er
  where er.is_active = true
  order by er.effective_at desc, er.id desc
  limit 1
  for update;

  update public.exchange_rates
  set is_active = false
  where is_active = true;

  insert into public.exchange_rates (
    rate_bs_per_usd,
    is_active,
    effective_at,
    created_by,
    previous_rate_id,
    previous_rate_bs_per_usd,
    change_reason,
    operation_id
  )
  values (
    p_rate_bs_per_usd,
    true,
    now(),
    v_uid,
    v_previous.id,
    v_previous.rate_bs_per_usd,
    v_reason,
    v_operation_id
  )
  returning * into v_created;

  update public.products
  set source_price_amount = source_price_amount
  where id > 0;

  return v_created;
end;
$function$;

revoke all on function public.set_active_exchange_rate(numeric, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_active_exchange_rate(numeric, uuid, text)
  to authenticated;

comment on function public.set_active_exchange_rate(numeric, uuid, text)
is 'Atomically changes the active rate and reprices products. Requires an authenticated Master/Admin and records actor, previous rate, reason and idempotency key.';

-- Restore the ownership boundary accidentally removed by a later wrapper
-- replacement. Master/Admin and Counter can read the operational batch;
-- advisors can read only orders attributed to themselves.
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

comment on function public.get_orders_financial_state(bigint[], date, numeric)
is 'Canonical batch financial state with role and advisor-ownership filtering.';

-- These directory helpers are used by authenticated application pages, but
-- do not need to be callable from the public/anonymous API surface.
alter function public.get_advisor_profiles() set search_path = '';
alter function public.get_driver_profiles() set search_path = '';

revoke all on function public.get_advisor_profiles()
  from public, anon;
revoke all on function public.get_driver_profiles()
  from public, anon;
grant execute on function public.get_advisor_profiles()
  to authenticated, service_role;
grant execute on function public.get_driver_profiles()
  to authenticated, service_role;

commit;
