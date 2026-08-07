-- Block 5: resolve an order into physical inventory quantities and expose an
-- atomic sale command. This is deliberately not connected to any UI/domain.

set lock_timeout = '5s';
set statement_timeout = '60s';

-- Reuse the existing order component snapshot table. It is currently empty,
-- so these invariants can be added without rewriting historical rows.
alter table public.order_item_components
  add constraint order_item_components_qty_positive_check
  check (qty > 0) not valid;

alter table public.order_item_components
  validate constraint order_item_components_qty_positive_check;

create unique index order_item_components_order_product_uidx
  on public.order_item_components (order_item_id, component_product_id);

-- The duplicate tasting product retained by the user is physically eight raw
-- pieces. Its visual prefried composition must not drive inventory deduction.
update public.products
set
  inventory_policy = 'direct',
  inventory_configuration_status = 'ready',
  allows_half_service = false
where id = 164
  and sku = 'DEGUSTPF_8';

-- This promotional Dondy is the same six-piece service. Historical half
-- services confirm the already-defined business rule: six becomes three.
update public.products
set allows_half_service = true
where id = 129
  and sku = 'BIRTHDAY_DONDY3'
  and units_per_service = 6;

insert into public.product_inventory_links (
  product_id,
  inventory_item_id,
  deduction_mode,
  quantity_units,
  sort_order,
  notes,
  is_active,
  configuration_version,
  deduction_stage
)
select
  legacy.product_id,
  coalesce(legacy_item.merged_into_item_id, legacy.inventory_item_id),
  legacy.deduction_mode,
  legacy.quantity_units,
  legacy.sort_order,
  concat_ws(
    ' ',
    nullif(btrim(legacy.notes), ''),
    'Configuración canónica v1: ocho piezas crudas; no consume servicios prefritos.'
  ),
  false,
  1,
  'kitchen'
from public.product_inventory_links legacy
join public.inventory_items legacy_item on legacy_item.id = legacy.inventory_item_id
where legacy.product_id = 164
  and legacy.configuration_version = 0
  and legacy.is_active
on conflict (product_id, inventory_item_id, configuration_version) do nothing;

do $$
begin
  if not exists (
    select 1
    from public.products product
    where product.id = 164
      and product.sku = 'DEGUSTPF_8'
      and product.inventory_policy = 'direct'
      and product.inventory_configuration_status = 'ready'
  ) then
    raise exception 'Block 5 stopped: tasting product 164 is missing or no longer matches the audited catalog.';
  end if;

  if not exists (
    select 1
    from public.products product
    where product.id = 129
      and product.sku = 'BIRTHDAY_DONDY3'
      and product.units_per_service = 6
      and product.allows_half_service
  ) then
    raise exception 'Block 5 stopped: promotional Dondy 129 must retain its six-to-three half-service rule.';
  end if;

  if (
    select count(*)
    from public.product_inventory_links link
    where link.product_id = 164
      and link.configuration_version = 1
  ) <> 5
  or (
    select sum(link.quantity_units)
    from public.product_inventory_links link
    where link.product_id = 164
      and link.configuration_version = 1
  ) <> 8 then
    raise exception 'Block 5 stopped: tasting product 164 must resolve to five raw items and eight pieces.';
  end if;
end
$$;

