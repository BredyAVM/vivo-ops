import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { orderMenuGraph, ids } from './order-menu-fixtures.ts';
import { decodeOrderMenuGraph, defaultMenuOrderSelection, quoteMenuOrder, menuQuoteDetailLines, type MenuOrderSelection } from '../../src/lib/brands/order-menu.ts';
import type { MenuDocument } from '../../src/lib/brands/menu-model.ts';

test('database independently prices configured orders while protecting VIVO and preparation state',async t=>{
 const db=new PGlite();
 try{
  await db.exec(readFileSync('tests/brands/fixtures/foundation-schema.sql','utf8'));
  await db.exec(`create sequence public.test_menu_product_id start 1000; alter table public.products alter column id set default nextval('public.test_menu_product_id');
   alter table public.products add column sku text,add column is_combo boolean default false,add column type text default 'product',
    add column base_price_usd numeric default 0,add column extra_fields jsonb default '{}',add column is_inventory_item boolean default true,
    add column inventory_enabled boolean default false,add column inventory_policy text,add column inventory_configuration_status text default 'draft';
   alter table public.orders add column extra_fields jsonb default '{"pricing":{"fx_rate":884.75}}';
   alter table public.order_items add column qty numeric default 1,add column notes text,add column pricing_origin_currency text default 'USD',
    add column pricing_origin_amount numeric default 14,add column admin_price_override_usd numeric,add column override_unit_price_usd numeric,
    add column crm_play_member_id bigint,add column reward_grant_id bigint,add column product_name_snapshot text,
    add column unit_price_usd_snapshot numeric,add column unit_price_bs_snapshot numeric,add column line_total_bs_snapshot numeric,
    add column pricing_fx_rate_snapshot numeric;
   grant insert on public.products to authenticated;grant usage on sequence public.test_menu_product_id to authenticated;
   create policy product_prepare on public.products for insert to authenticated with check(public.has_role('admin'));
   grant select,insert,update on public.orders,public.order_items to authenticated;
   create function public.test_legacy_pricing() returns trigger language plpgsql as $f$ begin
     if not public.has_role('admin') then new.unit_price_usd_snapshot:=0;new.line_total_usd:=0;end if;return new;end;$f$;
   create trigger order_items_set_pricing before insert on public.order_items for each row execute function public.test_legacy_pricing();`);
  for(const file of ['20261028185749_commercial_brand_foundation_v1.sql','20261028193056_muerdeme_menu_drafts_v1.sql','20261029154907_muerdeme_order_configurator_v1.sql'])
   await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
  const auth=async(id='00000000-0000-4000-8000-000000000001',role='authenticated')=>{
   await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role);
  };
  const baseline=async()=>{await db.exec('reset role');return (await db.query(`select jsonb_build_object('products',(select jsonb_agg(to_jsonb(p)order by id)from public.products p where id<1000),
   'clients',(select jsonb_agg(to_jsonb(p)order by id)from public.clients p),'payments',(select jsonb_agg(to_jsonb(p)order by id)from public.order_payments p),
   'closures',(select jsonb_agg(to_jsonb(p)order by id)from public.advisor_commission_closures p)) as v`)).rows[0];};
  const before=await baseline();
  const generated:Record<string,string>={};
  const fixture=orderMenuGraph();
  const save=async(document:MenuDocument,entryId:string|null=null,revision=0)=>(await db.query<{v:{entryId:string;revision:number}}>(
   'select public.admin_muerdeme_menu_save_v1($1,$2,$3,$4) as v',[entryId,revision,document,randomUUID()])).rows[0].v;
  await auth();
  for(const key of ['extra','fries','drink','burger','combo']as const){
   let json=JSON.stringify(fixture.entries.find(e=>e.entryId===ids[key])!.document);
   for(const [oldId,id]of Object.entries(generated))json=json.replaceAll(oldId,id);
   generated[ids[key]]=(await save(JSON.parse(json))).entryId;
  }
  const graphFor=async(key:keyof typeof ids)=>decodeOrderMenuGraph((await db.query<{v:unknown}>(
   'select public.muerdeme_order_menu_graph_v1($1) as v',[generated[ids[key]]])).rows[0].v);
  const sqlQuote=async(selection:MenuOrderSelection,revisions:Record<string,number>)=>(await db.query<{v:unknown}>(
   'select public.muerdeme_order_quote_v1($1,$2) as v',[selection,revisions])).rows[0].v;
  await t.test('new menu drafts get stable inactive adapters with zero percentage and no stock',async()=>{
   const rows=(await db.query<{is_active:boolean;commission_mode:string;commission_value:number;inventory_policy:string;entry_id:string}>(
    'select p.*,l.entry_id from app_private.muerdeme_menu_order_products l join public.products p on p.id=l.product_id')).rows;
   assert.equal(rows.length,4);assert.ok(rows.every(r=>!r.is_active&&r.commission_mode==='fixed_item'&&Number(r.commission_value)===0&&r.inventory_policy==='none'));
   assert.ok(!rows.some(r=>r.entry_id===generated[ids.extra]));
   const graph=await graphFor('burger');const entry=graph.entries.find(e=>e.entryId===generated[ids.burger])!;
   await save(entry.document,entry.entryId,1);assert.equal((await db.query('select * from app_private.muerdeme_menu_order_products')).rows.length,4);
  });
  await t.test('browser and database quotes agree on default combo, independent burgers, extra and upgrade',async()=>{
   const graph=await graphFor('combo');const root=graph.entries.find(e=>e.entryId===generated[ids.combo])!;
   const selection=defaultMenuOrderSelection(root);
   let quote=quoteMenuOrder(graph,selection);assert.deepEqual(await sqlQuote(selection,quote.revisions),quote);assert.equal(quote.unitUsd,15);
   selection.slots[0].removed=['sauce'];selection.slots[1].removed=['pickle'];selection.slots[1].variantKey='double';
   selection.slots[1].extras=[{entryId:generated[ids.extra],variantKey:'standard',quantity:1}];selection.slots[2].friesUpgrade='large';
   quote=quoteMenuOrder(graph,selection);assert.equal(quote.unitUsd,17);assert.deepEqual(await sqlQuote(selection,quote.revisions),quote);
  });
  await t.test('read access excludes anonymous/inactive users and preparation recipes from advisors/master',async()=>{
   for(const [id,role]of[['','anon'],['','service_role'],['00000000-0000-4000-8000-000000000003','authenticated']]){
    await auth(id,role);await assert.rejects(()=>graphFor('burger'),/permission denied|preparación/);
   }
   for(const id of ['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004']){
    await auth(id);await assert.rejects(()=>graphFor('burger'),/preparación/);
    const value=(await db.query<{v:{salesEnabled:boolean;rows:unknown[]}}>('select public.muerdeme_order_menu_search_v1() as v')).rows[0].v;
    assert.equal(value.salesEnabled,false);assert.equal(value.rows.length,0);
   }await auth();
  });
  await t.test('forged removals, extras, quantity and mismatched revision are rejected in SQL',async()=>{
   const graph=await graphFor('burger');const root=graph.entries.find(e=>e.entryId===generated[ids.burger])!;
   const s=defaultMenuOrderSelection(root);const quote=quoteMenuOrder(graph,s);
   await assert.rejects(()=>sqlQuote({...s,removed:['bread']},quote.revisions),/retirar/);
   await assert.rejects(()=>sqlQuote({...s,extras:[{entryId:generated[ids.extra],variantKey:'standard',quantity:3}]},quote.revisions),/permitidos/);
   await assert.rejects(()=>sqlQuote(s,{...quote.revisions,[root.entryId]:1}),/cambiaron/);
   await assert.rejects(()=>sqlQuote({...s,slots:[{}]}as MenuOrderSelection,quote.revisions),/componentes/);
  });
  const insertItem=async(id:number,quote:ReturnType<typeof quoteMenuOrder>,change:Record<string,unknown>={})=>{
   const row={id,order_id:10,product_id:quote.productId,qty:1,pricing_origin_currency:'USD',pricing_origin_amount:quote.unitUsd,
    unit_price_usd_snapshot:quote.unitUsd,line_total_usd:quote.unitUsd,notes:menuQuoteDetailLines(quote).join('\n'),...change};
   const keys=Object.keys(row);await db.query(`insert into public.order_items(${keys.join(',')})values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
  };
  await t.test('commercial preparation blocks actual Muérdeme insertion before producing a financial item',async()=>{
   const graph=await graphFor('burger');const quote=quoteMenuOrder(graph,defaultMenuOrderSelection(graph.entries.find(e=>e.entryId===generated[ids.burger])!));
   await assert.rejects(()=>insertItem(101,quote),/preparación/);assert.equal((await db.query('select * from public.order_items where id=101')).rows.length,0);
   await assert.rejects(()=>insertItem(102,quote,{product_id:1}),/producto VIVO/);
  });
  await t.test('when enabled in an isolated fixture, advisor insertion uses canonical USD/Bs despite legacy price reset',async()=>{
   await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");
   await auth('00000000-0000-4000-8000-000000000002');
   const graph=await graphFor('combo');const selection=defaultMenuOrderSelection(graph.entries.find(e=>e.entryId===generated[ids.combo])!);
   selection.slots[1].extras=[{entryId:generated[ids.extra],variantKey:'standard',quantity:1}];
   const quote=quoteMenuOrder(graph,selection);await insertItem(110,quote);
   const row=(await db.query<{unit_price_usd_snapshot:string;line_total_usd:string;line_total_bs_snapshot:string;notes:string}>('select * from public.order_items where id=110')).rows[0];
   assert.equal(Number(row.unit_price_usd_snapshot),15.75);assert.equal(Number(row.line_total_usd),15.75);assert.equal(Number(row.line_total_bs_snapshot),13934.81);
   await assert.rejects(()=>insertItem(111,quote,{qty:2}),/configuración individual/);
   await assert.rejects(()=>insertItem(112,quote,{pricing_origin_amount:0}),/precio de Muérdeme/);
   await assert.rejects(()=>insertItem(113,quote,{notes:null}),/configuración individual/);
   await assert.rejects(()=>insertItem(114,quote,{reward_grant_id:1}),/beneficios VIVO/);
  });
  await t.test('an ordinary VIVO insertion remains untouched by the new guard',async()=>{
   await auth();await db.exec("insert into public.order_items(id,order_id,product_id,qty,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd,notes) values(120,10,1,1,14,14,14,'VIVO conserva su detalle')");
   const row=(await db.query<{notes:string;line_total_usd:string}>('select * from public.order_items where id=120')).rows[0];
   assert.equal(row.notes,'VIVO conserva su detalle');assert.equal(Number(row.line_total_usd),14);
   assert.deepEqual(await baseline(),before);
  });
  await t.test('legacy VIVO service-role writers need no permission on private menu tables',async()=>{
   await db.exec('reset role;grant select on public.products to service_role;grant insert,select on public.order_items to service_role');
   await auth('','service_role');
   await db.exec("insert into public.order_items(id,order_id,product_id,qty,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd,notes) values(121,10,1,1,14,14,14,'Operación VIVO')");
   assert.equal((await db.query('select * from public.order_items where id=121')).rows.length,1);
   await assert.rejects(()=>db.query('select * from app_private.muerdeme_menu_order_products'),/permission denied/);
  });
 }finally{await db.close();}
});
