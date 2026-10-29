CREATE OR REPLACE FUNCTION app_private.inventory_materialize_order_commitment_v1(p_order_id bigint, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_order record;
  v_actor uuid;
  v_effective_at timestamptz;
  v_flow_status text;
  v_resolution jsonb;
  v_inserted integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory_order_commitment:' || p_order_id::text, 0)
  );

  select
    order_row.id,
    order_row.status::text as status,
    order_row.needs_reapproval,
    order_row.queued_needs_reapproval
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  if v_order.status not in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery') then
    raise exception 'La orden % no está aprobada para comprometer inventario.', p_order_id
      using errcode = '22023';
  end if;

  if coalesce(v_order.needs_reapproval, false)
    or coalesce(v_order.queued_needs_reapproval, false)
  then
    raise exception 'La orden % requiere aprobación antes de renovar su compromiso.', p_order_id
      using errcode = '22023';
  end if;

  v_actor := app_private.inventory_resolve_commitment_actor_v1(p_order_id, p_actor);
  if v_actor is null then
    raise exception 'No se pudo identificar al responsable del compromiso.';
  end if;

  v_effective_at := app_private.inventory_order_effective_at_v1(p_order_id);
  v_flow_status := case
    when v_effective_at <= now() + interval '10 days' then 'active'
    else 'draft'
  end;
  v_resolution := app_private.inventory_resolve_order_sale_v1(p_order_id);

  perform app_private.inventory_close_order_commitments_v1(
    p_order_id,
    'cancelled',
    v_actor
  );

  insert into public.inventory_planned_flows (
    inventory_item_id,
    flow_type,
    quantity_units,
    effective_at,
    status,
    order_id,
    inventory_recipe_id,
    depends_on_flow_id,
    notes,
    created_by_user_id
  )
  select
    (line.value ->> 'inventory_item_id')::bigint,
    'order_commitment',
    (line.value ->> 'quantity_units')::numeric,
    v_effective_at,
    v_flow_status,
    p_order_id,
    null,
    null,
    'canonical_order_commitment_v1',
    v_actor
  from jsonb_array_elements(v_resolution -> 'lines') line(value)
  where (line.value ->> 'quantity_units')::numeric > 0
  order by (line.value ->> 'inventory_item_id')::bigint;

  get diagnostics v_inserted = row_count;

  return jsonb_build_object(
    'status', 'materialized',
    'order_id', p_order_id,
    'effective_at', v_effective_at,
    'flow_status', v_flow_status,
    'line_count', v_inserted,
    'configuration_version', 1
  );
end;
$function$

