// Real trigger snapshot in isolated PostgreSQL; no production data is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const patchName='20261105120129_counter_admin_price_override_v1.sql';
test('Counter administrative prices survive the final writer without changing ordinary sales or permissions',async t=>{
 const db=new PGlite();const actor='00000000-0000-0000-0000-000000000001';
 const rows=async(sql,args=[]) => (await db.query(sql,args)).rows;
 try {
  const seed=read('tests/orders/delivered-order-prices-db.mjs').match(/await db.exec\(`([\s\S]*?)`\);/)[1];await db.exec(seed);
  await db.exec(`alter table orders add column fulfillment text default 'pickup',add column is_price_locked boolean default false;
   alter table order_items add column draft_price_agreement_key uuid,add column reward_grant_id bigint;
   create function is_master()returns boolean language sql as $$select public.has_role('master')$$;
   create or replace function has_role(text)returns boolean language sql as $$select current_setting('test.role',true)=$1$$;
   create or replace function is_master_or_admin()returns boolean language sql as $$select public.has_role('admin')or public.has_role('master')$$;
   create table exchange_rates(is_active boolean,effective_at timestamptz,rate_bs_per_usd numeric);
   insert into exchange_rates values(true,now(),888.9);
   set test.role='admin';set test.uid='${actor}';
   insert into products(id,name,sku,type,is_active,base_price_usd,base_price_bs,source_price_currency,source_price_amount)
    values(1,'Mixto','MIX','product',true,14,12444.6,'USD',14),(2,'Salsa','SAL','product',true,3,2666.7,'USD',3),(3,'Bebida','BEB','product',true,2.5,2222.25,'USD',2.5);
   insert into orders(id,status,source,client_id,extra_fields,total_usd,total_bs_snapshot)values(1,'ready','walk_in',1,'{"counter":{"quick_sale":true},"pricing":{"fx_rate":888.9}}',0,0);
   insert into payment_reports values(1,10,'confirmed');insert into inventory_movements values(1,-1);
   insert into advisor_commission_closures values(1,1,'${actor}','paid',now(),now(),'{"immutable":"historical"}');`);
  for(const file of ['20261009155720_preserve_existing_order_commercial_snapshots.sql','20261004190450_prehandoff_operational_item_changes.sql','20261009173444_split_historical_and_added_order_quantities.sql']){
   const definition=read('supabase/migrations/'+file).match(/create (?:or replace )?function app_private\.order_item_[\s\S]*?\$(function|)\$;/)[0];await db.exec(definition);
  }
  await db.exec(read('tests/orders/fixtures/delivered-pricing-triggers.sql'));
  await db.exec(read('tests/orders/fixtures/counter-admin-pricing-before-fix.sql'));
  const protectedRows=async()=>rows("select jsonb_build_object('payments',(select jsonb_agg(to_jsonb(p))from payment_reports p),'stock',(select jsonb_agg(to_jsonb(s))from inventory_movements s),'closures',(select jsonb_agg(to_jsonb(c))from advisor_commission_closures c))as value");
  const before=await protectedRows();
  const insert=async(id,price=null,currency='USD',amount=price,product=1,qty=1,reason='Ajuste autorizado')=>rows(`insert into order_items(id,order_id,product_id,qty,pricing_origin_currency,pricing_origin_amount,
   unit_price_usd_snapshot,line_total_usd,unit_price_bs_snapshot,line_total_bs_snapshot,pricing_fx_rate_snapshot,admin_price_override_usd,admin_price_override_reason)
   values($1,1,$2,$3::numeric,$4::text,$5::numeric,$6::numeric,$6::numeric*$3::numeric,case when $4='VES'then $5::numeric else $6::numeric*888.9 end,case when $4='VES'then $5::numeric*$3::numeric else $6::numeric*888.9*$3::numeric end,888.9,$6::numeric,$7)returning *`,[id,product,qty,currency,amount,price,price===null?null:reason]);
  const check=async(name,fn)=>t.test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback');}});
  await check('reproduces three approved zeros being overwritten to USD 19.50 before the fix',async()=>{
   for(const[id,product]of[[1,1],[2,2],[3,3]])await insert(id,0,'USD',0,product);
   assert.equal(Number((await rows('select total_usd from orders where id=1'))[0].total_usd),19.5);
   assert.deepEqual((await rows('select admin_price_override_usd from order_items order by id')).map(r=>Number(r.admin_price_override_usd)),[0,0,0]);
  });
  await db.exec(read('supabase/migrations/'+patchName));
  await check('atomic rebuild inputs keep all three prices and the order at zero',async()=>{
   for(const[id,product]of[[1,1],[2,2],[3,3]])await insert(id,0,'USD',0,product);
   assert.equal(Number((await rows('select total_usd from orders where id=1'))[0].total_usd),0);
   for(const row of await rows('select * from order_items')){
    for(const key of ['pricing_origin_amount','unit_price_usd_snapshot','line_total_usd','unit_price_bs_snapshot','line_total_bs_snapshot'])assert.equal(Number(row[key]),0,key);
    assert.equal(row.admin_price_override_by_user_id,actor);assert.ok(row.admin_price_override_at);
   }
  });
  await check('positive and fractional USD approvals also survive Counter inserts and updates',async()=>{
   for(const price of[0,0.25,5.75,20]){await db.exec('delete from order_items');const [row]=await insert(1,price,'USD',price,1,2);
    assert.equal(Number(row.line_total_usd),price*2);assert.equal(Number(row.unit_price_usd_snapshot),price);
    await db.query('update order_items set admin_price_override_usd=0,pricing_origin_amount=0,unit_price_usd_snapshot=0,unit_price_bs_snapshot=0,line_total_bs_snapshot=0 where id=1');
    assert.equal(Number((await rows('select line_total_usd from order_items where id=1'))[0].line_total_usd),0);
   }
  });
  await check('VES approvals preserve native amounts and convert the complete line',async()=>{
   for(const amount of[0,1,500.25]){await db.exec('delete from order_items');const [row]=await insert(1,amount/888.9,'VES',amount,1,3);
    assert.equal(Number(row.unit_price_bs_snapshot),amount);assert.equal(Number(row.line_total_bs_snapshot),amount*3);
    assert.equal(Number(row.line_total_usd),Number((amount*3/888.9).toFixed(2)));
   }
  });
  await check('ordinary Counter sales still use the catalogue, including VES line rounding',async()=>{
   for(const role of['admin','counter']){await db.exec(`set test.role='${role}';delete from order_items`);const [row]=await insert(1,null,'USD',0);assert.equal(Number(row.line_total_usd),14);}
   await db.exec("update products set source_price_currency='VES',source_price_amount=1 where id=1;update orders set extra_fields=jsonb_set(extra_fields,'{pricing,fx_rate}','7')where id=1;delete from order_items");
   const [row]=await insert(1,null,'VES',0,1,3);assert.equal(Number(row.line_total_usd),.43);assert.equal(Number(row.line_total_bs_snapshot),3);
  });
  await check('Master, Advisor and Counter cannot grant manual zero or positive prices',async()=>{
   for(const role of['master','advisor','counter'])for(const currency of['USD','VES']){
    await db.exec(`set test.role='${role}';savepoint denied`);await assert.rejects(()=>insert(1,0,currency,0),/Solo admin/);await db.exec('rollback to denied;release savepoint denied');
   }
  });
  await check('invalid amounts and missing reason fail rather than silently falling back to the catalogue',async()=>{
   for(const [price,reason]of[[-1,'Motivo'],['NaN','Motivo'],['Infinity','Motivo'],[0,' ']]){
    await db.exec('savepoint invalid');await assert.rejects(()=>insert(1,price,'USD',price,1,1,reason),/precio válido|precio valido|numeric field overflow/);await db.exec('rollback to invalid;release savepoint invalid');
   }
  });
  assert.deepEqual(await protectedRows(),before);
 }finally{await db.close();}
});
