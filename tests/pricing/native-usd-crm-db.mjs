// Actual CRM guard definitions in isolated PostgreSQL. No real orders or writes.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const source=read('tests/crm/catalog-gift-db.mjs');
const start=source.indexOf('await db.exec(`')+'await db.exec(`'.length;
await db.exec(source.slice(start,source.indexOf('`);',start)));
await db.exec(`
alter table products add column source_price_currency text default 'USD';
alter table products add column base_price_bs numeric;
alter table orders add column fulfillment text default 'pickup';
alter table crm_plays add column benefit_recurrence_mode text default 'once';
alter table crm_play_redemptions add column recurrence_mode_snapshot text default 'once';
alter table crm_play_redemptions add column benefit_day date;
create function public.is_admin() returns boolean language sql as $$select auth.role()='admin'$$;
create function app_private.order_item_operational_quantity_v1(jsonb,jsonb) returns boolean language sql as $$select false$$;
create function app_private.crm_order_has_validity_exception_v1(bigint,bigint) returns boolean language sql as $$select false$$;
create function app_private.crm_assert_order_minimum_v1(bigint) returns void language sql as $$select$$;
create table app_private.usd_catalog_cutover_v1(singleton boolean primary key,activated_at timestamptz);
insert into app_private.usd_catalog_cutover_v1 values(true,null);
create table app_private.native_usd_orders_v1(order_id bigint primary key);
create function app_private.order_uses_current_usd_v1(bigint) returns boolean language sql stable as $$select exists(select 1 from app_private.native_usd_orders_v1 where order_id=$1)$$;
insert into products(id,sku,name,type,base_price_usd,source_price_amount) values
  (8,'SINGLE_8','Pack8','combo',5.5,5.5),(10,'SINGLE_10','Pack10','combo',6.5,6.5),
  (100,'LC_SINGLE_8','Gift8','gambit',1.5,1.5),(101,'LC_SINGLE_10','Gift10','gambit',2.5,2.5);
insert into crm_play_benefit_upgrades values(1,1,1,8,1,1.272871),(2,1,1,10,1,2.591089);
insert into crm_play_member_benefit_selections values(1,1,1,auth.uid(),now());
select set_config('test.role','admin',false);
`);
await db.exec(read('tests/pricing/fixtures/native-usd-crm-functions.sql'));
await db.exec(read('supabase/migrations/20261009182721_native_usd_crm_upgrade_differences.sql'));
await db.exec(`create trigger crm_guard before insert or update on order_items for each row execute function app_private.crm_order_item_guard_v1();
  create trigger crm_redemption_guard before insert or update or delete on crm_play_redemptions for each row execute function app_private.crm_play_redemption_guard_v1();`);
const scalar=async(sql)=>(await db.query(sql)).rows[0].value;
assert.equal(Number(await scalar('select current_customer_difference_usd(u) as value from crm_play_benefit_upgrades u where id=1')),1.272871,'inactive projection retains the original published snapshot');
await db.exec(`update app_private.usd_catalog_cutover_v1 set activated_at=now();`);
assert.equal(Number(await scalar('select current_customer_difference_usd(u) as value from crm_play_benefit_upgrades u where id=1')),1.5);
assert.equal(Number(await scalar('select current_customer_difference_usd(u) as value from crm_play_benefit_upgrades u where id=2')),2.5);
assert.equal(Number(await scalar('select app_private.order_crm_upgrade_difference_v1(1,1) as value')),1.272871,'an existing order does not use the new projection');
await db.exec(`insert into app_private.native_usd_orders_v1 values(3);`);
assert.equal(Number(await scalar('select app_private.order_crm_upgrade_difference_v1(3,1) as value')),1.5);
await db.exec(`insert into order_items(order_id,product_id,qty,crm_play_member_id,crm_play_benefit_id,crm_play_benefit_upgrade_id)
  values(1,8,1,1,1,1),(3,8,1,1,1,1);`);
assert.equal(Number(await scalar('select line_total_usd as value from order_items where order_id=1')),1.27);
assert.equal(Number(await scalar('select line_total_usd as value from order_items where order_id=3')),1.5);
await db.exec(`insert into crm_play_redemptions(play_member_id,play_benefit_id,play_benefit_upgrade_id,
  order_id,order_item_id,product_id,quantity,status,reserved_by_user_id,reserved_at)
  select 1,1,1,3,id,8,1,'reserved',auth.uid(),now() from order_items where order_id=3;`);
assert.equal(Number(await scalar('select customer_paid_difference_usd as value from crm_play_redemptions where order_id=3')),1.5,'reservation certifies the same new amount as the order item');
await db.exec(`update products set source_price_amount=6 where sku='SINGLE_8';`);
assert.equal(Number(await scalar('select source_price_amount as value from products where sku=\'LC_SINGLE_8\'')),2,'paid catalog gifts follow the same difference formula');
assert.equal(Number(await scalar('select source_price_amount as value from products where sku=\'DONDY\'')),0,'unrelated free gifts remain zero');
await db.exec(`update order_items set notes='Unchanged gift' where order_id=3;`);
assert.equal(Number(await scalar('select line_total_usd as value from order_items where order_id=3')),1.5,'reserved prices survive a later catalog update');
await db.exec(`update orders set status='delivered' where id=3;
  update crm_play_redemptions set status='redeemed',redeemed_by_user_id=auth.uid(),redeemed_at=now() where order_id=3;`);
assert.equal(Number(await scalar('select customer_paid_difference_usd as value from crm_play_redemptions where order_id=3')),1.5,'delivery retains the reserved price after another catalog update');
await assert.rejects(db.exec(`update crm_play_redemptions set customer_paid_difference_usd=2 where order_id=3`),/inmutables/);
assert.equal(Number(await scalar('select customer_difference_usd_snapshot as value from crm_play_benefit_upgrades where id=1')),1.272871,'published historical config is never rewritten');
assert.equal(await scalar(`select has_function_privilege('anon','public.current_customer_difference_usd(public.crm_play_benefit_upgrades)','EXECUTE') as value`),false);
console.log('Native USD CRM passed (new differences, legacy config, reservation/delivery, catalog synchronization, zero gifts, immutability and permissions).');
await db.close();
