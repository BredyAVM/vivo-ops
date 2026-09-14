-- Self-cleaning integration test. No real order is edited.
do $test$
declare
  actor uuid;
  master_actor uuid;
  other_actor uuid;
  customer bigint;
  gift bigint;
  fixture bigint := 9000000940;
  line_fixture bigint := 9000000940;
  original_line jsonb;
  patch jsonb;
  items jsonb;
  changed jsonb;
  result jsonb;
  timestamp_before timestamptz;
  expected_error boolean;
  variant integer;
  installed boolean := position('v_preserved_legacy_ids' in pg_get_functiondef(
    'app_private.update_order_core_atomic_v1(bigint,timestamptz,jsonb,jsonb)'::regprocedure)) > 0;
begin
  select o.attributed_advisor_id,o.client_id into actor,customer from public.orders o
  where o.client_id is not null and exists(select 1 from public.user_roles r
    where r.user_id=o.attributed_advisor_id and r.role='advisor')
    and not exists(select 1 from public.user_roles r where r.user_id=o.attributed_advisor_id and r.role in ('master','admin'))
  order by o.id limit 1;
  select user_id into master_actor from public.user_roles where role='admin' order by user_id limit 1;
  select user_id into other_actor from public.user_roles r where role='advisor' and user_id<>actor
    and not exists(select 1 from public.user_roles x where x.user_id=r.user_id and x.role in ('master','admin'))
    order by user_id limit 1;
  select id into gift from public.products where is_active and type='gambit'
    and extra_fields->>'catalog_access_scope'='crm_only' and base_price_usd=0 order by id limit 1;
  assert actor is not null and master_actor is not null and other_actor is not null
    and customer is not null and gift is not null, 'Missing fixtures';
  assert not exists(select 1 from public.orders where id=fixture), 'Fixture order occupied';
  assert not exists(select 1 from public.order_items where id=line_fixture), 'Fixture item occupied';
  begin
    perform set_config('request.jwt.claim.sub',master_actor::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',master_actor,'role','authenticated')::text,true);
    -- Privileged manual order reproduces an already-existing legacy line without
    -- weakening or disabling any trigger, RLS policy or campaign permission.
    insert into public.orders(id,order_number,client_id,attributed_advisor_id,created_by_user_id,
      source,fulfillment,status,extra_fields)
    values(fixture,'ROLLBACK-LEGACY-GIFT',customer,actor,master_actor,'master','pickup','created',
      jsonb_build_object('pricing',jsonb_build_object('fx_rate',100),
        'schedule',jsonb_build_object('date',current_date::text,'time_24','14:00')));
    insert into public.order_items(id,order_id,product_id,qty,product_name_snapshot,
      pricing_origin_currency,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd,
      unit_price_bs_snapshot,line_total_bs_snapshot,notes)
    values(line_fixture,fixture,gift,1,'Legacy test','USD',0,0,0,0,0,'Composition A');
    update public.orders set source='advisor' where id=fixture;
    select to_jsonb(i) into original_line from public.order_items i where id=line_fixture;
    items := jsonb_build_array(original_line || jsonb_build_object('order_item_id',line_fixture));
    select last_modified_at,to_jsonb(o) into timestamp_before,patch from public.orders o where id=fixture;
    patch := jsonb_set(patch,'{extra_fields,schedule,date}',to_jsonb((current_date+1)::text));
    perform set_config('request.jwt.claim.sub',actor::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);

    if not installed then
      expected_error := false;
      begin
        perform public.update_order_core_atomic_v1(fixture,timestamp_before,patch,items);
      exception when insufficient_privilege then
        expected_error := sqlerrm='Este beneficio solo puede cargarse desde una jugada activa del cliente.';
      end;
      assert expected_error, 'Baseline must reproduce the reported failure';
    else
      result := public.update_order_core_atomic_v1(fixture,timestamp_before,patch,items);
      assert (result->>'ok')::boolean, 'Reschedule succeeds';
      assert (select extra_fields#>>'{schedule,date}'=(current_date+1)::text from public.orders where id=fixture), 'Date saved';
      assert (select to_jsonb(i)=original_line from public.order_items i where id=line_fixture), 'Legacy line is byte-for-byte unchanged';
      assert not exists(select 1 from public.crm_play_redemptions where order_id=fixture), 'No invented CRM redemption';
      select last_modified_at into timestamp_before from public.orders where id=fixture;

      -- Identical lines remain identical when serialized in a different line order.
      -- Malicious changes must NOT use the preservation path or unlock a new gift.
      for variant in 1..6 loop
        changed := case variant
          when 1 then jsonb_set(items,'{0,qty}','2')
          when 2 then items || jsonb_build_array((items->0)-'order_item_id'-'id')
          when 3 then jsonb_set(items,'{0,notes}','"Different composition"')
          when 4 then jsonb_set(items,'{0,line_total_usd}','1')
          when 5 then jsonb_set(items,'{0,order_item_id}',to_jsonb(line_fixture+1))
          else items || items end;
        expected_error := false;
        begin
          perform public.update_order_core_atomic_v1(fixture,timestamp_before,patch,changed);
        exception when insufficient_privilege or serialization_failure or unique_violation then expected_error := true;
        end;
        assert expected_error, format('Unauthorized variant %s was accepted',variant);
        assert (select to_jsonb(i)=original_line from public.order_items i where id=line_fixture), 'Failed edit rolls back the line';
      end loop;
      foreach actor in array array[other_actor,null::uuid] loop
        perform set_config('request.jwt.claim.sub',coalesce(actor::text,''),true);
        perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role',case when actor is null then 'anon' else 'authenticated' end)::text,true);
        expected_error := false;
        begin
          perform public.update_order_core_atomic_v1(fixture,timestamp_before,patch,items);
        exception when insufficient_privilege then expected_error := true;
        end;
        assert expected_error, 'Wrong advisor or anonymous cannot edit';
      end loop;
    end if;
    assert not exists(select 1 from public.inventory_movements where order_id=fixture), 'No physical stock consumed';
    raise exception 'Rollback fixtures' using errcode='ZX001';
  exception when sqlstate 'ZX001' then null;
  end;
  assert not exists(select 1 from public.orders where id=fixture), 'No fixture remains';
end;
$test$;
select 'PASS: baseline reproduction or repaired reschedule, unchanged legacy line, no new gifts, rollback, ownership, no real order edits' as result;
