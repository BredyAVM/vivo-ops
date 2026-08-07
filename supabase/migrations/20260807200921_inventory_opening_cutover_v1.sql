-- Block 7: physical opening, selective review, and automatic sales cutover.
-- No new tables are introduced. Readiness is derived from accepted opening counts.

create or replace function app_private.inventory_catalog_is_ready_v1()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with eligible_items as (
    select item.id
    from public.inventory_items item
    where item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
  )
  select
    exists (select 1 from eligible_items)
    and not exists (
      select 1
      from eligible_items eligible
      where not exists (
        select 1
        from public.inventory_count_lines count_line
        join public.inventory_counts count_header
          on count_header.id = count_line.inventory_count_id
        join public.inventory_movements movement
          on movement.id = count_line.movement_id
        where count_line.inventory_item_id = eligible.id
          and count_header.count_kind = 'opening'
          and count_header.status = 'accepted'
          and count_line.line_status = 'accepted'
          and movement.operation_id is not null
          and movement.movement_type = 'stock_count'
          and movement.reason_code = 'opening_balance'
          and not exists (
            select 1
            from public.inventory_movements reversal
            where reversal.reversal_of_movement_id = movement.id
          )
      )
    );
$$;

revoke all on function app_private.inventory_catalog_is_ready_v1()
  from public, anon, authenticated, service_role;

create or replace function public.inventory_catalog_ready_v1()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Master o administración pueden consultar la activación del inventario.'
      using errcode = '42501';
  end if;

  return app_private.inventory_catalog_is_ready_v1();
end;
$$;

revoke all on function public.inventory_catalog_ready_v1()
  from public, anon;
grant execute on function public.inventory_catalog_ready_v1()
  to authenticated;

create or replace function public.inventory_cutover_mode_v1()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in (
        'admin'::public.user_role,
        'master'::public.user_role,
        'counter'::public.user_role
      )
  ) then
    raise exception 'No tienes permiso para consultar el modo de inventario.' using errcode = '42501';
  end if;

  if app_private.inventory_catalog_is_ready_v1() then
    return 'canonical';
  end if;

  if exists (
    select 1
    from public.inventory_counts count_header
    where count_header.count_kind = 'opening'
  ) then
    return 'opening';
  end if;

  return 'legacy';
end;
$$;

revoke all on function public.inventory_cutover_mode_v1()
  from public, anon;
grant execute on function public.inventory_cutover_mode_v1()
  to authenticated;

create or replace function public.inventory_opening_status_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Master o administración pueden consultar la apertura.' using errcode = '42501';
  end if;

  with eligible_items as (
    select
      item.id,
      item.name,
      coalesce(item.inventory_group, 'other') as inventory_group,
      coalesce(item.unit_name, 'unidad') as unit_name,
      item.tracking_mode
    from public.inventory_items item
    where item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
  ),
  opening_lines as (
    select distinct on (count_line.inventory_item_id)
      count_line.inventory_item_id,
      count_header.id as inventory_count_id,
      count_header.status as count_status,
      count_line.line_status,
      count_header.created_at
    from public.inventory_count_lines count_line
    join public.inventory_counts count_header
      on count_header.id = count_line.inventory_count_id
    join public.inventory_movements movement
      on movement.id = count_line.movement_id
    where count_header.count_kind = 'opening'
      and movement.operation_id is not null
      and movement.movement_type = 'stock_count'
      and movement.reason_code = 'opening_balance'
      and not exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversal_of_movement_id = movement.id
      )
    order by count_line.inventory_item_id, count_header.created_at desc, count_header.id desc
  ),
  item_statuses as (
    select
      eligible.id,
      eligible.name,
      eligible.inventory_group,
      eligible.unit_name,
      eligible.tracking_mode,
      opening.inventory_count_id,
      case
        when opening.inventory_count_id is null then 'pending'
        when opening.count_status = 'accepted' and opening.line_status = 'accepted' then 'accepted'
        else 'under_review'
      end as opening_status
    from eligible_items eligible
    left join opening_lines opening on opening.inventory_item_id = eligible.id
  ),
  totals as (
    select
      count(*)::integer as eligible_count,
      count(*) filter (where opening_status = 'accepted')::integer as accepted_count,
      count(*) filter (where opening_status = 'under_review')::integer as under_review_count,
      count(*) filter (where opening_status = 'pending')::integer as pending_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', id,
            'name', name,
            'inventory_group', inventory_group,
            'unit_name', unit_name,
            'tracking_mode', tracking_mode,
            'opening_status', opening_status,
            'inventory_count_id', inventory_count_id
          )
          order by inventory_group, name, id
        ),
        '[]'::jsonb
      ) as items
    from item_statuses
  )
  select jsonb_build_object(
    'eligible_count', totals.eligible_count,
    'accepted_count', totals.accepted_count,
    'under_review_count', totals.under_review_count,
    'pending_count', totals.pending_count,
    'ready', app_private.inventory_catalog_is_ready_v1(),
    'items', totals.items
  )
  into v_result
  from totals;

  return v_result;
