set lock_timeout = '5s';
set statement_timeout = '60s';

-- Block 2 deliberately separates the canonical product policy from the legacy
-- deduction switch. The current order-delivery path still consumes
-- products.inventory_deduction_mode and active version-0 links, so neither is
-- modified here.

create temporary table inventory_block2_legacy_guard on commit drop as
select
  (
    select md5(coalesce(string_agg(
      concat_ws('|',
        id::text,
        inventory_enabled::text,
        coalesce(inventory_deduction_mode, '<null>'),
        current_stock_units::text
      ), E'\n' order by id
    ), ''))
    from public.products
  ) as product_legacy_hash,
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
        is_active::text
      ), E'\n' order by id
    ), ''))
    from public.product_inventory_links
  ) as legacy_link_hash,
  (
    select md5(coalesce(string_agg(
      concat_ws('|',
        id::text,
        parent_product_id::text,
        component_product_id::text,
        quantity::text,
        component_mode,
        is_required::text,
        sort_order::text
      ), E'\n' order by id
    ), ''))
    from public.product_components
  ) as component_hash,
  (
    select md5(coalesce(string_agg(
      concat_ws('|', id::text, current_stock_units::text),
      E'\n' order by id
    ), ''))
    from public.inventory_items
  ) as inventory_stock_hash,
  (select count(*) from public.inventory_movements) as movement_count,
  (select count(*) from public.inventory_recipes) as recipe_count;

do $$
declare
  actual_product_hash text;
begin
  select md5(coalesce(string_agg(
    concat_ws('|', id::text, coalesce(sku, ''), coalesce(name, '')),
    E'\n' order by id
  ), ''))
  into actual_product_hash
  from public.products;

  if (select count(*) from public.products) <> 143
     or actual_product_hash <> '0162e2db992ca064bec6240c97575be4' then
    raise exception
      'Block 2 stopped: the live product catalog changed after the audit (count %, hash %).',
      (select count(*) from public.products),
      actual_product_hash;
  end if;

  if (select count(*) from public.product_inventory_links) <> 107 then
    raise exception 'Block 2 stopped: expected 107 legacy inventory links.';
  end if;

  if (select count(*) from public.product_components) <> 233 then
    raise exception 'Block 2 stopped: expected 233 product components.';
  end if;
end
$$;

alter table public.products
  add column inventory_policy text,
  add column inventory_configuration_status text not null default 'draft',
  add column allows_half_service boolean not null default false;

alter table public.products
  add constraint products_inventory_policy_check
    check (
      inventory_policy is null
      or inventory_policy in ('self', 'direct', 'components', 'none')
    ),
  add constraint products_inventory_configuration_status_check
    check (
      inventory_configuration_status in (
        'draft',
        'ready',
        'needs_recipe',
        'needs_reconfiguration',
        'needs_catalog_correction',
        'needs_review'
      )
    );

comment on column public.products.inventory_policy is
  'Canonical inventory policy. Independent from the legacy inventory_deduction_mode until engine cutover.';
comment on column public.products.inventory_configuration_status is
  'Readiness of the product inventory configuration. New products start as draft.';
comment on column public.products.allows_half_service is
  'Whether the product may be sold as a half service; deduction uses the resolved order quantity.';

alter table public.product_inventory_links
  add column configuration_version integer not null default 0,
  add column deduction_stage text;

alter table public.product_inventory_links
  add constraint product_inventory_links_configuration_version_check
    check (configuration_version >= 0),
  add constraint product_inventory_links_deduction_stage_check
    check (
      deduction_stage is null
      or deduction_stage in ('kitchen', 'production', 'packing', 'fulfillment')
    );

create unique index product_inventory_links_version_item_uidx
  on public.product_inventory_links (
    product_id,
    inventory_item_id,
    configuration_version
  );

comment on column public.product_inventory_links.configuration_version is
  'Version 0 is the legacy active mapping. Version 1 is the canonical Block 2 mapping staged inactive.';
