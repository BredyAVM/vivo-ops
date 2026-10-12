import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const actor = '00000000-0000-0000-0000-000000000001';
const migration = '../../supabase/migrations/20261012165813_crm_reopen_and_audience_revision.sql';

async function setup() {
  const db = new PGlite();
  await db.exec(read('./fixtures/audience-revision-schema.sql'));
  await db.exec(`
    create function app_private.crm_offer_rest_bounds_v1(jsonb,timestamptz) returns boolean language sql as $$select true$$;
    create function app_private.crm_had_excluded_offer_v1(bigint,timestamptz,jsonb) returns boolean language sql as $$select false$$;
    create function app_private.crm_purchased_product_ids_v1(jsonb) returns bigint[] language sql as $$select '{}'::bigint[]$$;
    create function app_private.crm_clients_with_products_v1(jsonb,timestamptz) returns table(client_id bigint,matched_product_ids bigint[]) language sql as $$select id,'{}'::bigint[] from public.clients$$;
    create function app_private.crm_play_has_overlap_conflict_v1(bigint,bigint) returns boolean language sql as $$select $2=7$$;
    create function public.crm_client_metrics_v1(integer,timestamptz) returns table(client_id bigint,first_purchase_on date,last_purchase_on date,
      purchase_count integer,net_revenue_usd numeric,average_ticket_usd numeric,cadence_days numeric,cadence_window_used integer,
      last_advisor_id uuid,last_advisor_name_snapshot text,last_gift_on date,days_since_last_purchase integer,used_pickup boolean,used_delivery boolean)
    language sql as $$select id,'2024-01-01'::date,'2026-10-01'::date,case when id in (1,5,6,7) then 5 else 1 end,100::numeric,
      20::numeric,30::numeric,6,'${actor}'::uuid,'Advisor',null::date,11,true,false from public.clients$$;
    create function app_private.crm_refresh_published_play_summary_v1(p_play_id bigint) returns jsonb language plpgsql as $$begin
      perform set_config('app.crm_play_amendment_context','published_summary',true);
      update public.crm_plays set selection_summary=jsonb_build_object('total',(select count(*) from public.crm_play_members where play_id=p_play_id and workflow_status<>'removed')) where id=p_play_id;
      return '{}'::jsonb; end;$$;
    insert into profiles values('${actor}','Test Advisor',true);
    insert into user_roles values('${actor}','admin'),('${actor}','advisor');
    select set_config('request.jwt.claim.sub','${actor}',false);
    insert into clients select n,'Client '||n,true,'${actor}'::uuid from generate_series(1,7) n;
    insert into crm_plays(series_key,name,status,starts_at,ends_at,created_by_user_id,rules_snapshot)
      values('private','Private','draft','2026-10-01','2099-11-01','${actor}','{"play_type":"new_client"}'),
            ('shared','Shared','draft','2026-10-01','2099-11-01','${actor}','{"play_type":"loyalty"}');
    insert into crm_play_benefits(play_id,product_id,quantity,sort_order) values(1,100,1,1),(2,100,1,1);
    insert into crm_play_members(play_id,client_id,advisor_id_snapshot,eligible_at,purchase_count) values(1,1,'${actor}',now(),5);
    insert into crm_play_members(play_id,client_id,advisor_id_snapshot,eligible_at,purchase_count) select 2,n,'${actor}',now(),20 from generate_series(1,5) n;
    update crm_plays set status='frozen',snapshot_at=now() where id in (1,2);
    update crm_plays set status='active',activated_at=now(),activated_by_user_id='${actor}' where id=2;
    update crm_play_members set contacted_at='2026-10-05',play_launched_at='2026-10-06',workflow_status='launched' where play_id=2 and client_id in (1,2);
    update crm_play_members set benefit_status='redeemed' where play_id=2 and client_id=3;
    update crm_play_members set benefit_status='reserved' where play_id=2 and client_id=4;
    update crm_play_members set workflow_status='removed',benefit_status='cancelled' where play_id=2 and client_id=5;
    insert into crm_play_member_events select 1,id,'play_launched',now(),'${actor}' from crm_play_members where play_id=2 and client_id=2;
    insert into crm_play_redemptions select 1,id,'redeemed',123,now(),'${actor}' from crm_play_members where play_id=2 and client_id=3;
    insert into order_items select 1,id from crm_play_members where play_id=2 and client_id=4;
  `);
  await db.exec(read(migration));
  return db;
}
const rules = { min_purchase_count: 3, include_never_gifted: true, offer_rest_mode: 'none' };
async function preview(db) {
  return (await db.query('select crm_revise_play_audience_v1(2,$1::jsonb) v', [JSON.stringify(rules)])).rows[0].v;
}