end;
$$;

revoke all on function public.inventory_opening_status_v1()
  from public, anon;
grant execute on function public.inventory_opening_status_v1()
  to authenticated;

comment on function app_private.inventory_catalog_is_ready_v1() is
  'True only when every active canonical tracked item has an accepted, unreversed physical opening.';
comment on function public.inventory_opening_status_v1() is
  'Blind-opening progress for Inventory Center. Does not expose legacy expected quantities.';

-- Once an item enters the canonical ledger, prevent a two-call legacy writer from
-- inserting a movement and then failing while updating the stock projection.
create or replace function app_private.inventory_guard_canonical_movement_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.operation_id is not null
      and coalesce(current_setting('app.inventory_engine_write', true), '') <> 'on'
    then
      raise exception 'Los movimientos canónicos solo pueden escribirse mediante el motor de inventario.'
        using errcode = '42501';
    end if;

    if new.operation_id is null
      and coalesce(current_setting('app.inventory_engine_write', true), '') <> 'on'
      and app_private.inventory_item_is_initialized_v1(new.inventory_item_id)
    then
      raise exception 'El ítem ya usa el motor canónico; el escritor legado está deshabilitado.'
        using errcode = '42501';
    end if;

    return new;
  end if;

  if old.operation_id is not null then
    raise exception 'Los movimientos canónicos son inmutables; registra un reverso.'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_guard_canonical_movement_v1()
  from public, anon, authenticated;

