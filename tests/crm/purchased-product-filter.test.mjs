import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8').replaceAll('\r\n','\n');
const helper = {};
new Function('exports', ts.transpileModule(read('../../src/lib/crm/purchased-products.ts'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(helper);
const sql = read('../../supabase/migrations/20261008163133_crm_purchased_product_filter.sql');
const latestDeliverySql = read('../../supabase/migrations/20261008180418_crm_latest_delivery_product_filter.sql');

test('product settings deduplicate and reject invalid modes/IDs', () => {
  assert.deepEqual(helper.purchasedProductRules({}), {purchased_product_ids:[],purchased_product_mode:'any',purchased_product_scope:'any_purchase'});
  assert.deepEqual(helper.purchasedProductRules({purchasedProductIds:[70,70,4],purchasedProductMode:'all',purchasedProductScope:'latest_delivery'}), {purchased_product_ids:[70,4],purchased_product_mode:'all',purchased_product_scope:'latest_delivery'});
  for (const id of [0,-1,1.5,NaN,'70']) assert.throws(() => helper.purchasedProductRules({purchasedProductIds:[id]}));
  assert.throws(() => helper.purchasedProductRules({purchasedProductMode:'bad'}));
  assert.throws(() => helper.purchasedProductRules({purchasedProductScope:'bad'}));
});

test('real PostgreSQL: historic + live, any/all across orders, cutoffs, positive quantity, invalid settings and private permissions', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema app_private;create role anon;create role authenticated;create role service_role;
      create table products(id bigint primary key);insert into products values(70),(4),(5);
      create table historical_order_items(historical_order_id bigint,product_id bigint,quantity numeric);
      create table order_items(order_id bigint,product_id bigint,qty numeric);
      create table commercial_order_facts(fact_origin text,source_record_id bigint,client_id bigint,event_kind text,net_total_usd numeric,purchased_at timestamptz);
      insert into historical_order_items values(1,70,1),(1,70,1),(2,70,1),(3,70,0),(4,4,1);
      insert into order_items values(10,4,1),(11,70,1),(12,70,1),(13,70,1);
      insert into commercial_order_facts values
      ('historical',1,1,'purchase',10,'2025-02-01Z'),('historical',2,2,'purchase',10,'2025-02-01Z'),
      ('historical',3,3,'purchase',10,'2025-02-01Z'),('historical',4,4,'purchase',10,'2025-02-01Z'),
      ('live',10,1,'purchase',10,'2026-09-01Z'),('live',11,5,'gift_only',0,'2026-09-01Z'),
      ('live',12,6,'purchase',10,'2026-11-01Z');
      create table crm_plays(id bigint,status text,rules_snapshot jsonb,snapshot_at timestamptz);
      create table crm_play_members(play_id bigint,client_id bigint,workflow_status text,decision_snapshot jsonb);`);
    // The helper and guard are tested against real Postgres; preview wiring below
    // separately checks the deployed function's exact replacement anchors.
    await db.exec(sql.slice(sql.indexOf('create function app_private'),sql.indexOf('do $patch$')));
    await db.exec("alter table commercial_order_facts add column fulfillment text default 'pickup'");
    await db.exec(latestDeliverySql);
    const clients = async (ids,mode='any') => (await db.query('select client_id from app_private.crm_clients_with_products_v1($1,$2) order by client_id',[{purchased_product_ids:ids,purchased_product_mode:mode},'2026-10-08Z'])).rows.map(x=>Number(x.client_id));
    assert.deepEqual(await clients([70]),[1,2]);
    assert.deepEqual(await clients([70,4]),[1,2,4]);
    assert.deepEqual(await clients([70,4],'all'),[1]);
    assert.deepEqual(await clients([70,70,4],'all'),[1]);
    assert.deepEqual(await clients([]),[]);
    for(const rules of [{purchased_product_ids:[999]},{purchased_product_ids:['70']},{purchased_product_ids:null},{purchased_product_ids:[70],purchased_product_mode:'bad'},{purchased_product_ids:[70],purchased_product_scope:'bad'}]) {
      await assert.rejects(()=>db.query('insert into crm_plays values(1,$1,$2,null)',['draft',rules]));
    }
    await db.exec(`insert into crm_plays values(1,'draft','{"purchased_product_ids":[70]}',null);
      insert into crm_play_members values(1,4,'pending','{}');`);
    await assert.rejects(()=>db.query("update crm_plays set status='frozen' where id=1"),/sin los productos requeridos/);
    await db.exec(`update crm_play_members set decision_snapshot='{"manual_inclusion":true}';update crm_plays set status='frozen' where id=1;`);
    assert.equal((await db.query("select has_function_privilege('authenticated','app_private.crm_clients_with_products_v1(jsonb,timestamptz)','execute') v")).rows[0].v,false);
    const installed = read('fixtures/product-filter-installed-rebuild.sql');
    for(const anchor of ['  insert into public.crm_play_members (','  where client_row.is_active','    and metric.purchase_count >= minimum_purchases',"'primary_advisor_id', client_row.primary_advisor_id"]) assert.ok(installed.includes(anchor));
    assert.match(sql,/product_matches as materialized/);
    assert.match(read('../../src/app/app/master/plays/actions.ts'),/\.\.\.purchasedProductRules\(input\)/);
  } finally {await db.close();}
});

test('real installed preview intersects product matches with all other filters and stores evidence', async () => {
  const db = new PGlite();
  try {
    await db.exec(read('fixtures/product-filter-test-schema.sql'));
    await db.exec(`alter table crm_plays add column snapshot_at timestamptz;
      alter table crm_play_amendments add constraint crm_play_amendments_type_check check(amendment_type in ('message_updated'));
      create function app_private.crm_had_excluded_offer_v1(bigint,timestamptz,jsonb) returns boolean language sql as $$select false$$;
      create table products(id bigint primary key);insert into products values(70),(4);
      create table historical_order_items(historical_order_id bigint,product_id bigint,quantity numeric);
      create table order_items(order_id bigint,product_id bigint,qty numeric);
      create table commercial_order_facts(fact_origin text,source_record_id bigint,client_id bigint,event_kind text,net_total_usd numeric,purchased_at timestamptz);
      insert into historical_order_items values(1,70,1),(2,70,1);
      insert into order_items values(3,4,1);
      insert into commercial_order_facts values('historical',1,1,'purchase',10,'2025-01-01Z'),('historical',2,2,'purchase',10,'2025-01-01Z'),('live',3,1,'purchase',10,'2026-01-01Z');`);
    await db.exec(read('fixtures/product-filter-installed-rebuild.sql'));
    await db.exec(sql);
    await db.exec("alter table commercial_order_facts add column fulfillment text default 'delivery'");
    await db.exec(latestDeliverySql);
    await db.exec(`insert into crm_plays(id,name,status,starts_at) values(200,'Preview','draft','2026-10-01Z');insert into crm_play_benefits values(1,200);`);
    const preview = async rules => {
      await db.query('update crm_plays set rules_snapshot=$1 where id=200',[rules]);
      await db.query('select crm_rebuild_play_members_v1(200)');
      return (await db.query('select client_id from crm_play_members where play_id=200 order by client_id')).rows.map(x=>Number(x.client_id));
    };
    assert.deepEqual(await preview({}),[1,2,3,4,5,6,7,8]);
    assert.deepEqual(await preview({purchased_product_ids:[70]}),[1,2]);
    assert.deepEqual(await preview({purchased_product_ids:[70,4],purchased_product_mode:'all'}),[1]);
    const evidence=(await db.query('select decision_snapshot from crm_play_members where play_id=200')).rows[0].decision_snapshot;
    assert.deepEqual(evidence.matched_product_ids,[4,70]);
    assert.deepEqual(await preview({purchased_product_ids:[70],purchased_product_scope:'latest_delivery'}),[2]);
    const latestEvidence=(await db.query('select decision_snapshot from crm_play_members where play_id=200')).rows[0].decision_snapshot;
    assert.equal(latestEvidence.rules.purchased_product_scope,'latest_delivery');
    assert.deepEqual(latestEvidence.matched_product_ids,[70]);
    assert.deepEqual(await preview({purchased_product_ids:[70],min_purchase_count:31}),[]);
    assert.deepEqual(await preview({purchased_product_ids:[70],included_advisor_ids:[]}),[]);
    await db.exec("select set_config('request.jwt.claim.sub','',false)");
    await assert.rejects(()=>db.query('select crm_rebuild_play_members_v1(200)'),/access is required/);
  } finally {await db.close();}
});

test('last delivery is chosen before product matching; pickup, future, gifts and invalid orders cannot replace it', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema app_private;create role anon;create role authenticated;create role service_role;
      create table products(id bigint primary key);insert into products values(70),(71),(4);
      create table historical_order_items(historical_order_id bigint,product_id bigint,quantity numeric);
      create table order_items(order_id bigint,product_id bigint,qty numeric);
      create table commercial_order_facts(fact_origin text,source_record_id bigint,client_id bigint,event_kind text,net_total_usd numeric,purchased_at timestamptz,fulfillment text);
      create table crm_plays(id bigint,status text,rules_snapshot jsonb,snapshot_at timestamptz);
      create table crm_play_members(play_id bigint,client_id bigint,workflow_status text,decision_snapshot jsonb);
      insert into historical_order_items values
        (1,70,1),(2,70,1),(3,71,1),(5,70,1),(6,70,1),(7,70,1),(8,70,1),(9,70,1),
        (10,70,1),(11,4,1),(12,70,1),(13,70,1);
      insert into order_items values
        (101,71,1),(102,71,1),(103,70,1),(104,70,1),(105,71,1),
        (6,71,1),(107,4,1),(108,70,0),(109,71,1),(110,70,1),(110,70,1),(110,4,1),
        (111,70,1),(112,71,1),(113,71,1),(201,70,1);
      insert into commercial_order_facts
      select 'historical',id,id,'purchase',10,'2025-01-01Z'::timestamptz,'delivery'
        from unnest(array[1,2,3,5,6,7,8,9,10,11,12,13]) id;
      insert into commercial_order_facts values
        ('live',101,1,'purchase',10,'2026-09-01Z','delivery'),
        ('live',201,1,'purchase',10,'2026-10-01Z','pickup'),
        ('live',102,2,'purchase',10,'2026-09-01Z','pickup'),
        ('live',103,3,'purchase',10,'2026-09-01Z','delivery'),
        ('live',104,4,'purchase',10,'2026-09-01Z','pickup'),
        ('live',105,5,'purchase',10,'2026-11-01Z','delivery'),
        ('live',6,6,'purchase',10,'2026-09-01Z','delivery'),
        ('live',107,7,'purchase',10,'2026-09-01Z','delivery'),
        ('live',108,8,'purchase',10,'2026-09-01Z','delivery'),
        ('live',109,9,'gift_only',0,'2026-09-01Z','delivery'),
        ('live',110,10,'purchase',10,'2026-09-01Z','delivery'),
        ('live',111,11,'purchase',10,'2026-09-01Z','delivery'),
        -- Order 112 has no commercial fact: not delivered/canceled.
        ('live',113,13,'purchase',10,'2025-01-01Z','delivery');`);
    await db.exec(sql.slice(sql.indexOf('create function app_private'),sql.indexOf('do $patch$')));
    await db.exec(latestDeliverySql);
    const clients = async (ids,mode='any',asOf='2026-10-08Z') => (await db.query(
      'select client_id from app_private.crm_clients_with_products_v1($1,$2) order by client_id',
      [{purchased_product_ids:ids,purchased_product_mode:mode,purchased_product_scope:'latest_delivery'},asOf]
    )).rows.map(x=>Number(x.client_id));
    assert.deepEqual(await clients([70]),[2,3,5,9,10,11,12]);
    assert.deepEqual(await clients([70],'any','2026-09-01Z'),[2,3,5,9,10,11,12]); // Inclusive cutoff.
    assert.deepEqual(await clients([70,4],'all'),[10]); // Both on the same last delivery.
    assert.deepEqual(await clients([70,70,4],'all'),[10]); // Duplicate lines/IDs count once.
    assert.deepEqual(await clients([70,71]),[1,2,3,5,6,9,10,11,12,13]);
    assert.deepEqual(await clients([70],'any','2026-11-02Z'),[2,3,9,10,11,12]);
    await db.exec(`insert into crm_plays values(1,'draft','{"purchased_product_ids":[70],"purchased_product_scope":"latest_delivery"}','2026-10-08Z');
      insert into crm_play_members values(1,1,'pending','{}');`);
    await assert.rejects(()=>db.query("update crm_plays set status='frozen' where id=1"),/sin los productos requeridos/);
    await db.exec('update crm_play_members set client_id=2');
    await db.exec("update crm_plays set status='frozen' where id=1");
    for (const fn of ['crm_clients_with_products_v1(jsonb,timestamptz)','crm_purchased_product_ids_v1(jsonb)']) {
      assert.equal((await db.query("select has_function_privilege('authenticated',$1,'execute') v",[`app_private.${fn}`])).rows[0].v,false);
    }
  } finally {await db.close();}
});
