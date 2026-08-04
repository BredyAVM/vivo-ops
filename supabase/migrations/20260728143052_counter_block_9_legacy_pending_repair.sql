-- Give legacy pending Counter expenses an authorization group.
-- This changes no amount, status, account balance or accounting date.

begin;

update public.money_movements movement
set movement_group_id = gen_random_uuid()
where movement.status = 'pending'
  and movement.approval_required = true
  and movement.movement_type = 'expense_payment'
  and movement.order_id is null
  and movement.payment_report_id is null
  and movement.movement_group_id is null
  and public.is_counter_direct_money_account(movement.money_account_id);

commit;
