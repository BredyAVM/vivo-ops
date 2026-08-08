-- Block 13D: prevent operational adapters from bypassing surface filtering.

create or replace function public.inventory_alert_visible_to_current_user_v1(
  p_alert_id bigint
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_category text;
  v_inventory_item_id bigint;
  v_policy_id bigint;
  v_enabled boolean;
begin
  if v_actor is null or p_alert_id is null then
    return false;
  end if;

  if exists (
    select 1
    from public.user_roles actor_role
    where actor_role.user_id = v_actor
      and actor_role.role = 'admin'
  ) then
    return true;
  end if;

  if not exists (
    select 1
    from public.user_roles actor_role
    where actor_role.user_id = v_actor
      and actor_role.role = 'master'
  ) then
    return false;
  end if;

  select alert.alert_category, alert.inventory_item_id
  into v_category, v_inventory_item_id
  from public.inventory_alerts alert
  where alert.id = p_alert_id;

  if not found then
    return false;
  end if;

  select policy.id, policy.is_enabled
  into v_policy_id, v_enabled
  from public.inventory_alert_policies policy
  where policy.alert_category = v_category
    and (
      policy.inventory_item_id = v_inventory_item_id
      or policy.inventory_item_id is null
    )
  order by (policy.inventory_item_id is not null) desc
  limit 1;

  if not found or not v_enabled then
    return false;
  end if;

  return exists (
    select 1
    from public.inventory_alert_policy_routes route
    where route.inventory_alert_policy_id = v_policy_id
      and route.target_role = 'master'
      and route.surface in ('inventory_center', 'master_inventory')
  );
end;
$$;

revoke all on function public.inventory_alert_visible_to_current_user_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.inventory_alert_visible_to_current_user_v1(bigint)
  to service_role;

comment on function public.inventory_alert_visible_to_current_user_v1(bigint) is
  'RLS helper for direct center reads; operational roles use the surface-aware workspace RPC.';
