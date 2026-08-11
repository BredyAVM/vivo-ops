-- Keep the public command boundary strict for manual RPC calls, while allowing
-- the existing delivered-order trigger to materialize the physical sale for
-- any order source. Inventory remains advisory and can never roll delivery
-- back because of stock or caller-role restrictions.
create or replace function public.inventory_commit_order_sale_v1(
  p_operation_id uuid,
  p_order_id bigint,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_trigger_context boolean := pg_catalog.pg_trigger_depth() > 0;
  v_is_master_or_admin boolean := false;
  v_is_counter boolean := false;
  v_status text;
  v_source text;
  v_fulfillment text;
  v_last_modified_by uuid;
  v_order_actor uuid;
  v_resolution jsonb;
  v_item_ids bigint[];
  v_line record;
  v_existing_operation uuid;
begin
  if v_actor is null and not v_trigger_context then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if v_actor is not null then
    select
      exists (
        select 1 from public.user_roles role_row
        where role_row.user_id = v_actor
          and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
      ),
      exists (
        select 1 from public.user_roles role_row
        where role_row.user_id = v_actor
          and role_row.role = 'counter'::public.user_role
      )
    into v_is_master_or_admin, v_is_counter;
  end if;

  if not v_trigger_context and not v_is_master_or_admin and not v_is_counter then
    raise exception 'Solo administración, Master o el mostrador autorizado pueden confirmar una venta.'
      using errcode = '42501';
  end if;

  if p_operation_id is null or p_order_id is null then
    raise exception 'operation_id y order_id son obligatorios.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory_order_sale:' || p_order_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements movement
    where movement.operation_id = p_operation_id
  ) then
    if exists (
      select 1
      from public.inventory_movements movement
      where movement.operation_id = p_operation_id
        and (
          movement.movement_type <> 'sale_out'
          or movement.order_id is distinct from p_order_id
        )
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object('status', 'replayed', 'order_id', p_order_id);
  end if;

  select
    order_row.status::text,
    order_row.source::text,
    order_row.fulfillment::text,
    order_row.last_modified_by,
    coalesce(
      order_row.last_modified_by,
      order_row.sent_to_kitchen_by,
      order_row.created_by_user_id
    )
  into v_status, v_source, v_fulfillment, v_last_modified_by, v_order_actor
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  if v_trigger_context then
    v_actor := coalesce(v_actor, v_order_actor);
  elsif not v_is_master_or_admin and (
    v_source <> 'walk_in'
    or v_fulfillment <> 'pickup'
    or v_last_modified_by is distinct from v_actor
  ) then
    raise exception 'Mostrador solo puede cerrar el consumo de su retiro walk-in.' using errcode = '42501';
  end if;

  if v_status <> 'delivered' then
    raise exception 'La venta solo puede consumirse cuando la orden está entregada; estado actual: %.', v_status
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.inventory_movements movement
    where movement.order_id = p_order_id
      and movement.movement_type = 'sale_out'
      and movement.operation_id is null
  ) then
    raise exception 'La orden ya tiene un descuento legado; se bloqueó un descuento canónico duplicado.';
  end if;

  select movement.operation_id
  into v_existing_operation
  from public.inventory_movements movement
  where movement.order_id = p_order_id
    and movement.movement_type = 'sale_out'
    and movement.operation_id is not null
    and exists (
      select 1
      from public.inventory_movements original
      where original.operation_id = movement.operation_id
        and not exists (
          select 1
          from public.inventory_movements reversal
          where reversal.reversal_of_movement_id = original.id
        )
    )
  order by movement.created_at desc, movement.id desc
  limit 1;

  if v_existing_operation is not null then
    raise exception 'La orden ya fue descontada por la operación canónica %.', v_existing_operation;
  end if;

  v_resolution := app_private.inventory_resolve_order_sale_v1(p_order_id);

  select array_agg(
    (line.value ->> 'inventory_item_id')::bigint
    order by (line.value ->> 'inventory_item_id')::bigint
  )
  into v_item_ids
  from jsonb_array_elements(v_resolution -> 'lines') line(value);

  if coalesce(cardinality(v_item_ids), 0) = 0 then
    return jsonb_build_object(
      'status', 'no_inventory_effect',
      'order_id', p_order_id,
      'operation_id', p_operation_id,
      'resolution', v_resolution
    );
  end if;

  perform 1
  from public.inventory_items inventory_item
  where inventory_item.id = any(v_item_ids)
  order by inventory_item.id
  for update;

  if (
    select count(*) from public.inventory_items inventory_item
    where inventory_item.id = any(v_item_ids)
  ) <> cardinality(v_item_ids) then
    raise exception 'La resolución contiene ítems de inventario inexistentes.';
  end if;

  if exists (
    select 1
    from public.inventory_items inventory_item
    where inventory_item.id = any(v_item_ids)
      and (
        not inventory_item.is_active
        or inventory_item.tracking_mode = 'not_tracked'
        or inventory_item.merged_into_item_id is not null
      )
  ) then
    raise exception 'La resolución contiene un ítem de inventario no operativo.';
  end if;

  if exists (
    select 1
    from unnest(v_item_ids) item_id
    where not app_private.inventory_item_is_initialized_v1(item_id)
  ) then
    raise exception 'Todos los ítems consumidos requieren un conteo de apertura.';
  end if;

  -- A shortage is deliberately recorded as negative stock. Delivery remains
  -- valid and the existing control alerts expose the discrepancy.
  for v_line in
    select
      (line.value ->> 'inventory_item_id')::bigint as inventory_item_id,
      (line.value ->> 'quantity_units')::numeric as quantity_units
    from jsonb_array_elements(v_resolution -> 'lines') line(value)
    order by (line.value ->> 'inventory_item_id')::bigint
  loop
    perform app_private.inventory_apply_delta_v1(
      p_operation_id,
      v_line.inventory_item_id,
      'sale_out',
      -v_line.quantity_units,
      'order_delivery',
      coalesce(nullif(btrim(p_notes), ''), format('Consumo canónico de la orden %s.', p_order_id)),
      p_order_id,
      null,
      v_actor,
      null
    );
  end loop;

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object(
      'status', 'applied',
      'order_id', p_order_id,
      'resolution', v_resolution
    );
end;
$$;

revoke all on function public.inventory_commit_order_sale_v1(uuid, bigint, text)
  from public, anon;
grant execute on function public.inventory_commit_order_sale_v1(uuid, bigint, text)
  to authenticated;

comment on function public.inventory_commit_order_sale_v1(uuid, bigint, text) is
  'Atomic non-blocking sale command. Manual calls keep their role boundary; the delivered-order trigger records any valid sale, including negative balances.';
