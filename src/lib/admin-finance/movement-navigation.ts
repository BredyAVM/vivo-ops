export const ADMIN_MOVEMENT_PATH = '/app/admin/finanzas/cuentas/movimiento';
export type MovementDirection = 'inflow' | 'outflow';

export function adminMovementHref(direction: MovementDirection, accountId?: number) {
  const params = new URLSearchParams({ tipo: direction });
  if (accountId !== undefined && Number.isSafeInteger(accountId) && accountId > 0) params.set('cuenta', String(accountId));
  return `${ADMIN_MOVEMENT_PATH}?${params}`;
}

export function resolveAdminMovementContext(
  params: Record<string, string | string[] | undefined>,
  accounts: readonly { id: number; isActive: boolean }[],
) {
  const first = (key: string) => Array.isArray(params[key]) ? params[key][0] : params[key];
  const rawAccount = first('cuenta');
  const accountId = rawAccount === undefined ? null : Number(rawAccount);
  const account = accountId === null ? null : accounts.find(row => row.id === accountId && row.isActive);
  return {
    direction: first('tipo') === 'outflow' ? 'outflow' as const : 'inflow' as const,
    accountId: account?.id ?? null,
    invalidAccount: rawAccount !== undefined && (!Number.isSafeInteger(accountId) || !account),
  };
}

export function adminMovementHistoryHref(accountId: number, date: string) {
  return `/app/admin/finanzas/cuentas/${accountId}?${new URLSearchParams({ vista: 'movements', desde: date, hasta: date })}`;
}
