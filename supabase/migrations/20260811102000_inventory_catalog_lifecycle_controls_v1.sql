-- Block 36: reversible catalog lifecycle controls without new tables or columns.

create or replace function public.inventory_set_item_active_status_v1(
  p_inventory_item_id bigint,
  p_is_active boolean,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.inventory_items%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_product_names text[];
  v_recipe_names text[];
  v_active_flow_count integer := 0;
  v_changed boolean := false;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administracion puede cambiar el estado de un item.' using errcode = '42501';
  end if;
  if p_inventory_item_id is null or p_is_active is null then
    raise exception 'inventory_item_id e is_active son obligatorios.' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'La nota admite hasta 500 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-item-status:' || p_inventory_item_id::text, 0)
  );

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Item de inventario no encontrado.' using errcode = 'P0002';
  end if;
  if v_item.merged_into_item_id is not null then
    raise exception 'Un alias historico no puede cambiar de estado.' using errcode = '22023';
  end if;

  if v_item.is_active = p_is_active then
    return jsonb_build_object(
      'status', 'replayed',
      'inventory_item_id', v_item.id,
      'is_active', v_item.is_active,
      'stock_changed', false
    );
  end if;

  if p_is_active then
    if v_item.tracking_mode in ('transactional', 'periodic_count')
      and not app_private.inventory_item_has_accepted_opening_v1(v_item.id)
    then
      raise exception 'El item requiere una apertura aceptada antes de reactivarse.' using errcode = '22023';
    end if;
  else
    select array_agg(distinct product.name order by product.name)
    into v_product_names
    from public.product_inventory_links link
    join public.products product on product.id = link.product_id
    where link.inventory_item_id = v_item.id
      and link.configuration_version = 1
      and link.is_active
      and product.is_active;

    select array_agg(distinct output_item.name order by output_item.name)
    into v_recipe_names
    from public.inventory_recipes recipe
    join public.inventory_items output_item on output_item.id = recipe.output_inventory_item_id
    where recipe.is_active
      and (
        recipe.output_inventory_item_id = v_item.id
        or exists (
          select 1
          from public.inventory_recipe_components component
          where component.recipe_id = recipe.id
            and component.input_inventory_item_id = v_item.id
        )
      );

    select count(*)::integer
    into v_active_flow_count
    from public.inventory_planned_flows flow
    where flow.inventory_item_id = v_item.id
      and flow.status = 'active';

    if coalesce(cardinality(v_product_names), 0) > 0 then
      raise exception 'Primero desactiva los productos activos que usan este item: %.',
        array_to_string(v_product_names, ', ')
        using errcode = '22023';
    end if;
    if coalesce(cardinality(v_recipe_names), 0) > 0 then
      raise exception 'El item participa en recetas activas: %.', array_to_string(v_recipe_names, ', ')
        using errcode = '22023';
    end if;
    if v_active_flow_count > 0 then
      raise exception 'El item tiene % flujo(s) planificado(s) activo(s).', v_active_flow_count
        using errcode = '22023';
    end if;
  end if;

  update public.inventory_items item
  set is_active = p_is_active,
      notes = case
        when v_note is null then item.notes
        else left(
          format(
            '[Estado %s - %s] %s',
            case when p_is_active then 'reactivado' else 'desactivado' end,
            to_char(clock_timestamp() at time zone 'America/Caracas', 'YYYY-MM-DD HH24:MI'),
            v_note
          ) || coalesce(E'\n' || nullif(item.notes, ''), ''),
          1000
        )
      end
  where item.id = v_item.id;
  v_changed := found;

  if not p_is_active then
    update public.inventory_alerts alert
    set status = 'resolved',
        resolved_by_user_id = v_actor,
        resolved_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        details = coalesce(alert.details, '{}'::jsonb) || jsonb_build_object(
          'resolution_source', 'inventory_item_deactivation',
          'resolution_note', v_note
        )
    where alert.inventory_item_id = v_item.id
      and alert.status in ('open', 'managed');
  end if;

  return jsonb_build_object(
    'status', case when v_changed then 'applied' else 'replayed' end,
    'inventory_item_id', v_item.id,
    'is_active', p_is_active,
    'stock_changed', false,
    'orders_blocked', false
  );
end;
$$;

revoke all on function public.inventory_set_item_active_status_v1(bigint, boolean, text)
  from public, anon;
grant execute on function public.inventory_set_item_active_status_v1(bigint, boolean, text)
  to authenticated, service_role;

comment on function public.inventory_set_item_active_status_v1(bigint, boolean, text) is
  'Admin-only reversible item retirement. It preserves stock/history, rejects active dependencies, resolves obsolete item alerts, and never blocks orders.';