comment on column public.product_inventory_links.deduction_stage is
  'Operational stage at which the canonical engine will consume the linked inventory item.';

create temporary table inventory_product_policy_stage (
  product_id bigint primary key,
  inventory_policy text not null,
  configuration_status text not null,
  allows_half_service boolean not null
) on commit drop;

insert into inventory_product_policy_stage (
  product_id,
  inventory_policy,
  configuration_status,
  allows_half_service
)
select
  id,
  case
    when id = any(array[1,61,62,63,64,65,66,67,92,94,95,96,97,100,101,104,105,107,108,125,126,127,132,134,135,136,142,143,144,147,148,149,155,157,158,159,160]::bigint[]) then 'components'
    when id = any(array[4,5,8,11,14,17,20,51,52,53,54,55,56,57,58,59,60,89,93,99,102,103,106,109,110,113,117,119,122,129,130,133,137,138,153,156,161]::bigint[]) then 'direct'
    when id = any(array[70,71,72,73,74,75,76,77,78,79,139,140,141]::bigint[]) then 'none'
    when id = any(array[2,6,7,9,10,12,13,15,16,18,19,21,22,23,24,25,26,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,111,112,114,115,116,118,120,121,123,124,128,131,146,150,151,152,154,162]::bigint[]) then 'self'
    else null
  end,
  case
    when id = any(array[25,26]::bigint[]) then 'needs_recipe'
    when id = any(array[105,135]::bigint[]) then 'needs_reconfiguration'
    when id = 109 then 'needs_catalog_correction'
    else 'ready'
  end,
  id = any(array[4,5,8,11,14,17,102,103,106,109,110,113,117,119,122]::bigint[])
from public.products;

do $$
begin
  if (select count(*) from inventory_product_policy_stage) <> 143 then
    raise exception 'Block 2 stopped: policy stage must contain 143 products.';
  end if;

  if exists (
    select 1
    from inventory_product_policy_stage
    where inventory_policy is null
  ) then
    raise exception 'Block 2 stopped: at least one live product has no canonical policy.';
  end if;

  if (select count(*) from inventory_product_policy_stage where inventory_policy = 'self') <> 56
     or (select count(*) from inventory_product_policy_stage where inventory_policy = 'direct') <> 37
     or (select count(*) from inventory_product_policy_stage where inventory_policy = 'components') <> 37
     or (select count(*) from inventory_product_policy_stage where inventory_policy = 'none') <> 13 then
    raise exception 'Block 2 stopped: canonical policy distribution does not match the audited catalog.';
  end if;

  if (select count(*) from inventory_product_policy_stage where configuration_status = 'ready') <> 138
     or (select count(*) from inventory_product_policy_stage where configuration_status = 'needs_recipe') <> 2
     or (select count(*) from inventory_product_policy_stage where configuration_status = 'needs_reconfiguration') <> 2
     or (select count(*) from inventory_product_policy_stage where configuration_status = 'needs_catalog_correction') <> 1 then
    raise exception 'Block 2 stopped: configuration status distribution is invalid.';
  end if;

  if (select count(*) from inventory_product_policy_stage where allows_half_service) <> 15 then
    raise exception 'Block 2 stopped: half-service policy must cover exactly 15 products.';
  end if;
end
$$;

update public.products as product
set
  inventory_policy = stage.inventory_policy,
  inventory_configuration_status = stage.configuration_status,
  allows_half_service = stage.allows_half_service
from inventory_product_policy_stage as stage
where stage.product_id = product.id;

create temporary table inventory_product_link_stage (
  product_id bigint not null,
  inventory_item_id bigint not null,
  deduction_mode text not null,
  quantity_units numeric(14,3) not null,
  deduction_stage text not null,
  primary key (product_id, inventory_item_id)
) on commit drop;

