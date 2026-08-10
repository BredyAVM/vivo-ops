-- Block 26: versioned physical product configuration without duplicating catalog tables.

create or replace function public.inventory_update_product_physical_configuration_v1(
  p_configuration jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_product public.products%rowtype;
  v_policy text := lower(btrim(coalesce(p_configuration ->> 'inventory_policy', '')));
  v_detail_units_limit integer;
  v_note text := nullif(btrim(coalesce(p_configuration ->> 'change_note', '')), '');
  v_links jsonb := coalesce(p_configuration -> 'links', '[]'::jsonb);
  v_components jsonb := coalesce(p_configuration -> 'components', '[]'::jsonb);
  v_link jsonb;
  v_component jsonb;
  v_inventory_item_id bigint;
  v_component_product_id bigint;
  v_quantity numeric;
  v_mode text;
  v_stage text;
  v_seen_ids bigint[] := array[]::bigint[];
  v_sort integer := 0;
  v_has_selectable boolean := false;
  v_current_revision integer;
  v_next_revision integer;
  v_history jsonb;
  v_previous_snapshot jsonb;
  v_mirror_item public.inventory_items%rowtype;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administracion puede cambiar la configuracion fisica de un producto.'
      using errcode = '42501';
  end if;

  if p_configuration is null or jsonb_typeof(p_configuration) <> 'object' then
    raise exception 'La configuracion fisica no es valida.' using errcode = '22023';
  end if;

  select product.* into v_product
  from public.products product
  where product.id = (p_configuration ->> 'product_id')::bigint
  for update;
  if not found then
    raise exception 'El producto no existe.' using errcode = 'P0002';
  end if;
  if not v_product.is_active or v_product.inventory_configuration_status <> 'ready' then
    raise exception 'Solo se puede versionar un producto activo y listo.' using errcode = '22023';
  end if;

  if v_policy not in ('self', 'direct', 'components', 'none') then
    raise exception 'Selecciona una politica fisica valida.' using errcode = '22023';
  end if;
  v_detail_units_limit := coalesce(
    nullif(btrim(coalesce(p_configuration ->> 'detail_units_limit', '')), '')::integer,
    v_product.detail_units_limit
  );
  if v_detail_units_limit < 0 then
    raise exception 'El limite de seleccion no puede ser negativo.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_links) <> 'array' or jsonb_typeof(v_components) <> 'array' then
    raise exception 'Los vinculos y componentes deben ser listas.' using errcode = '22023';
  end if;

  if v_policy = 'self' and jsonb_array_length(v_links) <> 1 then
    raise exception 'Un producto que se descuenta a si mismo requiere exactamente un item fisico.'
      using errcode = '22023';
  elsif v_policy = 'direct' and jsonb_array_length(v_links) not between 1 and 50 then
    raise exception 'El consumo directo requiere entre 1 y 50 items fisicos.' using errcode = '22023';
  elsif v_policy = 'components' and jsonb_array_length(v_components) not between 1 and 100 then
    raise exception 'La composicion requiere entre 1 y 100 productos componentes.' using errcode = '22023';
  end if;

  v_current_revision := coalesce(
    nullif(v_product.extra_fields ->> 'inventory_physical_revision', '')::integer,
    1
  );
  v_next_revision := v_current_revision + 1;
  v_history := case
    when jsonb_typeof(v_product.extra_fields -> 'inventory_physical_history') = 'array'
      then v_product.extra_fields -> 'inventory_physical_history'
    else '[]'::jsonb
  end;
  v_previous_snapshot := jsonb_build_object(
    'revision', v_current_revision,
    'archived_at', now(),
    'archived_by_user_id', v_actor,
    'change_note', v_note,
    'inventory_policy', v_product.inventory_policy,
    'detail_units_limit', v_product.detail_units_limit,
    'is_detail_editable', v_product.is_detail_editable,
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'inventory_item_id', link.inventory_item_id,
        'quantity_units', link.quantity_units,
        'deduction_mode', link.deduction_mode,
        'deduction_stage', link.deduction_stage,
        'sort_order', link.sort_order
      ) order by link.sort_order, link.id)
      from public.product_inventory_links link
      where link.product_id = v_product.id
        and link.configuration_version = 1
        and link.is_active
    ), '[]'::jsonb),
    'components', coalesce((
      select jsonb_agg(jsonb_build_object(
        'component_product_id', component.component_product_id,
        'component_mode', component.component_mode,
        'quantity', component.quantity,
        'counts_toward_detail_limit', component.counts_toward_detail_limit,
        'is_required', component.is_required,
        'sort_order', component.sort_order
      ) order by component.sort_order, component.id)
      from public.product_components component
      where component.parent_product_id = v_product.id
    ), '[]'::jsonb)
  );

  delete from public.product_inventory_links link
  where link.product_id = v_product.id and link.configuration_version = 1;
  delete from public.product_components component
  where component.parent_product_id = v_product.id;

  if v_policy in ('self', 'direct') then
    v_seen_ids := array[]::bigint[];
    for v_link in
      select line.value
      from jsonb_array_elements(v_links) with ordinality as line(value, ordinal)
      order by line.ordinal
    loop
      v_inventory_item_id := (v_link ->> 'inventory_item_id')::bigint;
      v_quantity := (v_link ->> 'quantity_units')::numeric;
      v_stage := nullif(lower(btrim(coalesce(v_link ->> 'deduction_stage', ''))), '');
      if v_inventory_item_id = any(v_seen_ids) then
        raise exception 'Un item fisico no puede repetirse.' using errcode = '22023';
      end if;
      v_seen_ids := array_append(v_seen_ids, v_inventory_item_id);
      if v_quantity <= 0 then
        raise exception 'Cada cantidad descontada debe ser positiva.' using errcode = '22023';
      end if;
      if v_stage is not null and v_stage not in ('kitchen','production','packing','fulfillment') then
        raise exception 'La etapa de descuento no es valida.' using errcode = '22023';
      end if;
      if not exists (
        select 1 from public.inventory_items item
        where item.id = v_inventory_item_id
          and item.is_active
          and item.merged_into_item_id is null
          and item.tracking_mode <> 'not_tracked'
      ) then
        raise exception 'Uno de los items fisicos no esta activo o no es controlable.' using errcode = '22023';
      end if;
      v_sort := v_sort + 1;
      insert into public.product_inventory_links (
        product_id, inventory_item_id, deduction_mode, quantity_units,
        sort_order, notes, is_active, configuration_version, deduction_stage
      ) values (
        v_product.id, v_inventory_item_id,
        case when v_policy = 'self' then 'self_link' else 'recipe' end,
        v_quantity, v_sort, format('Revision fisica v%s', v_next_revision),
        true, 1, v_stage
      );
    end loop;
  elsif v_policy = 'components' then
    v_seen_ids := array[]::bigint[];
    for v_component in
      select line.value
      from jsonb_array_elements(v_components) with ordinality as line(value, ordinal)
      order by line.ordinal
    loop
      v_component_product_id := (v_component ->> 'component_product_id')::bigint;
      v_mode := lower(btrim(coalesce(v_component ->> 'component_mode', 'fixed')));
      v_quantity := (v_component ->> 'quantity')::numeric;
      if v_component_product_id = v_product.id then
        raise exception 'Un producto no puede contenerse a si mismo.' using errcode = '22023';
      end if;
      if v_mode not in ('fixed','selectable') or v_quantity <= 0 then
        raise exception 'Cada componente requiere un modo y una cantidad positiva.' using errcode = '22023';
      end if;
      if (v_component_product_id * 10 + case when v_mode = 'selectable' then 1 else 0 end) = any(v_seen_ids) then
        raise exception 'Un componente no puede repetirse con el mismo modo.' using errcode = '22023';
      end if;
      v_seen_ids := array_append(v_seen_ids,
        v_component_product_id * 10 + case when v_mode = 'selectable' then 1 else 0 end);
      if not exists (
        select 1 from public.products component_product
        where component_product.id = v_component_product_id
          and component_product.is_active
          and component_product.inventory_configuration_status = 'ready'
      ) then
        raise exception 'Uno de los productos componentes no esta activo y listo.' using errcode = '22023';
      end if;
      v_sort := v_sort + 1;
      v_has_selectable := v_has_selectable or v_mode = 'selectable';
      insert into public.product_components (
        parent_product_id, component_product_id, component_mode, quantity,
        counts_toward_detail_limit, is_required, sort_order, notes
      ) values (
        v_product.id, v_component_product_id, v_mode::public.product_component_mode, v_quantity,
        coalesce((v_component ->> 'counts_toward_detail_limit')::boolean, true),
        coalesce((v_component ->> 'is_required')::boolean, v_mode = 'fixed'),
        v_sort, format('Revision fisica v%s', v_next_revision)
      );
    end loop;
    if v_has_selectable and v_detail_units_limit <= 0 then
      raise exception 'Una composicion seleccionable requiere un limite mayor que cero.' using errcode = '22023';
    end if;
    if exists (
      with recursive descendants(product_id, path, cycle) as (
        select component.component_product_id, array[v_product.id, component.component_product_id]::bigint[], false
        from public.product_components component
        where component.parent_product_id = v_product.id
        union all
        select child.component_product_id, descendant.path || child.component_product_id,
               child.component_product_id = any(descendant.path)
        from descendants descendant
        join public.product_components child on child.parent_product_id = descendant.product_id
        where not descendant.cycle and cardinality(descendant.path) < 17
      )
      select 1 from descendants where product_id = v_product.id or cycle
    ) then
      raise exception 'La composicion produciria un ciclo.' using errcode = '22023';
    end if;
  end if;

  if v_policy = 'self' then
    select item.* into v_mirror_item
    from public.inventory_items item
    join public.product_inventory_links link on link.inventory_item_id = item.id
    where link.product_id = v_product.id and link.configuration_version = 1
    limit 1;
  end if;

  update public.products product
  set inventory_policy = v_policy,
      inventory_configuration_status = 'ready',
      inventory_enabled = v_policy <> 'none',
      inventory_deduction_mode = case when v_policy = 'components' then 'composition' else 'self' end,
      is_inventory_item = v_policy = 'self',
      is_detail_editable = v_policy = 'components' and v_has_selectable,
      is_combo_component_selectable = v_policy = 'components' and v_has_selectable,
      detail_units_limit = case when v_policy = 'components' then v_detail_units_limit else 0 end,
      inventory_kind = case when v_policy = 'self' then
        case when v_mirror_item.inventory_kind in ('raw_material','prepared_base')
          then v_mirror_item.inventory_kind else 'finished_good' end
        else product.inventory_kind end,
      inventory_unit_name = case when v_policy = 'self' then v_mirror_item.unit_name else product.inventory_unit_name end,
      packaging_name = case when v_policy = 'self' then v_mirror_item.packaging_name else product.packaging_name end,
      packaging_size = case when v_policy = 'self' then v_mirror_item.packaging_size else product.packaging_size end,
      low_stock_threshold = case when v_policy = 'self' then v_mirror_item.low_stock_threshold else product.low_stock_threshold end,
      inventory_group = case when v_policy = 'self' then v_mirror_item.inventory_group else product.inventory_group end,
      extra_fields = (coalesce(product.extra_fields, '{}'::jsonb)
        - 'inventory_physical_revision' - 'inventory_physical_history')
        || jsonb_build_object(
          'inventory_physical_revision', v_next_revision,
          'inventory_physical_history', v_history || jsonb_build_array(v_previous_snapshot),
          'inventory_physical_changed_at', now(),
          'inventory_physical_changed_by_user_id', v_actor,
          'inventory_physical_change_note', v_note
        )
  where product.id = v_product.id;

  return jsonb_build_object(
    'status', 'updated',
    'product_id', v_product.id,
    'previous_revision', v_current_revision,
    'revision', v_next_revision,
    'inventory_policy', v_policy,
    'orders_blocked', false,
    'committed_orders_keep_snapshot', true
  );
