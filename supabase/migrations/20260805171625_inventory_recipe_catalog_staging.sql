set lock_timeout = '5s';
set statement_timeout = '60s';

-- Block 3 prepares canonical recipes without exposing them to the legacy
-- production command. Existing active recipes, balances and movements remain
-- untouched until the atomic inventory engine replaces that command.

create temporary table inventory_block3_guard on commit drop as
select
  (
    select md5(coalesce(string_agg(
      concat_ws('|', id::text, current_stock_units::text),
      E'\n' order by id
    ), ''))
    from public.inventory_items
  ) as existing_stock_hash,
  (
    select md5(coalesce(string_agg(
      concat_ws('|',
        id::text,
        inventory_enabled::text,
        inventory_deduction_mode,
        current_stock_units::text
      ), E'\n' order by id
    ), ''))
    from public.products
  ) as legacy_product_hash,
  (
    select md5(coalesce(string_agg(
      concat_ws('|',
        id::text,
        product_id::text,
        inventory_item_id::text,
        deduction_mode,
        quantity_units::text,
        sort_order::text,
        coalesce(notes, '<null>'),
        is_active::text,
        configuration_version::text,
        coalesce(deduction_stage, '<null>')
      ), E'\n' order by id
    ), ''))
    from public.product_inventory_links
  ) as product_link_hash,
  (
    select md5(coalesce(string_agg(
      concat_ws('|',
        id::text,
        parent_product_id::text,
        component_product_id::text,
        component_mode::text,
        quantity::text,
        counts_toward_detail_limit::text,
        is_required::text,
        sort_order::text,
        coalesce(notes, '<null>')
      ), E'\n' order by id
    ), ''))
    from public.product_components
    where parent_product_id <> 105
  ) as unrelated_product_component_hash,
  (
    select md5(coalesce(string_agg(
      concat_ws('|',
        id::text,
        output_inventory_item_id::text,
        recipe_kind,
        output_quantity_units::text,
        coalesce(notes, '<null>'),
        is_active::text,
        lead_time_minutes::text,
        production_multiple::text,
        version::text
      ), E'\n' order by id
    ), ''))
    from public.inventory_recipes
  ) as legacy_recipe_hash,
  (
    select md5(coalesce(string_agg(
      concat_ws('|',
        id::text,
        recipe_id::text,
        input_inventory_item_id::text,
        quantity_units::text,
        sort_order::text
      ), E'\n' order by id
    ), ''))
    from public.inventory_recipe_components
  ) as legacy_recipe_component_hash,
  (select count(*) from public.inventory_movements) as movement_count;

do $$
declare
  product_identity_hash text;
  item_metadata_hash text;
begin
  select md5(coalesce(string_agg(
    concat_ws('|', id::text, coalesce(sku, ''), name),
    E'\n' order by id
  ), ''))
  into product_identity_hash
  from public.products;

  select md5(coalesce(string_agg(
    concat_ws('|',
      id::text,
      name,
      inventory_kind,
      inventory_group,
      unit_name,
      coalesce(packaging_name, '<null>'),
      coalesce(packaging_size::text, '<null>')
    ), E'\n' order by id
  ), ''))
  into item_metadata_hash
  from public.inventory_items;

  if (select count(*) from public.products) <> 143
     or product_identity_hash <> '0162e2db992ca064bec6240c97575be4' then
    raise exception 'Block 3 stopped: the product catalog changed after Block 2.';
  end if;

  if (select count(*) from public.inventory_items) <> 76
     or item_metadata_hash <> '315d870078277da447fff937598aeb58' then
    raise exception 'Block 3 stopped: inventory item metadata changed after the audit.';
  end if;

  if (select count(*) from public.inventory_recipes) <> 2
     or (select count(*) from public.inventory_recipe_components) <> 3 then
    raise exception 'Block 3 stopped: expected exactly two legacy recipes and three components.';
  end if;

  if (select count(*) from public.inventory_item_presentations) <> 0 then
    raise exception 'Block 3 stopped: presentations are no longer empty and require reconciliation.';
  end if;

  if (select count(*) from public.product_components where parent_product_id = 105) <> 4
     or exists (
       select 1 from public.product_components where parent_product_id = 135
     ) then
    raise exception 'Block 3 stopped: Evento/Colegio composition changed after the audit.';
  end if;
end
$$;