insert into inventory_product_link_stage (
  product_id,
  inventory_item_id,
  deduction_mode,
  quantity_units,
  deduction_stage
)
values
  (2,9,'self_link',1,'fulfillment'),
  (4,47,'recipe',6,'kitchen'),
  (5,1,'recipe',25,'kitchen'),
  (6,2,'self_link',1,'fulfillment'),
  (7,1,'self_link',25,'fulfillment'),
  (8,6,'recipe',20,'kitchen'),
  (9,14,'self_link',1,'fulfillment'),
  (10,6,'self_link',20,'fulfillment'),
  (11,13,'recipe',20,'kitchen'),
  (12,15,'self_link',1,'fulfillment'),
  (13,13,'self_link',20,'fulfillment'),
  (14,5,'recipe',25,'kitchen'),
  (15,16,'self_link',1,'fulfillment'),
  (16,5,'self_link',25,'fulfillment'),
  (17,19,'recipe',25,'kitchen'),
  (18,17,'self_link',1,'fulfillment'),
  (19,19,'self_link',25,'fulfillment'),
  (20,20,'recipe',5,'kitchen'),
  (21,18,'self_link',1,'fulfillment'),
  (22,20,'self_link',5,'fulfillment'),
  (23,21,'self_link',1,'fulfillment'),
  (24,8,'self_link',1,'fulfillment'),
  (25,22,'self_link',1,'fulfillment'),
  (26,23,'self_link',1,'fulfillment'),
  (30,26,'self_link',1,'fulfillment'),
  (31,29,'self_link',1,'fulfillment'),
  (32,28,'self_link',1,'fulfillment'),
  (33,27,'self_link',1,'fulfillment'),
  (34,30,'self_link',1,'fulfillment'),
  (35,31,'self_link',1,'fulfillment'),
  (36,32,'self_link',1,'fulfillment'),
  (37,33,'self_link',1,'fulfillment'),
  (38,34,'self_link',1,'fulfillment'),
  (39,35,'self_link',1,'fulfillment'),
  (40,36,'self_link',1,'fulfillment'),
  (41,37,'self_link',1,'fulfillment'),
  (42,38,'self_link',1,'fulfillment'),
  (43,39,'self_link',1,'fulfillment'),
  (44,40,'self_link',1,'fulfillment'),
  (45,41,'self_link',1,'fulfillment'),
  (46,42,'self_link',1,'fulfillment'),
  (47,43,'self_link',1,'fulfillment'),
  (48,44,'self_link',1,'fulfillment'),
  (49,45,'self_link',1,'fulfillment'),
  (50,46,'self_link',1,'fulfillment'),
  (51,1,'recipe',12,'kitchen'),
  (51,6,'recipe',10,'kitchen'),
  (52,1,'recipe',12,'kitchen'),
  (52,13,'recipe',10,'kitchen'),
  (53,1,'recipe',12,'kitchen'),
  (53,19,'recipe',12,'kitchen'),
  (54,1,'recipe',12,'kitchen'),
  (54,5,'recipe',12,'kitchen'),
  (55,6,'recipe',10,'kitchen'),
  (55,13,'recipe',10,'kitchen'),
  (56,13,'recipe',10,'kitchen'),
  (56,19,'recipe',12,'kitchen'),
  (57,5,'recipe',12,'kitchen'),
  (57,13,'recipe',10,'kitchen'),
  (58,6,'recipe',10,'kitchen'),
  (58,19,'recipe',12,'kitchen'),
  (59,5,'recipe',12,'kitchen'),
  (59,6,'recipe',10,'kitchen'),
  (60,5,'recipe',12,'kitchen'),
  (60,19,'recipe',12,'kitchen'),
  (89,47,'recipe',1,'kitchen'),
  (93,47,'recipe',3,'kitchen'),
  (99,47,'recipe',3,'kitchen'),
  (102,1,'recipe',25,'kitchen'),
  (103,19,'recipe',25,'kitchen'),
  (106,19,'recipe',25,'kitchen'),
  (109,55,'recipe',20,'kitchen'),
  (110,1,'recipe',25,'kitchen'),
  (111,1,'self_link',25,'fulfillment'),
  (112,2,'self_link',1,'fulfillment'),
  (113,5,'recipe',25,'kitchen'),
  (114,16,'self_link',1,'fulfillment'),
  (115,5,'self_link',25,'fulfillment'),
  (116,17,'self_link',1,'fulfillment'),
  (117,19,'recipe',25,'kitchen'),
  (118,19,'self_link',25,'fulfillment'),
  (119,13,'recipe',20,'kitchen'),
  (120,15,'self_link',1,'fulfillment'),
  (121,13,'self_link',20,'fulfillment'),
  (122,6,'recipe',20,'kitchen'),
  (123,6,'self_link',20,'fulfillment'),
  (124,14,'self_link',1,'fulfillment'),
  (128,36,'self_link',1,'fulfillment'),
  (129,47,'recipe',6,'kitchen'),
  (130,47,'recipe',1,'kitchen'),
  (131,68,'self_link',1,'fulfillment'),
  (133,47,'recipe',1,'kitchen'),
  (137,47,'recipe',1,'kitchen'),
  (138,47,'recipe',3,'kitchen'),
  (146,8,'self_link',1,'fulfillment'),
  (150,30,'self_link',1,'fulfillment'),
  (151,75,'self_link',1,'fulfillment'),
  (152,27,'self_link',1,'fulfillment'),
  (153,47,'recipe',1,'kitchen'),
  (154,75,'self_link',1,'fulfillment'),
  (156,47,'recipe',1,'kitchen'),
  (161,47,'recipe',1,'kitchen'),
  (162,76,'self_link',1,'fulfillment');

