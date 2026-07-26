-- Counter Block 4 emergency rollback
--
-- Preconditions:
-- 1. Revert the Counter application code first.
-- 2. Run this only if the guard below confirms that no Block 4 command has
--    persisted production money, fund reversals, or digital obligations.
-- 3. Immediately reapply COUNTER_BLOCK_3_LIGHT_READ_MODEL_2026-07-25.sql
--    after this script to restore counter_read_order_detail().

begin;

do $guard$
begin
  if exists (select 1 from public.order_change_obligations)
     or exists (
       select 1
       from public.client_fund_movements
       where reason_code = 'counter_change_fund_reversal'
     )
     or exists (
       select 1
       from public.counter_command_receipts
       where command_type = 'apply_order_payments'
         and result_payload ? 'cash_change_usd'
     ) then
    raise exception
      'Block 4 has production operations. Reconcile them before changing financial functions or dropping obligations.';
  end if;
end;
$guard$;

drop function public.counter_read_order_detail(bigint);

drop function public.counter_request_refund(uuid, bigint, jsonb, text);
alter function public.counter_request_refund_block2(
  uuid,
  bigint,
  jsonb,
  text
) rename to counter_request_refund;
revoke all on function public.counter_request_refund(uuid, bigint, jsonb, text)
  from public, anon;
grant execute on function public.counter_request_refund(uuid, bigint, jsonb, text)
  to authenticated, service_role;

drop function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
);
alter function public.counter_apply_order_payments_block2(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) rename to counter_apply_order_payments;
revoke all on function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) from public, anon;
grant execute on function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) to authenticated, service_role;

drop function public.get_orders_financial_state(bigint[], date, numeric);
drop function public.get_order_financial_state(bigint, date, numeric);
alter function public.get_order_financial_state_block3(
  bigint,
  date,
  numeric
) rename to get_order_financial_state;

create function public.get_orders_financial_state(
  p_order_ids bigint[],
  p_operation_date date default null,
  p_active_bs_rate numeric default null
)
returns table (
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
  select state.*
  from unnest(coalesce(p_order_ids, array[]::bigint[])) ids(order_id)
  cross join lateral public.get_order_financial_state(
    ids.order_id,
    p_operation_date,
    p_active_bs_rate
  ) state;
$function$;

revoke all on function public.get_orders_financial_state(bigint[], date, numeric)
  from public, anon;
grant execute on function public.get_orders_financial_state(bigint[], date, numeric)
  to authenticated, service_role;

drop table public.order_change_obligations;

commit;

-- Required next step:
-- Reapply docs/COUNTER_BLOCK_3_LIGHT_READ_MODEL_2026-07-25.sql so the
-- on-demand detail RPC is recreated without Block 4 fields.
