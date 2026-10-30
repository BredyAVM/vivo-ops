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
export async function loadStaffPayrollAccountsAction(): Promise<StaffPayrollAccount[]> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function applyOrdersWorkspaceStaffPayrollAction(input: {
  orderId: number;
  moneyAccountId: number;
  amountUsd: number;
  operationDate: string;
  notes: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
