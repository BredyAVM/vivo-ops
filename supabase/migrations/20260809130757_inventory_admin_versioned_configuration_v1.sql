-- Block 21: safe administration of the existing inventory catalog.
--
-- No tables or columns are added. Active product identity and item controls are
-- updated through narrow admin-only RPCs. Recipe formula changes are always
-- stored as inactive versions and only replace the operational recipe through
-- an explicit activation.

create or replace function public.inventory_update_product_identity_v1(
  p_configuration jsonb
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
  v_product_id bigint;
  v_name text;
  v_sku text;
  v_units_per_service integer;
  v_allows_half_service boolean;
  v_is_temporary boolean;
  v_detail_units_limit integer;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede modificar productos.' using errcode = '42501';
  end if;
  if p_configuration is null or jsonb_typeof(p_configuration) <> 'object' then
    raise exception 'La configuración del producto debe ser un objeto.' using errcode = '22023';
  end if;
  if pg_column_size(p_configuration) > 32768 then
    raise exception 'La configuración supera el tamaño permitido.' using errcode = '22023';
  end if;

  v_product_id := nullif(btrim(coalesce(p_configuration ->> 'product_id', '')), '')::bigint;
  if v_product_id is null then
    raise exception 'product_id es obligatorio.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-product:' || v_product_id::text, 0)
  );

  select product.*
  into v_product
  from public.products product
  where product.id = v_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado.' using errcode = 'P0002';
  end if;
  if not v_product.is_active then
    raise exception 'Este formulario solo modifica productos activos. Los borradores se editan antes de activarlos.'
      using errcode = '22023';
  end if;

  v_name := btrim(coalesce(p_configuration ->> 'name', ''));
  v_sku := upper(btrim(coalesce(p_configuration ->> 'sku', '')));
  v_units_per_service := nullif(
    btrim(coalesce(p_configuration ->> 'units_per_service', '')),
    ''
  )::integer;
  v_allows_half_service := coalesce(
    nullif(btrim(coalesce(p_configuration ->> 'allows_half_service', '')), '')::boolean,
    false
  );
  v_is_temporary := coalesce(
    nullif(btrim(coalesce(p_configuration ->> 'is_temporary', '')), '')::boolean,
    false
  );
  v_detail_units_limit := nullif(
    btrim(coalesce(p_configuration ->> 'detail_units_limit', '')),
    ''
  )::integer;

  if v_name = '' or char_length(v_name) > 160 then
    raise exception 'El nombre es obligatorio y admite hasta 160 caracteres.' using errcode = '22023';
  end if;
  if v_sku = '' or char_length(v_sku) > 64 or v_sku !~ '^[A-Z0-9][A-Z0-9._-]*$' then
    raise exception 'El SKU solo admite letras, números, punto, guion y guion bajo.' using errcode = '22023';
  end if;
  if v_units_per_service is null or v_units_per_service < 0 then
    raise exception 'Las unidades por servicio deben ser un entero mayor o igual a cero.' using errcode = '22023';
  end if;
  if v_detail_units_limit is null or v_detail_units_limit < 0 then
    raise exception 'El límite seleccionable debe ser un entero mayor o igual a cero.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.products product
    where product.sku = v_sku
      and product.id <> v_product_id
  ) then
    raise exception 'Ya existe otro producto con ese SKU.' using errcode = '23505';
  end if;

  update public.products
  set name = v_name,
      sku = v_sku,
      units_per_service = v_units_per_service,
      allows_half_service = v_allows_half_service,
      is_temporary = v_is_temporary,
      detail_units_limit = v_detail_units_limit
  where id = v_product_id;

  return jsonb_build_object(
    'status', 'updated',
    'product_id', v_product_id,
    'historical_order_names_preserved', true,
    'inventory_topology_changed', false
  );
end;
$$;

revoke all on function public.inventory_update_product_identity_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_update_product_identity_v1(jsonb)
  to authenticated, service_role;

