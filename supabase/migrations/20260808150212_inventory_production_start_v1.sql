-- Block 12: canonical production and inventory transformations (complete fresh-install definition).
-- Reuses recipes, planned flows, lots, movements, and the canonical balance.
-- No parallel production table or stock balance is introduced.

set lock_timeout = '5s';
set statement_timeout = '30s';

-- A planned flow can now be reconciled by either a receipt lot or a production lot.
alter table public.inventory_lots
  drop constraint inventory_lots_planned_receipt_shape_check;

alter table public.inventory_lots
  add constraint inventory_lots_planned_flow_shape_check
  check (planned_flow_id is null or lot_kind in ('receipt', 'production')) not valid;

alter table public.inventory_lots
  validate constraint inventory_lots_planned_flow_shape_check;

create or replace function app_private.inventory_validate_lot_planned_flow_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_flow public.inventory_planned_flows%rowtype;
begin
  if new.planned_flow_id is null then
    return new;
  end if;

  select flow.*
  into v_flow
  from public.inventory_planned_flows flow
  where flow.id = new.planned_flow_id;

  if not found then
    raise exception 'El flujo planificado del lote no existe.' using errcode = '23503';
  end if;
  if v_flow.inventory_item_id <> new.inventory_item_id then
    raise exception 'El lote y su flujo planificado deben pertenecer al mismo ítem.'
      using errcode = '23514';
  end if;
  if new.lot_kind = 'receipt' and v_flow.flow_type <> 'expected_receipt' then
    raise exception 'Un lote recibido solo puede conciliar una recepción esperada.'
      using errcode = '23514';
  end if;
  if new.lot_kind = 'production' and v_flow.flow_type <> 'planned_production' then
    raise exception 'Un lote producido solo puede cerrar una producción planificada.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_validate_lot_planned_flow_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists inventory_lots_validate_planned_flow_v1
  on public.inventory_lots;
create trigger inventory_lots_validate_planned_flow_v1
before insert or update of inventory_item_id, lot_kind, planned_flow_id
on public.inventory_lots
for each row
execute function app_private.inventory_validate_lot_planned_flow_v1();

