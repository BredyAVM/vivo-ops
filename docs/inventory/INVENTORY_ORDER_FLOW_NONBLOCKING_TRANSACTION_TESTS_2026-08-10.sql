-- Pruebas reversibles para la frontera no bloqueante de inventario.
-- Ejecutar completas: todas las mutaciones terminan en ROLLBACK.

-- 1. Ciclo de vida de una alerta por saldo negativo.
begin;

select pg_catalog.set_config('app.inventory_engine_write', 'on', true);

do $test$
declare
  v_item_id bigint;
begin
  select item.id
  into v_item_id
  from public.inventory_items item
  where item.current_stock_units < 0
    and item.is_active
    and item.tracking_mode <> 'not_tracked'
    and item.merged_into_item_id is null
  order by item.id
  limit 1;

  if v_item_id is null then
    raise exception 'La prueba requiere un ítem operativo con saldo negativo.';
  end if;

  update public.inventory_items
  set current_stock_units = 0
  where id = v_item_id;

  if exists (
    select 1
    from public.inventory_alerts alert
    where alert.alert_key = format('control:negative-balance:item:%s', v_item_id)
      and alert.status in ('open', 'managed')
  ) then
    raise exception 'La alerta no se resolvió al recuperar el saldo.';
  end if;

  update public.inventory_items
  set current_stock_units = -1
  where id = v_item_id;

  if (
    select count(*)
    from public.inventory_alerts alert
    where alert.alert_key = format('control:negative-balance:item:%s', v_item_id)
      and alert.status in ('open', 'managed')
      and alert.severity = 'critical'
      and alert.alert_category = 'control'
  ) <> 1 then
    raise exception 'La alerta negativa no se abrió de forma única y crítica.';
  end if;
end;
$test$;

rollback;

-- 2. Una falla de consumo no revierte la entrega ni duplica movimientos.
begin;

do $test$
declare
  v_order_id bigint;
  v_actor uuid;
  v_before_movements bigint;
  v_after_movements bigint;
  v_before_issues bigint;
  v_after_issues bigint;
  v_status text;
begin
  select
    order_row.id,
    coalesce(
      order_row.last_modified_by,
      order_row.sent_to_kitchen_by,
      order_row.created_by_user_id
    )
  into v_order_id, v_actor
  from public.orders order_row
  where order_row.status = 'delivered'
    and exists (
      select 1
      from public.inventory_movements movement
      where movement.order_id = order_row.id
        and movement.movement_type = 'sale_out'
    )
    and exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = coalesce(
        order_row.last_modified_by,
        order_row.sent_to_kitchen_by,
        order_row.created_by_user_id
      )
        and role_row.role in ('master'::public.user_role, 'admin'::public.user_role)
    )
  order by order_row.id desc
  limit 1;

  if v_order_id is null or v_actor is null then
    raise exception 'No existe una orden entregada apta para la prueba reversible.';
  end if;

  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );

  select count(*) into v_before_movements
  from public.inventory_movements
  where order_id = v_order_id and movement_type = 'sale_out';

  select count(*) into v_before_issues
  from public.order_timeline_events
  where order_id = v_order_id and event_type = 'inventory_sale_sync_failed';

  update public.orders
  set status = 'out_for_delivery'::public.order_status
  where id = v_order_id;

  update public.orders
  set status = 'delivered'::public.order_status
  where id = v_order_id;

  select status::text into v_status
  from public.orders
  where id = v_order_id;

  select count(*) into v_after_movements
  from public.inventory_movements
  where order_id = v_order_id and movement_type = 'sale_out';

  select count(*) into v_after_issues
  from public.order_timeline_events
  where order_id = v_order_id and event_type = 'inventory_sale_sync_failed';

  if v_status <> 'delivered' then
    raise exception 'Inventario bloqueó la entrega; estado final: %.', v_status;
  end if;
  if v_after_movements <> v_before_movements then
    raise exception 'El consumo se duplicó: antes %, después %.',
      v_before_movements, v_after_movements;
  end if;
  if v_after_issues <> v_before_issues + 1 then
    raise exception 'No se registró exactamente una incidencia de inventario.';
  end if;
end;
$test$;

rollback;
