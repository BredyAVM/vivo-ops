begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- These legacy SECURITY DEFINER functions predate the authenticated-only
-- RPC boundary. They remain available to the signed-in roles that use them,
-- but are no longer callable from the anonymous API surface.
alter function public.admin_list_user_roles() set search_path = '';
alter function public.is_admin() set search_path = '';
alter function public.is_master() set search_path = '';
alter function public.mark_order_modified(bigint, text) set search_path = '';
alter function public.reject_payment_report(bigint, text) set search_path = '';
alter function public.review_order_changes(bigint, boolean, text) set search_path = '';

revoke all on function public.admin_list_user_roles()
  from public, anon, authenticated, service_role;
revoke all on function public.is_admin()
  from public, anon, authenticated, service_role;
revoke all on function public.is_master()
  from public, anon, authenticated, service_role;
revoke all on function public.mark_order_modified(bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.reject_payment_report(bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.review_order_changes(bigint, boolean, text)
  from public, anon, authenticated, service_role;

grant execute on function public.admin_list_user_roles()
  to authenticated, service_role;
grant execute on function public.is_admin()
  to authenticated, service_role;
grant execute on function public.is_master()
  to authenticated, service_role;
grant execute on function public.mark_order_modified(bigint, text)
  to authenticated, service_role;
grant execute on function public.reject_payment_report(bigint, text)
  to authenticated, service_role;
grant execute on function public.review_order_changes(bigint, boolean, text)
  to authenticated, service_role;

-- Trigger and event-trigger functions do not require API EXECUTE grants.
-- Revoking those grants prevents them from appearing as callable endpoints
-- while preserving their normal automatic execution.
alter function public.trg_order_items_guard() set search_path = '';
alter function public.trg_order_items_recalc_order_total() set search_path = '';

revoke all on function public.rls_auto_enable()
  from public, anon, authenticated, service_role;
revoke all on function public.trg_order_items_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.trg_order_items_recalc_order_total()
  from public, anon, authenticated, service_role;

commit;
