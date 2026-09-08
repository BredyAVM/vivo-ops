-- PostgreSQL preserves the declared numeric scale when a numeric value is cast
-- directly to text. Counter's direct-sale helper therefore stored component
-- labels such as "10.000" even though the operational quantity was 10.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $migration$
declare
  v_definition text;
  v_rewritten text;
  v_configurable_label text :=
    'v_component_qty::text || '' '' || v_component.component_name';
  v_configurable_metadata text :=
    '''@sel|'' || v_component.component_product_id::text || ''|'' || v_component_qty::text';
  v_fixed_label text :=
    '(v_component.quantity * p_qty)::text || '' '' || v_component.component_name';
begin
  select pg_catalog.pg_get_functiondef(
    'public.counter_direct_sale_item_notes(bigint,numeric,text,jsonb)'::regprocedure
  )
  into v_definition;

  if pg_catalog.strpos(v_definition, v_configurable_label) = 0
     or pg_catalog.strpos(v_definition, v_configurable_metadata) = 0
     or pg_catalog.strpos(v_definition, v_fixed_label) = 0 then
    raise exception 'counter_direct_sale_item_notes has an unexpected definition';
  end if;

  v_rewritten := pg_catalog.replace(
    v_definition,
    v_configurable_label,
    'pg_catalog.trim_scale(v_component_qty)::text || '' '' || v_component.component_name'
  );
  v_rewritten := pg_catalog.replace(
    v_rewritten,
    v_configurable_metadata,
    '''@sel|'' || v_component.component_product_id::text || ''|'' || pg_catalog.trim_scale(v_component_qty)::text'
  );
  v_rewritten := pg_catalog.replace(
    v_rewritten,
    v_fixed_label,
    'pg_catalog.trim_scale(v_component.quantity * p_qty)::text || '' '' || v_component.component_name'
  );

  execute v_rewritten;
end;
$migration$;

comment on function public.counter_direct_sale_item_notes(bigint, numeric, text, jsonb)
is 'Valida y genera el detalle de productos de venta directa. Las cantidades se escriben sin ceros decimales de almacenamiento.';

-- Repair only system-generated Counter sales. The pattern is anchored to the
-- beginning of each detail line and does not touch prices or free-form text in
-- orders from other channels.
update public.order_items item
set notes = pg_catalog.regexp_replace(
  item.notes,
  '(^|' || chr(10) || ')([0-9]+)\.000 ',
  '\1\2 ',
  'g'
)
from public.orders order_row
where order_row.id = item.order_id
  and coalesce(
    (order_row.extra_fields->'counter'->>'quick_sale')::boolean,
    false
  ) = true
  and item.notes ~ ('(^|' || chr(10) || ')[0-9]+\.000 ');

revoke all on function public.counter_direct_sale_item_notes(bigint, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.counter_direct_sale_item_notes(bigint, numeric, text, jsonb)
  to service_role;

commit;