create unique index inventory_recipes_output_kind_version_uidx
  on public.inventory_recipes (output_inventory_item_id, recipe_kind, version);

create unique index inventory_recipe_components_recipe_input_uidx
  on public.inventory_recipe_components (recipe_id, input_inventory_item_id);

create temporary table inventory_block3_item_ids (
  item_key text primary key,
  inventory_item_id bigint not null unique
) on commit drop;

with inserted_item as (
  insert into public.inventory_items (
    name,
    inventory_kind,
    unit_name,
    packaging_name,
    packaging_size,
    current_stock_units,
    low_stock_threshold,
    is_active,
    notes,
    inventory_group,
    tracking_mode,
    consumption_triggers,
    availability_mode,
    target_stock_units,
    shelf_life_days,
    primary_count_frequency,
    primary_count_role,
    low_stock_inclusive
  )
  values (
    'Aderezo Mostaza Miel a granel (envase 1 kg)',
    'prepared_base',
    'envase',
    'envase de 1 kg',
    1,
    0,
    null,
    true,
    'Base comprada lista para porcionar. Rendimiento canónico: 8 porciones de 5 oz o 20 porciones de 2 oz.',
    'sauces',
    'transactional',
    array['production']::text[],
    'on_hand_only',
    null,
    null,
    'per_shift',
    'kitchen'::public.user_role,
    true
  )
  returning id
)
insert into inventory_block3_item_ids (item_key, inventory_item_id)
select 'mustard_honey_bulk_1kg', id
from inserted_item;

do $$
begin
  if (select count(*) from inventory_block3_item_ids) <> 1 then
    raise exception 'Block 3 stopped: mustard honey bulk item was not created exactly once.';
  end if;
end
$$;

insert into public.inventory_item_presentations (
  inventory_item_id,
  name,
  base_units_per_presentation,
  allows_fractional_quantity,
  is_active
)
select
  inventory_item_id,
  'Envase de 1 kg',
  1,
  true,
  true
from inventory_block3_item_ids
where item_key = 'mustard_honey_bulk_1kg';

update public.inventory_items as item
set
  name = canonical.name,
  inventory_kind = canonical.inventory_kind,
  inventory_group = canonical.inventory_group,
  unit_name = canonical.unit_name,
  packaging_name = canonical.packaging_name,
  packaging_size = canonical.packaging_size,
  notes = canonical.notes
