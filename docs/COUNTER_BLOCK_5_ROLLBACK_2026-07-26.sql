-- Counter Block 5 emergency rollback.
--
-- Preconditions:
-- 1. Revert the Counter and Master Ops application code first.
-- 2. Run only when the guard confirms there are no production Block 5
--    receipts or pickup-change requests to preserve.

begin;

do $guard$
begin
  if exists (
    select 1
    from public.counter_command_receipts
    where command_type in (
      'update_pickup_schedule',
      'change_pickup_items',
      'decide_pickup_change',
      'complete_pickup'
    )
  ) or exists (
    select 1
    from public.counter_pickup_change_requests
  ) then
    raise exception
      'Block 5 has production operations. Reconcile and preserve them before rollback.';
  end if;
end;
$guard$;

drop function public.counter_read_pickup_change_requests(bigint);
drop function public.counter_complete_pickup(uuid, bigint, text);
drop function public.counter_decide_pickup_change(uuid, bigint, text, text);
drop function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
);
drop function public.counter_update_pickup_schedule(
  uuid,
  bigint,
  date,
  time without time zone,
  text,
  boolean
);
drop function public.counter_apply_pickup_item_plan(
  bigint,
  jsonb,
  uuid,
  text,
  boolean
);
drop function public.counter_build_pickup_item_plan(bigint, jsonb, jsonb);
drop function public.counter_pickup_order_signature(bigint);

drop table public.counter_pickup_change_requests;

alter table public.counter_command_receipts
  drop constraint counter_command_receipts_type_ck;

alter table public.counter_command_receipts
  add constraint counter_command_receipts_type_ck
  check (
    command_type in (
      'apply_order_payments',
      'record_manual_movement',
      'request_refund',
      'decide_authorization',
      'execute_refund',
      'dispatch_delivery',
      'record_delivery_return',
      'complete_delivery_digital_change',
      'close_money_account'
    )
  );

commit;
