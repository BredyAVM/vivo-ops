import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const compile = (source, dependencies = {}) => {
  const exports = {};
  const context = vm.createContext({ exports, require: name => {
    assert.ok(dependencies[name], `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
};
const snapshots = compile(read('src/lib/pricing/order-snapshots.ts'));
const composition = compile(read('src/lib/orders/order-composer.ts'));
const persistence = compile(read('src/lib/orders/order-detail-persistence.ts'));
const { buildRepeatedMasterOpsOrder: repeat } = compile(read('src/app/app/master/ops/order-repeat.ts'), {
  '@/lib/pricing/order-snapshots': snapshots, '@/lib/orders/order-composer': composition,
  '@/lib/orders/order-detail-persistence': persistence,
});
const json = value => JSON.parse(JSON.stringify(value));
const product = (id, currency = 'USD', amount = 14) => ({ id, name: `Producto ${id}`, sku: `P${id}`,
  isActive: true, discretionaryAllowed: true, sourcePriceCurrency: currency, sourcePriceAmount: amount, basePriceUsd: 1 });
function fixtures() {
  return {
    defaults: { activeRate: 900, advisors: [{ id: 'advisor-1' }], productComponents: [], catalogItems: [product(1), product(2, 'VES', 6300)],
      order: { id: 0, orderNumber: '', status: 'created', isPriceProtected: false, source: 'master', attributedAdvisorUserId: null,
        deliveryDate: '2026-10-23', deliveryHour12: '10', deliveryMinute: '30', fxRate: '900', paymentMethod: '', paymentCurrency: 'USD',
        useClientFund: false, clientFundAmountUsd: '', paymentRequiresChange: false, paymentChangeFor: '',
        discountEnabled: false, discountPct: '0', hasInvoice: false, hasDeliveryNote: false,
        lastModifiedAtISO: null, note: '', items: [] } },
    source: { id: 3435, source: 'advisor', attributedAdvisorUserId: 'advisor-1', client: { id: 123, fullName: 'Cliente', fundBalanceUsd: 5 },
      fulfillment: 'delivery', deliveryAddress: 'Dirección', deliveryGpsUrl: 'https://maps.example', receiverName: 'Recibe', receiverPhone: '12345',
      items: [{ productId: 1, productName: 'Nombre anterior', qty: 2, notes: '', orderItemId: 999,
        sourcePriceAmount: 0, adminPriceOverrideUsd: 0, crmPlayMemberId: 9, commissionOverrideValue: 99, rewardGrantId: 10 },
        { productId: 2, productName: 'Bolívares', qty: 1, notes: '' }],
      status: 'delivered', idempotencyKey: 'old', paymentReports: [{ amount: 100 }], paymentMethod: 'cash_usd',
      useClientFund: true, clientFundAmountUsd: '5', isPriceProtected: true, deliveryDate: '2020-01-01',
      deliveryDriverId: 'old-driver', discountEnabled: true, discountPct: '50', fxRate: '500', totalUsd: 999 },
  };
}
test('repeat uses current mixed-currency catalog and current rate, never the old approved price', () => {
  const { defaults, source } = fixtures();
  const before = JSON.stringify({ defaults, source });
  const result = json(repeat(defaults, source));
  assert.equal(result.order.items[0].lineTotalUsd, 28);
  assert.equal(result.order.items[0].lineTotalBsSnapshot, 25200);
  assert.equal(result.order.items[0].productNameSnapshot, 'Producto 1');
  assert.equal(result.order.items[1].lineTotalUsd, 7);
  assert.equal(result.order.items[1].lineTotalBsSnapshot, 6300);
  assert.equal(result.order.fxRate, '900');
  assert.equal(JSON.stringify({ defaults, source }), before, 'source and defaults stay untouched');
});
test('repeat keeps purchase choices but resets schedule, identity, payments, discounts and all authorities', () => {
  const { defaults, source } = fixtures();
  const result = json(repeat(defaults, source));
  assert.equal(result.order.id, 0);
  assert.equal(result.order.orderNumber, '');
  assert.equal(result.order.status, 'created');
  assert.equal(result.order.selectedClientId, 123);
  assert.equal(result.order.fulfillment, 'delivery');
  assert.equal(result.order.deliveryAddress, 'Dirección');
  assert.equal(result.order.deliveryDate, defaults.order.deliveryDate);
  assert.equal(result.order.paymentMethod, '');
  assert.equal(result.order.useClientFund, false);
  assert.equal(result.order.clientFundAmountUsd, '');
  assert.equal(result.order.paymentRequiresChange, false);
  assert.equal(result.order.discountEnabled, false);
  assert.equal(result.order.isPriceProtected, false);
  assert.equal(result.order.lastModifiedAtISO, null);
  for (const key of ['paymentReports', 'deliveryDriverId', 'idempotencyKey']) assert.equal(result.order[key], undefined);
  for (const item of result.order.items) {
    assert.equal(item.orderItemId, null);
    assert.equal(item.adminPriceOverrideUsd, null);
    for (const key of ['crmPlayMemberId', 'commissionOverrideValue', 'rewardGrantId']) assert.equal(item[key], undefined);
  }
  assert.equal(result.order.attributedAdvisorUserId, 'advisor-1');
  assert.deepEqual(result.repeatSummary, { sourceOrderId: 3435, skippedItems: [] });
});
test('unavailable or CRM-only products are skipped with explicit notice; an inactive advisor is not attributed', () => {
  const { defaults, source } = fixtures();
  defaults.catalogItems[0].discretionaryAllowed = false;
  defaults.catalogItems[1].isActive = false;
  defaults.advisors = [];
  const result = repeat(defaults, source);
  assert.equal(result.order.items.length, 0);
  assert.equal(result.repeatSummary.skippedItems.length, 2);
  assert.equal(result.order.source, 'master');
  assert.equal(result.order.attributedAdvisorUserId, null);
});
test('fixed composition follows current recipe and custom choices retain metadata without CRM authority', () => {
  const { defaults, source } = fixtures();
  defaults.catalogItems[0].isDetailEditable = true;
  source.items[0].notes = '6 Mini\n@sel|8|6\n@prep|8|6\n@crm|forged';
  defaults.productComponents = [{ parentProductId: 2, componentProductId: 9, componentName: 'Salsa',
    componentMode: 'fixed', isRequired: true, quantity: 2, sortOrder: 1 }];
  const result = json(repeat(defaults, source));
  assert.deepEqual(result.order.items[0].editableDetailLines, ['6 Mini', '@sel|8|6', '@prep|8|6']);
  assert.deepEqual(result.order.items[1].editableDetailLines, ['2 Salsa', '@sel|9|2']);
  source.items[1].qty = 0.5;
  source.items[1].notes = '@prep|fried\nPara: Ana\n9 Salsa\n@sel|9|9';
  assert.deepEqual(json(repeat(defaults, source).order.items[1].editableDetailLines),
    ['@prep|fried', 'Para: Ana', '1 Salsa', '@sel|9|1']);
});
test('old custom choices that no longer fit the current pack remain blocked by the actual editor validator', () => {
  const validationSource = read('src/app/app/master/ops/order-editor-validation.ts');
  const parsed = ts.createSourceFile('validation.ts', validationSource, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getConfigurationIssue');
  const ctx = vm.createContext({ parseEditableDetailLines: composition.parseEditableDetailLines });
  vm.runInContext(ts.transpileModule(fn.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const currentProduct = { id: 1, name: 'Pack', isDetailEditable: true, detailUnitsLimit: 6 };
  const component = { parentProductId: 1, componentProductId: 8, componentName: 'Mini', componentMode: 'selectable', countsTowardDetailLimit: true };
  const line = { productId: 1, qty: 1, editableDetailLines: ['@sel|8|6'] };
  assert.equal(ctx.getConfigurationIssue(line, currentProduct, [component]), null);
  assert.match(ctx.getConfigurationIssue(line, { ...currentProduct, detailUnitsLimit: 8 }, [component]), /exactamente 8/);
  assert.match(ctx.getConfigurationIssue({ ...line, editableDetailLines: ['@sel|99|6'] }, currentProduct, [component]), /ya no pertenece/);
});
const actions = read('src/app/app/master/ops/actions.ts');
const ast = ts.createSourceFile('actions.ts', actions, ts.ScriptTarget.Latest, true);
const actionSource = ast.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ['loadMasterOpsOrderCreateDataAction', 'loadMasterOpsRepeatSource'].includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
function actionRuntime({ unauthorized = false, missing = false, itemsError = false } = {}) {
  const { defaults } = fixtures(); const calls = [];
  const context = vm.createContext({
    requireMasterOrAdminContext: async () => { if (unauthorized) throw new Error('Forbidden'); return { supabase }; },
    loadMasterOpsOrderComposerLookups: async () => ({ catalogItems: defaults.catalogItems,
      productComponents: defaults.productComponents, advisors: defaults.advisors, activeRate: defaults.activeRate }),
    getDefaultScheduleFields: focus => ({ deliveryDate: focus ?? '2026-10-23' }),
    buildRepeatedMasterOpsOrder: repeat, asOpsRecord: value => value ?? {},
    cleanText: (value, fallback = '') => value || fallback, one: value => Array.isArray(value) ? value[0] ?? null : value,
    mapClient: value => value,
  });
  const supabase = { from: table => {
    calls.push(table); let constrained = false;
    const result = table === 'orders'
      ? { data: missing ? null : { id: 3435, source: 'master', client: { id: 123 }, extra_fields: { pricing: { fx_rate: 1 } } }, error: null }
      : { data: [{ product_id: 1, product_name_snapshot: 'Mini', qty: 2, notes: '' }], error: itemsError ? { message: 'Read failed' } : null };
    const chain = { select: () => chain, eq: (column, id) => { assert.equal(column, table === 'orders' ? 'id' : 'order_id'); assert.equal(id, 3435); constrained = true; return chain; },
      single: async () => { assert.ok(constrained); return result; }, order: async () => { assert.ok(constrained); return result; } };
    return chain;
  } };
  vm.runInContext(ts.transpileModule(actionSource.replaceAll('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { run: context.loadMasterOpsOrderCreateDataAction, calls };
}
test('actual loader authorizes access, validates the ID, only reads the chosen order and resets a past focus date', async () => {
  const runtime = actionRuntime();
  const result = await runtime.run('2020-01-01', 3435);
  assert.deepEqual(runtime.calls, ['orders', 'order_items']);
  assert.equal(result.order.deliveryDate, '2026-10-23');
  assert.equal(result.order.items[0].lineTotalUsd, 28);
  for (const id of [0, -1, 1.2, NaN, Infinity, '3435']) await assert.rejects(actionRuntime().run(null, id), /inválida/);
  const rejected = actionRuntime({ unauthorized: true });
  await assert.rejects(rejected.run(null, 3435), /Forbidden/);
  assert.deepEqual(rejected.calls, []);
  await assert.rejects(actionRuntime({ missing: true }).run(null, 3435), /acceder/);
  await assert.rejects(actionRuntime({ itemsError: true }).run(null, 3435), /Read failed/);
});
test('ordinary new order has no template queries; all repeat UIs are explicit, lazy and stay in their workspace', async () => {
  const runtime = actionRuntime();
  const result = await runtime.run('2026-10-24');
  assert.equal(result.order.deliveryDate, '2026-10-24');
  assert.equal(result.repeatSummary, undefined);
  assert.deepEqual(runtime.calls, []);
  const shared = read('src/components/orders/OrdersWorkspaceClient.tsx');
  assert.match(shared, /onRepeatOrder=\{\(order\) => \{ setRepeatOrderId\(order.id\); closeOrderDetail\(\); setCreateOrderOpen\(true\); \}\}/);
  assert.match(shared, /templateOrderId=\{repeatOrderId\}/);
  assert.match(shared, /setRepeatOrderId\(null\); setCreateOrderOpen\(true\)/);
  assert.doesNotMatch(shared, /router\.(push|replace)\([^\n]*duplicateFrom/);
  const editor = read('src/app/app/master/ops/MasterOpsOrderEditor.tsx');
  assert.match(editor, /loadMasterOpsOrderCreateDataAction\(focusDate, templateOrderId\)/);
  assert.match(editor, /createMasterOpsOrderAction\(/);
  const advisor = read('src/app/app/advisor/orders/page.tsx');
  assert.match(advisor, /\) : null\}\s*<Link\s*prefetch=\{false\}\s*href=\{withAdvisorReturnTo\(`\/app\/advisor\/new\?duplicateFrom=/);
});