from (
  values
    (2::bigint, 'Mini tequeño prefrito', 'finished_stock', 'prefried', 'servicio', 'servicio de 25 piezas', 1::numeric, 'Existencia canónica por servicio prefrito de 25 piezas; preparación y enfriamiento: 240 minutos.'),
    (4::bigint, 'Menjurje', 'raw_material', 'sauces', 'kg', null, null::numeric, 'Base de verduras licuadas; se consumen 0,050 kg por cada kg de mayonesa.'),
    (5::bigint, 'Mandocas Crudas', 'raw_material', 'raw', 'pieza', 'bolsa', 100::numeric, 'Materia prima canónica; bolsa de 100 o unidades sueltas.'),
    (6::bigint, 'Empanadas Crudas', 'raw_material', 'raw', 'pieza', 'bolsa', 150::numeric, 'Materia prima canónica; bolsa de 150 o unidades sueltas.'),
    (7::bigint, 'Salsa Tártara a granel', 'prepared_base', 'sauces', 'recipiente', 'recipiente tipo kilo', 1::numeric, 'Se cuenta por recipiente y fracciones 0,25; 0,50; 0,75 o 1. El rendimiento real de cada preparación se declara.'),
    (8::bigint, 'Salsa Tártara 5oz', 'finished_stock', 'sauces', 'porción', 'vaso de 5 oz', 1::numeric, 'Porción lista. Rendimiento conservador: 8 por recipiente tipo kilo.'),
    (9::bigint, 'Salsa Tártara 1oz', 'finished_stock', 'sauces', 'porción', 'vaso de 1 oz', 1::numeric, 'Porción lista. Rendimiento proporcional: 40 por recipiente tipo kilo.'),
    (13::bigint, 'Cachitas Crudas', 'raw_material', 'raw', 'pieza', 'bolsa', 150::numeric, 'Materia prima canónica; bolsa de 150 o unidades sueltas.'),
    (14::bigint, 'Empanadas Pre-Fritas', 'finished_stock', 'prefried', 'servicio', 'servicio de 20 piezas', 1::numeric, 'Existencia canónica por servicio prefrito de 20 piezas; preparación y enfriamiento: 240 minutos.'),
    (15::bigint, 'Cachitas Pre-Fritas', 'finished_stock', 'prefried', 'servicio', 'servicio de 20 piezas', 1::numeric, 'Existencia canónica por servicio prefrito de 20 piezas; preparación y enfriamiento: 240 minutos.'),
    (16::bigint, 'Mandocas Pre-Fritas', 'finished_stock', 'prefried', 'servicio', 'servicio de 25 piezas', 1::numeric, 'Existencia canónica por servicio prefrito de 25 piezas; preparación y enfriamiento: 240 minutos.'),
    (17::bigint, 'Bombys Pre-Fritos', 'finished_stock', 'prefried', 'servicio', 'servicio de 25 piezas', 1::numeric, 'Existencia canónica por servicio prefrito de 25 piezas; preparación y enfriamiento: 240 minutos.'),
    (18::bigint, 'Tequeños Regulares Pre-Fritos', 'finished_stock', 'prefried', 'servicio', 'servicio de 5 piezas', 1::numeric, 'Prefrito bajo demanda de 5 piezas; objetivo cero y anticipación de 240 minutos.'),
    (19::bigint, 'Bombys Crudos', 'raw_material', 'raw', 'pieza', 'bolsa', 150::numeric, 'Materia prima canónica; bolsa de 150 o unidades sueltas.'),
    (20::bigint, 'Tequeños Regulares Crudos', 'raw_material', 'raw', 'pieza', 'bolsa', 100::numeric, 'Materia prima canónica; bolsa de 100 o unidades sueltas.'),
    (21::bigint, 'Salsa Tártara 2oz', 'finished_stock', 'sauces', 'porción', 'vaso de 2 oz', 1::numeric, 'Porción lista. Rendimiento proporcional: 20 por recipiente tipo kilo.'),
    (22::bigint, 'Aderezo Mostaza Miel 2oz', 'finished_stock', 'sauces', 'porción', 'vaso de 2 oz', 1::numeric, 'Porción lista. Rendimiento: 20 por envase de 1 kg.'),
    (23::bigint, 'Aderezo Mostaza Miel 5oz', 'finished_stock', 'sauces', 'porción', 'vaso de 5 oz', 1::numeric, 'Porción lista. Rendimiento: 8 por envase de 1 kg.'),
    (55::bigint, 'Empanadas Pulled Pork Crudas', 'raw_material', 'raw', 'pieza', 'bolsa', 100::numeric, 'Materia prima estacional Pulled Pork; servicio frito de 20 y medio servicio de 10.'),
    (68::bigint, 'Salsa Tártara Galón', 'finished_stock', 'sauces', 'recipiente', 'galón', 1::numeric, 'Recipiente de galón preparado; puede venderse o porcionarse posteriormente.')
) as canonical(
  id,
  name,
  inventory_kind,
  inventory_group,
  unit_name,
  packaging_name,
  packaging_size,
  notes
)
where item.id = canonical.id;

update public.products
set inventory_configuration_status = 'ready'
where id in (25, 26);

update public.products
set
  name = 'Evento personalizado',
  is_detail_editable = true,
  detail_units_limit = 0,
  is_combo_component_selectable = true,
  inventory_policy = 'components',
  inventory_configuration_status = 'ready'
where id = 105;

update public.products
set
  name = 'Empanadas Pulled Pork Fritas (20 und)',
  inventory_configuration_status = 'ready'
where id = 109;

update public.products
set
  name = 'Pack para Colegios (histórico)',
  inventory_policy = 'none',
  inventory_configuration_status = 'ready'
where id = 135;

update public.product_components
set notes = 'Evento personalizado: cantidad abierta; la selección real debe congelarse en el pedido.'
where parent_product_id = 105;

insert into public.product_components (
  parent_product_id,
  component_product_id,
  component_mode,
  quantity,
  counts_toward_detail_limit,
  is_required,
  sort_order,
  notes
)
select
  105,
  14,
  'selectable'::public.product_component_mode,
  1,
  true,
  true,
  5,
  'Evento personalizado: cantidad abierta; la selección real debe congelarse en el pedido.'
where not exists (
  select 1
  from public.product_components
  where parent_product_id = 105
    and component_product_id = 14
    and component_mode = 'selectable'::public.product_component_mode
);