comment on function public.inventory_update_product_identity_v1(jsonb) is
  'Admin-only safe edit of active commercial identity fields. It never changes prices, components, inventory policy, links, or stock.';

create or replace function public.inventory_update_item_controls_v1(
  p_configuration jsonb
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
  v_item_id bigint;
  v_name text;
  v_availability_mode text;
  v_low_stock_threshold numeric;
  v_low_stock_inclusive boolean;
  v_target_stock_units numeric;
  v_shelf_life_days integer;
  v_primary_count_frequency text;
  v_primary_count_role text;
  v_notes text;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede modificar controles de inventario.' using errcode = '42501';
  end if;
  if p_configuration is null or jsonb_typeof(p_configuration) <> 'object' then
    raise exception 'La configuración del ítem debe ser un objeto.' using errcode = '22023';
  end if;
  if pg_column_size(p_configuration) > 32768 then
    raise exception 'La configuración supera el tamaño permitido.' using errcode = '22023';
  end if;

  v_item_id := nullif(btrim(coalesce(p_configuration ->> 'inventory_item_id', '')), '')::bigint;
  if v_item_id is null then
    raise exception 'inventory_item_id es obligatorio.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-item-controls:' || v_item_id::text, 0)
  );

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = v_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario no encontrado.' using errcode = 'P0002';
  end if;
  if v_item.merged_into_item_id is not null then
    raise exception 'Un alias histórico no puede modificarse.' using errcode = '22023';
  end if;

  v_name := btrim(coalesce(p_configuration ->> 'name', ''));
  v_availability_mode := nullif(lower(btrim(coalesce(p_configuration ->> 'availability_mode', ''))), '');
  v_low_stock_threshold := nullif(
    btrim(coalesce(p_configuration ->> 'low_stock_threshold', '')),
    ''
  )::numeric;
  v_low_stock_inclusive := coalesce(
    nullif(btrim(coalesce(p_configuration ->> 'low_stock_inclusive', '')), '')::boolean,
    true
  );
  v_target_stock_units := nullif(
    btrim(coalesce(p_configuration ->> 'target_stock_units', '')),
    ''
  )::numeric;
  v_shelf_life_days := nullif(
    btrim(coalesce(p_configuration ->> 'shelf_life_days', '')),
    ''
  )::integer;
  v_primary_count_frequency := nullif(
    lower(btrim(coalesce(p_configuration ->> 'primary_count_frequency', ''))),
    ''
  );
  v_primary_count_role := nullif(
    lower(btrim(coalesce(p_configuration ->> 'primary_count_role', ''))),
    ''
  );
  v_notes := nullif(btrim(coalesce(p_configuration ->> 'notes', '')), '');

  if v_name = '' or char_length(v_name) > 160 then
    raise exception 'El nombre es obligatorio y admite hasta 160 caracteres.' using errcode = '22023';
  end if;
  if v_availability_mode is not null
    and v_availability_mode not in ('on_hand_only', 'immediate_recipe', 'scheduled_recipe')
  then
    raise exception 'El modo de disponibilidad no es válido.' using errcode = '22023';
  end if;
  if v_low_stock_threshold is not null and v_low_stock_threshold < 0 then
    raise exception 'La alerta mínima no puede ser negativa.' using errcode = '22023';
  end if;
  if v_target_stock_units is not null and v_target_stock_units < 0 then
    raise exception 'El stock objetivo no puede ser negativo.' using errcode = '22023';
  end if;
  if v_shelf_life_days is not null and v_shelf_life_days < 0 then
    raise exception 'La vida útil no puede ser negativa.' using errcode = '22023';
  end if;
  if v_primary_count_frequency is not null
    and v_primary_count_frequency not in ('per_shift', 'daily', 'weekly', 'biweekly', 'monthly')
  then
    raise exception 'La frecuencia de conteo no es válida.' using errcode = '22023';
  end if;
  if v_primary_count_role is not null
    and v_primary_count_role not in ('admin', 'master', 'kitchen', 'counter')
  then
    raise exception 'El rol de conteo no es válido.' using errcode = '22023';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  update public.inventory_items
  set name = v_name,
      availability_mode = v_availability_mode,
      low_stock_threshold = v_low_stock_threshold,
      low_stock_inclusive = v_low_stock_inclusive,
      target_stock_units = v_target_stock_units,
      shelf_life_days = v_shelf_life_days,
      primary_count_frequency = v_primary_count_frequency,
      primary_count_role = v_primary_count_role::public.user_role,
      notes = v_notes
  where id = v_item_id;

  return jsonb_build_object(
    'status', 'updated',
    'inventory_item_id', v_item_id,
    'stock_changed', false,
    'structural_fields_changed', false
  );