-- Diagnostic form: always returns structured errors instead of raising. It is
-- private so raw order/configuration data cannot bypass the public role check.
create or replace function app_private.inventory_order_sale_diagnostics_v1(
  p_order_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with recursive
order_header as (
  select order_row.id, order_row.order_number, order_row.status::text as status
  from public.orders order_row
  where order_row.id = p_order_id
),
roots as (
  select
    order_item.id as order_item_id,
    order_item.product_id,
    order_item.qty,
    order_item.notes,
    product.name as product_name,
    product.inventory_policy,
    product.inventory_configuration_status,
    product.allows_half_service,
    product.detail_units_limit,
    product.is_detail_editable
  from public.order_items order_item
  join public.products product on product.id = order_item.product_id
  where order_item.order_id = p_order_id
),
snapshot_order_items as (
  select distinct snapshot.order_item_id
  from public.order_item_components snapshot
  join roots root on root.order_item_id = snapshot.order_item_id
),
snapshot_selections as (
  select
    snapshot.order_item_id,
    root.product_id as parent_product_id,
    snapshot.component_product_id,
    sum(snapshot.qty) as quantity,
    'order_item_components'::text as selection_source
  from public.order_item_components snapshot
  join roots root on root.order_item_id = snapshot.order_item_id
  group by snapshot.order_item_id, root.product_id, snapshot.component_product_id
),
marker_lines as (
  select
    root.order_item_id,
    root.product_id as parent_product_id,
    btrim(split_line.line) as marker
  from roots root
  cross join lateral pg_catalog.regexp_split_to_table(
    coalesce(root.notes, ''),
    E'\\r?\\n'
  ) as split_line(line)
  where btrim(split_line.line) like '@sel|%'
),
valid_note_selections as (
  select
    marker.order_item_id,
    marker.parent_product_id,
    pg_catalog.split_part(marker.marker, '|', 2)::bigint as component_product_id,
    sum(pg_catalog.split_part(marker.marker, '|', 3)::numeric) as quantity,
    'notes_marker'::text as selection_source
  from marker_lines marker
  where marker.marker ~ E'^@sel\\|[1-9][0-9]*\\|[0-9]+(\\.[0-9]+)?$'
  group by
    marker.order_item_id,
    marker.parent_product_id,
    pg_catalog.split_part(marker.marker, '|', 2)::bigint
),
effective_selections as (
  select * from snapshot_selections
  union all
  select note_selection.*
  from valid_note_selections note_selection
  where not exists (
    select 1
    from snapshot_order_items snapshot_item
    where snapshot_item.order_item_id = note_selection.order_item_id
  )
),
nodes (
  source_order_item_id,
  root_product_id,
  root_quantity,
  product_id,
  quantity,
  depth,
  product_path,
  has_cycle,
  parent_product_id,
  component_mode,
  counts_toward_detail_limit,
  is_required
) as (
  select
    root.order_item_id,
    root.product_id,
    root.qty::numeric,
    root.product_id,
    root.qty::numeric,
    0,
    array[root.product_id]::bigint[],
    false,
    null::bigint,
    null::public.product_component_mode,
    null::boolean,
    null::boolean
  from roots root

  union all

  select
    node.source_order_item_id,
    node.root_product_id,
    node.root_quantity,
    component.component_product_id,
    (case
      when component.component_mode = 'fixed'::public.product_component_mode
        and component.is_required
      then coalesce(selection.quantity, node.quantity * component.quantity)
      else selection.quantity
    end)::numeric,
    node.depth + 1,
    node.product_path || component.component_product_id,
    component.component_product_id = any(node.product_path),
    component.parent_product_id,
    component.component_mode,
    component.counts_toward_detail_limit,
    component.is_required
  from nodes node
  join public.products parent_product on parent_product.id = node.product_id
  join public.product_components component
    on component.parent_product_id = node.product_id
  left join effective_selections selection
    on selection.order_item_id = node.source_order_item_id
   and selection.parent_product_id = node.product_id
   and selection.component_product_id = component.component_product_id
  where parent_product.inventory_policy = 'components'
    and not node.has_cycle
    and node.depth < 16
    and (
      (
        component.component_mode = 'fixed'::public.product_component_mode
        and component.is_required
      )
      or selection.quantity is not null
    )
),
component_totals as (
  select
    node.source_order_item_id,
    coalesce(sum(node.quantity) filter (
      where node.depth = 1 and node.counts_toward_detail_limit
    ), 0) as counted_quantity
  from nodes node
  group by node.source_order_item_id
),
leaf_contributions as (
  select
    node.source_order_item_id,
    node.root_product_id,
    node.product_id as leaf_product_id,
    link.inventory_item_id,
    case
      when node.depth = 0 then
        pg_catalog.trunc(node.quantity) * link.quantity_units
        + case
            when node.quantity - pg_catalog.trunc(node.quantity) = 0.5
            then pg_catalog.floor(link.quantity_units / 2)
            else 0
          end
      else
        node.quantity
        * case
            when product.units_per_service > 0
            then link.quantity_units / product.units_per_service
            else link.quantity_units
          end
    end as quantity_units
  from nodes node
  join public.products product on product.id = node.product_id
  join public.product_inventory_links link
    on link.product_id = node.product_id
   and link.configuration_version = 1
  where product.inventory_policy in ('self', 'direct')
    and not node.has_cycle
),
resolved_lines as (
  select
    contribution.inventory_item_id,
    inventory_item.name as inventory_item_name,
    sum(contribution.quantity_units) as quantity_units,
    jsonb_agg(
      jsonb_build_object(
        'order_item_id', contribution.source_order_item_id,
        'root_product_id', contribution.root_product_id,
        'leaf_product_id', contribution.leaf_product_id,
        'quantity_units', contribution.quantity_units
      )
      order by contribution.source_order_item_id, contribution.leaf_product_id
    ) as sources
  from leaf_contributions contribution
  join public.inventory_items inventory_item
    on inventory_item.id = contribution.inventory_item_id
  where contribution.quantity_units > 0
  group by contribution.inventory_item_id, inventory_item.name
),
errors as (
  select
    'order_not_found'::text as code,
    format('La orden %s no existe.', p_order_id) as message,
    null::bigint as order_item_id,
    null::bigint as product_id
  where not exists (select 1 from order_header)

  union all

  select
    'order_without_items',
    'La orden no contiene productos.',
    null::bigint,
    null::bigint
  where exists (select 1 from order_header)
    and not exists (select 1 from roots)

  union all

  select
    'invalid_order_quantity',
    format('La cantidad %s de %s no es válida para inventario.', root.qty, root.product_name),
    root.order_item_id,
    root.product_id
  from roots root
  where root.qty <= 0
     or root.qty - pg_catalog.trunc(root.qty) not in (0, 0.5)
     or (
       root.qty - pg_catalog.trunc(root.qty) = 0.5
       and not root.allows_half_service
     )

  union all

  select
    'malformed_selection_marker',
    format('La selección estructurada "%s" no tiene un formato válido.', marker.marker),
    marker.order_item_id,
    marker.parent_product_id
  from marker_lines marker
  where not exists (
    select 1 from snapshot_order_items snapshot_item
    where snapshot_item.order_item_id = marker.order_item_id
  )
    and marker.marker !~ E'^@sel\\|[1-9][0-9]*\\|[0-9]+(\\.[0-9]+)?$'

  union all

  select
    'invalid_selection_quantity',
    'Las cantidades seleccionadas deben ser mayores que cero.',
    selection.order_item_id,
    selection.parent_product_id
  from effective_selections selection
  where selection.quantity <= 0

  union all

  select
    'selection_not_allowed',
    format(
      'El producto %s no admite el componente seleccionado %s.',
      selection.parent_product_id,
      selection.component_product_id
    ),
    selection.order_item_id,
    selection.parent_product_id
  from effective_selections selection
  where not exists (
    select 1
    from public.product_components component
    where component.parent_product_id = selection.parent_product_id
      and component.component_product_id = selection.component_product_id
  )

  union all

  select
    'fixed_component_mismatch',
    format(
      'El componente fijo %s debe tener cantidad %s y recibió %s.',
      component.component_product_id,
      root.qty * component.quantity,
      selection.quantity
    ),
    root.order_item_id,
    root.product_id
  from roots root
  join public.product_components component
    on component.parent_product_id = root.product_id
   and component.component_mode = 'fixed'::public.product_component_mode
   and component.is_required
  join effective_selections selection
    on selection.order_item_id = root.order_item_id
   and selection.parent_product_id = root.product_id
   and selection.component_product_id = component.component_product_id
  where selection.quantity <> root.qty * component.quantity

  union all

  select
    'optional_component_excess',
    format(
      'El componente opcional %s supera el máximo %s.',
      component.component_product_id,
      root.qty * component.quantity
    ),
    root.order_item_id,
    root.product_id
  from roots root
  join public.product_components component
    on component.parent_product_id = root.product_id
   and component.component_mode = 'fixed'::public.product_component_mode
   and not component.is_required
  join effective_selections selection
    on selection.order_item_id = root.order_item_id
   and selection.parent_product_id = root.product_id
   and selection.component_product_id = component.component_product_id
  where selection.quantity > root.qty * component.quantity

  union all

  select
    'detail_quantity_mismatch',
    format(
      '%s exige %s piezas de detalle y la orden contiene %s.',
      root.product_name,
      root.qty * root.detail_units_limit,
      total.counted_quantity
    ),
    root.order_item_id,
    root.product_id
  from roots root
  join component_totals total on total.source_order_item_id = root.order_item_id
  where root.inventory_policy = 'components'
    and root.is_detail_editable
    and root.detail_units_limit > 0
    and total.counted_quantity <> root.qty * root.detail_units_limit

  union all

  select
    'open_detail_without_selection',
    format('%s necesita al menos una pieza seleccionada.', root.product_name),
    root.order_item_id,
    root.product_id
  from roots root
  join component_totals total on total.source_order_item_id = root.order_item_id
  where root.inventory_policy = 'components'
    and root.detail_units_limit = 0
    and root.is_detail_editable
    and total.counted_quantity <= 0
    and exists (
      select 1
      from public.product_components component
      where component.parent_product_id = root.product_id
        and component.component_mode = 'selectable'::public.product_component_mode
    )

  union all

  select distinct
    'product_not_ready',
    format(
      'El producto %s no tiene una configuración canónica lista.',
      product.name
    ),
    node.source_order_item_id,
    node.product_id
  from nodes node
  join public.products product on product.id = node.product_id
  where product.inventory_configuration_status <> 'ready'
     or product.inventory_policy is null

  union all

  select distinct
    'component_cycle',
    format('La composición del producto %s contiene un ciclo.', node.root_product_id),
    node.source_order_item_id,
    node.product_id
  from nodes node
  where node.has_cycle

  union all

  select distinct
    'component_depth_exceeded',
    format('La composición del producto %s supera 16 niveles.', node.root_product_id),
    node.source_order_item_id,
    node.product_id
  from nodes node
  join public.products product on product.id = node.product_id
  where node.depth = 16
    and product.inventory_policy = 'components'

  union all

  select distinct
    'component_without_resolution',
    format('El producto compuesto %s no produjo ningún componente válido.', product.name),
    node.source_order_item_id,
    node.product_id
  from nodes node
  join public.products product on product.id = node.product_id
  where product.inventory_policy = 'components'
    and not node.has_cycle
    and not exists (
      select 1
      from nodes child
      where child.source_order_item_id = node.source_order_item_id
        and child.parent_product_id = node.product_id
        and child.depth = node.depth + 1
    )

  union all

  select distinct
    'inventory_link_missing',
    format('El producto físico %s no tiene vínculo canónico v1.', product.name),
    node.source_order_item_id,
    node.product_id
  from nodes node
  join public.products product on product.id = node.product_id
  where product.inventory_policy in ('self', 'direct')
    and not node.has_cycle
    and not exists (
      select 1
      from public.product_inventory_links link
      where link.product_id = node.product_id
        and link.configuration_version = 1
    )
),
error_payload as (
  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'code', error_row.code,
          'message', error_row.message,
          'order_item_id', error_row.order_item_id,
          'product_id', error_row.product_id
        )
      )
      order by error_row.order_item_id nulls first, error_row.code
    ),
    '[]'::jsonb
  ) as value
  from errors error_row
),
line_payload as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'inventory_item_id', line.inventory_item_id,
        'inventory_item_name', line.inventory_item_name,
        'quantity_units', line.quantity_units,
        'sources', line.sources
      )
      order by line.inventory_item_id
    ),
    '[]'::jsonb
  ) as value
  from resolved_lines line
),
selection_payload as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'order_item_id', selection.order_item_id,
        'component_product_id', selection.component_product_id,
        'quantity', selection.quantity,
        'source', selection.selection_source
      )
      order by selection.order_item_id, selection.component_product_id
    ),
    '[]'::jsonb
  ) as value
  from effective_selections selection
)
select jsonb_build_object(
  'order_id', p_order_id,
  'order_number', (select header.order_number from order_header header),
  'order_status', (select header.status from order_header header),
  'configuration_version', 1,
  'errors', error_payload.value,
  'lines', line_payload.value,
  'selection_sources', selection_payload.value
)
from error_payload, line_payload, selection_payload;
$$;

