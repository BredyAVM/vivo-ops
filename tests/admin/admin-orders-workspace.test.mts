import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canOpenOrdersWorkspace, ordersWorkspaceNavigation } from '../../src/lib/orders/workspace-navigation.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('workspace routing does not grant administrative access to an operational role', () => {
  for (const roles of [[], ['advisor'], ['kitchen'], ['master']]) {
    assert.equal(canOpenOrdersWorkspace('admin', roles), false);
  }
  assert.equal(canOpenOrdersWorkspace('admin', ['admin']), true);
  assert.equal(canOpenOrdersWorkspace('master', ['master']), true);
  assert.equal(canOpenOrdersWorkspace('master', ['admin']), true);
  assert.equal(canOpenOrdersWorkspace('master', ['advisor']), false);
});

test('both route entries render one shared workspace without copied queries or controls', () => {
  for (const [path, surface] of [['src/app/app/admin/ordenes/page.tsx', 'admin'], ['src/app/app/master/ops/page.tsx', 'master']]) {
    const source = read(path);
    assert.match(source, /@\/lib\/orders\/operations-workspace/);
    assert.ok(source.includes(`<OrdersWorkspace surface="${surface}"`));
    assert.doesNotMatch(source, /supabase|\.from\(|\.rpc\(/);
  }
  const loader = read('src/lib/orders/operations-workspace.tsx');
  assert.ok(loader.indexOf('canOpenOrdersWorkspace(surface, ctx.roles)') < loader.indexOf('const params ='));
  assert.match(loader, /get_orders_financial_state/);
  assert.match(loader, /@\/components\/orders\/OrdersWorkspaceClient/);
});

test('Admin navigation stays native and Master keeps its original operational destinations', () => {
  assert.deepEqual(ordersWorkspaceNavigation('admin'), {
    orders: '/app/admin/ordenes', inventory: '/app/admin/inventario',
    payments: '/app/admin/autorizaciones?tipo=payment',
    movement: '/app/admin/finanzas/cuentas/movimiento',
  });
  assert.deepEqual(ordersWorkspaceNavigation('master'), {
    orders: '/app/master/ops', inventory: '/app/master/ops/inventory',
    payments: '/app/master/ops/finance', movement: '/app/master/ops/finance?movement=new',
  });
  const ui = read('src/components/orders/OrdersWorkspaceClient.tsx');
  assert.doesNotMatch(ui, /import Link from "next\/link"/);
  assert.match(ui, /<ContextLink href="\/app\/events\/ongoing"/);
  assert.match(ui, /appContextHref\(adminWorkspaceHref\(item.eventHref, current\), current\)/);
  assert.doesNotMatch(ui, /router\.(?:push|replace)\(`?['"]?\/app\/master\/ops/);
  assert.match(ui, /router\.push\(`\$\{navigation.orders\}/);
  assert.match(ui, /query \? `\$\{navigation.orders\}\?\$\{query\}` : navigation.orders/);
});

test('details and heavy editor are loaded only when needed, not for every listed order', () => {
  const ui = read('src/components/orders/OrdersWorkspaceClient.tsx');
  assert.match(ui, /if \(!selectedOrderId\)[\s\S]*loadMasterOpsOrderDetailAction\(\{ orderId: selectedOrderId \}\)/);
  assert.match(ui, /cached\?\.snapshotAt === snapshotAt/);
  assert.match(ui, /const MasterOpsOrderEditor = dynamic/);
  assert.match(ui, /\{createOrderOpen \? <MasterOpsOrderEditor/);
  assert.match(ui, /\{editingOrderId !== null \? <MasterOpsOrderEditor/);
  assert.match(ui, /if \(isAdminSurface\) return;\s*const refreshIfStale/);
  assert.match(ui, /if \(isAdminSurface\) return;\s*loadMasterOpsInventoryAlertSummaryAction/);
  assert.match(ui, /!isAdminSurface \? <div[\s\S]*<MasterOpsSignOutButton/);
});

test('financial order deep links stay in the administrative workspace', () => {
  for (const path of [
    'src/lib/admin-finance/authorizations-model.ts', 'src/lib/admin-finance/delivery-model.ts',
    'src/lib/admin-finance/tasks-model.ts',
    'src/app/app/admin/finanzas/cobranzas/_components/CollectionsOverview.tsx',
    'src/app/app/admin/finanzas/cuentas/_components/AccountDetail.tsx',
    'src/app/app/admin/finanzas/cartera/_components/ReceivablesOverview.tsx',
  ]) {
    assert.match(read(path), /\/app\/admin\/ordenes\?/);
    assert.doesNotMatch(read(path), /\/app\/master\/ops\?/);
  }
  assert.match(read('src/app/app/master/ops/actions.ts'), /revalidatePath\("\/app\/admin\/ordenes"\)/);
  assert.match(read('src/app/app/master/dashboard/actions.ts'), /revalidatePath\('\/app\/admin\/ordenes'\)/);
});