end;
$$;

revoke all on function public.inventory_update_product_physical_configuration_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_update_product_physical_configuration_v1(jsonb)
  to authenticated, service_role;

comment on function public.inventory_update_product_physical_configuration_v1(jsonb) is
  'Admin-only physical product revision writer. Reuses canonical links/components, archives prior structure in products.extra_fields, never changes stock, and never blocks orders.';

create or replace function app_private.inventory_resolve_order_sale_v1(p_order_id bigint)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_diagnostics jsonb;
  v_first_error jsonb;
  v_committed_lines jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'inventory_item_id', flow.inventory_item_id,
    'inventory_item_name', item.name,
    'quantity_units', flow.quantity_units,
    'sources', jsonb_build_array(jsonb_build_object(
      'order_id', p_order_id,
      'planned_flow_id', flow.id,
      'source', 'order_commitment_snapshot'
    ))
  ) order by flow.inventory_item_id)
  into v_committed_lines
  from public.inventory_planned_flows flow
  join public.inventory_items item on item.id = flow.inventory_item_id
  where flow.order_id = p_order_id
    and flow.flow_type = 'order_commitment'
    and flow.status in ('active', 'fulfilled');

  if v_committed_lines is not null and jsonb_array_length(v_committed_lines) > 0 then
    return jsonb_build_object(
      'status', 'resolved',
      'order_id', p_order_id,
      'configuration_source', 'committed_snapshot',
      'lines', v_committed_lines
    );
  end if;

  v_diagnostics := app_private.inventory_order_sale_diagnostics_v1(p_order_id);
  if jsonb_array_length(v_diagnostics -> 'errors') > 0 then
    v_first_error := v_diagnostics -> 'errors' -> 0;
    raise exception '[%] %', v_first_error ->> 'code', v_first_error ->> 'message'
      using errcode = '22023', detail = (v_diagnostics -> 'errors')::text;
  end if;
  return (v_diagnostics - 'errors') || jsonb_build_object('status', 'resolved');
end;
$$;

revoke all on function app_private.inventory_resolve_order_sale_v1(bigint)
  from public, anon, authenticated;
grant execute on function app_private.inventory_resolve_order_sale_v1(bigint)
  to service_role;

comment on function app_private.inventory_resolve_order_sale_v1(bigint) is
  'Resolves delivery from the already committed physical snapshot when available; otherwise uses the current canonical product configuration.';
