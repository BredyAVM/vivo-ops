-- Block 9: universal inventory/catalog configurator, draft phase.
-- Reuses the canonical catalog tables. No table or column is introduced.
-- The filename matches the migration version recorded by Supabase.

create unique index if not exists inventory_items_canonical_name_uidx
  on public.inventory_items (lower(btrim(name)))
  where merged_into_item_id is null;

create or replace function app_private.inventory_create_draft_item_v1(
  p_item jsonb,
  p_presentations jsonb default '[]'::jsonb
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_name text;
  v_inventory_kind text;
  v_inventory_group text;
  v_unit_name text;
  v_tracking_mode text;
  v_availability_mode text;
  v_consumption_triggers text[] := array[]::text[];
  v_low_stock_threshold numeric;
  v_target_stock_units numeric;
  v_shelf_life_days integer;
  v_primary_count_frequency text;
  v_primary_count_role text;
  v_notes text;
  v_item_id bigint;
  v_presentation jsonb;
  v_presentation_name text;
  v_presentation_units numeric;
  v_presentation_fractional boolean;
  v_first_presentation_name text;
  v_first_presentation_units numeric;
begin
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    raise exception 'La configuracion del item debe ser un objeto.' using errcode = '22023';
  end if;

  if p_presentations is null or jsonb_typeof(p_presentations) <> 'array' then
    raise exception 'Las presentaciones deben enviarse como una lista.' using errcode = '22023';
  end if;

  if jsonb_array_length(p_presentations) > 20 then
    raise exception 'Un item admite hasta 20 presentaciones de entrada.' using errcode = '22023';
  end if;

  v_name := btrim(coalesce(p_item ->> 'name', ''));
  v_inventory_kind := lower(btrim(coalesce(p_item ->> 'inventory_kind', '')));
  v_inventory_group := lower(btrim(coalesce(p_item ->> 'inventory_group', 'other')));
  v_unit_name := btrim(coalesce(p_item ->> 'unit_name', ''));
  v_tracking_mode := lower(btrim(coalesce(p_item ->> 'tracking_mode', '')));
  v_availability_mode := nullif(lower(btrim(coalesce(p_item ->> 'availability_mode', ''))), '');
  v_primary_count_frequency := nullif(
    lower(btrim(coalesce(p_item ->> 'primary_count_frequency', ''))),
    ''
  );
  v_primary_count_role := nullif(lower(btrim(coalesce(p_item ->> 'primary_count_role', ''))), '');
  v_notes := nullif(btrim(coalesce(p_item ->> 'notes', '')), '');

  if v_name = '' or char_length(v_name) > 160 then
    raise exception 'El nombre del item es obligatorio y admite hasta 160 caracteres.'
      using errcode = '22023';
  end if;
  if v_unit_name = '' or char_length(v_unit_name) > 40 then
    raise exception 'La unidad base es obligatoria y admite hasta 40 caracteres.'
      using errcode = '22023';
  end if;
  if v_inventory_kind not in ('raw_material', 'prepared_base', 'finished_stock', 'packaging') then
    raise exception 'El tipo fisico del item no es valido.' using errcode = '22023';
  end if;
  if v_inventory_group not in ('raw', 'fried', 'prefried', 'sauces', 'packaging', 'other') then
    raise exception 'El grupo del item no es valido.' using errcode = '22023';
  end if;
  if v_tracking_mode not in ('transactional', 'periodic_count', 'not_tracked') then
    raise exception 'El modo de control del item no es valido.' using errcode = '22023';
  end if;
  if v_availability_mode is not null
    and v_availability_mode not in ('on_hand_only', 'immediate_recipe', 'scheduled_recipe')
  then
    raise exception 'El modo de disponibilidad no es valido.' using errcode = '22023';
  end if;
  if v_primary_count_frequency is not null
    and v_primary_count_frequency not in ('per_shift', 'daily', 'weekly', 'biweekly', 'monthly')
  then
    raise exception 'La frecuencia de conteo no es valida.' using errcode = '22023';
  end if;
  if v_primary_count_role is not null
    and v_primary_count_role not in ('admin', 'master', 'kitchen', 'counter')
  then
    raise exception 'El rol responsable del conteo no es valido.' using errcode = '22023';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'La nota del item admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  if p_item ? 'low_stock_threshold'
    and jsonb_typeof(p_item -> 'low_stock_threshold') <> 'null'
    and nullif(btrim(p_item ->> 'low_stock_threshold'), '') is not null
  then
    v_low_stock_threshold := (p_item ->> 'low_stock_threshold')::numeric;
    if v_low_stock_threshold < 0 then
      raise exception 'El umbral de alerta no puede ser negativo.' using errcode = '22023';
    end if;
  end if;

  if p_item ? 'target_stock_units'
    and jsonb_typeof(p_item -> 'target_stock_units') <> 'null'
    and nullif(btrim(p_item ->> 'target_stock_units'), '') is not null
  then
    v_target_stock_units := (p_item ->> 'target_stock_units')::numeric;
    if v_target_stock_units < 0 then
      raise exception 'El objetivo de stock no puede ser negativo.' using errcode = '22023';
    end if;
  end if;

  if v_low_stock_threshold is not null
    and v_target_stock_units is not null
    and v_target_stock_units < v_low_stock_threshold
  then
    raise exception 'El objetivo de stock no puede ser menor que el umbral de alerta.'
      using errcode = '22023';
  end if;

  if p_item ? 'shelf_life_days'
    and jsonb_typeof(p_item -> 'shelf_life_days') <> 'null'
    and nullif(btrim(p_item ->> 'shelf_life_days'), '') is not null
  then
    v_shelf_life_days := (p_item ->> 'shelf_life_days')::integer;
    if v_shelf_life_days < 0 then
      raise exception 'La vida util no puede ser negativa.' using errcode = '22023';
    end if;
  end if;

  if p_item ? 'consumption_triggers' then
    if jsonb_typeof(p_item -> 'consumption_triggers') <> 'array' then
      raise exception 'Los disparadores de consumo deben enviarse como una lista.' using errcode = '22023';
    end if;

    select coalesce(array_agg(distinct lower(btrim(trigger_name))), array[]::text[])
    into v_consumption_triggers
    from jsonb_array_elements_text(p_item -> 'consumption_triggers') as trigger_rows(trigger_name);

    if exists (
      select 1
      from unnest(v_consumption_triggers) as trigger_name
      where trigger_name not in ('sale', 'production', 'manual_issue')
    ) then
      raise exception 'La configuracion contiene un disparador de consumo no valido.' using errcode = '22023';
    end if;
  end if;

  if v_tracking_mode = 'not_tracked' then
    v_consumption_triggers := array[]::text[];
    v_availability_mode := null;
  end if;

  if exists (
    select 1
    from public.inventory_items item
    where item.merged_into_item_id is null
      and lower(btrim(item.name)) = lower(v_name)
  ) then
    raise exception 'Ya existe un item fisico canonico con ese nombre. Reutilizalo en vez de duplicarlo.'
      using errcode = '23505';
  end if;

  insert into public.inventory_items (
    name,
    inventory_kind,
    unit_name,
    current_stock_units,
    low_stock_threshold,
    low_stock_inclusive,
    is_active,
    notes,
    inventory_group,
    tracking_mode,
    consumption_triggers,
    availability_mode,
    target_stock_units,
    shelf_life_days,
    merged_into_item_id,
    primary_count_frequency,
    primary_count_role
  )
  values (
    v_name,
    v_inventory_kind,
    v_unit_name,
    0,
    v_low_stock_threshold,
    true,
    false,
    v_notes,
    v_inventory_group,
    v_tracking_mode,
    v_consumption_triggers,
    v_availability_mode,
    v_target_stock_units,
    v_shelf_life_days,
    null,
    v_primary_count_frequency,
    v_primary_count_role::public.user_role
  )
  returning id into v_item_id;

  for v_presentation in
    select presentation_row.value
    from jsonb_array_elements(p_presentations) with ordinality as presentation_row(value, ordinal)
    order by presentation_row.ordinal
  loop
    if jsonb_typeof(v_presentation) <> 'object' then
      raise exception 'Cada presentacion debe ser un objeto.' using errcode = '22023';
    end if;

    v_presentation_name := btrim(coalesce(v_presentation ->> 'name', ''));
    v_presentation_units := nullif(btrim(coalesce(v_presentation ->> 'base_units', '')), '')::numeric;
    v_presentation_fractional := coalesce(
      nullif(btrim(coalesce(v_presentation ->> 'allows_fractional_quantity', '')), '')::boolean,
      false
    );

    if v_presentation_name = '' or char_length(v_presentation_name) > 80 then
      raise exception 'Cada presentacion requiere un nombre de hasta 80 caracteres.'
        using errcode = '22023';
    end if;
    if v_presentation_units is null or v_presentation_units <= 0 then
      raise exception 'Cada presentacion debe convertir a una cantidad positiva de unidades base.'
        using errcode = '22023';
    end if;

    insert into public.inventory_item_presentations (
      inventory_item_id,
      name,
      base_units_per_presentation,
      allows_fractional_quantity,
      is_active
    )
    values (
      v_item_id,
      v_presentation_name,
      v_presentation_units,
      v_presentation_fractional,
      true
    );

    if v_first_presentation_name is null then
      v_first_presentation_name := v_presentation_name;
      v_first_presentation_units := v_presentation_units;
    end if;
  end loop;

  if v_first_presentation_name is not null then
    update public.inventory_items
    set packaging_name = v_first_presentation_name,
        packaging_size = v_first_presentation_units
    where id = v_item_id;
  end if;

  return v_item_id;
end;
$$;

revoke all on function app_private.inventory_create_draft_item_v1(jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.inventory_save_catalog_draft_v1(
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
  v_entry_kind text;
  v_product jsonb;
  v_item jsonb;
  v_presentations jsonb;
  v_product_id bigint;
  v_existing_product public.products%rowtype;
  v_is_reuse boolean := false;
  v_name text;
  v_sku text;
  v_product_type text;
  v_policy text;
  v_none_reason text;
  v_source_price_amount numeric;
  v_source_price_currency text;
  v_units_per_service integer;
  v_allows_half_service boolean;
  v_is_temporary boolean;
  v_detail_units_limit integer;
  v_has_selectable_components boolean := false;
  v_self_item jsonb;
  v_self_mode text;
  v_inventory_item_id bigint;
  v_new_inventory_item_id bigint;
  v_quantity_units numeric;
  v_deduction_stage text;
  v_link jsonb;
  v_component jsonb;
  v_component_product_id bigint;
  v_component_mode text;
  v_counts_toward_detail_limit boolean;
  v_is_required boolean;
  v_sort_order integer;
  v_seen_ids bigint[] := array[]::bigint[];
  v_link_count integer := 0;
  v_component_count integer := 0;
  v_mirror_item public.inventory_items%rowtype;
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
    raise exception 'Solo administracion puede guardar borradores del catalogo de inventario.'
      using errcode = '42501';
  end if;

  if p_configuration is null or jsonb_typeof(p_configuration) <> 'object' then
    raise exception 'La configuracion debe ser un objeto.' using errcode = '22023';
  end if;
  if pg_column_size(p_configuration) > 262144 then
    raise exception 'La configuracion supera el tamano permitido.' using errcode = '22023';
  end if;

  v_entry_kind := lower(btrim(coalesce(p_configuration ->> 'entry_kind', '')));
  if v_entry_kind not in ('item', 'product') then
    raise exception 'Selecciona si crearas un item interno o un producto comercial.'
      using errcode = '22023';
  end if;

  if v_entry_kind = 'item' then
    v_item := p_configuration -> 'inventory_item';
    v_presentations := coalesce(p_configuration -> 'presentations', '[]'::jsonb);
    v_inventory_item_id := app_private.inventory_create_draft_item_v1(v_item, v_presentations);

    return jsonb_build_object(
      'entry_kind', 'item',
      'inventory_item_id', v_inventory_item_id,
      'status', 'draft',
      'is_active', false
    );
  end if;

  v_product := p_configuration -> 'product';
  if v_product is null or jsonb_typeof(v_product) <> 'object' then
    raise exception 'La configuracion del producto debe ser un objeto.' using errcode = '22023';
  end if;

  v_name := btrim(coalesce(v_product ->> 'name', ''));
  v_sku := upper(btrim(coalesce(v_product ->> 'sku', '')));
  v_product_type := lower(btrim(coalesce(v_product ->> 'type', 'product')));
  v_policy := lower(btrim(coalesce(v_product ->> 'inventory_policy', '')));
  v_none_reason := nullif(btrim(coalesce(v_product ->> 'none_reason', '')), '');
  v_source_price_currency := upper(btrim(coalesce(v_product ->> 'source_price_currency', 'USD')));
  v_source_price_amount := coalesce(
    nullif(btrim(coalesce(v_product ->> 'source_price_amount', '')), '')::numeric,
    0
  );
  v_units_per_service := coalesce(
    nullif(btrim(coalesce(v_product ->> 'units_per_service', '')), '')::integer,
    0
  );
  v_detail_units_limit := coalesce(
    nullif(btrim(coalesce(v_product ->> 'detail_units_limit', '')), '')::integer,
    0
  );
  v_allows_half_service := coalesce(
    nullif(btrim(coalesce(v_product ->> 'allows_half_service', '')), '')::boolean,
    false
  );
  v_is_temporary := coalesce(
    nullif(btrim(coalesce(v_product ->> 'is_temporary', '')), '')::boolean,
    false
  );

  if v_name = '' or char_length(v_name) > 160 then
    raise exception 'El nombre del producto es obligatorio y admite hasta 160 caracteres.'
      using errcode = '22023';
  end if;
  if v_sku = '' or char_length(v_sku) > 64 or v_sku !~ '^[A-Z0-9][A-Z0-9._-]*$' then
    raise exception 'El SKU es obligatorio y solo admite letras, numeros, punto, guion y guion bajo.'
      using errcode = '22023';
  end if;
  if v_product_type not in ('product', 'combo', 'service', 'promo', 'gambit') then
    raise exception 'El tipo comercial del producto no es valido.' using errcode = '22023';
  end if;
  if v_policy not in ('self', 'direct', 'components', 'none') then
    raise exception 'La politica de inventario no es valida.' using errcode = '22023';
  end if;
  if v_source_price_currency not in ('USD', 'VES') or v_source_price_amount < 0 then
    raise exception 'El precio fuente no es valido.' using errcode = '22023';
  end if;
  if v_units_per_service < 0 or v_detail_units_limit < 0 then
    raise exception 'Las cantidades comerciales no pueden ser negativas.' using errcode = '22023';
  end if;
  if v_policy = 'none' and (v_none_reason is null or char_length(v_none_reason) < 3) then
    raise exception 'Indica por que este producto no descuenta inventario.' using errcode = '22023';
  end if;
  if v_none_reason is not null and char_length(v_none_reason) > 300 then
    raise exception 'La razon de no inventariar admite hasta 300 caracteres.' using errcode = '22023';
  end if;

  if p_configuration ? 'product_id'
    and jsonb_typeof(p_configuration -> 'product_id') <> 'null'
    and nullif(btrim(p_configuration ->> 'product_id'), '') is not null
  then
    v_product_id := (p_configuration ->> 'product_id')::bigint;
    v_is_reuse := true;

    select product.*
    into v_existing_product
    from public.products product
    where product.id = v_product_id
    for update;

    if not found then
      raise exception 'El producto que intentas reutilizar ya no existe.' using errcode = 'P0002';
    end if;
    if v_existing_product.is_active then
      raise exception 'Solo se puede reutilizar un producto inactivo.' using errcode = '22023';
    end if;
    if exists (select 1 from public.order_items order_item where order_item.product_id = v_product_id)
      or exists (
        select 1
        from public.order_item_components order_component
        where order_component.component_product_id = v_product_id
      )
    then
      raise exception 'Ese producto tiene historia de pedidos y no puede renombrarse ni reconfigurarse. Crea uno nuevo.'
        using errcode = '22023';
    end if;
    if exists (
      select 1
      from public.product_components component
      where component.component_product_id = v_product_id
        and component.parent_product_id <> v_product_id
    ) then
      raise exception 'Ese producto forma parte de otro producto. Retira primero esa dependencia.'
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
    from public.products product
    where product.sku = v_sku
      and (v_product_id is null or product.id <> v_product_id)
  ) then
    raise exception 'Ya existe un producto con ese SKU.' using errcode = '23505';
  end if;

  if v_is_reuse then
    delete from public.product_inventory_links link where link.product_id = v_product_id;
    delete from public.product_components component where component.parent_product_id = v_product_id;

    update public.products
    set sku = v_sku,
        name = v_name,
        type = v_product_type::public.product_type,
        is_combo = v_product_type = 'combo',
        source_price_amount = v_source_price_amount,
        source_price_currency = v_source_price_currency::public.currency_code,
        units_per_service = v_units_per_service,
        is_active = false,
        is_inventory_item = v_policy = 'self',
        is_temporary = v_is_temporary,
        is_detail_editable = false,
        detail_units_limit = v_detail_units_limit,
        is_combo_component_selectable = false,
        inventory_enabled = v_policy <> 'none',
        inventory_deduction_mode = case when v_policy = 'components' then 'composition' else 'self' end,
        inventory_policy = v_policy,
        inventory_configuration_status = 'draft',
        allows_half_service = v_allows_half_service,
        current_stock_units = 0,
        extra_fields = case
          when v_policy = 'none' then (coalesce(extra_fields, '{}'::jsonb) - 'inventory_none_reason')
            || jsonb_build_object('inventory_none_reason', v_none_reason)
          else coalesce(extra_fields, '{}'::jsonb) - 'inventory_none_reason'
        end
    where id = v_product_id;
  else
    insert into public.products (
      sku,
      name,
      type,
      is_active,
      is_combo,
      source_price_amount,
      source_price_currency,
      base_price_usd,
      base_price_bs,
      units_per_service,
      is_inventory_item,
      is_temporary,
      is_detail_editable,
      detail_units_limit,
      is_combo_component_selectable,
      inventory_enabled,
      inventory_deduction_mode,
      inventory_policy,
      inventory_configuration_status,
      allows_half_service,
      current_stock_units,
      extra_fields
    )
    values (
      v_sku,
      v_name,
      v_product_type::public.product_type,
      false,
      v_product_type = 'combo',
      v_source_price_amount,
      v_source_price_currency::public.currency_code,
      0,
      0,
      v_units_per_service,
      v_policy = 'self',
      v_is_temporary,
      false,
      v_detail_units_limit,
      false,
      v_policy <> 'none',
      case when v_policy = 'components' then 'composition' else 'self' end,
      v_policy,
      'draft',
      v_allows_half_service,
      0,
      case
        when v_policy = 'none' then jsonb_build_object('inventory_none_reason', v_none_reason)
        else '{}'::jsonb
      end
    )
    returning id into v_product_id;
  end if;

  if v_policy = 'self' then
    v_self_item := p_configuration -> 'self_item';
    if v_self_item is null or jsonb_typeof(v_self_item) <> 'object' then
      raise exception 'La politica self requiere definir el item que representa al producto.'
        using errcode = '22023';
    end if;

    v_self_mode := lower(btrim(coalesce(v_self_item ->> 'mode', '')));
    if v_self_mode = 'new' then
      v_new_inventory_item_id := app_private.inventory_create_draft_item_v1(
        v_self_item -> 'inventory_item',
        coalesce(v_self_item -> 'presentations', '[]'::jsonb)
      );
      v_inventory_item_id := v_new_inventory_item_id;
    elsif v_self_mode = 'existing' then
      v_inventory_item_id := (v_self_item ->> 'inventory_item_id')::bigint;
    else
      raise exception 'Selecciona si el item propio es nuevo o existente.' using errcode = '22023';
    end if;

    select item.*
    into v_mirror_item
    from public.inventory_items item
    where item.id = v_inventory_item_id
      and item.merged_into_item_id is null;
    if not found then
      raise exception 'El item fisico seleccionado no existe o es un alias historico.' using errcode = '22023';
    end if;

    v_quantity_units := coalesce(
      nullif(btrim(coalesce(v_self_item ->> 'quantity_units', '')), '')::numeric,
      1
    );
    v_deduction_stage := nullif(lower(btrim(coalesce(v_self_item ->> 'deduction_stage', ''))), '');
    if v_quantity_units <= 0 then
      raise exception 'La cantidad descontada debe ser positiva.' using errcode = '22023';
    end if;
    if v_deduction_stage is not null
      and v_deduction_stage not in ('kitchen', 'production', 'packing', 'fulfillment')
    then
      raise exception 'La etapa de descuento no es valida.' using errcode = '22023';
    end if;

    insert into public.product_inventory_links (
      product_id,
      inventory_item_id,
      deduction_mode,
      quantity_units,
      sort_order,
      is_active,
      configuration_version,
      deduction_stage
    )
    values (
      v_product_id,
      v_inventory_item_id,
      'self_link',
      v_quantity_units,
      1,
      true,
      1,
      v_deduction_stage
    );

    update public.products
    set inventory_kind = case
          when v_mirror_item.inventory_kind in ('raw_material', 'prepared_base')
            then v_mirror_item.inventory_kind
          else 'finished_good'
        end,
        inventory_unit_name = v_mirror_item.unit_name,
        packaging_name = v_mirror_item.packaging_name,
        packaging_size = v_mirror_item.packaging_size,
        low_stock_threshold = v_mirror_item.low_stock_threshold,
        inventory_group = v_mirror_item.inventory_group
    where id = v_product_id;
  elsif v_policy = 'direct' then
    if p_configuration -> 'links' is null
      or jsonb_typeof(p_configuration -> 'links') <> 'array'
    then
      raise exception 'La politica direct requiere una lista de items de consumo.'
        using errcode = '22023';
    end if;
    if jsonb_array_length(p_configuration -> 'links') = 0
      or jsonb_array_length(p_configuration -> 'links') > 50
    then
      raise exception 'La politica direct requiere entre 1 y 50 items de consumo.'
        using errcode = '22023';
    end if;

    v_seen_ids := array[]::bigint[];
    for v_link in
      select link_row.value
      from jsonb_array_elements(p_configuration -> 'links') with ordinality as link_row(value, ordinal)
      order by link_row.ordinal
    loop
      v_inventory_item_id := (v_link ->> 'inventory_item_id')::bigint;
      v_quantity_units := (v_link ->> 'quantity_units')::numeric;
      v_deduction_stage := nullif(lower(btrim(coalesce(v_link ->> 'deduction_stage', ''))), '');
      v_link_count := v_link_count + 1;

      if v_inventory_item_id = any(v_seen_ids) then
        raise exception 'Un item no puede repetirse en el consumo directo.' using errcode = '22023';
      end if;
      v_seen_ids := array_append(v_seen_ids, v_inventory_item_id);
      if v_quantity_units <= 0 then
        raise exception 'Cada cantidad de consumo directo debe ser positiva.' using errcode = '22023';
      end if;
      if v_deduction_stage is not null
        and v_deduction_stage not in ('kitchen', 'production', 'packing', 'fulfillment')
      then
        raise exception 'La etapa de descuento no es valida.' using errcode = '22023';
      end if;
      if not exists (
        select 1
        from public.inventory_items item
        where item.id = v_inventory_item_id
          and item.merged_into_item_id is null
      ) then
        raise exception 'Uno de los items de consumo no existe o es un alias historico.'
          using errcode = '22023';
      end if;

      insert into public.product_inventory_links (
        product_id,
        inventory_item_id,
        deduction_mode,
        quantity_units,
        sort_order,
        is_active,
        configuration_version,
        deduction_stage
      )
      values (
        v_product_id,
        v_inventory_item_id,
        'recipe',
        v_quantity_units,
        v_link_count,
        true,
        1,
        v_deduction_stage
      );
    end loop;
  elsif v_policy = 'components' then
    if p_configuration -> 'components' is null
      or jsonb_typeof(p_configuration -> 'components') <> 'array'
    then
      raise exception 'La politica components requiere una lista de productos componentes.'
        using errcode = '22023';
    end if;
    if jsonb_array_length(p_configuration -> 'components') = 0
      or jsonb_array_length(p_configuration -> 'components') > 100
    then
      raise exception 'La politica components requiere entre 1 y 100 componentes.'
        using errcode = '22023';
    end if;

    v_seen_ids := array[]::bigint[];
    for v_component in
      select component_row.value
      from jsonb_array_elements(p_configuration -> 'components') with ordinality as component_row(value, ordinal)
      order by component_row.ordinal
    loop
      v_component_product_id := (v_component ->> 'component_product_id')::bigint;
      v_component_mode := lower(btrim(coalesce(v_component ->> 'component_mode', 'fixed')));
      v_quantity_units := (v_component ->> 'quantity')::numeric;
      v_counts_toward_detail_limit := coalesce(
        nullif(btrim(coalesce(v_component ->> 'counts_toward_detail_limit', '')), '')::boolean,
        true
      );
      v_is_required := coalesce(
        nullif(btrim(coalesce(v_component ->> 'is_required', '')), '')::boolean,
        v_component_mode = 'fixed'
      );
      v_component_count := v_component_count + 1;

      if v_component_mode not in ('fixed', 'selectable') then
        raise exception 'El modo de componente no es valido.' using errcode = '22023';
      end if;
      if v_quantity_units <= 0 then
        raise exception 'Cada cantidad de componente debe ser positiva.' using errcode = '22023';
      end if;
      if v_component_product_id = v_product_id then
        raise exception 'Un producto no puede ser componente de si mismo.' using errcode = '22023';
      end if;
      if (v_component_product_id * 10 + case when v_component_mode = 'selectable' then 1 else 0 end)
        = any(v_seen_ids)
      then
        raise exception 'Un componente no puede repetirse con el mismo modo.' using errcode = '22023';
      end if;
      v_seen_ids := array_append(
        v_seen_ids,
        v_component_product_id * 10 + case when v_component_mode = 'selectable' then 1 else 0 end
      );
      if not exists (select 1 from public.products product where product.id = v_component_product_id) then
        raise exception 'Uno de los productos componente no existe.' using errcode = '22023';
      end if;

      v_has_selectable_components := v_has_selectable_components or v_component_mode = 'selectable';
      v_sort_order := v_component_count;
      insert into public.product_components (
        parent_product_id,
        component_product_id,
        component_mode,
        quantity,
        counts_toward_detail_limit,
        is_required,
        sort_order
      )
      values (
        v_product_id,
        v_component_product_id,
        v_component_mode::public.product_component_mode,
        v_quantity_units,
        v_counts_toward_detail_limit,
        v_is_required,
        v_sort_order
      );
    end loop;

    if v_has_selectable_components and v_detail_units_limit <= 0 then
      raise exception 'Una composicion seleccionable requiere un limite de unidades mayor que cero.'
        using errcode = '22023';
    end if;

    update public.products
    set is_detail_editable = v_has_selectable_components,
        is_combo_component_selectable = v_has_selectable_components
    where id = v_product_id;
  end if;

  return jsonb_build_object(
    'entry_kind', 'product',
    'product_id', v_product_id,
    'inventory_item_id', v_new_inventory_item_id,
    'reused_product', v_is_reuse,
    'inventory_policy', v_policy,
    'status', 'draft',
    'is_active', false
  );
end;
$$;

revoke all on function public.inventory_save_catalog_draft_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_save_catalog_draft_v1(jsonb)
  to authenticated;

comment on function public.inventory_save_catalog_draft_v1(jsonb) is
  'Admin-only atomic creator/reuser for inactive inventory and commercial catalog drafts. It never writes stock or activates sale deductions.';
comment on function app_private.inventory_create_draft_item_v1(jsonb, jsonb) is
  'Internal validated writer for inactive zero-stock physical item drafts and their entry presentations.';
