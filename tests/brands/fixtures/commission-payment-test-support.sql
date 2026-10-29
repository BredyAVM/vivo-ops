-- Minimal account/collection dependencies; the payment function itself is the unchanged production fixture plus the Muérdeme guard.
create table public.money_accounts(id bigint primary key,currency_code text,is_active boolean);
insert into public.money_accounts values(1,'USD',true);
create table public.commission_payment_operations(request_id uuid primary key,closure_id bigint,payment_movement_id bigint,fee_movement_id bigint,created_by uuid,request jsonb,result jsonb);
create table public.commission_payment_reversals(payment_request_id uuid);
create table public.advisor_commission_deductions(closure_id bigint,deduction_type text,amount_usd numeric);
create table public.advisor_commission_carry_transfers(source_closure_id bigint);
create table public.money_movements(id bigint generated always as identity,movement_date date,created_by_user_id uuid,confirmed_at timestamptz,confirmed_by_user_id uuid,
 direction text,movement_type text,money_account_id bigint,currency_code text,amount numeric,exchange_rate_ves_per_usd numeric,amount_usd_equivalent numeric,
 reference_code text,counterparty_name text,description text,movement_group_id uuid,status text,approval_required boolean);
alter table public.advisor_commission_closures add column manual_deductions_usd numeric default 0,add column paid_at timestamptz,add column paid_by_user_id uuid;
alter table public.advisor_commission_periods add column name text default 'Semana de prueba';
create function app_private.commission_collection_state_v1(bigint)returns jsonb language sql stable as $$
 select jsonb_build_object('orderIds','[]'::jsonb,'pendingUsd',c.payable_usd-coalesce((select sum(m.amount_usd_equivalent)
  from public.commission_payment_operations o join public.money_movements m on m.id=o.payment_movement_id where o.closure_id=c.id and m.status='confirmed'),0))
 from public.advisor_commission_closures c where c.id=$1;
$$;
