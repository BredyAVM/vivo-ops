import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeliveryCostInput, readStoredDeliveryCost, deliveryCostSourceLabel } from '../../src/lib/domain/delivery-cost.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { deliveryFilters, deliveryHref, deliveryOrderHref, parseDeliveryOverview, parseDeliverySettlement } from '../../src/lib/admin-finance/delivery-model.ts';
import { buildAdminTaskGroups, filterAdminTaskGroups } from '../../src/lib/admin-finance/tasks-model.ts';
import { accountsReport, activeOrdersReport, adminCsv } from '../../src/lib/admin-finance/reports-model.ts';
import { resolveLegacyAdminSection } from '../../src/lib/admin-finance/legacy-navigation.ts';
import type { AdminFinanceAccountSnapshot, AdminFinanceAccountsOverview } from '../../src/lib/admin-finance/accounts-model.ts';
import type { ActiveOrder, ActiveOrdersOverview } from '../../src/lib/admin-finance/active-orders-model.ts';
import type { CommissionRow } from '../../src/lib/admin-finance/commissions-model.ts';
const now = new Date('2026-09-10T17:00:00Z');
test('delivery cost distinguishes blank, zero and a positive manual amount', () => {
  for (const input of [null, undefined, '', '   ']) assert.equal(parseDeliveryCostInput(input), null);
  for (const input of [0, '0', '0,00']) assert.equal(parseDeliveryCostInput(input), 0);
  assert.equal(parseDeliveryCostInput(' 2,35 '), 2.35);
});
test('delivery cost rejects malformed and out-of-range financial inputs', () => {
  for (const input of [-1, '-1', NaN, Infinity, true, {}, [], 'abc', '1,2,3', '1e9', 1000000000]) assert.throws(() => parseDeliveryCostInput(input));
});
test('delivery readers keep unavailable cost unavailable and distinguish legacy provenance', () => {
  assert.equal(readStoredDeliveryCost('bad'), null);
  assert.equal(readStoredDeliveryCost(null), null);
  assert.equal(readStoredDeliveryCost(0), 0);
  assert.match(deliveryCostSourceLabel('internal_product'), /Registro anterior/);
  assert.match(deliveryCostSourceLabel('internal_assignment_input'), /Registrado al asignar/);
  assert.match(deliveryCostSourceLabel('external_partner_manual_v1'), /Registrado al asignar/);
});
test('assignment actions use a single cost command, not a client-side metadata rewrite', () => {
  const actions = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url), 'utf8');
  const assignments = actions.slice(actions.indexOf('export async function assignInternalDriverAction'), actions.indexOf('export async function correctDeliveredDeliveryAssignmentAction'));
  assert.equal((assignments.match(/rpc\('assign_delivery_with_cost_v1'/g) ?? []).length, 2);
  assert.doesNotMatch(assignments, /\.update\(/);
  assert.equal((assignments.match(/requireMasterOrAdmin\(\)/g) ?? []).length, 2);
  const dashboard = readFileSync(new URL('../../src/app/app/master/dashboard/MasterDashboardClient.tsx', import.meta.url), 'utf8');
  const reader = dashboard.slice(dashboard.indexOf('function getEffectiveDeliveryCostUsd'), dashboard.indexOf('function isDeliveryCatalogItem'));
  assert.doesNotMatch(reader, /getInternalDeliveryPayUsd/);
  assert.match(reader, /readStoredDeliveryCost/);
});
const filters = deliveryFilters({}, now);
function payload() { return { definitionVersion: 'admin-delivery-v1', asOf: now.toISOString(), from: filters.from, to: filters.to, mode: filters.mode, query: '', offset: 0, pageSize: 30, summary: { deliveries: 1, costed: 0, knownCostUsd: 0, internal: 1, external: 0, unassigned: 0 }, undatedDeliveries: 2, rows: [{ id: 25, orderNumber: 'V-25', clientName: 'Cliente', deliveredAt: now.toISOString(), mode: 'internal', responsible: 'Rider', costUsd: null, costSource: 'internal_product' }], pending: { results: [{ id: 12, orderId: 25, orderNumber: null, status: 'open', responsibleName: 'Rider', dispatchedAt: now.toISOString() }], nextCursor: null } }; }
test('delivery uses Caracas dates and validates ranges and cursor pairs', () => {
  assert.equal(filters.from, '2026-09-01'); assert.equal(filters.to, '2026-09-10');
  assert.equal(deliveryFilters({ period: 'today' }, new Date('2026-09-10T02:00:00Z')).from, '2026-09-09');
  for (const values of [{ from: '2026-02-30' }, { from: '2027-01-01', to: '2026-01-01' }, { from: '2020-01-01', to: '2026-01-01' }, { settlementId: '12' }, { settlementBefore: 'bad', settlementId: '12' }]) assert.throws(() => deliveryFilters(values, now));
});
test('delivery does not manufacture missing costs and retains operational pending state', () => {
  const data = parseDeliveryOverview(payload(), filters, now);
  assert.equal(data.rows[0].costUsd, null); assert.equal(data.summary.costed, 0); assert.equal(data.undatedDeliveries, 2);
  assert.equal(data.settlements[0].orderNumber, '25'); assert.equal(data.settlements[0].status, 'open');
  assert.equal(data.nextSettlementCursor, null);
});
test('delivery rejects stale, truncated, duplicate and contradictory payloads', () => {
  const p = payload();
  assert.throws(() => parseDeliveryOverview({ ...p, rows: [] }, filters, now));
  assert.throws(() => parseDeliveryOverview(p, filters, new Date('2026-09-10T18:00:00Z')));
  assert.throws(() => parseDeliveryOverview({ ...p, summary: { ...p.summary, costed: 2 } }, filters, now));
  assert.throws(() => parseDeliveryOverview({ ...p, pending: { ...p.pending, nextCursor: { id: 12, dispatchedAt: now.toISOString() } } }, filters, now));
  assert.throws(() => parseDeliveryOverview({ ...p, summary: { ...p.summary, deliveries: 2, internal: 2 }, rows: [p.rows[0], p.rows[0]] }, filters, now));
});
test('delivery rejects rows outside the requested scope and encodes navigation', () => {
  const p = payload();
  assert.throws(() => parseDeliveryOverview({ ...p, rows: [{ ...p.rows[0], deliveredAt: '2026-08-01T12:00:00Z' }] }, filters, now));
  const data = parseDeliveryOverview(p, filters, now);
  assert.match(deliveryOrderHref(data.rows[0]), /openOrder=25/);
  assert.match(deliveryOrderHref(data.rows[0]), /tab=entrega/);
  assert.match(deliveryHref({ ...filters, q: 'A&B' }), /q=A%26B/);
});
test('settlement preserves each native currency and unfinished collection', () => {
  const result = parseDeliverySettlement({ id: 3, orderId: 10, orderNumber: null, status: 'open', clientName: 'Cliente', responsibleName: 'Rider', dispatchedAt: now.toISOString(), collectionFinalizedAt: null, entries: [], currencyBreakdown: ['USD','VES'].map(currencyCode => ({ currencyCode, expectedCollection: 100, customerCollection: 0, cashReturned: 0, custodyOutstanding: 0, cashChangeSent: 50, cashChangeReturned: 0, digitalChangeOutstanding: 0 })) }, 3);
  assert.equal(result.collectionFinalized, false); assert.equal(result.currencies.length, 2); assert.equal(result.currencies[1].currency, 'VES');
  assert.throws(() => parseDeliverySettlement({ id: 4 }, 3));
});
function account(): AdminFinanceAccountSnapshot { return { id: 1, name: 'Caja', currencyCode: 'VES', isActive: true, anchorKind: 'none', openReconciliations: 2, orphanedReconciliations: 1, openReconciliationNative: 100, pendingMovementOperations: 1, pendingMovementNative: 20 } as AdminFinanceAccountSnapshot; }
function order(): ActiveOrder { return { id: 10, clientName: 'Cliente', needsReview: true, scheduledDate: '2026-09-01', pendingReportsCount: 2, pendingUsd: 15 } as ActiveOrder; }
test('tasks deduplicate order conditions and do not double-count orphan reconciliation groups', () => {
  const result = buildAdminTaskGroups({ accounts: [account()], orders: [order()], commissions: [], currentPeriodId: null, today: '2026-09-10' });
  assert.equal(result.length, 4); assert.equal(result.filter(r => r.domain === 'pedidos').length, 1);
  const reconciliation = result.find(r => r.key === 'cuentas:conciliacion:1')!;
  assert.equal(reconciliation.count, 2); assert.equal(reconciliation.currency, 'VES'); assert.match(reconciliation.note, /incluidas/);
  assert.match(result.find(r => r.domain === 'pedidos')!.note, /reportes/);
});
test('resolved source conditions disappear without a second task state', () => {
  const result = buildAdminTaskGroups({ accounts: [{ ...account(), anchorKind: 'baseline', pendingMovementOperations: 0, openReconciliations: 0, orphanedReconciliations: 0 }], orders: [{ ...order(), needsReview: false, scheduledDate: '2026-09-11', pendingReportsCount: 0 }], commissions: [], currentPeriodId: null, today: '2026-09-10' });
  assert.equal(result.length, 0);
});
test('commission tasks keep historical finalized exceptions but no obsolete preliminaries or invented debt', () => {
  const base = { id: 1, periodId: 2, advisorName: 'Asesor', status: 'preliminary', eligibleNow: true, calculationBeforePeriod: true, issues: [], payableUsd: 123 } as unknown as CommissionRow;
  const groups = buildAdminTaskGroups({ accounts: [], orders: [], commissions: [base, { ...base, id: 2, periodId: 1 }, { ...base, id: 3, periodId: 1, status: 'paid', eligibleNow: false, issues: ['Falta evidencia'] }], currentPeriodId: 2, today: '2026-09-10' });
  assert.equal(groups.length, 2); assert.ok(groups.every(row => row.amount === null));
  assert.equal(filterAdminTaskGroups(groups, 'comisiones', 'evidencia').length, 1);
});
test('CSV protects formulas and escapes quotes, commas and newlines without changing numeric negatives', () => {
  const csv = adminCsv([['=SUM(1,2)','  @A1','-cmd','a"b\nc', -12.3, null]]);
  assert.match(csv, /"'=SUM\(1,2\)"/); assert.match(csv, /"'  @A1"/); assert.match(csv, /"'-cmd"/); assert.match(csv, /a""b\nc/); assert.match(csv, /,-12.3,""$/);
  assert.throws(() => adminCsv([[NaN]]));
});
test('reports export complete typed snapshots, both currencies and unavailable equivalences', () => {
  const csv = accountsReport({ asOf: now.toISOString(), definitionVersion: 'admin-finance-accounts-v2', activeRateBsPerUsd: null, accounts: [{ ...account(), balanceNative: 10, currentValueUsd: null, quality: 'Q3_incomplete' }] } as AdminFinanceAccountsOverview);
  assert.match(csv, /"VES",10,"",""/); assert.match(csv, /Q3_incomplete/);
  const orderCsv = activeOrdersReport({ asOf: now.toISOString(), definitionVersion: 'admin-finance-active-orders-v1', orders: [{ ...order(), orderNumber: 'V10', advisorName: 'Asesor', status: 'queued', fulfillment: 'delivery', scheduledTime: null, totalUsd: 20, coveredUsd: 5, pendingReportsUsd: 4, qualityCode: 'Q1_exact' }] } as ActiveOrdersOverview);
  assert.match(orderCsv, /20,5,15,4/);
});
test('legacy deep links only select existing sections for admins, never grant a role', () => {
  assert.equal(resolveLegacyAdminSection('users', ['master']).view, 'operations');
  assert.equal(resolveLegacyAdminSection('unknown', ['admin']).view, 'operations');
  assert.equal(resolveLegacyAdminSection('users', ['admin']).settings, 'users');
  assert.equal(resolveLegacyAdminSection('deliveries', ['admin']).calculations, 'deliveries');
});
test('new reads preserve permission boundaries and exports authenticate independently of layouts', () => {
  const filename = readdirSync('supabase/migrations').find(name => name.endsWith('_admin_delivery_overview_v1.sql'))!;
  const sql = readFileSync(`supabase/migrations/${filename}`,'utf8');
  assert.match(sql,/security invoker set search_path = ''/); assert.match(sql,/r.role = 'admin'/);
  assert.match(sql,/from public,anon,authenticated,service_role/); assert.match(sql,/public.counter_read_pending_settlements/);
  assert.doesNotMatch(sql,/grant select|security definer|update public\./i);
  const route = readFileSync('src/app/app/admin/reportes/exportar/route.ts','utf8');
  assert.match(route,/getAuthContext\(\)/); assert.match(route,/isAdminRole\(ctx.roles\)/); assert.match(route,/private, no-store/);
});
