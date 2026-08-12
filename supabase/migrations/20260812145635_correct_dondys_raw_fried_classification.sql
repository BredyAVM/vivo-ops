-- Correct the Dondys classification without introducing a second stock item.
-- The physical source is raw product received in bags of 30 UND. Commercial
-- Dondy presentations are fried on demand and deduct the exact included UND.

set lock_timeout = '5s';
set statement_timeout = '30s';

do $$
declare
  v_canonical_item_id bigint;
  v_product_count integer;
begin
  select item.id
  into strict v_canonical_item_id
  from public.inventory_items item
  where item.name = 'Dondys'
    and item.merged_into_item_id is null;

  if not exists (
    select 1
    from public.inventory_item_presentations presentation
    where presentation.inventory_item_id = v_canonical_item_id
      and presentation.is_active
      and presentation.base_units_per_presentation = 30
  ) then
    raise exception 'El Dondy canónico no tiene su presentación activa de 30 UND.';
  end if;

  update public.inventory_items
  set
    name = 'Dondys Crudos',
    inventory_kind = 'raw_material',
    inventory_group = 'raw',
    unit_name = 'pieza',
    packaging_name = 'bolsa',
    packaging_size = 30,
    notes = case
      when nullif(btrim(coalesce(notes, '')), '') is null then
        'Producto crudo de masa hojaldrada rellena de Nutella. Se recibe en bolsas de 30 UND y se fríe al vender; no tiene etapa prefrita.'
      when notes not ilike '%masa hojaldrada%' then
        notes || E'\nProducto crudo de masa hojaldrada rellena de Nutella. Se recibe en bolsas de 30 UND y se fríe al vender; no tiene etapa prefrita.'
      else notes
    end
  where id = v_canonical_item_id;

  -- Preserve legacy aliases and their history, but classify them as aliases of
  -- the raw source so they never appear as beverages or independent stock.
  update public.inventory_items
  set
    inventory_kind = 'raw_material',
    inventory_group = 'raw'
  where merged_into_item_id = v_canonical_item_id;

  -- Every commercial, promotional or historical Dondy remains a finished fried
  -- product. This also fixes catalog grouping for inactive seasonal variants.
  update public.products
  set inventory_group = 'fried'
  where inventory_kind = 'finished_good'
    and (
      upper(coalesce(sku, '')) like '%DOND%'
      or lower(name) like '%dondy%'
    );

  get diagnostics v_product_count = row_count;
  if v_product_count = 0 then
    raise exception 'No se encontró ningún producto comercial Dondy para reclasificar.';
  end if;

  -- One legacy individual-product link still targeted its merged alias. Point it
  -- to the same canonical raw stock used by services, promos, combos and Vivo Box.
  update public.product_inventory_links link
  set inventory_item_id = v_canonical_item_id
  where link.inventory_item_id in (
      select alias.id
      from public.inventory_items alias
      where alias.merged_into_item_id = v_canonical_item_id
    )
    and exists (
      select 1
      from public.products product
      where product.id = link.product_id
        and (
          upper(coalesce(product.sku, '')) like '%DOND%'
          or lower(product.name) like '%dondy%'
        )
    );

  if exists (
    select 1
    from public.products product
    where (
        upper(coalesce(product.sku, '')) like '%DOND%'
        or lower(product.name) like '%dondy%'
      )
      and product.inventory_kind = 'finished_good'
      and product.inventory_group <> 'fried'
  ) then
    raise exception 'Quedaron productos Dondy fuera de la familia de fritos.';
  end if;

  if exists (
    select 1
    from public.product_inventory_links link
    join public.inventory_items item on item.id = link.inventory_item_id
    join public.products product on product.id = link.product_id
    where item.merged_into_item_id = v_canonical_item_id
      and (
        upper(coalesce(product.sku, '')) like '%DOND%'
        or lower(product.name) like '%dondy%'
      )
  ) then
    raise exception 'Quedaron enlaces Dondy apuntando a un alias fusionado.';
  end if;
end;
$$;
