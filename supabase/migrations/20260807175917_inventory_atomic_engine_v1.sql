set lock_timeout = '5s';
set statement_timeout = '30s';

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

alter table public.inventory_movements
  drop constraint inventory_movements_type_check;

alter table public.inventory_movements
  add constraint inventory_movements_type_check
  check (
    movement_type = any (
      array[
        'inbound'::text,
        'return_in'::text,
        'sale_out'::text,
        'damage'::text,
        'waste'::text,
        'quality_taste'::text,
        'manual_adjustment'::text,
        'stock_count'::text,
        'production_out'::text,
        'production_in'::text,
        'pack_out'::text,
        'pack_in'::text,
        'reversal'::text
      ]
    )
  );

alter table public.inventory_counts
  drop constraint inventory_counts_kind_check;

alter table public.inventory_counts
  add constraint inventory_counts_kind_check
  check (
    count_kind = any (
      array[
        'opening'::text,
        'shift_change'::text,
        'requested'::text,
        'recount'::text,
        'periodic'::text
      ]
    )
  );

alter table public.inventory_movements
  add constraint inventory_movements_canonical_delta_check
  check (
    operation_id is null
    or case
      when movement_type in ('inbound', 'return_in', 'production_in', 'pack_in')
        then quantity_units > 0
      when movement_type in (
        'sale_out',
        'damage',
        'waste',
        'quality_taste',
        'production_out',
        'pack_out'
      )
        then quantity_units < 0
      when movement_type in ('manual_adjustment', 'stock_count', 'reversal')
        then true
      else false
    end
  ) not valid;

alter table public.inventory_movements
  validate constraint inventory_movements_canonical_delta_check;

create unique index inventory_movements_operation_line_uidx
  on public.inventory_movements using btree (
    operation_id,
    inventory_item_id,
    movement_type,
    coalesce(reversal_of_movement_id, 0)
  )
  where operation_id is not null;

comment on column public.inventory_movements.quantity_units is
  'Delta firmado para operaciones canónicas con operation_id; las filas heredadas sin operation_id conservan su semántica histórica hasta el corte coordinado.';

comment on column public.inventory_movements.operation_id is
  'Clave idempotente y agrupador de todos los movimientos de un mismo hecho físico atómico.';

create or replace function app_private.inventory_operation_result_v1(
  p_operation_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'operation_id', p_operation_id,
    'movement_count', count(m.id),
    'movements', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'movement_id', m.id,
          'inventory_item_id', m.inventory_item_id,
          'inventory_item_name', item.name,
          'movement_type', m.movement_type,
          'quantity_units', m.quantity_units,
          'reason_code', m.reason_code,
          'reversal_of_movement_id', m.reversal_of_movement_id
        )
        order by m.id
      ) filter (where m.id is not null),
      '[]'::jsonb
    )
  )
  from public.inventory_movements m
  join public.inventory_items item on item.id = m.inventory_item_id
  where m.operation_id = p_operation_id;
$$;

revoke all on function app_private.inventory_operation_result_v1(uuid)
  from public, anon, authenticated;

create or replace function app_private.inventory_item_is_initialized_v1(
  p_inventory_item_id bigint
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.inventory_movements opening
    where opening.inventory_item_id = p_inventory_item_id
      and opening.operation_id is not null
      and opening.reason_code = 'opening_balance'
      and not exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversal_of_movement_id = opening.id
      )
  );
$$;

revoke all on function app_private.inventory_item_is_initialized_v1(bigint)
  from public, anon, authenticated;

create or replace function app_private.inventory_apply_delta_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_movement_type text,
  p_delta_units numeric,
  p_reason_code text,
  p_notes text,
  p_order_id bigint,
  p_inventory_lot_id bigint,
  p_actor_user_id uuid,
  p_reversal_of_movement_id bigint default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before numeric;
  v_after numeric;
  v_movement_id bigint;
