import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const repair = readFileSync(new URL('../../supabase/migrations/20261016142247_crm_lc_october_advisor_cost_correction.sql', import.meta.url), 'utf8');
async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema app_private;
    create table crm_plays(id bigint primary key,name text,status text,starts_at timestamptz,selection_summary jsonb default '{}');
    create table crm_play_benefits(id bigint primary key,play_id bigint references crm_plays,quantity numeric,
      product_name_snapshot text,unit_benefit_value_usd numeric,unit_advisor_cost_usd numeric,
      unit_company_cost_usd numeric,unit_budget_cost_usd numeric,
      check(unit_benefit_value_usd=unit_advisor_cost_usd+unit_company_cost_usd),
      check(unit_budget_cost_usd=unit_company_cost_usd));
    create table crm_play_redemptions(id bigint primary key,play_benefit_id bigint,order_id bigint,
      status text,quantity numeric,redeemed_at timestamptz,unit_benefit_value_usd numeric,
      benefit_value_usd numeric,unit_advisor_cost_usd numeric,advisor_charge_usd numeric,
      unit_company_cost_usd numeric,company_cost_usd numeric,
      check(benefit_value_usd=advisor_charge_usd+company_cost_usd));
    create table orders(id bigint primary key,attributed_advisor_id uuid,status text,total_usd numeric);
    create table advisor_commission_periods(id bigint primary key,date_from date,date_to date);
    create table advisor_commission_closures(id bigint primary key,advisor_user_id uuid,period_id bigint,status text,snapshot jsonb);
    create function app_private.crm_play_amendment_immutable_v1() returns trigger language plpgsql as $$begin raise exception 'immutable audit'; end;$$;
    create function app_private.crm_play_benefit_guard_v2() returns trigger language plpgsql as $$begin raise exception 'immutable benefit'; end;$$;
    create function app_private.crm_play_redemption_guard_v1() returns trigger language plpgsql as $$begin raise exception 'immutable redemption'; end;$$;
    create function app_private.crm_refresh_published_play_summary_v1(p_id bigint) returns jsonb language plpgsql as $$begin
      update crm_plays set selection_summary=(select jsonb_build_object('advisor',unit_advisor_cost_usd,'company',unit_company_cost_usd) from crm_play_benefits where play_id=p_id) where id=p_id;
      return '{}'::jsonb; end;$$;
    insert into crm_plays values(71,'LC · clientes perdidos · octubre de 2026','active','2026-10-09T04:00Z','{}'),
      (72,'LC · clientes perdidos · septiembre de 2026','closed','2026-09-09T04:00Z','{}');
    insert into crm_play_benefits values(81,71,1,'Single Pack (6 und)',4,1.50,2.50,2.50),(82,72,1,'Single Pack (6 und)',4,1.50,2.50,2.50);
    insert into orders values(91,'00000000-0000-0000-0000-000000000001','delivered',20),(92,'00000000-0000-0000-0000-000000000001','queued',10);
    insert into crm_play_redemptions values(101,81,91,'redeemed',1,'2026-10-15T20:00Z',4,4,1.50,1.50,2.50,2.50),
      (102,81,92,'reserved',1,null,4,4,1.50,1.50,2.50,2.50),(103,82,91,'redeemed',1,'2026-09-15T20:00Z',4,4,1.50,1.50,2.50,2.50),
      (104,81,91,'voided',1,'2026-10-14T20:00Z',4,4,1.50,1.50,2.50,2.50);
    insert into advisor_commission_periods values(111,'2026-10-01','2026-10-15');
    insert into advisor_commission_closures values(121,'00000000-0000-0000-0000-000000000001',111,'preliminary','{"cached":true}');
    create trigger crm_play_benefits_guard before update or delete on crm_play_benefits for each row execute function app_private.crm_play_benefit_guard_v2();
    create trigger crm_play_redemptions_guard before update or delete on crm_play_redemptions for each row execute function app_private.crm_play_redemption_guard_v1();`);
  return db;
}
test('LC maintenance corrects only active economics, retains all evidence and restores protections', async () => {
  const db=await setup();
  try {
    const orders=(await db.query('select * from orders order by id')).rows;
    const closures=(await db.query('select * from advisor_commission_closures')).rows;
    await db.exec('begin;'+repair+'commit;');
    assert.deepEqual((await db.query('select * from orders order by id')).rows,orders);
    assert.deepEqual((await db.query('select * from advisor_commission_closures')).rows,closures);
    const uses=(await db.query('select id,status,advisor_charge_usd,company_cost_usd from crm_play_redemptions order by id')).rows;
    assert.deepEqual(uses.map(r=>[r.status,Number(r.advisor_charge_usd),Number(r.company_cost_usd)]),
      [['redeemed',.75,3.25],['reserved',.75,3.25],['redeemed',1.5,2.5],['voided',1.5,2.5]]);
    const audit=(await db.query('select * from app_private.crm_play_cost_corrections')).rows[0];
    assert.equal(audit.previous_values.redemptions.length,2);
    assert.equal(Number(audit.previous_values.benefit.unit_advisor_cost_usd),1.5);
    assert.equal(Number(audit.corrected_values.benefit.unit_advisor_cost_usd),.75);
    assert.equal(audit.corrected_values.commission_recalculation_required,true);
    await assert.rejects(()=>db.exec('update crm_play_benefits set unit_advisor_cost_usd=0 where id=81'),/immutable benefit/);
    await assert.rejects(()=>db.exec('delete from crm_play_redemptions where id=101'),/immutable redemption/);
    await assert.rejects(()=>db.exec("update app_private.crm_play_cost_corrections set reason='erase evidence'"),/immutable audit/);
    const protectedTable=(await db.query("select relrowsecurity,has_table_privilege('authenticated',oid,'SELECT') allowed from pg_class where oid='app_private.crm_play_cost_corrections'::regclass")).rows[0];
    assert.equal(protectedTable.relrowsecurity,true); assert.equal(protectedTable.allowed,false);
  } finally {await db.close();}
});
test('closed settlement or drift aborts without changing business data or disabling guards', async () => {
  for (const drift of ["update advisor_commission_closures set status='closed'", "alter table crm_play_benefits disable trigger crm_play_benefits_guard; update crm_play_benefits set unit_advisor_cost_usd=1,unit_company_cost_usd=3,unit_budget_cost_usd=3 where id=81; alter table crm_play_benefits enable trigger crm_play_benefits_guard;"]) {
    const db=await setup();
    try {
      await db.exec(drift);
      const before=(await db.query('select * from crm_play_benefits order by id')).rows;
      await db.exec('begin');
      await assert.rejects(()=>db.exec(repair),/closed|no rows/);
      await db.exec('rollback');
      assert.deepEqual((await db.query('select * from crm_play_benefits order by id')).rows,before);
      await assert.rejects(()=>db.exec('delete from crm_play_redemptions where id=101'),/immutable redemption/);
      assert.equal((await db.query("select to_regclass('app_private.crm_play_cost_corrections') v")).rows[0].v,null);
    } finally {await db.close();}
  }
});
