-- Block 13C: alert configuration, lifecycle commands and role-aware workspace.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.inventory_save_alert_policy_v1(
  p_alert_category text,
  p_inventory_item_id bigint,
  p_is_enabled boolean,
  p_routes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_policy_id bigint;
  v_route_count integer;
  v_distinct_route_count integer;
begin
  if v_actor is null then
    raise exception 'No autenticado.' using errcode = '42501';
  end if;
  if not public.has_role('admin') then
    raise exception 'Solo administración puede configurar las alertas de inventario.'
      using errcode = '42501';
  end if;
  if p_alert_category not in (
    'availability', 'commitment', 'production', 'control', 'procurement', 'system'
  ) then
    raise exception 'La categoría de alerta no es válida.' using errcode = '22023';
  end if;
  if p_is_enabled is null then
    raise exception 'Debes indicar si la política está activa.' using errcode = '22023';
  end if;
  if p_routes is null or jsonb_typeof(p_routes) <> 'array' then
    raise exception 'Las rutas deben enviarse como una lista.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_routes) > 20 then
    raise exception 'Una política admite hasta 20 rutas.' using errcode = '22023';
  end if;
  if p_is_enabled and jsonb_array_length(p_routes) = 0 then
    raise exception 'Una política activa requiere al menos una ruta.' using errcode = '22023';
  end if;
  if not p_is_enabled and jsonb_array_length(p_routes) > 0 then
    raise exception 'Una política desactivada no debe conservar rutas.' using errcode = '22023';
  end if;

  if p_inventory_item_id is not null and not exists (
    select 1 from public.inventory_items item where item.id = p_inventory_item_id
  ) then
    raise exception 'El ítem de inventario no existe.' using errcode = 'P0002';
  end if;

  with routes as (
    select
      nullif(btrim(route.value ->> 'target_role'), '') as target_role,
      nullif(btrim(route.value ->> 'surface'), '') as surface
    from jsonb_array_elements(p_routes) route(value)
  )
  select count(*), count(distinct (target_role, surface))
  into v_route_count, v_distinct_route_count
  from routes;

  if v_route_count <> v_distinct_route_count then
    raise exception 'Una ruta no puede repetirse.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_routes) route(value)
    where not (
      (route.value ->> 'target_role' = 'admin'
        and route.value ->> 'surface' in ('inventory_center', 'admin_inventory'))
      or (route.value ->> 'target_role' = 'master'
        and route.value ->> 'surface' in ('inventory_center', 'master_inventory'))
      or (route.value ->> 'target_role' = 'advisor'
        and route.value ->> 'surface' = 'advisor_availability')
      or (route.value ->> 'target_role' = 'kitchen'
        and route.value ->> 'surface' = 'kitchen_inventory')
      or (route.value ->> 'target_role' = 'counter'
        and route.value ->> 'surface' = 'counter_inventory')
    )
  ) then
    raise exception 'La política contiene una combinación de rol y ubicación no válida.'
      using errcode = '22023';
  end if;

  select policy.id
  into v_policy_id
  from public.inventory_alert_policies policy
  where policy.alert_category = p_alert_category
    and policy.inventory_item_id is not distinct from p_inventory_item_id
  for update;

  if not found then
    insert into public.inventory_alert_policies (
      alert_category,
      inventory_item_id,
      is_enabled,
      created_by_user_id,
      updated_by_user_id
    )
    values (
      p_alert_category,
      p_inventory_item_id,
      p_is_enabled,
      v_actor,
      v_actor
    )
    returning id into v_policy_id;
  else
    update public.inventory_alert_policies
    set is_enabled = p_is_enabled,
        updated_by_user_id = v_actor,
        updated_at = now()
    where id = v_policy_id;
  end if;

  delete from public.inventory_alert_policy_routes
  where inventory_alert_policy_id = v_policy_id;

  if p_is_enabled then
    insert into public.inventory_alert_policy_routes (
      inventory_alert_policy_id,
      target_role,
      surface
    )
    select
      v_policy_id,
      (route.value ->> 'target_role')::public.user_role,
      route.value ->> 'surface'
    from jsonb_array_elements(p_routes) route(value);
  end if;

  perform app_private.inventory_refresh_alerts_core_v1();

  return jsonb_build_object(
    'status', 'applied',
    'policy_id', v_policy_id,
    'alert_category', p_alert_category,
    'inventory_item_id', p_inventory_item_id,
    'is_enabled', p_is_enabled,
    'route_count', jsonb_array_length(p_routes)
  );