end;
$$;

revoke all on function public.inventory_update_item_controls_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_update_item_controls_v1(jsonb)
  to authenticated, service_role;

comment on function public.inventory_update_item_controls_v1(jsonb) is
  'Admin-only safe edit of item naming, availability, alert, target, shelf-life and counting controls. It never changes stock, unit, kind, group, or tracking mode.';

create or replace function public.inventory_save_recipe_draft_v1(
  p_configuration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe public.inventory_recipes%rowtype;
  v_source_recipe public.inventory_recipes%rowtype;
  v_draft_recipe_id bigint;
  v_source_recipe_id bigint;
  v_output_item_id bigint;
  v_recipe_kind text;
  v_output_quantity numeric;
  v_lead_time_minutes integer;
  v_production_multiple numeric;
  v_notes text;
  v_version integer;
  v_component jsonb;
  v_input_item_id bigint;
  v_component_quantity numeric;
  v_sort_order integer := 0;
  v_seen_ids bigint[] := array[]::bigint[];
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede guardar versiones de recetas.' using errcode = '42501';
  end if;
  if p_configuration is null or jsonb_typeof(p_configuration) <> 'object' then
    raise exception 'La receta debe ser un objeto.' using errcode = '22023';
  end if;
  if pg_column_size(p_configuration) > 131072 then
    raise exception 'La receta supera el tamaño permitido.' using errcode = '22023';
  end if;
  if p_configuration -> 'components' is null
    or jsonb_typeof(p_configuration -> 'components') <> 'array'
    or jsonb_array_length(p_configuration -> 'components') < 1
    or jsonb_array_length(p_configuration -> 'components') > 50
  then
    raise exception 'La receta requiere entre 1 y 50 insumos.' using errcode = '22023';
  end if;

  v_draft_recipe_id := nullif(btrim(coalesce(p_configuration ->> 'draft_recipe_id', '')), '')::bigint;
  v_source_recipe_id := nullif(btrim(coalesce(p_configuration ->> 'source_recipe_id', '')), '')::bigint;
  v_output_item_id := nullif(
    btrim(coalesce(p_configuration ->> 'output_inventory_item_id', '')),
    ''
  )::bigint;
  v_recipe_kind := lower(btrim(coalesce(p_configuration ->> 'recipe_kind', '')));
  v_output_quantity := nullif(
    btrim(coalesce(p_configuration ->> 'output_quantity_units', '')),
    ''
  )::numeric;
  v_lead_time_minutes := nullif(
    btrim(coalesce(p_configuration ->> 'lead_time_minutes', '')),
    ''
  )::integer;
  v_production_multiple := nullif(
    btrim(coalesce(p_configuration ->> 'production_multiple', '')),
    ''
  )::numeric;
  v_notes := nullif(btrim(coalesce(p_configuration ->> 'notes', '')), '');

  if v_output_item_id is null then
    raise exception 'Selecciona el ítem que producirá la receta.' using errcode = '22023';
  end if;
  if v_recipe_kind not in ('production', 'packaging') then
    raise exception 'El tipo de receta no es válido.' using errcode = '22023';
  end if;
  if v_output_quantity is null or v_output_quantity <= 0 then
    raise exception 'La salida de la receta debe ser mayor que cero.' using errcode = '22023';
  end if;
  if v_lead_time_minutes is null or v_lead_time_minutes < 0 or v_lead_time_minutes > 43200 then
    raise exception 'El tiempo debe estar entre 0 y 43.200 minutos.' using errcode = '22023';
  end if;
  if v_production_multiple is null or v_production_multiple <= 0 then
    raise exception 'El múltiplo de producción debe ser mayor que cero.' using errcode = '22023';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.inventory_items item
    where item.id = v_output_item_id
      and item.merged_into_item_id is null
      and item.tracking_mode = 'transactional'
  ) then
    raise exception 'La salida debe ser un ítem transaccional vigente.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'inventory-recipe:' || v_output_item_id::text || ':' || v_recipe_kind,
      0
    )
  );

  perform 1
  from public.inventory_recipes recipe
  where recipe.output_inventory_item_id = v_output_item_id
    and recipe.recipe_kind = v_recipe_kind
  order by recipe.id
  for update;

  if v_source_recipe_id is not null then
    select recipe.*
    into v_source_recipe
    from public.inventory_recipes recipe
    where recipe.id = v_source_recipe_id;

    if not found
      or v_source_recipe.output_inventory_item_id <> v_output_item_id
      or v_source_recipe.recipe_kind <> v_recipe_kind
    then
      raise exception 'La receta base no corresponde a la salida seleccionada.' using errcode = '22023';
    end if;
  end if;

  if v_draft_recipe_id is not null then
    select recipe.*
    into v_recipe
    from public.inventory_recipes recipe
    where recipe.id = v_draft_recipe_id
    for update;

    if not found then
      raise exception 'El borrador de receta ya no existe.' using errcode = 'P0002';
    end if;
    if v_recipe.is_active
      or coalesce(v_recipe.notes, '') not like 'Borrador administrador:%'
      or v_recipe.output_inventory_item_id <> v_output_item_id
      or v_recipe.recipe_kind <> v_recipe_kind
    then
      raise exception 'La versión seleccionada ya no es un borrador editable.' using errcode = '22023';
    end if;

    update public.inventory_recipes
    set output_quantity_units = v_output_quantity,
        lead_time_minutes = v_lead_time_minutes,
        production_multiple = v_production_multiple,
        notes = 'Borrador administrador: ' || coalesce(v_notes, 'Sin nota adicional.')
    where id = v_draft_recipe_id;

    delete from public.inventory_recipe_components component
    where component.recipe_id = v_draft_recipe_id;
  else
    if exists (
      select 1
      from public.inventory_recipes recipe
      where recipe.output_inventory_item_id = v_output_item_id
        and recipe.recipe_kind = v_recipe_kind
        and not recipe.is_active
        and coalesce(recipe.notes, '') like 'Borrador administrador:%'
    ) then
      raise exception 'Ya existe un borrador para esta salida. Recarga la pantalla para editarlo.'
        using errcode = '23505';
    end if;

    select coalesce(max(recipe.version), 0) + 1
    into v_version
    from public.inventory_recipes recipe
    where recipe.output_inventory_item_id = v_output_item_id
      and recipe.recipe_kind = v_recipe_kind;

    insert into public.inventory_recipes (
      output_inventory_item_id,
      recipe_kind,
      output_quantity_units,
      notes,
      is_active,
      lead_time_minutes,
      production_multiple,
      version
    )
    values (
      v_output_item_id,
      v_recipe_kind,
      v_output_quantity,
      'Borrador administrador: ' || coalesce(v_notes, 'Sin nota adicional.'),
      false,
      v_lead_time_minutes,
      v_production_multiple,
      v_version
    )
    returning id into v_draft_recipe_id;
  end if;

  for v_component in
    select component_row.value
    from jsonb_array_elements(p_configuration -> 'components')
      with ordinality as component_row(value, ordinal)
    order by component_row.ordinal
  loop
    v_input_item_id := nullif(
      btrim(coalesce(v_component ->> 'input_inventory_item_id', '')),
      ''
    )::bigint;
    v_component_quantity := nullif(
      btrim(coalesce(v_component ->> 'quantity_units', '')),
      ''
    )::numeric;
    v_sort_order := v_sort_order + 1;

    if v_input_item_id is null or v_component_quantity is null or v_component_quantity <= 0 then
      raise exception 'Cada insumo debe tener un ítem y una cantidad positiva.' using errcode = '22023';
    end if;
    if v_input_item_id = v_output_item_id then
      raise exception 'La receta no puede consumir su propio ítem de salida.' using errcode = '22023';
    end if;
    if v_input_item_id = any(v_seen_ids) then
      raise exception 'Un insumo no puede repetirse en la misma receta.' using errcode = '22023';
    end if;
    if not exists (
      select 1
      from public.inventory_items item
      where item.id = v_input_item_id
        and item.merged_into_item_id is null
        and item.tracking_mode = 'transactional'
    ) then
      raise exception 'Uno de los insumos no es un ítem transaccional vigente.' using errcode = '22023';
    end if;

    v_seen_ids := array_append(v_seen_ids, v_input_item_id);
    insert into public.inventory_recipe_components (
      recipe_id,
      input_inventory_item_id,
      quantity_units,
      sort_order
    )
    values (
      v_draft_recipe_id,
      v_input_item_id,
      v_component_quantity,
      v_sort_order
    );
  end loop;

  select recipe.*
  into v_recipe
  from public.inventory_recipes recipe
  where recipe.id = v_draft_recipe_id;

  return jsonb_build_object(
    'status', 'draft_saved',
    'recipe_id', v_recipe.id,
    'version', v_recipe.version,
    'is_active', false,
    'operational_recipe_unchanged', true
  );