-- Accepting a recount also closes every resolved ancestor. This keeps an
-- opening in review until its selected recount lines have actually been accepted.
create or replace function public.inventory_review_count_v1(
  p_inventory_count_id bigint,
  p_action text,
  p_line_ids bigint[] default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_count record;
  v_parent_count record;
  v_recount_id bigint;
  v_child_count_id bigint;
  v_parent_count_id bigint;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Master o administración pueden revisar conteos.' using errcode = '42501';
  end if;

  if p_action not in ('accept', 'request_recount') then
    raise exception 'Acción de revisión inválida.' using errcode = '22023';
  end if;

  select count_header.*
  into v_count
  from public.inventory_counts count_header
  where count_header.id = p_inventory_count_id
  for update;

  if not found then
    raise exception 'Conteo no encontrado.';
  end if;

  if p_action = 'accept' then
    if v_count.status = 'accepted' then
      return jsonb_build_object(
        'status', 'replayed',
        'inventory_count_id', v_count.id,
        'review_action', 'accept'
      );
    end if;

    if v_count.status <> 'submitted' then
      raise exception 'Solo un conteo presentado puede aceptarse.';
    end if;

    update public.inventory_count_lines
    set line_status = 'accepted',
        reviewed_by_user_id = v_actor,
        reviewed_at = v_now
    where inventory_count_id = v_count.id
      and line_status = 'submitted';

    update public.inventory_counts
    set status = 'accepted',
        reviewed_by_user_id = v_actor,
        reviewed_at = v_now,
        notes = case
          when nullif(btrim(p_notes), '') is null then notes
          when notes is null then btrim(p_notes)
          else notes || E'\n' || btrim(p_notes)
        end
    where id = v_count.id;

    v_child_count_id := v_count.id;
    v_parent_count_id := v_count.parent_count_id;

    while v_parent_count_id is not null loop
      select parent_header.*
      into v_parent_count
      from public.inventory_counts parent_header
      where parent_header.id = v_parent_count_id
      for update;

      if not found then
        raise exception 'La cadena de reconteo referencia un conteo padre inexistente.';
      end if;

      update public.inventory_count_lines parent_line
      set line_status = 'accepted',
          reviewed_by_user_id = v_actor,
          reviewed_at = v_now
      where parent_line.inventory_count_id = v_parent_count.id
        and parent_line.line_status = 'recount_requested'
        and exists (
          select 1
          from public.inventory_count_lines child_line
          where child_line.inventory_count_id = v_child_count_id
            and child_line.recounted_from_line_id = parent_line.id
            and child_line.line_status = 'accepted'
        );

      if exists (
        select 1
        from public.inventory_count_lines unresolved_line
        where unresolved_line.inventory_count_id = v_parent_count.id
          and unresolved_line.line_status <> 'accepted'
      ) then
        exit;
      end if;

      update public.inventory_counts
      set status = 'accepted',
          reviewed_by_user_id = v_actor,
          reviewed_at = v_now
      where id = v_parent_count.id;

      v_child_count_id := v_parent_count.id;
      v_parent_count_id := v_parent_count.parent_count_id;
    end loop;

    return jsonb_build_object(
      'status', 'applied',
      'inventory_count_id', v_count.id,
      'review_action', 'accept'
    );
  end if;

  if v_count.status <> 'submitted' then
    raise exception 'Solo un conteo presentado puede enviarse a reconteo.';
  end if;

  if p_line_ids is null or cardinality(p_line_ids) = 0 then
    raise exception 'Debes seleccionar al menos una línea para reconteo.' using errcode = '22023';
  end if;

  if cardinality(p_line_ids) <> (
    select count(distinct line_id) from unnest(p_line_ids) line_id
  ) then
    raise exception 'Las líneas de reconteo no pueden repetirse.' using errcode = '22023';
  end if;

  if (
    select count(*)
    from public.inventory_count_lines count_line
    where count_line.inventory_count_id = v_count.id
      and count_line.id = any(p_line_ids)
      and count_line.line_status = 'submitted'
  ) <> cardinality(p_line_ids) then
    raise exception 'Una o más líneas no pertenecen al conteo presentado.';
  end if;

  if exists (
    select 1
    from public.inventory_counts child_header
    where child_header.parent_count_id = v_count.id
      and child_header.status in ('open', 'submitted', 'recount_requested')
  ) then
    raise exception 'Ya existe un reconteo pendiente para este conteo.';
  end if;

  insert into public.inventory_counts (
    count_kind,
    status,
    responsible_role,
    parent_count_id,
    requested_by_user_id,
    created_by_user_id,
    notes
  )
  values (
    'recount',
    'open',
    v_count.responsible_role,
    v_count.id,
    v_actor,
    v_actor,
    nullif(btrim(p_notes), '')
  )
  returning id into v_recount_id;

  insert into public.inventory_count_lines (
    inventory_count_id,
    inventory_item_id,
    expected_quantity_units,
    line_status,
    recounted_from_line_id
  )
  select
    v_recount_id,
    original_line.inventory_item_id,
    item.current_stock_units,
    'pending',
    original_line.id
  from public.inventory_count_lines original_line
  join public.inventory_items item on item.id = original_line.inventory_item_id
  where original_line.inventory_count_id = v_count.id
    and original_line.id = any(p_line_ids)
  order by original_line.id;

  update public.inventory_count_lines
  set line_status = case when id = any(p_line_ids) then 'recount_requested' else 'accepted' end,
      reviewed_by_user_id = v_actor,
      reviewed_at = v_now
  where inventory_count_id = v_count.id
    and line_status = 'submitted';

  update public.inventory_counts
  set status = 'recount_requested',
      reviewed_by_user_id = v_actor,
      reviewed_at = v_now,
      notes = case
        when nullif(btrim(p_notes), '') is null then notes
        when notes is null then btrim(p_notes)
        else notes || E'\n' || btrim(p_notes)
      end
  where id = v_count.id;

  return jsonb_build_object(
    'status', 'applied',
    'inventory_count_id', v_count.id,
    'review_action', 'request_recount',
    'recount_inventory_count_id', v_recount_id
  );
end;
$$;

revoke all on function public.inventory_review_count_v1(bigint, text, bigint[], text)
  from public, anon;
grant execute on function public.inventory_review_count_v1(bigint, text, bigint[], text)
  to authenticated;

-- Counter may commit only the walk-in pickup it just completed. Master and
-- administration keep the existing authority boundary.
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
  v_is_master_or_admin boolean;
  v_is_counter boolean;
  v_status text;
  v_source text;
  v_fulfillment text;
  v_last_modified_by uuid;
  v_resolution jsonb;
  v_item_ids bigint[];
  v_line record;
  v_existing_operation uuid;
  v_shortage text;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

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

  if not v_is_master_or_admin and not v_is_counter then
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
    order_row.last_modified_by
  into v_status, v_source, v_fulfillment, v_last_modified_by
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  if not v_is_master_or_admin and (
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

  select inventory_item.name
  into v_shortage
  from jsonb_array_elements(v_resolution -> 'lines') line(value)
  join public.inventory_items inventory_item
    on inventory_item.id = (line.value ->> 'inventory_item_id')::bigint
  where inventory_item.current_stock_units < (line.value ->> 'quantity_units')::numeric
  order by inventory_item.id
  limit 1;

  if v_shortage is not null then
    raise exception 'Existencia insuficiente para completar la venta: %.', v_shortage;
  end if;

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

create or replace function app_private.inventory_order_sale_cutover_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status
    and new.status = 'delivered'
    and app_private.inventory_catalog_is_ready_v1()
  then
    perform public.inventory_commit_order_sale_v1(
      gen_random_uuid(),
      new.id,
      format('Consumo automático al entregar la orden %s.', new.id)
    );
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_sale_cutover_trigger_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists inventory_order_sale_cutover_v1 on public.orders;
create trigger inventory_order_sale_cutover_v1
after update of status on public.orders
for each row execute function app_private.inventory_order_sale_cutover_trigger_v1();

comment on function public.inventory_commit_order_sale_v1(uuid, bigint, text) is
  'Atomic sale command. Block 7 enables automatic delivery cutover after all physical openings are accepted.';
comment on function app_private.inventory_order_sale_cutover_trigger_v1() is
  'Commits the canonical sale in the same delivery transaction only after the complete opening is accepted.';
