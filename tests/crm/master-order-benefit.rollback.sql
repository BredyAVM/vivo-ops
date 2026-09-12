-- Always run inside BEGIN ... ROLLBACK. Fixtures and CRM selections are discarded.
do $test$
declare
  member record;
  actor record;
  upgrade record;
  test_order_id bigint := 9000000920;
  test_item_id bigint := 9000000920;
  other_advisor uuid;
  rejected boolean;
  order_source text;
begin
  select m.id, m.client_id, m.advisor_id_snapshot, b.id as benefit_id, b.product_id, b.quantity
  into member
  from public.crm_play_members m
  join public.crm_plays p on p.id = m.play_id
  join public.crm_play_benefits b on b.play_id = p.id
  where m.benefit_status = 'available' and m.workflow_status <> 'removed'
    and m.advisor_id_snapshot is not null
    and p.status = 'active' and (p.starts_at is null or p.starts_at <= now())
    and (p.ends_at is null or p.ends_at > now())
    and p.purchase_requirement_mode = 'none'
  order by m.id, b.id limit 1;
  assert member.id is not null, 'Need one available active test member';
  select user_id into other_advisor from public.user_roles
  where role = 'advisor' and user_id <> member.advisor_id_snapshot
    and user_id not in (select user_id from public.user_roles where role in ('admin','master')) limit 1;
  assert other_advisor is not null, 'Need an unrelated advisor for denial test';
  assert not exists(select 1 from public.orders where id between test_order_id and test_order_id + 10), 'Fixture order IDs must be unused';
  assert not exists(select 1 from public.order_items where id between test_item_id and test_item_id + 10), 'Fixture item IDs must be unused';

  for actor in select distinct on (role) role, user_id from public.user_roles where role in ('master','admin') order by role, user_id loop
    for order_source in select unnest(array['advisor','master','walk_in']) loop
    perform set_config('request.jwt.claim.sub', actor.user_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub',actor.user_id,'role','authenticated')::text, true);
    assert public.is_master_or_admin(), 'The test actor must have a privileged role';
    perform public.crm_set_play_benefits_v2(member.id, array[member.benefit_id]);

    insert into public.orders(id, order_number, client_id, attributed_advisor_id, created_by_user_id, source, fulfillment, status, extra_fields)
    values(test_order_id, 'ROLLBACK-CRM-' || actor.role::text || '-' || order_source, member.client_id, member.advisor_id_snapshot, actor.user_id,
      order_source::public.order_source, 'pickup', 'created', '{"pricing":{"fx_rate":100,"discount_pct":0}}');
    insert into public.order_items(id, order_id, product_id, qty, product_name_snapshot, pricing_origin_currency, pricing_origin_amount,
      unit_price_usd_snapshot, line_total_usd, crm_play_member_id, crm_play_benefit_id)
    values(test_item_id, test_order_id, member.product_id, member.quantity, 'Rollback gift', 'USD', 99, 99, 99, member.id, member.benefit_id);
    assert (select line_total_usd = 0 from public.order_items where id = test_item_id), 'DB must price the gift at zero';
    assert exists(select 1 from public.crm_play_redemptions where order_item_id = test_item_id and status = 'reserved'
      and reserved_by_user_id = actor.user_id and redeemed_at is null), 'Operator is audited; gift is reserved, not delivered';
    delete from public.order_items where id = test_item_id;
    assert (select benefit_status = 'available' from public.crm_play_members where id = member.id), 'Removing gift releases availability';

    perform set_config('request.jwt.claim.sub', other_advisor::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub',other_advisor,'role','authenticated')::text, true);
    rejected := false;
    begin
      insert into public.order_items(id, order_id, product_id, qty, product_name_snapshot, unit_price_usd_snapshot, line_total_usd, crm_play_member_id, crm_play_benefit_id)
      values(test_item_id, test_order_id, member.product_id, member.quantity, 'Denied gift', 0, 0, member.id, member.benefit_id);
    exception when insufficient_privilege then rejected := true;
    end;
    assert rejected, 'Unrelated advisor must still be denied';

    perform set_config('request.jwt.claim.sub', actor.user_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub',actor.user_id,'role','authenticated')::text, true);
    update public.orders set attributed_advisor_id = other_advisor where id = test_order_id;
    rejected := false;
    begin
      insert into public.order_items(id, order_id, product_id, qty, product_name_snapshot, unit_price_usd_snapshot, line_total_usd, crm_play_member_id, crm_play_benefit_id)
      values(test_item_id, test_order_id, member.product_id, member.quantity, 'Wrong advisor gift', 0, 0, member.id, member.benefit_id);
    exception when insufficient_privilege then rejected := true;
    end;
    assert rejected, 'Master/admin must preserve the assigned advisor';
    update public.orders set attributed_advisor_id = member.advisor_id_snapshot where id = test_order_id;

    select * into upgrade from public.crm_play_benefit_upgrades where play_benefit_id = member.benefit_id order by id limit 1;
    if upgrade.id is not null then
      insert into public.order_items(id, order_id, product_id, qty, product_name_snapshot, unit_price_usd_snapshot, line_total_usd,
        crm_play_member_id, crm_play_benefit_id, crm_play_benefit_upgrade_id)
      values(test_item_id, test_order_id, upgrade.target_product_id, upgrade.target_quantity, 'Rollback upgrade', 0, 0,
        member.id, member.benefit_id, upgrade.id);
      assert (select line_total_usd = upgrade.customer_difference_usd_snapshot from public.order_items where id = test_item_id), 'DB charges only the upgrade difference';
      delete from public.order_items where id = test_item_id;
    end if;
    test_order_id := test_order_id + 1;
    test_item_id := test_item_id + 1;
    end loop;
  end loop;
end;
$test$;
select 'PASS: master/admin; advisor/master/walk-in origins; gift and upgrade; advisor boundary; removal releases reservation; no delivery' as result;
