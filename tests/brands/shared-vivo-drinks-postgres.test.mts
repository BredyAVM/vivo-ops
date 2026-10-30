import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {menuDocument} from './menu-fixtures.ts';
import {decodeMenuEditor,parseMenuDocument} from '../../src/lib/brands/menu-model.ts';
import {decodeOrderMenuGraph,defaultMenuOrderSelection,quoteMenuOrder,menuQuoteDetailLines,type MenuOrderQuote} from '../../src/lib/brands/order-menu.ts';
import {buildMenuStockSnapshot,readMenuStockSnapshot,menuStockSignature} from '../../src/lib/brands/inventory-menu.ts';

test('shared VIVO beverages reuse products and the central inventory ledger',async t=>{
 const db=new PGlite();try{
  for(const file of['foundation-schema.sql','inventory-menu-schema.sql'])await db.exec(readFileSync('tests/brands/fixtures/'+file,'utf8'));
  for(const file of['20261028185749_commercial_brand_foundation_v1.sql','20261028193056_muerdeme_menu_drafts_v1.sql','20261029154907_muerdeme_order_configurator_v1.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
  await db.exec(`alter table public.products add column inventory_group text default 'other';
   alter table public.inventory_items add column inventory_group text default 'other';
   insert into public.inventory_items(id,name,unit_name,current_stock_units,inventory_group) values(1,'Tequeños','pieza',100,'raw'),(2,'Coca Cola','botella',100,'beverages'),(3,'Pepsi','botella',100,'beverages');
   update public.products set name=case id when 2 then 'Coca Cola 1,5 Lts' else 'Pepsi 1,5 Lts' end,inventory_group='beverages',inventory_policy='self',commission_mode='fixed_item',commission_value=5 where id in(2,3);
   insert into public.product_inventory_links values(1,1,1,25),(2,2,0,99),(2,2,1,1),(3,3,1,1);`);
  await db.exec(readFileSync('tests/brands/fixtures/inventory-diagnostics-baseline.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20261029163705_muerdeme_kitchen_inventory_v1.sql','utf8'));
  for(const file of['inventory-ledger-test-support.sql','inventory-routes-existing.sql','inventory-resolution-existing.sql','inventory-commitment-existing.sql','inventory-sale-existing.sql'])await db.exec(readFileSync('tests/brands/fixtures/'+file,'utf8'));
  const one=async<T=unknown>(sql:string,args:unknown[]=[])=>((await db.query<{v:T}>(sql,args)).rows[0]?.v);
  const admin='00000000-0000-4000-8000-000000000001',advisor='00000000-0000-4000-8000-000000000002';
  const auth=async(id=admin,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role);};
  const legacy=()=>one('select jsonb_agg(to_jsonb(p)order by id)as v from public.products p where id<1000');
  const before=await legacy(),beforeDiag=await one('select app_private.inventory_order_sale_diagnostics_v1(10)as v');
  await db.exec(readFileSync('supabase/migrations/20261030145549_muerdeme_shared_vivo_drinks_v1.sql','utf8'));
  assert.deepEqual(await legacy(),before);assert.deepEqual(await one('select app_private.inventory_order_sale_diagnostics_v1(10)as v'),beforeDiag);
  await auth();
  const save=(doc:unknown)=>one<{entryId:string}>('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v',[doc,randomUUID()]);
  let burger='',combo='';
  const comboDoc=()=>({...menuDocument('combo','Combo compartido',15),comboGroups:[
   {key:'burger',label:'Hamburguesa',kind:'burger',quantity:1,choices:[{entryId:burger,variantKey:'standard',supplementUsd:0}]},
   {key:'drink',label:'Bebidas',kind:'drink',quantity:2,choices:[{entryId:'vivo:2',variantKey:'standard',supplementUsd:0},{entryId:'vivo:3',variantKey:'standard',supplementUsd:0.5}]}]});
  await t.test('administration selects existing VIVO products and cannot create duplicate Muérdeme drinks',async()=>{
   const data=decodeMenuEditor(await one('select public.admin_muerdeme_menu_editor_v1(null,\'combo\')as v'));
   assert.deepEqual(data.lookups.map(l=>l.entryId),['vivo:2','vivo:3']);
   await assert.rejects(()=>save(menuDocument('drink','Otra Coca Cola',2)),/bebidas se seleccionan/);
   burger=(await save(menuDocument('burger','Hamburguesa',5))).entryId;
   await one('select public.admin_muerdeme_inventory_recipe_save_v1($1,\'standard\',1,0,$2,$3)as v',[burger,{schemaVersion:1,mode:'untracked',note:'Ensayo aislado sin consumo de hamburguesa',lines:[]},randomUUID()]);
   combo=(await save(parseMenuDocument(comboDoc()))).entryId;
   assert.equal(await one<number>("select count(*)::int as v from app_private.muerdeme_menu_entries where kind='drink'"),0);
   assert.equal(await one<number>('select count(*)::int as v from public.products'),34); // original 32 + burger + combo
   assert.deepEqual(await legacy(),before);
   const filtered=decodeMenuEditor(await one('select public.admin_muerdeme_menu_editor_v1($1,\'combo\',\'sin coincidencias\')as v',[combo]));
   assert.deepEqual(filtered.lookups.filter(l=>l.kind==='drink').map(l=>l.entryId),['vivo:2','vivo:3']);
  });
  let quote:MenuOrderQuote;let notes='';let certificate:NonNullable<ReturnType<typeof readMenuStockSnapshot>>;
  await t.test('client and database quotes agree; the included drink uses only the configured supplement',async()=>{
   const graph=decodeOrderMenuGraph(await one('select public.muerdeme_order_menu_graph_v1($1)as v',[combo]));
   assert.equal(graph.entries.find(e=>e.entryId==='vivo:2')!.productId,2);
   const selected=defaultMenuOrderSelection(graph.entries.find(e=>e.entryId===combo)!);selected.slots.find(s=>s.groupKey==='drink'&&s.position===1)!.entryId='vivo:3';
   quote=quoteMenuOrder(graph,selected);assert.equal(quote.unitUsd,15.5);
   assert.deepEqual(await one('select public.muerdeme_order_quote_v1($1,$2)as v',[selected,quote.revisions]),quote);
   const burgerEntry=graph.entries.find(e=>e.entryId===burger)!;
   const recipe={entryId:burger,variantKey:'standard',revision:1,signature:menuStockSignature('burger',burgerEntry.document.variants[0]),document:{schemaVersion:1 as const,mode:'untracked' as const,note:'Ensayo aislado sin consumo de hamburguesa',lines:[]}};
   const stocks=[{id:2,name:'Coca Cola',unitName:'botella',currentStock:100,eligible:true},{id:3,name:'Pepsi',unitName:'botella',currentStock:100,eligible:true}];
   const expected=buildMenuStockSnapshot(graph,quote,[recipe],stocks);
   const preview=await one<{snapshot:typeof expected}>('select public.muerdeme_inventory_preview_v1($1,$2)as v',[selected,quote.revisions]);
   assert.deepEqual(preview.snapshot,expected);assert.equal(preview.snapshot.status,'ready');
   assert.deepEqual(preview.snapshot.lines.map(l=>[l.inventoryItemId,l.quantity]),[[2,1],[3,1]]);
   await db.exec('reset role;update public.products set source_price_amount=99 where id=2');await auth();
   assert.deepEqual(await one('select public.muerdeme_order_quote_v1($1,$2)as v',[selected,quote.revisions]),quote);
   await db.exec('reset role;update public.products set source_price_amount=14 where id=2');await auth();
  });
  const insertCombo=(id:number,text=menuQuoteDetailLines(quote).join('\n'))=>db.query('insert into public.order_items(id,order_id,product_id,qty,notes,pricing_origin_amount)values($1,10,$2,1,$3,$4)',[id,quote.productId,text,quote.unitUsd]);
  await t.test('certified shared consumption is frozen for existing items and cannot be forged',async()=>{
   await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");await auth();
   await insertCombo(100);notes=await one<string>('select notes as v from public.order_items where id=100');certificate=readMenuStockSnapshot(notes)!;
   await db.exec('reset role;update public.product_inventory_links set quantity_units=2 where product_id=2 and configuration_version=1');await auth();
   await db.exec('begin;delete from public.order_items where id=100');await insertCombo(101,notes);await db.exec('commit');
   assert.deepEqual(readMenuStockSnapshot(await one<string>('select notes as v from public.order_items where id=101')),certificate);
   await insertCombo(102,notes);const next=readMenuStockSnapshot(await one<string>('select notes as v from public.order_items where id=102'))!;
   assert.equal(next.lines.find(l=>l.inventoryItemId===2)!.quantity,2);assert.notEqual(next.certificateId,certificate.certificateId);
   await db.exec('delete from public.order_items where id=102');
   await assert.rejects(()=>db.query("update app_private.muerdeme_inventory_certificates set snapshot='{}'"),/certifican|inmutable/);
   await db.exec('reset role;update public.product_inventory_links set quantity_units=1 where product_id=2 and configuration_version=1');await auth();
  });
  await t.test('inactive, internal, non-beverage and incomplete stock links are rejected without moving stock',async()=>{
   for(const sql of["update public.products set is_active=false where id=2","update public.products set inventory_group='other'where id=2","update public.products set extra_fields='{\"catalog_access_scope\":\"admin_internal\"}'where id=2","update public.inventory_items set is_active=false where id=2","delete from public.product_inventory_links where product_id=2 and configuration_version=1"]){
    await db.exec('reset role;begin');await db.exec(sql);await auth();
    await assert.rejects(()=>one('select public.muerdeme_order_menu_graph_v1($1)as v',[combo]),/bebida VIVO/);
    await db.exec('rollback;reset role');
   }
   await auth();await assert.rejects(()=>one('select public.muerdeme_order_quote_v1($1,$2)as v',[{...quote.selection,slots:quote.selection.slots.map(s=>s.groupKey==='drink'?{...s,entryId:'vivo:1'}:s)},quote.revisions]),/no pertenece/);
  });
  await t.test('shared beverage stock is aggregated with standalone VIVO sales and dispatched once',async()=>{
   await auth();await db.exec("insert into public.order_items(id,order_id,product_id,qty,line_total_usd,notes)values(13,10,2,1,2,'Bebida VIVO aparte')");await db.exec('reset role');
   const d=await one<{lines:{inventory_item_id:number;quantity_units:number}[];errors:unknown[]}>('select app_private.inventory_order_sale_diagnostics_v1(10)as v');assert.deepEqual(d.errors,[]);
   assert.deepEqual(d.lines.map(l=>[l.inventory_item_id,l.quantity_units]),[[1,25],[2,2],[3,1]]);
   const balances=await one('select jsonb_agg(jsonb_build_array(id,current_stock_units)order by id)as v from public.inventory_items');
   await one('select app_private.inventory_materialize_order_commitment_v1(10,$1)as v',[admin]);await one('select app_private.inventory_materialize_order_commitment_v1(10,$1)as v',[admin]);
   assert.deepEqual(await one('select jsonb_agg(jsonb_build_array(id,current_stock_units)order by id)as v from public.inventory_items'),balances);
   await auth();await db.exec("update public.orders set status='out_for_delivery'where id=10");const operation=randomUUID();
   assert.equal((await one<{status:string}>('select public.inventory_commit_order_sale_v1($1,10,null)as v',[operation])).status,'applied');
   assert.equal((await one<{status:string}>('select public.inventory_commit_order_sale_v1($1,10,null)as v',[operation])).status,'replayed');
   await db.exec('reset role');assert.deepEqual(await one('select jsonb_agg(jsonb_build_array(id,current_stock_units)order by id)as v from public.inventory_items'),[[1,75],[2,98],[3,99]]);
   assert.equal(await one<number>('select count(*)::int as v from public.inventory_movements'),3);
  });
  await t.test('anonymous and service roles cannot read the shared menu and sales permissions remain scoped',async()=>{
   for(const[id,role]of[['','anon'],['','service_role'],['00000000-0000-4000-8000-000000000003','authenticated']]){await auth(id,role);await assert.rejects(()=>one('select public.muerdeme_order_menu_graph_v1($1)as v',[combo]),/permission denied|preparación/);}
   await auth(advisor);assert.equal(decodeOrderMenuGraph(await one('select public.muerdeme_order_menu_graph_v1($1)as v',[combo])).entries.filter(e=>e.entryId.startsWith('vivo:')).length,2);
   await assert.rejects(()=>save(menuDocument('drink','Duplicada',2)),/administrador activo/);
  });
 }finally{await db.close();}
});
