-- Certificación reversible del inventario V1.
-- Ejecutar en producción con las identidades internas indicadas. Todo termina
-- en ROLLBACK y no deja órdenes, saldos, movimientos ni alertas de prueba.
begin;

select set_config(
  'request.jwt.claims',
  '{"sub":"74d6bc21-b6cc-42ef-8f4c-ec47dc5d411d","role":"authenticated"}',
  true
);

do $$
begin
  if (public.inventory_cutover_readiness_v1()->>'inventory_blocks_orders')::boolean then
    raise exception 'Inventario no puede bloquear órdenes en el piloto V1.';
  end if;

  if public.inventory_cutover_readiness_v1()->>'status' <> 'ready_for_canonical_operation' then
    raise exception 'El centro canónico no reporta preparación operativa.';
  end if;

  if (public.inventory_opening_status_v1()->>'pending_count')::int <> 0
    or (public.inventory_opening_status_v1()->>'under_review_count')::int <> 0
  then
    raise exception 'La apertura conserva líneas pendientes.';
  end if;

  if exists (
    select 1
    from public.inventory_alerts alert
    where alert.status='open'
      and alert.inventory_item_id is not null
      and not app_private.inventory_item_is_initialized_v1(alert.inventory_item_id)
  ) then
    raise exception 'Existe una alerta abierta para un ítem no inicializado.';
  end if;

  if exists (
    select 1 from public.inventory_alerts
    where status='open' and alert_type='inventory_sale_sync_failed'
  ) then
    raise exception 'Quedan entregas sin conciliación de inventario.';
  end if;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid=function_row.pronamespace
    where namespace_row.nspname='public'
      and function_row.proname like 'inventory_%'
      and (
        not function_row.prosecdef
        or coalesce(array_to_string(function_row.proconfig,','),'') not like '%search_path=%'
        or has_function_privilege('anon',function_row.oid,'execute')
        or has_function_privilege('public',function_row.oid,'execute')
      )
  ) then
    raise exception 'Una función pública de inventario incumple la frontera de seguridad.';
  end if;
end;
$$;

-- Usar una orden real todavía no entregada, con compromiso materializado. El
-- caso se revierte completamente al final.
create temporary table _inventory_v1_order as
select order_row.id
from public.orders order_row
where order_row.status='out_for_delivery'
  and order_row.source <> 'walk_in'
  and not exists (
    select 1 from public.inventory_movements movement
    where movement.order_id=order_row.id and movement.movement_type='sale_out'
  )
  and exists (
    select 1 from public.inventory_planned_flows flow
    where flow.order_id=order_row.id
      and flow.flow_type='order_commitment'
      and flow.status in ('draft','active')
  )
order by order_row.id
limit 1;

do $$
begin
  if not exists (select 1 from _inventory_v1_order) then
    raise exception 'No existe una orden no entregada apropiada para la prueba transaccional.';
  end if;
end;
$$;

create temporary table _inventory_v1_lines as
select distinct (line.value->>'inventory_item_id')::bigint inventory_item_id
from _inventory_v1_order fixture
cross join lateral jsonb_array_elements(
  app_private.inventory_resolve_order_sale_v1(fixture.id)->'lines'
) line(value);

-- Colocar cada saldo en cero mediante el escritor canónico administrativo.
-- La entrega debe convertirlos en negativos, no rechazar la orden.
do $$
declare line_row record;
begin
  for line_row in select inventory_item_id from _inventory_v1_lines order by inventory_item_id loop
    perform public.inventory_adjust_stock_v1(
      pg_catalog.md5('inventory-v1-negative-certification:'||line_row.inventory_item_id::text)::uuid,
      line_row.inventory_item_id,
      0,
      'pilot_validation',
      'Prueba reversible de saldo negativo no bloqueante.'
    );
  end loop;
end;
$$;

create temporary table _inventory_v1_event_cursor as
select coalesce(max(event.id),0) id
from public.order_timeline_events event
where event.order_id=(select id from _inventory_v1_order);

-- La transición se ejecuta con el rol de Counter, aunque la orden nació en
-- Asesor. Este era el caso que dejó consumos pendientes antes de V3.
select set_config(
  'request.jwt.claims',
  '{"sub":"0e4553ea-9050-452c-94e7-07a81a771135","role":"authenticated"}',
  true
);

update public.orders
set status='delivered'
where id=(select id from _inventory_v1_order);

do $$
declare v_error text;
begin
  if not exists (
    select 1 from public.inventory_movements movement
    where movement.order_id=(select id from _inventory_v1_order)
      and movement.movement_type='sale_out'
  ) then
    raise exception 'El trigger de entrega no escribió los movimientos de venta.';
  end if;

  if not exists (
    select 1
    from public.inventory_items item
    join _inventory_v1_lines line_row on line_row.inventory_item_id=item.id
    where item.current_stock_units < 0
  ) then
    raise exception 'La entrega no expuso el saldo negativo esperado.';
  end if;

  if exists (
    select 1
    from public.order_timeline_events event
    cross join _inventory_v1_event_cursor cursor_row
    where event.order_id=(select id from _inventory_v1_order)
      and event.id>cursor_row.id
      and event.event_type='inventory_sale_sync_failed'
  ) then
    raise exception 'La entrega creó una incidencia de sincronización.';
  end if;

  -- La excepción del trigger no debe convertirse en un permiso RPC manual.
  begin
    perform public.inventory_commit_order_sale_v1(
      gen_random_uuid(),
      (select id from _inventory_v1_order),
      'Prueba de frontera manual de Counter.'
    );
    raise exception 'Counter obtuvo acceso manual sobre una orden ajena.';
  exception when sqlstate '42501' then
    get stacked diagnostics v_error=message_text;
    if v_error not like 'Mostrador solo puede cerrar%' then
      raise;
    end if;
  end;
end;
$$;

-- La disponibilidad de fecha también es informativa para el Asesor.
select set_config(
  'request.jwt.claims',
  '{"sub":"1a496721-7bd7-4571-9632-4714bc76a2d5","role":"authenticated"}',
  true
);

do $$
declare v_result jsonb;
begin
  v_result := public.inventory_catalog_availability_v1(
    now()+interval '1 day',
    array(select product.id from public.products product where product.is_active order by product.id limit 10),
    'advisor_availability'
  );
  if coalesce((v_result->>'inventory_blocks_submission')::boolean,true) then
    raise exception 'La disponibilidad del Asesor se volvió bloqueante.';
  end if;
end;
$$;

-- Resumen visible antes del rollback.
select set_config(
  'request.jwt.claims',
  '{"sub":"74d6bc21-b6cc-42ef-8f4c-ec47dc5d411d","role":"authenticated"}',
  true
);

select jsonb_build_object(
  'certification','pass',
  'order_id',(select id from _inventory_v1_order),
  'sale_out_count',(
    select count(*) from public.inventory_movements
    where order_id=(select id from _inventory_v1_order) and movement_type='sale_out'
  ),
  'negative_item_count',(
    select count(*)
    from public.inventory_items item
    join _inventory_v1_lines line_row on line_row.inventory_item_id=item.id
    where item.current_stock_units<0
  ),
  'inventory_blocks_orders',(
    public.inventory_cutover_readiness_v1()->>'inventory_blocks_orders'
  )::boolean
) result;

rollback;
