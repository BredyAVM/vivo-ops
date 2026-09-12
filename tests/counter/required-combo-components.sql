-- Read-only regression: no orders, payments or stock movements are created.
begin;
do $test$
declare
  v_actor uuid;
  v_catalog jsonb;
  v_box record;
  v_dondy bigint;
  v_sauce bigint;
  v_mini bigint;
  v_lines jsonb;
  v_notes text;
  v_count integer := 0;
begin
  select user_id into v_actor from public.user_roles
  where role::text in ('counter', 'admin') order by role::text limit 1;
  if v_actor is null then raise exception 'No Counter/Admin test actor'; end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  v_catalog := public.counter_read_catalog();
  select id into strict v_dondy from public.products where sku = 'GAMBIT_DONDY_1';
  if exists (select 1 from jsonb_array_elements(v_catalog->'products') p where (p->>'id')::bigint = v_dondy) then
    raise exception 'Inactive Dondy must not become a standalone sale';
  end if;
  for v_box in select id, sku, detail_units_limit from public.products
    where sku in ('VIVOBOX_6', 'VIVOBOX_XL_8', 'VIVOBOX_XXL_10') and is_active
  loop
    v_count := v_count + 1;
    if not exists (select 1 from jsonb_array_elements(v_catalog->'components') c
      where (c->>'parentProductId')::bigint = v_box.id
        and (c->>'componentProductId')::bigint = v_dondy
        and c->>'componentMode' = 'fixed' and (c->>'isRequired')::boolean
        and (c->>'quantity')::numeric = 1) then
      raise exception 'Missing required Dondy in %', v_box.sku;
    end if;
    select pc.component_product_id into strict v_sauce
      from public.product_components pc join public.products p on p.id = pc.component_product_id
      where pc.parent_product_id = v_box.id and pc.component_mode = 'fixed'
        and pc.is_required and p.id <> v_dondy;
    select pc.component_product_id into v_mini
      from public.product_components pc where pc.parent_product_id = v_box.id
      and pc.component_mode = 'selectable' order by pc.sort_order limit 1;
    v_lines := jsonb_build_array('@sel|' || v_sauce || '|1', '@sel|' || v_dondy || '|1',
      '@sel|' || v_mini || '|' || v_box.detail_units_limit);
    v_notes := public.counter_direct_sale_item_notes(v_box.id, 1, null, v_lines);
    if strpos(v_notes, '@sel|' || v_dondy || '|1') = 0 or strpos(v_notes, '1 Dondy (1 und)') = 0 then
      raise exception 'Dondy absent from persisted detail in %', v_box.sku;
    end if;
    begin
      perform public.counter_direct_sale_item_notes(v_box.id, 1, null, v_lines - 1);
      raise exception 'Missing required Dondy was accepted';
    exception when others then
      if sqlerrm <> 'counter_item_required_component_missing' then raise; end if;
    end;
    begin
      perform public.counter_direct_sale_item_notes(v_box.id, 1, null,
        jsonb_set(v_lines, '{1}', to_jsonb('@sel|' || v_dondy || '|2')));
      raise exception 'Wrong required Dondy quantity was accepted';
    exception when others then
      if sqlerrm <> 'counter_item_fixed_component_quantity_invalid' then raise; end if;
    end;
  end loop;
  if v_count <> 3 then raise exception 'Expected three active Vivo Boxes, found %', v_count; end if;
  begin
    perform public.counter_direct_sale_item_notes(v_dondy, 1, null, '[]');
    raise exception 'Inactive standalone Dondy was accepted';
  exception when others then
    if sqlerrm <> 'counter_product_unavailable' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.counter_read_catalog();
    raise exception 'Unauthenticated catalog access accepted';
  exception when insufficient_privilege then null;
  end;
end;
$test$;
select 'PASS: three Vivo Boxes include Dondy; required quantities and access checks preserved' as result;
rollback;
