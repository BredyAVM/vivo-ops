import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { menuDocument } from './menu-fixtures.ts';
import { decodeMenuEditor, type MenuDocument } from '../../src/lib/brands/menu-model.ts';

test('Muérdeme catalogue validates composition and references without modifying VIVO',async t=>{
  const db=new PGlite();
  try{
    await db.exec(readFileSync('tests/brands/fixtures/foundation-schema.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261028185749_commercial_brand_foundation_v1.sql','utf8'));
    const snapshot=async()=>{
      await db.exec('reset role');
      const rows:unknown[]=[];
      for(const table of ['products','clients','orders','order_items','order_payments','advisor_commission_closures']) rows.push((await db.query(`select to_jsonb(t) as row from public.${table} t order by id`)).rows);
      return rows;
    };
    const before=await snapshot();
    await db.exec(readFileSync('supabase/migrations/20261028193056_muerdeme_menu_drafts_v1.sql','utf8'));
    const auth=async(id='00000000-0000-4000-8000-000000000001',role='authenticated')=>{
      await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec(`set role ${role}`);
    };
    const save=async(document:MenuDocument,id:string|null=null,revision=0,operation=randomUUID())=>(await db.query<{v:{entryId:string;revision:number}}>(
      'select public.admin_muerdeme_menu_save_v1($1,$2,$3,$4) as v',[id,revision,document,operation])).rows[0].v;
    const edit=async(id:string|null,kind='burger')=>decodeMenuEditor((await db.query<{v:unknown}>(
      'select public.admin_muerdeme_menu_editor_v1($1,$2) as v',[id,kind])).rows[0].v);
    let friesId='',extraId='',burgerId='',drinkId='',comboId='';
    const fries=menuDocument('fries','Ensayo Papas',2);
    fries.variants.push({key:'large',label:'Grandes',priceUsd:3,burger:null});
    fries.friesUpgrades=[{fromKey:'standard',toKey:'large',supplementUsd:0.75}];
    const burger=menuDocument('burger','Ensayo Hamburguesa',5);
    const combo=menuDocument('combo','Ensayo Combo',15);
    await t.test('anonymous, advisor, master, inactive admin and service role cannot manage drafts',async()=>{
      for(const [id,role]of[['','anon'],['','authenticated'],['00000000-0000-4000-8000-000000000002','authenticated'],['00000000-0000-4000-8000-000000000003','authenticated'],['00000000-0000-4000-8000-000000000004','authenticated'],['','service_role']]){
        await auth(id,role);await assert.rejects(()=>save(fries),/permission denied|administrador activo/);await assert.rejects(()=>edit(null),/permission denied|administrador activo/);
      }
    });
    await t.test('create all five kinds with independent versioned draft identities',async()=>{
      await auth();
      friesId=(await save(fries)).entryId;
      extraId=(await save(menuDocument('extra','Ensayo Tocineta',0.75))).entryId;
      drinkId=(await save(menuDocument('drink','Ensayo Bebida',2))).entryId;
      burger.variants[0].burger!.extras=[{entryId:extraId,variantKey:'standard',maxQty:2}];
      burger.variants.push({...structuredClone(burger.variants[0]),key:'double',label:'Doble',priceUsd:7});
      burger.variants[1].burger!.pattyCount=2;
      burgerId=(await save(burger)).entryId;
      combo.comboGroups=[{key:'burgers',label:'Hamburguesas',kind:'burger',quantity:2,choices:[{entryId:burgerId,variantKey:'standard',supplementUsd:0},{entryId:burgerId,variantKey:'double',supplementUsd:0}]},
        {key:'fries',label:'Papas',kind:'fries',quantity:2,choices:[{entryId:friesId,variantKey:'standard',supplementUsd:0}]},
        {key:'drink',label:'Bebida',kind:'drink',quantity:1,choices:[{entryId:drinkId,variantKey:'standard',supplementUsd:0}]}];
      comboId=(await save(combo)).entryId;
      const value=await edit(comboId);
      assert.equal(value.entry!.document.variants[0].priceUsd,15);
      assert.equal(value.entry!.document.comboGroups[0].quantity,2);
      assert.equal(value.entry!.document.comboGroups[0].choices.length,2);
      assert.equal(value.lookups.find(e=>e.entryId===burgerId)!.variants[1].hasFries,false);
    });
    await t.test('unchanged retry is exact, stale edits reject, old versions are immutable',async()=>{
      const op=randomUUID();const changed=structuredClone(burger);changed.name='Ensayo Hamburguesa revisada';
      const result=await save(changed,burgerId,1,op);
      assert.deepEqual(await save(changed,burgerId,1,op),result);
      await assert.rejects(()=>save(burger,burgerId,1),/producto cambió/);
      await assert.rejects(()=>save(burger,burgerId,1,op),/otros datos/);
      assert.equal((await edit(burgerId)).entry!.revision,2);
      assert.equal((await db.query('select document from app_private.muerdeme_menu_revisions where entry_id=$1 and revision=1',[burgerId])).rows.length,1);
      await assert.rejects(()=>db.exec('delete from app_private.muerdeme_menu_revisions'),/permission denied/);
      await assert.rejects(()=>db.exec('update app_private.muerdeme_menu_revisions set revision=99'),/permission denied/);
    });
    await t.test('a parent cannot lose a referenced presentation or acquire duplicate fries',async()=>{
      const changed=structuredClone(burger);changed.variants.pop();
      await assert.rejects(()=>save(changed,burgerId,2),/dejaría incompleto/);
      changed.variants=structuredClone(burger.variants);
      changed.variants[0].burger!.includedFries={entryId:friesId,variantKey:'standard',quantity:1};
      await assert.rejects(()=>save(changed,burgerId,2),/dejaría incompleto/);
      assert.equal((await edit(burgerId)).entry!.revision,2);
      assert.equal((await edit(comboId)).entry!.document.comboGroups.length,3);
    });
    await t.test('references cannot change kinds, use missing presentations or archive a required component',async()=>{
      const bad=structuredClone(burger);bad.variants[0].burger!.extras[0].entryId=drinkId;
      await assert.rejects(()=>save(bad,burgerId,2),/tipo indicado/);
      bad.variants[0].burger!.extras[0]={entryId:extraId,variantKey:'missing',maxQty:1};
      await assert.rejects(()=>save(bad,burgerId,2),/ya no existe/);
      const extra=(await edit(extraId)).entry!.document;extra.archived=true;
      await assert.rejects(()=>save(extra,extraId,1),/dejaría incompleto/);
      const wrong=menuDocument('drink','Ensayo cambio de tipo');
      await assert.rejects(()=>save(wrong,burgerId,2),/cambiar el tipo/);
    });
    await t.test('unapproved prices remain null, free zero remains zero, malformed supplements roll back',async()=>{
      const pending=menuDocument('drink','Ensayo precio pendiente',null);
      const id=(await save(pending)).entryId;
      assert.equal((await edit(id)).entry!.document.variants[0].priceUsd,null);
      pending.variants[0].priceUsd=0;
      await save(pending,id,1);
      assert.equal((await edit(id)).entry!.document.variants[0].priceUsd,0);
      const bad=structuredClone(combo);bad.comboGroups[0].choices[0].supplementUsd=0.005;
      await assert.rejects(()=>save(bad,comboId,1),/suplementos en USD/);
    });
    await t.test('lookup and search use only draft metadata and never require VIVO product reads',async()=>{
      await db.exec('reset role; revoke select on public.products from authenticated');await auth();
      assert.ok((await edit(comboId)).lookups.length>=3);
      const list=(await db.query<{v:{rows:{entryId:string}[]}}>("select public.admin_muerdeme_menu_list_v1('Hamburguesa','burger',1,false) as v")).rows[0].v;
      assert.equal(list.rows[0].entryId,burgerId);
      await db.exec('reset role; grant select on public.products to authenticated');
    });
    await t.test('direct revision inserts cannot bypass document, author or parent checks',async()=>{
      await auth();
      const invalid=structuredClone(burger) as unknown as Record<string,unknown>;invalid.variants=[];
      await assert.rejects(()=>db.query('insert into app_private.muerdeme_menu_revisions(entry_id,revision,document,operation_id,actor_id) values($1,3,$2,$3,$4)',
        [burgerId,invalid,randomUUID(),'00000000-0000-4000-8000-000000000001']),/límite de opciones/);
      await assert.rejects(()=>db.query('insert into app_private.muerdeme_menu_revisions(entry_id,revision,document,operation_id,actor_id) values($1,99,$2,$3,$4)',
        [burgerId,burger,randomUUID(),'00000000-0000-4000-8000-000000000001']),/versión o el autor/);
      await auth('00000000-0000-4000-8000-000000000002');
      assert.equal((await db.query('select * from app_private.muerdeme_menu_revisions')).rows.length,0);
      assert.equal((await db.query('select * from app_private.muerdeme_menu_entries')).rows.length,0);
    });
    await t.test('list pages are bounded and accent-insensitive without loading revision histories',async()=>{
      await auth();
      for(let i=0;i<27;i++)await save(menuDocument('drink',`Bebida ${String(i).padStart(2,'0')}`,null));
      await save(menuDocument('drink','Bebida Clásica',2));
      const list=async(page:number,q='')=>(await db.query<{v:{rows:{entryId:string}[];hasNext:boolean}}>(
        'select public.admin_muerdeme_menu_list_v1($1,$2,$3,false) as v',[q,'drink',page])).rows[0].v;
      const first=await list(1),second=await list(2);
      assert.equal(first.rows.length,25);assert.equal(first.hasNext,true);assert.equal(second.hasNext,false);
      assert.equal(new Set([...first.rows,...second.rows].map(r=>r.entryId)).size,30);
      assert.equal((await list(1,'clasica')).rows.length,1);
      await assert.rejects(()=>list(0),/Filtros del catálogo inválidos/);
    });
    await t.test('launch remains disabled and all legacy financial and operational data are identical',async()=>{
      assert.deepEqual(await snapshot(),before);
      assert.equal((await db.query<{sales_enabled:boolean}>("select sales_enabled from app_private.commercial_brands where code='muerdeme'")).rows[0].sales_enabled,false);
    });
  }finally{await db.close();}
});
