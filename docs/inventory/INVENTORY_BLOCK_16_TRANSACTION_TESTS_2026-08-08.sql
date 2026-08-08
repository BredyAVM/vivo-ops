-- Block 16: reversible verification of the cutover readiness audit.
-- The installed RPC is read-only; this transaction proves it does not mutate
-- inventory, orders, counts, flows, alerts, recipes, or product configuration.

begin;

do $$
declare
  v_admin uuid;
  v_master uuid;
  v_advisor uuid;
  v_payload jsonb;
  v_before jsonb;
  v_after jsonb;
  v_denied boolean := false;
begin
  select user_id into v_admin
  from public.user_roles
  where role = 'admin'::public.user_role
  order by user_id
  limit 1;

  select user_id into v_master
  from public.user_roles
  where role = 'master'::public.user_role
  order by user_id
  limit 1;

  select user_id into v_advisor
  from public.user_roles
  where role = 'advisor'::public.user_role
  order by user_id
  limit 1;

  if v_admin is null or v_master is null or v_advisor is null then
    raise exception 'Block 16 requires Admin, Master, and Advisor fixtures.';
  end if;

  select jsonb_build_object(
    'items', (select count(*) from public.inventory_items),
    'products', (select count(*) from public.products),
    'links', (select count(*) from public.product_inventory_links),
    'recipes', (select count(*) from public.inventory_recipes),
    'recipe_components', (select count(*) from public.inventory_recipe_components),
    'movements', (select count(*) from public.inventory_movements),
    'counts', (select count(*) from public.inventory_counts),
    'count_lines', (select count(*) from public.inventory_count_lines),
    'flows', (select count(*) from public.inventory_planned_flows),
    'alerts', (select count(*) from public.inventory_alerts),
    'orders', (select count(*) from public.orders),
    'order_items', (select count(*) from public.order_items)
  ) into v_before;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin)::text,
    true
  );
  v_payload := public.inventory_cutover_readiness_v1();

  if v_payload ->> 'read_only' <> 'true'
    or v_payload ->> 'inventory_blocks_orders' <> 'false'
    or v_payload #>> '{safety,performs_writes}' <> 'false'
    or v_payload #>> '{safety,activates_cutover}' <> 'false'
    or v_payload #>> '{safety,blocks_order_submission}' <> 'false'
    or v_payload #>> '{safety,advisor_can_submit}' <> 'true'
    or v_payload #>> '{safety,master_keeps_final_decision}' <> 'true'
  then
    raise exception 'The readiness payload broke the non-blocking safety contract: %.', v_payload;
  end if;

  if jsonb_array_length(coalesce(v_payload -> 'checks', '[]'::jsonb)) <> 12 then
    raise exception 'The readiness audit did not return its twelve canonical checks.';
  end if;

  if not coalesce((v_payload ->> 'structural_ready')::boolean, false) then
    raise exception 'The audited Block 16 baseline has unexpected structural blockers: %.', v_payload;
  end if;

  if coalesce((v_payload ->> 'operational_ready')::boolean, false)
    or v_payload ->> 'cutover_mode' <> 'legacy'
  then
    raise exception 'Block 16 unexpectedly activated the operational cutover.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master)::text,
    true
  );
  perform public.inventory_cutover_readiness_v1();

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor)::text,
    true
  );
  begin
    perform public.inventory_cutover_readiness_v1();
  exception
    when insufficient_privilege then
      v_denied := true;
  end;

  if not v_denied then
    raise exception 'Advisor unexpectedly received cutover-readiness visibility.';
  end if;

  select jsonb_build_object(
    'items', (select count(*) from public.inventory_items),
    'products', (select count(*) from public.products),
    'links', (select count(*) from public.product_inventory_links),
    'recipes', (select count(*) from public.inventory_recipes),
    'recipe_components', (select count(*) from public.inventory_recipe_components),
    'movements', (select count(*) from public.inventory_movements),
    'counts', (select count(*) from public.inventory_counts),
    'count_lines', (select count(*) from public.inventory_count_lines),
    'flows', (select count(*) from public.inventory_planned_flows),
    'alerts', (select count(*) from public.inventory_alerts),
    'orders', (select count(*) from public.orders),
    'order_items', (select count(*) from public.order_items)
  ) into v_after;

  if v_after is distinct from v_before then
    raise exception 'The readiness audit mutated production tables. Before %, after %.', v_before, v_after;
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('public', 'public.inventory_cutover_readiness_v1()', 'execute')
    or has_function_privilege('anon', 'public.inventory_cutover_readiness_v1()', 'execute')
    or not has_function_privilege('authenticated', 'public.inventory_cutover_readiness_v1()', 'execute')
  then
    raise exception 'The readiness RPC grants are not restricted as expected.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure_row.pronamespace
    where namespace.nspname = 'public'
      and procedure_row.proname = 'inventory_cutover_readiness_v1'
      and procedure_row.prosecdef
      and procedure_row.provolatile = 's'
      and exists (
        select 1
        from unnest(procedure_row.proconfig) setting
        where setting = 'search_path=""'
      )
  ) then
    raise exception 'The readiness RPC lost SECURITY DEFINER, STABLE, or its empty search_path.';
  end if;
end;
$$;

rollback;
