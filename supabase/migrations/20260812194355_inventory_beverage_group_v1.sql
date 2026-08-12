-- Canonical beverage family.
-- Reuses inventory_group on inventory_items/products; no balance, table, or
-- movement is created.

set lock_timeout = '5s';
set statement_timeout = '120s';

alter table public.inventory_items
  drop constraint inventory_items_group_check;
alter table public.inventory_items
  add constraint inventory_items_group_check
  check (inventory_group in (
    'raw', 'fried', 'prefried', 'sauces', 'beverages', 'packaging', 'other'
  )) not valid;
alter table public.inventory_items
  validate constraint inventory_items_group_check;

alter table public.products
  drop constraint products_inventory_group_check;
alter table public.products
  add constraint products_inventory_group_check
  check (inventory_group in (
    'raw', 'fried', 'prefried', 'sauces', 'beverages', 'packaging', 'other'
  )) not valid;
alter table public.products
  validate constraint products_inventory_group_check;

do $migration$
declare
  v_function_definition text;
  v_updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'app_private.inventory_create_draft_item_v1(jsonb,jsonb)'::regprocedure
  )
  into v_function_definition;

  v_updated_definition := replace(
    v_function_definition,
    $old$if v_inventory_group not in ('raw', 'fried', 'prefried', 'sauces', 'packaging', 'other') then$old$,
    $new$if v_inventory_group not in ('raw', 'fried', 'prefried', 'sauces', 'beverages', 'packaging', 'other') then$new$
  );

  if v_updated_definition = v_function_definition then
    raise exception 'No se encontró la validación canónica de inventory_group en inventory_create_draft_item_v1.';
  end if;

  execute v_updated_definition;
end;
$migration$;

do $migration$
declare
  v_expected_count integer;
begin
  with expected(id, name) as (
    values
      (26::bigint, 'Pepsi 1,5 Lts'::text),
      (27::bigint, 'Pepsi Lata'::text),
      (28::bigint, 'Pepsi 2 Lts'::text),
      (29::bigint, 'Pepsi 1 Lt'::text),
      (30::bigint, 'Malta Lata'::text),
      (31::bigint, 'Yukery Manzana 1,5 Lts'::text),
      (32::bigint, 'Yukery Naranja 1,5 Lts'::text),
      (33::bigint, 'Yukery Pera 1,5 Lts'::text),
      (34::bigint, 'Lipton Durazno 1,5 Lts'::text),
      (35::bigint, 'Lipton Limón 1,5 Lts'::text),
      (36::bigint, 'Coca-Cola 1,5 Lts'::text),
      (38::bigint, 'Coca-Cola 2 Lts'::text),
      (39::bigint, 'Coca-Cola Lata'::text),
      (40::bigint, 'Chinotto 1,5 Lts'::text),
      (42::bigint, 'Frescolita 1,5 Lts'::text),
      (43::bigint, 'Frescolita 2 Lts'::text),
      (46::bigint, 'Jugo del Valle 1,5 Lts'::text),
      (76::bigint, 'Fanta Naranja 1,5 Lts'::text),
      (109::bigint, 'Yukipack Manzana'::text),
      (110::bigint, 'Yukipack Pera'::text),
      (111::bigint, 'Yukipack Durazno'::text)
  )
  select count(*)
  into v_expected_count
  from expected
  join public.inventory_items item
    on item.id = expected.id
   and item.name = expected.name
   and item.inventory_group = 'other';

  if v_expected_count <> 21 then
    raise exception 'La clasificación auditada de 21 bebidas cambió; se detiene la migración.';
  end if;
end;
$migration$;

update public.inventory_items item
set inventory_group = 'beverages'
where item.id = any(array[
  26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 38, 39, 40, 42, 43, 46, 76,
  109, 110, 111
]::bigint[])
  and item.inventory_group = 'other';

update public.products product
set inventory_group = 'beverages'
where exists (
  select 1
  from public.product_inventory_links link
  where link.product_id = product.id
    and link.configuration_version = 1
    and link.inventory_item_id = any(array[
      26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 38, 39, 40, 42, 43, 46, 76,
      109, 110, 111
    ]::bigint[])
)
  and product.inventory_group = 'other';

comment on column public.inventory_items.inventory_group is
  'Canonical operational family: raw, fried, prefried, sauces, beverages, packaging, or other.';
comment on column public.products.inventory_group is
  'Catalog family aligned to its canonical inventory target, including beverages.';
