-- Self-cleaning integration test: all fixture rows are rolled back on success.
-- Run after advisor_discretionary_new_client_gifts, under a maintenance connection.
do $test$
declare
  advisor_id uuid;
  admin_id uuid;
  master_id uuid;
  other_advisor_id uuid;
  client_id bigint;
  gift record;
  actor_id uuid;
  crm_product_id bigint;
  fixture_order_id bigint := 9000000930;
  fixture_item_id bigint := 9000000930;
  denied boolean;
begin
  select o.attributed_advisor_id, o.client_id into advisor_id, client_id
  from public.orders o
  where o.status = 'delivered' and o.client_id is not null
    and exists(select 1 from public.user_roles r where r.user_id=o.attributed_advisor_id and r.role='advisor')
    and not exists(select 1 from public.user_roles r where r.user_id=o.attributed_advisor_id and r.role in ('admin','master'))
  order by o.id limit 1;
  select user_id into admin_id from public.user_roles where role='admin' order by user_id limit 1;
  select user_id into master_id from public.user_roles where role='master' order by user_id limit 1;
  select user_id into other_advisor_id from public.user_roles r
  where role='advisor' and user_id<>advisor_id
    and not exists(select 1 from public.user_roles p where p.user_id=r.user_id and p.role in ('admin','master'))
  order by user_id limit 1;
  select id into crm_product_id from public.products
  where is_active and extra_fields->>'catalog_access_scope'='crm_only' order by id limit 1;
  assert advisor_id is not null and client_id is not null and admin_id is not null
    and master_id is not null and other_advisor_id is not null and crm_product_id is not null,
    'Need existing role/catalog fixtures';
  assert not exists(select 1 from public.orders where id=fixture_order_id), 'Order fixture ID occupied';
  assert not exists(select 1 from public.order_items where id=fixture_item_id), 'Item fixture ID occupied';
  assert (select count(*)=2 from public.products where sku in ('GAMBIT_DONDY_1_CN','GAMBIT_DONDYS_3')
    and extra_fields->>'catalog_access_scope'='advisor_gift'), 'Only classified gifts are available';
  begin
    perform set_config('request.jwt.claim.sub', advisor_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub',advisor_id,'role','authenticated')::text, true);
    insert into public.orders(id, order_number, client_id, attributed_advisor_id, created_by_user_id, source, fulfillment, status, extra_fields)
    values(fixture_order_id,'ROLLBACK-DISCRETIONARY-GIFT',client_id,advisor_id,advisor_id,'advisor','pickup','created',
      '{"pricing":{"fx_rate":100,"discount_pct":0},"schedule":{"date":"2026-09-14"}}');

    -- A client with an already delivered purchase can receive the optional gift.
    foreach actor_id in array array[advisor_id,admin_id,master_id] loop
      perform set_config('request.jwt.claim.sub', actor_id::text, true);
      perform set_config('request.jwt.claims', jsonb_build_object('sub',actor_id,'role','authenticated')::text, true);
      for gift in select id from public.products where sku in ('GAMBIT_DONDY_1_CN','GAMBIT_DONDYS_3') loop
        insert into public.order_items(id,order_id,product_id,qty,product_name_snapshot,
          pricing_origin_currency,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd,
          unit_price_bs_snapshot,line_total_bs_snapshot)
        values(fixture_item_id,fixture_order_id,gift.id,1,'Test gift','USD',99,99,99,9900,9900);
        assert (select unit_price_usd_snapshot=0 and line_total_usd=0 and unit_price_bs_snapshot=0 and line_total_bs_snapshot=0
          and crm_play_member_id is null and crm_play_benefit_id is null from public.order_items where id=fixture_item_id),
          'Standalone gifts remain free, without CRM enrollment';
        update public.order_items set notes='Entrega posterior a la primera compra' where id=fixture_item_id;
        assert not exists(select 1 from public.crm_play_redemptions where order_item_id=fixture_item_id),
          'Discretionary gifts must not reserve a campaign benefit';
        delete from public.order_items where id=fixture_item_id;
      end loop;
    end loop;

    select id into gift from public.products where sku='GAMBIT_DONDY_1_CN';
    foreach actor_id in array array[other_advisor_id,null::uuid] loop
      perform set_config('request.jwt.claim.sub', coalesce(actor_id::text,''), true);
      perform set_config('request.jwt.claims', jsonb_build_object('sub',actor_id,'role',case when actor_id is null then 'anon' else 'authenticated' end)::text, true);
      denied := false;
      begin
        insert into public.order_items(id,order_id,product_id,qty,product_name_snapshot,unit_price_usd_snapshot,line_total_usd)
        values(fixture_item_id,fixture_order_id,gift.id,1,'Denied gift',0,0);
      exception when insufficient_privilege then denied := true;
      end;
      assert denied, 'Anonymous and unrelated advisor must be denied';
    end loop;

    perform set_config('request.jwt.claim.sub', admin_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub',admin_id,'role','authenticated')::text, true);
    denied := false;
    begin
      insert into public.order_items(id,order_id,product_id,qty,product_name_snapshot,unit_price_usd_snapshot,line_total_usd,
        admin_price_override_usd,admin_price_override_reason)
      values(fixture_item_id,fixture_order_id,gift.id,1,'Paid gift attempt',1,1,1,'Test');
    exception when invalid_parameter_value then denied := true;
    end;
    assert denied, 'A discretionary gift cannot become a charge';
    denied := false;
    begin
      insert into public.order_items(id,order_id,product_id,qty,product_name_snapshot,unit_price_usd_snapshot,line_total_usd)
      values(fixture_item_id,fixture_order_id,crm_product_id,1,'Campaign without member',0,0);
    exception when insufficient_privilege then denied := true;
    end;
    assert denied, 'Campaign-only gifts still need a real CRM benefit';
    update public.orders set client_id=null, attributed_advisor_id=null where id=fixture_order_id;
    perform set_config('request.jwt.claim.sub', advisor_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub',advisor_id,'role','authenticated')::text, true);
    denied := false;
    begin
      insert into public.order_items(id,order_id,product_id,qty,product_name_snapshot,unit_price_usd_snapshot,line_total_usd)
      values(fixture_item_id,fixture_order_id,gift.id,1,'Unassigned order gift',0,0);
    exception when insufficient_privilege then denied := true;
    end;
    assert denied, 'Null assignment cannot bypass ownership';
    assert not exists(select 1 from public.inventory_movements where order_id=fixture_order_id),
      'Editing a draft gift must not consume physical stock';
    raise exception 'Rollback successful fixtures' using errcode='ZX001';
  exception when sqlstate 'ZX001' then null;
  end;
  assert not exists(select 1 from public.orders where id=fixture_order_id), 'No fixture order may persist';
  assert not exists(select 1 from public.order_items where id=fixture_item_id), 'No fixture item may persist';
end;
$test$;
select 'PASS: discretionary gifts; repeat purchase; advisor/master/admin; zero price; ownership; CRM separation; no stock; no fixture rows' as result;