revoke all on function app_private.inventory_order_sale_diagnostics_v1(bigint)
  from public, anon, authenticated;

create or replace function app_private.inventory_resolve_order_sale_v1(
  p_order_id bigint
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_diagnostics jsonb;
  v_first_error jsonb;
begin
  v_diagnostics := app_private.inventory_order_sale_diagnostics_v1(p_order_id);

  if jsonb_array_length(v_diagnostics -> 'errors') > 0 then
    v_first_error := v_diagnostics -> 'errors' -> 0;
    raise exception '[%] %',
      v_first_error ->> 'code',
      v_first_error ->> 'message'
      using errcode = '22023', detail = (v_diagnostics -> 'errors')::text;
  end if;

  return (v_diagnostics - 'errors') || jsonb_build_object('status', 'resolved');
end;
$$;

revoke all on function app_private.inventory_resolve_order_sale_v1(bigint)
  from public, anon, authenticated;

create or replace function public.inventory_preview_order_sale_v1(
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
    raise exception 'Solo administración o máster pueden previsualizar el consumo de una orden.'
      using errcode = '42501';
  end if;

  return app_private.inventory_resolve_order_sale_v1(p_order_id);
end;
$$;

revoke all on function public.inventory_preview_order_sale_v1(bigint)
  from public, anon;
grant execute on function public.inventory_preview_order_sale_v1(bigint)
  to authenticated;

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
  v_status text;
  v_resolution jsonb;
  v_item_ids bigint[];
  v_line record;
  v_existing_operation uuid;
  v_shortage text;
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
    raise exception 'Solo administración o máster pueden confirmar el consumo de una venta.'
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

  select order_row.status::text
  into v_status
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
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

comment on function public.inventory_preview_order_sale_v1(bigint) is
  'Block 5 canonical preview: resolves an order into exact physical inventory lines without writing stock.';
comment on function public.inventory_commit_order_sale_v1(uuid, bigint, text) is
  'Block 5 atomic sale command. Not connected to operational modules until the explicit cutover block.';