create temporary table inventory_block3_recipe_stage (
  recipe_key text primary key,
  output_inventory_item_id bigint not null,
  recipe_kind text not null,
  output_quantity_units numeric not null,
  lead_time_minutes integer not null,
  production_multiple numeric not null,
  version integer not null,
  notes text not null
) on commit drop;

insert into inventory_block3_recipe_stage values
  ('prefried_mini_tequenos', 2, 'production', 1, 240, 1, 1, 'Bloque 3: canónica preparada; 25 piezas crudas producen 1 servicio prefrito de 25.'),
  ('prefried_empanadas', 14, 'production', 1, 240, 1, 1, 'Bloque 3: canónica preparada; 20 piezas crudas producen 1 servicio prefrito de 20.'),
  ('prefried_cachitas', 15, 'production', 1, 240, 1, 1, 'Bloque 3: canónica preparada; 20 piezas crudas producen 1 servicio prefrito de 20.'),
  ('prefried_mandocas', 16, 'production', 1, 240, 1, 1, 'Bloque 3: canónica preparada; 25 piezas crudas producen 1 servicio prefrito de 25.'),
  ('prefried_bombys', 17, 'production', 1, 240, 1, 1, 'Bloque 3: canónica preparada; 25 piezas crudas producen 1 servicio prefrito de 25.'),
  ('prefried_tequenos_regulares', 18, 'production', 1, 240, 1, 1, 'Bloque 3: canónica preparada; 5 piezas crudas producen 1 servicio prefrito bajo demanda.'),
  ('tartara_from_bases', 7, 'production', 1, 0, 0.25, 2, 'Bloque 3: canónica preparada; la salida real se declara por recipiente o fracción.'),
  ('tartara_5oz_from_bulk', 8, 'packaging', 1, 0, 1, 1, 'Bloque 3: canónica preparada; 8 porciones de 5 oz por recipiente tipo kilo.'),
  ('tartara_2oz_from_bulk', 21, 'packaging', 1, 0, 1, 1, 'Bloque 3: canónica preparada; 20 porciones de 2 oz por recipiente tipo kilo.'),
  ('tartara_1oz_from_bulk', 9, 'packaging', 1, 0, 1, 1, 'Bloque 3: canónica preparada; 40 porciones de 1 oz por recipiente tipo kilo.'),
  ('tartara_gallon_from_bases', 68, 'production', 1, 0, 1, 1, 'Bloque 3: canónica preparada; referencia nominal de 4 kg de mayonesa por galón.'),
  ('mustard_honey_5oz_from_bulk', 23, 'packaging', 1, 0, 1, 1, 'Bloque 3: canónica preparada; 8 porciones de 5 oz por envase de 1 kg.'),
  ('mustard_honey_2oz_from_bulk', 22, 'packaging', 1, 0, 1, 1, 'Bloque 3: canónica preparada; 20 porciones de 2 oz por envase de 1 kg.');

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
select
  output_inventory_item_id,
  recipe_kind,
  output_quantity_units,
  notes,
  false,
  lead_time_minutes,
  production_multiple,
  version
from inventory_block3_recipe_stage
on conflict (output_inventory_item_id, recipe_kind, version)
do update set
  output_quantity_units = excluded.output_quantity_units,
  notes = excluded.notes,
  is_active = false,
  lead_time_minutes = excluded.lead_time_minutes,
  production_multiple = excluded.production_multiple;

create temporary table inventory_block3_recipe_ids (
  recipe_key text primary key,
  recipe_id bigint not null unique
) on commit drop;

insert into inventory_block3_recipe_ids (recipe_key, recipe_id)
select stage.recipe_key, recipe.id
from inventory_block3_recipe_stage as stage
join public.inventory_recipes as recipe
  on recipe.output_inventory_item_id = stage.output_inventory_item_id
 and recipe.recipe_kind = stage.recipe_kind
 and recipe.version = stage.version;

create temporary table inventory_block3_recipe_component_stage (
  recipe_key text not null,
  input_inventory_item_id bigint not null,
  quantity_units numeric not null,
  sort_order integer not null,
  primary key (recipe_key, input_inventory_item_id)
) on commit drop;

