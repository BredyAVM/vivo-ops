// Real PostgreSQL functions in an isolated local database. No production writes/pushes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const advisor = '00000000-0000-0000-0000-000000000002';
const other = '00000000-0000-0000-0000-000000000003';
const claimId = '11111111-1111-4111-8111-111111111111';
const migration = readdirSync(new URL('../../supabase/migrations/', import.meta.url)).find(name => name.endsWith('_advisor_created_master_notifications.sql'));

test('canonical creation, recipients and service-only push claim remain atomic and deduplicated', async t => {
  const db = new PGlite();
  const rows = async (sql, args=[]) => (await db.query(sql,args)).rows;
  const claim = async (orderId, who=advisor, key=claimId) => (await rows('select claim_advisor_created_push_v1($1,$2::uuid,$3::uuid) result',[orderId,who,key]))[0].result;
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema app_private;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function has_role(text) returns boolean language sql stable as $$select $1='advisor' and auth.uid() is not null$$;
      create function app_private.reserve_draft_conversion_prices_v1(bigint,bigint,jsonb) returns void language plpgsql as $$begin return; end$$;
      create function app_private.finish_draft_conversion_prices_v1(bigint) returns void language plpgsql as $$begin return; end$$;
      create function reward_lock_order_grants_v1(bigint,jsonb) returns void language plpgsql as $$begin return; end$$;`);
    const installed = read('tests/rewards/fixtures/redemption-installed-routines.sql');
    await db.exec(installed.slice(0,installed.indexOf('CREATE OR REPLACE FUNCTION')));
    await db.exec(`alter table orders alter column created_at set default statement_timestamp();
      alter table order_items add constraint positive_qty check(qty>0);
      alter table order_items add column reward_grant_id bigint, add column reward_purpose text, add column reward_amount_usd numeric;
      create table order_timeline_events(id bigint generated always as identity primary key,order_id bigint references orders(id),order_number text,event_type text,event_group text,title text,message text,severity text,actor_user_id uuid,payload jsonb not null default '{}',created_at timestamptz default now());
      create table order_timeline_event_recipients(id bigint generated always as identity primary key,event_id bigint references order_timeline_events(id),target_role text,target_user_id uuid,requires_action boolean default false,read_at timestamptz,created_at timestamptz default now());
      create index on order_timeline_events(order_id,event_type,created_at desc);
      alter table orders enable row level security;
      create policy own_order on orders to authenticated using(attributed_advisor_id=auth.uid()) with check(attributed_advisor_id=auth.uid());
      alter table order_timeline_events enable row level security;
      create policy event_select on order_timeline_events for select to authenticated using(true);
      create policy event_insert on order_timeline_events for insert to authenticated with check(true);
      alter table order_timeline_event_recipients enable row level security;
      create policy recipient_select on order_timeline_event_recipients for select to authenticated using(true);
      create policy recipient_insert on order_timeline_event_recipients for insert to authenticated with check(true);
      grant usage on schema public,auth,app_private to authenticated,service_role;
      grant select,insert,update on all tables in schema public to authenticated,service_role;
      grant usage,select on all sequences in schema public to authenticated,service_role;
      insert into clients(id,full_name) values(1,'Fixture Client');`);
    await db.exec(installed.match(/CREATE OR REPLACE FUNCTION public\.advisor_create_order_atomic_v1[\s\S]*?\$function\$\s*;/)[0]);
    await db.exec(read('supabase/migrations/' + migration));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[advisor]);
    const create = async (key, items=[{product_id:1,qty:1,line_total_usd:5,line_total_bs_snapshot:4500}]) =>
      (await rows("select advisor_create_order_atomic_v1($1::uuid,1,'pickup',5,4500,null,null,null,null,'{}',$2::jsonb,null) result",[key,JSON.stringify(items)]))[0].result;
    let orderId, eventId;
    await t.test('real atomic writer produces master/admin/advisor recipients and replay changes nothing', async () => {
      await db.exec('set role authenticated');
      const key=crypto.randomUUID();
      const created=await create(key); orderId=created.orderId;
      eventId=(await rows('select id from order_timeline_events where order_id=$1',[orderId]))[0].id;
      assert.deepEqual((await rows('select target_role,requires_action from order_timeline_event_recipients where event_id=$1 and target_role is not null order by target_role',[eventId])),[
        {target_role:'admin',requires_action:true},{target_role:'master',requires_action:true},
      ]);
      assert.equal((await rows('select count(*)::int n from order_timeline_event_recipients where event_id=$1 and target_user_id=$2',[eventId,advisor]))[0].n,1);
      const replay=await create(key); assert.equal(replay.orderId,orderId);assert.equal(replay.replayed,true);
      assert.equal((await rows('select count(*)::int n from order_timeline_events'))[0].n,1);
      assert.equal((await rows('select count(*)::int n from order_timeline_event_recipients'))[0].n,3);
      await db.exec('reset role');
    });
    await t.test('item failure rolls back header, items, event and recipients', async () => {
      await assert.rejects(()=>create(crypto.randomUUID(),[{product_id:1,qty:-1}]),/positive_qty/);
      assert.equal((await rows('select count(*)::int n from orders'))[0].n,1);
      assert.equal((await rows('select count(*)::int n from order_timeline_event_recipients'))[0].n,3);
    });
    await t.test('anon/authenticated cannot claim or finalize; only service_role can', async () => {
      for (const role of ['anon','authenticated']) {
        assert.equal((await rows("select has_function_privilege($1,'public.claim_advisor_created_push_v1(bigint,uuid,uuid)','execute') allowed",[role]))[0].allowed,false);
        assert.equal((await rows("select has_function_privilege($1,'public.finish_advisor_created_push_v1(bigint,uuid,text,integer,integer)','execute') allowed",[role]))[0].allowed,false);
      }
      assert.equal((await rows("select has_function_privilege('service_role','public.claim_advisor_created_push_v1(bigint,uuid,uuid)','execute') allowed"))[0].allowed,true);
      await db.exec('set role authenticated');
      await assert.rejects(()=>claim(orderId),/permission denied/);
      await db.exec('reset role');
    });
    await t.test('concurrent/repeated claim calls return one winner and preserve snapshots', async () => {
      const original=(await rows('select to_jsonb(o) row from orders o where id=$1',[orderId]))[0].row;
      await db.exec('set role service_role');
      const results=await Promise.all(Array.from({length:6},(_,index)=>claim(orderId,advisor,index===0?claimId:crypto.randomUUID())));
      assert.equal(results.filter(r=>r.claimed).length,1);
      assert.equal((await rows('select to_jsonb(o) row from orders o where id=$1',[orderId]))[0].row.total_usd,original.total_usd);
      assert.deepEqual((await rows('select to_jsonb(o) row from orders o where id=$1',[orderId]))[0].row,original);
      assert.equal((await rows('select count(*)::int n from order_timeline_event_recipients'))[0].n,3);
    });
    await t.test('wrong token cannot finalize; correct receipt is write-once and cannot reopen claim', async () => {
      const finish=async(key,status='sent')=>(await rows('select finish_advisor_created_push_v1($1,$2::uuid,$3,1,0) result',[eventId,key,status]))[0].result;
      assert.equal(await finish(crypto.randomUUID()),false);
      assert.equal(await finish(claimId),true);
      assert.equal(await finish(claimId,'uncertain'),false);
      assert.equal((await claim(orderId)).claimed,false);
      assert.equal((await rows("select payload #>> '{master_created_push,status}' status from order_timeline_events where id=$1",[eventId]))[0].status,'sent');
    });
    await t.test('wrong advisor, no items, approved and historical orders do not alert', async () => {
      await assert.rejects(()=>claim(orderId,other),/Not the creator/);
      for (const patch of ["created_at=now()-interval '1 day'","status='queued'"]) {
        const key=crypto.randomUUID();const o=await create(key);await db.exec(`update orders set ${patch} where id=${o.orderId}`);
        assert.equal((await claim(o.orderId)).claimed,false);
      }
      const o=await create(crypto.randomUUID());
      await db.exec('reset role');await db.exec(`delete from order_items where order_id=${o.orderId}`);await db.exec('set role service_role');
      assert.equal((await claim(o.orderId)).claimed,false);
    });
    await t.test('compatibility path repairs recent missing recipients without duplicating the event', async () => {
      const o=await create(crypto.randomUUID());
      const e=(await rows('select id from order_timeline_events where order_id=$1',[o.orderId]))[0].id;
      await db.exec('reset role'); await db.exec(`delete from order_timeline_event_recipients where event_id=${e}`);
      await db.exec('set role service_role');
      assert.equal((await claim(o.orderId)).claimed,true);
      assert.equal((await rows('select count(*)::int n from order_timeline_events where order_id=$1',[o.orderId]))[0].n,1);
      assert.equal((await rows('select count(*)::int n from order_timeline_event_recipients where event_id=$1',[e]))[0].n,3);
      assert.equal((await claim(o.orderId)).claimed,false);
    });
    await t.test('other event types/origins do not acquire creation recipients', async () => {
      await db.exec('reset role');
      await db.query("insert into order_timeline_events(order_id,event_type,event_group,title,actor_user_id) values($1,'order_modified','approval','Fixture',$2)",[orderId,advisor]);
      const e=(await rows('select max(id) id from order_timeline_events'))[0].id;
      assert.equal((await rows('select count(*)::int n from order_timeline_event_recipients where event_id=$1',[e]))[0].n,0);
      const o=await create(crypto.randomUUID());await db.exec(`update orders set source='master' where id=${o.orderId}`);
      await assert.rejects(()=>claim(o.orderId),/Not the creator/);
    });
    await t.test('legacy entry point can create one missing recent event and keeps existing read state', async () => {
      await db.exec('reset role');
      const o=await create(crypto.randomUUID());
      const e=(await rows('select id from order_timeline_events where order_id=$1',[o.orderId]))[0].id;
      await db.exec(`delete from order_timeline_event_recipients where event_id=${e}; delete from order_timeline_events where id=${e};`);
      await db.exec('set role service_role');
      assert.equal((await claim(o.orderId)).claimed,true);
      const current=(await rows('select id from order_timeline_events where order_id=$1',[o.orderId]))[0].id;
      await db.exec(`update order_timeline_event_recipients set requires_action=false,read_at=now() where event_id=${current}`);
      assert.equal((await claim(o.orderId)).claimed,false);
      assert.equal((await rows('select count(*)::int n from order_timeline_events where order_id=$1',[o.orderId]))[0].n,1);
      assert.equal((await rows('select count(*)::int n from order_timeline_event_recipients where event_id=$1 and read_at is not null and not requires_action',[current]))[0].n,3);
    });
  } finally { await db.close(); }
});
