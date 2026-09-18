begin;
set local lock_timeout = '3s';
create temporary table gambit_order_item_probe as select * from public.order_items with no data;
create trigger gambit_probe_guard before insert on gambit_order_item_probe
for each row execute function app_private.crm_order_item_guard_v1();
create temporary table gambit_probe_results (check_name text, passed boolean);
do $test$
declare
  actor uuid;
  advisor uuid;
  order_id bigint;
  gift public.products%rowtype;
  config jsonb;
  scope text;
  did_insert boolean;
  snapshot jsonb;
  after_row public.products%rowtype;
  paid public.products%rowtype;
  crm_line public.order_items%rowtype;
  catalog jsonb;
begin
  select user_id into actor from public.user_roles where role::text = 'admin' order by user_id limit 1;
  select o.id,o.attributed_advisor_id into order_id,advisor
  from public.orders o join public.user_roles r on r.user_id=o.attributed_advisor_id and r.role::text='advisor'
  where o.source::text='advisor' order by o.id desc limit 1;
  if actor is null or advisor is null then raise exception 'Missing authorized fixtures'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  select * into strict gift from public.products where sku='GAMBIT_DONDY_1';
  config := jsonb_build_object(
    'product_id', gift.id,'product_type',gift.type,'name',gift.name,'sku',gift.sku,
    'units_per_service',gift.units_per_service,'allows_half_service',gift.allows_half_service,
    'is_temporary',gift.is_temporary,'detail_units_limit',gift.detail_units_limit
  );
  snapshot := to_jsonb(gift) - 'extra_fields' - 'updated_at' - 'updated_by';
  foreach scope in array array['crm_only','advisor_gift_only','advisor_gift','gambit_disabled'] loop
    perform public.inventory_update_product_identity_v1(config || jsonb_build_object('catalog_access_scope',scope));
    select * into after_row from public.products where id=gift.id;
    if after_row.extra_fields ->> 'catalog_access_scope' <> scope
      or (after_row.extra_fields - 'catalog_access_scope') is distinct from (gift.extra_fields - 'catalog_access_scope')
      or (to_jsonb(after_row) - 'extra_fields' - 'updated_at' - 'updated_by') is distinct from snapshot
    then raise exception 'Persistence or unrelated commercial data changed: %',scope; end if;
    insert into gambit_probe_results values ('admin saves '||scope||' preserving other fields',true);
    catalog := public.counter_read_catalog();
    if exists (select 1 from jsonb_array_elements(catalog->'products') p where (p->>'id')::bigint=gift.id)
      <> (scope in ('advisor_gift','advisor_gift_only')) then
      raise exception 'Wrong counter catalog result: %',scope;
    end if;
    insert into gambit_probe_results values ('Counter catalog '||scope,true);
    did_insert := false;
    begin
      insert into gambit_order_item_probe(id,order_id,product_id,qty,notes,pricing_origin_currency,pricing_origin_amount)
      values(-1,order_id,gift.id,1,null,'USD',0);
      did_insert := true;
    exception when sqlstate '42501' then
      if sqlerrm not like 'Este beneficio solo puede%' then raise; end if;
    end;
    if did_insert <> (scope in ('advisor_gift','advisor_gift_only')) then raise exception 'Wrong Master guard result: %',scope; end if;
    insert into gambit_probe_results values ('Master writes advisor-source '||scope,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',advisor,'role','authenticated')::text,true);
    did_insert := false;
    begin
      insert into gambit_order_item_probe(id,order_id,product_id,qty,notes,pricing_origin_currency,pricing_origin_amount)
      values(-2,order_id,gift.id,1,null,'USD',0);
      did_insert := true;
    exception when sqlstate '42501' then
      if sqlerrm not like 'Este beneficio solo puede%' then raise; end if;
    end;
    if did_insert <> (scope in ('advisor_gift','advisor_gift_only')) then raise exception 'Wrong advisor guard result: %',scope; end if;
    insert into gambit_probe_results values ('Advisor writes '||scope,true);
    begin
      perform public.inventory_update_product_identity_v1(config || jsonb_build_object('catalog_access_scope','advisor_gift'));
      raise exception 'Advisor configured own permissions';
    exception when sqlstate '42501' then
      if sqlerrm not like 'Solo administración%' then raise; end if;
    end;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  end loop;

  perform public.inventory_update_product_identity_v1(config || '{"catalog_access_scope":"advisor_gift"}'::jsonb);
  begin
    insert into gambit_order_item_probe(id,order_id,product_id,qty,crm_play_member_id)
    values(-3,order_id,gift.id,1,-99999);
    raise exception 'Both modes bypassed CRM validation';
  exception when sqlstate '22023' then
    if sqlerrm not like 'La vinculación CRM%' then raise; end if;
  end;
  insert into gambit_probe_results values ('Both modes still validate linked CRM',true);
  begin
    insert into gambit_order_item_probe(id,order_id,product_id,qty,admin_price_override_usd)
    values(-4,order_id,gift.id,1,4);
    raise exception 'Charged a free gift';
  exception when sqlstate '22023' then
    if sqlerrm not like 'El obsequio debe%' then raise; end if;
  end;
  insert into gambit_probe_results values ('Free gifts retain zero customer price',true);
  begin
    perform public.inventory_update_product_identity_v1(config || '{"catalog_access_scope":"forged"}'::jsonb);
    raise exception 'Unknown scope accepted';
  exception when sqlstate '22023' then
    if sqlerrm not like 'La forma de aplicar%' then raise; end if;
  end;
  insert into gambit_probe_results values ('Unknown application modes rejected',true);

  select * into strict paid from public.products
  where type::text='gambit' and is_active and source_price_amount>0 order by id limit 1;
  perform public.inventory_update_product_identity_v1(jsonb_build_object(
    'product_id',paid.id,'product_type',paid.type,'name',paid.name,'sku',paid.sku,
    'units_per_service',paid.units_per_service,'allows_half_service',paid.allows_half_service,
    'is_temporary',paid.is_temporary,'detail_units_limit',paid.detail_units_limit,
    'catalog_access_scope','advisor_gift_only'));
  insert into gambit_order_item_probe(id,order_id,product_id,qty,pricing_origin_currency,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd)
  values(-5,order_id,paid.id,1,paid.source_price_currency,paid.source_price_amount,paid.base_price_usd,paid.base_price_usd);
  if not exists(select 1 from gambit_order_item_probe where id=-5 and pricing_origin_amount=paid.source_price_amount) then
    raise exception 'Paid strategy lost its original currency price';
  end if;
  insert into gambit_probe_results values ('Paid discretionary strategy preserves price',true);

  select i.* into crm_line from public.order_items i
  join public.products p on p.id=i.product_id and p.is_active
  join public.crm_play_redemptions r on r.order_id=i.order_id
    and r.play_member_id=i.crm_play_member_id and r.play_benefit_id=i.crm_play_benefit_id and r.status='redeemed'
  where i.crm_play_member_id is not null order by i.id desc limit 1;
  if crm_line.id is null then raise exception 'Missing existing CRM fixture'; end if;
  update public.products set extra_fields=coalesce(extra_fields,'{}'::jsonb)||'{"catalog_access_scope":"advisor_gift_only"}'::jsonb
  where id=crm_line.product_id;
  crm_line.id := -6;
  insert into gambit_order_item_probe select (crm_line).*;
  insert into gambit_probe_results values ('Already redeemed CRM remains valid after mode change',true);

end;
$test$;
select * from gambit_probe_results;
rollback;