insert into inventory_block3_recipe_component_stage values
  ('prefried_mini_tequenos', 1, 25, 1),
  ('prefried_empanadas', 6, 20, 1),
  ('prefried_cachitas', 13, 20, 1),
  ('prefried_mandocas', 5, 25, 1),
  ('prefried_bombys', 19, 25, 1),
  ('prefried_tequenos_regulares', 20, 5, 1),
  ('tartara_from_bases', 3, 1, 1),
  ('tartara_from_bases', 4, 0.05, 2),
  ('tartara_5oz_from_bulk', 7, 0.125, 1),
  ('tartara_2oz_from_bulk', 7, 0.05, 1),
  ('tartara_1oz_from_bulk', 7, 0.025, 1),
  ('tartara_gallon_from_bases', 3, 4, 1),
  ('tartara_gallon_from_bases', 4, 0.2, 2);

insert into inventory_block3_recipe_component_stage (
  recipe_key,
  input_inventory_item_id,
  quantity_units,
  sort_order
)
select
  recipe_key,
  item.inventory_item_id,
  quantity_units,
  1
from (
  values
    ('mustard_honey_5oz_from_bulk', 0.125::numeric),
    ('mustard_honey_2oz_from_bulk', 0.05::numeric)
) as component(recipe_key, quantity_units)
cross join inventory_block3_item_ids as item
where item.item_key = 'mustard_honey_bulk_1kg';

delete from public.inventory_recipe_components as component
using inventory_block3_recipe_ids as canonical
where component.recipe_id = canonical.recipe_id;

insert into public.inventory_recipe_components (
  recipe_id,
  input_inventory_item_id,
  quantity_units,
  sort_order
)
select
  recipe.recipe_id,
  component.input_inventory_item_id,
  component.quantity_units,
  component.sort_order
from inventory_block3_recipe_component_stage as component
join inventory_block3_recipe_ids as recipe using (recipe_key)
order by recipe.recipe_id, component.sort_order;

do $$
declare
  guard inventory_block3_guard%rowtype;
  current_stock_hash text;
  current_legacy_product_hash text;
  current_product_link_hash text;
  current_unrelated_component_hash text;
  current_legacy_recipe_hash text;
  current_legacy_recipe_component_hash text;
