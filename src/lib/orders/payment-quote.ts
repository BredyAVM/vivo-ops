import { formatOrderDisplayNumber } from './order-labels.ts';
import {
  formatWhatsAppBs, formatWhatsAppUsd, formatWhatsAppExchangeRate, formatWhatsAppCalculationTime,
} from './whatsapp-summary.ts';

type Numeric = number | string | null;
export type PaymentQuoteState = {
  order_id: Numeric;
  pending_usd: Numeric;
  pending_bs: Numeric;
  snapshot_rate_bs_per_usd: Numeric;
  collection_mode: string | null;
  pending_reports_count: Numeric;
  effective_operation_date: string | null;
};

export type OrderPaymentQuote = {
  orderId: number;
  orderLabel: string;
  pendingUsd: number;
  pendingBs: number;
  exchangeRate: number;
  activeRate: number;
  collectionMode: 'snapshot_quote' | 'post_delivery_usd';
  generatedAt: string;
  operationDate: string;
  pendingReportsCount: number;
  text: string;
};

export type PaymentQuoteActor = { userId: string; roles: readonly string[] };
export type PaymentQuoteOrder = {
  id: number;
  status: string;
  attributed_advisor_id: string | null;
};

export type PaymentQuoteReader = {
  readOrder: (orderId: number) => Promise<PaymentQuoteOrder | null>;
  readActiveRate: () => Promise<number | null>;
  readState: (orderId: number, operationDate: string, activeRate: number) => Promise<PaymentQuoteState | null>;
};

function validAmount(value: Numeric, field: string) {
  if (value == null || String(value).trim() === '') throw new Error(`La cotización no tiene ${field}.`);
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`La cotización tiene ${field} inválido.`);
  return amount;
}

export function quoteOperationDate(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('Fecha de consulta inválida.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function buildOrderPaymentQuote(input: {
  orderId: number; state: PaymentQuoteState; activeRate: number; now: Date;
}): OrderPaymentQuote {
  const { state, orderId, activeRate, now } = input;
  if (Number(state.order_id) !== orderId) throw new Error('La cotización no corresponde a esta orden.');
  if (!Number.isFinite(activeRate) || activeRate <= 0) throw new Error('No hay una tasa vigente válida.');
  if (state.collection_mode !== 'snapshot_quote' && state.collection_mode !== 'post_delivery_usd') {
    throw new Error('La orden requiere revisar su regla de cobranza antes de cotizar.');
  }
  // These are certified balances. Never rebuild Bs from the displayed, rounded USD balance.
  const pendingUsd = validAmount(state.pending_usd, 'saldo USD');
  const pendingBs = validAmount(state.pending_bs, 'saldo Bs');
  const exchangeRate = state.collection_mode === 'snapshot_quote'
    ? validAmount(state.snapshot_rate_bs_per_usd, 'tasa del presupuesto') : activeRate;
  if (exchangeRate <= 0) throw new Error('La orden no conserva una tasa válida para cotizar.');
  const operationDate = quoteOperationDate(now);
  if (state.effective_operation_date !== operationDate) throw new Error('La cotización no corresponde a la fecha de hoy.');
  const pendingReportsCount = validAmount(state.pending_reports_count, 'cantidad de pagos por revisar');
  if (!Number.isSafeInteger(pendingReportsCount)) throw new Error('Cantidad de pagos por revisar inválida.');
  const generatedAt = now.toISOString();
  const orderLabel = formatOrderDisplayNumber(orderId);
  const parts = [
    '*Cotización de pago*', `*Orden:* ${orderLabel}`,
    `*Saldo pendiente USD:* ${formatWhatsAppUsd(pendingUsd)}`,
    `*Monto a pagar en bolívares:* ${formatWhatsAppBs(pendingBs)}`,
    `*${state.collection_mode === 'snapshot_quote' ? 'Tasa del presupuesto' : 'Tasa vigente'}:* ${formatWhatsAppExchangeRate(exchangeRate)}`,
    `*Consultado:* ${formatWhatsAppCalculationTime(generatedAt)}`,
  ];
  if (pendingUsd === 0 && pendingBs === 0) parts.push('Sin deuda pendiente.');
  if (state.collection_mode === 'snapshot_quote') parts.push('Se conserva el monto en bolívares acordado para esta orden.');
  if (pendingReportsCount > 0) parts.push('Hay pagos por revisar; todavía no están descontados de este saldo.');
  parts.push('Esta consulta no registra un pago.');
  return { orderId, orderLabel, pendingUsd, pendingBs, exchangeRate, activeRate,
    collectionMode: state.collection_mode, generatedAt, operationDate, pendingReportsCount, text: parts.join('\n') };
}

/** Only read capabilities are accepted. Ownership is checked before financial data is requested. */
export async function readOrderPaymentQuote(input: {
  orderId: number; actor: PaymentQuoteActor; reader: PaymentQuoteReader; now: Date;
}) {
  const { orderId, actor, reader, now } = input;
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Orden inválida.');
  if (!actor.userId) throw new Error('No autenticado.');
  const privileged = actor.roles.includes('admin') || actor.roles.includes('master');
  if (!privileged && !actor.roles.includes('advisor')) throw new Error('No autorizado.');
  const order = await reader.readOrder(orderId);
  if (!order || order.id !== orderId) throw new Error('No se pudo consultar la orden.');
  if (!privileged && order.attributed_advisor_id !== actor.userId) throw new Error('No autorizado para consultar esta orden.');
  if (order.status === 'cancelled') throw new Error('La orden está cancelada; revisa su historial financiero.');
  const activeRate = await reader.readActiveRate();
  if (activeRate == null || !Number.isFinite(activeRate) || activeRate <= 0) throw new Error('No hay una tasa vigente válida.');
  const state = await reader.readState(orderId, quoteOperationDate(now), activeRate);
  if (!state) throw new Error('No se pudo consultar el saldo financiero.');
  return buildOrderPaymentQuote({ orderId, state, activeRate, now });
}
