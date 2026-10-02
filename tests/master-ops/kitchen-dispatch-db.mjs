// Isolated PostgreSQL verification of the existing canonical writer; no production mutations.
import { PGlite } from '../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
await db.exec(`
create schema auth;
create type order_status as enum ('created','queued','confirmed','in_kitchen','ready','out_for_delivery','delivered','cancelled');
create type fulfillment_type as enum ('pickup','delivery');
create function auth.uid() returns uuid language sql as $$select '00000000-0000-0000-0000-000000000001'::uuid$$;
create function is_master_or_admin() returns boolean language sql as $$select current_setting('test.role',true) in ('master','admin')$$;
create table orders(id bigint primary key,status order_status,fulfillment fulfillment_type,queued_needs_reapproval boolean,
 sent_to_kitchen_at timestamptz,sent_to_kitchen_by uuid);
create table order_events(order_id bigint,event text,performed_by uuid,meta jsonb);
create table tasks(task_type text,order_id bigint,title text,body text,due_at timestamptz,created_by uuid);
set test.role='master';
insert into orders(id,status,fulfillment,queued_needs_reapproval) values (1,'queued','delivery',false),(2,'queued','pickup',true),(3,'created','pickup',false),(4,'queued','pickup',false);
`);
const source = readFileSync(new URL('../../supabase/migrations/20260324220958_functions_only.sql', import.meta.url), 'utf8');
const start = source.indexOf('CREATE OR REPLACE FUNCTION public.send_to_kitchen(');
assert.ok(start >= 0);
await db.exec(source.slice(start, source.indexOf('$function$;', start) + '$function$;'.length));
await db.exec('select send_to_kitchen(1)');
assert.equal((await db.query('select status from orders where id=1')).rows[0].status, 'confirmed');
await assert.rejects(db.exec('select send_to_kitchen(1)'), /must be in queued/);
assert.equal((await db.query('select count(*)::int as n from order_events where order_id=1')).rows[0].n, 1);
assert.equal((await db.query('select count(*)::int as n from tasks where order_id=1')).rows[0].n, 1);
await assert.rejects(db.exec('select send_to_kitchen(2)'), /re-approval/);
await assert.rejects(db.exec('select send_to_kitchen(3)'), /must be in queued/);
await db.exec("set test.role='advisor'");
await assert.rejects(db.exec('select send_to_kitchen(4)'), /Only master\/admin/);
await db.exec("set test.role='admin'; select send_to_kitchen(4)");
assert.equal((await db.query('select count(*)::int as n from tasks where order_id=4')).rows[0].n, 0);
// A failed transaction cannot leave the status/event committed without the task.
await db.exec("insert into orders(id,status,fulfillment,queued_needs_reapproval) values (5,'queued','delivery',false); alter table tasks add constraint reject_test_order check(order_id<>5)");
await assert.rejects(db.exec('select send_to_kitchen(5)'), /reject_test_order/);
assert.equal((await db.query('select status from orders where id=5')).rows[0].status, 'queued');
assert.equal((await db.query('select count(*)::int as n from order_events where order_id=5')).rows[0].n, 0);
await db.close();
console.log('11 canonical kitchen-dispatch database checks passed.');
