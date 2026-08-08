-- Bloque 14: ejecutar manualmente en Supabase SQL Editor.
-- Las mutaciones de prueba se revierten al finalizar.

begin;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (
      select user_id::text
      from public.user_roles
      where role = 'admin'
      order by user_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);
set local role authenticated;

do $$
declare
  v_workspace jsonb;
  v_expected_items integer;
  v_reported_items integer;
  v_item_id bigint;
  v_opening_operation uuid := gen_random_uuid();
  v_receipt_operation uuid := gen_random_uuid();
  v_loss_operation uuid := gen_random_uuid();
  v_page jsonb;
  v_newest jsonb;
begin
  v_workspace := public.inventory_reporting_workspace_v1(10);

  select count(*)
  into v_expected_items
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count');

  v_reported_items := (v_workspace #>> '{summary,tracked_items}')::integer;
  if v_reported_items <> v_expected_items then
    raise exception 'Expected % tracked items, report returned %',
      v_expected_items, v_reported_items;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_workspace -> 'items') row_value
    where not (row_value ->> 'initialized')::boolean
      and (
        row_value -> 'stock_units' <> 'null'::jsonb
        or row_value -> 'projected_available_units' <> 'null'::jsonb
      )
  ) then
    raise exception 'A pending opening exposed a legacy balance.';
  end if;

  select item.id
  into v_item_id
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
    and not exists (
      select 1
      from public.inventory_movements opening
      where opening.inventory_item_id = item.id
        and opening.operation_id is not null
        and opening.reason_code = 'opening_balance'
        and not exists (
          select 1
          from public.inventory_movements reversal
          where reversal.reversal_of_movement_id = opening.id
        )
    )
  order by item.id
  limit 1;

  if v_item_id is null then
    raise notice 'All eligible items already have an opening; mutation test skipped.';
    return;
  end if;

  perform public.inventory_submit_count_v1(
    v_opening_operation,
    'opening',
    jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_item_id,
      'counted_quantity_units', 5
    )),
    'Bloque 14: apertura transaccional'
  );

  perform public.inventory_receive_stock_v1(
    v_receipt_operation,
    v_item_id,
    3,
    'inbound',
    'reporting_test_receipt',
    'Bloque 14: entrada transaccional'
  );

  perform public.inventory_record_loss_v1(
    v_loss_operation,
    v_item_id,
    'damage',
    1,
    'reporting_test_damage',
    'Bloque 14: avería transaccional'
  );

  v_page := public.inventory_kardex_page_v1(v_item_id, null, null, 2);
  if jsonb_array_length(v_page -> 'items') <> 2 then
    raise exception 'Expected two rows on the first kardex page.';
  end if;

  v_newest := v_page -> 'items' -> 0;
  if (v_newest ->> 'balance_before_units')::numeric <> 8
    or (v_newest ->> 'balance_after_units')::numeric <> 7
  then
    raise exception 'Unexpected kardex balances: %', v_newest;
  end if;

  if v_page -> 'next_cursor' = 'null'::jsonb then
    raise exception 'Expected a cursor for the remaining opening movement.';
  end if;
end;
$$;

rollback;