end;
$$;

revoke all on function public.inventory_save_alert_policy_v1(
  text, bigint, boolean, jsonb
) from public, anon;
grant execute on function public.inventory_save_alert_policy_v1(
  text, bigint, boolean, jsonb
) to authenticated, service_role;

create or replace function public.inventory_delete_alert_policy_override_v1(
  p_alert_category text,
  p_inventory_item_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_deleted integer;
begin
  if v_actor is null then
    raise exception 'No autenticado.' using errcode = '42501';
  end if;
  if not public.has_role('admin') then
    raise exception 'Solo administración puede eliminar una excepción de alertas.'
      using errcode = '42501';
  end if;
  if p_inventory_item_id is null then
    raise exception 'La política global no puede eliminarse.' using errcode = '22023';
  end if;
  if p_alert_category not in (
    'availability', 'commitment', 'production', 'control', 'procurement', 'system'
  ) then
    raise exception 'La categoría de alerta no es válida.' using errcode = '22023';
  end if;

  delete from public.inventory_alert_policies policy
  where policy.alert_category = p_alert_category
    and policy.inventory_item_id = p_inventory_item_id;
  get diagnostics v_deleted = row_count;

  perform app_private.inventory_refresh_alerts_core_v1();

  return jsonb_build_object(
    'status', case when v_deleted = 0 then 'not_found' else 'deleted' end,
    'alert_category', p_alert_category,
    'inventory_item_id', p_inventory_item_id
  );
end;
$$;

revoke all on function public.inventory_delete_alert_policy_override_v1(text, bigint)
  from public, anon;
grant execute on function public.inventory_delete_alert_policy_override_v1(text, bigint)
  to authenticated, service_role;

create or replace function public.inventory_update_item_alert_settings_v1(
  p_inventory_item_id bigint,
  p_low_stock_threshold numeric,
  p_low_stock_inclusive boolean,
  p_target_stock_units numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.inventory_items%rowtype;
begin
  if v_actor is null then
    raise exception 'No autenticado.' using errcode = '42501';
  end if;
  if not public.has_role('admin') then
    raise exception 'Solo administración puede cambiar umbrales y objetivos.'
      using errcode = '42501';
  end if;
  if p_inventory_item_id is null then
    raise exception 'El ítem es obligatorio.' using errcode = '22023';
  end if;
  if p_low_stock_threshold is not null and p_low_stock_threshold < 0 then
    raise exception 'El umbral no puede ser negativo.' using errcode = '22023';
  end if;
  if p_target_stock_units is not null and p_target_stock_units < 0 then
    raise exception 'El objetivo no puede ser negativo.' using errcode = '22023';
  end if;
  if p_low_stock_threshold is not null
    and p_target_stock_units is not null
    and p_target_stock_units < p_low_stock_threshold
  then
    raise exception 'El objetivo no puede ser menor que el umbral.' using errcode = '22023';
  end if;

  update public.inventory_items item
  set low_stock_threshold = p_low_stock_threshold,
      low_stock_inclusive = coalesce(p_low_stock_inclusive, true),
      target_stock_units = p_target_stock_units
  where item.id = p_inventory_item_id
  returning item.* into v_item;

  if not found then
    raise exception 'El ítem de inventario no existe.' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'inventory_item_id', v_item.id,
    'low_stock_threshold', v_item.low_stock_threshold,
    'low_stock_inclusive', v_item.low_stock_inclusive,
    'target_stock_units', v_item.target_stock_units
  );
end;
$$;

revoke all on function public.inventory_update_item_alert_settings_v1(
  bigint, numeric, boolean, numeric
) from public, anon;
grant execute on function public.inventory_update_item_alert_settings_v1(
  bigint, numeric, boolean, numeric
) to authenticated, service_role;

create or replace function public.inventory_update_alert_status_v1(
  p_alert_id bigint,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_alert public.inventory_alerts%rowtype;
  v_is_admin boolean;
  v_is_master boolean;
begin
  if v_actor is null then
    raise exception 'No autenticado.' using errcode = '42501';
  end if;
  v_is_admin := public.has_role('admin');
  v_is_master := public.has_role('master');
  if not (v_is_admin or v_is_master) then
    raise exception 'Solo Master o administración pueden gestionar alertas.'
      using errcode = '42501';
  end if;
  if p_alert_id is null or p_action not in ('manage', 'resolve', 'reopen') then
    raise exception 'La alerta o la acción no son válidas.' using errcode = '22023';
  end if;
  if p_note is not null and char_length(btrim(p_note)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;
  if p_action in ('resolve', 'reopen') and not v_is_admin then
    raise exception 'Solo administración puede resolver o reabrir manualmente una alerta.'
      using errcode = '42501';
  end if;
  if not v_is_admin and not public.inventory_alert_visible_to_current_user_v1(p_alert_id) then
    raise exception 'La alerta no está dirigida a tus roles.' using errcode = '42501';
  end if;

  select alert.*
  into v_alert
  from public.inventory_alerts alert
  where alert.id = p_alert_id
  for update;

  if not found then
    raise exception 'La alerta no existe.' using errcode = 'P0002';
  end if;

  if p_action = 'manage' then
    if v_alert.status = 'resolved' then
      raise exception 'Una alerta resuelta debe reabrirse antes de gestionarla.' using errcode = '22023';
    end if;
    update public.inventory_alerts
    set status = 'managed',
        managed_by_user_id = v_actor,
        managed_at = now(),
        updated_at = now(),
        details = details || jsonb_build_object(
          'management_source', 'manual',
          'management_note', nullif(btrim(p_note), '')
        )
    where id = v_alert.id;
  elsif p_action = 'resolve' then
    update public.inventory_alerts
    set status = 'resolved',
        resolved_by_user_id = v_actor,
        resolved_at = now(),
        updated_at = now(),
        details = details || jsonb_build_object(
          'resolution_source', 'manual',
          'resolution_note', nullif(btrim(p_note), '')
        )
    where id = v_alert.id;
  else
    update public.inventory_alerts
    set status = 'open',
        managed_by_user_id = null,
        managed_at = null,
        resolved_by_user_id = null,
        resolved_at = null,
        updated_at = now(),
        details = (details - 'resolution_source' - 'resolution_note' - 'resolved_reason')
          || jsonb_build_object('reopened_by_user_id', v_actor, 'reopened_at', now())
    where id = v_alert.id;
  end if;

  select alert.* into v_alert
  from public.inventory_alerts alert
  where alert.id = p_alert_id;

  return jsonb_build_object(
    'status', 'applied',
    'alert_id', v_alert.id,
    'alert_status', v_alert.status,
    'updated_at', v_alert.updated_at
  );
end;
$$;

revoke all on function public.inventory_update_alert_status_v1(bigint, text, text)
  from public, anon;
grant execute on function public.inventory_update_alert_status_v1(bigint, text, text)
  to authenticated, service_role;

create or replace function public.inventory_alert_workspace_v1(
  p_surface text default 'inventory_center',
  p_include_resolved boolean default true
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
  v_alerts jsonb;
  v_summary jsonb;
  v_policies jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
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
    select
      alert.*,
      item.name as inventory_item_name,
      item.unit_name,
      order_row.order_number,
      effective_policy.id as policy_id,
      effective_policy.is_enabled
    from public.inventory_alerts alert
    left join public.inventory_items item on item.id = alert.inventory_item_id
    left join public.orders order_row on order_row.id = alert.order_id
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
    where (p_include_resolved or alert.status <> 'resolved')
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
  ), limited_alerts as (
    select *
    from visible_alerts
    order by
      (status = 'resolved'),
      case severity when 'critical' then 1 when 'warning' then 2 else 3 end,
      last_detected_at desc,
      id desc
    limit 300
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', alert.id,
    'alert_key', alert.alert_key,
    'category', alert.alert_category,
    'type', alert.alert_type,
    'severity', alert.severity,
    'requires_action', alert.requires_action,
    'status', alert.status,
    'inventory_item_id', alert.inventory_item_id,
    'inventory_item_name', alert.inventory_item_name,
    'unit_name', alert.unit_name,
    'order_id', alert.order_id,
    'order_number', alert.order_number,
    'planned_flow_id', alert.planned_flow_id,
    'inventory_count_id', alert.inventory_count_id,
    'title', alert.title,
    'message', alert.message,
    'details', case
      when p_surface = 'advisor_availability' then jsonb_strip_nulls(jsonb_build_object(
        'available_without_affecting_commitments', alert.details -> 'available_without_affecting_commitments',
        'next_available_at', alert.details -> 'next_available_at',
        'affected_products', alert.details -> 'affected_products'
      ))
      else alert.details
    end,
    'first_detected_at', alert.first_detected_at,
    'last_detected_at', alert.last_detected_at,
    'managed_at', alert.managed_at,
    'resolved_at', alert.resolved_at,
    'created_at', alert.created_at,
    'updated_at', alert.updated_at
  ) order by
    (alert.status = 'resolved'),
    case alert.severity when 'critical' then 1 when 'warning' then 2 else 3 end,
    alert.last_detected_at desc,
    alert.id desc
  ), '[]'::jsonb)
  into v_alerts
  from limited_alerts alert;

  select jsonb_build_object(
    'open', count(*) filter (where row_value ->> 'status' = 'open'),
    'managed', count(*) filter (where row_value ->> 'status' = 'managed'),
    'resolved', count(*) filter (where row_value ->> 'status' = 'resolved'),
    'critical', count(*) filter (
      where row_value ->> 'severity' = 'critical'
        and row_value ->> 'status' <> 'resolved'
    ),
    'requires_action', count(*) filter (
      where (row_value ->> 'requires_action')::boolean
        and row_value ->> 'status' <> 'resolved'
    )
  )
  into v_summary
  from jsonb_array_elements(v_alerts) alert_row(row_value);

  if v_is_admin then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', policy.id,
      'category', policy.alert_category,
      'inventory_item_id', policy.inventory_item_id,
      'is_enabled', policy.is_enabled,
      'routes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'target_role', route.target_role,
          'surface', route.surface
        ) order by route.target_role, route.surface)
        from public.inventory_alert_policy_routes route
        where route.inventory_alert_policy_id = policy.id
      ), '[]'::jsonb),
      'updated_at', policy.updated_at
    ) order by policy.inventory_item_id nulls first, policy.alert_category), '[]'::jsonb)
    into v_policies
    from public.inventory_alert_policies policy;

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', item.id,
      'name', item.name,
      'unit_name', item.unit_name,
      'inventory_group', item.inventory_group,
      'tracking_mode', item.tracking_mode,
      'is_active', item.is_active,
      'low_stock_threshold', item.low_stock_threshold,
      'low_stock_inclusive', item.low_stock_inclusive,
      'target_stock_units', item.target_stock_units
    ) order by item.name, item.id), '[]'::jsonb)
    into v_items
    from public.inventory_items item
    where item.merged_into_item_id is null;
  end if;

  return jsonb_build_object(
    'surface', p_surface,
    'generated_at', now(),
    'refresh', v_refresh,
    'summary', coalesce(v_summary, jsonb_build_object(
      'open', 0,
      'managed', 0,
      'resolved', 0,
      'critical', 0,
      'requires_action', 0
    )),
    'alerts', v_alerts,
    'configuration', jsonb_build_object(
      'can_configure', v_is_admin,
      'policies', v_policies,
      'items', v_items
    )
  );
end;
$$;

revoke all on function public.inventory_alert_workspace_v1(text, boolean)
  from public, anon;
grant execute on function public.inventory_alert_workspace_v1(text, boolean)
  to authenticated, service_role;

comment on function public.inventory_save_alert_policy_v1(text, bigint, boolean, jsonb) is
  'Admin command that atomically replaces category or item-specific role/surface routes.';
comment on function public.inventory_update_item_alert_settings_v1(bigint, numeric, boolean, numeric) is
  'Admin command that reuses the canonical item threshold and target fields.';
comment on function public.inventory_update_alert_status_v1(bigint, text, text) is
  'Manages the operational lifecycle without changing the underlying inventory fact.';
comment on function public.inventory_alert_workspace_v1(text, boolean) is
  'Role-aware, lazy-loaded Inventory Alert Center read model with configuration for administrators.';
