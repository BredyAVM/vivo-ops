import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const advisor = '00000000-0000-0000-0000-000000000001';
const admin = '00000000-0000-0000-0000-000000000002';
const master = '00000000-0000-0000-0000-000000000003';
const outsider = '00000000-0000-0000-0000-000000000004';
async function asUser(db, user) { await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]); }
const request = (db, member = 1) => db.query('select crm_request_play_no_apply_v1($1,$2,$3) v', [member, 'criteria_mismatch', 'El cliente no cumple la condición documentada.']);
const review = (db, id, approve = true) => db.query('select crm_review_play_no_apply_v1($1,$2,$3) v', [id, approve, 'Verificado por administración con evidencia.']);
async function setup() {
  const db = new PGlite();
  await db.exec(read('./fixtures/audience-revision-schema.sql'));
  await db.exec(`
    alter table order_items add column order_id bigint;
    alter table crm_play_member_events add column from_status text, add column to_status text, add column note text;
    alter table crm_play_member_events alter column id set not null;
    alter table crm_play_member_events alter column id add generated always as identity;
    alter table crm_play_amendments drop constraint crm_play_amendments_type_check;
    create table crm_play_member_benefit_selections(play_member_id bigint);
    create function app_private.crm_refresh_published_play_summary_v1(p_play_id bigint) returns jsonb language plpgsql as $$begin
      perform set_config('app.crm_play_amendment_context','published_summary',true);
      update public.crm_plays set selection_summary=jsonb_build_object('total',(select count(*) from public.crm_play_members where play_id=p_play_id and workflow_status<>'removed')) where id=p_play_id;
      return '{}'::jsonb; end;$$;
    insert into profiles values('${advisor}','Advisor',true),('${admin}','Admin',true),('${master}','Master',true),('${outsider}','Other',true);
    insert into user_roles values('${advisor}','advisor'),('${admin}','admin'),('${master}','master'),('${outsider}','advisor');
    insert into clients select n,'Client '||n,true,'${advisor}'::uuid from generate_series(1,6) n;
    insert into crm_plays(name,status,starts_at,ends_at,created_by_user_id) values('Test','draft',now()-interval '1 day',now()+interval '1 month','${admin}');
    insert into crm_play_members(play_id,client_id,advisor_id_snapshot,purchase_count,decision_snapshot)
      select 1,n,'${advisor}',15,'{"original":true}' from generate_series(1,6) n;
    update crm_plays set status='frozen',snapshot_at=now() where id=1;
    update crm_plays set status='active',activated_at=now(),activated_by_user_id='${admin}' where id=1;
    update crm_play_members set contacted_at=now(),responded_at=now(),play_launched_at=now(),workflow_status='launched' where id=1;
    update crm_play_members set benefit_status='reserved' where id=3;
    update crm_play_members set benefit_status='redeemed' where id=4;
    insert into orders values(77,'created'); insert into order_items values(7,5,77);
    grant usage on schema public,auth to authenticated,anon;
    grant select on user_roles to authenticated;
  `);
  const source = read('../../supabase/migrations/20260909152336_crm_play_published_amendments_v1.sql');
  const removal = source.match(/create or replace function public\.crm_remove_published_play_member_v1\([\s\S]*?\n\$\$;/)[0];
  await db.exec(removal);
  await db.exec(read('../../supabase/migrations/20261012202958_crm_no_apply_requests.sql'));
  await asUser(db, advisor);
  return db;
}

test('pending leaves original snapshot, milestones and denominator unchanged; only admin approval excludes', async () => {
  const db = await setup();
  try {
    const before = (await db.query('select to_jsonb(m) v from crm_play_members m where id=1')).rows[0].v;
    const id = (await request(db)).rows[0].v.request_id;
    assert.deepEqual((await db.query('select to_jsonb(m) v from crm_play_members m where id=1')).rows[0].v, before);
    await assert.rejects(() => request(db), /pendiente/);
    await asUser(db, master); await assert.rejects(() => review(db, id), /Solo el administrador/);
    await asUser(db, advisor); await assert.rejects(() => review(db, id), /Solo el administrador/);
    await asUser(db, admin); await review(db, id);
    const after = (await db.query('select * from crm_play_members where id=1')).rows[0];
    assert.equal(after.workflow_status, 'removed');
    assert.deepEqual(after.decision_snapshot, before.decision_snapshot);
    assert.equal(after.purchase_count, 15);
    assert.ok(after.contacted_at && after.responded_at && after.play_launched_at);
    assert.equal((await db.query("select count(*)::int n from crm_play_members where workflow_status <> 'removed'")).rows[0].n, 5);
    assert.equal((await db.query('select selection_summary from crm_plays where id=1')).rows[0].selection_summary.total, 5);
    assert.equal((await db.query('select count(*)::int n from crm_play_member_events where play_member_id=1')).rows[0].n, 2);
    await assert.rejects(() => review(db, id), /ya fue resuelta/);
    await assert.rejects(() => db.exec('delete from crm_play_no_apply_requests'), /no se puede borrar/);
    await assert.rejects(() => db.exec("update crm_play_no_apply_requests set justification='Changed original justification'"), /inmutables/);
  } finally { await db.close(); }
});

test('rejection stays evaluable and allows a new justified request; legacy bypass and ownership blocked', async () => {
  const db = await setup();
  try {
    await asUser(db, outsider); await assert.rejects(() => request(db), /no pertenece/);
    await asUser(db, master); await assert.rejects(() => request(db), /Solo el asesor/);
    await asUser(db, advisor);
    await assert.rejects(() => db.query("select crm_request_play_no_apply_v1(1,'no_response','No respondió al mensaje')"), /motivo/);
    await assert.rejects(() => db.query("select crm_request_play_no_apply_v1(1,'other',' ')"), /motivo/);
    await assert.rejects(() => db.exec("update crm_play_members set workflow_status='not_applicable' where id=1"), /aprobación/);
    const id = (await request(db)).rows[0].v.request_id;
    await asUser(db, admin); await review(db, id, false);
    assert.equal((await db.query('select workflow_status from crm_play_members where id=1')).rows[0].workflow_status, 'launched');
    await asUser(db, advisor); assert.ok((await request(db)).rows[0].v.request_id > id);
  } finally { await db.close(); }
});

test('delivered gifts cannot request; reservations and gifts still in orders cannot be excluded', async () => {
  const db = await setup();
  try {
    await assert.rejects(() => request(db, 4), /ya recibió/);
    for (const member of [3,5]) {
      await asUser(db, advisor); const id = (await request(db, member)).rows[0].v.request_id;
      await asUser(db, admin); await assert.rejects(() => review(db, id), /pedido o ya se entregó/);
      assert.equal((await db.query('select status from crm_play_no_apply_requests where id=$1', [id])).rows[0].status, 'pending');
    }
    await db.exec("update orders set status='cancelled' where id=77");
    const id = (await db.query('select id from crm_play_no_apply_requests where play_member_id=5')).rows[0].id;
    await review(db,id);
    assert.equal((await db.query('select workflow_status from crm_play_members where id=5')).rows[0].workflow_status,'removed');
  } finally { await db.close(); }
});

test('table has read-only owner RLS; anonymous and direct mutations cannot bypass RPC review', async () => {
  const db = await setup();
  try {
    await request(db);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select count(*)::int n from crm_play_no_apply_requests')).rows[0].n,1);
    await assert.rejects(() => db.exec("update crm_play_no_apply_requests set status='approved'"), /permission denied/);
    await assert.rejects(() => db.exec('delete from crm_play_no_apply_requests'), /permission denied/);
    await asUser(db,outsider);
    assert.equal((await db.query('select count(*)::int n from crm_play_no_apply_requests')).rows[0].n,0);
    await asUser(db,admin);
    assert.equal((await db.query('select count(*)::int n from crm_play_no_apply_requests')).rows[0].n,1);
    await db.exec('reset role; set role anon');
    await assert.rejects(() => request(db), /permission denied/);
    await assert.rejects(() => review(db,1), /permission denied/);
  } finally { await db.close(); }
});
