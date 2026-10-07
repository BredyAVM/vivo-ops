import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const readSql = path => readFileSync(new URL(path,import.meta.url),'utf8').replaceAll('\r\n','\n');
test('monthly rest: real preview excludes offers, not greetings; Caracas bounds, all plays, confirmation and manual inclusion',async()=>{
  const db=new PGlite();
  const actor='00000000-0000-0000-0000-000000000001';
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
      create table crm_plays(id bigint primary key,status text,starts_at timestamptz,ends_at timestamptz,rules_snapshot jsonb default '{}',metric_window integer default 6,selection_summary jsonb,created_by_user_id uuid default '${actor}');
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
      create function crm_client_metrics_v1(integer,timestamptz) returns table(client_id bigint,first_purchase_on date,last_purchase_on date,
        purchase_count integer,net_revenue_usd numeric,average_ticket_usd numeric,cadence_days numeric,cadence_window_used integer,
        last_advisor_id uuid,last_advisor_name_snapshot text,last_gift_on date,days_since_last_purchase integer,used_pickup boolean,used_delivery boolean)
      language sql as $$select id,'2024-01-01'::date,'2026-09-20'::date,30,300::numeric,10::numeric,30::numeric,6,'${actor}'::uuid,'Advisor',null::date,10,true,false from public.clients$$;
    `);
    await db.exec(readSql('./fixtures/monthly-rest-installed-functions.sql'));
    await db.exec(readSql('../../supabase/migrations/20261007191322_crm_previous_month_offer_exclusion.sql'));
    await db.exec(`insert into crm_plays(id,status,starts_at,ends_at) values(100,'closed','2026-09-01T04:00Z','2026-10-01T04:00Z'),(200,'draft','2026-10-05T04:00Z','2099-11-01T04:00Z');
      insert into crm_play_benefits values(1,200);
      insert into crm_play_members(play_id,client_id,play_launched_at,workflow_status) values
      (100,1,'2026-09-12T12:00Z','launched'),(100,2,null,'contacted'),
      (100,3,'2026-09-01T03:59:59Z','launched'),(100,4,'2026-10-01T03:59:59Z','launched'),
      (100,5,'2026-10-01T04:00Z','launched'),(100,6,'2026-08-20T12:00Z','launched'),
      (100,7,'2026-09-20T12:00Z','removed'),(100,8,null,'pending');`);
    await db.query('select crm_rebuild_play_members_v1(200)');
    const candidates=(await db.query('select client_id from crm_play_members where play_id=200 order by client_id')).rows.map(x=>Number(x.client_id));
    assert.deepEqual(candidates,[2,3,5,6,8]);
    assert.equal((await db.query("select app_private.crm_had_previous_month_offer_v1(1,'2026-10-31T23:00Z') v")).rows[0].v,true);
    assert.equal((await db.query("select app_private.crm_had_previous_month_offer_v1(1,'2026-11-01T04:00Z') v")).rows[0].v,false);
    // January consults December, not an approximate rolling 30-day window.
    await db.exec("insert into crm_play_members(play_id,client_id,play_launched_at) values(100,1,'2026-12-31T23:00Z')");
    assert.equal((await db.query("select app_private.crm_had_previous_month_offer_v1(1,'2027-01-05T04:00Z') v")).rows[0].v,true);
    // An outdated preview cannot be confirmed or directly published.
    await db.exec('insert into crm_play_members(play_id,client_id) values(200,1)');
    await assert.rejects(()=>db.query('select crm_confirm_play_v1(200)'),/mes anterior/);
    await assert.rejects(()=>db.exec("update crm_plays set status='active' where id=200"),/mes anterior/);
    await db.exec('delete from crm_play_members where play_id=200 and client_id=1');
    await db.exec("update crm_plays set status='active' where id=200");
    await assert.rejects(()=>db.query('select crm_add_manual_play_member_v1(200,1,$1,$2)',[actor,'Manual inclusion requested']),/descansar este mes/);
    // Daily repeat in THIS month is not a previous-month offer.
    assert.equal((await db.query("select app_private.crm_had_previous_month_offer_v1(5,'2026-10-05T04:00Z') v")).rows[0].v,false);
    assert.equal((await db.query("select has_function_privilege('authenticated','app_private.crm_had_previous_month_offer_v1(bigint,timestamptz)','execute') v")).rows[0].v,false);
    await db.exec("select set_config('request.jwt.claim.sub','',false)");
    await assert.rejects(()=>db.query('select crm_rebuild_play_members_v1(200)'),/access is required/);
    // Batch correction must finish EVERY candidate even when each removal
    // updates the shared parent summary. History and costs are not regenerated.
    await db.exec(`select set_config('request.jwt.claim.sub','${actor}',false);
      create function crm_refresh_play_preview_summary_v1(p_id bigint) returns jsonb language plpgsql as $$
      declare summary jsonb;begin
        select jsonb_build_object('total',count(*)) into summary from public.crm_play_members where play_id=p_id;
        update public.crm_plays set selection_summary=summary where id=p_id;
        return summary;end;$$;
      insert into crm_plays(id,status,starts_at) values(300,'draft','2026-10-07T04:00Z');
      insert into crm_play_members(play_id,client_id,play_launched_at)
        select 100,n,'2026-09-20T12:00Z' from generate_series(101,120) n;
      insert into crm_play_members(play_id,client_id)
        select 300,n from generate_series(101,120) n;`);
    const correction=readSql('../../supabase/migrations/20261007192039_crm_finish_monthly_rest_correction.sql');
    await db.exec(correction);
    assert.equal((await db.query('select count(*)::int n from crm_play_members where play_id=300')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from crm_play_amendments where play_id=300')).rows[0].n,20);
    assert.equal((await db.query('select count(*)::int n from crm_play_members where play_id=100 and client_id>=101')).rows[0].n,20);
    await db.exec(correction);
    assert.equal((await db.query('select count(*)::int n from crm_play_amendments where play_id=300')).rows[0].n,20);
  } finally {await db.close();}
});
