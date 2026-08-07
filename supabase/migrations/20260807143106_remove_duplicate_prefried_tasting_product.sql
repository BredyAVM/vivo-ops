set lock_timeout = '5s';
set statement_timeout = '30s';

do $$
declare
  v_duplicate_product_id bigint;
  v_keeper_product_id bigint;
  v_orphan_inventory_item_id bigint;
  v_deleted_rows integer;
begin
  select p.id
  into strict v_duplicate_product_id
  from public.products p
  where p.sku = 'LOYAL_DEGUSTPF_8'
    and p.name = 'Degustación Prefritos (8 und) Loyal'
    and p.is_active = false;

  select p.id
  into strict v_keeper_product_id
  from public.products p
  where p.sku = 'DEGUSTPF_8'
    and p.name = 'Degustación Prefritos (8 und)'
    and p.is_active = false;

  if exists (
    select 1
    from public.order_items oi
    where oi.product_id = v_duplicate_product_id
  ) then
    raise exception 'El producto duplicado ya aparece en pedidos; se cancela la limpieza.';
  end if;

  if exists (
    select 1
    from public.order_item_components oic
    where oic.component_product_id = v_duplicate_product_id
  ) then
    raise exception 'El producto duplicado ya aparece como componente de un pedido; se cancela la limpieza.';
  end if;

  if exists (
    select 1
    from public.advisor_commission_deductions acd
    where acd.product_id = v_duplicate_product_id
  ) then
    raise exception 'El producto duplicado ya tiene deducciones de comisión; se cancela la limpieza.';
  end if;

  if exists (
    select 1
    from public.product_components pc
    where pc.component_product_id = v_duplicate_product_id
  ) then
    raise exception 'El producto duplicado ya es componente de otro producto; se cancela la limpieza.';
  end if;

  if not exists (
    select 1
    from public.product_components pc
    join public.products component on component.id = pc.component_product_id
    where pc.parent_product_id = v_duplicate_product_id
    having count(*) = 5
      and count(*) filter (where component.sku = 'MINI_TEQ_PF_25' and pc.quantity = 2) = 1
      and count(*) filter (where component.sku = 'CACH_PF_20' and pc.quantity = 2) = 1
      and count(*) filter (where component.sku = 'BOMB_PF_25' and pc.quantity = 2) = 1
      and count(*) filter (where component.sku = 'EMP_PF_20' and pc.quantity = 1) = 1
      and count(*) filter (where component.sku = 'MAND_PF_25' and pc.quantity = 1) = 1
  ) then
    raise exception 'La composición comercial del duplicado cambió; se cancela la limpieza.';
  end if;

  if not exists (
    select 1
    from public.product_inventory_links pil
    join public.inventory_items item on item.id = pil.inventory_item_id
    where pil.product_id = v_duplicate_product_id
    having count(*) = 5
      and count(*) filter (where item.name = 'Mini Tequeños Pre-Fritos' and pil.quantity_units = 2) = 1
      and count(*) filter (where item.name = 'Cachitas Pre-Fritas' and pil.quantity_units = 2) = 1
      and count(*) filter (where item.name = 'Bombys Pre-Fritos' and pil.quantity_units = 2) = 1
      and count(*) filter (where item.name = 'Empanadas Pre-Fritas' and pil.quantity_units = 1) = 1
      and count(*) filter (where item.name = 'Mandocas Pre-Fritas' and pil.quantity_units = 1) = 1
  ) then
    raise exception 'Los vínculos de inventario del duplicado cambiaron; se cancela la limpieza.';
  end if;

  if not exists (
    select 1
    from public.product_inventory_links pil
    join public.inventory_items item on item.id = pil.inventory_item_id
    where pil.product_id = v_keeper_product_id
    having count(*) = 5
      and count(*) filter (where item.name = 'Mini Tequeños Crudos' and pil.quantity_units = 2) = 1
      and count(*) filter (where item.name = 'Cachitas Crudas' and pil.quantity_units = 2) = 1
      and count(*) filter (where item.name = 'Bombys Crudos' and pil.quantity_units = 2) = 1
      and count(*) filter (where item.name = 'Empanadas Crudas' and pil.quantity_units = 1) = 1
      and count(*) filter (where item.name = 'Mandocas Crudas' and pil.quantity_units = 1) = 1
  ) then
    raise exception 'El producto que debe conservarse ya no descuenta las ocho piezas crudas esperadas.';
  end if;

  select item.id
  into strict v_orphan_inventory_item_id
  from public.inventory_items item
  where item.name = 'Degustación Prefritos (8 und) Loyal'
    and item.is_active = false
    and item.current_stock_units = 0;

  if exists (
    select 1 from public.inventory_count_lines where inventory_item_id = v_orphan_inventory_item_id
    union all
    select 1 from public.inventory_item_presentations where inventory_item_id = v_orphan_inventory_item_id
    union all
    select 1 from public.inventory_items where merged_into_item_id = v_orphan_inventory_item_id
    union all
    select 1 from public.inventory_lots where inventory_item_id = v_orphan_inventory_item_id
    union all
    select 1 from public.inventory_movements where inventory_item_id = v_orphan_inventory_item_id
    union all
    select 1 from public.inventory_planned_flows where inventory_item_id = v_orphan_inventory_item_id
    union all
    select 1 from public.inventory_recipe_components where input_inventory_item_id = v_orphan_inventory_item_id
    union all
    select 1 from public.inventory_recipes where output_inventory_item_id = v_orphan_inventory_item_id
    union all
    select 1 from public.product_inventory_links where inventory_item_id = v_orphan_inventory_item_id
  ) then
    raise exception 'El ítem interno huérfano ya tiene dependencias; se cancela la limpieza.';
  end if;

  delete from public.product_components
  where parent_product_id = v_duplicate_product_id;
  get diagnostics v_deleted_rows = row_count;
  if v_deleted_rows <> 5 then
    raise exception 'Se esperaban eliminar 5 componentes; se eliminaron %.', v_deleted_rows;
  end if;

  delete from public.product_inventory_links
  where product_id = v_duplicate_product_id;
  get diagnostics v_deleted_rows = row_count;
  if v_deleted_rows <> 5 then
    raise exception 'Se esperaban eliminar 5 vínculos de inventario; se eliminaron %.', v_deleted_rows;
  end if;

  delete from public.products
  where id = v_duplicate_product_id;
  get diagnostics v_deleted_rows = row_count;
  if v_deleted_rows <> 1 then
    raise exception 'No se eliminó exactamente un producto duplicado.';
  end if;

  delete from public.inventory_items
  where id = v_orphan_inventory_item_id;
  get diagnostics v_deleted_rows = row_count;
  if v_deleted_rows <> 1 then
    raise exception 'No se eliminó exactamente un ítem interno huérfano.';
  end if;
end
$$;
