import type { AdminFinanceAccountsOverview } from './accounts-model';
import type { ActiveOrdersOverview } from './active-orders-model';
export function adminCsv(rows: Array<Array<string | number | null>>) {
  return '\uFEFF' + rows.map(row => row.map(value => {
    if (value === null) return '""';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Invalid report number');
      return String(value);
    }
    // Text supplied by users must never become a spreadsheet formula.
    const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
}
export function accountsReport(data: AdminFinanceAccountsOverview) {
  return adminCsv([
    ['Corte UTC','Definición','Cuenta ID','Cuenta','Activa','Moneda','Saldo nativo','Equivalente actual USD','Tasa Bs/USD al corte','Calidad','Base','Conciliaciones abiertas','Movimientos pendientes'],
    ...data.accounts.map(a => [data.asOf,data.definitionVersion,a.id,a.name,a.isActive ? 'Sí' : 'No',a.currencyCode,a.balanceNative,a.currentValueUsd,data.activeRateBsPerUsd,a.quality,a.anchorKind,a.openReconciliations,a.pendingMovementOperations]),
  ]);
}
export function activeOrdersReport(data: ActiveOrdersOverview) {
  return adminCsv([
    ['Corte UTC','Definición','Orden ID','Número','Cliente','Asesor','Estado','Entrega','Fecha programada Caracas','Hora programada Caracas','Total USD','Cubierto USD','Pendiente USD','Reportes por revisar USD','Requiere revisión','Calidad'],
    ...data.orders.map(o => [data.asOf,data.definitionVersion,o.id,o.orderNumber,o.clientName,o.advisorName,o.status,o.fulfillment,o.scheduledDate,o.scheduledTime,o.totalUsd,o.coveredUsd,o.pendingUsd,o.pendingReportsUsd,o.needsReview ? 'Sí' : 'No',o.qualityCode]),
  ]);
}
