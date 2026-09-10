import type { AdminFinanceAccountSnapshot } from './accounts-model';
import type { ActiveOrder } from './active-orders-model';
import type { CommissionRow } from './commissions-model';
export type AdminTaskGroup = { key: string; domain: 'cuentas' | 'pedidos' | 'comisiones'; title: string; entity: string; count: number; href: string; attention: boolean; amount: number | null; currency: 'USD' | 'VES'; note: string };
export function buildAdminTaskGroups(input: { accounts: AdminFinanceAccountSnapshot[]; orders: ActiveOrder[]; commissions: CommissionRow[]; currentPeriodId: number | null; today: string }): AdminTaskGroup[] {
  const result: AdminTaskGroup[] = [];
  for (const a of input.accounts) {
    const base = { domain: 'cuentas' as const, entity: a.name, currency: a.currencyCode };
    const accountHref = `/app/admin/finanzas/cuentas/${a.id}`;
    if (a.openReconciliations > 0) result.push({ ...base, key: `cuentas:conciliacion:${a.id}`, title: 'Revisar conciliaciones', count: a.openReconciliations, href: `${accountHref}?vista=reconciliation&estado=open&desde=2020-01-01`, attention: a.orphanedReconciliations > 0, amount: a.openReconciliationNative, note: a.orphanedReconciliations ? `${a.orphanedReconciliations} con origen no vigente; incluidas en este grupo` : 'Diferencias abiertas; no son pagos pendientes' });
    if (a.pendingMovementOperations > 0) result.push({ ...base, key: `cuentas:movimientos:${a.id}`, title: 'Revisar movimientos', count: a.pendingMovementOperations, href: `${accountHref}?vista=movements&estado=pending&desde=2020-01-01`, attention: false, amount: a.pendingMovementNative, note: 'Operaciones agrupadas por cuenta' });
    if (a.isActive && a.anchorKind === 'none') result.push({ ...base, key: `cuentas:base:${a.id}`, title: 'Revisar base del saldo', count: 1, href: `${accountHref}?vista=configuration`, attention: true, amount: null, note: 'Cuenta activa sin base o cierre válido' });
  }
  for (const o of input.orders) {
    // One group per order, even when more than one condition is present.
    const reasons = [o.needsReview ? 'Revisión de orden' : '', o.scheduledDate === null ? 'Sin fecha' : o.scheduledDate < input.today ? 'Entrega pendiente de fecha anterior' : '', o.pendingReportsCount > 0 ? `${o.pendingReportsCount} reportes de pago por revisar` : ''].filter(Boolean);
    if (reasons.length) result.push({ key: `pedidos:revision:${o.id}`, domain: 'pedidos', title: reasons[0], entity: `#${o.id} · ${o.clientName}`, count: 1,
      href: `/app/master/ops?${new URLSearchParams({ openOrder: String(o.id), ...(o.scheduledDate ? { focusDate: o.scheduledDate } : {}) })}`, attention: o.needsReview || (o.scheduledDate !== null && o.scheduledDate < input.today), amount: o.pendingUsd, currency: 'USD', note: reasons.slice(1).join(' · ') || 'Saldo de esta orden; no se suma a diferencias de cuenta' });
  }
  for (const c of input.commissions) {
    const currentPreliminary = c.status === 'preliminary' && c.eligibleNow && c.periodId === input.currentPeriodId;
    if (!currentPreliminary && c.status !== 'closed' && !(c.status === 'paid' && c.issues.length)) continue;
    result.push({ key: `comisiones:revision:${c.id}`, domain: 'comisiones', title: c.calculationBeforePeriod ? 'Actualizar cálculo' : c.status === 'preliminary' ? 'Revisar cálculo preliminar' : c.status === 'closed' ? 'Revisar liquidación cerrada' : 'Revisar evidencia de pago', entity: c.advisorName, count: 1,
      href: `/app/commissions/${c.id}?section=settlement#audit-detail`, attention: c.status === 'paid' && c.issues.length > 0, amount: null, currency: 'USD', note: `Cierre #${c.id} · ${c.issues[0] || 'Abrir el cierre para decidir'}` });
  }
  if (new Set(result.map(row => row.key)).size !== result.length) throw new Error('Duplicate administrative groups');
  return result.sort((a, b) => Number(b.attention) - Number(a.attention) || a.domain.localeCompare(b.domain) || a.entity.localeCompare(b.entity, 'es'));
}
export function filterAdminTaskGroups(groups: AdminTaskGroup[], domain: string, q: string) {
  const query = q.trim().toLocaleLowerCase('es');
  return groups.filter(row => (domain === 'all' || row.domain === domain) && (!query || `${row.title} ${row.entity} ${row.note}`.toLocaleLowerCase('es').includes(query)));
}
