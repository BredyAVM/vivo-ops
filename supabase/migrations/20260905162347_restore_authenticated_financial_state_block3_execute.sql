-- Restore the authenticated execution path used by Master Ops, Advisor and
-- other server actions that read the canonical per-order financial state.
-- The 20260827165032 replacement accidentally restricted this inner helper to
-- service_role even though get_order_financial_state remains security invoker.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke all on function public.get_order_financial_state_block3(
  bigint,
  date,
  numeric
) from public, anon;

grant execute on function public.get_order_financial_state_block3(
  bigint,
  date,
  numeric
) to authenticated, service_role;

commit;