begin
  if p_operation_id is null then
    raise exception 'operation_id es obligatorio.' using errcode = '22023';
  end if;

  if p_actor_user_id is null then
    raise exception 'actor_user_id es obligatorio.' using errcode = '22023';
  end if;

  if p_delta_units is null then
    raise exception 'El delta de inventario es obligatorio.' using errcode = '22023';
  end if;

  select item.current_stock_units
  into v_before
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario % no encontrado.', p_inventory_item_id;
  end if;

  v_after := v_before + p_delta_units;
  perform pg_catalog.set_config('app.inventory_engine_write', 'on', true);

  insert into public.inventory_movements (
    inventory_item_id,
    movement_type,
    quantity_units,
    reason_code,
    notes,
    order_id,
    created_by_user_id,
    operation_id,
    reversal_of_movement_id,
    inventory_lot_id
  )
  values (
    p_inventory_item_id,
    p_movement_type,
    p_delta_units,
    nullif(btrim(p_reason_code), ''),
    nullif(btrim(p_notes), ''),
    p_order_id,
    p_actor_user_id,
    p_operation_id,
    p_reversal_of_movement_id,
    p_inventory_lot_id
  )
  returning id into v_movement_id;

  update public.inventory_items
  set current_stock_units = v_after
  where id = p_inventory_item_id;

  perform pg_catalog.set_config('app.inventory_engine_write', 'off', true);

  return jsonb_build_object(
    'movement_id', v_movement_id,
    'inventory_item_id', p_inventory_item_id,
    'before_units', v_before,
    'delta_units', p_delta_units,
    'after_units', v_after
  );
end;
$$;

revoke all on function app_private.inventory_apply_delta_v1(
  uuid, bigint, text, numeric, text, text, bigint, bigint, uuid, bigint
) from public, anon, authenticated;

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

drop trigger if exists inventory_guard_canonical_movement_v1
  on public.inventory_movements;

create trigger inventory_guard_canonical_movement_v1
before insert or update or delete on public.inventory_movements
for each row execute function app_private.inventory_guard_canonical_movement_v1();

create or replace function app_private.inventory_guard_stock_projection_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.current_stock_units is not distinct from old.current_stock_units then
    return new;
  end if;

  if app_private.inventory_item_is_initialized_v1(old.id)
    and coalesce(current_setting('app.inventory_engine_write', true), '') <> 'on'
  then
    raise exception 'El saldo inicializado solo puede cambiar mediante el motor de inventario.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_guard_stock_projection_v1()
  from public, anon, authenticated;

drop trigger if exists inventory_guard_stock_projection_v1
  on public.inventory_items;

create trigger inventory_guard_stock_projection_v1
before update of current_stock_units on public.inventory_items
for each row execute function app_private.inventory_guard_stock_projection_v1();

