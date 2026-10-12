// Isolated PostgreSQL regression of the real dispatch validation/obligation wrapper.
// The unchanged ledger core is a recording stub; no production connection is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); }
catch { ({ PGlite } = await import('../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js')); }
const db = new PGlite();
const migration = (name) => readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function definition(source, name) {
  const start = source.indexOf('create function public.' + name + '(');
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('$function$;', start) + '$function$;'.length);
}
await db.exec(`
create schema auth;
create role service_role;
create type currency_code as enum ('USD','VES');
create function auth.uid() returns uuid language sql as $$select '00000000-0000-0000-0000-000000000001'::uuid$$;
create function has_role(text) returns boolean language sql as $$select current_setting('test.role',true)=$1$$;
create function is_master_or_admin() returns boolean language sql as $$select false$$;
create table counter_command_receipts(actor_user_id uuid,command_type text,idempotency_key uuid,order_id bigint,request_payload jsonb,status text,result_payload jsonb);
create table orders(id bigint primary key,fulfillment text,status text,delivery_mode text,internal_driver_user_id uuid,external_partner_id bigint,external_driver_name text,total_usd numeric,attributed_advisor_id uuid);
create table exchange_rates(id bigint,rate_bs_per_usd numeric,is_active boolean,effective_at timestamptz);
create table delivery_settlement_entries(id bigint generated always as identity,settlement_id bigint,entry_type text,source_line_key text);
create table order_change_obligations(order_id bigint,command_idempotency_key uuid,line_key text,requested_by_user_id uuid,responsible_user_id uuid,responsible_role text,status text,payment_method_code text,currency_code currency_code,amount numeric,exchange_rate_ves_per_usd numeric,amount_usd_equivalent numeric,notes text,delivery_settlement_id bigint,delivery_settlement_entry_id bigint,unique(command_idempotency_key,line_key));
create table core_calls(expected jsonb,cash jsonb,digital jsonb);
create function get_order_financial_state(bigint,date,numeric) returns table(pending_usd numeric) language sql as $$select total_usd from public.orders where id=$1$$;
create function counter_dispatch_delivery_block2(uuid,bigint,integer,jsonb,jsonb,jsonb,text) returns jsonb language plpgsql set search_path=public as $$
declare item jsonb; result jsonb;
begin
  insert into core_calls values($4,$5,$6);
  for item in select value from jsonb_array_elements($6) loop
    insert into delivery_settlement_entries(settlement_id,entry_type,source_line_key) values(1,'digital_change_due',item->>'line_key');
  end loop;
  result := jsonb_build_object('delivery_settlement_id',1,'entries','[]'::jsonb);
  insert into counter_command_receipts values(auth.uid(),'dispatch_delivery',$1,$2,
    jsonb_build_object('order_id',$2,'eta_minutes',$3,'expected_collection_lines',$4,'cash_change_lines',$5,'digital_change_lines',$6,'notes',$7),'completed',result);
  return result;
end$$;
insert into exchange_rates values(1,876.8,true,now());
insert into orders values(1,'delivery','ready','internal',auth.uid(),null,null,75.50,auth.uid());
select set_config('test.role','counter',false);
`);
await db.exec(definition(migration('20260725204313_counter_block2_atomic_persistence.sql'), 'counter_amount_usd'));
await db.exec(definition(migration('20260727160408_counter_block_6_delivery_dispatch.sql'), 'counter_dispatch_delivery')
  .replace('public.counter_dispatch_delivery(', 'public.counter_dispatch_delivery_block6_v1('));
await db.exec('revoke all on function counter_dispatch_delivery_block6_v1(uuid,bigint,integer,jsonb,jsonb,jsonb,text) from public; grant execute on function counter_dispatch_delivery_block6_v1(uuid,bigint,integer,jsonb,jsonb,jsonb,text) to service_role;');
const acl = async () => (await db.query("select proacl::text,prosecdef,proconfig from pg_proc where proname='counter_dispatch_delivery_block6_v1'")).rows;
const beforeAcl = await acl();
const line = (amount, key, currency='USD') => ({ line_key:key,currency_code:currency,amount,exchange_rate_ves_per_usd:currency==='VES'?876.8:null });
let sequence = 0;
const call = (expected, cash, digital=[], eta=20, key=null) => db.query('select counter_dispatch_delivery_block6_v1($1,1,$2,$3,$4,$5,null) as result',[
  key ?? `00000000-0000-0000-0000-${String(++sequence).padStart(12,'0')}`,eta,JSON.stringify(expected),JSON.stringify(cash),JSON.stringify(digital),
]);
await assert.rejects(call([line(100,'e')],[line(24,'c')]), /allocation must equal/);
await db.exec(migration('20261012185926_counter_delivery_partial_change.sql'));
assert.deepEqual(await acl(), beforeAcl, 'Function privileges/security must not change');
const result = (await call([line(100,'e')],[line(24,'c')])).rows[0].result;
assert.equal(result.expected_collection_usd,100);
assert.equal(result.cash_change_usd,24);
assert.equal(result.digital_change_usd,0);
assert.equal((await db.query('select count(*)::int as n from order_change_obligations')).rows[0].n,0);
assert.equal((await db.query('select cash from core_calls limit 1')).rows[0].cash[0].amount,24);
await db.exec('update orders set total_usd=50');
await call([line(20,'e')],[line(5,'c')]); // net abono 15; deuda 35
await db.exec('update orders set total_usd=75.50');
await call([line(100,'e')],[line(25,'c')]); // net 75; deuda .50
await call([line(100,'e')],[line(24.5,'c')]); // exacto
await call([line(20,'e')],[]); // abono sin cambio
await call([],[]); // cobranza del asesor: no movimiento
await call([line(100,'e')],[line(24,'c')],[{...line(.5,'d'),payment_method_code:'payment_mobile'}]);
assert.equal((await db.query('select count(*)::int as n from order_change_obligations')).rows[0].n,1);
await call([line(87680,'e','VES')],[line(21043.2,'c','VES')]);
await assert.rejects(call([line(100,'e')],[line(101,'c')]),/no puede superar/);
await assert.rejects(call([],[line(1,'c')]),/Expected customer collection/);
await assert.rejects(call([line(-10,'e')],[]),/amount must be/);
await assert.rejects(call([line(100,'e')],[],[],0),/ETA/);
await db.exec("select set_config('test.role','advisor',false)");
await assert.rejects(call([line(100,'e')],[]),/Only Counter/);
await db.exec("select set_config('test.role','counter',false); update orders set internal_driver_user_id=null");
await assert.rejects(call([line(100,'e')],[]),/no internal driver/);
await db.exec('update orders set internal_driver_user_id=auth.uid()');
const key='00000000-0000-0000-0001-000000000001';
await call([line(100,'e')],[line(24,'c')],[],20,key);
const count = (await db.query('select count(*)::int as n from core_calls')).rows[0].n;
await call([line(100,'e')],[line(24,'c')],[],20,key);
assert.equal((await db.query('select count(*)::int as n from core_calls')).rows[0].n,count);
await assert.rejects(call([line(100,'e')],[line(25,'c')],[],20,key),/different request/);
await db.close();
console.log('PASS: partial change, partial payment, optional digital, VES, roles, ETA, assignment, idempotency and unchanged ACL.');