begin
  select * into guard from inventory_block3_guard;

  select md5(coalesce(string_agg(
    concat_ws('|', item.id::text, item.current_stock_units::text),
    E'\n' order by item.id
  ), ''))
  into current_stock_hash
  from public.inventory_items as item
  where exists (
    select 1
    from public.inventory_items as existing
    where existing.id = item.id
      and item.id <> (select inventory_item_id from inventory_block3_item_ids)
  );

  select md5(coalesce(string_agg(
    concat_ws('|',
      id::text,
      inventory_enabled::text,
      inventory_deduction_mode,
      current_stock_units::text
    ), E'\n' order by id
  ), ''))
  into current_legacy_product_hash
  from public.products;

  select md5(coalesce(string_agg(
    concat_ws('|',
      id::text,
      product_id::text,
      inventory_item_id::text,
      deduction_mode,
      quantity_units::text,
      sort_order::text,
      coalesce(notes, '<null>'),
      is_active::text,
      configuration_version::text,
      coalesce(deduction_stage, '<null>')
    ), E'\n' order by id
  ), ''))
  into current_product_link_hash
  from public.product_inventory_links;

  select md5(coalesce(string_agg(
    concat_ws('|',
      id::text,
      parent_product_id::text,
      component_product_id::text,
      component_mode::text,
      quantity::text,
      counts_toward_detail_limit::text,
      is_required::text,
      sort_order::text,
      coalesce(notes, '<null>')
    ), E'\n' order by id
  ), ''))
  into current_unrelated_component_hash
  from public.product_components
  where parent_product_id <> 105;

  select md5(coalesce(string_agg(
    concat_ws('|',
      id::text,
      output_inventory_item_id::text,
      recipe_kind,
      output_quantity_units::text,
      coalesce(notes, '<null>'),
      is_active::text,
      lead_time_minutes::text,
      production_multiple::text,
      version::text
    ), E'\n' order by id
  ), ''))
  into current_legacy_recipe_hash
  from public.inventory_recipes
  where id in (1, 2);

  select md5(coalesce(string_agg(
    concat_ws('|',
      id::text,
      recipe_id::text,
      input_inventory_item_id::text,
      quantity_units::text,
      sort_order::text
    ), E'\n' order by id
  ), ''))
  into current_legacy_recipe_component_hash
  from public.inventory_recipe_components
  where id in (1, 2, 3);

  if current_stock_hash is distinct from guard.existing_stock_hash then
    raise exception 'Block 3 stopped: an existing inventory balance changed.';
  end if;

  if current_legacy_product_hash is distinct from guard.legacy_product_hash then
    raise exception 'Block 3 stopped: legacy product deduction fields changed.';
  end if;

  if current_product_link_hash is distinct from guard.product_link_hash then
    raise exception 'Block 3 stopped: product inventory links changed.';
  end if;

  if current_unrelated_component_hash is distinct from guard.unrelated_product_component_hash then
    raise exception 'Block 3 stopped: product components outside Evento changed.';
  end if;

  if current_legacy_recipe_hash is distinct from guard.legacy_recipe_hash
     or current_legacy_recipe_component_hash is distinct from guard.legacy_recipe_component_hash then
    raise exception 'Block 3 stopped: legacy active recipes changed.';
  end if;

  if (select count(*) from public.inventory_movements) <> guard.movement_count then
    raise exception 'Block 3 stopped: inventory movements changed during the migration.';
  end if;

  if (select count(*) from public.inventory_items) <> 77
     or (select count(*) from public.inventory_item_presentations) <> 1
     or (select count(*) from public.inventory_recipes) <> 15
     or (select count(*) from public.inventory_recipe_components) <> 18 then
    raise exception 'Block 3 stopped: resulting catalog row counts are invalid.';
  end if;

  if (select count(*) from inventory_block3_recipe_ids) <> 13
     or exists (
       select 1
       from public.inventory_recipes as recipe
       join inventory_block3_recipe_ids as canonical on canonical.recipe_id = recipe.id
       where recipe.is_active
     ) then
    raise exception 'Block 3 stopped: canonical recipes must contain 13 inactive rows.';
  end if;

  if (select count(*) from public.inventory_recipes where is_active) <> 2 then
    raise exception 'Block 3 stopped: the two legacy active recipes were not preserved.';
  end if;

  if exists (
    select 1
    from inventory_block3_recipe_stage as stage
    join inventory_block3_recipe_ids as ids using (recipe_key)
    left join inventory_block3_recipe_component_stage as component using (recipe_key)
    group by stage.recipe_key, ids.recipe_id
    having count(component.input_inventory_item_id) = 0
  ) then
    raise exception 'Block 3 stopped: at least one canonical recipe has no inputs.';
  end if;

  if exists (
    with recursive recipe_edges as (
      select recipe.output_inventory_item_id as root_item_id,
             component.input_inventory_item_id as next_item_id
      from public.inventory_recipes as recipe
      join public.inventory_recipe_components as component on component.recipe_id = recipe.id
      union all
      select edge.root_item_id,
             component.input_inventory_item_id
      from recipe_edges as edge
      join public.inventory_recipes as recipe on recipe.output_inventory_item_id = edge.next_item_id
      join public.inventory_recipe_components as component on component.recipe_id = recipe.id
      where edge.root_item_id <> edge.next_item_id
    )
    select 1
    from recipe_edges
    where root_item_id = next_item_id
  ) then
    raise exception 'Block 3 stopped: recipe cycle detected.';
  end if;

  if (select count(*) from public.product_components where parent_product_id = 105) <> 5
     or not exists (
       select 1
       from public.product_components
       where parent_product_id = 105
         and component_product_id = 14
         and component_mode = 'selectable'::public.product_component_mode
     ) then
    raise exception 'Block 3 stopped: Evento personalizado must have five selectable fried families.';
  end if;

  if (select count(*) from public.products where inventory_configuration_status = 'ready') <> 143
     or (select count(*) from public.products where inventory_policy = 'self') <> 56
     or (select count(*) from public.products where inventory_policy = 'direct') <> 37
     or (select count(*) from public.products where inventory_policy = 'components') <> 36
     or (select count(*) from public.products where inventory_policy = 'none') <> 14 then
    raise exception 'Block 3 stopped: final product policy/status distribution is invalid.';
  end if;

  if (select count(*) from public.product_inventory_links where configuration_version = 0 and is_active) <> 107
     or (select count(*) from public.product_inventory_links where configuration_version = 1) <> 103
     or exists (
       select 1
       from public.product_inventory_links
       where configuration_version = 1 and is_active
     ) then
    raise exception 'Block 3 stopped: product link staging changed.';
  end if;
end
$$;