create or replace function public.inventory_initialize_stock_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_counted_quantity_units numeric,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item record;
  v_delta numeric;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role = 'admin'
  ) then
    raise exception 'Solo administración puede registrar una apertura.' using errcode = '42501';
  end if;

  if p_operation_id is null or p_inventory_item_id is null then
    raise exception 'operation_id e inventory_item_id son obligatorios.' using errcode = '22023';
  end if;

  if p_counted_quantity_units is null or p_counted_quantity_units < 0 then
    raise exception 'La existencia inicial debe ser mayor o igual a cero.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements m where m.operation_id = p_operation_id
  ) then
    if not exists (
      select 1
      from public.inventory_movements m
      where m.operation_id = p_operation_id
        and m.reason_code = 'opening_balance'
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object('status', 'replayed');
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario no encontrado.';
  end if;

  if not v_item.is_active
    or v_item.tracking_mode = 'not_tracked'
    or v_item.merged_into_item_id is not null
  then
    raise exception 'El ítem no admite una apertura operativa.';
  end if;

  if app_private.inventory_item_is_initialized_v1(p_inventory_item_id) then
    raise exception 'El ítem ya tiene una apertura canónica.';
  end if;

  if exists (
    select 1
    from public.inventory_movements m
    where m.inventory_item_id = p_inventory_item_id
      and m.operation_id is not null
  ) then
    raise exception 'El ítem ya tiene operaciones canónicas y no puede abrirse de nuevo.';
  end if;

  v_delta := p_counted_quantity_units - v_item.current_stock_units;

  perform app_private.inventory_apply_delta_v1(
    p_operation_id,
    p_inventory_item_id,
    'stock_count',
    v_delta,
    'opening_balance',
    coalesce(nullif(btrim(p_notes), ''), 'Apertura canónica por conteo físico'),
    null,
    null,
    v_actor,
    null
  );

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object('status', 'applied');
end;
$$;

revoke all on function public.inventory_initialize_stock_v1(uuid, bigint, numeric, text)
  from public, anon;
grant execute on function public.inventory_initialize_stock_v1(uuid, bigint, numeric, text)
  to authenticated;

create or replace function public.inventory_receive_stock_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_quantity_units numeric,
  p_receipt_kind text default 'inbound',
  p_reason_code text default null,
  p_notes text default null,
  p_inventory_lot_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item record;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role in ('admin', 'kitchen')
  ) then
    raise exception 'Solo cocina o administración pueden recibir mercancía.' using errcode = '42501';
  end if;

  if p_operation_id is null or p_inventory_item_id is null then
    raise exception 'operation_id e inventory_item_id son obligatorios.' using errcode = '22023';
  end if;

  if p_quantity_units is null or p_quantity_units <= 0 then
    raise exception 'La cantidad recibida debe ser mayor que cero.' using errcode = '22023';
  end if;

  if p_receipt_kind not in ('inbound', 'return_in') then
    raise exception 'Tipo de entrada inválido.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements m where m.operation_id = p_operation_id
  ) then
    if not exists (
      select 1 from public.inventory_movements m
      where m.operation_id = p_operation_id and m.movement_type = p_receipt_kind
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object('status', 'replayed');
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario no encontrado.';
  end if;

  if not v_item.is_active
    or v_item.tracking_mode = 'not_tracked'
    or v_item.merged_into_item_id is not null
  then
    raise exception 'El ítem no admite entradas operativas.';
  end if;

  if not app_private.inventory_item_is_initialized_v1(p_inventory_item_id) then
    raise exception 'El ítem requiere un conteo de apertura antes de recibir movimientos.';
  end if;

  if p_inventory_lot_id is not null and not exists (
    select 1
    from public.inventory_lots lot
    where lot.id = p_inventory_lot_id
      and lot.inventory_item_id = p_inventory_item_id
      and lot.status = 'open'
  ) then
    raise exception 'El lote no pertenece al ítem o no está abierto.';
  end if;

  perform app_private.inventory_apply_delta_v1(
    p_operation_id,
    p_inventory_item_id,
    p_receipt_kind,
    p_quantity_units,
    coalesce(
      nullif(btrim(p_reason_code), ''),
      case when p_receipt_kind = 'return_in' then 'event_return' else 'merchandise_receipt' end
    ),
    p_notes,
    null,
    p_inventory_lot_id,
    v_actor,
    null
  );

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object('status', 'applied');
end;
$$;

revoke all on function public.inventory_receive_stock_v1(
  uuid, bigint, numeric, text, text, text, bigint
) from public, anon;
grant execute on function public.inventory_receive_stock_v1(
  uuid, bigint, numeric, text, text, text, bigint
) to authenticated;

create or replace function public.inventory_record_loss_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_loss_kind text,
  p_quantity_units numeric,
  p_reason_code text default null,
  p_notes text default null,
  p_inventory_lot_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item record;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role in ('admin', 'kitchen')
  ) then
    raise exception 'Solo cocina o administración pueden reportar pérdidas.' using errcode = '42501';
  end if;

  if p_operation_id is null or p_inventory_item_id is null then
    raise exception 'operation_id e inventory_item_id son obligatorios.' using errcode = '22023';
  end if;

  if p_loss_kind not in ('damage', 'waste', 'quality_taste') then
    raise exception 'Tipo de pérdida inválido.' using errcode = '22023';
  end if;

  if p_quantity_units is null or p_quantity_units <= 0 then
    raise exception 'La cantidad debe ser mayor que cero.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements m where m.operation_id = p_operation_id
  ) then
    if not exists (
      select 1 from public.inventory_movements m
      where m.operation_id = p_operation_id and m.movement_type = p_loss_kind
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object('status', 'replayed');
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario no encontrado.';
  end if;

  if not app_private.inventory_item_is_initialized_v1(p_inventory_item_id) then
    raise exception 'El ítem requiere un conteo de apertura antes de registrar pérdidas.';
  end if;

  if v_item.current_stock_units < p_quantity_units then
    raise exception 'La pérdida dejaría el inventario en negativo.';
  end if;

  if p_inventory_lot_id is not null and not exists (
    select 1
    from public.inventory_lots lot
    where lot.id = p_inventory_lot_id
      and lot.inventory_item_id = p_inventory_item_id
      and lot.status = 'open'
  ) then
    raise exception 'El lote no pertenece al ítem o no está abierto.';
  end if;

  perform app_private.inventory_apply_delta_v1(
    p_operation_id,
    p_inventory_item_id,
    p_loss_kind,
    -p_quantity_units,
    coalesce(nullif(btrim(p_reason_code), ''), p_loss_kind),
    p_notes,
    null,
    p_inventory_lot_id,
    v_actor,
    null
  );

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object('status', 'applied');
end;
$$;

revoke all on function public.inventory_record_loss_v1(
  uuid, bigint, text, numeric, text, text, bigint
) from public, anon;
grant execute on function public.inventory_record_loss_v1(
  uuid, bigint, text, numeric, text, text, bigint
) to authenticated;

create or replace function public.inventory_adjust_stock_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_target_quantity_units numeric,
  p_reason_code text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item record;
  v_delta numeric;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role = 'admin'
  ) then
    raise exception 'Solo administración puede ajustar existencias.' using errcode = '42501';
  end if;

  if p_operation_id is null or p_inventory_item_id is null then
    raise exception 'operation_id e inventory_item_id son obligatorios.' using errcode = '22023';
  end if;

  if p_target_quantity_units is null or p_target_quantity_units < 0 then
    raise exception 'La existencia objetivo debe ser mayor o igual a cero.' using errcode = '22023';
  end if;

  if nullif(btrim(p_reason_code), '') is null then
    raise exception 'El motivo del ajuste es obligatorio.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements m where m.operation_id = p_operation_id
  ) then
    if not exists (
      select 1 from public.inventory_movements m
      where m.operation_id = p_operation_id and m.movement_type = 'manual_adjustment'
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object('status', 'replayed');
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario no encontrado.';
  end if;

  if not app_private.inventory_item_is_initialized_v1(p_inventory_item_id) then
    raise exception 'El ítem requiere un conteo de apertura antes de ajustarse.';
  end if;

  v_delta := p_target_quantity_units - v_item.current_stock_units;

  perform app_private.inventory_apply_delta_v1(
    p_operation_id,
    p_inventory_item_id,
    'manual_adjustment',
    v_delta,
    p_reason_code,
    p_notes,
    null,
    null,
    v_actor,
    null
  );

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object('status', 'applied');
end;
$$;

revoke all on function public.inventory_adjust_stock_v1(uuid, bigint, numeric, text, text)
  from public, anon;
grant execute on function public.inventory_adjust_stock_v1(uuid, bigint, numeric, text, text)
  to authenticated;

create or replace function public.inventory_execute_recipe_v1(
  p_operation_id uuid,
  p_recipe_id bigint,
  p_batch_multiplier numeric,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe record;
  v_component record;
  v_output_item record;
  v_required numeric;
  v_item_ids bigint[];
  v_uninitialized text;
  v_input_type text;
  v_output_type text;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role in ('admin', 'kitchen')
  ) then
    raise exception 'Solo cocina o administración pueden ejecutar recetas.' using errcode = '42501';
  end if;

  if p_operation_id is null or p_recipe_id is null then
    raise exception 'operation_id y recipe_id son obligatorios.' using errcode = '22023';
  end if;

  if p_batch_multiplier is null or p_batch_multiplier <= 0 then
    raise exception 'El multiplicador debe ser mayor que cero.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements m where m.operation_id = p_operation_id
  ) then
    if not exists (
      select 1 from public.inventory_movements m
      where m.operation_id = p_operation_id
        and m.movement_type in ('production_in', 'pack_in')
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object('status', 'replayed');
  end if;

  select recipe.*
  into v_recipe
  from public.inventory_recipes recipe
  where recipe.id = p_recipe_id;

  if not found then
    raise exception 'Receta no encontrada.';
  end if;

  if not v_recipe.is_active then
    raise exception 'La receta está inactiva.';
  end if;

  if coalesce(v_recipe.notes, '') not like 'Bloque 3:%' then
    raise exception 'La receta heredada no está habilitada para el motor canónico.';
  end if;

  if mod(p_batch_multiplier, v_recipe.production_multiple) <> 0 then
    raise exception 'El multiplicador debe respetar el múltiplo de producción %.',
      v_recipe.production_multiple;
  end if;

  if not exists (
    select 1 from public.inventory_recipe_components component
    where component.recipe_id = p_recipe_id
  ) then
    raise exception 'La receta no tiene insumos.';
  end if;

  if exists (
    select 1
    from public.inventory_recipe_components component
    where component.recipe_id = p_recipe_id
      and component.input_inventory_item_id = v_recipe.output_inventory_item_id
  ) then
    raise exception 'La receta no puede consumir su mismo ítem de salida.';
  end if;

  select array_agg(ids.id order by ids.id)
  into v_item_ids
  from (
    select distinct component.input_inventory_item_id as id
    from public.inventory_recipe_components component
    where component.recipe_id = p_recipe_id
    union
    select v_recipe.output_inventory_item_id
  ) ids;

  perform 1
  from public.inventory_items item
  where item.id = any(v_item_ids)
  order by item.id
  for update;

  if (
    select count(*) from public.inventory_items item where item.id = any(v_item_ids)
  ) <> cardinality(v_item_ids) then
    raise exception 'La receta referencia ítems inexistentes.';
  end if;

  select string_agg(item.name, ', ' order by item.id)
  into v_uninitialized
  from public.inventory_items item
  where item.id = any(v_item_ids)
    and not app_private.inventory_item_is_initialized_v1(item.id);

  if v_uninitialized is not null then
    raise exception 'Falta apertura canónica en: %.', v_uninitialized;
  end if;

  v_input_type := case when v_recipe.recipe_kind = 'packaging' then 'pack_out' else 'production_out' end;
  v_output_type := case when v_recipe.recipe_kind = 'packaging' then 'pack_in' else 'production_in' end;

  for v_component in
    select
      component.input_inventory_item_id,
      sum(component.quantity_units) as quantity_units,
      item.name,
      item.current_stock_units
    from public.inventory_recipe_components component
    join public.inventory_items item on item.id = component.input_inventory_item_id
    where component.recipe_id = p_recipe_id
    group by component.input_inventory_item_id, item.name, item.current_stock_units
    order by component.input_inventory_item_id
  loop
    v_required := v_component.quantity_units * p_batch_multiplier;
    if v_component.current_stock_units < v_required then
      raise exception 'Stock insuficiente en %: requiere %, disponible %.',
        v_component.name,
        v_required,
        v_component.current_stock_units;
    end if;

    perform app_private.inventory_apply_delta_v1(
      p_operation_id,
      v_component.input_inventory_item_id,
      v_input_type,
      -v_required,
      format('recipe:%s:v%s', v_recipe.id, v_recipe.version),
      p_notes,
      null,
      null,
      v_actor,
      null
    );
  end loop;

  select item.*
  into v_output_item
  from public.inventory_items item
  where item.id = v_recipe.output_inventory_item_id;

  perform app_private.inventory_apply_delta_v1(
    p_operation_id,
    v_recipe.output_inventory_item_id,
    v_output_type,
    v_recipe.output_quantity_units * p_batch_multiplier,
    format('recipe:%s:v%s', v_recipe.id, v_recipe.version),
    p_notes,
    null,
    null,
    v_actor,
    null
  );

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object(
      'status', 'applied',
      'recipe_id', v_recipe.id,
      'recipe_version', v_recipe.version,
      'output_inventory_item_id', v_output_item.id
    );
end;
$$;

revoke all on function public.inventory_execute_recipe_v1(uuid, bigint, numeric, text)
  from public, anon;
grant execute on function public.inventory_execute_recipe_v1(uuid, bigint, numeric, text)
  to authenticated;

create or replace function public.inventory_reverse_operation_v1(
  p_reversal_operation_id uuid,
  p_target_operation_id uuid,
  p_reason_code text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_reversal_hash bigint;
  v_target_hash bigint;
  v_row record;
  v_negative_item text;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role = 'admin'
  ) then
    raise exception 'Solo administración puede revertir operaciones.' using errcode = '42501';
  end if;

  if p_reversal_operation_id is null or p_target_operation_id is null then
    raise exception 'Las dos claves de operación son obligatorias.' using errcode = '22023';
  end if;

  if p_reversal_operation_id = p_target_operation_id then
    raise exception 'El reverso necesita una clave de operación distinta.' using errcode = '22023';
  end if;

  if nullif(btrim(p_reason_code), '') is null then
    raise exception 'El motivo del reverso es obligatorio.' using errcode = '22023';
  end if;

  v_reversal_hash := pg_catalog.hashtextextended(p_reversal_operation_id::text, 0);
  v_target_hash := pg_catalog.hashtextextended(p_target_operation_id::text, 0);

  if v_reversal_hash <= v_target_hash then
    perform pg_catalog.pg_advisory_xact_lock(v_reversal_hash);
    if v_target_hash <> v_reversal_hash then
      perform pg_catalog.pg_advisory_xact_lock(v_target_hash);
    end if;
  else
    perform pg_catalog.pg_advisory_xact_lock(v_target_hash);
    perform pg_catalog.pg_advisory_xact_lock(v_reversal_hash);
  end if;

  if exists (
    select 1 from public.inventory_movements m where m.operation_id = p_reversal_operation_id
  ) then
    if not exists (
      select 1 from public.inventory_movements m
      where m.operation_id = p_reversal_operation_id and m.movement_type = 'reversal'
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_reversal_operation_id)
      || jsonb_build_object('status', 'replayed', 'reversed_operation_id', p_target_operation_id);
  end if;

  if not exists (
    select 1 from public.inventory_movements m
    where m.operation_id = p_target_operation_id
  ) then
    raise exception 'La operación canónica que se desea revertir no existe.';
  end if;

  if exists (
    select 1 from public.inventory_movements m
    where m.operation_id = p_target_operation_id and m.movement_type = 'reversal'
  ) then
    raise exception 'No se puede revertir un reverso; debe revisarse la operación original.';
  end if;

  if exists (
    select 1
    from public.inventory_movements original
    join public.inventory_movements reversal
      on reversal.reversal_of_movement_id = original.id
    where original.operation_id = p_target_operation_id
  ) then
    raise exception 'La operación ya tiene uno o más movimientos revertidos.';
  end if;

  perform 1
  from public.inventory_items item
  where item.id in (
    select distinct m.inventory_item_id
    from public.inventory_movements m
    where m.operation_id = p_target_operation_id
  )
  order by item.id
  for update;

  select item.name
  into v_negative_item
  from public.inventory_items item
  join (
    select m.inventory_item_id, sum(m.quantity_units) as original_delta
    from public.inventory_movements m
    where m.operation_id = p_target_operation_id
    group by m.inventory_item_id
  ) totals on totals.inventory_item_id = item.id
  where item.current_stock_units - totals.original_delta < 0
  order by item.id
  limit 1;

  if v_negative_item is not null then
    raise exception 'El reverso dejaría % con existencia negativa.', v_negative_item;
  end if;

  for v_row in
    select m.*
    from public.inventory_movements m
    where m.operation_id = p_target_operation_id
    order by m.inventory_item_id, m.id
  loop
    perform app_private.inventory_apply_delta_v1(
      p_reversal_operation_id,
      v_row.inventory_item_id,
      'reversal',
      -v_row.quantity_units,
      p_reason_code,
      p_notes,
      v_row.order_id,
      v_row.inventory_lot_id,
      v_actor,
      v_row.id
    );
  end loop;

  return app_private.inventory_operation_result_v1(p_reversal_operation_id)
    || jsonb_build_object('status', 'applied', 'reversed_operation_id', p_target_operation_id);
end;
$$;

revoke all on function public.inventory_reverse_operation_v1(uuid, uuid, text, text)
  from public, anon;
grant execute on function public.inventory_reverse_operation_v1(uuid, uuid, text, text)
  to authenticated;

create or replace function public.inventory_submit_count_v1(
  p_operation_id uuid,
  p_count_kind text,
  p_lines jsonb,
  p_notes text default null,
  p_parent_count_id bigint default null,
  p_existing_count_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_is_kitchen boolean;
  v_responsible_role public.user_role;
  v_count_id bigint;
  v_existing_operation_count_id bigint;
  v_item_ids bigint[];
  v_line_count integer;
  v_distinct_count integer;
  v_line record;
  v_item record;
  v_expected numeric;
  v_delta numeric;
  v_movement jsonb;
  v_movement_id bigint;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  select
    exists (
      select 1 from public.user_roles ur where ur.user_id = v_actor and ur.role = 'admin'
    ),
    exists (
      select 1 from public.user_roles ur where ur.user_id = v_actor and ur.role = 'kitchen'
    )
  into v_is_admin, v_is_kitchen;

  if not v_is_admin and not v_is_kitchen then
    raise exception 'Solo cocina o administración pueden presentar conteos.' using errcode = '42501';
  end if;

  if p_operation_id is null then
    raise exception 'operation_id es obligatorio.' using errcode = '22023';
  end if;

  if p_count_kind not in ('opening', 'shift_change', 'requested', 'recount', 'periodic') then
    raise exception 'Tipo de conteo inválido.' using errcode = '22023';
  end if;

  if jsonb_typeof(p_lines) <> 'array'
    or jsonb_array_length(p_lines) = 0
    or jsonb_array_length(p_lines) > 200
  then
    raise exception 'El conteo debe contener entre 1 y 200 líneas.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements m where m.operation_id = p_operation_id
  ) then
    select line.inventory_count_id
    into v_existing_operation_count_id
    from public.inventory_count_lines line
    join public.inventory_movements movement on movement.id = line.movement_id
    where movement.operation_id = p_operation_id
    limit 1;

    if v_existing_operation_count_id is null then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object(
        'status', 'replayed',
        'inventory_count_id', v_existing_operation_count_id
      );
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_lines) element
    where jsonb_typeof(element) <> 'object'
      or nullif(element ->> 'inventory_item_id', '') is null
      or nullif(element ->> 'counted_quantity_units', '') is null
  ) then
    raise exception 'Cada línea requiere inventory_item_id y counted_quantity_units.' using errcode = '22023';
  end if;

  select
    count(*),
    count(distinct (element ->> 'inventory_item_id')::bigint),
    array_agg(distinct (element ->> 'inventory_item_id')::bigint order by (element ->> 'inventory_item_id')::bigint)
  into v_line_count, v_distinct_count, v_item_ids
  from jsonb_array_elements(p_lines) element;

  if v_line_count <> v_distinct_count then
    raise exception 'Un ítem no puede repetirse dentro del mismo conteo.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) element
    where (element ->> 'counted_quantity_units')::numeric < 0
  ) then
    raise exception 'Las cantidades contadas no pueden ser negativas.' using errcode = '22023';
  end if;

  perform 1
  from public.inventory_items item
  where item.id = any(v_item_ids)
  order by item.id
  for update;

  if (
    select count(*) from public.inventory_items item where item.id = any(v_item_ids)
  ) <> cardinality(v_item_ids) then
    raise exception 'El conteo contiene ítems inexistentes.';
  end if;

  if exists (
    select 1
    from public.inventory_items item
    where item.id = any(v_item_ids)
      and (
        not item.is_active
        or item.tracking_mode = 'not_tracked'
        or item.merged_into_item_id is not null
      )
  ) then
    raise exception 'El conteo contiene un ítem no operativo.';
  end if;

  if p_count_kind = 'opening' then
    if not v_is_admin then
      raise exception 'Solo administración puede presentar el conteo de apertura.' using errcode = '42501';
    end if;

    if exists (
      select 1 from unnest(v_item_ids) item_id
      where app_private.inventory_item_is_initialized_v1(item_id)
    ) then
      raise exception 'La apertura contiene un ítem ya inicializado.';
    end if;
  elsif exists (
    select 1 from unnest(v_item_ids) item_id
    where not app_private.inventory_item_is_initialized_v1(item_id)
  ) then
    raise exception 'Todos los ítems requieren apertura antes del conteo operativo.';
  end if;

  v_responsible_role := case when v_is_kitchen then 'kitchen'::public.user_role else 'admin'::public.user_role end;

  if p_existing_count_id is not null then
    select count_header.id, count_header.responsible_role
    into v_count_id, v_responsible_role
    from public.inventory_counts count_header
    where count_header.id = p_existing_count_id
      and count_header.status = 'open'
      and count_header.count_kind = p_count_kind
    for update;

    if not found then
      raise exception 'La solicitud de conteo ya no está abierta o no coincide con el tipo indicado.';
    end if;

    if not v_is_admin and v_responsible_role <> 'kitchen'::public.user_role then
      raise exception 'La solicitud no corresponde al rol de cocina.' using errcode = '42501';
    end if;

    if p_parent_count_id is not null then
      raise exception 'parent_count_id no se envía al completar una solicitud existente.' using errcode = '22023';
    end if;

    if (
      select count(*)
      from public.inventory_count_lines line
      where line.inventory_count_id = v_count_id and line.line_status = 'pending'
    ) <> cardinality(v_item_ids)
    or exists (
      select 1
      from public.inventory_count_lines line
      where line.inventory_count_id = v_count_id
        and line.line_status = 'pending'
        and line.inventory_item_id <> all(v_item_ids)
    ) then
      raise exception 'Las líneas enviadas no coinciden con la solicitud abierta.';
    end if;
  else
    if p_count_kind = 'recount' and p_parent_count_id is null then
      raise exception 'Un reconteo requiere parent_count_id.' using errcode = '22023';
    end if;

    if p_count_kind <> 'recount' and p_parent_count_id is not null then
      raise exception 'Solo un reconteo puede tener parent_count_id.' using errcode = '22023';
    end if;

    insert into public.inventory_counts (
      count_kind,
      status,
      responsible_role,
      parent_count_id,
      requested_by_user_id,
      created_by_user_id,
      submitted_at,
      notes
    )
    values (
      p_count_kind,
      'submitted',
      v_responsible_role,
      p_parent_count_id,
      case when p_count_kind in ('requested', 'recount') then v_actor else null end,
      v_actor,
      v_now,
      nullif(btrim(p_notes), '')
    )
    returning id into v_count_id;
  end if;

  for v_line in
    select
      (element ->> 'inventory_item_id')::bigint as inventory_item_id,
      (element ->> 'counted_quantity_units')::numeric as counted_quantity_units,
      nullif(btrim(element ->> 'note'), '') as note
    from jsonb_array_elements(p_lines) element
    order by (element ->> 'inventory_item_id')::bigint
  loop
    select item.*
    into v_item
    from public.inventory_items item
    where item.id = v_line.inventory_item_id;

    if p_existing_count_id is not null then
      select line.expected_quantity_units
      into v_expected
      from public.inventory_count_lines line
      where line.inventory_count_id = v_count_id
        and line.inventory_item_id = v_line.inventory_item_id
        and line.line_status = 'pending';
    else
      v_expected := v_item.current_stock_units;
    end if;

    v_delta := v_line.counted_quantity_units - v_item.current_stock_units;

    v_movement := app_private.inventory_apply_delta_v1(
      p_operation_id,
      v_line.inventory_item_id,
      'stock_count',
      v_delta,
      case when p_count_kind = 'opening' then 'opening_balance' else 'physical_count' end,
      coalesce(v_line.note, p_notes),
      null,
      null,
      v_actor,
      null
    );
    v_movement_id := (v_movement ->> 'movement_id')::bigint;

    if p_existing_count_id is null then
      insert into public.inventory_count_lines (
        inventory_count_id,
        inventory_item_id,
        expected_quantity_units,
        counted_quantity_units,
        line_status,
        note,
        movement_id,
        counted_by_user_id,
        counted_at
      )
      values (
        v_count_id,
        v_line.inventory_item_id,
        v_expected,
        v_line.counted_quantity_units,
        'submitted',
        v_line.note,
        v_movement_id,
        v_actor,
        v_now
      );
    else
      update public.inventory_count_lines
      set counted_quantity_units = v_line.counted_quantity_units,
          line_status = 'submitted',
          note = coalesce(v_line.note, note),
          movement_id = v_movement_id,
          counted_by_user_id = v_actor,
          counted_at = v_now
      where inventory_count_id = v_count_id
        and inventory_item_id = v_line.inventory_item_id
        and line_status = 'pending';
    end if;
  end loop;

  if p_existing_count_id is not null then
    update public.inventory_counts
    set status = 'submitted',
        submitted_at = v_now,
        notes = coalesce(nullif(btrim(p_notes), ''), notes)
    where id = v_count_id;
  end if;

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object(
      'status', 'applied',
      'inventory_count_id', v_count_id,
      'count_kind', p_count_kind
    );