create or replace function public.inventory_activate_recipe_v1(
  p_recipe_id bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe public.inventory_recipes%rowtype;
  v_blockers text[];
  v_replaced_ids bigint[];
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede activar recetas.' using errcode = '42501';
  end if;
  if p_recipe_id is null then
    raise exception 'recipe_id es obligatorio.' using errcode = '22023';
  end if;

  select recipe.*
  into v_recipe
  from public.inventory_recipes recipe
  where recipe.id = p_recipe_id
  for update;

  if not found then
    raise exception 'Receta no encontrada.' using errcode = 'P0002';
  end if;
  if coalesce(v_recipe.notes, '') not like 'Bloque 3:%' then
    raise exception 'Solo las recetas canónicas preparadas pueden activarse desde este centro.'
      using errcode = '22023';
  end if;
  if v_recipe.is_active then
    return jsonb_build_object(
      'status', 'replayed',
      'recipe_id', v_recipe.id,
      'replaced_recipe_ids', '[]'::jsonb
    );
  end if;

  perform 1
  from public.inventory_recipes recipe
  where recipe.output_inventory_item_id = v_recipe.output_inventory_item_id
    and recipe.recipe_kind = v_recipe.recipe_kind
  order by recipe.id
  for update;

  select array_agg(item.name order by item.id)
  into v_blockers
  from public.inventory_items item
  where item.id in (
    select v_recipe.output_inventory_item_id
    union
    select component.input_inventory_item_id
    from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id
  )
  and (
    not item.is_active
    or item.merged_into_item_id is not null
    or item.tracking_mode <> 'transactional'
    or not app_private.inventory_item_has_accepted_opening_v1(item.id)
  );

  if v_blockers is not null then
    raise exception 'Falta activación o apertura aceptada en: %.', array_to_string(v_blockers, ', ')
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id
  ) then
    raise exception 'La receta no tiene insumos.' using errcode = '22023';
  end if;

  select array_agg(recipe.id order by recipe.id)
  into v_replaced_ids
  from public.inventory_recipes recipe
  where recipe.output_inventory_item_id = v_recipe.output_inventory_item_id
    and recipe.recipe_kind = v_recipe.recipe_kind
    and recipe.is_active
    and recipe.id <> v_recipe.id;

  update public.inventory_recipes recipe
  set is_active = false
  where recipe.output_inventory_item_id = v_recipe.output_inventory_item_id
    and recipe.recipe_kind = v_recipe.recipe_kind
    and recipe.is_active
    and recipe.id <> v_recipe.id;

  update public.inventory_recipes
  set is_active = true
  where id = v_recipe.id;

  return jsonb_build_object(
    'status', 'applied',
    'recipe_id', v_recipe.id,
    'replaced_recipe_ids', coalesce(to_jsonb(v_replaced_ids), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.inventory_activate_recipe_v1(bigint)
  from public, anon;
grant execute on function public.inventory_activate_recipe_v1(bigint)
  to authenticated, service_role;

create or replace function public.inventory_start_recipe_v2(
  p_operation_id uuid,
  p_recipe_id bigint,
  p_batch_multiplier numeric,
  p_declared_output_units numeric default null,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe public.inventory_recipes%rowtype;
  v_component record;
  v_output_item public.inventory_items%rowtype;
  v_existing_flow public.inventory_planned_flows%rowtype;
  v_existing_output public.inventory_movements%rowtype;
  v_required numeric;
  v_expected_output numeric;
  v_actual_output numeric;
  v_available_at timestamptz;
  v_item_ids bigint[];
  v_blockers text;
  v_input_type text;
  v_output_type text;
  v_flow_id bigint;
  v_lot_id bigint;
  v_expiry timestamptz;
  v_now timestamptz := now();
  v_movement jsonb;
  v_capture jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'kitchen'::public.user_role)
  ) then
    raise exception 'Solo cocina o administración pueden iniciar preparaciones.'
      using errcode = '42501';
  end if;
  if p_operation_id is null or p_recipe_id is null then
    raise exception 'operation_id y recipe_id son obligatorios.' using errcode = '22023';
  end if;
  if p_batch_multiplier is null or p_batch_multiplier <= 0 then
    raise exception 'El multiplicador debe ser mayor que cero.' using errcode = '22023';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  select recipe.*
  into v_recipe
  from public.inventory_recipes recipe
  where recipe.id = p_recipe_id;
  if not found then
    raise exception 'Receta no encontrada.' using errcode = 'P0002';
  end if;
  if not v_recipe.is_active or coalesce(v_recipe.notes, '') not like 'Bloque 3:%' then
    raise exception 'La receta canónica todavía no está activa.' using errcode = '22023';
  end if;

  select flow.*
  into v_existing_flow
  from public.inventory_planned_flows flow
  where flow.operation_id = p_operation_id;
  if found then
    if v_existing_flow.flow_type <> 'planned_production'
      or v_existing_flow.inventory_recipe_id <> v_recipe.id
    then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'replayed',
      'availability_mode', 'scheduled',
      'production_flow_id', v_existing_flow.id,
      'recipe_id', v_recipe.id,
      'expected_output_units', v_existing_flow.quantity_units,
      'available_at', v_existing_flow.effective_at,
      'flow_status', v_existing_flow.status
    );
  end if;

  select movement.*
  into v_existing_output
  from public.inventory_movements movement
  where movement.operation_id = p_operation_id
    and movement.inventory_item_id = v_recipe.output_inventory_item_id
    and movement.movement_type in ('production_in', 'pack_in')
  limit 1;
  if found then
    if v_existing_output.reason_code <> format(
      'recipe:%s:v%s:complete', v_recipe.id, v_recipe.version
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;
    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object(
        'status', 'replayed',
        'availability_mode', 'immediate',
        'recipe_id', v_recipe.id,
        'actual_output_units', v_existing_output.quantity_units,
        'inventory_lot_id', v_existing_output.inventory_lot_id
      );
  end if;
  if exists (
    select 1 from public.inventory_movements movement
    where movement.operation_id = p_operation_id
  ) then
    raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
  end if;

  if mod(p_batch_multiplier, v_recipe.production_multiple) <> 0 then
    raise exception 'El multiplicador debe respetar el múltiplo de producción %.',
      v_recipe.production_multiple using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id
  ) then
    raise exception 'La receta no tiene insumos.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id
      and component.input_inventory_item_id = v_recipe.output_inventory_item_id
  ) then
    raise exception 'La receta no puede consumir su propio ítem de salida.' using errcode = '22023';
  end if;
  if v_recipe.lead_time_minutes > 0 and p_declared_output_units is not null then
    raise exception 'La salida real de una preparación diferida se declara al terminar.'
      using errcode = '22023';
  end if;

  v_expected_output := v_recipe.output_quantity_units * p_batch_multiplier;
  v_actual_output := case
    when v_recipe.lead_time_minutes = 0
      then coalesce(p_declared_output_units, v_expected_output)
    else null
  end;
  if v_recipe.lead_time_minutes = 0 and v_actual_output <= 0 then
    raise exception 'La salida real debe ser mayor que cero.' using errcode = '22023';
  end if;

  select array_agg(item_id order by item_id)
  into v_item_ids
  from (
    select v_recipe.output_inventory_item_id as item_id
    union
    select component.input_inventory_item_id
    from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id
  ) item_set;

  perform 1
  from public.inventory_items item
  where item.id = any(v_item_ids)
  order by item.id
  for update;

  select string_agg(item.name, ', ' order by item.id)
  into v_blockers
  from public.inventory_items item
  where item.id = any(v_item_ids)
    and (
      not item.is_active
      or item.merged_into_item_id is not null
      or item.tracking_mode <> 'transactional'
      or not app_private.inventory_item_has_accepted_opening_v1(item.id)
    );
  if v_blockers is not null then
    raise exception 'Falta activación o apertura aceptada en: %.', v_blockers
      using errcode = '22023';
  end if;

  v_input_type := case
    when v_recipe.recipe_kind = 'packaging' then 'pack_out'
    else 'production_out'
  end;
  v_output_type := case
    when v_recipe.recipe_kind = 'packaging' then 'pack_in'
    else 'production_in'
  end;

  for v_component in
    select
      component.input_inventory_item_id,
      sum(component.quantity_units) as quantity_units,
      item.name,
      item.current_stock_units
    from public.inventory_recipe_components component
    join public.inventory_items item on item.id = component.input_inventory_item_id
    where component.recipe_id = v_recipe.id
    group by component.input_inventory_item_id, item.name, item.current_stock_units
    order by component.input_inventory_item_id
  loop
    v_required := v_component.quantity_units * p_batch_multiplier;
    if v_component.current_stock_units < v_required then
      raise exception 'Stock insuficiente en %: requiere %, disponible %.',
        v_component.name, v_required, v_component.current_stock_units
        using errcode = '22023';
    end if;

    perform app_private.inventory_apply_delta_v1(
      p_operation_id,
      v_component.input_inventory_item_id,
      v_input_type,
      -v_required,
      format('recipe:%s:v%s:start', v_recipe.id, v_recipe.version),
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

  v_capture := jsonb_build_object(
    'schema_version', 1,
    'recipe_id', v_recipe.id,
    'recipe_version', v_recipe.version,
    'recipe_kind', v_recipe.recipe_kind,
    'batch_multiplier', p_batch_multiplier,
    'expected_output_units', v_expected_output,
    'started_at', v_now,
    'start_operation_id', p_operation_id,
    'lead_time_minutes', v_recipe.lead_time_minutes
  );

  if v_recipe.lead_time_minutes > 0 then
    v_available_at := v_now + make_interval(mins => v_recipe.lead_time_minutes);
    insert into public.inventory_planned_flows (
      inventory_item_id,
      flow_type,
      quantity_units,
      effective_at,
      status,
      inventory_recipe_id,
      notes,
      created_by_user_id,
      operation_id,
      capture_details
    )
    values (
      v_output_item.id,
      'planned_production',
      v_expected_output,
      v_available_at,
      'active',
      v_recipe.id,
      nullif(btrim(p_notes), ''),
      v_actor,
      p_operation_id,
      v_capture
    )
    returning id into v_flow_id;

    return jsonb_build_object(
      'status', 'applied',
      'availability_mode', 'scheduled',
      'production_flow_id', v_flow_id,
      'recipe_id', v_recipe.id,
      'expected_output_units', v_expected_output,
      'available_at', v_available_at,
      'flow_status', 'active'
    );
  end if;

  v_expiry := case
    when v_output_item.shelf_life_days is not null and v_output_item.shelf_life_days > 0
      then v_now + make_interval(days => v_output_item.shelf_life_days)
    else null
  end;
  v_capture := v_capture || jsonb_build_object(
    'actual_output_units', v_actual_output,
    'difference_quantity_units', v_actual_output - v_expected_output,
    'completed_at', v_now,
    'completion_operation_id', p_operation_id
  );

  insert into public.inventory_lots (
    inventory_item_id,
    lot_code,
    lot_kind,
    received_or_produced_at,
    expires_at,
    initial_quantity_units,
    status,
    notes,
    created_by_user_id,
    capture_details
  )
  values (
    v_output_item.id,
    'PROD-' || p_operation_id::text,
    'production',
    v_now,
    v_expiry,
    v_actual_output,
    'open',
    nullif(btrim(p_notes), ''),
    v_actor,
    v_capture
  )
  returning id into v_lot_id;

  v_movement := app_private.inventory_apply_delta_v1(
    p_operation_id,
    v_output_item.id,
    v_output_type,
    v_actual_output,
    format('recipe:%s:v%s:complete', v_recipe.id, v_recipe.version),
    p_notes,
    null,
    v_lot_id,
    v_actor,
    null
  );

  return v_movement || jsonb_build_object(
    'status', 'applied',
    'availability_mode', 'immediate',
    'recipe_id', v_recipe.id,
    'expected_output_units', v_expected_output,
    'actual_output_units', v_actual_output,
    'difference_quantity_units', v_actual_output - v_expected_output,
    'inventory_lot_id', v_lot_id
  );
end;
$$;

revoke all on function public.inventory_start_recipe_v2(uuid, bigint, numeric, numeric, text)
  from public, anon;
grant execute on function public.inventory_start_recipe_v2(uuid, bigint, numeric, numeric, text)
  to authenticated, service_role;

create or replace function public.inventory_complete_production_v1(
  p_operation_id uuid,
  p_production_flow_id bigint,
  p_actual_output_units numeric,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_flow public.inventory_planned_flows%rowtype;
  v_recipe public.inventory_recipes%rowtype;
  v_output_item public.inventory_items%rowtype;
  v_existing_output public.inventory_movements%rowtype;
  v_existing_lot public.inventory_lots%rowtype;
  v_output_type text;
  v_lot_id bigint;
  v_expiry timestamptz;
  v_difference numeric;
  v_capture jsonb;
  v_movement jsonb;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'kitchen'::public.user_role)
  ) then
    raise exception 'Solo cocina o administración pueden terminar preparaciones.'
      using errcode = '42501';
  end if;
  if p_operation_id is null or p_production_flow_id is null then
    raise exception 'operation_id y production_flow_id son obligatorios.' using errcode = '22023';
  end if;
  if p_actual_output_units is null or p_actual_output_units <= 0 then
    raise exception 'La salida real debe ser mayor que cero.' using errcode = '22023';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  select movement.*
  into v_existing_output
  from public.inventory_movements movement
  where movement.operation_id = p_operation_id
    and movement.movement_type in ('production_in', 'pack_in')
  limit 1;
  if found then
    select lot.*
    into v_existing_lot
    from public.inventory_lots lot
    where lot.id = v_existing_output.inventory_lot_id;
    if not found or v_existing_lot.planned_flow_id <> p_production_flow_id then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;
    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object(
        'status', 'replayed',
        'production_flow_id', p_production_flow_id,
        'inventory_lot_id', v_existing_lot.id,
        'actual_output_units', v_existing_lot.initial_quantity_units
      );
  end if;
  if exists (
    select 1 from public.inventory_movements movement
    where movement.operation_id = p_operation_id
  ) or exists (
    select 1 from public.inventory_planned_flows flow
    where flow.operation_id = p_operation_id
  ) then
    raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
  end if;

  select flow.*
  into v_flow
  from public.inventory_planned_flows flow
  where flow.id = p_production_flow_id
  for update;
  if not found or v_flow.flow_type <> 'planned_production' then
    raise exception 'Producción planificada no encontrada.' using errcode = 'P0002';
  end if;
  if v_flow.status <> 'active' then
    raise exception 'La producción ya fue resuelta con estado %.', v_flow.status
      using errcode = '22023';
  end if;
  if v_flow.effective_at > v_now then
    raise exception 'La preparación estará disponible a partir de %.', v_flow.effective_at
      using errcode = '22023';
  end if;

  select recipe.*
  into v_recipe
  from public.inventory_recipes recipe
  where recipe.id = v_flow.inventory_recipe_id;
  if not found then
    raise exception 'La receta de la producción ya no existe.' using errcode = 'P0002';
  end if;

  select item.*
  into v_output_item
  from public.inventory_items item
  where item.id = v_flow.inventory_item_id
  for update;
  if not found
    or not v_output_item.is_active
    or v_output_item.merged_into_item_id is not null
    or v_output_item.tracking_mode <> 'transactional'
    or not app_private.inventory_item_has_accepted_opening_v1(v_output_item.id)
  then
    raise exception 'El ítem de salida no está abierto para producción.' using errcode = '22023';
  end if;

  v_difference := p_actual_output_units - v_flow.quantity_units;
  v_expiry := case
    when v_output_item.shelf_life_days is not null and v_output_item.shelf_life_days > 0
      then v_now + make_interval(days => v_output_item.shelf_life_days)
    else null
  end;
  v_capture := coalesce(v_flow.capture_details, '{}'::jsonb) || jsonb_build_object(
    'actual_output_units', p_actual_output_units,
    'difference_quantity_units', v_difference,
    'completed_at', v_now,
    'completion_operation_id', p_operation_id
  );

  insert into public.inventory_lots (
    inventory_item_id,
    lot_code,
    lot_kind,
    received_or_produced_at,
    expires_at,
    initial_quantity_units,
    status,
    notes,
    created_by_user_id,
    planned_flow_id,
    capture_details
  )
  values (
    v_output_item.id,
    'PROD-' || p_operation_id::text,
    'production',
    v_now,
    v_expiry,
    p_actual_output_units,
    'open',
    nullif(btrim(p_notes), ''),
    v_actor,
    v_flow.id,
    v_capture
  )
  returning id into v_lot_id;

  v_output_type := case
    when v_recipe.recipe_kind = 'packaging' then 'pack_in'
    else 'production_in'
  end;
  v_movement := app_private.inventory_apply_delta_v1(
    p_operation_id,
    v_output_item.id,
    v_output_type,
    p_actual_output_units,
    format('recipe:%s:v%s:complete', v_recipe.id, v_recipe.version),
    p_notes,
    null,
    v_lot_id,
    v_actor,
    null
  );

  update public.inventory_planned_flows
  set status = 'fulfilled',
      resolved_by_user_id = v_actor,
      resolved_at = v_now,
      updated_at = v_now,
      capture_details = v_capture,
      notes = case
        when nullif(btrim(p_notes), '') is null then notes
        when notes is null then btrim(p_notes)
        else notes || E'\n' || btrim(p_notes)
      end
  where id = v_flow.id;

  return v_movement || jsonb_build_object(
    'status', 'applied',
    'production_flow_id', v_flow.id,
    'recipe_id', v_recipe.id,
    'inventory_lot_id', v_lot_id,
    'expected_output_units', v_flow.quantity_units,
    'actual_output_units', p_actual_output_units,
    'difference_quantity_units', v_difference
  );
