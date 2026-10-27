CREATE OR REPLACE FUNCTION public.counter_order_change_balance_internal(p_order_id bigint)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with order_client as (
    select
      order_row.id as order_id,
      order_row.client_id,
      greatest(0, coalesce(client.fund_balance_usd, 0))::numeric as client_balance_usd
    from public.orders order_row
    join public.clients client
      on client.id = order_row.client_id
    where order_row.id = p_order_id
  ),
  order_fund as (
    select
      fund.order_id,
      round(coalesce(sum(
        case
          when fund.movement_type = 'credit'
            and fund.reason_code in ('payment_overage_stored', 'retention_overage_stored')
            then fund.amount_usd
          when fund.movement_type = 'debit'
            and fund.reason_code in (
              'counter_change_fund_reversal',
              'client_fund_payout',
              'payment_void_fund_reversal',
              'counter_change_waived'
            )
            then -fund.amount_usd
          when fund.movement_type = 'debit'
            and fund.reason_code = 'counter_change_given'
            and exists (
              select 1
              from public.counter_command_receipts receipt
              join public.money_movements movement
                on movement.order_id = receipt.order_id
               and movement.movement_group_id = receipt.idempotency_key
               and movement.status = 'confirmed'
               and movement.direction = 'outflow'
               and movement.movement_type = 'change_given'
              where receipt.command_type = 'give_order_change'
                and receipt.status = 'completed'
                and receipt.order_id = fund.order_id
                and receipt.idempotency_key = fund.movement_group_id
            )
            then -fund.amount_usd
          else 0
        end
      ), 0), 2) as available_from_order_usd
    from public.client_fund_movements fund
    where fund.order_id = p_order_id
    group by fund.order_id
  )
  select round(greatest(
    0,
    least(
      order_client.client_balance_usd,
      greatest(0, coalesce(order_fund.available_from_order_usd, 0))
    )
  ), 2)
  from order_client
  left join order_fund
    on order_fund.order_id = order_client.order_id;
$function$
;

CREATE OR REPLACE FUNCTION public.void_financial_movement_v1(p_movement_id bigint, p_group_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$ select app_private.void_financial_movement_v1(p_movement_id,p_group_id,p_reason); $function$
;