end;
$$;

revoke all on function public.inventory_submit_count_v1(
  uuid, text, jsonb, text, bigint, bigint
) from public, anon;
grant execute on function public.inventory_submit_count_v1(
  uuid, text, jsonb, text, bigint, bigint
) to authenticated;

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
  v_recount_id bigint;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role in ('admin', 'master')
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
    from public.inventory_count_lines line
    where line.inventory_count_id = v_count.id
      and line.id = any(p_line_ids)
      and line.line_status = 'submitted'
  ) <> cardinality(p_line_ids) then
    raise exception 'Una o más líneas no pertenecen al conteo presentado.';
  end if;

  if exists (
    select 1
    from public.inventory_counts child
    where child.parent_count_id = v_count.id
      and child.status in ('open', 'submitted')
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
    original.inventory_item_id,
    item.current_stock_units,
    'pending',
    original.id
  from public.inventory_count_lines original
  join public.inventory_items item on item.id = original.inventory_item_id
  where original.inventory_count_id = v_count.id
    and original.id = any(p_line_ids)
  order by original.id;

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

comment on function public.inventory_initialize_stock_v1(uuid, bigint, numeric, text) is
  'Apertura canónica idempotente de un ítem mediante conteo físico; administración.';
comment on function public.inventory_receive_stock_v1(uuid, bigint, numeric, text, text, text, bigint) is
  'Entrada o devolución idempotente sobre un ítem ya inicializado; cocina o administración.';
comment on function public.inventory_record_loss_v1(uuid, bigint, text, numeric, text, text, bigint) is
  'Avería, merma o prueba de calidad idempotente; cocina o administración.';
comment on function public.inventory_adjust_stock_v1(uuid, bigint, numeric, text, text) is
  'Ajuste administrativo idempotente hacia una existencia objetivo.';
comment on function public.inventory_execute_recipe_v1(uuid, bigint, numeric, text) is
  'Transformación atómica de todos los insumos y la salida de una receta canónica activa.';
comment on function public.inventory_reverse_operation_v1(uuid, uuid, text, text) is
  'Reverso administrativo inmutable de una operación canónica completa.';
comment on function public.inventory_submit_count_v1(uuid, text, jsonb, text, bigint, bigint) is
  'Conteo ciego atómico; congela esperado, registra contado y ajusta la existencia real.';
comment on function public.inventory_review_count_v1(bigint, text, bigint[], text) is
  'Aceptación o solicitud parcial de reconteo por Master o administración.';
