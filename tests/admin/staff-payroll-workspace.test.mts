import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canApplyStaffPayroll, isStaffPayrollAccount, isStaffPayrollDate, validateStaffPayrollDraft } from '../../src/lib/payments/staff-payroll.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const account = { id: 16, name: 'CxC Personal', accountKind: 'other', currencyCode: 'USD', isActive: true };
const order = { status: 'delivered', balanceUsd: 14, integrityStatus: 'complete' };

test('payroll access is administrative and includes delivered orders with debt', () => {
  assert.equal(canApplyStaffPayroll(['admin'], order), true);
  assert.equal(canApplyStaffPayroll(['admin', 'master'], order), true);
  for (const roles of [[], ['master'], ['advisor'], ['counter']]) assert.equal(canApplyStaffPayroll(roles, order), false);
  for (const override of [{ status: 'cancelled' }, { balanceUsd: 0 }, { balanceUsd: 0.009 }, { balanceUsd: Number.NaN }, { integrityStatus: 'missing_items' }]) {
    assert.equal(canApplyStaffPayroll(['admin'], { ...order, ...override }), false);
  }
});

test('only active internal payroll accounts are eligible; cash and banks are never a fallback', () => {
  assert.equal(isStaffPayrollAccount(account), true);
  assert.equal(isStaffPayrollAccount({ ...account, name: 'Nómina', accountKind: 'fund', currencyCode: 'VES' }), true);
  for (const override of [{ isActive: false }, { id: 0 }, { currencyCode: 'EUR' }, { accountKind: 'bank' }, { accountKind: 'cash' }, { accountKind: 'wallet' }, { name: 'Otros gastos' }]) {
    assert.equal(isStaffPayrollAccount({ ...account, ...override }), false);
  }
});

test('payroll supports full and partial debt application without negative or excess amounts', () => {
  assert.equal(validateStaffPayrollDraft(14, '2026-10-12', 14), null);
  assert.equal(validateStaffPayrollDraft(5, '2026-10-12', 14), null);
  assert.equal(validateStaffPayrollDraft(0.01, '2026-10-12', 0.01), null);
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 14.01]) {
    assert.ok(validateStaffPayrollDraft(amount, '2026-10-12', 14));
  }
  assert.ok(validateStaffPayrollDraft(14, '2026-10-12', 0));
  assert.ok(validateStaffPayrollDraft(14, '2026-10-12', Number.NaN));
});

test('payroll validates real calendar dates and permits previous operational dates', () => {
  for (const date of ['2026-10-12', '2026-10-11', '2024-02-29']) assert.equal(isStaffPayrollDate(date), true);
  for (const date of ['', '2026-02-29', '2026-02-30', '12/10/2026', '2026-13-01', '2026-10-12T12:00:00Z']) {
    assert.equal(isStaffPayrollDate(date), false);
    assert.ok(validateStaffPayrollDraft(5, date, 14));
  }
});

test('workspace loads the compact payroll form only after an administrative click in payments', () => {
  const ui = read('src/components/orders/OrdersWorkspaceClient.tsx');
  assert.match(ui, /const StaffPayrollPaymentForm = dynamic/);
  assert.match(ui, /const canOpenStaffPayroll = activeTab === "pagos" && canApplyStaffPayroll\(roles, order\)/);
  assert.match(ui, /\{canOpenStaffPayroll && staffPayrollOpen \? \(/);
  assert.match(ui, /Pagar por nómina/);
  assert.match(ui, /onDirectAction\(order, "staff-payroll"/);
  const action = ui.slice(ui.indexOf('if (action === "staff-payroll")'), ui.indexOf('} else if (action === "approve")'));
  assert.match(action, /canApplyStaffPayroll\(roles, order\)/);
  assert.match(action, /applyOrdersWorkspaceStaffPayrollAction/);
  const loader = read('src/lib/orders/operations-workspace.tsx');
  assert.doesNotMatch(loader, /loadStaffPayrollAccountsAction|StaffPayrollPaymentForm/);
});

test('server rechecks role, internal account and cancellation before delegating to the existing flow', () => {
  const source = read('src/app/app/master/ops/staff-payroll-actions.ts');
  assert.equal((source.match(/await requireAdminContext\(\)/g) ?? []).length, 2);
  const apply = source.slice(source.indexOf('export async function applyOrdersWorkspaceStaffPayrollAction'));
  assert.ok(apply.indexOf('await requireAdminContext()') < apply.indexOf("supabase.from('money_accounts')"));
  assert.match(apply, /isStaffPayrollAccount\(mapAccount\(account\)\)/);
  assert.match(apply, /order.status === 'cancelled'/);
  assert.match(apply, /await applyStaffPayrollPaymentAction\(input\)/);
  assert.doesNotMatch(source, /service.role|\.insert\(|\.update\(/i);
  const legacy = read('src/app/app/master/dashboard/actions.ts');
  const flow = legacy.slice(legacy.indexOf('export async function applyStaffPayrollPaymentAction'), legacy.indexOf('export async function applyClientFundPaymentAction'));
  assert.match(flow, /requireAdminRole\(roles\)/);
  assert.match(flow, /loadOrderFinancialState/);
  assert.match(flow, /paymentUsd - pendingUsd > 0.005/);
  assert.match(flow, /order_id: null,[\s\S]*payment_report_id: null/);
});

test('payroll review displays USD, short order number and account before confirming; duplicate clicks are blocked', () => {
  const ui = read('src/components/orders/StaffPayrollPaymentForm.tsx');
  assert.match(ui, /formatOrderDisplayNumber\(orderId\)/);
  assert.doesNotMatch(ui, /orderNumber|window\.confirm/);
  assert.match(ui, /Monto a aplicar \(USD\)/);
  assert.match(ui, /currentTarget.select\(\)/);
  assert.match(ui, /aria-label="Confirmación de nómina"/);
  assert.match(ui, /Confirmar pago por nómina/);
  assert.match(ui, /if \(!review \|\| disabled \|\| requestBusyRef.current\) return/);
  assert.match(ui, /validateStaffPayrollDraft\(review.amountUsd, review.operationDate, pendingUsd\)/);
  assert.match(ui, /let mounted = true/);
});