end;
$$;

revoke all on function public.inventory_complete_production_v1(uuid, bigint, numeric, text)
  from public, anon;
grant execute on function public.inventory_complete_production_v1(uuid, bigint, numeric, text)
  to authenticated, service_role;

create or replace function public.inventory_resolve_production_v1(
  p_production_flow_id bigint,
  p_resolution text,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_can_operate boolean;
  v_flow public.inventory_planned_flows%rowtype;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  select
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role = 'admin'::public.user_role
    ),
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role in ('admin'::public.user_role, 'kitchen'::public.user_role)
    )
  into v_is_admin, v_can_operate;
  if not v_can_operate then
    raise exception 'Solo cocina o administración pueden resolver preparaciones.'
      using errcode = '42501';
  end if;
  if p_resolution not in ('failed', 'cancelled') then
    raise exception 'La resolución debe ser failed o cancelled.' using errcode = '22023';
  end if;
  if p_resolution = 'cancelled' and not v_is_admin then
    raise exception 'Solo administración puede anular una preparación iniciada.'
      using errcode = '42501';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  select flow.*
  into v_flow
  from public.inventory_planned_flows flow
  where flow.id = p_production_flow_id
  for update;
  if not found or v_flow.flow_type <> 'planned_production' then
    raise exception 'Producción planificada no encontrada.' using errcode = 'P0002';
  end if;
  if v_flow.status = p_resolution then
    return jsonb_build_object(
      'status', 'replayed',
      'production_flow_id', v_flow.id,
      'resolution', p_resolution
    );
  end if;
  if v_flow.status <> 'active' then
    raise exception 'La producción ya fue resuelta con estado %.', v_flow.status
      using errcode = '22023';
  end if;

  update public.inventory_planned_flows
  set status = p_resolution,
      resolved_by_user_id = v_actor,
      resolved_at = v_now,
      updated_at = v_now,
      capture_details = coalesce(capture_details, '{}'::jsonb) || jsonb_build_object(
        'actual_output_units', 0,
        'difference_quantity_units', -quantity_units,
        'resolved_at', v_now,
        'resolution', p_resolution,
        'resolution_actor_user_id', v_actor
      ),
      notes = case
        when nullif(btrim(p_notes), '') is null then notes
        when notes is null then btrim(p_notes)
        else notes || E'\n' || btrim(p_notes)
      end
  where id = v_flow.id;

  return jsonb_build_object(
    'status', 'applied',
    'production_flow_id', v_flow.id,
    'resolution', p_resolution,
    'inputs_restored', false
  );