do $$
begin
  if (select count(*) from inventory_product_link_stage) <> 103
     or (select count(distinct product_id) from inventory_product_link_stage) <> 93 then
    raise exception 'Block 2 stopped: canonical links must contain 103 rows for 93 products.';
  end if;

  if (select count(*) from inventory_product_link_stage where deduction_mode = 'self_link') <> 56
     or (select count(*) from inventory_product_link_stage where deduction_mode = 'recipe') <> 47 then
    raise exception 'Block 2 stopped: canonical link mode distribution is invalid.';
  end if;

  if exists (
    select 1
    from inventory_product_link_stage as link
    left join public.inventory_items as item on item.id = link.inventory_item_id
    where item.id is null or item.merged_into_item_id is not null
  ) then
    raise exception 'Block 2 stopped: a staged link points to a missing or aliased inventory item.';
  end if;

  if exists (
    select 1
    from inventory_product_link_stage as link
    join inventory_product_policy_stage as policy on policy.product_id = link.product_id
    where (policy.inventory_policy = 'self' and link.deduction_mode <> 'self_link')
       or (policy.inventory_policy = 'direct' and link.deduction_mode <> 'recipe')
       or policy.inventory_policy in ('components', 'none')
  ) then
    raise exception 'Block 2 stopped: a staged link conflicts with its product policy.';
  end if;

  if exists (
    select 1
    from inventory_product_policy_stage as policy
    left join inventory_product_link_stage as link on link.product_id = policy.product_id
    where policy.inventory_policy in ('self', 'direct')
    group by policy.product_id, policy.inventory_policy
    having count(link.product_id) = 0
       or (policy.inventory_policy = 'self' and count(link.product_id) <> 1)
  ) then
    raise exception 'Block 2 stopped: self/direct product link coverage is incomplete.';
  end if;

  if exists (
    select 1
    from public.product_components as component
    join inventory_product_policy_stage as policy
      on policy.product_id = component.parent_product_id
    where policy.inventory_policy not in ('components', 'direct')
  ) then
    raise exception 'Block 2 stopped: existing component definitions conflict with canonical product policies.';
  end if;

  if exists (
    select 1
    from public.product_components as component
    join inventory_product_policy_stage as policy
      on policy.product_id = component.parent_product_id
    where policy.inventory_policy = 'direct'
      and component.parent_product_id <> all(array[51,52,53,54,55,56,57,58,59,60]::bigint[])
  ) then
    raise exception 'Block 2 stopped: only the ten audited mixed services may combine direct policy with catalog components.';
  end if;

  if exists (
    select 1
    from inventory_product_policy_stage as policy
    left join public.product_components as component
      on component.parent_product_id = policy.product_id
    where policy.inventory_policy = 'components'
      and policy.configuration_status = 'ready'
    group by policy.product_id
    having count(component.id) = 0
  ) then
    raise exception 'Block 2 stopped: a ready component product has no component definition.';
  end if;
