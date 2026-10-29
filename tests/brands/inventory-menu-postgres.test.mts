import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{randomUUID}from'node:crypto';import{PGlite}from'@electric-sql/pglite';
import{orderMenuGraph,ids,stocks,stockRecipes}from'./inventory-menu-fixtures.ts';
import{decodeOrderMenuGraph,defaultMenuOrderSelection,quoteMenuOrder,menuQuoteDetailLines,type MenuOrderSelection}from'../../src/lib/brands/order-menu.ts';
import{buildMenuStockSnapshot,readMenuStockSnapshot,MUERDEME_STOCK_PREFIX,type MenuStockRecipe}from'../../src/lib/brands/inventory-menu.ts';
test('Muérdeme kitchen/stock database integration preserves the VIVO resolver and central ledger contract',async t=>{
 const db=new PGlite();
 try{
  await db.exec(readFileSync('tests/brands/fixtures/foundation-schema.sql','utf8'));
  await db.exec(readFileSync('tests/brands/fixtures/inventory-menu-schema.sql','utf8'));
  for(const file of ['20261028185749_commercial_brand_foundation_v1.sql','20261028193056_muerdeme_menu_drafts_v1.sql','20261029154907_muerdeme_order_configurator_v1.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
  for(const item of stocks)await db.query('insert into public.inventory_items(id,name,unit_name,current_stock_units)values($1,$2,$3,$4)',[item.id,item.name,item.unitName,item.currentStock]);
  await db.exec('insert into public.product_inventory_links values(1,1,1,25);');
  await db.exec(readFileSync('tests/brands/fixtures/inventory-diagnostics-baseline.sql','utf8'));
  const one=async<T=unknown>(sql:string,params:unknown[]=[])=>((await db.query<{v:T}>(sql,params)).rows[0].v);
  const diag=()=>one<{lines:{inventory_item_id:number;quantity_units:number}[];errors:unknown[]}>('select app_private.inventory_order_sale_diagnostics_v1(10)as v');
  const before=await diag();assert.deepEqual(before.lines.map(l=>[l.inventory_item_id,l.quantity_units]),[[1,25]]);
  const hash=await one<string>("select md5(pg_get_functiondef('app_private.inventory_order_sale_diagnostics_v1(bigint)'::regprocedure))as v");
  assert.equal(hash,'39703329e57344c4bf06f4c7dc65235d');
  await db.exec(readFileSync('supabase/migrations/20261029163705_muerdeme_kitchen_inventory_v1.sql','utf8'));
  assert.deepEqual(await diag(),before);
  for(const name of ['inventory-ledger-test-support.sql','inventory-routes-existing.sql','inventory-resolution-existing.sql','inventory-commitment-existing.sql','inventory-sale-existing.sql'])await db.exec(readFileSync('tests/brands/fixtures/'+name,'utf8'));
  const auth=async(id='00000000-0000-4000-8000-000000000001',role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role);};
  const generated:Record<string,string>={};const fixture=orderMenuGraph();await auth();
  for(const key of ['extra','fries','drink','burger','combo']as const){let raw=JSON.stringify(fixture.entries.find(e=>e.entryId===ids[key])!.document);for(const[a,b]of Object.entries(generated))raw=raw.replaceAll(a,b);
   generated[ids[key]]=(await one<{entryId:string}>('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v',[JSON.parse(raw),randomUUID()])).entryId;}
  const graphFor=async(key:keyof typeof ids)=>decodeOrderMenuGraph(await one('select public.muerdeme_order_menu_graph_v1($1)as v',[generated[ids[key]]]));
  let graph=await graphFor('combo');
  const saveRecipe=(entryId:string,variantKey:string,document:MenuStockRecipe,expected=0,operation=randomUUID())=>one<{revision:number}>('select public.admin_muerdeme_inventory_recipe_save_v1($1,$2,1,$3,$4,$5)as v',[entryId,variantKey,expected,document,operation]);
  const preview=async(s:MenuOrderSelection)=>{const q=quoteMenuOrder(graph,s);return one<{snapshot:ReturnType<typeof buildMenuStockSnapshot>}>('select public.muerdeme_inventory_preview_v1($1,$2)as v',[s,q.revisions]);};
  const defaultSelection=()=>defaultMenuOrderSelection(graph.entries.find(e=>e.entryId===generated[ids.combo])!);
  const stockBalances=()=>db.query('select id,current_stock_units from public.inventory_items order by id');
  const balances=await stockBalances();
  await t.test('pending recipes return instructions but no partial physical consumption',async()=>{const p=await preview(defaultSelection());assert.equal(p.snapshot.status,'pending');assert.deepEqual(p.snapshot.lines,[]);assert.equal(p.snapshot.kitchen.length,5);});
  await t.test('admin recipes are append-only, validate quantities, and replay safely',async()=>{
   for(const r of stockRecipes(graph))assert.equal((await saveRecipe(r.entryId,r.variantKey,r.document)).revision,1);
   const r=stockRecipes(graph)[0],op=randomUUID();assert.equal((await saveRecipe(r.entryId,r.variantKey,r.document,1,op)).revision,2);assert.equal((await saveRecipe(r.entryId,r.variantKey,r.document,1,op)).revision,2);
   await assert.rejects(()=>saveRecipe(r.entryId,r.variantKey,r.document,1),/cambió/);
   await assert.rejects(()=>db.query('update app_private.muerdeme_inventory_recipe_revisions set revision=99'),/permission denied/);
   await assert.rejects(()=>saveRecipe(r.entryId,r.variantKey,{...r.document,lines:[{inventoryItemId:1,quantity:0,ingredientKey:null}]},2),/positiva/);
   assert.deepEqual(await stockBalances(),balances);
  });
  await t.test('database and client snapshots agree for separate burgers, extras and upgrades',async()=>{
   graph=await graphFor('combo');const s=defaultSelection();s.slots[0].removed=['sauce'];s.slots[1].variantKey='double';s.slots[1].extras=[{entryId:generated[ids.extra],variantKey:'standard',quantity:2}];s.slots[2].friesUpgrade='large';
   const recipes=stockRecipes(graph);recipes[0].revision=2;const expected=buildMenuStockSnapshot(graph,quoteMenuOrder(graph,s),recipes,stocks);assert.deepEqual((await preview(s)).snapshot,expected);
  });
  const insert=async(id:number,notes:string,productId:number,price:number)=>db.query('insert into public.order_items(id,order_id,product_id,qty,notes,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd)values($1,10,$2,1,$3,$4,$4,$4)',[id,productId,notes,price]);
  let certificate:ReturnType<typeof readMenuStockSnapshot>;let quote=quoteMenuOrder(graph,defaultSelection());let savedNotes='';
  await t.test('actual item guard issues a server certificate and combines with VIVO stock in one resolution',async()=>{
   await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");await auth();
   await insert(100,menuQuoteDetailLines(quote).join('\n'),quote.productId,quote.unitUsd);
   savedNotes=await one<string>('select notes as v from public.order_items where id=100');certificate=readMenuStockSnapshot(savedNotes);assert.ok(certificate?.certificateId);
   await db.exec('reset role');const d=await diag();assert.deepEqual(d.errors,[]);assert.equal(d.lines.find(l=>l.inventory_item_id===1)?.quantity_units,27);assert.equal(d.lines.find(l=>l.inventory_item_id===2)?.quantity_units,0.2);assert.deepEqual(await stockBalances(),balances);await auth();
  });
  await t.test('old stock receipt survives atomic delete/reinsert after a recipe revision; new item uses new amounts',async()=>{
   const r=stockRecipes(graph).find(r=>r.entryId===generated[ids.burger]&&r.variantKey==='standard')!;r.document.lines[1].quantity=0.15;
   const revision=await one<number>('select max(revision)as v from app_private.muerdeme_inventory_recipe_revisions where entry_id=$1 and variant_key=$2',[r.entryId,r.variantKey]);await saveRecipe(r.entryId,r.variantKey,r.document,revision);
   await db.exec('begin;delete from public.order_items where id=100');await insert(101,savedNotes,quote.productId,quote.unitUsd);await db.exec('commit');
   const old=readMenuStockSnapshot(await one<string>('select notes as v from public.order_items where id=101'));assert.deepEqual(old,certificate);
   await insert(102,savedNotes,quote.productId,quote.unitUsd);const current=readMenuStockSnapshot(await one<string>('select notes as v from public.order_items where id=102'));assert.notEqual(current!.certificateId,old!.certificateId);assert.equal(current!.lines.find(l=>l.inventoryItemId===2)?.quantity,0.3);
  });
  await t.test('forged stock quantities, direct certificate writes and alternate legacy stock policy are rejected or replaced',async()=>{
   const forged={...certificate,certificateId:randomUUID(),lines:[{inventoryItemId:1,name:'Fake',unitName:'pieza',quantity:999}]};
   await insert(103,[...menuQuoteDetailLines(quote),MUERDEME_STOCK_PREFIX+JSON.stringify(forged)].join('\n'),quote.productId,quote.unitUsd);
   const actual=readMenuStockSnapshot(await one<string>('select notes as v from public.order_items where id=103'));assert.equal(actual!.lines.find(l=>l.inventoryItemId===1)?.quantity,2);
   await assert.rejects(()=>db.query('update app_private.muerdeme_inventory_certificates set order_item_id=null'),/certifican/);
   await assert.rejects(()=>db.query("update public.products set inventory_policy='direct' where id=$1",[quote.productId]),/Preparación/);
  });
  await t.test('VIVO service-role inserts keep working without private recipe permissions',async()=>{
   await db.exec('reset role;grant select on public.products to service_role;grant insert,select on public.order_items to service_role');await auth('','service_role');
   await db.exec("insert into public.order_items(id,order_id,product_id,qty,notes,line_total_usd)values(104,10,2,1,'VIVO conserva su nota',14)");
   assert.equal(await one<string>('select notes as v from public.order_items where id=104'),'VIVO conserva su nota');
   await assert.rejects(()=>db.query('select * from app_private.muerdeme_inventory_recipe_revisions'),/permission denied/);await auth();
   await db.exec('delete from public.order_items where id=104');
  });
  await t.test('anonymous, inactive, advisor and master cannot modify recipes; scoped certificates follow order ownership',async()=>{
   const r=stockRecipes(graph)[0];for(const[id,role]of[['','anon'],['','service_role'],['00000000-0000-4000-8000-000000000003','authenticated'],['00000000-0000-4000-8000-000000000002','authenticated'],['00000000-0000-4000-8000-000000000004','authenticated']]){
    await auth(id,role);await assert.rejects(()=>saveRecipe(r.entryId,r.variantKey,r.document),/permission denied|administración/);
   }
   await auth('00000000-0000-4000-8000-000000000002');assert.equal((await db.query('select * from app_private.muerdeme_inventory_certificates')).rows.length,3);
   await db.exec("reset role;update public.orders set attributed_advisor_id='00000000-0000-4000-8000-000000000004' where id=10");await auth('00000000-0000-4000-8000-000000000002');assert.equal((await db.query('select * from app_private.muerdeme_inventory_certificates')).rows.length,0);await auth();
  });
  await t.test('the unchanged central reservation and dispatch functions move mixed stock once, at physical exit',async()=>{
   await db.exec('reset role');const d=await diag();const quantities=new Map(d.lines.map(l=>[l.inventory_item_id,l.quantity_units]));
   const actor='00000000-0000-4000-8000-000000000001';
   await one('select app_private.inventory_materialize_order_commitment_v1(10,$1)as v',[actor]);
   await one('select app_private.inventory_materialize_order_commitment_v1(10,$1)as v',[actor]);
   const planned=(await db.query<{inventory_item_id:number;quantity_units:string}>("select * from public.inventory_planned_flows where status='active'")).rows;
   assert.equal(planned.length,quantities.size);assert.ok(planned.every(l=>Number(l.quantity_units)===quantities.get(l.inventory_item_id)));assert.deepEqual(await stockBalances(),balances);
   await auth();const operation=randomUUID();await assert.rejects(()=>one('select public.inventory_commit_order_sale_v1($1,10,null)as v',[operation]),/en camino/);
   await db.exec("update public.orders set status='out_for_delivery' where id=10");
   assert.equal((await one<{status:string}>('select public.inventory_commit_order_sale_v1($1,10,null)as v',[operation])).status,'applied');
   assert.equal((await one<{status:string}>('select public.inventory_commit_order_sale_v1($1,10,null)as v',[operation])).status,'replayed');
   await assert.rejects(()=>one('select public.inventory_commit_order_sale_v1($1,10,null)as v',[randomUUID()]),/ya fue descontada/);
   await db.exec('reset role');const after=await stockBalances();assert.ok(after.rows.every((r:{id:number;current_stock_units:string})=>Number(r.current_stock_units)===stocks.find(s=>s.id===r.id)!.currentStock-(quantities.get(r.id)??0)));
   assert.equal((await db.query("select * from public.inventory_planned_flows where status='active'")).rows.length,0);assert.equal((await db.query('select * from public.inventory_movements')).rows.length,quantities.size);
  });
 }finally{await db.close();}
});
