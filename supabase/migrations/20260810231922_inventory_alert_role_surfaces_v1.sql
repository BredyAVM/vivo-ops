-- Block 29: role-specific inventory alert surfaces remain independent from
-- order actions and order-follow-up notifications.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- Counter needs the same commercial availability signal as Advisor. Internal
-- procurement, control, production and system alerts remain outside Counter.
insert into public.inventory_alert_policy_routes (
  inventory_alert_policy_id,
  target_role,
  surface
)
select
  policy.id,
  'counter'::public.user_role,
  'counter_inventory'
from public.inventory_alert_policies policy
where policy.alert_category = 'availability'
  and policy.inventory_item_id is null
  and policy.is_enabled
on conflict (
  inventory_alert_policy_id,
  target_role,
  surface
) do nothing;

comment on function public.inventory_alert_workspace_v1(text, boolean) is
  'Role- and surface-aware inventory alert center, kept separate from order action and follow-up inboxes.';