end;
$$;

revoke all on function public.inventory_resolve_production_v1(bigint, text, text)
  from public, anon;
grant execute on function public.inventory_resolve_production_v1(bigint, text, text)
  to authenticated, service_role;

create or replace function public.inventory_production_workspace_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_can_activate boolean;
  v_can_operate boolean;
  v_can_read boolean;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  select
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role = 'admin'::public.user_role
    ),
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role in ('admin'::public.user_role, 'kitchen'::public.user_role)
    ),
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role in (
          'admin'::public.user_role,
          'master'::public.user_role,
          'kitchen'::public.user_role
        )
    )
  into v_can_activate, v_can_operate, v_can_read;

  if not v_can_read then
    raise exception 'No tienes permiso para consultar producción de inventario.'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'permissions', jsonb_build_object(
      'can_activate', v_can_activate,
      'can_start', v_can_operate,
      'can_complete', v_can_operate,
      'can_fail', v_can_operate,
      'can_cancel', v_can_activate
    ),
    'recipes', coalesce((
      select jsonb_agg(recipe_row.payload order by recipe_row.output_name, recipe_row.recipe_id)
      from (
        select
          recipe.id as recipe_id,
          output_item.name as output_name,
          jsonb_build_object(
            'id', recipe.id,
            'recipe_kind', recipe.recipe_kind,
            'is_active', recipe.is_active,
            'notes', recipe.notes,
            'lead_time_minutes', recipe.lead_time_minutes,
            'production_multiple', recipe.production_multiple,
            'output_quantity_units', recipe.output_quantity_units,
            'output_inventory_item_id', output_item.id,
            'output_name', output_item.name,
            'output_unit_name', output_item.unit_name,
            'output_current_stock_units', output_item.current_stock_units,
            'output_availability_mode', output_item.availability_mode,
            'output_target_stock_units', output_item.target_stock_units,
            'activation_blockers', coalesce((
              select jsonb_agg(blocker.name order by blocker.id)
              from public.inventory_items blocker
              where blocker.id in (
                select recipe.output_inventory_item_id
                union
                select component.input_inventory_item_id
                from public.inventory_recipe_components component
                where component.recipe_id = recipe.id
              )
              and (
                not blocker.is_active
                or blocker.merged_into_item_id is not null
                or blocker.tracking_mode <> 'transactional'
                or not app_private.inventory_item_has_accepted_opening_v1(blocker.id)
              )
            ), '[]'::jsonb),
            'components', coalesce((
              select jsonb_agg(jsonb_build_object(
                'inventory_item_id', input_item.id,
                'name', input_item.name,
                'unit_name', input_item.unit_name,
                'quantity_units', component.quantity_units,
                'current_stock_units', input_item.current_stock_units,
                'initialized', app_private.inventory_item_has_accepted_opening_v1(input_item.id)
              ) order by component.sort_order, component.id)
              from public.inventory_recipe_components component
              join public.inventory_items input_item
                on input_item.id = component.input_inventory_item_id
              where component.recipe_id = recipe.id
            ), '[]'::jsonb)
          ) as payload
        from public.inventory_recipes recipe
        join public.inventory_items output_item
          on output_item.id = recipe.output_inventory_item_id
        where coalesce(recipe.notes, '') like 'Bloque 3:%'
      ) recipe_row
    ), '[]'::jsonb),
    'active_batches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', flow.id,
        'recipe_id', flow.inventory_recipe_id,
        'output_inventory_item_id', flow.inventory_item_id,
        'output_name', item.name,
        'output_unit_name', item.unit_name,
        'expected_output_units', flow.quantity_units,
        'available_at', flow.effective_at,
        'is_ready', flow.effective_at <= now(),
        'status', flow.status,
        'notes', flow.notes,
        'created_at', flow.created_at,
        'capture_details', flow.capture_details
      ) order by flow.effective_at, flow.id)
      from public.inventory_planned_flows flow
      join public.inventory_items item on item.id = flow.inventory_item_id
      where flow.flow_type = 'planned_production'
        and flow.status = 'active'
    ), '[]'::jsonb),
    'recent_batches', coalesce((
      select jsonb_agg(recent.payload order by recent.resolved_at desc, recent.id desc)
      from (
        select
          flow.id,
          flow.resolved_at,
          jsonb_build_object(
            'id', flow.id,
            'recipe_id', flow.inventory_recipe_id,
            'output_inventory_item_id', flow.inventory_item_id,
            'output_name', item.name,
            'output_unit_name', item.unit_name,
            'expected_output_units', flow.quantity_units,
            'actual_output_units', nullif(flow.capture_details ->> 'actual_output_units', '')::numeric,
            'difference_quantity_units', nullif(flow.capture_details ->> 'difference_quantity_units', '')::numeric,
            'available_at', flow.effective_at,
            'status', flow.status,
            'resolved_at', flow.resolved_at,
            'notes', flow.notes
          ) as payload
        from public.inventory_planned_flows flow
        join public.inventory_items item on item.id = flow.inventory_item_id
        where flow.flow_type = 'planned_production'
          and flow.status in ('fulfilled', 'failed', 'cancelled')
        order by flow.resolved_at desc nulls last, flow.id desc
        limit 50
      ) recent
    ), '[]'::jsonb),
    'recent_lots', coalesce((
      select jsonb_agg(recent_lot.payload order by recent_lot.produced_at desc, recent_lot.id desc)
      from (
        select
          lot.id,
          lot.received_or_produced_at as produced_at,
          jsonb_build_object(
            'id', lot.id,
            'inventory_item_id', lot.inventory_item_id,
            'item_name', item.name,
            'unit_name', item.unit_name,
            'quantity_units', lot.initial_quantity_units,
            'produced_at', lot.received_or_produced_at,
            'expires_at', lot.expires_at,
            'planned_flow_id', lot.planned_flow_id,
            'capture_details', lot.capture_details
          ) as payload
        from public.inventory_lots lot
        join public.inventory_items item on item.id = lot.inventory_item_id
        where lot.lot_kind = 'production'
        order by lot.received_or_produced_at desc, lot.id desc
        limit 50
      ) recent_lot
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'canonical_recipes', (
        select count(*) from public.inventory_recipes recipe
        where coalesce(recipe.notes, '') like 'Bloque 3:%'
      ),
      'active_recipes', (
        select count(*) from public.inventory_recipes recipe
        where coalesce(recipe.notes, '') like 'Bloque 3:%' and recipe.is_active
      ),
      'cooling_batches', (
        select count(*) from public.inventory_planned_flows flow
        where flow.flow_type = 'planned_production'
          and flow.status = 'active'
          and flow.effective_at > now()
      ),
      'ready_batches', (
        select count(*) from public.inventory_planned_flows flow
        where flow.flow_type = 'planned_production'
          and flow.status = 'active'
          and flow.effective_at <= now()
      ),
      'yield_variances', (
        select count(*) from public.inventory_planned_flows flow
        where flow.flow_type = 'planned_production'
          and flow.status = 'fulfilled'
          and coalesce(nullif(flow.capture_details ->> 'difference_quantity_units', '')::numeric, 0) <> 0
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.inventory_production_workspace_v1()
  from public, anon;
grant execute on function public.inventory_production_workspace_v1()
  to authenticated, service_role;

comment on constraint inventory_lots_planned_flow_shape_check on public.inventory_lots is
  'A receipt or production lot may reconcile exactly one compatible planned flow.';
comment on function public.inventory_activate_recipe_v1(bigint) is
  'Admin-only activation of a staged canonical recipe after accepted openings; replaces the prior active version.';
comment on function public.inventory_start_recipe_v2(uuid, bigint, numeric, numeric, text) is
  'Kitchen/Admin production start: consumes inputs atomically; immediate recipes credit actual output, delayed recipes create unavailable work in progress.';
comment on function public.inventory_complete_production_v1(uuid, bigint, numeric, text) is
  'Kitchen/Admin completion of a ready delayed production with declared physical yield, production lot, and output movement.';
comment on function public.inventory_resolve_production_v1(bigint, text, text) is
  'Resolves an active production as failed or admin-cancelled without silently restoring already consumed inputs.';
comment on function public.inventory_production_workspace_v1() is
  'Role-aware canonical production read model for Inventory and future Kitchen/Master adapters.';
