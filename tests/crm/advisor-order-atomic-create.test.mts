import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

test('advisor creates the order through one atomic command', () => {
  const composer = read('src/app/app/advisor/new/AdvisorOrderComposer.tsx');
  const submitStart = composer.indexOf('async function handleSubmit');
  const submit = composer.slice(
    submitStart,
    composer.indexOf('\n  return (', submitStart),
  );

  assert.match(submit, /createAdvisorOrderAction\(\{/);
  assert.match(submit, /orderCreationRequestRef\.current = crypto\.randomUUID\(\)/);
  assert.match(submit, /requestId: orderCreationRequestRef\.current/);
  assert.doesNotMatch(submit, /\.from\(['"]orders['"]\)\s*\.insert/);
  assert.doesNotMatch(submit, /\.from\(['"]order_items['"]\)\s*\.insert/);
  assert.doesNotMatch(submit, /ensureAdvisorOrderCreatedEventAction|markAdvisorOrderDraftConvertedAction/);
});

test('server action validates details and delegates the mutation to the database transaction', () => {
  const actions = read('src/app/app/advisor/new/actions.ts');
  const create = actions.slice(
    actions.indexOf('export async function createAdvisorOrderAction'),
    actions.indexOf('export async function replaceAdvisorOrderItemsAction'),
  );

  assert.match(create, /requireAuthContext\(\)/);
  assert.match(create, /normalizeAdvisorItemDetails\(/);
  assert.match(create, /rpc\('advisor_create_order_atomic_v1'/);
  assert.match(create, /No se creó una orden duplicada/);
  assert.doesNotMatch(create, /createSupabaseServiceRoleServer|\.from\(['"]orders['"]\)|\.from\(['"]order_items['"]\)/);
});

test('database command is atomic, idempotent and uses caller RLS', () => {
  const migrations = readdirSync(new URL('../../supabase/migrations/', import.meta.url));
  const migrationName = migrations.find((name) => name.endsWith('_advisor_atomic_order_creation.sql'));
  assert.ok(migrationName, 'atomic advisor migration must exist');
  const migration = read(`supabase/migrations/${migrationName}`);

  assert.match(migration, /advisor_creation_idempotency_key uuid/);
  assert.match(migration, /orders_advisor_creation_idempotency_uk/);
  assert.match(migration, /security invoker\s+set search_path = ''/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /insert into public\.orders/);
  assert.match(migration, /insert into public\.order_items/);
  assert.match(migration, /insert into public\.order_timeline_events/);
  assert.match(migration, /update public\.advisor_order_drafts/);
  assert.match(migration, /grant execute on function public\.advisor_create_order_atomic_v1/);
  assert.doesNotMatch(migration, /security definer/i);
});

test('Master exposes a safe cancellation path for an active order without items', () => {
  const actions = read('src/app/app/master/ops/actions.ts');
  const loader = actions.slice(
    actions.indexOf('export async function loadMasterOpsOrderDetailAction'),
    actions.indexOf('export async function selectMasterOpsOrderInventoryRouteAction'),
  );
  const client = read('src/app/app/master/ops/MasterOpsClient.tsx');

  assert.match(loader, /integrityStatus[\s\S]*"missing_items"/);
  assert.doesNotMatch(loader, /No se pudieron confirmar los productos de la orden/);
  assert.match(client, /Orden incompleta detectada/);
  assert.match(client, /REQUIERE CANCELACIÓN/);
  assert.match(client, /const directActions = isIncompleteOrder \? \[\]/);
  assert.match(client, /const canCancelOrder = order\.status !== "cancelled"/);
});
