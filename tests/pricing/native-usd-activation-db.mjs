// Full approved catalog, real financial definitions, exact activation SQL;
// isolated PostgreSQL only. Stale data must roll back the entire activation.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const rows=JSON.parse(read('tests/pricing/fixtures/catalog-before-usd-cutover.json'));
const collection=read('tests/pricing/native-usd-collection-db.mjs');
const begin=collection.indexOf('await db.exec(`')+'await db.exec(`'.length;
const precision=read('supabase/migrations/20260915001157_order_collection_precision_v1.sql');
const crm=read('supabase/migrations/20261009182721_native_usd_crm_upgrade_differences.sql');
const syncStart=crm.indexOf('create function app_private.sync_single_upgrade_products_v1');
const syncEnd=crm.indexOf('$function$;',crm.indexOf('as $function$',syncStart)+14)+12;
const activation=read('supabase/migrations/20261009183635_activate_native_usd_catalog.sql');
const db=new PGlite();
await db.exec(collection.slice(begin,collection.indexOf('`);',begin)));
await db.exec(precision.slice(precision.indexOf('create function app_private.collection_payment_allocation_v1'),precision.indexOf('-- Uses only immutable order snapshots')));
await db.exec(read('tests/pricing/fixtures/native-usd-financial-functions.sql'));
await db.exec(read('supabase/migrations/20261009182000_native_usd_order_collection_policy.sql'));
await db.exec(`create table products(id bigint primary key,sku text unique,is_active boolean,type text,
  source_price_currency text,source_price_amount numeric,base_price_usd numeric,base_price_bs numeric);
  create function public.sync_product_derived_prices() returns trigger language plpgsql as $$begin
    new.base_price_usd:=case when new.source_price_currency='USD' then new.source_price_amount else new.source_price_amount/900 end;
    new.base_price_bs:=case when new.source_price_currency='USD' then new.source_price_amount*900 else new.source_price_amount end;
    return new; end$$;
  create trigger sync before update on products for each row execute function public.sync_product_derived_prices();`);
for(let i=0;i<rows.length;i++){
  const p=rows[i]; await db.query('insert into products values($1,$2,true,$3,$4,$5,$6,$7)',
    [i+1,p.sku,p.kind,p.currency,p.amount,p.currency==='USD'?p.amount:Number(p.amount)/900,p.currency==='VES'?p.amount:Number(p.amount)*900]);
}
await db.exec(crm.slice(syncStart,syncEnd));
await db.exec(`insert into orders values(1,'old','created',1,auth.uid(),auth.uid(),14,11200,
  '{"pricing":{"total_usd":14,"total_bs":11200,"fx_rate":800}}');
  insert into order_items values(1,1,'USD',11200,14,null,null);`);
const legacy=(await db.query(`select * from get_order_financial_state(1,'2026-10-09',900)`)).rows;
const catalogHash=async()=>(await db.query(`select md5(string_agg(to_jsonb(p)::text,'' order by id)) as hash from products p`)).rows[0].hash;
await db.exec(`update products set source_price_amount=11501 where sku='MINI_TEQ_F_25';`);
const staleHash=await catalogHash();
await assert.rejects(db.exec(activation),/approved catalog price changed/);
await db.exec('rollback;');
assert.equal(await catalogHash(),staleHash,'failed activation leaves the whole catalog untouched');
assert.equal((await db.query('select activated_at from app_private.usd_catalog_cutover_v1')).rows[0].activated_at,null);
assert.equal((await db.query(`select to_regclass('app_private.usd_catalog_activation_audit_v1') as audit`)).rows[0].audit,null,'audit creation rolls back too');
await db.exec(`update products set source_price_amount=11500 where sku='MINI_TEQ_F_25';`);
await db.exec(activation);
assert.equal((await db.query(`select count(*) as count from products where source_price_currency<>'USD'`)).rows[0].count,0);
assert.equal((await db.query(`select count(*) as count from app_private.usd_catalog_activation_audit_v1`)).rows[0].count,111);
assert.equal((await db.query(`select count(*) as count from app_private.usd_catalog_activation_audit_v1 where activated_price is null`)).rows[0].count,0);
assert.equal(Number((await db.query(`select source_price_amount from products where sku='MINI_TEQ_F_25'`)).rows[0].source_price_amount),14);
assert.equal(Number((await db.query(`select source_price_amount from products where sku='LC_SINGLE_8'`)).rows[0].source_price_amount),1.5);
assert.equal(Number((await db.query(`select source_price_amount from products where sku='LC_SINGLE_10'`)).rows[0].source_price_amount),2.5);
assert.equal((await db.query(`select count(*) as count from products where source_price_amount=0`)).rows[0].count,26);
assert.deepEqual((await db.query(`select * from get_order_financial_state(1,'2026-10-09',900)`)).rows,legacy,'real activation preserves an existing USD order too');
await db.exec(`insert into orders values(2,'new','created',1,auth.uid(),auth.uid(),14,12600,
  '{"pricing":{"total_usd":14,"total_bs":12600,"fx_rate":900}}');
  insert into order_items values(2,2,'USD',12600,14,null,null);`);
const state=(await db.query(`select * from get_order_financial_state(2,'2026-10-09',1000)`)).rows[0];
assert.equal(state.collection_mode,'native_usd'); assert.equal(Number(state.pending_bs),14000);
assert.equal((await db.query(`select has_table_privilege('authenticated','app_private.usd_catalog_activation_audit_v1','INSERT') as allowed`)).rows[0].allowed,false);
console.log('Native USD activation passed (111 products, approved prices, zero gifts, audit, stale rollback, old/new policy and permissions).');
await db.close();