test('private confirmed cut reopens with audit; shared or used cuts cannot become destructive drafts', async () => {
  const db = await setup();
  try {
    await assert.rejects(() => db.exec("update crm_plays set status='draft' where id=1"), /Invalid CRM play status/);
    await db.query('select crm_reopen_unshared_play_v1(1,$1)', ['Adjust private definition']);
    assert.equal((await db.query('select status from crm_plays where id=1')).rows[0].status, 'draft');
    await assert.rejects(() => db.query('select crm_confirm_play_v1(1)'), /Vuelve a probar/);
    assert.equal((await db.query('select count(*) n from crm_play_members where play_id=1')).rows[0].n, 1);
    assert.equal((await db.query("select count(*) n from crm_play_amendments where amendment_type='design_reopened'")).rows[0].n, 1);
    await assert.rejects(() => db.query('select crm_reopen_unshared_play_v1(2,$1)', ['Unsafe shared reopen']), /aún no compartida/);
    await db.exec("update crm_plays set status='frozen',snapshot_at=now() where id=1; insert into order_items select 2,id from crm_play_members where play_id=1;");
    await assert.rejects(() => db.query('select crm_reopen_unshared_play_v1(1,$1)', ['Unsafe private reopen']), /conservarse su historial/);
  } finally { await db.close(); }
});

test('published preview changes nothing; apply preserves IDs, snapshots, follow-up, reservations and deliveries', async () => {
  const db = await setup();
  try {
    const before = (await db.query('select * from crm_play_members order by id')).rows;
    const p = await preview(db);
    assert.equal(p.added, 1); assert.equal(p.removed, 1); assert.equal(p.protected, 2); assert.equal(p.total, 4);
    assert.deepEqual(p.clients.map(x => [x.client_id, x.action]), [[1,'keep'],[2,'remove'],[3,'protected'],[4,'protected'],[6,'add']]);
    assert.deepEqual((await db.query('select * from crm_play_members order by id')).rows, before);
    assert.equal((await db.query('select count(*) n from crm_play_amendments')).rows[0].n, 0);
    await db.query('select crm_revise_play_audience_v1(2,$1::jsonb,true,$2,$3)', [JSON.stringify(rules),p.token,'Adjust clients and filters']);
    const after = (await db.query('select * from crm_play_members order by id')).rows;
    for (const old of before.filter(x => x.play_id===2 && [1,3,4,5].includes(x.client_id))) assert.deepEqual(after.find(x=>x.id===old.id), old);
    const removed = after.find(x=>x.play_id===2 && x.client_id===2);
    assert.equal(removed.workflow_status,'removed'); assert.equal(removed.benefit_status,'cancelled');
    assert.deepEqual(removed.play_launched_at,before.find(x=>x.id===removed.id).play_launched_at);
    assert.equal((await db.query('select count(*) n from crm_play_member_events')).rows[0].n,1);
    assert.equal((await db.query('select count(*) n from crm_play_redemptions')).rows[0].n,1);
    const p2 = await preview(db); assert.equal(p2.added,0); assert.equal(p2.removed,0);
    assert.equal((await db.query('select status from crm_plays where id=2')).rows[0].status,'active');
    assert.equal((await db.query("select new_values->>'added' n from crm_play_amendments where amendment_type='audience_revised'")).rows[0].n,'1');
    await assert.rejects(()=>db.exec("update crm_plays set rules_snapshot='{}' where id=2"), /immutable/);
  } finally { await db.close(); }
});

test('stale preview, missing reason, invalid filters, closed campaigns and non-admin requests are rejected', async () => {
  const db = await setup();
  try {
    const p = await preview(db);
    await db.exec("update crm_play_members set last_note='New follow-up' where play_id=2 and client_id=1");
    await assert.rejects(()=>db.query('select crm_revise_play_audience_v1(2,$1::jsonb,true,$2,$3)',[JSON.stringify(rules),p.token,'A valid reason']),/Vuelve a probar/);
    assert.equal((await db.query('select count(*) n from crm_play_amendments')).rows[0].n,0);
    const fresh=await preview(db);
    await assert.rejects(()=>db.query('select crm_revise_play_audience_v1(2,$1::jsonb,true,$2,$3)',[JSON.stringify(rules),fresh.token,'']),/motivo/);
    await assert.rejects(()=>db.query('select crm_revise_play_audience_v1(2,$1::jsonb)',[JSON.stringify({min_purchase_count:5,max_purchase_count:1})]),/Maximum purchases/);
    for (const signature of ['crm_reopen_unshared_play_v1(bigint,text)','crm_revise_play_audience_v1(bigint,jsonb,boolean,text,text)']) {
      assert.equal((await db.query(`select has_function_privilege('anon','public.${signature}','execute') v`)).rows[0].v,false);
    }
    await db.exec("delete from user_roles where role='admin';insert into user_roles values('00000000-0000-0000-0000-000000000001','master')");
    await assert.rejects(()=>preview(db),/Solo el administrador/);
    await assert.rejects(()=>db.query('select crm_reopen_unshared_play_v1(1,$1)',['A valid reason']),/Solo el administrador/);
    await db.exec("insert into user_roles values('00000000-0000-0000-0000-000000000001','admin');update crm_plays set status='closed',closed_at=now() where id=2");
    await assert.rejects(()=>preview(db),/compartida o pausada/);
  } finally { await db.close(); }
});

test('UI uses explicit preview/apply controls and admin-only reopening; API never feeds a published cut into draft deletion', () => {
  const ui=read('../../src/app/app/master/plays/MasterPlaysClient.tsx');
  const actions=read('../../src/app/app/master/plays/actions.ts');
  assert.match(ui,/Volver al diseño/); assert.match(ui,/Probar ajustes de la lista/);
  assert.match(ui,/Aplicar ajustes a la publicación/); assert.match(ui,/roles.includes\('admin'\)/);
  assert.match(actions,/requireAdminContext/); assert.match(actions,/crm_revise_play_audience_v1/);
});
