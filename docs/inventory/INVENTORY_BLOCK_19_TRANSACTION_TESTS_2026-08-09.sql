-- Vivo Ops Inventory Block 19: controlled opening and atomic recipe activation.
-- Every opening, recipe activation, and movement is rolled back.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '45s';
set local idle_in_transaction_session_timeout = '30s';

do $$
declare
  v_admin uuid;
  v_master uuid;
  v_advisor uuid;
  v_opening_status jsonb;
  v_opening_lines jsonb;
  v_opening_count_id bigint;
  v_readiness jsonb;
  v_result jsonb;
  v_failed boolean := false;
begin
  select role_row.user_id into v_admin
  from public.user_roles role_row
  where role_row.role = 'admin'
  order by role_row.user_id
  limit 1;

  select role_row.user_id into v_master
  from public.user_roles role_row
  where role_row.role = 'master'
    and not exists (
      select 1 from public.user_roles elevated
      where elevated.user_id = role_row.user_id and elevated.role = 'admin'
    )
  order by role_row.user_id
  limit 1;

  select role_row.user_id into v_advisor
  from public.user_roles role_row
  where role_row.role = 'advisor'
    and not exists (
      select 1 from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role in ('admin', 'master')
    )
  order by role_row.user_id
  limit 1;

  if v_admin is null or v_master is null or v_advisor is null then
    raise exception 'Block 19 requires Admin, Master, and Advisor actors.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_readiness := public.inventory_cutover_readiness_v1();
  if not (v_readiness ->> 'structural_ready')::boolean
    or (v_readiness ->> 'operational_ready')::boolean
    or v_readiness ->> 'cutover_mode' <> 'legacy'
    or (v_readiness #>> '{opening,accepted_count}')::integer <> 0
    or (v_readiness #>> '{opening,eligible_count}')::integer <> 48
    or (v_readiness #>> '{recipes,active_count}')::integer <> 0
    or (v_readiness #>> '{recipes,canonical_count}')::integer <> 13
  then
    raise exception 'Block 19 did not start from the certified 0/48 legacy state: %.', v_readiness;
  end if;

  begin
    perform public.inventory_activate_canonical_recipes_v1();
  exception when others then
    if sqlstate = '22023' then
      v_failed := true;
    else
      raise;
    end if;
  end;
  if not v_failed then
    raise exception 'Recipe batch activation succeeded before the accepted opening.';
  end if;

  v_opening_status := public.inventory_opening_status_v1();
  select jsonb_agg(
    jsonb_build_object(
      'inventory_item_id', source.item_id,
      'counted_quantity_units',
      case source.item_name
        when 'Yukipack Manzana' then 14
        when 'Yukipack Pera' then 14
        when 'Yukipack Durazno' then 22
        else case source.item_id
          when 1 then 1600
          when 2 then 7
          when 3 then 4.125
          when 4 then 7
          when 5 then 425
          when 6 then 750
          when 8 then 10
          when 9 then 10
          when 13 then 450
          when 14 then 8
          when 15 then 10
          when 16 then 3
          when 17 then 2
          when 19 then 525
          when 20 then 18
          when 21 then 10
          when 22 then 3
          when 23 then 5
          when 26 then 8
          when 27 then 29
          when 28 then 4
          when 29 then 9
          when 30 then 15
          when 31 then 9
          when 32 then 5
          when 33 then 7
          when 34 then 5
          when 35 then 4
          when 36 then 20
          when 38 then 16
          when 39 then 13
          when 40 then 2
          when 42 then 1
          when 47 then 125
          when 76 then 6
          when 78 then 0.25
          else 0
        end
      end
    )
    order by source.item_id
  )
  into v_opening_lines
  from (
    select
      (element ->> 'id')::bigint as item_id,
      element ->> 'name' as item_name
    from jsonb_array_elements(v_opening_status -> 'items') element
    where element ->> 'opening_status' = 'pending'
  ) source;

  if jsonb_array_length(v_opening_lines) <> 48
    or not exists (
      select 1
      from jsonb_array_elements(v_opening_lines) line
      where (line ->> 'inventory_item_id')::bigint = 78
        and (line ->> 'counted_quantity_units')::numeric = 0.25
    )
  then
    raise exception 'The certified opening payload is incomplete.';
  end if;

  v_result := public.inventory_submit_count_v1(
    'b1900000-0000-4000-8000-000000000001'::uuid,
    'opening',
    v_opening_lines,
    'Block 19 rollback-only certified opening',
    null,
    null
  );
  v_opening_count_id := (v_result ->> 'inventory_count_id')::bigint;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_review_count_v1(
    v_opening_count_id,
    'accept',
    null,
    'Block 19 rollback-only Master review'
  );

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_result := public.inventory_activate_canonical_recipes_v1();
  if v_result ->> 'status' <> 'applied'
    or (v_result ->> 'activated_recipe_count')::integer <> 13
    or (v_result ->> 'active_recipe_count')::integer <> 13
    or (v_result ->> 'canonical_recipe_count')::integer <> 13
  then
    raise exception 'Atomic canonical recipe activation failed: %.', v_result;
  end if;

  v_result := public.inventory_activate_canonical_recipes_v1();
  if v_result ->> 'status' <> 'replayed'
    or (v_result ->> 'activated_recipe_count')::integer <> 0
  then
    raise exception 'Canonical recipe activation is not idempotent: %.', v_result;
  end if;

  v_readiness := public.inventory_cutover_readiness_v1();
  if not (v_readiness ->> 'structural_ready')::boolean
    or not (v_readiness ->> 'operational_ready')::boolean
    or v_readiness ->> 'cutover_mode' <> 'canonical'
    or (v_readiness ->> 'inventory_blocks_orders')::boolean
    or not (v_readiness #>> '{safety,advisor_can_submit}')::boolean
    or not (v_readiness #>> '{safety,master_keeps_final_decision}')::boolean
  then
    raise exception 'The controlled opening did not reach the safe canonical state: %.', v_readiness;
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );
  v_failed := false;
  begin
    perform public.inventory_activate_canonical_recipes_v1();
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Advisor unexpectedly activated canonical recipes.';
  end if;
end;
$$;

rollback;

select jsonb_build_object(
  'block', 19,
  'result', 'pass',
  'persisted_openings', (
    select count(*) from public.inventory_counts
    where count_kind = 'opening'
  ),
  'active_canonical_recipes', (
    select count(*) from public.inventory_recipes
    where is_active and coalesce(notes, '') like 'Bloque 3:%'
  ),
  'persisted_test_movements', (
    select count(*) from public.inventory_movements
    where operation_id::text like 'b1900000-0000-4000-8000-%'
  )
);

