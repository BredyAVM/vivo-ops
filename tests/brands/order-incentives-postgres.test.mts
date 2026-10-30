import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{randomUUID}from'node:crypto';import{PGlite}from'@electric-sql/pglite';
import{menuDocument}from'./menu-fixtures.ts';import{decodeOrderMenuGraph,defaultMenuOrderSelection,quoteMenuOrder,menuQuoteDetailLines}from'../../src/lib/brands/order-menu.ts';
test('fixed burger incentives integrate into closures without changing existing VIVO finances',async t=>{
 const db=new PGlite();try{
  for(const file of['foundation-schema.sql','inventory-menu-schema.sql','inventory-ledger-test-support.sql'])await db.exec(readFileSync('tests/brands/fixtures/'+file,'utf8'));
  await db.exec(`alter table public.profiles add column receives_commissions boolean default true;
   alter table public.orders add column created_at timestamptz default now();alter table public.orders alter column order_number type text using order_number::text;
   create table public.advisor_commission_periods(id bigint primary key,date_from date,date_to date,status text);
   insert into public.advisor_commission_periods values(1,'2026-10-26','2026-11-01','open'),(2,'2026-11-02','2026-11-08','open');
   alter table public.advisor_commission_closures add column period_id bigint default 1,add column advisor_user_id uuid default '00000000-0000-4000-8000-000000000002',
    add column gross_commission_usd numeric default 1,add column payable_usd numeric default 1,add column snapshot jsonb default '{}';
   create unique index test_closure_advisor_period on public.advisor_commission_closures(period_id,advisor_user_id);
   update public.advisor_commission_closures set period_id=99;grant select,insert,update on public.advisor_commission_closures to authenticated;
   grant select on public.advisor_commission_periods,public.user_roles to authenticated;
   create function public.get_order_financial_state(bigint,date,numeric)returns table(total_usd numeric,confirmed_paid_usd numeric,pending_usd numeric)
   language sql stable as $$select o.total_usd,coalesce((select sum(amount)from public.order_payments where order_id=o.id and status='confirmed'and currency='USD'),0),
    greatest(0,o.total_usd-coalesce((select sum(amount)from public.order_payments where order_id=o.id and status='confirmed'and currency='USD'),0))from public.orders o where o.id=$1$$;
   grant select,insert,update on public.order_payments to authenticated;`);
  for(const file of['20261028185749_commercial_brand_foundation_v1.sql','20261028193056_muerdeme_menu_drafts_v1.sql','20261029154907_muerdeme_order_configurator_v1.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
  await db.exec(readFileSync('tests/brands/fixtures/inventory-diagnostics-baseline.sql','utf8'));await db.exec(readFileSync('supabase/migrations/20261029163705_muerdeme_kitchen_inventory_v1.sql','utf8'));
  await db.exec(readFileSync('tests/brands/fixtures/commission-payment-test-support.sql','utf8'));
  const baseline=await db.query('select * from public.advisor_commission_closures order by id');
  await db.exec(readFileSync('tests/brands/fixtures/commission-payment-existing.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20261029172623_muerdeme_order_incentives_v1.sql','utf8'));assert.deepEqual(await db.query('select * from public.advisor_commission_closures order by id'),baseline);
  await db.exec(readFileSync('supabase/migrations/20261030140956_muerdeme_combo_fixed_incentive_v1.sql','utf8'));assert.deepEqual(await db.query('select * from public.advisor_commission_closures order by id'),baseline);
  await db.exec("alter table public.products add column inventory_group text default 'other'");
  await db.exec(readFileSync('supabase/migrations/20261030145549_muerdeme_shared_vivo_drinks_v1.sql','utf8'));
  const one=async<T=unknown>(sql:string,args:unknown[]=[])=>((await db.query<{v:T}>(sql,args)).rows[0]?.v);
  const admin='00000000-0000-4000-8000-000000000001',advisor='00000000-0000-4000-8000-000000000002';
  const auth=async(id=admin,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role);};
  await auth();const menu=menuDocument('burger','Prueba Hamburguesa',5);
  const entry=(await one<{entryId:string}>('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v',[menu,randomUUID()])).entryId;
  await one('select public.admin_muerdeme_inventory_recipe_save_v1($1,$2,1,0,$3,$4)as v',[entry,'standard',{schemaVersion:1,mode:'untracked',note:'Prueba sin movimientos físicos',lines:[]},randomUUID()]);
  const fries=(await one<{entryId:string}>('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v',[menuDocument('fries','Prueba Papas',2),randomUUID()])).entryId;
  await one('select public.admin_muerdeme_inventory_recipe_save_v1($1,$2,1,0,$3,$4)as v',[fries,'standard',{schemaVersion:1,mode:'untracked',note:'Prueba sin movimientos físicos',lines:[]},randomUUID()]);
  await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");await auth(advisor);
  const addOrder=async(id:number,which=entry,source='advisor',creator=advisor,paid=true,client=1)=>{
   await db.query("insert into public.orders(id,client_id,total_usd,order_number,status,source,created_by_user_id,attributed_advisor_id,created_at,extra_fields)values($1,$7,5,$1::bigint::text,'delivered',$2,$3,$4,$5,$6)",[id,source,creator,advisor,'2026-10-29T12:00:00Z',{'pricing':{fx_rate:884.75},'delivery':{completed_at:'2026-10-29T12:00:00Z'}},client]);
   const graph=decodeOrderMenuGraph(await one('select public.muerdeme_order_menu_graph_v1($1)as v',[which]));const q=quoteMenuOrder(graph,defaultMenuOrderSelection(graph.entries.find(e=>e.entryId===which)!));
   await db.query('insert into public.order_items(id,order_id,product_id,qty,notes,pricing_origin_amount)values($1,$2,$3,1,$4,$5)',[id*10,id,q.productId,menuQuoteDetailLines(q).join('\n'),q.unitUsd]);
   if(paid)await db.query("insert into public.order_payments values($1,$1,5,'USD','confirmed')",[id]);return q;
  };
  const candidates=(period=1)=>one<{version:number;rows:Array<{orderId:number;amountUsd:number;purchaseKind:string}>}>('select public.admin_muerdeme_incentive_candidates_v1($1,$2)as v',[period,[advisor]]);
  let firstQuote:ReturnType<typeof quoteMenuOrder>;
  await t.test('first and recurring paid burger orders produce one amount each, regardless of product count',async()=>{
   firstQuote=await addOrder(20);await db.query('insert into public.order_items(id,order_id,product_id,qty,notes,pricing_origin_amount)values(201,20,$1,1,$2,$3)',[firstQuote.productId,menuQuoteDetailLines(firstQuote).join('\n'),firstQuote.unitUsd]);await addOrder(21);await auth();
   const value=await candidates();assert.deepEqual(value.rows.map(r=>[r.orderId,r.amountUsd,r.purchaseKind]),[[20,0.3,'first'],[21,0.2,'recurrent']]);
  });
  await t.test('fries only, direct channel, undelivered and unpaid orders earn no special incentive',async()=>{
   await auth(advisor);await addOrder(22,fries);await auth();await addOrder(23,entry,'master',admin);await addOrder(24,entry,'advisor',advisor,false);await addOrder(25);await db.exec("update public.orders set status='queued' where id=25");
   assert.deepEqual((await candidates()).rows.map(r=>r.orderId),[20,21]);
  });
  await t.test('changing configured USD amounts while sales are enabled preserves already captured policies',async()=>{
   await one('select public.admin_commercial_incentive_draft_save_v1(0.75,0.45,1,$1)as v',[randomUUID()]);await auth(advisor);await addOrder(26);await auth();
   assert.deepEqual((await candidates()).rows.map(r=>[r.orderId,r.amountUsd]),[[20,0.3],[21,0.2],[26,0.45]]);
  });
  const saveClosure=async(rows:unknown[],total:number,id=30,period=1)=>db.query(`insert into public.advisor_commission_closures(id,period_id,advisor_user_id,status,snapshot,gross_commission_usd)
   values($1,$2,$3,'preliminary',$4,$5)on conflict(period_id,advisor_user_id)do update set snapshot=excluded.snapshot,gross_commission_usd=excluded.gross_commission_usd`,[id,period,advisor,{muerdeme_incentives:{version:1,totalUsd:total,rows}},8+total]);
  await t.test('repeated upsert binds each order once and rejects overlapping-period duplicate settlement',async()=>{
   const rows=(await candidates()).rows;await saveClosure(rows,0.95);await saveClosure(rows,0.95,31);
   assert.equal((await db.query('select * from app_private.muerdeme_incentive_settlement_links')).rows.length,3);
   await assert.rejects(()=>saveClosure(rows,0.95,40,2),/duplicate key|ya|relacionad/);
   await assert.rejects(()=>db.query('delete from app_private.muerdeme_incentive_settlement_links'),/cálculo/);
  });
  await t.test('closed/paid receipts remain immutable; confirmed collection is rechecked before finalizing',async()=>{
   await db.exec("update public.order_payments set status='rejected'where order_id=21");
   await assert.rejects(()=>db.exec("update public.advisor_commission_closures set status='closed'where id=30"),/estímulo|corresponde/);
   await db.exec("update public.order_payments set status='confirmed'where order_id=21");
   await db.exec("update public.advisor_commission_closures set status='closed'where id=30");
   await db.exec(`update public.advisor_commission_closures set payable_usd=0.95,snapshot=snapshot||'{"version":2,"totals":{"payableUsd":0.95},"settlement":{"formulaVersion":"advisor-settlement-v1"},"commissionWorkflow":{"conformity":{"status":"confirmed"}}}'::jsonb where id=30`);
   await db.exec("reset role;update public.order_payments set status='rejected'where order_id=21");
   await assert.rejects(()=>one('select app_private.muerdeme_assert_commission_incentives_v1(30)as v'),/cambió su entrega o cobranza/);
   await auth();const key=randomUUID();const pay=(amount:number,request=key)=>one<{replayed:boolean}>('select app_private.record_commission_payment_v1($1,30,1,$2,0,null,current_date,null)as v',[request,amount]);
   await assert.rejects(()=>pay(0.1),/cambió su entrega o cobranza/);await db.exec('reset role');assert.equal((await db.query('select * from public.money_movements')).rows.length,0);
   await db.exec("update public.order_payments set status='confirmed'where order_id=21");await auth();
   await pay(0.1);assert.equal((await pay(0.1)).replayed,true);await pay(0.85,randomUUID());
   await assert.rejects(()=>db.exec("update public.advisor_commission_closures set snapshot='{}'where id=30"),/Reabre/);
   assert.equal(await one<string>('select status as v from public.advisor_commission_closures where id=30'),'paid');
   await db.exec("update public.orders set status='cancelled'where id=20");assert.equal((await db.query('select * from app_private.muerdeme_incentive_settlement_links')).rows.length,3);
  });
  await t.test('a previously unpaid burger becomes payable in a later cycle without changing a paid closure',async()=>{
   await db.query("insert into public.order_payments values(24,24,5,'USD','confirmed')");assert.deepEqual((await candidates(2)).rows.map(r=>[r.orderId,r.amountUsd]),[[24,0.2]]);
   assert.deepEqual(await db.query('select * from public.advisor_commission_closures where id=10'),{...baseline,rows:baseline.rows.filter((r:{id:number})=>r.id===10)});
  });
  await t.test('the real VIVO payment writer has identical partial/final monetary results before and after integration',async()=>{
   await db.exec('reset role');const patched=await one<string>("select pg_get_functiondef('app_private.record_commission_payment_v1(uuid,bigint,bigint,numeric,numeric,numeric,date,text)'::regprocedure)as v");
   const sample=async()=>{await db.exec('begin');try{
    await db.query(`insert into public.advisor_commission_closures(id,period_id,advisor_user_id,status,payable_usd,snapshot)values(50,77,$1,'closed',1,$2)`,[advisor,{version:2,totals:{payableUsd:1},settlement:{formulaVersion:'advisor-settlement-v1'},commissionWorkflow:{conformity:{status:'confirmed'}}}]);
    for(const amount of[0.25,0.75])await one('select app_private.record_commission_payment_v1($1,50,1,$2,0,null,current_date,null)as v',[randomUUID(),amount]);
    return await one(`select jsonb_build_object('closure',(select jsonb_build_object('status',status,'payable',payable_usd,'snapshot',snapshot)from public.advisor_commission_closures where id=50),
     'movements',(select jsonb_agg(jsonb_build_array(amount,currency_code,status,direction,movement_type)order by id)from public.money_movements where description like 'Liquidación de comisión · Cierre 50 ·%'))as v`);
   }finally{await db.exec('rollback');}};
   await db.exec(readFileSync('tests/brands/fixtures/commission-payment-existing.sql','utf8'));const old=await sample();await db.exec(patched);assert.deepEqual(await sample(),old);await auth();
  });
  await t.test('combo conditions replace their included burger/drink terms and the highest amount wins once per order',async()=>{
   await db.exec("reset role;update app_private.commercial_brands set sales_enabled=false where code='muerdeme'");await auth();
   const comboDoc=(amount:number|null)=>({...menuDocument('combo','Combo de prueba '+String(amount),15),comboIncentiveUsd:amount,comboGroups:[
    {key:'burgers',label:'Hamburguesas',kind:'burger' as const,quantity:2,choices:[{entryId:entry,variantKey:'standard',supplementUsd:0}]}]});
   const saveCombo=async(amount:number|null)=>{const doc=comboDoc(amount);const value=await one<{entryId:string}>('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v',[doc,randomUUID()]);return{...value,doc};};
   const low=await saveCombo(0.2),high=await saveCombo(0.8),zero=await saveCombo(0),inherited=await saveCombo(null);
   for(const amount of[-1,0.123,'0.5',true])await assert.rejects(()=>one('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v',[{...comboDoc(null),comboIncentiveUsd:amount},randomUUID()]),/estímulo fijo/);
   await assert.rejects(()=>one('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v',[{...menu,comboIncentiveUsd:0.5},randomUUID()]),/Solo los combos/);
   await db.exec(`reset role;insert into public.clients values(2,'Otro cliente',$$${advisor}$$,'own','[]');update app_private.commercial_brands set sales_enabled=true where code='muerdeme'`);await auth(advisor);
   await addOrder(80,low.entryId,'advisor',advisor,true,2);
   const state=(id:number)=>one<{amountUsd:number;purchaseKind:string;fixedCombo?:{entryId:string;revision:number;name:string;amountUsd:number}}>('select app_private.muerdeme_incentive_state_v1($1)as v',[id]);
   assert.equal((await state(80)).purchaseKind,'first');assert.equal((await state(80)).amountUsd,0.2);
   await assert.rejects(()=>db.exec('update public.order_items set qty=100 where order_id=80'),/configuración individual/);assert.equal((await state(80)).amountUsd,0.2);
   const highQuote=await addOrder(81,high.entryId),zeroQuote=await addOrder(82,zero.entryId);await addOrder(83,inherited.entryId);
   assert.equal((await state(82)).amountUsd,0);assert.equal((await state(83)).amountUsd,0.45);
   const addLine=async(order:number,id:number,q:ReturnType<typeof quoteMenuOrder>)=>db.query('insert into public.order_items(id,order_id,product_id,qty,notes,pricing_origin_amount)values($1,$2,$3,1,$4,$5)',[id,order,q.productId,menuQuoteDetailLines(q).join('\n'),q.unitUsd]);
   await addLine(80,805,highQuote);await addLine(80,806,highQuote);await addLine(80,807,zeroQuote);
   const selected=await state(80);assert.equal(selected.amountUsd,0.8);assert.equal(selected.fixedCombo!.entryId,high.entryId);assert.equal(selected.fixedCombo!.revision,1);
   await addLine(82,825,firstQuote);assert.equal((await state(82)).amountUsd,0.45); // zero combo does not cancel a separately sold burger
   await db.exec("reset role;update app_private.commercial_brands set sales_enabled=false where code='muerdeme'");await auth();await one('select public.admin_muerdeme_menu_save_v1($1,1,$2,$3)as v',[high.entryId,{...high.doc,comboIncentiveUsd:1.25},randomUUID()]);
   await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");await auth();
   assert.deepEqual(await state(80),selected);assert.equal((await state(81)).amountUsd,0.8);
   await auth(advisor);await addOrder(84,high.entryId);assert.equal((await state(84)).amountUsd,1.25);assert.equal((await state(84)).fixedCombo!.revision,2);
   await db.exec('delete from public.order_items where id in(805,806)');assert.equal((await state(80)).amountUsd,0.2);
   await addLine(80,808,firstQuote);assert.equal((await state(80)).amountUsd,0.75);assert.equal((await state(80)).fixedCombo,undefined);
   await db.exec("reset role;insert into public.advisor_commission_periods values(3,'2026-11-09','2026-11-15','open')");await auth();
   const receipt=await state(81);await saveClosure([receipt],0.8,70,3);
   await assert.rejects(()=>saveClosure([{...receipt,amountUsd:1.6}],1.6,70,3),/corresponde/);
   await db.exec(`update public.advisor_commission_closures set status='closed',payable_usd=0.8,snapshot=snapshot||'{"version":2,"totals":{"payableUsd":0.8},"settlement":{"formulaVersion":"advisor-settlement-v1"},"commissionWorkflow":{"conformity":{"status":"confirmed"}}}'::jsonb where id=70`);
   const payCombo=(amount:number,key=randomUUID())=>one<{replayed:boolean}>('select app_private.record_commission_payment_v1($1,70,1,$2,0,null,current_date,null)as v',[key,amount]);
   const paymentKey=randomUUID();await payCombo(0.1,paymentKey);assert.equal((await payCombo(0.1,paymentKey)).replayed,true);
   await db.exec("reset role;update public.order_payments set status='rejected'where order_id=81");await auth();
   await assert.rejects(()=>payCombo(0.7),/cambió su entrega o cobranza/);
   await db.exec("update public.order_payments set status='confirmed'where order_id=81");
   await payCombo(0.7);assert.equal(await one<string>('select status as v from public.advisor_commission_closures where id=70'),'paid');
  });
  await t.test('anonymous, inactive users and other advisors cannot obtain or forge settlement data',async()=>{
   for(const[id,role]of[['','anon'],['','service_role'],['00000000-0000-4000-8000-000000000003','authenticated'],[advisor,'authenticated']]){await auth(id,role);await assert.rejects(()=>candidates(),/permission denied|activos/);}
   await auth(advisor);await assert.rejects(()=>db.query('insert into app_private.muerdeme_order_incentive_terms(order_id,policy_revision)values(10,2)'),/condiciones/);
  });
 }finally{await db.close();}
});
