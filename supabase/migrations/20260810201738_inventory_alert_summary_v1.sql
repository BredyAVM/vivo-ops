-- Lightweight, authorized alert counts for operational headers.
-- Detection is refreshed first, but the response does not carry alert rows,
-- policy configuration, item catalogs, or the reporting workspace payload.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.inventory_alert_summary_v1(
  p_surface text default 'inventory_center'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_is_master boolean;
  v_refresh jsonb;
  v_summary jsonb;
begin
  if v_actor is null then
    raise exception 'No autenticado.' using errcode = '42501';
  end if;

  if p_surface not in (
    'inventory_center',
    'advisor_availability',
    'master_inventory',
    'kitchen_inventory',
    'counter_inventory',
    'admin_inventory'
  ) then
    raise exception 'La ubicación de alertas no es válida.' using errcode = '22023';
  end if;

  v_is_admin := public.has_role('admin');
  v_is_master := public.has_role('master');

  if not v_is_admin and not (
    (p_surface = 'inventory_center' and v_is_master)
    or (p_surface = 'master_inventory' and v_is_master)
    or (p_surface = 'advisor_availability' and public.has_role('advisor'))
    or (p_surface = 'kitchen_inventory' and public.has_role('kitchen'))
    or (p_surface = 'counter_inventory' and public.has_role('counter'))
  ) then
    raise exception 'No autorizado para esta ubicación de alertas.' using errcode = '42501';
  end if;

  v_refresh := app_private.inventory_refresh_alerts_core_v1();

  with visible_alerts as (
    select alert.status, alert.severity, alert.requires_action
    from public.inventory_alerts alert
    join lateral (
      select policy.id, policy.is_enabled
      from public.inventory_alert_policies policy
      where policy.alert_category = alert.alert_category
        and (
          policy.inventory_item_id = alert.inventory_item_id
          or policy.inventory_item_id is null
        )
      order by (policy.inventory_item_id is not null) desc
      limit 1
    ) effective_policy on effective_policy.is_enabled
    where alert.status <> 'resolved'
      and (
        (v_is_admin and p_surface in ('inventory_center', 'admin_inventory'))
        or exists (
          select 1
          from public.inventory_alert_policy_routes route
          join public.user_roles actor_role
            on actor_role.user_id = v_actor
           and actor_role.role = route.target_role
          where route.inventory_alert_policy_id = effective_policy.id
            and route.surface = p_surface
        )
      )
  )
  select jsonb_build_object(
    'active', count(*),
    'open', count(*) filter (where status = 'open'),
    'managed', count(*) filter (where status = 'managed'),
    'critical', count(*) filter (where severity = 'critical'),
    'requires_action', count(*) filter (where requires_action)
  )
  into v_summary
  from visible_alerts;

  return jsonb_build_object(
    'surface', p_surface,
    'generated_at', now(),
    'refresh', v_refresh,
    'summary', coalesce(v_summary, jsonb_build_object(
      'active', 0,
      'open', 0,
      'managed', 0,
      'critical', 0,
      'requires_action', 0
    ))
  );
end;
$$;

revoke all on function public.inventory_alert_summary_v1(text)
  from public, anon;
grant execute on function public.inventory_alert_summary_v1(text)
  to authenticated, service_role;

comment on function public.inventory_alert_summary_v1(text) is
  'Refreshes canonical alert detection and returns only authorized active counts for a surface.';
