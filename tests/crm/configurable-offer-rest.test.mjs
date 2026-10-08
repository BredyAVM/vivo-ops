import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFileSync(new URL(path,import.meta.url),'utf8').replaceAll('\r\n','\n');
const code = ts.transpileModule(read('../../src/lib/crm/offer-rest.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const helper = {};
new Function('exports',code)(helper);

test('configurable rest serializes one mode, validates calendar dates and renders the selected condition',()=>{
  assert.deepEqual(helper.offerRestRules({offerRestMode:'none',offerRestDays:30,offerRestFrom:'invalid'}),{offer_rest_mode:'none',offer_rest_days:null,offer_rest_from:'',offer_rest_to:''});
  assert.equal(helper.offerRestRules({}).offer_rest_mode,'previous_month');
  assert.equal(helper.offerRestRules({offerRestMode:'days',offerRestDays:60}).offer_rest_days,60);
  for (const days of [0,-1,1.5,3651,NaN]) assert.throws(()=>helper.offerRestRules({offerRestMode:'days',offerRestDays:days}));
  for (const from of ['2026-02-30','2026-13-01','2026-09-31','not a date']) assert.throws(()=>helper.offerRestRules({offerRestMode:'dates',offerRestFrom:from,offerRestTo:'2026-10-01'}));
  assert.throws(()=>helper.offerRestRules({offerRestMode:'dates',offerRestFrom:'2026-10-02',offerRestTo:'2026-10-01'}));
  assert.equal(helper.offerRestRules({offerRestMode:'dates',offerRestFrom:'2024-02-29',offerRestTo:'2024-02-29'}).offer_rest_from,'2024-02-29');
  assert.equal(helper.offerRestLabel({offer_rest_mode:'none'},null),null);
  assert.match(helper.offerRestLabel({offer_rest_mode:'days',offer_rest_days:45},null),/45 días anteriores al inicio/);
  assert.match(helper.offerRestLabel({offer_rest_mode:'dates',offer_rest_from:'2026-09-01',offer_rest_to:'2026-09-30'},null),/01\/09\/2026 al 30\/09\/2026/);
  assert.equal(helper.offerRestLabel({},'2026-09-01T04:00Z'),null);
});

test('real SQL: configurable preview, inclusive dates, Venezuela day boundaries, none, stale confirmation, manual inclusion and next-month copy',async()=>{
  const db=new PGlite(); const actor='00000000-0000-0000-0000-000000000001';
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create schema app_private;create schema auth;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function is_master_or_admin() returns boolean language sql as $$select auth.uid() is not null$$;
      create function app_private.crm_play_has_overlap_conflict_v1(bigint,bigint) returns boolean language sql as $$select false$$;
      select set_config('request.jwt.claim.sub','${actor}',false);
      create table profiles(id uuid primary key,full_name text,is_active boolean default true);
      create table user_roles(user_id uuid,role text);
      insert into profiles values('${actor}','Test Advisor',true);
      insert into user_roles values('${actor}','advisor'),('${actor}','admin');
      create table clients(id bigint primary key,full_name text,is_active boolean default true,primary_advisor_id uuid default '${actor}');
      insert into clients(id,full_name) select n,'Client '||n from generate_series(1,8) n;
      create table crm_plays(id bigint primary key,name text,status text,starts_at timestamptz,ends_at timestamptz,
        rules_snapshot jsonb default '{}',metric_window integer default 6,selection_summary jsonb,
        benefit_recurrence_mode text default 'once',benefit_fulfillment text default 'any',created_by_user_id uuid default '${actor}');
      create table crm_play_benefits(id bigint,play_id bigint);
      create table crm_play_benefit_upgrades(id bigint,play_id bigint);
      create table crm_play_redemptions(id bigint,play_member_id bigint,status text);
      create table crm_play_member_events(id bigint,play_member_id bigint,event_type text);
      create table crm_play_amendments(play_id bigint,amendment_type text,client_id bigint,advisor_id_snapshot uuid,previous_values jsonb,new_values jsonb,reason text,created_by_user_id uuid);
      create table crm_play_members(id bigint generated always as identity primary key,play_id bigint,client_id bigint,
        advisor_id_snapshot uuid,eligible_at timestamptz,workflow_status text default 'pending',benefit_status text default 'available',
        first_purchase_on date,last_purchase_on date,purchase_count integer,net_revenue_usd numeric,average_ticket_usd numeric,
        cadence_days numeric,cadence_window integer,last_advisor_id uuid,last_advisor_name_snapshot text,last_gift_on date,
        days_since_last_purchase integer,used_pickup boolean,used_delivery boolean,decision_snapshot jsonb,eligibility_reasons text[],play_launched_at timestamptz);
      create index crm_members_client_launch_time_idx on crm_play_members(client_id,play_launched_at) where play_launched_at is not null;
      create function crm_client_metrics_v1(integer,timestamptz) returns table(client_id bigint,first_purchase_on date,last_purchase_on date,
        purchase_count integer,net_revenue_usd numeric,average_ticket_usd numeric,cadence_days numeric,cadence_window_used integer,
        last_advisor_id uuid,last_advisor_name_snapshot text,last_gift_on date,days_since_last_purchase integer,used_pickup boolean,used_delivery boolean)
      language sql as $$select id,'2024-01-01'::date,'2026-09-20'::date,30,300::numeric,10::numeric,30::numeric,6,'${actor}'::uuid,'Advisor',null::date,10,true,false from public.clients$$;`);
    await db.exec(read('./fixtures/configurable-rest-installed-functions.sql'));
    await db.exec(`create trigger crm_play_monthly_rest_guard before update on crm_plays for each row execute function app_private.crm_play_monthly_rest_guard_v1();`);
    await db.exec(read('../../supabase/migrations/20261008121045_crm_configurable_offer_rest.sql'));
    await db.exec(`insert into crm_plays(id,name,status,starts_at,ends_at) values(100,'History','closed','2026-09-01T04:00Z','2026-10-01T04:00Z'),(200,'Target','draft','2026-10-08T04:00Z','2099-11-01T04:00Z');
      insert into crm_play_benefits values(1,200);
      insert into crm_play_members(play_id,client_id,play_launched_at,workflow_status) values
      (100,1,'2026-09-08T04:00Z','launched'),(100,2,null,'contacted'),
      (100,3,'2026-09-08T03:59:59Z','launched'),(100,4,'2026-10-08T03:59:59.999999Z','removed'),
      (100,5,'2026-10-08T04:00Z','launched'),(100,6,'2026-08-20T12:00Z','launched'),
      (100,7,'2026-09-20T12:00Z','removed'),(100,8,null,'pending');`);
    const preview=async rules=>{
      await db.query("update crm_plays set rules_snapshot=$1::jsonb,status='draft' where id=200",[JSON.stringify(rules)]);
      await db.query('select crm_rebuild_play_members_v1(200)');
      return (await db.query('select client_id from crm_play_members where play_id=200 order by client_id')).rows.map(x=>Number(x.client_id));
    };
    // Legacy campaigns keep September as a calendar month, not 30 days.
    assert.deepEqual(await preview({}),[2,4,5,6,8]);
    assert.deepEqual(await preview({offer_rest_mode:'days',offer_rest_days:30}),[2,3,5,6,8]);
    assert.deepEqual(await preview({offer_rest_mode:'dates',offer_rest_from:'2026-09-08',offer_rest_to:'2026-10-07'}),[2,3,5,6,8]);
    // Both ends of a single-day interval are included through microseconds.
    assert.deepEqual(await preview({offer_rest_mode:'dates',offer_rest_from:'2026-10-07',offer_rest_to:'2026-10-07'}),[1,2,3,5,6,7,8]);
    assert.deepEqual(await preview({offer_rest_mode:'none'}),[1,2,3,4,5,6,7,8]);
    await preview({offer_rest_mode:'days',offer_rest_days:30});
    await db.exec('insert into crm_play_members(play_id,client_id) values(200,1)');
    await assert.rejects(()=>db.query('select crm_confirm_play_v1(200)'),/período de descanso seleccionado/);
    await assert.rejects(()=>db.exec("update crm_plays set status='active' where id=200"),/período de descanso seleccionado/);
    await db.exec('delete from crm_play_members where play_id=200 and client_id=1');
    await db.exec("update crm_plays set status='active' where id=200");
    await assert.rejects(()=>db.query('select crm_add_manual_play_member_v1(200,1,$1,$2)',[actor,'Manual inclusion requested']),/período de descanso seleccionado/);
    // Settings are validated on direct updates, independently of UI or list size.
    for (const rules of [{offer_rest_mode:'bad'},{offer_rest_mode:'days',offer_rest_days:0},{offer_rest_mode:'days',offer_rest_days:2.5},{offer_rest_mode:'dates',offer_rest_from:'2026-02-30',offer_rest_to:'2026-03-01'},{offer_rest_mode:'dates',offer_rest_from:'2026-10-08',offer_rest_to:'2026-10-07'}]) {
      await assert.rejects(()=>db.query('update crm_plays set rules_snapshot=$1::jsonb where id=200',[JSON.stringify(rules)]));
    }
    for (const sig of ['crm_offer_rest_bounds_v1(jsonb,timestamptz)','crm_had_excluded_offer_v1(bigint,timestamptz,jsonb)']) {
      assert.equal((await db.query(`select has_function_privilege('authenticated','app_private.${sig}','execute') v`)).rows[0].v,false);
    }
    // Exercise the real v3 month-shift function with a minimal v2 clone adapter.
    await db.exec(`create or replace function crm_clone_play_v2(p_source_play_id bigint,p_name text default null) returns jsonb language plpgsql as $$
      declare new_id bigint;begin select coalesce(max(id),0)+1 into new_id from public.crm_plays;
      insert into public.crm_plays(id,name,status,starts_at,ends_at,rules_snapshot) select new_id,coalesce(p_name,name),'draft',starts_at,ends_at,rules_snapshot from public.crm_plays where id=p_source_play_id;
      return jsonb_build_object('play_id',new_id);end;$$;
      update crm_plays set rules_snapshot='{"offer_rest_mode":"dates","offer_rest_from":"2026-09-01","offer_rest_to":"2026-09-30"}' where id=200;`);
    const copy=(await db.query('select crm_clone_play_v3(200,null,1) v')).rows[0].v;
    const copied=(await db.query('select rules_snapshot,status from crm_plays where id=$1',[copy.play_id])).rows[0];
    assert.equal(copied.rules_snapshot.offer_rest_from,'2026-10-01');
    assert.equal(copied.rules_snapshot.offer_rest_to,'2026-10-31');
    assert.equal(copied.status,'draft');
    const same=(await db.query('select crm_clone_play_v3(200,null,0) v')).rows[0].v;
    assert.equal((await db.query('select rules_snapshot from crm_plays where id=$1',[same.play_id])).rows[0].rules_snapshot.offer_rest_from,'2026-09-01');
    await db.exec("select set_config('request.jwt.claim.sub','',false)");
    await assert.rejects(()=>db.query('select crm_rebuild_play_members_v1(200)'),/access is required/);
    await assert.rejects(()=>db.query('select crm_clone_play_v3(200,null,1)'),/access is required/);
  } finally {await db.close();}
});
