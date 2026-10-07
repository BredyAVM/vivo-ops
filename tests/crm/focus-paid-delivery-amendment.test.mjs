import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('published Focus amendment changes only channel and copy, audits it, and restores the guard', async () => {
  const db = new PGlite();
  try {
    const guard = readFileSync(new URL('./fixtures/published-play-guard-20261007.sql',import.meta.url),'utf8');
    const types = {id:'bigint',starts_at:'timestamptz',ends_at:'timestamptz',minimum_order_amount_usd:'numeric',
      activated_by_user_id:'uuid',rules_snapshot:'jsonb',selection_summary:'jsonb'};
    const fields = [...new Set([...guard.matchAll(/(?:old|new)\.([a-z_]+)/g)].map(m=>m[1]))];
    for (const f of ['id','advisor_guidance','message_template']) if (!fields.includes(f)) fields.push(f);
    await db.exec(`create schema app_private;
      create table crm_plays(${fields.map(f=>`${f} ${types[f] || 'text'}`).join(',')});
      create table crm_play_amendments(play_id bigint,amendment_type text,previous_values jsonb,new_values jsonb,reason text,created_by_user_id uuid);
      ${guard};
      create trigger crm_plays_guard before update on crm_plays for each row execute function app_private.crm_play_guard_v1();
      insert into crm_plays(id,name,status,starts_at,ends_at,benefit_fulfillment,benefit_recurrence_mode,purchase_requirement_mode,minimum_order_amount_usd,description,message_template,advisor_guidance,activated_by_user_id,rules_snapshot)
      values (1,'Focus Pickup · octubre de 2026','active','2026-10-03T04:00Z','2026-11-01T03:59:59.999Z','pickup','daily','minimum_order',10,
      'Dondy por compra pickup mínima $10.','Cada día que hagas una compra de $10 o más en productos y la retires en nuestro local','compra pickup elegible',
      '00000000-0000-0000-0000-000000000001','{"cohort":"pickup"}');
      insert into crm_plays(id,name,status,benefit_fulfillment) values (2,'Focus Zona 1','active','delivery_zone_1');`);
    const original = (await db.query("select pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure) def")).rows[0].def;
    const before = (await db.query('select to_jsonb(p) v from crm_plays p order by id')).rows;
    await db.exec(readFileSync(new URL('../../supabase/migrations/20261007131740_crm_focus_pickup_paid_delivery_amendment.sql',import.meta.url),'utf8'));
    const after = (await db.query('select to_jsonb(p) v from crm_plays p order by id')).rows;
    assert.equal(after[0].v.benefit_fulfillment,'any');
    assert.equal(after[0].v.minimum_order_amount_usd,10);
    assert.match(after[0].v.message_template,/delivery pagando el envío habitual/);
    assert.doesNotMatch(after[0].v.message_template,/retires en nuestro local/);
    for (const key of Object.keys(before[0].v)) {
      if (!['benefit_fulfillment','description','message_template','advisor_guidance','updated_at'].includes(key))
        assert.deepEqual(after[0].v[key],before[0].v[key],key);
    }
    assert.deepEqual(after[1],before[1]);
    assert.equal((await db.query("select pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure) def")).rows[0].def,original);
    const audit = (await db.query('select * from crm_play_amendments')).rows;
    assert.equal(audit.length,1);
    assert.equal(audit[0].previous_values.benefit_fulfillment,'pickup');
    assert.equal(audit[0].new_values.benefit_fulfillment,'any');
    await assert.rejects(()=>db.exec("update crm_plays set minimum_order_amount_usd=0 where id=1"),/immutable/);
    await assert.rejects(()=>db.exec("update crm_plays set benefit_fulfillment='any' where id=2"),/immutable/);
  } finally {await db.close();}
});
