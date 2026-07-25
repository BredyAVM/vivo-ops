-- Run only after reverting the Counter application code that calls these RPCs.

begin;

drop function if exists public.counter_read_pending_settlements(timestamptz, bigint, integer);
drop function if exists public.counter_search_orders(text, timestamptz, bigint, integer);
drop function if exists public.counter_search_clients(text, bigint, integer);
drop function if exists public.counter_read_cash_snapshot(integer);
drop function if exists public.counter_read_catalog();
drop function if exists public.counter_read_order_detail(bigint);
drop function if exists public.counter_read_active_queue(integer);
drop function if exists public.counter_read_configuration();

commit;
