export type StaffPayrollAccount = {
  id: number;
  name: string;
  accountKind: string;
  currencyCode: string;
  isActive: boolean;
};

export function isStaffPayrollAccount(account: StaffPayrollAccount) {
  const name = account.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return account.isActive && Number.isSafeInteger(account.id) && account.id > 0 &&
    ['USD', 'VES'].includes(account.currencyCode) &&
    ['other', 'fund'].includes(account.accountKind) &&
    /cxc|cuenta por cobrar|personal|nomina|empleado|trabajador/.test(name);
}

export function canApplyStaffPayroll(roles: readonly string[], order: {
  status: string;
  balanceUsd: number;
  integrityStatus?: string;
}) {
  return roles.includes('admin') && order.status !== 'cancelled' &&
    order.integrityStatus !== 'missing_items' &&
    Number.isFinite(order.balanceUsd) && order.balanceUsd >= 0.01;
}

export function validateStaffPayrollDraft(amountUsd: number, operationDate: string, pendingUsd: number) {
  if (!Number.isFinite(pendingUsd) || pendingUsd < 0.01) return 'La orden ya no tiene saldo pendiente.';
  if (!Number.isFinite(amountUsd) || amountUsd < 0.01) return 'Indica un monto USD mayor a cero.';
  if (amountUsd - pendingUsd > 0.005) return 'El monto no puede superar el saldo pendiente.';
  if (!isStaffPayrollDate(operationDate)) return 'Indica una fecha de aplicación válida.';
  return null;
}

export function isStaffPayrollDate(operationDate: string) {
  const date = new Date(`${operationDate}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(operationDate) && !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === operationDate;
}
