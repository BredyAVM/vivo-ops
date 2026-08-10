-- Authorized, chronological financial activity for one order.
--
-- The function projects confirmed ledger facts into operational moments. It
-- never creates, edits or reinterprets balances. Counter temporarily stores
-- the full overpayment before reversing cash change, so fund_stored is exposed
-- as the net of those same-timestamp fund rows.

begin;

create or replace function public.read_order_financial_activity(
  p_order_id bigint
)
returns table (
  activity_key text,
  activity_type text,
  activity_sequence integer,
  occurred_at timestamptz,
  operation_date date,
  currency_code text,
  amount numeric,
  amount_usd numeric,
  money_account_id bigint,
  money_account_name text,
  reference_code text,
  notes text,
  actor_user_id uuid,
  actor_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_authorized boolean := false;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select exists (
    select 1
    from public.orders order_row
    where order_row.id = p_order_id
      and (
        public.is_master_or_admin()
        or (
          public.has_role('advisor'::text)
          and order_row.attributed_advisor_id = v_uid
        )
      )
  )
  into v_authorized;

  if not v_authorized then
    raise exception 'Order financial activity is not available to this user'
      using errcode = '42501';
  end if;

  return query
  with money_activity as (
    select
      ('money:' || movement.id::text)::text as activity_key,
      case
        when movement.direction = 'inflow'
          and movement.movement_type = 'order_payment'
          then 'payment_received'
        when movement.direction = 'outflow'
          and movement.movement_type = 'change_given'
          then 'change_given'
        when movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
          then 'refund_paid'
      end::text as activity_type,
      case
        when movement.direction = 'inflow' then 10
        when movement.movement_type = 'change_given' then 20
        else 60
      end::integer as activity_sequence,
      movement.created_at as occurred_at,
      movement.movement_date as operation_date,
      movement.currency_code::text as currency_code,
      movement.amount as amount,
      movement.amount_usd_equivalent as amount_usd,
      movement.money_account_id,
      account.name::text as money_account_name,
      movement.reference_code,
      coalesce(movement.notes, movement.description)::text as notes,
      movement.created_by_user_id as actor_user_id,
      coalesce(nullif(btrim(profile.full_name), ''), 'Usuario')::text as actor_name
    from public.money_movements movement
    left join public.money_accounts account
      on account.id = movement.money_account_id
    left join public.profiles profile
      on profile.id = movement.created_by_user_id
    where movement.order_id = p_order_id
      and movement.status = 'confirmed'
      and (
        (movement.direction = 'inflow' and movement.movement_type = 'order_payment')
        or
        (movement.direction = 'outflow' and movement.movement_type in ('change_given', 'withdrawal'))
      )
  ),
  fund_stored_activity as (
    select
      ('fund-store:' || min(fund.id)::text)::text as activity_key,
      'fund_stored'::text as activity_type,
      30::integer as activity_sequence,
      fund.created_at as occurred_at,
      (fund.created_at at time zone 'America/Caracas')::date as operation_date,
      'USD'::text as currency_code,
      round(sum(
        case
          when fund.movement_type = 'credit' then fund.amount_usd
          when fund.reason_code = 'counter_change_fund_reversal' then -fund.amount_usd
          else 0
        end
      ), 2) as amount,
      round(sum(
        case
          when fund.movement_type = 'credit' then fund.amount_usd
          when fund.reason_code = 'counter_change_fund_reversal' then -fund.amount_usd
          else 0
        end
      ), 2) as amount_usd,
      null::bigint as money_account_id,
      null::text as money_account_name,
      null::text as reference_code,
      'Excedente neto guardado en el fondo del cliente.'::text as notes,
      fund.created_by_user_id as actor_user_id,
      coalesce(nullif(btrim(profile.full_name), ''), 'Usuario')::text as actor_name
    from public.client_fund_movements fund
    left join public.profiles profile
      on profile.id = fund.created_by_user_id
    where fund.order_id = p_order_id
      and fund.reason_code in (
        'payment_overage_stored',
        'retention_overage_stored',
        'counter_change_fund_reversal'
      )
    group by fund.created_at, fund.created_by_user_id, profile.full_name
    having round(sum(
      case
        when fund.movement_type = 'credit' then fund.amount_usd
        when fund.reason_code = 'counter_change_fund_reversal' then -fund.amount_usd
        else 0
      end
    ), 2) > 0.005
  ),
  other_fund_activity as (
    select
      ('fund:' || fund.id::text)::text as activity_key,
      case fund.reason_code
        when 'client_fund_payout' then 'fund_paid_out'
        when 'order_fund_applied' then 'fund_applied'
        when 'order_fund_restore' then 'fund_restored'
        when 'payment_void_fund_reversal' then 'fund_reversed'
      end::text as activity_type,
      case fund.reason_code
        when 'order_fund_applied' then 15
        when 'order_fund_restore' then 40
        when 'payment_void_fund_reversal' then 50
        else 70
      end::integer as activity_sequence,
      fund.created_at as occurred_at,
      (fund.created_at at time zone 'America/Caracas')::date as operation_date,
      upper(fund.currency_code)::text as currency_code,
      fund.amount,
      fund.amount_usd,
      fund.money_account_id,
      account.name::text as money_account_name,
      null::text as reference_code,
      fund.notes,
      fund.created_by_user_id as actor_user_id,
      coalesce(nullif(btrim(profile.full_name), ''), 'Usuario')::text as actor_name
    from public.client_fund_movements fund
    left join public.money_accounts account
      on account.id = fund.money_account_id
    left join public.profiles profile
      on profile.id = fund.created_by_user_id
    where fund.order_id = p_order_id
      and fund.reason_code in (
        'client_fund_payout',
        'order_fund_applied',
        'order_fund_restore',
        'payment_void_fund_reversal'
      )
  ),
  combined as (
    select * from money_activity
    union all
    select * from fund_stored_activity
    union all
    select * from other_fund_activity
  )
  select
    combined.activity_key,
    combined.activity_type,
    combined.activity_sequence,
    combined.occurred_at,
    combined.operation_date,
    combined.currency_code,
    combined.amount,
    combined.amount_usd,
    combined.money_account_id,
    combined.money_account_name,
    combined.reference_code,
    combined.notes,
    combined.actor_user_id,
    combined.actor_name
  from combined
  where combined.activity_type is not null
  order by combined.occurred_at, combined.activity_sequence, combined.activity_key;
end;
$$;

revoke all on function public.read_order_financial_activity(bigint)
  from public, anon;

grant execute on function public.read_order_financial_activity(bigint)
  to authenticated, service_role;

commit;