end
$$;

insert into public.product_inventory_links (
  product_id,
  inventory_item_id,
  deduction_mode,
  quantity_units,
  sort_order,
  notes,
  is_active,
  configuration_version,
  deduction_stage
)
select
  product_id,
  inventory_item_id,
  deduction_mode,
  quantity_units,
  row_number() over (partition by product_id order by inventory_item_id),
  'Block 2: canonical configuration staged; deductions remain inactive.',
  false,
  1,
  deduction_stage
from inventory_product_link_stage
on conflict (product_id, inventory_item_id, configuration_version)
do update set
  deduction_mode = excluded.deduction_mode,
  quantity_units = excluded.quantity_units,
  sort_order = excluded.sort_order,
  notes = excluded.notes,
  is_active = false,
  deduction_stage = excluded.deduction_stage;

do $$
declare
  guard inventory_block2_legacy_guard%rowtype;
  current_product_legacy_hash text;
  current_legacy_link_hash text;
  current_component_hash text;
  current_inventory_stock_hash text;
begin
  select * into guard from inventory_block2_legacy_guard;

  select md5(coalesce(string_agg(
    concat_ws('|',
      id::text,
      inventory_enabled::text,
      coalesce(inventory_deduction_mode, '<null>'),
      current_stock_units::text
    ), E'\n' order by id
  ), ''))
  into current_product_legacy_hash
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
      is_active::text
    ), E'\n' order by id
  ), ''))
  into current_legacy_link_hash
  from public.product_inventory_links
  where configuration_version = 0;

  select md5(coalesce(string_agg(
    concat_ws('|',
      id::text,
      parent_product_id::text,
      component_product_id::text,
      quantity::text,
      component_mode,
      is_required::text,
      sort_order::text
    ), E'\n' order by id
  ), ''))
  into current_component_hash
  from public.product_components;

  select md5(coalesce(string_agg(
    concat_ws('|', id::text, current_stock_units::text),
    E'\n' order by id
  ), ''))
  into current_inventory_stock_hash
  from public.inventory_items;

  if current_product_legacy_hash is distinct from guard.product_legacy_hash then
    raise exception 'Block 2 stopped: legacy product deduction fields changed.';
  end if;

  if current_legacy_link_hash is distinct from guard.legacy_link_hash then
    raise exception 'Block 2 stopped: legacy product inventory links changed.';
  end if;

  if current_component_hash is distinct from guard.component_hash then
    raise exception 'Block 2 stopped: product components changed.';
  end if;

  if current_inventory_stock_hash is distinct from guard.inventory_stock_hash then
    raise exception 'Block 2 stopped: inventory balances changed.';
  end if;

  if (select count(*) from public.inventory_movements) <> guard.movement_count
     or (select count(*) from public.inventory_recipes) <> guard.recipe_count then
    raise exception 'Block 2 stopped: movements or recipes changed.';
  end if;

  if (select count(*) from public.product_inventory_links where configuration_version = 0) <> 107
     or (select count(*) from public.product_inventory_links where configuration_version = 1) <> 103
     or exists (
       select 1
       from public.product_inventory_links
       where configuration_version = 1 and is_active
     ) then
    raise exception 'Block 2 stopped: canonical link staging is incomplete or active.';
  end if;
end
$$;
