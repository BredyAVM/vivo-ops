set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace function public.inventory_start_recipe_v3(
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
  v_upstream_recipe public.inventory_recipes%rowtype;
  v_input_item public.inventory_items%rowtype;
  v_input_item_id bigint;
  v_component_quantity numeric;
  v_required_input numeric;
  v_deficit numeric;
  v_upstream_multiplier numeric;
  v_upstream_output numeric;
  v_upstream_operation_id uuid;
  v_lock_item_ids bigint[];
  v_result jsonb;
  v_auto_preparation_applied boolean := false;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'kitchen'::public.user_role)
  ) then
    raise exception 'Solo cocina o administración pueden iniciar preparaciones.'
      using errcode = '42501';
  end if;
  if p_operation_id is null or p_recipe_id is null then
    raise exception 'operation_id y recipe_id son obligatorios.' using errcode = '22023';
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

  -- A replay must never manufacture the upstream input a second time.
  if exists (
    select 1
    from public.inventory_movements movement
    where movement.operation_id = p_operation_id
  ) or exists (
    select 1
    from public.inventory_planned_flows flow
    where flow.operation_id = p_operation_id
  ) then
    v_result := public.inventory_start_recipe_v2(
      p_operation_id,
      p_recipe_id,
      p_batch_multiplier,
      p_declared_output_units,
      p_notes
    );
    return v_result || jsonb_build_object(
      'auto_preparation_applied', false
    );
  end if;

  -- Automatic chaining is deliberately narrow: one immediate packaging input
  -- may be supplied by one immediate active production recipe. This covers
  -- bulk tartar -> 5 oz / 2 oz / 1 oz without introducing a second recipe model.
  if v_recipe.is_active
    and coalesce(v_recipe.notes, '') like 'Bloque 3:%'
    and v_recipe.recipe_kind = 'packaging'
    and v_recipe.lead_time_minutes = 0
    and (
      select count(*)
      from public.inventory_recipe_components component
      where component.recipe_id = v_recipe.id
    ) = 1
  then
    select
      component.input_inventory_item_id,
      component.quantity_units
    into
      v_input_item_id,
      v_component_quantity
    from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id;

    select upstream.*
    into v_upstream_recipe
    from public.inventory_recipes upstream
    where upstream.output_inventory_item_id = v_input_item_id
      and upstream.recipe_kind = 'production'
      and upstream.lead_time_minutes = 0
      and upstream.is_active
      and coalesce(upstream.notes, '') like 'Bloque 3:%';

    if found then
      -- Lock the complete two-step item set in canonical order. Besides keeping
      -- the calculation current, this avoids over-producing under concurrency.
      select array_agg(item_id order by item_id)
      into v_lock_item_ids
      from (
        select v_recipe.output_inventory_item_id as item_id
        union
        select v_input_item_id
        union
        select component.input_inventory_item_id
        from public.inventory_recipe_components component
        where component.recipe_id = v_upstream_recipe.id
      ) item_set;

      perform 1
      from public.inventory_items item
      where item.id = any(v_lock_item_ids)
      order by item.id
      for update;

      select item.*
      into v_input_item
      from public.inventory_items item
      where item.id = v_input_item_id;

      v_required_input := v_component_quantity * p_batch_multiplier;
      v_deficit := greatest(v_required_input - v_input_item.current_stock_units, 0);

      if v_deficit > 0 then
        v_upstream_multiplier := ceil(
          (v_deficit / v_upstream_recipe.output_quantity_units)
          / v_upstream_recipe.production_multiple
        ) * v_upstream_recipe.production_multiple;
        v_upstream_output := v_upstream_recipe.output_quantity_units
          * v_upstream_multiplier;
        v_upstream_operation_id := pg_catalog.md5(
          p_operation_id::text || ':auto-upstream:' || v_upstream_recipe.id::text
        )::uuid;

        perform public.inventory_start_recipe_v2(
          v_upstream_operation_id,
          v_upstream_recipe.id,
          v_upstream_multiplier,
          v_upstream_output,
          format(
            'Preparación automática para porcionar %s.',
            (select item.name
             from public.inventory_items item
             where item.id = v_recipe.output_inventory_item_id)
          )
        );
        v_auto_preparation_applied := true;
      end if;
    end if;
  end if;

  v_result := public.inventory_start_recipe_v2(
    p_operation_id,
    p_recipe_id,
    p_batch_multiplier,
    p_declared_output_units,
    p_notes
  );

  return v_result || jsonb_build_object(
    'auto_preparation_applied', v_auto_preparation_applied,
    'auto_preparation_recipe_id',
      case when v_auto_preparation_applied then v_upstream_recipe.id else null end,
    'auto_preparation_output_units',
      case when v_auto_preparation_applied then v_upstream_output else null end,
    'auto_preparation_input_item_id',
      case when v_auto_preparation_applied then v_input_item_id else null end
  );
end;
$$;

revoke all on function public.inventory_start_recipe_v3(uuid, bigint, numeric, numeric, text)
  from public, anon;
grant execute on function public.inventory_start_recipe_v3(uuid, bigint, numeric, numeric, text)
  to authenticated, service_role;

comment on function public.inventory_start_recipe_v3(uuid, bigint, numeric, numeric, text) is
  'Starts a canonical recipe atomically and, for one-input immediate packaging, prepares a missing immediate upstream input before packaging it.';
