-- Block 13B: deterministic inventory alert detection and reconciliation.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function app_private.inventory_effective_alert_policy_v1(
  p_alert_category text,
  p_inventory_item_id bigint
)
returns table (
  policy_id bigint,
  is_enabled boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select policy.id, policy.is_enabled
  from public.inventory_alert_policies policy
  where policy.alert_category = p_alert_category
    and (
      policy.inventory_item_id = p_inventory_item_id
      or policy.inventory_item_id is null
    )
  order by (policy.inventory_item_id is not null) desc
  limit 1;
$$;

revoke all on function app_private.inventory_effective_alert_policy_v1(text, bigint)
  from public, anon, authenticated, service_role;

-- Immediate preparations contribute capacity without pretending their output is
-- already stored. Scheduled recipes never contribute before their planned flow.
create or replace function app_private.inventory_effective_capacity_v1(
  p_inventory_item_id bigint,
  p_target_at timestamptz,
  p_visited bigint[] default array[]::bigint[]
)
returns numeric
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_item public.inventory_items%rowtype;
  v_recipe public.inventory_recipes%rowtype;
  v_capacity jsonb;
  v_base_capacity numeric;
  v_component record;
  v_component_capacity numeric;
  v_batch_capacity numeric;
  v_batches numeric;
begin
  if p_inventory_item_id is null
    or p_target_at is null
    or p_inventory_item_id = any(coalesce(p_visited, array[]::bigint[]))
    or cardinality(coalesce(p_visited, array[]::bigint[])) >= 12
  then
    return 0;
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id;

  if not found
    or not v_item.is_active
    or v_item.tracking_mode not in ('transactional', 'periodic_count')
    or v_item.merged_into_item_id is not null
    or not app_private.inventory_item_is_initialized_v1(v_item.id)
  then
    return null;
  end if;

  v_capacity := app_private.inventory_item_capacity_v1(
    v_item.id,
    p_target_at,
    null
  );
  v_base_capacity := greatest(
    coalesce((v_capacity ->> 'available_without_affecting_commitments')::numeric, 0),
    0
  );

  if v_item.availability_mode <> 'immediate_recipe' then
    return v_base_capacity;
  end if;

  select recipe.*
  into v_recipe
  from public.inventory_recipes recipe
  where recipe.output_inventory_item_id = v_item.id
    and recipe.is_active
    and recipe.lead_time_minutes = 0
  order by recipe.version desc, recipe.id desc
  limit 1;

  if not found then
    return v_base_capacity;
  end if;

  v_batches := null;
  for v_component in
    select component.input_inventory_item_id, component.quantity_units
    from public.inventory_recipe_components component
    where component.recipe_id = v_recipe.id
    order by component.id
  loop
    v_component_capacity := app_private.inventory_effective_capacity_v1(
      v_component.input_inventory_item_id,
      p_target_at,
      coalesce(p_visited, array[]::bigint[]) || v_item.id
    );
    v_batch_capacity := greatest(
      coalesce(v_component_capacity, 0) / v_component.quantity_units,
      0
    );
    v_batches := case
      when v_batches is null then v_batch_capacity
      else least(v_batches, v_batch_capacity)
    end;
  end loop;

  if v_batches is null or v_batches <= 0 then
    return v_base_capacity;
  end if;

  v_batches := floor(v_batches / v_recipe.production_multiple)
    * v_recipe.production_multiple;

  return greatest(
    v_base_capacity + (v_batches * v_recipe.output_quantity_units),
    0
  );
end;
$$;

revoke all on function app_private.inventory_effective_capacity_v1(
  bigint, timestamptz, bigint[]
) from public, anon, authenticated, service_role;

create or replace function app_private.inventory_upsert_alert_candidate_v1(
  p_detected_at timestamptz,
  p_alert_key text,
  p_alert_category text,
  p_alert_type text,
  p_severity text,
  p_requires_action boolean,
  p_inventory_item_id bigint,
  p_order_id bigint,
  p_planned_flow_id bigint,
  p_inventory_count_id bigint,
  p_title text,
  p_message text,
  p_details jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_policy record;
  v_alert_id bigint;
begin
  select *
  into v_policy
  from app_private.inventory_effective_alert_policy_v1(
    p_alert_category,
    p_inventory_item_id
  );

  if not found or not v_policy.is_enabled then
    return null;
  end if;

  insert into public.inventory_alerts (
    alert_key,
    alert_category,
    alert_type,
    severity,
    requires_action,
    status,
    inventory_item_id,
    order_id,
    planned_flow_id,
    inventory_count_id,
    title,
    message,
    details,
    first_detected_at,
    last_detected_at,
    created_at,
    updated_at
  )
  values (
    p_alert_key,
    p_alert_category,
    p_alert_type,
    p_severity,
    p_requires_action,
    'open',
    p_inventory_item_id,
    p_order_id,
    p_planned_flow_id,
    p_inventory_count_id,
    p_title,
    p_message,
    coalesce(p_details, '{}'::jsonb)
      || jsonb_build_object('detection_source', 'inventory_reconciler'),
    p_detected_at,
    p_detected_at,
    p_detected_at,
    p_detected_at
  )
  on conflict (alert_key) where status in ('open', 'managed')
  do update set
    alert_category = excluded.alert_category,
    alert_type = excluded.alert_type,
    severity = excluded.severity,
    requires_action = excluded.requires_action,
    inventory_item_id = excluded.inventory_item_id,
    order_id = excluded.order_id,
    planned_flow_id = excluded.planned_flow_id,
    inventory_count_id = excluded.inventory_count_id,
    title = excluded.title,
    message = excluded.message,
    details = excluded.details,
    last_detected_at = excluded.last_detected_at,
    updated_at = excluded.updated_at
  returning id into v_alert_id;

  return v_alert_id;
end;
$$;

revoke all on function app_private.inventory_upsert_alert_candidate_v1(
  timestamptz, text, text, text, text, boolean, bigint, bigint, bigint, bigint,
  text, text, jsonb
) from public, anon, authenticated, service_role;

create or replace function app_private.inventory_refresh_alerts_core_v1()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_actor uuid := auth.uid();
  v_row record;
  v_capacity numeric;
  v_threshold_hit boolean;
  v_opened_or_updated integer := 0;
  v_resolved integer := 0;
  v_alert_id bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory_alert_refresh_v1', 0)
  );

  -- Commercial availability is based on free capacity after protected
  -- commitments. Immediate recipes contribute only what their inputs can make.
  for v_row in
    select
      item.*,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'product_id', affected.id,
          'product_name', affected.name
        ) order by affected.name, affected.id), '[]'::jsonb)
        from (
          select distinct product.id, product.name
          from public.product_inventory_links link
          join public.products product on product.id = link.product_id
          where link.inventory_item_id = item.id
            and link.is_active
            and product.is_active
            and product.inventory_enabled
            and product.inventory_configuration_status = 'ready'
        ) affected
      ) as affected_products,
      (
        select min(flow.effective_at)
        from public.inventory_planned_flows flow
        where flow.inventory_item_id = item.id
          and flow.status = 'active'
          and flow.flow_type in ('expected_receipt', 'planned_production')
          and flow.effective_at > v_started_at
      ) as next_incoming_at
    from public.inventory_items item
    where item.is_active
      and item.tracking_mode in ('transactional', 'periodic_count')
      and item.merged_into_item_id is null
      and app_private.inventory_item_is_initialized_v1(item.id)
      and exists (
        select 1
        from public.product_inventory_links link
        join public.products product on product.id = link.product_id
        where link.inventory_item_id = item.id
          and link.is_active
          and product.is_active
          and product.inventory_enabled
          and product.inventory_configuration_status = 'ready'
      )
  loop
    v_capacity := app_private.inventory_effective_capacity_v1(
      v_row.id,
      v_started_at,
      array[]::bigint[]
    );
    if v_capacity is null then
      continue;
    end if;

    if v_capacity <= 0 then
      v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
        v_started_at,
        format('availability:out:item:%s', v_row.id),
        'availability',
        'commercial_out',
        'critical',
        false,
        v_row.id,
        null,
        null,
        null,
        format('%s no tiene disponibilidad libre', v_row.name),
        case
          when v_row.next_incoming_at is null
            then 'No hay unidades disponibles sin afectar compromisos confirmados.'
          else format(
            'No hay unidades libres ahora. Existe una reposición o producción prevista para %s.',
            to_char(v_row.next_incoming_at at time zone 'America/Caracas', 'DD/MM/YYYY HH24:MI')
          )
        end,
        jsonb_build_object(
          'available_without_affecting_commitments', v_capacity,
          'current_stock_units', v_row.current_stock_units,
          'next_available_at', v_row.next_incoming_at,
          'affected_products', v_row.affected_products
        )
      );
    else
      v_threshold_hit := v_row.low_stock_threshold is not null and (
        (v_row.low_stock_inclusive and v_capacity <= v_row.low_stock_threshold)
        or (not v_row.low_stock_inclusive and v_capacity < v_row.low_stock_threshold)
      );
      if v_threshold_hit then
        v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
          v_started_at,
          format('availability:low:item:%s', v_row.id),
          'availability',
          'commercial_low',
          'warning',
          false,
          v_row.id,
          null,
          null,
          null,
          format('%s está en últimas unidades', v_row.name),
          format(
            'Quedan %s unidades disponibles sin afectar compromisos confirmados.',
            trim(to_char(v_capacity, 'FM999999990.##'))
          ),
          jsonb_build_object(
            'available_without_affecting_commitments', v_capacity,
            'current_stock_units', v_row.current_stock_units,
            'low_stock_threshold', v_row.low_stock_threshold,
            'affected_products', v_row.affected_products
          )
        );
      end if;
    end if;
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  -- Purchased or counted inputs use the real physical balance for procurement.
  for v_row in
    select item.*
    from public.inventory_items item
    where item.is_active
      and item.tracking_mode in ('transactional', 'periodic_count')
      and item.merged_into_item_id is null
      and item.low_stock_threshold is not null
      and app_private.inventory_item_is_initialized_v1(item.id)
      and not exists (
        select 1
        from public.inventory_recipes recipe
        where recipe.output_inventory_item_id = item.id
          and recipe.is_active
      )
      and (
        (item.low_stock_inclusive and item.current_stock_units <= item.low_stock_threshold)
        or (not item.low_stock_inclusive and item.current_stock_units < item.low_stock_threshold)
      )
  loop
    v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
      v_started_at,
      format('procurement:%s:item:%s',
        case when v_row.current_stock_units <= 0 then 'out' else 'low' end,
        v_row.id
      ),
      'procurement',
      case when v_row.current_stock_units <= 0 then 'stock_out' else 'stock_low' end,
      case when v_row.current_stock_units <= 0 then 'critical' else 'warning' end,
      true,
      v_row.id,
      null,
      null,
      null,
      case
        when v_row.current_stock_units <= 0 then format('Reponer %s: existencia agotada', v_row.name)
        else format('Reponer %s: existencia baja', v_row.name)
      end,
      format(
        'Existencia física: %s %s. Umbral: %s.',
        trim(to_char(v_row.current_stock_units, 'FM999999990.##')),
        v_row.unit_name,
        trim(to_char(v_row.low_stock_threshold, 'FM999999990.##'))
      ),
      jsonb_build_object(
        'current_stock_units', v_row.current_stock_units,
        'low_stock_threshold', v_row.low_stock_threshold,
        'target_stock_units', v_row.target_stock_units,
        'unit_name', v_row.unit_name
      )
    );
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  -- Prepared stock can request production without being confused with a purchase.
  for v_row in
    select
      item.*,
      recipe.id as recipe_id,
      recipe.lead_time_minutes
    from public.inventory_items item
    join lateral (
      select candidate.id, candidate.lead_time_minutes
      from public.inventory_recipes candidate
      where candidate.output_inventory_item_id = item.id
        and candidate.is_active
      order by candidate.version desc, candidate.id desc
      limit 1
    ) recipe on true
    where item.is_active
      and item.tracking_mode in ('transactional', 'periodic_count')
      and item.merged_into_item_id is null
      and item.target_stock_units is not null
      and item.current_stock_units < item.target_stock_units
      and app_private.inventory_item_is_initialized_v1(item.id)
  loop
    v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
      v_started_at,
      format('production:target:item:%s', v_row.id),
      'production',
      'production_below_target',
      case
        when v_row.current_stock_units <= 0 and v_row.lead_time_minutes > 0 then 'critical'
        else 'warning'
      end,
      true,
      v_row.id,
      null,
      null,
      null,
      format('Preparar %s para recuperar el objetivo', v_row.name),
      format(
        'Existencia: %s. Objetivo: %s. Tiempo de preparación: %s minutos.',
        trim(to_char(v_row.current_stock_units, 'FM999999990.##')),
        trim(to_char(v_row.target_stock_units, 'FM999999990.##')),
        v_row.lead_time_minutes
      ),
      jsonb_build_object(
        'recipe_id', v_row.recipe_id,
        'current_stock_units', v_row.current_stock_units,
        'target_stock_units', v_row.target_stock_units,
        'suggested_output_units', v_row.target_stock_units - v_row.current_stock_units,
        'lead_time_minutes', v_row.lead_time_minutes
      )
    );
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  for v_row in
    select flow.*, item.name as item_name, item.unit_name
    from public.inventory_planned_flows flow
    join public.inventory_items item on item.id = flow.inventory_item_id
    where flow.status = 'active'
      and flow.effective_at < v_started_at
      and flow.flow_type in ('expected_receipt', 'planned_production')
  loop
    v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
      v_started_at,
      format('%s:overdue:flow:%s',
        case when v_row.flow_type = 'expected_receipt' then 'procurement' else 'production' end,
        v_row.id
      ),
      case when v_row.flow_type = 'expected_receipt' then 'procurement' else 'production' end,
      case when v_row.flow_type = 'expected_receipt'
        then 'expected_receipt_overdue'
        else 'production_overdue'
      end,
      'warning',
      true,
      v_row.inventory_item_id,
      v_row.order_id,
      v_row.id,
      null,
      case when v_row.flow_type = 'expected_receipt'
        then format('Recepción atrasada: %s', v_row.item_name)
        else format('Producción atrasada: %s', v_row.item_name)
      end,
      format(
        'La disponibilidad estaba prevista para %s y continúa pendiente.',
        to_char(v_row.effective_at at time zone 'America/Caracas', 'DD/MM/YYYY HH24:MI')
      ),
      jsonb_build_object(
        'effective_at', v_row.effective_at,
        'quantity_units', v_row.quantity_units,
        'unit_name', v_row.unit_name,
        'flow_type', v_row.flow_type
      )
    );
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  for v_row in
    select
      flow.*,
      item.name as item_name,
      lot.initial_quantity_units as actual_quantity_units,
      lot.id as lot_id
    from public.inventory_planned_flows flow
    join public.inventory_items item on item.id = flow.inventory_item_id
    left join lateral (
      select candidate.id, candidate.initial_quantity_units
      from public.inventory_lots candidate
      where candidate.planned_flow_id = flow.id
      order by candidate.created_at desc, candidate.id desc
      limit 1
    ) lot on true
    where (
      flow.flow_type = 'expected_receipt'
      and flow.status = 'failed'
      and flow.quantity_units is not null
      and lot.initial_quantity_units is not null
      and lot.initial_quantity_units <> flow.quantity_units
    )
    or (
      flow.flow_type = 'planned_production'
      and flow.status = 'fulfilled'
      and nullif(flow.capture_details ->> 'difference_quantity_units', '')::numeric <> 0
    )
  loop
    v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
      v_started_at,
      format('%s:variance:flow:%s',
        case when v_row.flow_type = 'expected_receipt' then 'procurement' else 'production' end,
        v_row.id
      ),
      case when v_row.flow_type = 'expected_receipt' then 'procurement' else 'production' end,
      case when v_row.flow_type = 'expected_receipt'
        then 'receipt_variance'
        else 'production_variance'
      end,
      'warning',
      true,
      v_row.inventory_item_id,
      v_row.order_id,
      v_row.id,
      null,
      case when v_row.flow_type = 'expected_receipt'
        then format('Diferencia en recepción: %s', v_row.item_name)
        else format('Diferencia de rendimiento: %s', v_row.item_name)
      end,
      case when v_row.flow_type = 'expected_receipt'
        then format(
          'Se esperaban %s y se recibieron %s unidades.',
          trim(to_char(v_row.quantity_units, 'FM999999990.##')),
          trim(to_char(v_row.actual_quantity_units, 'FM999999990.##'))
        )
        else format(
          'La producción terminó con una diferencia de %s unidades.',
          trim(to_char(
            nullif(v_row.capture_details ->> 'difference_quantity_units', '')::numeric,
            'FM999999990.##'
          ))
        )
      end,
      jsonb_build_object(
        'expected_quantity_units', v_row.quantity_units,
        'actual_quantity_units', case
          when v_row.flow_type = 'expected_receipt' then v_row.actual_quantity_units
          else nullif(v_row.capture_details ->> 'actual_output_units', '')::numeric
        end,
        'difference_quantity_units', case
          when v_row.flow_type = 'expected_receipt'
            then v_row.actual_quantity_units - v_row.quantity_units
          else nullif(v_row.capture_details ->> 'difference_quantity_units', '')::numeric
        end,
        'inventory_lot_id', v_row.lot_id,
        'flow_type', v_row.flow_type
      )
    );
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  for v_row in
    select flow.*, item.name as item_name
    from public.inventory_planned_flows flow
    join public.inventory_items item on item.id = flow.inventory_item_id
    where flow.flow_type = 'planned_production'
      and flow.status = 'failed'
      and coalesce(flow.capture_details ->> 'resolution', 'failed') = 'failed'
  loop
    v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
      v_started_at,
      format('production:failed:flow:%s', v_row.id),
      'production',
      'production_failed',
      'critical',
      true,
      v_row.inventory_item_id,
      v_row.order_id,
      v_row.id,
      null,
      format('Producción fallida: %s', v_row.item_name),
      'Los insumos consumidos no generaron salida disponible. Administración debe revisar la trazabilidad.',
      jsonb_build_object(
        'expected_output_units', v_row.quantity_units,
        'capture_details', v_row.capture_details
      )
    );
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  for v_row in
    select count_header.*
    from public.inventory_counts count_header
    where count_header.status in ('open', 'recount_requested')
      and count_header.due_at is not null
      and count_header.due_at < v_started_at
  loop
    v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
      v_started_at,
      format('control:count-overdue:%s', v_row.id),
      'control',
      'count_overdue',
      'warning',
      true,
      null,
      null,
      null,
      v_row.id,
      format('Conteo vencido #%s', v_row.id),
      format(
        'El conteo %s venció el %s y no debe bloquear ninguna orden.',
        v_row.count_kind,
        to_char(v_row.due_at at time zone 'America/Caracas', 'DD/MM/YYYY HH24:MI')
      ),
      jsonb_build_object(
        'count_kind', v_row.count_kind,
        'responsible_role', v_row.responsible_role,
        'due_at', v_row.due_at
      )
    );
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  for v_row in
    select
      count_header.id,
      count_header.status,
      count_header.count_kind,
      count_header.responsible_role,
      coalesce(jsonb_agg(jsonb_build_object(
        'line_id', line.id,
        'inventory_item_id', line.inventory_item_id,
        'inventory_item_name', item.name,
        'difference_quantity_units', line.difference_quantity_units,
        'line_status', line.line_status,
        'note', line.note
      ) order by abs(line.difference_quantity_units) desc, line.id)
        filter (where line.difference_quantity_units is not null and line.difference_quantity_units <> 0),
        '[]'::jsonb
      ) as differences,
      count(*) filter (
        where line.difference_quantity_units is not null
          and line.difference_quantity_units <> 0
      ) as difference_count
    from public.inventory_counts count_header
    join public.inventory_count_lines line
      on line.inventory_count_id = count_header.id
    join public.inventory_items item on item.id = line.inventory_item_id
    where count_header.status in ('submitted', 'recount_requested')
    group by count_header.id
    having count(*) filter (
      where line.difference_quantity_units is not null
        and line.difference_quantity_units <> 0
    ) > 0
  loop
    v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
      v_started_at,
      format('control:count-variance:%s', v_row.id),
      'control',
      case when v_row.status = 'recount_requested' then 'recount_requested' else 'count_variance' end,
      'warning',
      true,
      null,
      null,
      null,
      v_row.id,
      case when v_row.status = 'recount_requested'
        then format('Reconteo solicitado #%s', v_row.id)
        else format('Diferencias en conteo #%s', v_row.id)
      end,
      format('%s ítems presentan diferencias pendientes de revisión.', v_row.difference_count),
      jsonb_build_object(
        'count_kind', v_row.count_kind,
        'responsible_role', v_row.responsible_role,
        'difference_count', v_row.difference_count,
        'differences', v_row.differences
      )
    );
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  -- A projected negative balance means confirmed commitments depend on a change
  -- in supply. Immediate recipes are excluded here because their input graph is
  -- assessed by the commercial availability resolver instead.
  for v_row in
    with flow_events as (
      select
        flow.inventory_item_id,
        flow.effective_at,
        sum(case
          when flow.flow_type = 'order_commitment' then -flow.quantity_units
          when flow.flow_type in ('expected_receipt', 'planned_production') then flow.quantity_units
          else 0
        end) as delta_units
      from public.inventory_planned_flows flow
      join public.inventory_items item on item.id = flow.inventory_item_id
      where flow.effective_at between v_started_at and v_started_at + interval '10 days'
        and item.is_active
        and item.availability_mode is distinct from 'immediate_recipe'
        and app_private.inventory_item_is_initialized_v1(item.id)
        and (
          (flow.flow_type = 'order_commitment' and flow.status in ('draft', 'active'))
          or (flow.flow_type in ('expected_receipt', 'planned_production') and flow.status = 'active')
        )
      group by flow.inventory_item_id, flow.effective_at
    ), running as (
      select
        event.inventory_item_id,
        event.effective_at,
        item.current_stock_units + sum(event.delta_units) over (
          partition by event.inventory_item_id
          order by event.effective_at
          rows between unbounded preceding and current row
        ) as projected_balance
      from flow_events event
      join public.inventory_items item on item.id = event.inventory_item_id
    )
    select
      item.id as inventory_item_id,
      item.name as item_name,
      min(running.projected_balance) as minimum_balance,
      (array_agg(running.effective_at order by running.projected_balance, running.effective_at))[1]
        as minimum_at
    from running
    join public.inventory_items item on item.id = running.inventory_item_id
    group by item.id
    having min(running.projected_balance) < 0
  loop
    v_alert_id := app_private.inventory_upsert_alert_candidate_v1(
      v_started_at,
      format('commitment:shortage:item:%s', v_row.inventory_item_id),
      'commitment',
      'commitment_shortage',
      'critical',
      true,
      v_row.inventory_item_id,
      null,
      null,
      null,
      format('Compromisos en riesgo: %s', v_row.item_name),
      format(
        'La proyección llega a un déficit de %s unidades alrededor del %s.',
        trim(to_char(abs(v_row.minimum_balance), 'FM999999990.##')),
        to_char(v_row.minimum_at at time zone 'America/Caracas', 'DD/MM/YYYY HH24:MI')
      ),
      jsonb_build_object(
        'minimum_projected_balance', v_row.minimum_balance,
        'minimum_projected_at', v_row.minimum_at,
        'horizon_days', 10
      )
    );
    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  -- Order-linked engine incidents remain auditable on the order, but their
  -- actionable lifecycle belongs only to the Inventory Alert Center.
  for v_row in
    select event.*
    from public.order_timeline_events event
    where event.event_group = 'inventory'
  loop
    select alert.id
    into v_alert_id
    from public.inventory_alerts alert
    where alert.order_timeline_event_id = v_row.id;

    if not found then
      insert into public.inventory_alerts (
        alert_key,
        alert_category,
        alert_type,
        severity,
        requires_action,
        status,
        order_id,
        order_timeline_event_id,
        title,
        message,
        details,
        first_detected_at,
        last_detected_at,
        created_at,
        updated_at
      )
      select
        format('system:order-timeline:%s', v_row.id),
        'system',
        v_row.event_type,
        case when v_row.severity in ('info', 'warning', 'critical') then v_row.severity else 'warning' end,
        true,
        'open',
        v_row.order_id,
        v_row.id,
        v_row.title,
        v_row.message,
        coalesce(v_row.payload, '{}'::jsonb)
          || jsonb_build_object('detection_source', 'order_timeline'),
        v_row.created_at,
        v_started_at,
        v_started_at,
        v_started_at
      where exists (
        select 1
        from app_private.inventory_effective_alert_policy_v1('system', null) policy
        where policy.is_enabled
      )
      returning id into v_alert_id;
    elsif exists (
      select 1 from public.inventory_alerts alert
      where alert.id = v_alert_id and alert.status in ('open', 'managed')
    ) then
      update public.inventory_alerts
      set last_detected_at = v_started_at,
          updated_at = v_started_at
      where id = v_alert_id;
    end if;

    if v_alert_id is not null then
      v_opened_or_updated := v_opened_or_updated + 1;
    end if;
  end loop;

  update public.inventory_alerts alert
  set status = 'resolved',
      resolved_by_user_id = v_actor,
      resolved_at = v_started_at,
      updated_at = v_started_at,
      details = alert.details || jsonb_build_object(
        'resolution_source', 'automatic',
        'resolved_reason', 'condition_cleared'
      )
  where alert.status in ('open', 'managed')
    and alert.details ->> 'detection_source' = 'inventory_reconciler'
    and alert.last_detected_at < v_started_at;
  get diagnostics v_resolved = row_count;

  return jsonb_build_object(
    'detected_or_updated', v_opened_or_updated,
    'automatically_resolved', v_resolved,
    'refreshed_at', v_started_at
  );
end;
$$;

revoke all on function app_private.inventory_refresh_alerts_core_v1()
  from public, anon, authenticated, service_role;

create or replace function public.inventory_refresh_alerts_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'No autenticado.' using errcode = '42501';
  end if;
  if not (
    public.has_role('admin')
    or public.has_role('master')
    or public.has_role('kitchen')
  ) then
    raise exception 'No autorizado para actualizar alertas de inventario.'
      using errcode = '42501';
  end if;

  return app_private.inventory_refresh_alerts_core_v1();
end;
$$;

revoke all on function public.inventory_refresh_alerts_v1()
  from public, anon;
grant execute on function public.inventory_refresh_alerts_v1()
  to authenticated, service_role;

comment on function app_private.inventory_effective_capacity_v1(bigint, timestamptz, bigint[]) is
  'Projected capacity protected against commitments, recursively including immediate recipes.';
comment on function app_private.inventory_refresh_alerts_core_v1() is
  'Reconciles canonical inventory conditions into deduplicated alert episodes.';
comment on function public.inventory_refresh_alerts_v1() is
  'Authorized manual/time-based refresh used by the Inventory Alert Center and future lightweight adapters.';