create or replace function public.inventory_set_product_active_status_v1(
  p_product_id bigint,
  p_is_active boolean,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_product public.products%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_blockers text[];
  v_parent_names text[];
  v_open_order_count integer := 0;
  v_history jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administracion puede cambiar el estado de un producto.' using errcode = '42501';
  end if;
  if p_product_id is null or p_is_active is null then
    raise exception 'product_id e is_active son obligatorios.' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'La nota admite hasta 500 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-product-status:' || p_product_id::text, 0)
  );

  select product.*
  into v_product
  from public.products product
  where product.id = p_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado.' using errcode = 'P0002';
  end if;
  if v_product.is_active = p_is_active then
    return jsonb_build_object(
      'status', 'replayed',
      'product_id', v_product.id,
      'is_active', v_product.is_active,
      'orders_blocked', false
    );
  end if;
  if v_product.inventory_configuration_status <> 'ready' then
    raise exception 'Los borradores se activan desde la cola de revision.' using errcode = '22023';
  end if;

  if p_is_active then
    if v_product.inventory_policy is null then
      raise exception 'El producto no tiene politica de inventario.' using errcode = '22023';
    end if;

    select array_agg(distinct item.name order by item.name)
    into v_blockers
    from public.product_inventory_links link
    join public.inventory_items item on item.id = link.inventory_item_id
    where link.product_id = v_product.id
      and link.configuration_version = 1
      and link.is_active
      and (
        not item.is_active
        or item.merged_into_item_id is not null
        or item.tracking_mode = 'not_tracked'
        or (
          item.tracking_mode in ('transactional', 'periodic_count')
          and not app_private.inventory_item_has_accepted_opening_v1(item.id)
        )
      );

    if coalesce(cardinality(v_blockers), 0) > 0 then
      raise exception 'Primero reactiva o completa la apertura de: %.', array_to_string(v_blockers, ', ')
        using errcode = '22023';
    end if;

    select array_agg(distinct component_product.name order by component_product.name)
    into v_blockers
    from public.product_components component
    join public.products component_product on component_product.id = component.component_product_id
    where component.parent_product_id = v_product.id
      and (not component_product.is_active or component_product.inventory_configuration_status <> 'ready');

    if coalesce(cardinality(v_blockers), 0) > 0 then
      raise exception 'Primero reactiva los componentes: %.', array_to_string(v_blockers, ', ')
        using errcode = '22023';
    end if;
  else
    select array_agg(distinct parent.name order by parent.name)
    into v_parent_names
    from public.product_components component
    join public.products parent on parent.id = component.parent_product_id
    where component.component_product_id = v_product.id
      and parent.is_active;

    if coalesce(cardinality(v_parent_names), 0) > 0 then
      raise exception 'Primero desactiva los productos activos que lo incluyen: %.',
        array_to_string(v_parent_names, ', ')
        using errcode = '22023';
    end if;
  end if;

  select count(distinct order_item.order_id)::integer
  into v_open_order_count
  from public.order_items order_item
  join public.orders order_row on order_row.id = order_item.order_id
  where order_item.product_id = v_product.id
    and order_row.status not in ('delivered'::public.order_status, 'cancelled'::public.order_status);

  v_history := case
    when jsonb_typeof(coalesce(v_product.extra_fields, '{}'::jsonb) -> 'inventory_catalog_status_history') = 'array'
      then coalesce(v_product.extra_fields, '{}'::jsonb) -> 'inventory_catalog_status_history'
    else '[]'::jsonb
  end;
  v_history := v_history || jsonb_build_array(jsonb_build_object(
    'is_active', p_is_active,
    'changed_at', clock_timestamp(),
    'changed_by', v_actor,
    'note', v_note,
    'open_order_count', v_open_order_count,
    'orders_blocked', false
  ));

  update public.products product
  set is_active = p_is_active,
      extra_fields = coalesce(product.extra_fields, '{}'::jsonb)
        || jsonb_build_object('inventory_catalog_status_history', v_history)
  where product.id = v_product.id;

  return jsonb_build_object(
    'status', 'applied',
    'product_id', v_product.id,
    'is_active', p_is_active,
    'open_order_count', v_open_order_count,
    'orders_blocked', false
  );
end;
$$;

revoke all on function public.inventory_set_product_active_status_v1(bigint, boolean, text)
  from public, anon;
grant execute on function public.inventory_set_product_active_status_v1(bigint, boolean, text)
  to authenticated, service_role;

comment on function public.inventory_set_product_active_status_v1(bigint, boolean, text) is
  'Admin-only reversible commercial/seasonal status using products.is_active. It preserves open orders and records lifecycle history in existing extra_fields.';
