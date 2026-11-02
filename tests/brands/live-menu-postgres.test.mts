import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as nodeModule from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { menuDocument } from './menu-fixtures.ts';
import type { MenuDocument } from '../../src/lib/brands/menu-model.ts';
import { decodeOrderMenuGraph, defaultMenuOrderSelection, quoteMenuOrder, menuQuoteDetailLines } from '../../src/lib/brands/order-menu.ts';
const registerHooks=Reflect.get(nodeModule,'registerHooks') as (h: {resolve(s:string,c:{parentURL?:string},next:(s:string,c:object)=>{url:string}):{url:string;shortCircuit?:boolean}})=>void;
registerHooks({resolve(s,c,next){if(s==='./menu-model'&&c.parentURL?.includes('/lib/brands/'))return next(s+'.ts',c);return next(s,c);}});
const {menuChanges,decodeMenuHistory}=await import('../../src/lib/brands/menu-history.ts');

test('live catalogue revisions preserve historical orders, recipes and VIVO; history remains scoped and administrator-only',async t=>{
 const db=new PGlite();
 const fixture=(name:string)=>readFileSync('tests/brands/fixtures/'+name,'utf8');
 const migration=(name:string)=>readFileSync('supabase/migrations/'+name+'.sql','utf8');
 const one=async<T=unknown>(sql:string,args:unknown[]=[])=>((await db.query<{v:T}>(sql,args)).rows[0]?.v);
 const admin='00000000-0000-4000-8000-000000000001',advisor='00000000-0000-4000-8000-000000000002';
 const auth=async(id=admin,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role);};
 const save=(document:MenuDocument,id:string|null=null,revision=0,note:string|null=null,op=randomUUID())=>one<{entryId:string;revision:number}>('select public.admin_muerdeme_menu_save_v2($1,$2,$3,$4,$5)as v',[id,revision,document,op,note]);
 const history=async(id:string,page=1)=>decodeMenuHistory(await one('select public.admin_muerdeme_menu_history_v1($1,$2)as v',[id,page]));
 try {
  for(const name of ['foundation-schema.sql','inventory-menu-schema.sql','inventory-ledger-test-support.sql'])await db.exec(fixture(name));
  for(const name of ['20261028185749_commercial_brand_foundation_v1','20261028193056_muerdeme_menu_drafts_v1','20261029154907_muerdeme_order_configurator_v1'])await db.exec(migration(name));
  await db.exec(fixture('inventory-diagnostics-baseline.sql'));await db.exec(migration('20261029163705_muerdeme_kitchen_inventory_v1'));
  // Reuse the production function shape so the migration's guarded replacement
  // fails if the incentive contract changes.
  const incentiveSql=migration('20261029172623_muerdeme_order_incentives_v1');
  const state=incentiveSql.match(/create function app_private\.muerdeme_incentive_state_v1\([\s\S]*?\$f\$;/)![0];
  await db.exec(state);
  await db.exec(migration('20261030140956_muerdeme_combo_fixed_incentive_v1'));
  await db.exec("alter table public.products add column inventory_group text default 'other'");
  await db.exec(migration('20261030145549_muerdeme_shared_vivo_drinks_v1'));
  await auth();const original=menuDocument('burger','Hamburguesa histórica',5);
  const legacy=await one<{entryId:string}>('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v',[original,randomUUID()]);
  const snapshot=async()=>{await db.exec('reset role');const result=await one("select jsonb_build_object('orders',(select jsonb_agg(to_jsonb(t)order by id)from public.orders t),'payments',(select jsonb_agg(to_jsonb(t)order by id)from public.order_payments t),'closures',(select jsonb_agg(to_jsonb(t)order by id)from public.advisor_commission_closures t),'clients',(select jsonb_agg(to_jsonb(t)order by id)from public.clients t))as v");await auth();return result;};
  const baseline=await snapshot();
  await db.exec('reset role');await db.exec(migration('20261102154757_muerdeme_live_catalog_v1'));await auth();
  const burger=structuredClone(original);let revision=1;
  await t.test('installation keeps sales closed and leaves existing business records untouched',async()=>{
   assert.equal(await one("select sales_enabled as v from app_private.commercial_brands where code='muerdeme'"),false);
   assert.equal((await history(legacy.entryId)).rows[0].note,null);
   assert.deepEqual(await snapshot(),baseline);
  });
  await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");await auth();
  await t.test('price edits while selling retain the old revision, actor/time and optional note',async()=>{
   burger.variants[0].priceUsd=6.25;await save(burger,legacy.entryId,revision++,'  Ajuste semanal  ');
   const h=await history(legacy.entryId);assert.deepEqual(h.rows.map(r=>r.revision),[2,1]);assert.equal(h.rows[0].note,'Ajuste semanal');
   assert.deepEqual(h.rows[0].changes,menuChanges(original,burger));assert.equal(h.rows[0].actor,'Administrador');assert.ok(h.rows[0].createdAt);
   assert.deepEqual(await one('select document as v from app_private.muerdeme_menu_revisions where entry_id=$1 and revision=1',[legacy.entryId]),original);
  });
  await t.test('retries are exact, conflicting requests and stale edits are rejected',async()=>{
   const op=randomUUID(),result=await save(burger,legacy.entryId,revision,'Continuidad',op);
   assert.deepEqual(await save(burger,legacy.entryId,revision,'Continuidad',op),result);revision++;
   await assert.rejects(()=>save(burger,legacy.entryId,revision-1,'Otra nota',op),/otros datos/);
   await assert.rejects(()=>save(burger,legacy.entryId,revision-1),/producto cambió/);
   await assert.rejects(()=>save(burger,legacy.entryId,revision,'a'.repeat(301)),/300/);
   await assert.rejects(()=>db.exec('update app_private.muerdeme_menu_revisions set change_note=\'x\''),/permission denied/);
   await assert.rejects(()=>db.exec('delete from app_private.muerdeme_menu_revisions'),/permission denied/);
  });
  await t.test('legacy clients can save a live version and receive an automatic note',async()=>{
   await one('select public.admin_muerdeme_menu_save_v1($1,$2,$3,$4)as v',[legacy.entryId,revision++,burger,randomUUID()]);
   assert.equal((await history(legacy.entryId)).rows[0].note,'Actualización del catálogo');
   assert.equal((await one<{salesEnabled:boolean}>('select public.admin_muerdeme_menu_editor_v1($1)as v',[legacy.entryId])).salesEnabled,true);
   assert.equal((await one<{salesEnabled:boolean}>('select public.admin_muerdeme_menu_list_v1()as v')).salesEnabled,true);
  });
  const graph=async()=>decodeOrderMenuGraph(await one('select public.muerdeme_order_menu_graph_v1($1)as v',[legacy.entryId]));
  const preview=async()=>{const g=await graph(),s=defaultMenuOrderSelection(g.entries.find(e=>e.entryId===legacy.entryId)!);return one<{snapshot:{status:string}}>('select public.muerdeme_inventory_preview_v1($1,$2)as v',[s,quoteMenuOrder(g,s).revisions]);};
  await t.test('price-only revisions preserve recipe readiness; physical changes require review',async()=>{
   await one('select public.admin_muerdeme_inventory_recipe_save_v1($1,$2,$3,0,$4,$5)as v',[legacy.entryId,'standard',revision,{schemaVersion:1,mode:'untracked',note:'Sin movimientos en esta prueba',lines:[]},randomUUID()]);
   assert.equal((await preview()).snapshot.status,'ready');
   burger.variants[0].priceUsd=7;await save(burger,legacy.entryId,revision++);assert.equal((await preview()).snapshot.status,'ready');
   const g=await graph(),q=quoteMenuOrder(g,defaultMenuOrderSelection(g.entries.find(e=>e.entryId===legacy.entryId)!));
   await db.query('insert into public.order_items(id,order_id,product_id,qty,notes,pricing_origin_amount)values(300,10,$1,1,$2,$3)',[q.productId,menuQuoteDetailLines(q).join('\n'),q.unitUsd]);
   const old=await one('select to_jsonb(t)as v from public.order_items t where id=300');
   const oldDoc=structuredClone(burger);burger.variants[0].burger!.pattyCount=2;await save(burger,legacy.entryId,revision++);
   assert.equal((await preview()).snapshot.status,'pending');assert.deepEqual((await history(legacy.entryId)).rows[0].changes,menuChanges(oldDoc,burger));
   assert.deepEqual(await one('select to_jsonb(t)as v from public.order_items t where id=300'),old);
  });
  await t.test('pending prices and explicit zero are distinct in history, and unchanged configuration has no differences',async()=>{
   const pending=menuDocument('extra','Tocineta',null),entry=await save(pending);const free={...pending,variants:pending.variants.map(v=>({...v,priceUsd:0}))};
   await save(free,entry.entryId,1);const changes=(await history(entry.entryId)).rows[0].changes;
   assert.deepEqual(changes,menuChanges(pending,free));assert.equal(changes.prices[0].before,null);assert.equal(changes.prices[0].after,0);
   assert.deepEqual(menuChanges(free,free),{labels:[],prices:[],recipeReview:[]});
   const reordered=JSON.parse(JSON.stringify(burger),function(key,value){return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value;});
   assert.deepEqual(menuChanges(burger,reordered),{labels:[],prices:[],recipeReview:[]});
   for(const kind of ['burger','extra','fries','combo']as const){const doc=menuDocument(kind,'Inicial');assert.deepEqual(await one('select app_private.muerdeme_menu_changes_v1(null,$1)as v',[doc]),menuChanges(null,doc));}
  });
  await t.test('active parents still prevent archiving a required burger, and archiving the parent makes retirement safe',async()=>{
   const combo=menuDocument('combo','Combo',12);combo.comboGroups=[{key:'burgers',label:'Hamburguesas',kind:'burger',quantity:2,choices:[{entryId:legacy.entryId,variantKey:'standard',supplementUsd:0}]}];
   const entry=await save(combo);await assert.rejects(()=>save({...burger,archived:true},legacy.entryId,revision),/dejaría incompleto/);
   await save({...combo,archived:true},entry.entryId,1);await save({...burger,archived:true},legacy.entryId,revision++);
   const retired=await graph();assert.throws(()=>quoteMenuOrder(retired,defaultMenuOrderSelection(retired.entries.find(e=>e.entryId===legacy.entryId)!)),/archivado|disponible|catálogo/);await save(burger,legacy.entryId,revision++);
  });
  await t.test('history reads only one product, caps pages at 25 and preserves descending version order',async()=>{
   while(revision<28)await save(burger,legacy.entryId,revision++);
   const first=await history(legacy.entryId),second=await history(legacy.entryId,2);
   assert.equal(first.rows.length,25);assert.equal(first.hasNext,true);assert.equal(second.hasNext,false);
   assert.equal(first.rows.at(-1)!.revision-1,second.rows[0].revision);assert.equal(first.rows[0].name,burger.name);
   await assert.rejects(()=>history(legacy.entryId,0),/página/);await assert.rejects(()=>history(randomUUID()),/No se encontró/);
  });
  await t.test('anonymous, service, advisors and inactive administrators cannot read history or append revisions',async()=>{
   for(const[id,role]of[['','anon'],['','service_role'],[advisor,'authenticated'],['00000000-0000-4000-8000-000000000003','authenticated'],['00000000-0000-4000-8000-000000000004','authenticated']]){
    await auth(id,role);await assert.rejects(()=>history(legacy.entryId),/permission denied|administrador activo/);await assert.rejects(()=>save(burger,legacy.entryId,revision),/permission denied|administrador activo/);
   }
   await auth();assert.equal(await one("select count(*)as v from public.products p join app_private.commercial_product_brands b on b.product_id=p.id where b.brand_code='muerdeme' and p.is_active"),0);
  });
 } finally {await db.close();}
});

test('history decoder rejects malformed prices, page overflow and non-descending or unbounded results',()=>{
 const row={revision:2,name:'Producto',actor:'Administrador',note:null,createdAt:'2026-11-02T16:00:00Z',changes:{labels:['Precios USD'],recipeReview:[],prices:[{key:'standard',label:'Simple',before:null,after:0,added:false,removed:false}]}};
 const history={entryId:'00000000-0000-4000-8000-000000000001',name:'Producto',page:1,hasNext:false,rows:[row]};
 assert.equal(decodeMenuHistory(history),history);
 for(const bad of [{...history,page:10001},{...history,rows:[row,row]},{...history,rows:Array(26).fill(row)},
  {...history,rows:[{...row,changes:{...row.changes,prices:[{...row.changes.prices[0],after:0.001}]}}]},
  {...history,rows:[{...row,changes:{...row.changes,prices:[{...row.changes.prices[0],added:true,removed:true}]}}]}]) assert.throws(()=>decodeMenuHistory(bad),/incompleto/);
});
