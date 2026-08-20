-- Move the physical inventory cut-off for delivery orders from customer
-- delivery to the hand-off to the driver (out_for_delivery). Pickups keep their
-- cut-off when the customer collects them. Inventory remains non-blocking.

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
  v_closed_commitments integer := 0;
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
      || pg_catalog.jsonb_build_object('status', 'replayed', 'order_id', p_order_id);
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

  if v_fulfillment = 'delivery'
    and v_status not in ('out_for_delivery', 'delivered')
  then
    raise exception 'El delivery solo puede consumirse al salir en camino; estado actual: %.', v_status
      using errcode = '22023';
  elsif v_fulfillment <> 'delivery' and v_status <> 'delivered' then
    raise exception 'El retiro solo puede consumirse cuando el cliente lo recibe; estado actual: %.', v_status
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

  select pg_catalog.array_agg(
    (line.value ->> 'inventory_item_id')::bigint
    order by (line.value ->> 'inventory_item_id')::bigint
  )
  into v_item_ids
  from pg_catalog.jsonb_array_elements(v_resolution -> 'lines') line(value);

  -- The commitment and the physical stock move in the same transaction. If a
  -- later validation fails, this close is rolled back with every sale movement.
  v_closed_commitments := app_private.inventory_close_order_commitments_v1(
    p_order_id,
    'fulfilled',
    v_actor
  );

  if coalesce(pg_catalog.cardinality(v_item_ids), 0) = 0 then
    return pg_catalog.jsonb_build_object(
      'status', 'no_inventory_effect',
      'order_id', p_order_id,
      'operation_id', p_operation_id,
      'physical_exit_status', v_status,
      'closed_commitments', v_closed_commitments,
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
  ) <> pg_catalog.cardinality(v_item_ids) then
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
    from pg_catalog.unnest(v_item_ids) item_id
    where not app_private.inventory_item_is_initialized_v1(item_id)
  ) then
    raise exception 'Todos los ítems consumidos requieren un conteo de apertura.';
  end if;

  -- A shortage is deliberately recorded as negative stock. Dispatch remains
  -- valid and the existing control alerts expose the discrepancy.
  for v_line in
    select
      (line.value ->> 'inventory_item_id')::bigint as inventory_item_id,
      (line.value ->> 'quantity_units')::numeric as quantity_units
    from pg_catalog.jsonb_array_elements(v_resolution -> 'lines') line(value)
    order by (line.value ->> 'inventory_item_id')::bigint
  loop
    perform app_private.inventory_apply_delta_v1(
      p_operation_id,
      v_line.inventory_item_id,
      'sale_out',
      -v_line.quantity_units,
      'order_delivery',
      coalesce(
        nullif(pg_catalog.btrim(p_notes), ''),
        pg_catalog.format('Consumo canónico al salir del local: orden %s.', p_order_id)
      ),
      p_order_id,
      null,
      v_actor,
      null
    );
  end loop;

  return app_private.inventory_operation_result_v1(p_operation_id)
    || pg_catalog.jsonb_build_object(
      'status', 'applied',
      'order_id', p_order_id,
      'physical_exit_status', v_status,
      'closed_commitments', v_closed_commitments,
      'resolution', v_resolution
    );
end;
$$;

revoke all on function public.inventory_commit_order_sale_v1(uuid, bigint, text)
  from public, anon;
grant execute on function public.inventory_commit_order_sale_v1(uuid, bigint, text)
  to authenticated;

comment on function public.inventory_commit_order_sale_v1(uuid, bigint, text) is
  'Atomic non-blocking physical-exit command. Delivery consumes at out_for_delivery; pickup consumes at delivered. It closes order commitments in the same transaction and permits negative balances.';

create or replace function app_private.inventory_order_sale_cutover_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_operation_id uuid;
  v_sqlstate text;
  v_message text;
  v_detail text;
  v_is_physical_exit boolean;
begin
  v_is_physical_exit := old.status is distinct from new.status
    and (
      (
        new.fulfillment::text = 'delivery'
        and new.status::text in ('out_for_delivery', 'delivered')
      )
      or (
        new.fulfillment::text <> 'delivery'
        and new.status::text = 'delivered'
      )
    );

  if v_is_physical_exit then
    v_actor := coalesce(
      auth.uid(),
      new.last_modified_by,
      new.sent_to_kitchen_by,
      new.created_by_user_id
    );
    -- Keep the operation identity used by delivered-order reconciliation so a
    -- delivered transition safely replays a successful dispatch consumption.
    v_operation_id := pg_catalog.md5(
      'vivo.inventory.order.sale.v2:' || new.id::text
    )::uuid;

    begin
      if app_private.inventory_catalog_is_ready_v1() then
        perform public.inventory_commit_order_sale_v1(
          v_operation_id,
          new.id,
          case
            when new.fulfillment::text = 'delivery'
              and new.status::text = 'out_for_delivery'
              then pg_catalog.format('Consumo automático al entregar la orden %s al motorizado.', new.id)
            when new.fulfillment::text = 'delivery'
              then pg_catalog.format('Reintento de consumo al confirmar la entrega de la orden %s.', new.id)
            else pg_catalog.format('Consumo automático al retirar la orden %s.', new.id)
          end
        );
      end if;
    exception when others then
      get stacked diagnostics
        v_sqlstate = returned_sqlstate,
        v_message = message_text,
        v_detail = pg_exception_detail;

      perform app_private.inventory_record_order_issue_v1(
        new.id,
        'inventory_sale_sync_failed',
        'order_delivery',
        'Salida sin conciliación de inventario',
        'La orden continuó sin bloqueo, pero su salida física requiere conciliación de inventario.',
        'critical',
        v_actor,
        pg_catalog.jsonb_build_object(
          'operation_id', v_operation_id,
          'order_status', new.status::text,
          'fulfillment', new.fulfillment::text,
          'sqlstate', v_sqlstate,
          'error', v_message,
          'detail', nullif(v_detail, '')
        )
      );
    end;
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_sale_cutover_trigger_v1()
  from public, anon, authenticated, service_role;

comment on function app_private.inventory_order_sale_cutover_trigger_v1() is
  'Non-blocking physical-exit trigger. Delivery consumes when handed to the driver and retries idempotently at delivered; pickup consumes at customer collection.';
