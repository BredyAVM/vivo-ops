-- Authorized order-level read model for client fund payouts.
--
-- client_fund_movements remains the canonical customer-fund ledger. This RPC
-- exposes only confirmed payout debits linked to one order, so the attributed
-- advisor can see the same operation that master/admin already sees without
-- granting advisor-wide access to the client's fund history.

begin;

create or replace function public.read_order_client_fund_payouts(
  p_order_id bigint
)
returns table (
  id bigint,
  order_id bigint,
  currency_code text,
  amount numeric,
  amount_usd numeric,
  money_account_id bigint,
  money_account_name text,
  notes text,
  created_at timestamptz,
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
    raise exception 'Order fund payout history is not available to this user'
      using errcode = '42501';
  end if;

  return query
  select
    fund.id,
    fund.order_id,
    upper(fund.currency_code)::text,
    fund.amount,
    fund.amount_usd,
    fund.money_account_id,
    coalesce(account.name, 'Cuenta')::text,
    fund.notes,
    fund.created_at,
    fund.created_by_user_id,
    coalesce(nullif(btrim(profile.full_name), ''), 'Usuario')::text
  from public.client_fund_movements fund
  left join public.money_accounts account
    on account.id = fund.money_account_id
  left join public.profiles profile
    on profile.id = fund.created_by_user_id
  where fund.order_id = p_order_id
    and fund.movement_type = 'debit'
    and fund.reason_code = 'client_fund_payout'
  order by fund.created_at desc, fund.id desc;
end;
$$;

revoke all on function public.read_order_client_fund_payouts(bigint)
  from public, anon;

grant execute on function public.read_order_client_fund_payouts(bigint)
  to authenticated, service_role;

commit;
