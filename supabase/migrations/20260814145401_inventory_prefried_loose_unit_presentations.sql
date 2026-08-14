-- Prefried stock remains canonical in services, while Kitchen can count
-- complete services plus individual loose units.
-- Reuses inventory_item_presentations; no balance, table, or column is added.

begin;

set lock_timeout = '5s';
set statement_timeout = '30s';

with prefried_seed(item_name, units_per_service) as (
  values
    ('Mini tequeño prefrito', 25::numeric),
    ('Empanadas Pre-Fritas', 20::numeric),
    ('Cachitas Pre-Fritas', 20::numeric),
    ('Mandocas Pre-Fritas', 25::numeric),
    ('Bombys Pre-Fritos', 25::numeric)
)
insert into public.inventory_item_presentations (
  inventory_item_id,
  name,
  base_units_per_presentation,
  allows_fractional_quantity,
  is_active
)
select
  item.id,
  'UND sueltas',
  1::numeric / seed.units_per_service,
  false,
  true
from prefried_seed seed
join public.inventory_items item
  on item.name = seed.item_name
 and item.inventory_group = 'prefried'
 and item.merged_into_item_id is null
where not exists (
  select 1
  from public.inventory_item_presentations presentation
  where presentation.inventory_item_id = item.id
    and lower(btrim(presentation.name)) = 'und sueltas'
);

do $verify$
declare
  v_count integer;
begin
  select count(*)
  into v_count
  from public.inventory_item_presentations presentation
  join public.inventory_items item on item.id = presentation.inventory_item_id
  where item.name in (
    'Mini tequeño prefrito',
    'Empanadas Pre-Fritas',
    'Cachitas Pre-Fritas',
    'Mandocas Pre-Fritas',
    'Bombys Pre-Fritos'
  )
    and item.inventory_group = 'prefried'
    and presentation.is_active
    and not presentation.allows_fractional_quantity
    and lower(btrim(presentation.name)) = 'und sueltas'
    and presentation.base_units_per_presentation in (0.04::numeric, 0.05::numeric);

  if v_count <> 5 then
    raise exception 'No se configuraron las cinco presentaciones de UND sueltas prefritas.';
  end if;
end;
$verify$;

commit;
