-- Bloque 24: prueba reversible del adaptador de Cocina.
-- Ejecutar únicamente en un entorno con el catálogo canónico abierto.

begin;

do $$
declare
  v_kitchen_user_id uuid;
  v_item_id bigint;
  v_stock_before numeric;
  v_loss_operation_id uuid := '24000000-0000-4000-8000-000000000001'::uuid;
  v_receipt_operation_id uuid := '24000000-0000-4000-8000-000000000002'::uuid;
  v_count_operation_id uuid := '24000000-0000-4000-8000-000000000003'::uuid;
begin
  select role_row.user_id
  into v_kitchen_user_id
  from public.user_roles role_row
  where role_row.role = 'kitchen'::public.user_role
  order by role_row.user_id
  limit 1;

  select item.id, item.current_stock_units
  into v_item_id, v_stock_before
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.current_stock_units >= 2
    and app_private.inventory_item_has_accepted_opening_v1(item.id)
  order by case when item.inventory_group = 'raw' then 0 else 1 end, item.id
  limit 1;

  if v_kitchen_user_id is null or v_item_id is null then
    raise exception 'La prueba requiere un usuario de Cocina y un ítem abierto con al menos 2 unidades.';
  end if;

  perform set_config('request.jwt.claim.sub', v_kitchen_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  perform public.inventory_record_loss_v1(
    v_loss_operation_id,
    v_item_id,
    'quality_taste',
    1,
    'block_24_transaction_test',
    'Bloque 24: prueba reversible',
    null
  );

  perform public.inventory_reconcile_receipt_v1(
    v_receipt_operation_id,
    v_item_id,
    jsonb_build_object(
      'quantity_unknown', false,
      'source_name', 'Bloque 24',
      'loose_units', 1,
      'presentations', '[]'::jsonb
    ),
    null,
    'BLOCK24-ROLLBACK',
    now(),
    null,
    'Bloque 24: entrada reversible'
  );

  perform public.inventory_submit_count_v1(
    v_count_operation_id,
    'shift_change',
    jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_item_id,
      'counted_quantity_units', v_stock_before - 1,
      'note', 'Bloque 24: conteo reversible'
    )),
    'Bloque 24: conteo reversible',
    null,
    null
  );

  if (
    select count(*)
    from public.inventory_movements movement
    where movement.operation_id in (v_loss_operation_id, v_receipt_operation_id, v_count_operation_id)
  ) <> 3 then
    raise exception 'La secuencia no creó los tres movimientos esperados.';
  end if;

  if not exists (
    select 1
    from public.inventory_counts count_header
    join public.inventory_count_lines count_line
      on count_line.inventory_count_id = count_header.id
    join public.inventory_movements movement
      on movement.id = count_line.movement_id
    where movement.operation_id = v_count_operation_id
      and count_header.status = 'submitted'
      and count_header.responsible_role = 'kitchen'::public.user_role
  ) then
    raise exception 'El conteo no quedó enviado bajo responsabilidad de Cocina.';
  end if;

  if exists (
    select 1
    from public.inventory_movements movement
    where movement.operation_id in (v_loss_operation_id, v_receipt_operation_id, v_count_operation_id)
      and movement.created_by_user_id is distinct from v_kitchen_user_id
  ) then
    raise exception 'Un movimiento perdió la identidad del usuario de Cocina.';
  end if;
end;
$$;

rollback;

-- Después del rollback deben cumplirse las tres consultas:
-- 1) cero movimientos con los UUID del bloque;
-- 2) cero lotes con lot_code = 'BLOCK24-ROLLBACK';
-- 3) saldos originales intactos.
