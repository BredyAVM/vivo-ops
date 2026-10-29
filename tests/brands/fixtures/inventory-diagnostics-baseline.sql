CREATE OR REPLACE FUNCTION app_private.inventory_order_sale_diagnostics_v1(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
    format('La cantidad %s de %s no es vÃ¡lida para inventario.', root.qty, root.product_name),
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
    format('La selecciÃ³n estructurada "%s" no tiene un formato vÃ¡lido.', marker.marker),
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
      'El componente fijo %s debe tener cantidad %s y recibiÃ³ %s.',
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
      'El componente opcional %s supera el mÃ¡ximo %s.',
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
      'El producto %s no tiene una configuraciÃ³n canÃ³nica lista.',
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
    format('La composiciÃ³n del producto %s contiene un ciclo.', node.root_product_id),
    node.source_order_item_id,
    node.product_id
  from nodes node
  where node.has_cycle

  union all

  select distinct
    'component_depth_exceeded',
    format('La composiciÃ³n del producto %s supera 16 niveles.', node.root_product_id),
    node.source_order_item_id,
    node.product_id
  from nodes node
  join public.products product on product.id = node.product_id
  where node.depth = 16
    and product.inventory_policy = 'components'

  union all

  select distinct
    'component_without_resolution',
    format('El producto compuesto %s no produjo ningÃºn componente vÃ¡lido.', product.name),
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
    format('El producto fÃ­sico %s no tiene vÃ­nculo canÃ³nico v1.', product.name),
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
$function$

