-- Block 13E: expose commands/read models, not the underlying alert tables.

revoke all on table public.inventory_alert_policies
  from public, anon, authenticated;
revoke all on table public.inventory_alert_policy_routes
  from public, anon, authenticated;
revoke all on table public.inventory_alerts
  from public, anon, authenticated;

revoke all on function public.inventory_alert_visible_to_current_user_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.inventory_alert_visible_to_current_user_v1(bigint)
  to service_role;

comment on function public.inventory_alert_visible_to_current_user_v1(bigint) is
  'Internal RLS helper. Clients consume role- and surface-aware inventory alert RPCs.';
