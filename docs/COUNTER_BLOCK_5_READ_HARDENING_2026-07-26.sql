-- Counter Block 5: keep pickup-change reads behind the bounded, role-aware RPC.
-- Apply after COUNTER_BLOCK_5_PICKUP_OPERATION_2026-07-26.sql.

begin;

revoke select on table public.counter_pickup_change_requests
  from authenticated;

commit;
