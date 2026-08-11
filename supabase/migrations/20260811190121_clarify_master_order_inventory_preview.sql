-- Clarify the existing Master order inventory preview without adding tables
-- or columns. The RPC now returns the physical unit for every resolved item,
-- the total protected commitments inside the ten-day horizon, and the exact
-- time at which the preview was calculated.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.inventory_preview_order_commitment_v1(
  p_order_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_order record;
  v_resolution jsonb;
  v_calculated_at timestamptz := now();
  v_horizon_days integer := 10;
  v_horizon_end timestamptz := v_calculated_at + interval '10 days';
  v_effective_at timestamptz;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_capacity jsonb;
  v_inventory_item_id bigint;
  v_unit_name text;
  v_requested numeric;
  v_available numeric;
  v_without_incoming numeric;
  v_committed_horizon numeric;
  v_decision text := 'available';
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  select order_row.id, order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) and not (
    v_order.attributed_advisor_id = v_actor
    and exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role = 'advisor'::public.user_role
    )
  ) then
    raise exception 'No tienes permiso para evaluar el compromiso de esta orden.'
      using errcode = '42501';
  end if;

  v_resolution := app_private.inventory_resolve_order_sale_v1(p_order_id);
  v_effective_at := app_private.inventory_order_effective_at_v1(p_order_id);

  for v_line in
    select line.value
    from jsonb_array_elements(v_resolution -> 'lines') line(value)
    order by (line.value ->> 'inventory_item_id')::bigint
  loop
    v_inventory_item_id := (v_line ->> 'inventory_item_id')::bigint;
    v_requested := (v_line ->> 'quantity_units')::numeric;
    v_capacity := app_private.inventory_item_capacity_v1(
      v_inventory_item_id,
      v_effective_at,
      p_order_id
    );
    v_available := nullif(v_capacity ->> 'available_without_affecting_commitments', '')::numeric;
    v_without_incoming := nullif(v_capacity ->> 'available_without_incoming', '')::numeric;

    select
      item.unit_name,
      coalesce(sum(flow.quantity_units), 0)
    into v_unit_name, v_committed_horizon
    from public.inventory_items item
    left join public.inventory_planned_flows flow
      on flow.inventory_item_id = item.id
     and flow.flow_type = 'order_commitment'
     and flow.status in ('draft', 'active')
     and flow.effective_at is not null
     and flow.effective_at <= v_horizon_end
     and flow.order_id is distinct from p_order_id
    where item.id = v_inventory_item_id
    group by item.unit_name;

    if v_capacity ->> 'status' = 'outside_horizon' then
      v_decision := case when v_decision = 'available' then 'outside_horizon' else v_decision end;
    elsif v_capacity ->> 'status' = 'requires_opening' then
      v_decision := 'requires_opening';
    elsif v_available < v_requested then
      v_decision := 'insufficient';
    elsif v_decision not in ('insufficient', 'requires_opening')
      and v_without_incoming < v_requested
    then
      v_decision := 'relies_on_incoming';
    end if;

    v_lines := v_lines || jsonb_build_array(
      v_line || v_capacity || jsonb_build_object(
        'unit_name', coalesce(v_unit_name, 'unidad'),
        'requested_quantity_units', v_requested,
        'shortage_quantity_units', case
          when v_available is null then null
          else greatest(v_requested - v_available, 0)
        end,
        'committed_through_horizon', coalesce(v_committed_horizon, 0),
        'relies_on_incoming', case
          when v_available is null or v_without_incoming is null then false
          else v_without_incoming < v_requested and v_available >= v_requested
        end
      )
    );
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    v_decision := 'no_inventory_effect';
  end if;

  return jsonb_build_object(
    'status', 'previewed',
    'decision', v_decision,
    'order_id', p_order_id,
    'calculated_at', v_calculated_at,
    'effective_at', v_effective_at,
    'horizon_days', v_horizon_days,
    'horizon_ends_at', v_horizon_end,
    'lines', v_lines
  );
end;
$$;

revoke all on function public.inventory_preview_order_commitment_v1(bigint)
  from public, anon;
grant execute on function public.inventory_preview_order_commitment_v1(bigint)
  to authenticated;

comment on function public.inventory_preview_order_commitment_v1(bigint) is
  'Current dated order inventory preview with explicit physical units, calculation time, and protected commitments inside the ten-day horizon; never blocks the order flow.';
