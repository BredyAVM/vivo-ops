'use server';

import { requireAdminContext } from '@/lib/auth';
import { isStaffPayrollAccount, isStaffPayrollDate, type StaffPayrollAccount } from '@/lib/payments/staff-payroll';
import { applyStaffPayrollPaymentAction } from '../dashboard/actions';

type AccountRow = {
  id: number;
  name: string;
  account_kind: string;
  currency_code: string;
  is_active: boolean;
};

function mapAccount(row: AccountRow): StaffPayrollAccount {
  return {
    id: Number(row.id), name: row.name, accountKind: row.account_kind,
    currencyCode: row.currency_code, isActive: row.is_active,
  };
}

// Loaded only when the administrator opens the payroll form, not with the board.
export async function loadStaffPayrollAccountsAction(): Promise<StaffPayrollAccount[]> {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.from('money_accounts')
    .select('id, name, account_kind, currency_code, is_active')
    .eq('is_active', true).in('account_kind', ['other', 'fund']).order('name');
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapAccount).filter(isStaffPayrollAccount);
}

export async function applyOrdersWorkspaceStaffPayrollAction(input: {
  orderId: number;
  moneyAccountId: number;
  amountUsd: number;
  operationDate: string;
  notes: string | null;
}) {
  const { supabase } = await requireAdminContext();
  if (!Number.isSafeInteger(input.orderId) || input.orderId <= 0 ||
    !Number.isSafeInteger(input.moneyAccountId) || input.moneyAccountId <= 0) {
    throw new Error('Selecciona una orden y una cuenta interna válidas.');
  }
  const { data: account, error: accountError } = await supabase.from('money_accounts')
    .select('id, name, account_kind, currency_code, is_active')
    .eq('id', input.moneyAccountId).single();
  if (accountError) throw new Error(accountError.message);
  if (!account || !isStaffPayrollAccount(mapAccount(account))) {
    throw new Error('Selecciona una cuenta interna de personal activa, no una cuenta bancaria o de caja.');
  }
  const { data: order, error: orderError } = await supabase.from('orders')
    .select('id, status').eq('id', input.orderId).single();
  if (orderError) throw new Error(orderError.message);
  if (!order || order.status === 'cancelled') throw new Error('No se puede aplicar nómina a una orden cancelada.');
  if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0.01) throw new Error('Indica un monto USD mayor a cero.');
  if (!isStaffPayrollDate(input.operationDate)) throw new Error('Fecha de aplicación inválida.');
  // Keep the existing payroll/report/offset/event flow and its live balance check.
  await applyStaffPayrollPaymentAction(input);
}
