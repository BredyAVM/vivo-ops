import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_RUNTIME || '../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js');
const read = (name) => readFileSync(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const prior = read('20260909152336_crm_play_published_amendments_v1.sql');
const start = prior.indexOf('create or replace function app_private.crm_play_guard_v1()');
const end = prior.indexOf('$$;',prior.indexOf('as $$',start));
const guard = prior.slice(start,end+3);
const fields = [...new Set([...guard.matchAll(/(?:new|old)\.(\w+)/g)].map((m)=>m[1]))];
const fixed = ['id','name','starts_at','ends_at','closed_at','status'];
const extras = fields.filter((f)=>!fixed.includes(f)).map((f)=>`${f} text`).join(',');
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema app_private;
create table crm_plays(id bigint primary key,name text,starts_at timestamptz,ends_at timestamptz,closed_at timestamptz,status text,${extras});
create table crm_play_members(id bigint primary key,play_id bigint,benefit_status text,benefit_expired_at timestamptz);
create table crm_play_redemptions(id bigint primary key,play_member_id bigint,status text,cost numeric);
${guard}
create trigger play_guard before update on crm_plays for each row execute function app_private.crm_play_guard_v1();
insert into crm_plays(id,name,status,starts_at,ends_at,closed_at) values
(1,'Aniversario · septiembre de 2026','active','2026-09-08T00:00:00-04:00','2026-10-01T23:59:59.999-04:00',null),
(2,'Loyal · septiembre de 2026','active','2026-09-11T00:00:00-04:00','2026-10-04T23:59:59.999-04:00',null),
(3,'LC · clientes perdidos · septiembre de 2026','active','2026-09-22T00:00:00-04:00','2026-10-01T23:59:59.999-04:00',null),
(4,'NC · clientes nuevos · septiembre de 2026','closed','2026-09-22T00:00:00-04:00','2026-09-30T23:59:59.999-04:00','2026-10-01T04:00:00Z');
insert into crm_play_members values(1,1,'available',null),(2,2,'redeemed',null),(3,3,'reserved',null),(4,4,'expired','2026-10-01T04:00:00Z');
insert into crm_play_redemptions values(1,2,'redeemed',4);
`);
const rows = async (sql) => (await db.query(sql)).rows;
const beforeGuard = (await rows("select pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure) source"))[0].source;
const beforeNC = await rows('select * from crm_plays where id=4');
const beforeRedemptions = await rows('select * from crm_play_redemptions');
const correction = read('20261001152150_crm_september_period_correction.sql');
// Fail closed if a target changed since audit; entire maintenance operation rolls back.
await db.exec("begin; alter table crm_plays disable trigger play_guard; update crm_plays set ends_at=ends_at+interval '1 day' where id=1; alter table crm_plays enable trigger play_guard; commit;");
await assert.rejects(db.exec(`begin; ${correction} commit;`),/changed since audit/);
await db.exec('rollback');
assert.equal((await rows("select to_regclass('app_private.crm_play_period_corrections') as name"))[0].name,null);
await db.exec("begin; alter table crm_plays disable trigger play_guard; update crm_plays set ends_at=ends_at-interval '1 day' where id=1; alter table crm_plays enable trigger play_guard; commit;");
await db.exec(`begin; ${correction} commit;`);
assert.equal((await rows("select count(*) n from crm_plays where status='closed' and ends_at='2026-09-30T23:59:59.999-04:00'"))[0].n,4);
assert.equal((await rows("select count(*) n from app_private.crm_play_period_corrections"))[0].n,3);
assert.deepEqual(await rows('select * from crm_play_redemptions'),beforeRedemptions);
assert.deepEqual(await rows('select * from crm_plays where id=4'),beforeNC);
assert.equal((await rows("select pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure) source"))[0].source,beforeGuard);
assert.equal((await rows("select count(*) n from crm_play_members where benefit_status='expired'"))[0].n,3);
assert.equal((await rows("select benefit_status from crm_play_members where id=2"))[0].benefit_status,'redeemed');
await assert.rejects(db.exec("update crm_plays set ends_at=ends_at+interval '1 day' where id=1"),/immutable/);
assert.equal((await rows("select has_table_privilege('authenticated','app_private.crm_play_period_corrections','INSERT') writable"))[0].writable,false);
console.log('PASS: four correct closures; three audited repairs; NC, delivered benefits and original guard preserved; stale audit and subsequent edits rejected.');
await db.close();
