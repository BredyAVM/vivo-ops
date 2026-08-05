-- Inventory catalog classification (Block 1).
--
-- This backfills only non-operational inventory metadata. It deliberately does
-- not change products.inventory_enabled, products.inventory_deduction_mode,
-- product_inventory_links, current_stock_units, recipes, or movements. The
-- current delivery deduction code still understands only the legacy
-- self/composition behavior, so product-policy activation must be coordinated
-- with the later atomic engine cutover.

set lock_timeout = '5s';
set statement_timeout = '60s';

create temporary table inventory_catalog_classification_stage (
  inventory_item_id bigint primary key,
  expected_name text not null,
  tracking_mode text not null,
  consumption_triggers text[],
  availability_mode text,
  target_stock_units numeric,
  shelf_life_days integer,
  merged_into_item_id bigint,
  primary_count_frequency text,
  primary_count_role text,
  low_stock_threshold numeric,
  replace_low_stock_threshold boolean not null,
  low_stock_inclusive boolean not null
) on commit drop;

insert into inventory_catalog_classification_stage (
  inventory_item_id,
  expected_name,
  tracking_mode,
  consumption_triggers,
  availability_mode,
  target_stock_units,
  shelf_life_days,
  merged_into_item_id,
  primary_count_frequency,
  primary_count_role,
  low_stock_threshold,
  replace_low_stock_threshold,
  low_stock_inclusive
)
values
  (22, 'Aderezo Mostaza Miel 2oz', 'transactional', array['sale']::text[], 'immediate_recipe', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (23, 'Aderezo Mostaza Miel 5oz', 'transactional', array['sale']::text[], 'immediate_recipe', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (52, 'Bombys Beneficio del mes', 'not_tracked', null, null, null, null, 19, null, null, null, false, true),
  (19, 'Bombys Crudos', 'transactional', array['sale', 'production']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (60, 'Bombys Crudos (Beneficio del Mes)', 'not_tracked', null, null, null, null, 19, null, null, null, false, true),
  (54, 'Bombys Fritos Beneficio Destacado del mes', 'not_tracked', null, null, null, null, 19, null, null, null, false, true),
  (17, 'Bombys Pre-Fritos', 'transactional', array['sale']::text[], 'scheduled_recipe', 10, 90, null, 'per_shift', 'kitchen', 10, true, false),
  (59, 'Bombys Pre-Fritos (Beneficio del Mes)', 'not_tracked', null, null, null, null, 17, null, null, null, false, true),
  (13, 'Cachitas Crudas', 'transactional', array['sale', 'production']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (63, 'Cachitas Crudas (Beneficio del Mes)', 'not_tracked', null, null, null, null, 13, null, null, null, false, true),
  (61, 'Cachitas Fritas (Beneficio del Mes)', 'not_tracked', null, null, null, null, 13, null, null, null, false, true),
  (15, 'Cachitas Pre-Fritas', 'transactional', array['sale']::text[], 'scheduled_recipe', 10, 90, null, 'per_shift', 'kitchen', 10, true, false),
  (62, 'Cachitas Pre-Fritas (Beneficio del Mes)', 'not_tracked', null, null, null, null, 15, null, null, null, false, true),
  (40, 'Chinotto 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (41, 'Chinotto 2 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (37, 'Coca-Cola 1 Lt', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (36, 'Coca-Cola 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (67, 'Coca-Cola 1,5 Lts (Mayor)', 'not_tracked', null, null, null, null, 36, null, null, null, false, true),
  (38, 'Coca-Cola 2 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (39, 'Coca-Cola Lata', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (44, 'Coca-Cola Sin Azúcar 1 Lt', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (45, 'Coca-Cola Sin Azúcar 2 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (50, 'Combo Baby Mix Frito (25 und) Ajustado', 'not_tracked', null, null, null, null, null, null, null, null, false, true),
  (53, 'Combo Rumba Mix Frito (76 und) Ajustado', 'not_tracked', null, null, null, null, null, null, null, null, false, true),
  (49, 'Combo Sexy Mix Frito (50 und) Ajustado', 'not_tracked', null, null, null, null, null, null, null, null, false, true),
  (24, 'Crema de Leche 2oz', 'not_tracked', null, null, null, null, null, null, null, null, false, true),
  (25, 'Crema de Leche 5oz', 'not_tracked', null, null, null, null, null, null, null, null, false, true),
  (69, 'Dondy (und)', 'not_tracked', null, null, null, null, 47, null, null, null, false, true),
  (47, 'Dondys', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (10, 'Dondys (6 und)', 'not_tracked', null, null, null, null, 47, null, null, null, false, true),
  (6, 'Empanadas Crudas', 'transactional', array['sale', 'production']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (65, 'Empanadas Crudas (Beneficio del Mes)', 'not_tracked', null, null, null, null, 6, null, null, null, false, true),
  (55, 'Empanadas de Cerdo Crudas', 'transactional', array['sale']::text[], 'on_hand_only', 0, null, null, 'per_shift', 'kitchen', null, false, true),
  (64, 'Empanadas Fritas (Beneficio del Mes)', 'not_tracked', null, null, null, null, 6, null, null, null, false, true),
  (14, 'Empanadas Pre-Fritas', 'transactional', array['sale']::text[], 'scheduled_recipe', 10, 90, null, 'per_shift', 'kitchen', 10, true, false),
  (66, 'Empanadas Pre-Fritas (Beneficio del Mes)', 'not_tracked', null, null, null, null, 14, null, null, null, false, true),
  (42, 'Frescolita 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (43, 'Frescolita 2 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (46, 'Jugo del Valle 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (34, 'Lipton Durazno 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (35, 'Lipton Limón 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (30, 'Malta Lata', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (5, 'Mandocas Crudas', 'transactional', array['sale', 'production']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (58, 'Mandocas Crudas (Beneficio del Mes)', 'not_tracked', null, null, null, null, 5, null, null, null, false, true),
  (16, 'Mandocas Pre-Fritas', 'transactional', array['sale']::text[], 'scheduled_recipe', 10, 90, null, 'per_shift', 'kitchen', 10, true, false),
  (57, 'Mandocas Pre-Fritas (Beneficio del Mes)', 'not_tracked', null, null, null, null, 16, null, null, null, false, true),
  (2, 'Mini tequeño prefrito', 'transactional', array['sale']::text[], 'scheduled_recipe', 10, 90, null, 'per_shift', 'kitchen', 10, true, false),
  (12, 'Mini Tequeños Crudos', 'not_tracked', null, null, null, null, 1, null, null, null, false, true),
  (56, 'Mini Tequeños Fritos (Beneficio del Mes)', 'not_tracked', null, null, null, null, 1, null, null, null, false, true),
  (51, 'Mini Tequeños Fritos Beneficio del mes', 'not_tracked', null, null, null, null, 1, null, null, null, false, true),
  (11, 'Mini Tequeños Pre-Fritos', 'not_tracked', null, null, null, null, 2, null, null, null, false, true),
  (70, 'Pack para Colegios', 'not_tracked', null, null, null, null, null, null, null, null, false, true),
  (29, 'Pepsi 1 Lt', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (26, 'Pepsi 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (28, 'Pepsi 2 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (27, 'Pepsi Lata', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (9, 'Salsa Tártara 1oz', 'transactional', array['sale']::text[], 'immediate_recipe', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (21, 'Salsa Tártara 2oz', 'transactional', array['sale']::text[], 'immediate_recipe', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (8, 'Salsa Tártara 5oz', 'transactional', array['sale']::text[], 'immediate_recipe', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (71, 'Salsa Tártara 5oz Obsequio', 'not_tracked', null, null, null, null, 8, null, null, null, false, true),
  (68, 'Salsa Tártara Galón', 'transactional', array['sale', 'production']::text[], 'immediate_recipe', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (20, 'Tequeños Regulares Crudos', 'transactional', array['sale', 'production']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (18, 'Tequeños Regulares Pre-Fritos', 'transactional', array['sale']::text[], 'scheduled_recipe', 0, 90, null, 'per_shift', 'kitchen', null, false, true),
  (31, 'Yukery Manzana 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (32, 'Yukery Naranja 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (33, 'Yukery Pera 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (75, 'Yukypack', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true),
  (48, 'Cajas grandes', 'periodic_count', null, 'on_hand_only', null, null, null, 'biweekly', 'master', null, false, true),
  (3, 'Mayonesa', 'transactional', array['production']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (4, 'Menjurje', 'transactional', array['production']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (1, 'Mini tequeño crudo', 'transactional', array['sale', 'production']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (7, 'Salsa Tartara', 'transactional', array['sale', 'production']::text[], 'immediate_recipe', null, null, null, 'per_shift', 'kitchen', null, false, true),
  (72, 'Malta lata', 'not_tracked', null, null, null, null, 30, null, null, null, false, true),
  (74, 'Pepsi lata', 'not_tracked', null, null, null, null, 27, null, null, null, false, true),
  (73, 'Yukipack', 'not_tracked', null, null, null, null, 75, null, null, null, false, true),
  (76, 'Fanta Naranja 1,5 Lts', 'transactional', array['sale']::text[], 'on_hand_only', null, null, null, 'per_shift', 'kitchen', 10, true, true);

do $$
begin
  if (select count(*) from inventory_catalog_classification_stage) <> 76 then
    raise exception 'Inventory catalog classification must contain exactly 76 items';
  end if;

  if exists (
    select 1
    from inventory_catalog_classification_stage staged
    left join public.inventory_items item
      on item.id = staged.inventory_item_id
     and item.name = staged.expected_name
    where item.id is null
  ) then
    raise exception 'Inventory catalog drift detected: an expected item id/name is missing';
  end if;

  if exists (
    select 1
    from inventory_catalog_classification_stage staged
    left join public.inventory_items target
      on target.id = staged.merged_into_item_id
    where staged.merged_into_item_id is not null
      and target.id is null
  ) then
    raise exception 'Inventory alias target is missing';
  end if;
end;
$$;

update public.inventory_items item
set
  tracking_mode = staged.tracking_mode,
  consumption_triggers = staged.consumption_triggers,
  availability_mode = staged.availability_mode,
  target_stock_units = staged.target_stock_units,
  shelf_life_days = staged.shelf_life_days,
  merged_into_item_id = staged.merged_into_item_id,
  primary_count_frequency = staged.primary_count_frequency,
  primary_count_role = staged.primary_count_role::public.user_role,
  low_stock_threshold = case
    when staged.replace_low_stock_threshold then staged.low_stock_threshold
    else item.low_stock_threshold
  end,
  low_stock_inclusive = staged.low_stock_inclusive
from inventory_catalog_classification_stage staged
where item.id = staged.inventory_item_id;

do $$
begin
  if (select count(*) from public.inventory_items where tracking_mode = 'transactional') <> 46 then
    raise exception 'Expected 46 transactional inventory items after classification';
  end if;

  if (select count(*) from public.inventory_items where tracking_mode = 'periodic_count') <> 1 then
    raise exception 'Expected 1 periodic-count inventory item after classification';
  end if;

  if (select count(*) from public.inventory_items where tracking_mode = 'not_tracked') <> 29 then
    raise exception 'Expected 29 non-tracked inventory aliases or historical items after classification';
  end if;

  if (select count(*) from public.inventory_items where merged_into_item_id is not null) <> 23 then
    raise exception 'Expected 23 historical aliases with a physical canonical target';
  end if;

  if (
    select count(*)
    from public.inventory_items
    where primary_count_frequency = 'per_shift'
      and primary_count_role = 'kitchen'::public.user_role
  ) <> 46 then
    raise exception 'Expected 46 per-shift items assigned to Kitchen';
  end if;

  if not exists (
    select 1
    from public.inventory_items
    where id = 48
      and tracking_mode = 'periodic_count'
      and primary_count_frequency = 'biweekly'
      and primary_count_role = 'master'::public.user_role
  ) then
    raise exception 'Cajas grandes must remain a Master-owned biweekly periodic count';
  end if;
end;
$$;
