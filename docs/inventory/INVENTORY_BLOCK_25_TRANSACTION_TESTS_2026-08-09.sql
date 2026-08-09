-- Bloque 25: prueba reversible de solicitudes de conteo por Máster.

begin;

do $$
declare
  v_master uuid;
  v_kitchen uuid;
  v_item_id bigint;
  v_stock_before numeric;
  v_orders_before bigint;
  v_movements_before bigint;
  v_counts_before bigint;
  v_operation_id uuid := '25000000-0000-4000-8000-000000000001'::uuid;
  v_first jsonb;
  v_replay jsonb;
  v_count_id bigint;
  v_denied boolean := false;
begin
  select role_row.user_id into v_master
  from public.user_roles role_row
  where role_row.role = 'master'::public.user_role
    and not exists (
      select 1 from public.user_roles other
      where other.user_id = role_row.user_id
        and other.role = 'admin'::public.user_role
    )
  order by role_row.user_id
  limit 1;

  select role_row.user_id into v_kitchen
  from public.user_roles role_row
  where role_row.role = 'kitchen'::public.user_role
    and not exists (
      select 1 from public.user_roles other
      where other.user_id = role_row.user_id
        and other.role in ('admin'::public.user_role, 'master'::public.user_role)
    )
  order by role_row.user_id
  limit 1;

  select item.id, item.current_stock_units
  into v_item_id, v_stock_before
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
    and app_private.inventory_item_is_initialized_v1(item.id)
  order by item.id
  limit 1;

  if v_master is null or v_kitchen is null or v_item_id is null then
    raise exception 'Faltan datos para ejecutar la prueba.';
  end if;

  select count(*) into v_orders_before from public.orders;
  select count(*) into v_movements_before from public.inventory_movements;
  select count(*) into v_counts_before from public.inventory_counts;

  perform set_config('request.jwt.claim.sub', v_master::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_first := public.inventory_request_count_v1(
    v_operation_id,
    array[v_item_id],
    now() + interval '45 minutes',
    'Bloque 25: prueba reversible'
  );
  v_replay := public.inventory_request_count_v1(
    v_operation_id,
    array[v_item_id],
    now() + interval '45 minutes',
    'Bloque 25: prueba reversible'
  );
  v_count_id := (v_first->>'inventory_count_id')::bigint;

  if v_first->>'status' <> 'applied' or v_replay->>'status' <> 'replayed' then
    raise exception 'La idempotencia no devolvió applied/replayed.';
  end if;

  if (v_replay->>'inventory_count_id')::bigint <> v_count_id
    or (select count(*) from public.inventory_counts) <> v_counts_before + 1 then
    raise exception 'El reintento duplicó o cambió el conteo.';
  end if;

  if not exists (
    select 1
    from public.inventory_counts count_header
    join public.inventory_count_lines count_line
      on count_line.inventory_count_id = count_header.id
    where count_header.id = v_count_id
      and count_header.count_kind = 'requested'
      and count_header.status = 'open'
      and count_header.responsible_role = 'kitchen'::public.user_role
      and count_header.requested_by_user_id = v_master
      and count_header.request_operation_id = v_operation_id
      and count_line.inventory_item_id = v_item_id
      and count_line.expected_quantity_units = v_stock_before
      and count_line.line_status = 'pending'
  ) then
    raise exception 'La solicitud no conservó la foto canónica esperada.';
  end if;

  if (select current_stock_units from public.inventory_items where id = v_item_id) <> v_stock_before
    or (select count(*) from public.inventory_movements) <> v_movements_before
    or (select count(*) from public.orders) <> v_orders_before then
    raise exception 'La solicitud modificó saldos, movimientos u órdenes.';
  end if;

  perform set_config('request.jwt.claim.sub', v_kitchen::text, true);
  begin
    perform public.inventory_request_count_v1(
      '25000000-0000-4000-8000-000000000002'::uuid,
      array[v_item_id],
      now() + interval '45 minutes',
      null
    );
  exception
    when insufficient_privilege then
      v_denied := true;
  end;

  if not v_denied then
    raise exception 'Cocina pudo abrir una solicitud reservada a Máster.';
  end if;
end;
$$;

rollback;

-- Debe devolver cero para ambas operaciones después del rollback.
select count(*) as operation_rows
from public.inventory_counts
where request_operation_id in (
  '25000000-0000-4000-8000-000000000001'::uuid,
  '25000000-0000-4000-8000-000000000002'::uuid
);
