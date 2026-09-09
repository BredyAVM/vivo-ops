-- The configured lead time remains a planning estimate for prefried batches,
-- but Kitchen or Administration may confirm physical readiness and credit the
-- real output before that estimate. The early completion is preserved in the
-- existing flow/lot capture_details for auditability. No table or column is added.

set lock_timeout = '5s';
set statement_timeout = '120s';

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
  v_completed_before_estimate boolean := false;
  v_estimated_minutes_remaining integer := 0;
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

  v_completed_before_estimate := coalesce(v_flow.effective_at > v_now, false);
  v_estimated_minutes_remaining := case
    when v_completed_before_estimate
      then greatest(ceil(extract(epoch from (v_flow.effective_at - v_now)) / 60)::integer, 0)
    else 0
  end;

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
    'completion_operation_id', p_operation_id,
    'estimated_available_at', v_flow.effective_at,
    'completed_before_estimate', v_completed_before_estimate,
    'estimated_minutes_remaining_at_completion', v_estimated_minutes_remaining
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
    'difference_quantity_units', v_difference,
    'estimated_available_at', v_flow.effective_at,
    'completed_before_estimate', v_completed_before_estimate,
    'estimated_minutes_remaining_at_completion', v_estimated_minutes_remaining
  );
end;
$$;

revoke all on function public.inventory_complete_production_v1(uuid, bigint, numeric, text)
  from public, anon;
grant execute on function public.inventory_complete_production_v1(uuid, bigint, numeric, text)
  to authenticated, service_role;

comment on function public.inventory_complete_production_v1(uuid, bigint, numeric, text) is
  'Credits the declared physical production when Kitchen or Administration confirms readiness. Recipe lead time is a planning estimate, not a completion lock; early completion is audited in capture_details.';