end;
$$;

revoke all on function public.inventory_save_recipe_draft_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_save_recipe_draft_v1(jsonb)
  to authenticated, service_role;

comment on function public.inventory_save_recipe_draft_v1(jsonb) is
  'Admin-only atomic recipe version writer. Active recipes are never edited; a draft and all of its components are saved together.';

create or replace function public.inventory_activate_recipe_v1(
  p_recipe_id bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe public.inventory_recipes%rowtype;
  v_blockers text[];
  v_replaced_ids bigint[];
  v_human_notes text;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede activar recetas.' using errcode = '42501';
  end if;
  if p_recipe_id is null then
    raise exception 'recipe_id es obligatorio.' using errcode = '22023';
  end if;

  select recipe.*
  into v_recipe
  from public.inventory_recipes recipe
  where recipe.id = p_recipe_id
  for update;

  if not found then
    raise exception 'Receta no encontrada.' using errcode = 'P0002';
  end if;
  if coalesce(v_recipe.notes, '') not like 'Bloque 3:%'
    and coalesce(v_recipe.notes, '') not like 'Borrador administrador:%'
  then
    raise exception 'Esta versión no es una receta canónica activable.' using errcode = '22023';
  end if;
  if v_recipe.is_active then
    return jsonb_build_object(
      'status', 'replayed',
      'recipe_id', v_recipe.id,
      'replaced_recipe_ids', '[]'::jsonb
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'inventory-recipe:' || v_recipe.output_inventory_item_id::text || ':' || v_recipe.recipe_kind,
      0
    )
  );

  perform 1
  from public.inventory_recipes recipe
  where recipe.output_inventory_item_id = v_recipe.output_inventory_item_id
    and recipe.recipe_kind = v_recipe.recipe_kind
  order by recipe.id
  for update;

  select array_agg(item.name order by item.id)
  into v_blockers
  from public.inventory_items item
  where item.id in (
    select v_recipe.output_inventory_item_id
    union
    select component.input_inventory_item_id
    from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id
  )
  and (
    not item.is_active
    or item.merged_into_item_id is not null
    or item.tracking_mode <> 'transactional'
    or not app_private.inventory_item_has_accepted_opening_v1(item.id)
  );

  if v_blockers is not null then
    raise exception 'Falta activación o apertura aceptada en: %.', array_to_string(v_blockers, ', ')
      using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id
  ) then
    raise exception 'La receta no tiene insumos.' using errcode = '22023';
  end if;

  select array_agg(recipe.id order by recipe.id)
  into v_replaced_ids
  from public.inventory_recipes recipe
  where recipe.output_inventory_item_id = v_recipe.output_inventory_item_id
    and recipe.recipe_kind = v_recipe.recipe_kind
    and recipe.is_active
    and recipe.id <> v_recipe.id;

  update public.inventory_recipes recipe
  set is_active = false,
      notes = case
        when coalesce(recipe.notes, '') like 'Bloque 3:%'
          then 'Histórico canónico:' || substring(recipe.notes from char_length('Bloque 3:') + 1)
        else 'Histórico previo: ' || coalesce(nullif(btrim(recipe.notes), ''), 'Sin nota adicional.')
      end
  where recipe.output_inventory_item_id = v_recipe.output_inventory_item_id
    and recipe.recipe_kind = v_recipe.recipe_kind
    and recipe.is_active
    and recipe.id <> v_recipe.id;

  v_human_notes := case
    when coalesce(v_recipe.notes, '') like 'Borrador administrador:%'
      then nullif(btrim(substring(v_recipe.notes from char_length('Borrador administrador:') + 1)), '')
    else nullif(btrim(substring(v_recipe.notes from char_length('Bloque 3:') + 1)), '')
  end;

  update public.inventory_recipes
  set is_active = true,
      notes = format(
        'Bloque 3: administrada v%s; %s',
        v_recipe.version,
        coalesce(v_human_notes, 'Sin nota adicional.')
      )
  where id = v_recipe.id;

  return jsonb_build_object(
    'status', 'applied',
    'recipe_id', v_recipe.id,
    'version', v_recipe.version,
    'replaced_recipe_ids', coalesce(to_jsonb(v_replaced_ids), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.inventory_activate_recipe_v1(bigint)
  from public, anon;
grant execute on function public.inventory_activate_recipe_v1(bigint)
  to authenticated, service_role;

comment on function public.inventory_activate_recipe_v1(bigint) is
  'Admin-only activation of a prepared or administrator recipe version. The previous active version becomes history atomically.';

create or replace function public.inventory_admin_configuration_workspace_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede consultar este espacio de configuración.'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', product.id,
        'sku', product.sku,
        'name', product.name,
        'type', product.type,
        'is_active', product.is_active,
        'units_per_service', product.units_per_service,
        'allows_half_service', product.allows_half_service,
        'is_temporary', product.is_temporary,
        'detail_units_limit', product.detail_units_limit,
        'inventory_policy', product.inventory_policy,
        'inventory_configuration_status', product.inventory_configuration_status,
        'order_reference_count', (
          select count(*)
          from public.order_items order_item
          where order_item.product_id = product.id
        ),
        'open_order_reference_count', (
          select count(distinct order_item.order_id)
          from public.order_items order_item
          join public.orders order_row on order_row.id = order_item.order_id
          where order_item.product_id = product.id
            and order_row.status not in ('delivered'::public.order_status, 'cancelled'::public.order_status)
        ),
        'parent_product_count', (
          select count(distinct component.parent_product_id)
          from public.product_components component
          where component.component_product_id = product.id
        ),
        'links', coalesce((
          select jsonb_agg(jsonb_build_object(
            'inventory_item_id', item.id,
            'item_name', item.name,
            'quantity_units', link.quantity_units,
            'deduction_mode', link.deduction_mode,
            'deduction_stage', link.deduction_stage
          ) order by link.sort_order, link.id)
          from public.product_inventory_links link
          join public.inventory_items item on item.id = link.inventory_item_id
          where link.product_id = product.id
            and link.configuration_version = 1
            and link.is_active
        ), '[]'::jsonb)
      ) order by product.name, product.id)
      from public.products product
      where product.is_active
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'name', item.name,
        'inventory_kind', item.inventory_kind,
        'inventory_group', item.inventory_group,
        'unit_name', item.unit_name,
        'tracking_mode', item.tracking_mode,
        'availability_mode', item.availability_mode,
        'current_stock_units', item.current_stock_units,
        'low_stock_threshold', item.low_stock_threshold,
        'low_stock_inclusive', item.low_stock_inclusive,
        'target_stock_units', item.target_stock_units,
        'shelf_life_days', item.shelf_life_days,
        'primary_count_frequency', item.primary_count_frequency,
        'primary_count_role', item.primary_count_role,
        'notes', item.notes,
        'is_active', item.is_active,
        'has_accepted_opening', app_private.inventory_item_has_accepted_opening_v1(item.id),
        'product_reference_count', (
          select count(distinct link.product_id)
          from public.product_inventory_links link
          where link.inventory_item_id = item.id
            and link.configuration_version = 1
            and link.is_active
        ),
        'recipe_input_count', (
          select count(distinct component.recipe_id)
          from public.inventory_recipe_components component
          where component.input_inventory_item_id = item.id
        ),
        'recipe_output_count', (
          select count(*)
          from public.inventory_recipes recipe
          where recipe.output_inventory_item_id = item.id
        )
      ) order by item.name, item.id)
      from public.inventory_items item
      where item.merged_into_item_id is null
    ), '[]'::jsonb),
    'recipes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recipe.id,
        'output_inventory_item_id', output_item.id,
        'output_name', output_item.name,
        'output_unit_name', output_item.unit_name,
        'recipe_kind', recipe.recipe_kind,
        'output_quantity_units', recipe.output_quantity_units,
        'lead_time_minutes', recipe.lead_time_minutes,
        'production_multiple', recipe.production_multiple,
        'version', recipe.version,
        'is_active', recipe.is_active,
        'notes', recipe.notes,
        'lifecycle', case
          when recipe.is_active then 'active'
          when coalesce(recipe.notes, '') like 'Borrador administrador:%' then 'draft'
          else 'history'
        end,
        'active_batch_count', (
          select count(*)
          from public.inventory_planned_flows flow
          where flow.inventory_recipe_id = recipe.id
            and flow.flow_type = 'planned_production'
            and flow.status = 'active'
        ),
        'activation_blockers', coalesce((
          select jsonb_agg(blocker.name order by blocker.id)
          from public.inventory_items blocker
          where blocker.id in (
            select recipe.output_inventory_item_id
            union
            select component.input_inventory_item_id
            from public.inventory_recipe_components component
            where component.recipe_id = recipe.id
          )
          and (
            not blocker.is_active
            or blocker.merged_into_item_id is not null
            or blocker.tracking_mode <> 'transactional'
            or not app_private.inventory_item_has_accepted_opening_v1(blocker.id)
          )
        ), '[]'::jsonb),
        'components', coalesce((
          select jsonb_agg(jsonb_build_object(
            'input_inventory_item_id', input_item.id,
            'input_name', input_item.name,
            'unit_name', input_item.unit_name,
            'quantity_units', component.quantity_units,
            'current_stock_units', input_item.current_stock_units
          ) order by component.sort_order, component.id)
          from public.inventory_recipe_components component
          join public.inventory_items input_item
            on input_item.id = component.input_inventory_item_id
          where component.recipe_id = recipe.id
        ), '[]'::jsonb)
      ) order by output_item.name, recipe.recipe_kind, recipe.version desc, recipe.id desc)
      from public.inventory_recipes recipe
      join public.inventory_items output_item
        on output_item.id = recipe.output_inventory_item_id
    ), '[]'::jsonb),
    'rules', jsonb_build_object(
      'product_structure_locked', true,
      'item_structure_locked_after_creation', true,
      'active_recipe_mutation_allowed', false,
      'recipe_activation_is_explicit', true,
      'orders_blocked_by_inventory', false
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.inventory_admin_configuration_workspace_v1()
  from public, anon;
grant execute on function public.inventory_admin_configuration_workspace_v1()
  to authenticated, service_role;

comment on function public.inventory_admin_configuration_workspace_v1() is
  'Admin-only configuration read model with product dependencies, safe item controls, recipe history, drafts, stock context, and activation blockers.';
