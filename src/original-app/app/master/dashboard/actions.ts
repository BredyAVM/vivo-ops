'use server';

import { preserveAdvisorCommissionWorkflowSnapshot } from '@/lib/commissions/workflow-snapshot';
import * as configurationCommands from '@/lib/admin-config/canonical-actions';
export async function updateExchangeRateAction(input: Parameters<typeof configurationCommands.updateExchangeRateAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function createMoneyAccountAction(input: Parameters<typeof configurationCommands.createMoneyAccountAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function updateMoneyAccountAction(input: Parameters<typeof configurationCommands.updateMoneyAccountAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function toggleMoneyAccountActiveAction(input: Parameters<typeof configurationCommands.toggleMoneyAccountActiveAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function updateMoneyAccountPaymentRulesAction(input: Parameters<typeof configurationCommands.updateMoneyAccountPaymentRulesAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function createMoneyAccountBaselineAction(input: Parameters<typeof configurationCommands.createMoneyAccountBaselineAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function createDeliveryPartnerAction(input: Parameters<typeof configurationCommands.createDeliveryPartnerAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function updateDeliveryPartnerAction(input: Parameters<typeof configurationCommands.updateDeliveryPartnerAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function toggleDeliveryPartnerActiveAction(input: Parameters<typeof configurationCommands.toggleDeliveryPartnerActiveAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function loadDeliveryPartnerRatesAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function createDeliveryPartnerRateAction(input: Parameters<typeof configurationCommands.createDeliveryPartnerRateAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function updateDeliveryPartnerRateAction(input: Parameters<typeof configurationCommands.updateDeliveryPartnerRateAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function toggleDeliveryPartnerRateActiveAction(input: Parameters<typeof configurationCommands.toggleDeliveryPartnerRateActiveAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function createClientAction(input: Parameters<typeof configurationCommands.createClientAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function updateClientAction(input: Parameters<typeof configurationCommands.updateClientAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function toggleClientActiveAction(input: Parameters<typeof configurationCommands.toggleClientActiveAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function updateDashboardUserAction(input: Parameters<typeof configurationCommands.updateDashboardUserAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
import { buildOrderCancellationCommand, readOrderCancellationPreview, readOrderCancellationReceipt, type OrderCancellationInput } from '@/lib/domain/order-cancellation-command';

import { buildPaymentConfirmationCommand, readPaymentConfirmationReceipt, type PaymentConfirmationInput } from '@/lib/domain/payment-confirmation-command';

import { revalidatePath, updateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/supabase/server';
import { requireAuthContext, requireMasterOrAdminContext } from '@/lib/auth';
import { verifyMuerdemeOrderItems } from '@/lib/brands/order-menu-save';
import { sendPushToAdvisorDevices, sendPushToRoleDevices } from '@/lib/push';
import { getPaymentReportRequirements } from '@/lib/payments/payment-report-rules';
import { assertNoActivePaymentDuplicate } from '@/lib/payments/payment-duplicates';
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from '@/lib/pricing/order-snapshots';
import { APPROVED_PRICE_CHANGE_MESSAGE, hasUnauthorizedPriceChange, preservedApprovedPriceSnapshot, storedApprovedPriceLine } from '@/lib/orders/approved-price-preservation';
import { preservedAgreedPriceSnapshot, preservedOperationalSnapshot } from '@/lib/orders/operational-edit-pricing';
import { getPhoneSearchTerms, normalizePhone } from '@/lib/phone/normalize-phone';
import { normalizeRemoteSearchValue } from '@/lib/search/normalize-search';
import { searchClientSummaries } from '@/lib/search/client-search';
import { formatOrderDisplayLabel, getPaymentMethodLabel } from '@/lib/orders/order-labels';
import { isOrderPriceProtected } from '@/lib/domain/order-domain';
import { loadMoneyAccountBalanceSnapshots } from '@/lib/finance/account-balances';
import { executeMoneyTransfer } from '@/lib/finance/money-transfer-command';
import { loadAccountClosurePreview } from '@/lib/finance/account-closure-preview';
import {
  advisorReceivesCommissions,
  loadEligibleCommissionAdvisors,
} from '@/lib/commissions/advisor-eligibility';
import {
  countedAdvisorNewClientType,
  isAdvisorCommercialOrder,
} from '@/lib/commissions/commercial-criteria';
import { preserveAdvisorGoalPublicationSnapshot } from '@/lib/commissions/goal-snapshot';
import {
  EVENT_COMMISSION_TERMS_KIND,
  ORDER_COMMISSION_TERMS_KIND,
  commissionTermsEqual,
  normalizeOrderCommissionTerms,
  parseOrderCommissionAdjustmentPayload,
  validateOrderCommissionTerms,
  type OrderCommissionMode,
  type OrderCommissionTerms,
} from '@/lib/commissions/order-commission-terms';
import { resolveProductCommissionTerms } from '@/lib/commissions/product-commission-policy';
import {
  getOrderCommercialNetUsd,
  getOrderLineTotalUsd,
  getOrderMoneySnapshot,
  getOrderRoundingClosureSnapshot,
} from '@/lib/orders/order-money';
import { parseDeliveryCostInput, parseDeliveryDistanceInput, readDeliveryCorrectionReceipt } from '@/lib/domain/delivery-cost';
import { getMasterDashboardPermissions } from './permissions';

const MASTER_DASHBOARD_FINANCIAL_REFERENCES_TAG = 'master-dashboard-financial-references';
const STALE_ORDER_EDIT_MESSAGE =
  'No se guardaron los cambios porque otra persona actualizó esta orden después de que la abriste. Para evitar pisar su trabajo, actualiza la orden, revisa lo nuevo y vuelve a guardar si todavía aplica.';
const LEGACY_INVENTORY_ADMIN_DISABLED_MESSAGE =
  'La administración de inventario fue trasladada al Centro de Inventario. Usa /app/inventory/configure para productos, ítems y recetas, y las secciones operativas del centro para movimientos y producción.';

function rejectLegacyInventoryAdministration(): void {
  throw new Error(LEGACY_INVENTORY_ADMIN_DISABLED_MESSAGE);
}

function revalidateMasterDashboardFinancialReferences() {
  revalidatePath('/app/advisor/wallet');
  revalidatePath('/app/admin/premios');
  updateTag(MASTER_DASHBOARD_FINANCIAL_REFERENCES_TAG);
  revalidatePath('/app/admin', 'layout');
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/admin/ordenes');
}

async function requireMasterOrAdmin() {
  return requireMasterOrAdminContext();
}

async function requireKitchenOperator() {
  const ctx = await requireAuthContext();
  const allowed = ctx.roles.includes('admin') || ctx.roles.includes('master') || ctx.roles.includes('kitchen');

  if (!allowed) {
    throw new Error('Esta accion requiere permisos de cocina, master o administrador.');
  }

  return ctx;
}

async function requireDeliveryOperator() {
  const ctx = await requireAuthContext();
  const allowed = ctx.roles.includes('admin') || ctx.roles.includes('master') || ctx.roles.includes('counter');

  if (!allowed) {
    throw new Error('Esta accion requiere permisos de mostrador, master o administrador.');
  }

  return ctx;
}

async function requirePaymentReportOperator() {
  const ctx = await requireAuthContext();
  const allowed = ctx.roles.includes('admin') || ctx.roles.includes('master') || ctx.roles.includes('counter');

  if (!allowed) {
    throw new Error('Esta accion requiere permisos de cobro, master o administrador.');
  }

  return ctx;
}

async function loadActiveExchangeRate(supabase: Awaited<ReturnType<typeof createSupabaseServer>>) {
  const { data, error } = await supabase
    .from('exchange_rates')
    .select('rate_bs_per_usd')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const rate = toSafeNumber(data?.rate_bs_per_usd, 0);
  if (rate <= 0) {
    throw new Error('No hay una tasa activa valida.');
  }

  return rate;
}

function createSupabaseServiceRoleServer() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Falta configurar SUPABASE_SERVICE_ROLE_KEY para acciones administrativas.');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function valuesEquivalent(field: string, beforeValue: unknown, afterValue: unknown): boolean {
  if (field === 'total_usd' || field === 'total_bs_snapshot') {
    const beforeNumber = Number(beforeValue ?? 0);
    const afterNumber = Number(afterValue ?? 0);

    if (Number.isFinite(beforeNumber) && Number.isFinite(afterNumber)) {
      return Math.abs(beforeNumber - afterNumber) < 0.005;
    }
  }

  return stableStringify(beforeValue) === stableStringify(afterValue);
}

function toSafeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value: unknown) {
  const n = toSafeNumber(value, 0);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}



function buildClientPhoneOrFilters(phone: string) {
  return [
    `phone.eq.${phone}`,
    ...getPhoneSearchTerms(phone)
      .map((term) => term.replace(/[,%]/g, ' '))
      .filter(Boolean)
      .slice(0, 5)
      .map((term) => `phone.ilike.%${term}%`),
  ];
}

function getOrderPricingSnapshot(order: { extra_fields?: unknown }) {
  const extraFields =
    order.extra_fields && typeof order.extra_fields === 'object' && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as Record<string, unknown>)
      : {};

  return extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
    ? (extraFields.pricing as Record<string, unknown>)
    : {};
}

function getEffectiveOrderTotalUsd(order: { total_usd?: unknown; extra_fields?: unknown }) {
  const pricing = getOrderPricingSnapshot(order);
  const snapshotTotalUsd = toSafeNumber(pricing.total_usd, Number.NaN);

  if (Number.isFinite(snapshotTotalUsd)) {
    return roundMoney(snapshotTotalUsd);
  }

  return roundMoney(order.total_usd);
}

function getEffectiveOrderTotalBs(order: { total_bs_snapshot?: unknown; extra_fields?: unknown }) {
  const pricing = getOrderPricingSnapshot(order);
  const snapshotTotalBs = toSafeNumber(pricing.total_bs, Number.NaN);

  if (Number.isFinite(snapshotTotalBs)) {
    return roundMoney(snapshotTotalBs);
  }

  return roundMoney(order.total_bs_snapshot);
}

function getEffectiveOrderPendingUsd(input: {
  order: { extra_fields?: any };
  financialState?: { pending_usd?: unknown } | null;
  fallbackPendingUsd?: unknown;
}) {
  const roundingClosure = getOrderRoundingClosureSnapshot(input.order);
  if (roundingClosure.isClosed) return 0;

  return roundMoney(
    input.financialState?.pending_usd ??
      input.fallbackPendingUsd ??
      0
  );
}

function normalizeDateOnly(value: unknown) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function parseRpcId(value: unknown) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function savePaymentReportOperationDate(reportId: unknown, operationDate: unknown) {
  const id = parseRpcId(reportId);
  const normalizedOperationDate = normalizeDateOnly(operationDate);

  if (!id || !normalizedOperationDate) return;

  const adminSupabase = createSupabaseServiceRoleServer();
  const { error } = await adminSupabase
    .from('payment_reports')
    .update({ operation_date: normalizedOperationDate })
    .eq('id', id);

  if (error) throw new Error(error.message);
}

function getCaracasDateString(value: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function dateOnlyFromIso(value: unknown) {
  const text = String(value || '').trim();
  if (!text) return null;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;

  return getCaracasDateString(date);
}

function compareDateOnly(a: string, b: string) {
  return a.localeCompare(b);
}

function getOrderDeliveryReferenceDate(order: { status?: unknown; extra_fields?: unknown }) {
  const extraFields =
    order.extra_fields && typeof order.extra_fields === 'object' && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as Record<string, any>)
      : {};

  const completedAt = dateOnlyFromIso(extraFields.delivery?.completed_at);
  if (completedAt) return completedAt;

  if (String(order.status || '') !== 'delivered') return null;

  const scheduledDate = normalizeDateOnly(extraFields.schedule?.date);
  if (scheduledDate) return scheduledDate;

  return null;
}

function canUseSnapshotForPaymentOperation(
  order: { status?: unknown; extra_fields?: unknown },
  operationDate: string | null
) {
  const deliveryDate = getOrderDeliveryReferenceDate(order);
  if (!deliveryDate) return true;

  const effectiveOperationDate = operationDate || getCaracasDateString(new Date());
  return compareDateOnly(effectiveOperationDate, deliveryDate) <= 0;
}

const ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD = 1;
const MASTER_OUTFLOW_ADMIN_APPROVAL_MIN_USD = 10;

type OrderFinancialState = {
  total_usd: number | string | null;
  total_bs: number | string | null;
  snapshot_rate_bs_per_usd: number | string | null;
  confirmed_paid_usd: number | string | null;
  pending_reports_usd: number | string | null;
  pending_reports_bs_snapshot: number | string | null;
  pending_usd: number | string | null;
  pending_bs: number | string | null;
  overpaid_usd: number | string | null;
  collection_mode: string | null;
};

type NotificationRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'counter' | 'driver';
type OrderEventSeverity = 'info' | 'warning' | 'critical';
type AppUserRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'counter' | 'driver';
type PaymentMethodCode = 'payment_mobile' | 'transfer' | 'zelle' | 'wallet_usd' | 'cash_usd' | 'cash_ves' | 'pos' | 'retention';

const PAYMENT_METHOD_CODES = new Set<PaymentMethodCode>([
  'payment_mobile',
  'transfer',
  'zelle',
  'wallet_usd',
  'cash_usd',
  'cash_ves',
  'pos',
  'retention',
]);


function normalizePaymentMethodCode(input: unknown): PaymentMethodCode | null {
  if (typeof input !== 'string') return null;
  return PAYMENT_METHOD_CODES.has(input as PaymentMethodCode) ? (input as PaymentMethodCode) : null;
}

async function loadOrderFinancialState(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    orderId: number;
    operationDate?: string | null;
    activeBsRate?: number | null;
  }
) {
  const { data, error } = await (supabase as any).rpc('get_order_financial_state', {
    p_order_id: input.orderId,
    p_operation_date: input.operationDate || null,
    p_active_bs_rate: input.activeBsRate && input.activeBsRate > 0 ? input.activeBsRate : null,
  });

  if (error) {
    console.warn('get_order_financial_state skipped in master action', error.message);
    return null;
  }

  return (((data ?? []) as OrderFinancialState[])[0] ?? null);
}

function getSnapshotEquivalentUsdFromFinancialState(input: {
  state: OrderFinancialState | null;
  reportedAmount: number;
}) {
  const state = input.state;
  if (!state || state.collection_mode !== 'snapshot_quote') return null;

  const reportedAmount = roundMoney(input.reportedAmount);
  const pendingUsd = roundMoney(state.pending_usd);
  const pendingBs = roundMoney(state.pending_bs);
  const totalUsd = roundMoney(state.total_usd);
  const totalBs = roundMoney(state.total_bs);
  const snapshotRate = toSafeNumber(state.snapshot_rate_bs_per_usd, 0);

  if (pendingUsd > 0.005 && pendingBs > 0.005 && Math.abs(reportedAmount - pendingBs) <= 0.01) {
    return pendingUsd;
  }

  if (reportedAmount > 0 && pendingBs > 0.005 && reportedAmount < pendingBs && snapshotRate > 0) {
    return roundMoney(reportedAmount / snapshotRate);
  }

  if (totalUsd > 0.005 && totalBs > 0.005 && Math.abs(reportedAmount - totalBs) <= 0.01) {
    return totalUsd;
  }

  return null;
}

function requiresAdminMovementApproval(
  roles: readonly string[],
  direction: 'inflow' | 'outflow',
  amountUsd: number,
  movementType?: 'change_given' | 'expense_payment' | 'other_income' | 'withdrawal'
) {
  if (direction !== 'outflow') return false;
  if (getMasterDashboardPermissions(roles).isAdmin) return false;
  if (movementType === 'change_given') return false;
  return amountUsd >= MASTER_OUTFLOW_ADMIN_APPROVAL_MIN_USD;
}

function requireAdminRole(roles: readonly string[]) {
  if (!getMasterDashboardPermissions(roles).isAdmin) {
    throw new Error('Esta acción requiere permisos de administrador.');
  }
}

async function notifyAdminMoneyApproval(input: {
  title: string;
  body: string;
  tag: string;
}) {
  try {
    await sendPushToRoleDevices({
      roles: ['admin'],
      title: input.title,
      body: input.body,
      url: '/app/master/dashboard',
      tag: input.tag,
      tone: 'critical',
      requireInteraction: true,
    });
  } catch (pushError) {
    console.warn(
      'admin money approval push skipped',
      pushError instanceof Error ? pushError.message : 'unknown push error',
    );
  }
}

type OrderEventContext = {
  orderId: number;
  orderNumber: string | null;
  createdAt: string | null;
  advisorUserId: string | null;
  internalDriverUserId: string | null;
  fulfillment: 'pickup' | 'delivery' | null;
  status: string | null;
  clientName: string | null;
};

type OrderEventRecipientInput = {
  targetRole?: NotificationRole | null;
  targetUserId?: string | null;
  requiresAction?: boolean;
  notify?: boolean;
};



type MasterInboxStateItemInput = {
  itemId: string;
  itemType: 'task' | 'event';
  orderId: number | null;
};

function normalizeMasterInboxStateItems(input: unknown): MasterInboxStateItemInput[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  const items: MasterInboxStateItemInput[] = [];

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;

    const record = raw as Record<string, unknown>;
    const itemId = String(record.itemId || '').trim();
    const itemType = record.itemType === 'event' ? 'event' : record.itemType === 'task' ? 'task' : null;
    const orderId = record.orderId == null ? null : Number(record.orderId);

    if (!itemId || !itemType || seen.has(itemId)) continue;
    if (itemId.length > 160) continue;
    if (record.orderId != null && !Number.isFinite(orderId)) continue;

    seen.add(itemId);
    items.push({
      itemId,
      itemType,
      orderId: orderId == null ? null : orderId,
    });
  }

  return items;
}

function getTimelineEventId(itemId: string) {
  const match = itemId.match(/^timeline-(\d+)$/);
  if (!match) return null;
  const eventId = Number(match[1]);
  return Number.isFinite(eventId) && eventId > 0 ? eventId : null;
}

async function appendKitchenIncidentStateEvents(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  actorUserId: string,
  items: MasterInboxStateItemInput[],
  state: 'reviewed' | 'resolved' | 'reopened',
) {
  const sourceEventIds = items
    .filter((item) => item.itemType === 'event')
    .map((item) => getTimelineEventId(item.itemId))
    .filter((eventId): eventId is number => eventId != null);

  if (sourceEventIds.length === 0) return;

  const { data: sourceEvents, error } = await supabase
    .from('order_timeline_events')
    .select('id, order_id, event_type')
    .in('id', sourceEventIds)
    .eq('event_type', 'kitchen_incident');

  if (error) throw new Error(error.message);

  const presentation = {
    reviewed: {
      eventType: 'kitchen_incident_reviewed',
      title: 'Master reviso la incidencia',
      message: 'Master recibio y reviso el problema reportado por Cocina.',
      severity: 'info' as const,
    },
    resolved: {
      eventType: 'kitchen_incident_resolved',
      title: 'Incidencia resuelta por Master',
      message: 'Master marco como resuelto el problema reportado por Cocina.',
      severity: 'info' as const,
    },
    reopened: {
      eventType: 'kitchen_incident_reopened',
      title: 'Incidencia reabierta por Master',
      message: 'Master reabrio el seguimiento del problema reportado por Cocina.',
      severity: 'warning' as const,
    },
  }[state];

  for (const sourceEvent of sourceEvents ?? []) {
    const orderId = Number(sourceEvent.order_id);
    const sourceIncidentEventId = Number(sourceEvent.id);
    if (!Number.isFinite(orderId) || orderId <= 0 || !Number.isFinite(sourceIncidentEventId)) continue;

    await appendOrderEvent(supabase, {
      orderId,
      eventType: presentation.eventType,
      eventGroup: 'kitchen',
      title: presentation.title,
      message: presentation.message,
      severity: presentation.severity,
      actorUserId,
      payload: {
        source_incident_event_id: sourceIncidentEventId,
        incident_state: state,
      },
      recipients: [{ targetRole: 'kitchen', notify: true }],
    });
  }
}

async function saveMasterInboxItemsState(
  input: { items: MasterInboxStateItemInput[] },
  status: 'reviewed' | 'resolved'
) {
  const { supabase, user } = await requireMasterOrAdmin();
  const items = normalizeMasterInboxStateItems(input.items);

  if (items.length === 0) return;

  const { data: currentStates, error: currentStatesError } = await supabase
    .from('master_inbox_item_states')
    .select('item_id, status')
    .in('item_id', items.map((item) => item.itemId));

  if (currentStatesError) throw new Error(currentStatesError.message);

  const currentStatusByItemId = new Map(
    (currentStates ?? []).map((item) => [String(item.item_id), String(item.status)]),
  );
  const changedItems = items.filter((item) => {
    const currentStatus = currentStatusByItemId.get(item.itemId);
    if (status === 'reviewed' && currentStatus === 'resolved') return false;
    return currentStatus !== status;
  });

  if (changedItems.length === 0) return;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('master_inbox_item_states')
    .upsert(
      changedItems.map((item) => ({
        item_id: item.itemId,
        item_type: item.itemType,
        order_id: item.orderId,
        status,
        reviewed_by_user_id: user.id,
        reviewed_at: now,
        resolved_by_user_id: status === 'resolved' ? user.id : null,
        resolved_at: status === 'resolved' ? now : null,
        reopened_by_user_id: null,
        reopened_at: null,
        updated_at: now,
      })),
      { onConflict: 'item_id' }
    );

  if (error) {
    throw new Error(error.message);
  }

  await appendKitchenIncidentStateEvents(supabase, user.id, changedItems, status);

  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/kitchen');
}

export async function markMasterInboxItemsReviewedAction(input: { items: MasterInboxStateItemInput[] }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function resolveMasterInboxItemsAction(input: { items: MasterInboxStateItemInput[] }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reopenMasterInboxItemsAction(input: { itemIds: string[] }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadMasterOrderEventsAction(input: { orderId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

async function loadOrderEventContext(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  orderId: number,
): Promise<OrderEventContext | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, created_at, attributed_advisor_id, internal_driver_user_id, fulfillment, status, client:clients!orders_client_id_fkey(full_name)')
    .eq('id', orderId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const client = Array.isArray(data.client) ? data.client[0] ?? null : data.client;

  return {
    orderId: Number(data.id),
    orderNumber: data.order_number == null ? null : String(data.order_number),
    createdAt: data.created_at == null ? null : String(data.created_at),
    advisorUserId: data.attributed_advisor_id ?? null,
    internalDriverUserId: data.internal_driver_user_id ?? null,
    fulfillment:
      data.fulfillment === 'pickup' || data.fulfillment === 'delivery' ? data.fulfillment : null,
    status: data.status == null ? null : String(data.status),
    clientName: client?.full_name == null ? null : String(client.full_name),
  };
}

function dedupeEventRecipients(recipients: OrderEventRecipientInput[]) {
  const seen = new Set<string>();
  const out: Array<{
    target_role: NotificationRole | null;
    target_user_id: string | null;
    requires_action: boolean;
  }> = [];

  for (const recipient of recipients) {
    const targetRole = recipient.targetRole ?? null;
    const targetUserId = recipient.targetUserId ?? null;

    if (!targetRole && !targetUserId) continue;

    const key = `${targetRole ?? ''}|${targetUserId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      target_role: targetRole,
      target_user_id: targetUserId,
      requires_action: !!recipient.requiresAction,
    });
  }

  return out;
}

function getAdvisorPushTargets(params: {
  contextAdvisorUserId?: string | null;
  recipients?: OrderEventRecipientInput[];
}) {
  const ids = new Set<string>();

  const contextAdvisorUserId = String(params.contextAdvisorUserId || '').trim();
  if (contextAdvisorUserId) ids.add(contextAdvisorUserId);

  for (const recipient of params.recipients ?? []) {
    const targetUserId = String(recipient.targetUserId || '').trim();
    const targetRole = String(recipient.targetRole || '').trim();

    if (targetUserId) {
      ids.add(targetUserId);
      continue;
    }

    if (targetRole === 'advisor' && contextAdvisorUserId) {
      ids.add(contextAdvisorUserId);
    }
  }

  return Array.from(ids);
}

async function appendOrderEvent(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    orderId: number;
    /** Trusted receipt from a command that already wrote the visible history. */
    persistedEventId?: number;
    eventType: string;
    eventGroup: string;
    title: string;
    message?: string | null;
    severity?: OrderEventSeverity;
    actorUserId?: string | null;
    payload?: Record<string, unknown>;
    context?: OrderEventContext | null;
    recipients?: OrderEventRecipientInput[];
  },
) {
  try {
    const context = input.context ?? (await loadOrderEventContext(supabase, input.orderId));

    const { data: insertedEvent, error: insertEventError } = input.persistedEventId
      ? await supabase.from('order_timeline_events').select('id')
          .eq('id', input.persistedEventId).eq('order_id', input.orderId)
          .eq('event_type', input.eventType).single()
      : await supabase
      .from('order_timeline_events')
      .insert({
        order_id: input.orderId,
        order_number: context?.orderNumber ?? null,
        event_type: input.eventType,
        event_group: input.eventGroup,
        title: input.title,
        message: input.message ?? null,
        severity: input.severity ?? 'info',
        actor_user_id: input.actorUserId ?? null,
        payload: input.payload ?? {},
      })
      .select('id')
      .single();

    if (insertEventError || !insertedEvent) {
      console.warn('appendOrderEvent skipped', insertEventError?.message ?? 'unknown insert error');
      return;
    }

    const recipientRows = dedupeEventRecipients(input.recipients ?? []).map((recipient) => ({
      event_id: insertedEvent.id,
      target_role: recipient.target_role,
      target_user_id: recipient.target_user_id,
      requires_action: recipient.requires_action,
    }));

    if (recipientRows.length === 0) return;

    const { error: recipientsError } = await supabase
      .from('order_timeline_event_recipients')
      .insert(recipientRows);

    if (recipientsError) {
      console.warn('appendOrderEvent recipients skipped', recipientsError.message);
    }

    const advisorPushTargets = getAdvisorPushTargets({
      contextAdvisorUserId: context?.advisorUserId,
      recipients: input.recipients,
    });

    if (advisorPushTargets.length > 0) {
      const advisorPushRequiresAction = (input.recipients ?? []).some((recipient) => {
        const targetsAdvisor =
          recipient.targetRole === 'advisor' ||
          Boolean(recipient.targetUserId && recipient.targetUserId === context?.advisorUserId);

        return targetsAdvisor && Boolean(recipient.requiresAction);
      });
      const advisorPushTag = advisorPushRequiresAction
        ? `advisor-order-${input.orderId}-${input.eventType}`
        : `advisor-order-${input.orderId}-status`;

      for (const advisorUserId of advisorPushTargets) {
        try {
          await sendPushToAdvisorDevices({
            advisorUserId,
            orderId: input.orderId,
            eventType: input.eventType,
            title: input.title,
            body: input.message,
            orderNumber: context?.orderNumber,
            clientName: context?.clientName,
            payload: input.payload,
            tag: advisorPushTag,
          });
        } catch (pushError) {
          console.warn(
            'appendOrderEvent push skipped',
            pushError instanceof Error ? pushError.message : 'unknown push error',
          );
        }
      }
    }

    const rolePushTargets = new Set<string>();
    const kitchenShouldNotify = (input.recipients ?? []).some(
      (recipient) =>
        recipient.targetRole === 'kitchen' && (recipient.requiresAction || recipient.notify),
    );
    const counterRequiresAction = (input.recipients ?? []).some(
      (recipient) => recipient.targetRole === 'counter' && recipient.requiresAction,
    );
    for (const recipient of input.recipients ?? []) {
      if (!recipient.requiresAction) continue;
      if (recipient.targetRole === 'admin') rolePushTargets.add('admin');
      if (recipient.targetRole === 'master') {
        rolePushTargets.add('master');
        rolePushTargets.add('admin');
      }
    }

    if (rolePushTargets.size > 0) {
      try {
        const orderLabel = formatOrderDisplayLabel(input.orderId);
        const clientLabel = context?.clientName ? `${context.clientName}. ` : '';
        await sendPushToRoleDevices({
          roles: Array.from(rolePushTargets),
          title: `${orderLabel}: ${input.title}`,
          body: `${clientLabel}${input.message || 'Requiere revision en el dashboard.'}`,
          url: '/app/master/dashboard',
          tag: `master-order-${input.orderId}-${input.eventType}`,
          tone: input.severity === 'critical' ? 'critical' : input.severity === 'warning' ? 'warning' : 'info',
          requireInteraction: input.severity === 'critical',
        });
      } catch (pushError) {
        console.warn(
          'appendOrderEvent role push skipped',
          pushError instanceof Error ? pushError.message : 'unknown push error',
        );
      }
    }

    if (kitchenShouldNotify) {
      try {
        const orderLabel = formatOrderDisplayLabel(input.orderId);
        const clientLabel = context?.clientName ? `${context.clientName}. ` : '';
        const isNewKitchenOrder = input.eventType === 'order_sent_to_kitchen';
        const isResolvedIncident = input.eventType === 'kitchen_incident_resolved';
        await sendPushToRoleDevices({
          roles: ['kitchen'],
          title: isNewKitchenOrder ? `${orderLabel}: nueva orden en cola` : `${orderLabel}: ${input.title}`,
          body: `${clientLabel}${input.message || 'Hay una orden nueva para tomar en cocina.'}`,
          url: '/app/kitchen',
          tag: `kitchen-order-${input.orderId}-${input.eventType}`,
          tone: isNewKitchenOrder ? 'critical' : isResolvedIncident ? 'success' : 'warning',
          requireInteraction: isNewKitchenOrder || input.eventType === 'order_modified',
        });
      } catch (pushError) {
        console.warn(
          'appendOrderEvent kitchen push skipped',
          pushError instanceof Error ? pushError.message : 'unknown push error',
        );
      }
    }

    if (counterRequiresAction) {
      try {
        const orderLabel = formatOrderDisplayLabel(input.orderId);
        const clientLabel = context?.clientName ? `${context.clientName}. ` : '';
        await sendPushToRoleDevices({
          roles: ['counter'],
          title: `${orderLabel}: pedido listo`,
          body: `${clientLabel}${input.message || 'Hay un pedido listo para mostrador.'}`,
          url: '/app/counter',
          tag: `counter-order-${input.orderId}-${input.eventType}`,
          tone: input.severity === 'critical' ? 'critical' : 'warning',
          requireInteraction: true,
        });
      } catch (pushError) {
        console.warn(
          'appendOrderEvent counter push skipped',
          pushError instanceof Error ? pushError.message : 'unknown push error',
        );
      }
    }
  } catch (error) {
    console.warn(
      'appendOrderEvent failed',
      error instanceof Error ? error.message : 'unknown order event error',
    );
  }
}

function catalogPriceChanged(params: {
  previousCurrency: 'VES' | 'USD';
  previousAmount: number;
  nextCurrency: 'VES' | 'USD';
  nextAmount: number;
}) {
  const tolerance = params.previousCurrency === 'VES' || params.nextCurrency === 'VES' ? 0.01 : 0.005;
  return (
    params.previousCurrency !== params.nextCurrency ||
    Math.abs(Number(params.previousAmount || 0) - Number(params.nextAmount || 0)) > tolerance
  );
}

async function notifyOpenOrdersAffectedByCatalogPriceChange(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    productId: number;
    productName: string;
    previousCurrency: 'VES' | 'USD';
    previousAmount: number;
    nextCurrency: 'VES' | 'USD';
    nextAmount: number;
    actorUserId: string;
  }
) {
  if (!catalogPriceChanged(input)) return;

  const { data: itemRows, error: itemError } = await supabase
    .from('order_items')
    .select('order_id, product_name_snapshot, pricing_origin_currency, pricing_origin_amount')
    .eq('product_id', input.productId);

  if (itemError) {
    console.warn('catalog price impact skipped', itemError.message);
    return;
  }

  const impactedOrderIds = Array.from(
    new Set(
      (itemRows ?? [])
        .filter((item) =>
          catalogPriceChanged({
            previousCurrency: item.pricing_origin_currency === 'VES' ? 'VES' : 'USD',
            previousAmount: toSafeNumber(item.pricing_origin_amount, 0),
            nextCurrency: input.nextCurrency,
            nextAmount: input.nextAmount,
          })
        )
        .map((item) => Number(item.order_id || 0))
        .filter((orderId) => Number.isFinite(orderId) && orderId > 0)
    )
  );

  if (impactedOrderIds.length === 0) return;

  const { data: orderRows, error: ordersError } = await supabase
    .from('orders')
    .select('id, status, total_usd, order_number, attributed_advisor_id, is_price_locked, extra_fields')
    .in('id', impactedOrderIds);

  if (ordersError) {
    console.warn('catalog price impact orders skipped', ordersError.message);
    return;
  }

  const candidateOrders = (orderRows ?? []).filter((order) => {
    if (['cancelled', 'delivered'].includes(String(order.status || ''))) return false;
    const totalUsd = toSafeNumber((order.extra_fields as any)?.pricing?.total_usd, toSafeNumber(order.total_usd, 0));
    return totalUsd > 0.01;
  });

  if (candidateOrders.length === 0) return;

  const candidateOrderIds = candidateOrders.map((order) => Number(order.id));
  const { data: reportRows } = await supabase
    .from('payment_reports')
    .select('order_id, status, reported_amount_usd_equivalent')
    .in('order_id', candidateOrderIds);

  const confirmedPaidByOrder = new Map<number, number>();
  for (const report of reportRows ?? []) {
    if (report.status !== 'confirmed') continue;
    const orderId = Number(report.order_id || 0);
    confirmedPaidByOrder.set(
      orderId,
      (confirmedPaidByOrder.get(orderId) ?? 0) + toSafeNumber(report.reported_amount_usd_equivalent, 0)
    );
  }

  for (const order of candidateOrders) {
    const orderId = Number(order.id);
    const totalUsd = toSafeNumber((order.extra_fields as any)?.pricing?.total_usd, toSafeNumber(order.total_usd, 0));
    const clientFundUsd = toSafeNumber((order.extra_fields as any)?.payment?.client_fund_used_usd, 0);
    const confirmedPaidUsd = (confirmedPaidByOrder.get(orderId) ?? 0) + clientFundUsd;
    if (
      Math.max(0, totalUsd - confirmedPaidUsd) <= 0.01 ||
      isOrderPriceProtected({
        isPriceLocked: Boolean(order.is_price_locked),
        totalUsd,
        confirmedPaidUsd,
      })
    ) {
      continue;
    }

    const context = await loadOrderEventContext(supabase, orderId);
    await appendOrderEvent(supabase, {
      orderId,
      context,
      eventType: 'catalog_price_changed_for_open_quote',
      eventGroup: 'modification',
      title: 'Precio de catálogo actualizado',
      message: `El precio de ${input.productName} cambió y esta orden sigue con saldo pendiente.`,
      severity: 'warning',
      actorUserId: input.actorUserId,
      payload: {
        product_id: input.productId,
        product_name: input.productName,
        previous_currency: input.previousCurrency,
        previous_amount: input.previousAmount,
        next_currency: input.nextCurrency,
        next_amount: input.nextAmount,
      },
      recipients: [
        { targetRole: 'master', requiresAction: true },
        { targetUserId: context?.advisorUserId, requiresAction: true },
      ],
    });
  }
}

export async function notifyCanonicalCatalogPriceChangeAction(input: {
  productId: number;
  productName: string;
  previousCurrency: 'VES' | 'USD';
  previousAmount: number;
  nextCurrency: 'VES' | 'USD';
  nextAmount: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function getChangeSectionsSummary(params: {
  changedFields: string[];
  itemsChanged: boolean;
}): { sections: string[]; summary: string[] } {
  const sectionSet = new Set<string>();
  const summary: string[] = [];

  if (params.itemsChanged) {
    sectionSet.add('pedido');
    summary.push('Se modificó el pedido.');
  }

  for (const field of params.changedFields) {
    if (field === 'client_id') {
      sectionSet.add('cliente');
      summary.push('Se cambió el cliente.');
      continue;
    }
    if (field === 'attributed_advisor_id') {
      sectionSet.add('cliente');
      summary.push('Se cambió el asesor.');
      continue;
    }
    if (field === 'fulfillment') {
      sectionSet.add('entrega');
      summary.push('Se cambió el tipo de entrega.');
      continue;
    }
    if (field === 'delivery_address') {
      sectionSet.add('direccion');
      summary.push('Se cambió la dirección.');
      continue;
    }
    if (field === 'receiver_name' || field === 'receiver_phone') {
      sectionSet.add('entrega');
      summary.push('Se cambiaron datos del receptor.');
      continue;
    }
    if (field === 'notes') {
      sectionSet.add('nota');
      summary.push('Se modificó la nota de la orden.');
      continue;
    }
    if (field === 'source') {
      sectionSet.add('cliente');
      summary.push('Se cambió el origen de la orden.');
      continue;
    }
    if (field === 'total_usd' || field === 'total_bs_snapshot') {
      sectionSet.add('precio');
      summary.push('Se modificó el total de la orden.');
      continue;
    }
    if (field === 'extra_fields') {
      sectionSet.add('entrega');
      summary.push('Se cambiaron datos de entrega, pago o configuración.');
    }
  }

  return {
    sections: Array.from(sectionSet),
    summary: Array.from(new Set(summary)),
  };
}

function toUsdEquivalentByCurrency(
  amount: number,
  currency: string,
  exchangeRateVesPerUsd: number | null
) {
  if (String(currency || '').toUpperCase() === 'VES') {
    const rate = toSafeNumber(exchangeRateVesPerUsd, 0);
    if (rate <= 0) {
      throw new Error('La tasa es obligatoria para montos en VES.');
    }
    return amount / rate;
  }

  return amount;
}

function toNativeAmountFromUsd(
  amountUsd: number,
  currency: string,
  exchangeRateVesPerUsd: number | null
) {
  if (String(currency || '').toUpperCase() === 'VES') {
    const rate = toSafeNumber(exchangeRateVesPerUsd, 0);
    if (rate <= 0) {
      throw new Error('La tasa es obligatoria para montos en VES.');
    }
    return Number((amountUsd * rate).toFixed(2));
  }

  return Number(amountUsd.toFixed(2));
}

async function syncInventoryItemFromCatalogProduct(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    currentName?: string;
    nextName: string;
    isActive: boolean;
    inventoryEnabled: boolean;
    isInventoryItem: boolean;
    inventoryDeductionMode: 'self' | 'composition';
    inventoryKind: 'raw_material' | 'prepared_base' | 'finished_good';
    inventoryUnitName: string;
    packagingName: string | null;
    packagingSize: number | null;
    currentStockUnits: number | null;
    lowStockThreshold: number | null;
    inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'beverages' | 'packaging' | 'other';
  }
) {
  if (!input.inventoryEnabled || !input.isInventoryItem || input.inventoryDeductionMode !== 'self') {
    return null;
  }

  const candidateNames = Array.from(
    new Set([String(input.currentName || '').trim(), String(input.nextName || '').trim()].filter(Boolean))
  );

  const { data: existingItems, error: existingItemsError } = await supabase
    .from('inventory_items')
    .select('id, name, current_stock_units')
    .in('name', candidateNames);

  if (existingItemsError) {
    throw new Error(existingItemsError.message);
  }

  const matchedItem =
    (existingItems ?? []).find((item) => String(item.name || '').trim() === String(input.currentName || '').trim()) ??
    (existingItems ?? []).find((item) => String(item.name || '').trim() === String(input.nextName || '').trim()) ??
    null;

  const payload = {
    name: input.nextName,
    inventory_kind:
      input.inventoryKind === 'finished_good' ? 'finished_stock' : input.inventoryKind,
    unit_name: input.inventoryUnitName.trim() || 'pieza',
    packaging_name: input.packagingName?.trim() ? input.packagingName.trim() : null,
    packaging_size: input.packagingSize == null ? null : Math.max(0, toSafeNumber(input.packagingSize, 0)),
    current_stock_units:
      matchedItem != null
        ? toSafeNumber(matchedItem.current_stock_units, 0)
        : input.currentStockUnits == null
          ? 0
          : Math.max(0, toSafeNumber(input.currentStockUnits, 0)),
    low_stock_threshold:
      input.lowStockThreshold == null ? null : Math.max(0, toSafeNumber(input.lowStockThreshold, 0)),
    inventory_group: input.inventoryGroup,
    is_active: !!input.isActive,
  };

  if (matchedItem) {
    const { error } = await supabase
      .from('inventory_items')
      .update(payload)
      .eq('id', Number(matchedItem.id));

    if (error) throw new Error(error.message);
    return Number(matchedItem.id);
  }

  const { data, error } = await supabase
    .from('inventory_items')
    .insert(payload)
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return Number(data.id);
}

async function applyClientFundToOrder(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    clientId: number;
    orderId: number;
    amountUsd: number;
    userId: string;
    notes?: string | null;
  }
) {
  const amountUsd = Number(input.amountUsd || 0);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;

  const { data: currentClient, error: currentClientError } = await supabase
    .from('clients')
    .select('id, fund_balance_usd')
    .eq('id', input.clientId)
    .single();

  if (currentClientError || !currentClient) {
    throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
  }

  const currentBalance = Number(toSafeNumber(currentClient.fund_balance_usd, 0).toFixed(2));
  const nextAmountUsd = Number(amountUsd.toFixed(2));

  if (nextAmountUsd > currentBalance + 0.0001) {
    throw new Error('El cliente no tiene suficiente fondo disponible.');
  }

  const { error: updateClientError } = await supabase
    .from('clients')
    .update({
      fund_balance_usd: Number((currentBalance - nextAmountUsd).toFixed(2)),
    })
    .eq('id', input.clientId);

  if (updateClientError) {
    throw new Error(updateClientError.message);
  }

  const { error: fundMovementError } = await supabase
    .from('client_fund_movements')
    .insert({
      client_id: input.clientId,
      movement_type: 'debit',
      currency_code: 'USD',
      amount: nextAmountUsd,
      amount_usd: nextAmountUsd,
      money_account_id: null,
      order_id: input.orderId,
      payment_report_id: null,
      reason_code: 'order_fund_applied',
      notes: String(input.notes || '').trim() || null,
      created_by_user_id: input.userId,
    });

  if (fundMovementError) {
    throw new Error(fundMovementError.message);
  }
}

async function restoreClientFundToOrder(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    clientId: number;
    orderId: number;
    amountUsd: number;
    userId: string;
    notes?: string | null;
  }
) {
  const amountUsd = Number(input.amountUsd || 0);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;

  const { data: currentClient, error: currentClientError } = await supabase
    .from('clients')
    .select('id, fund_balance_usd')
    .eq('id', input.clientId)
    .single();

  if (currentClientError || !currentClient) {
    throw new Error(currentClientError?.message || 'No se pudo restaurar el fondo del cliente.');
  }

  const currentBalance = Number(toSafeNumber(currentClient.fund_balance_usd, 0).toFixed(2));
  const nextAmountUsd = Number(amountUsd.toFixed(2));

  const { error: updateClientError } = await supabase
    .from('clients')
    .update({
      fund_balance_usd: Number((currentBalance + nextAmountUsd).toFixed(2)),
    })
    .eq('id', input.clientId);

  if (updateClientError) {
    throw new Error(updateClientError.message);
  }

  const { error: fundMovementError } = await supabase
    .from('client_fund_movements')
    .insert({
      client_id: input.clientId,
      movement_type: 'credit',
      currency_code: 'USD',
      amount: nextAmountUsd,
      amount_usd: nextAmountUsd,
      money_account_id: null,
      order_id: input.orderId,
      payment_report_id: null,
      reason_code: 'order_fund_restore',
      notes: String(input.notes || '').trim() || null,
      created_by_user_id: input.userId,
    });

  if (fundMovementError) {
    throw new Error(fundMovementError.message);
  }
}

export async function createPaymentReportAction(input: {
  orderId: number;
  reportedMoneyAccountId: number;
  reportedCurrency: string;
  reportedAmount: number;
  reportedExchangeRateVesPerUsd: number | null;
  paymentMethod?: string | null;
  operationDate?: string | null;
  referenceCode: string | null;
  bankName?: string | null;
  payerName: string | null;
  notes: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function confirmPaymentReportAction(input: PaymentConfirmationInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function applyStaffPayrollPaymentAction(input: {
  orderId: number;
  moneyAccountId: number;
  amountUsd?: number | string | null;
  operationDate?: string | null;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function applyClientFundPaymentAction(input: {
  orderId: number;
  amountUsd: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function deliverClientFundChangeAction(input: {
  requestId: string;
  expectedDifferenceUsd?: number;
  orderId: number;
  moneyAccountId: number;
  currencyCode: string;
  amount: number;
  exchangeRateVesPerUsd?: number | null;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function settleClientFundPayoutAction(input: {
  requestId: string;
  expectedDifferenceUsd?: number;
  orderId: number;
  lines: Array<{
    moneyAccountId: number;
    currencyCode: string;
    amount: number;
    exchangeRateVesPerUsd?: number | null;
    notes?: string | null;
  }>;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function rejectPaymentReportAction(input: {
  reportId: number;
  reviewNotes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function approveOrderAction(input: {
  orderId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reapproveQueuedOrderAction(input: {
  orderId: number;
  notes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

async function kitchenDispatchAction(input: { orderId: number }, checkOnly: boolean): Promise<import('@/lib/orders/kitchen-dispatch').KitchenDispatchResult> {
  const { executeKitchenDispatch } = await import('@/lib/orders/kitchen-dispatch');
  try {
    const { supabase, user } = await requireMasterOrAdmin();
    if (!Number.isSafeInteger(input.orderId) || input.orderId <= 0) {
      return { ok: false, needsCheck: false, message: 'Orden inválida.' };
    }
    const result = await executeKitchenDispatch({
      send: checkOnly ? undefined : async () => {
        const { error } = await supabase.rpc('send_to_kitchen', { p_order_id: input.orderId });
        return { error: error?.message ?? null };
      },
      read: async () => {
        const { data, error } = await supabase.from('orders')
          .select('id,status,queued_needs_reapproval,sent_to_kitchen_at,kitchen_started_at,ready_at')
          .eq('id', input.orderId).single();
        if (error || !data) throw new Error(error?.message || 'No se pudo leer la orden.');
        return {
          id: Number(data.id), status: data.status,
          queuedNeedsReapproval: Boolean(data.queued_needs_reapproval),
          sentToKitchenAtISO: data.sent_to_kitchen_at,
          kitchenStartedAtISO: data.kitchen_started_at,
          readyAtISO: data.ready_at,
        };
      },
      onCommitted: async () => {
        const eventContext = await loadOrderEventContext(supabase, input.orderId);
        await appendOrderEvent(supabase, {
          orderId: input.orderId,
          eventType: 'order_sent_to_kitchen', eventGroup: 'kitchen',
          title: 'Enviada a cocina', message: 'Nueva orden en cola para tomar en cocina.',
          severity: 'critical', actorUserId: user.id,
          context: eventContext,
          recipients: [
            { targetRole: 'kitchen', requiresAction: true }, { targetRole: 'master' },
            { targetUserId: eventContext?.advisorUserId },
          ],
        });
      },
    });
    if (!result.ok) console.warn('kitchen_dispatch_confirmation', {
      orderId: input.orderId, checkOnly, needsCheck: result.needsCheck, status: result.order?.status,
    });
    return result;
  } catch (error) {
    return { ok: false, needsCheck: true, message: error instanceof Error ? error.message : 'No se pudo confirmar el envío a cocina.' };
  }
}

export async function readKitchenDispatchAction(input: { orderId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function sendToKitchenAction(input: {
  orderId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function returnToCreatedAction(input: {
  orderId: number;
  reason: string;
  recalculatePricing?: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function previewOrderCancellationAction(orderId: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function cancelOrderAction(input: OrderCancellationInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function assignInternalDriverAction(input: {
  orderId: number;
  driverUserId: string;
  costUsd?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function assignExternalPartnerAction(input: {
  orderId: number;
  partnerId: number;
  reference: string | null;
  distanceKm?: number | null;
  costUsd?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function correctDeliveredDeliveryAssignmentAction(input: {
  orderId: number;
  assignmentKind: 'internal' | 'external';
  driverUserId?: string | null;
  partnerId?: number | null;
  reference?: string | null;
  distanceKm?: number | null;
  costUsd?: number | null;
  notes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reviewOrderChangesAction(input: {
  orderId: number;
  approved: boolean;
  notes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function kitchenTakeAction(input: {
  orderId: number;
  etaMinutes: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateKitchenEtaAction(input: {
  orderId: number;
  etaMinutes: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function protectOrderPriceAction(input: { orderId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reportKitchenIncidentAction(input: {
  orderId: number;
  reason: string;
  note?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function markReadyAction(input: {
  orderId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function outForDeliveryAction(input: {
  orderId: number;
  etaMinutes?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function markDeliveredAction(input: {
  orderId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function clearDeliveryAssignmentAction(input: {
  orderId: number;
  notes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function returnFromKitchenToQueueAction(input: {
  orderId: number;
  reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateCatalogItemAction(input: {
  productId: number;
  type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
  sourcePriceAmount: number;
  sourcePriceCurrency: 'VES' | 'USD';
  isActive: boolean;
  unitsPerService: number;
  isDetailEditable: boolean;
  detailUnitsLimit: number;
  isInventoryItem: boolean;
  isTemporary: boolean;
  isComboComponentSelectable: boolean;
  commissionMode: 'default' | 'fixed_item' | 'fixed_order';
  commissionValue: number | null;
  commissionNotes: string | null;
  advisorGiftCostUsd: number | null;
  internalRiderPayUsd: number | null;
  inventoryEnabled: boolean;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_good';
  inventoryDeductionMode: 'self' | 'composition';
  inventoryUnitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number | null;
  lowStockThreshold: number | null;
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'beverages' | 'packaging' | 'other';
  inventoryLinks?: Array<{
    inventoryItemId: number;
    quantityUnits: number;
    notes: string | null;
    sortOrder: number;
  }>;
  components: Array<{
    componentProductId: number;
    componentMode: 'fixed' | 'selectable';
    quantity: number;
    countsTowardDetailLimit: boolean;
    isRequired: boolean;
    sortOrder: number;
    notes: string | null;
  }>;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }


export async function updateCatalogPricesQuickAction(input: {
  items: Array<{
    productId: number;
    sourcePriceAmount: number;
  }>;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }





export async function loadMoneyActivityAction(input?: {
  movementLimit?: number;
  closureLimit?: number;
  reconciliationLimit?: number;
  movementDateFrom?: string;
  movementDateTo?: string;
  moneyAccountId?: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadInventoryMovementsAction(input?: {
  movementLimit?: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createExtraMoneyMovementAction(input: {
  direction: 'inflow' | 'outflow';
  outflowPurpose?: 'change' | 'expense' | null;
  moneyAccountId: number;
  amount: number;
  feeAmount?: number | null;
  movementDate: string;
  exchangeRateVesPerUsd: number | null;
  referenceCode: string;
  counterpartyName: string;
  description: string;
  notes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createInventoryItemAction(input: {
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'beverages' | 'packaging' | 'other';
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  isActive: boolean;
  notes: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateInventoryItemAction(input: {
  inventoryItemId: number;
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'beverages' | 'packaging' | 'other';
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  isActive: boolean;
  notes: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function toggleInventoryItemActiveAction(input: {
  inventoryItemId: number;
  nextIsActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveInventoryRecipeAction(input: {
  inventoryItemId: number;
  recipeId: number | null;
  recipeKind: 'production' | 'packaging';
  outputQuantityUnits: number;
  notes: string | null;
  components: Array<{
    inputInventoryItemId: number;
    quantityUnits: number;
    sortOrder: number;
  }>;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }








export async function createOrderAdminAdjustmentAction(input: {
  orderId: number;
  kind: 'advisor_change' | 'client_change' | 'schedule_change';
  reason: string;
  notes?: string | null;
  nextAdvisorUserId?: string | null;
  nextClientId?: number | null;
  nextDeliveryDate?: string | null;
  nextDeliveryHour12?: string | null;
  nextDeliveryMinute?: string | null;
  nextDeliveryAmPm?: 'AM' | 'PM' | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function closeOrderRoundingBalanceAction(input: {
  orderId: number;
  requestId: string;
  expectedDifferenceUsd: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function normalizeTagList(input: string[]) {
  return Array.from(
    new Set(
      (input ?? [])
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
    )
  );
}

function normalizeRecentAddressesForClient(input: unknown) {
  if (!Array.isArray(input)) return [] as Array<{ address_text: string; gps_url: string | null }>;

  return input
    .map((row) => {
      const data =
        row && typeof row === 'object' ? (row as Record<string, unknown>) : {};

      return {
        address_text: String(data.address_text ?? data.addressText ?? '').trim(),
        gps_url: String(data.gps_url ?? data.gpsUrl ?? '').trim() || null,
      };
    })
    .filter((row) => row.address_text || row.gps_url);
}

function mergeRecentAddresses(
  currentValue: unknown,
  nextAddressText: string,
  nextGpsUrl: string
) {
  const current = normalizeRecentAddressesForClient(currentValue);
  const normalizedAddressText = String(nextAddressText || '').trim();
  const normalizedGpsUrl = String(nextGpsUrl || '').trim() || null;

  if (!normalizedAddressText && !normalizedGpsUrl) {
    return current.slice(0, 2);
  }

  const nextEntry = {
    address_text: normalizedAddressText,
    gps_url: normalizedGpsUrl,
  };

  const deduped = current.filter(
    (row) =>
      !(
        row.address_text === nextEntry.address_text &&
        (row.gps_url ?? null) === (nextEntry.gps_url ?? null)
      )
  );

  return [nextEntry, ...deduped].slice(0, 2);
}

function normalizeRecentAddresses(
  input: Array<{ addressText: string; gpsUrl: string }>
) {
  return (input ?? [])
    .map((row) => ({
      address_text: String(row?.addressText || '').trim(),
      gps_url: String(row?.gpsUrl || '').trim(),
    }))
    .filter((row) => row.address_text || row.gps_url)
    .slice(0, 2);
}

async function assertDeliveryItemForOrder(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  items: Array<{ productId: number; productNameSnapshot?: string | null }>
) {
  const productIds = Array.from(
    new Set(
      (items ?? [])
        .map((item) => Number(item.productId))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  if (productIds.length === 0) {
    throw new Error('Debes agregar un ítem de delivery.');
  }

  const { data, error } = await supabase
    .from('products')
    .select('id, name, internal_rider_pay_usd')
    .in('id', productIds);

  if (error) throw new Error(error.message);

  const hasDeliveryItem = (data ?? []).some((product) => {
    const name = String(product.name || '').trim().toLowerCase();
    return Number(product.internal_rider_pay_usd || 0) > 0 || name.includes('delivery');
  });

  if (!hasDeliveryItem) {
    throw new Error('Una orden delivery debe incluir un producto de delivery.');
  }
}

async function replaceProductInventoryLinks(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    productId: number;
    inventoryDeductionMode: 'self' | 'composition';
    selfInventoryItemId?: number | null;
    inventoryLinks: Array<{
      inventoryItemId: number;
      quantityUnits: number;
      notes: string | null;
      sortOrder: number;
    }>;
  }
) {
  const { error: deleteError } = await supabase
    .from('product_inventory_links')
    .delete()
    .eq('product_id', input.productId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (input.inventoryDeductionMode === 'self') {
    const selfInventoryItemId = toSafeNumber(input.selfInventoryItemId, 0);
    if (selfInventoryItemId <= 0) {
      return;
    }

    const { error: insertSelfLinkError } = await supabase
      .from('product_inventory_links')
      .insert({
        product_id: input.productId,
        inventory_item_id: selfInventoryItemId,
        deduction_mode: 'self_link',
        quantity_units: 1,
        sort_order: 1,
        notes: null,
        is_active: true,
      });

    if (insertSelfLinkError) {
      throw new Error(insertSelfLinkError.message);
    }

    return;
  }

  const normalized = (input.inventoryLinks ?? [])
    .map((row, index) => ({
      inventoryItemId: toSafeNumber(row.inventoryItemId, 0),
      quantityUnits: Math.max(0, toSafeNumber(row.quantityUnits, 0)),
      notes: row.notes?.trim() ? row.notes.trim() : null,
      sortOrder: toSafeNumber(row.sortOrder, index + 1) || index + 1,
    }))
    .filter((row) => row.inventoryItemId > 0 && row.quantityUnits > 0);

  if (normalized.length === 0) {
    return;
  }

  const { data: existingItems, error: existingItemsError } = await supabase
    .from('inventory_items')
    .select('id')
    .in('id', normalized.map((row) => row.inventoryItemId));

  if (existingItemsError) {
    throw new Error(existingItemsError.message);
  }

  const foundIds = new Set((existingItems ?? []).map((row) => Number(row.id)));
  const missing = normalized.filter((row) => !foundIds.has(row.inventoryItemId));
  if (missing.length > 0) {
    throw new Error('Hay items internos inválidos en el descuento de inventario.');
  }

  const { error: insertError } = await supabase
    .from('product_inventory_links')
    .insert(
      normalized.map((row) => ({
        product_id: input.productId,
        inventory_item_id: row.inventoryItemId,
        deduction_mode: 'recipe',
        quantity_units: row.quantityUnits,
        sort_order: row.sortOrder,
        notes: row.notes,
        is_active: true,
      }))
    );

  if (insertError) {
    throw new Error(insertError.message);
  }
}

async function applyDeliveredOrderInventoryDeductions(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  userId: string,
  orderId: number
) {
  const { data: existingSaleMovements, error: existingSaleMovementsError } = await supabase
    .from('inventory_movements')
    .select('id')
    .eq('order_id', orderId)
    .eq('movement_type', 'sale_out')
    .limit(1);

  if (existingSaleMovementsError) {
    throw new Error(existingSaleMovementsError.message);
  }

  if ((existingSaleMovements ?? []).length > 0) {
    return;
  }

  const cutoverMode = await loadInventoryCutoverMode(supabase);
  if (cutoverMode !== 'legacy') {
    return;
  }

  const { data: orderRow, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number')
    .eq('id', orderId)
    .single();

  if (orderError || !orderRow) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden entregada.');
  }

  const { data: orderItems, error: orderItemsError } = await supabase
    .from('order_items')
    .select('id, product_id, qty, product_name_snapshot, notes')
    .eq('order_id', orderId);

  if (orderItemsError) {
    throw new Error(orderItemsError.message);
  }

  const productIds = Array.from(
    new Set((orderItems ?? []).map((row) => toSafeNumber(row.product_id, 0)).filter((id) => id > 0))
  );

  if (productIds.length === 0) {
    return;
  }

  const { data: productComponents, error: productComponentsError } = await supabase
    .from('product_components')
    .select('parent_product_id, component_product_id, component_mode, quantity, is_required')
    .in('parent_product_id', productIds);

  if (productComponentsError) {
    throw new Error(productComponentsError.message);
  }

  const componentProductIds = Array.from(
    new Set(
      (productComponents ?? [])
        .map((row) => Number(row.component_product_id))
        .filter((id) => id > 0)
    )
  );

  const lookupProductIds = Array.from(new Set([...productIds, ...componentProductIds]));

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, name, inventory_enabled, inventory_deduction_mode')
    .in('id', lookupProductIds);

  if (productsError) {
    throw new Error(productsError.message);
  }

  const { data: links, error: linksError } = await supabase
    .from('product_inventory_links')
    .select('product_id, inventory_item_id, quantity_units, is_active')
    .in('product_id', lookupProductIds);

  if (linksError) {
    throw new Error(linksError.message);
  }

  const productById = new Map(
    (products ?? []).map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        name: String(row.name || '').trim(),
        inventoryEnabled: !!row.inventory_enabled,
        deductionMode: row.inventory_deduction_mode === 'composition' ? ('composition' as const) : ('self' as const),
      },
    ])
  );

  const componentsByParentProductId = new Map<
    number,
    Array<{
      componentProductId: number;
      componentMode: 'fixed' | 'selectable';
      quantity: number;
      isRequired: boolean;
    }>
  >();

  for (const row of productComponents ?? []) {
    const parentProductId = Number(row.parent_product_id);
    const componentProductId = Number(row.component_product_id);
    if (parentProductId <= 0 || componentProductId <= 0) continue;

    const list = componentsByParentProductId.get(parentProductId) ?? [];
    list.push({
      componentProductId,
      componentMode: row.component_mode === 'selectable' ? 'selectable' : 'fixed',
      quantity: Math.max(0, toSafeNumber(row.quantity, 0)),
      isRequired: !!row.is_required,
    });
    componentsByParentProductId.set(parentProductId, list);
  }

  const linksByProductId = new Map<number, Array<{ inventoryItemId: number; quantityUnits: number }>>();
  for (const row of links ?? []) {
    if (!row.is_active) continue;
    const productId = Number(row.product_id);
    const list = linksByProductId.get(productId) ?? [];
    list.push({
      inventoryItemId: Number(row.inventory_item_id),
      quantityUnits: Math.max(0, toSafeNumber(row.quantity_units, 0)),
    });
    linksByProductId.set(productId, list);
  }

  const allLinkedInventoryIds = Array.from(
    new Set((links ?? []).filter((row) => row.is_active).map((row) => Number(row.inventory_item_id)).filter((id) => id > 0))
  );

  const inventoryItemsById = new Map<number, { id: number; currentStockUnits: number }>();
  if (allLinkedInventoryIds.length > 0) {
    const { data: linkedInventoryItems, error: linkedInventoryItemsError } = await supabase
      .from('inventory_items')
      .select('id, current_stock_units')
      .in('id', allLinkedInventoryIds);

    if (linkedInventoryItemsError) {
      throw new Error(linkedInventoryItemsError.message);
    }

    for (const row of linkedInventoryItems ?? []) {
      inventoryItemsById.set(Number(row.id), {
        id: Number(row.id),
        currentStockUnits: toSafeNumber(row.current_stock_units, 0),
      });
    }
  }

  const fallbackInventoryNames = Array.from(
    new Set(
      Array.from(productById.values())
        .map((product) => String(product.name || '').trim())
        .filter(Boolean)
    )
  );

  const inventoryItemsByName = new Map<string, { id: number; currentStockUnits: number }>();
  if (fallbackInventoryNames.length > 0) {
    const { data: fallbackInventoryItems, error: fallbackInventoryItemsError } = await supabase
      .from('inventory_items')
      .select('id, name, current_stock_units')
      .in('name', fallbackInventoryNames);

    if (fallbackInventoryItemsError) {
      throw new Error(fallbackInventoryItemsError.message);
    }

    for (const row of fallbackInventoryItems ?? []) {
      const normalizedName = String((row as { name?: string | null }).name || '').trim().toLowerCase();
      if (!normalizedName) continue;

      const inventoryRow = {
        id: Number(row.id),
        currentStockUnits: toSafeNumber(row.current_stock_units, 0),
      };

      inventoryItemsByName.set(normalizedName, inventoryRow);
      inventoryItemsById.set(inventoryRow.id, inventoryRow);
    }
  }

  const aggregatedDeductions = new Map<number, number>();
  const notesByInventoryItemId = new Map<number, string[]>();

  const parseOrderItemSelections = (notes: string | null | undefined) => {
    const selectedComponentQtyById = new Map<number, number>();
    const selectedComponentQtyByName = new Map<string, number>();

    for (const rawLine of String(notes || '').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('@sel|')) {
        const [, componentProductIdRaw, qtyRaw] = line.split('|');
        const componentProductId = Number(componentProductIdRaw || 0);
        const qty = Math.max(0, toSafeNumber(qtyRaw, 0));
        if (componentProductId > 0 && qty > 0) {
          selectedComponentQtyById.set(componentProductId, qty);
        }
        continue;
      }

      if (/^para\s*:/i.test(line)) continue;

      const match = line.match(/^(\d+)\s+(.+)$/i);
      if (!match) continue;

      const qty = Math.max(0, toSafeNumber(match[1], 0));
      const componentName = String(match[2] || '').trim().toLowerCase();
      if (!componentName || qty <= 0) continue;
      selectedComponentQtyByName.set(componentName, qty);
    }

    return { selectedComponentQtyById, selectedComponentQtyByName };
  };

  const addInventoryDeduction = (inventoryItemId: number, quantityUnits: number, noteLabel: string) => {
    if (inventoryItemId <= 0 || quantityUnits <= 0) return;

    aggregatedDeductions.set(
      inventoryItemId,
      (aggregatedDeductions.get(inventoryItemId) ?? 0) + quantityUnits
    );

    const notes = notesByInventoryItemId.get(inventoryItemId) ?? [];
    notes.push(noteLabel);
    notesByInventoryItemId.set(inventoryItemId, notes);
  };

  const applyProductDeductions = (
    productId: number,
    qty: number,
    noteLabel: string,
    selectableSelections?: ReturnType<typeof parseOrderItemSelections>,
    stack: number[] = []
  ) => {
    if (productId <= 0 || qty <= 0) return;
    if (stack.includes(productId)) return;

    const product = productById.get(productId);
    if (!product?.inventoryEnabled) return;

    const nextStack = [...stack, productId];
    const productComponentsRows = componentsByParentProductId.get(productId) ?? [];

    if (product.deductionMode === 'composition' && productComponentsRows.length > 0) {
      let appliedFromComponents = false;

      for (const componentRow of productComponentsRows) {
        if (componentRow.componentMode === 'fixed' && componentRow.isRequired) {
          const childQty = qty * Math.max(0, componentRow.quantity);
          if (childQty > 0) {
            appliedFromComponents = true;
            applyProductDeductions(componentRow.componentProductId, childQty, noteLabel, undefined, nextStack);
          }
          continue;
        }

        let selectedQty = selectableSelections?.selectedComponentQtyById.get(componentRow.componentProductId) ?? 0;
        if (selectedQty <= 0) {
          const componentName = productById.get(componentRow.componentProductId)?.name?.trim().toLowerCase() || '';
          if (componentName) {
            selectedQty = selectableSelections?.selectedComponentQtyByName.get(componentName) ?? 0;
          }
        }

        if (selectedQty > 0) {
          appliedFromComponents = true;
          applyProductDeductions(componentRow.componentProductId, qty * selectedQty, noteLabel, undefined, nextStack);
        }
      }

      if (appliedFromComponents) {
        return;
      }
    }

    const productLinks = linksByProductId.get(productId) ?? [];
    if (product.deductionMode === 'composition') {
      for (const link of productLinks) {
        if (link.inventoryItemId <= 0 || link.quantityUnits <= 0) continue;
        addInventoryDeduction(link.inventoryItemId, qty * link.quantityUnits, noteLabel);
      }
      if (productLinks.length > 0) {
        return;
      }
    }

    const selfInventoryLink = productLinks.find((link) => link.inventoryItemId > 0) ?? null;
    if (selfInventoryLink) {
      addInventoryDeduction(selfInventoryLink.inventoryItemId, qty, noteLabel);
      return;
    }

    const fallbackInventoryItem = inventoryItemsByName.get(product.name.trim().toLowerCase()) ?? null;
    if (fallbackInventoryItem) {
      addInventoryDeduction(fallbackInventoryItem.id, qty, noteLabel);
    }
  };

  for (const row of orderItems ?? []) {
    const productId = toSafeNumber(row.product_id, 0);
    const qty = Math.max(0, toSafeNumber(row.qty, 0));
    if (productId <= 0 || qty <= 0) continue;

    const product = productById.get(productId);
    if (!product?.inventoryEnabled) continue;
    applyProductDeductions(
      productId,
      qty,
      `${row.product_name_snapshot || product.name} x${qty}`,
      parseOrderItemSelections((row as { notes?: string | null }).notes ?? null)
    );
  }

  if (aggregatedDeductions.size === 0) {
    return;
  }

  for (const [inventoryItemId, quantityUnits] of aggregatedDeductions.entries()) {
    const inventoryItem = inventoryItemsById.get(inventoryItemId);

    if (!inventoryItem) {
      throw new Error(`No se encontró el item interno ${inventoryItemId} para descontar inventario.`);
    }

    const nextStock = inventoryItem.currentStockUnits - quantityUnits;
    const noteLines = notesByInventoryItemId.get(inventoryItemId) ?? [];
    const notes = [formatOrderDisplayLabel(orderId), ...noteLines].join(' · ');

    const { error: movementError } = await supabase
      .from('inventory_movements')
      .insert({
        inventory_item_id: inventoryItemId,
        movement_type: 'sale_out',
        quantity_units: quantityUnits,
        reason_code: 'order_delivery',
        notes,
        order_id: orderId,
        created_by_user_id: userId,
      });

    if (movementError) {
      throw new Error(movementError.message);
    }

    const { error: stockError } = await supabase
      .from('inventory_items')
      .update({ current_stock_units: nextStock })
      .eq('id', inventoryItemId);

    if (stockError) {
      throw new Error(stockError.message);
    }

    inventoryItemsById.set(inventoryItemId, { id: inventoryItemId, currentStockUnits: nextStock });
  }
}

async function loadInventoryCutoverMode(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>
): Promise<'legacy' | 'opening' | 'canonical'> {
  const { data, error } = await supabase.rpc('inventory_cutover_mode_v1');
  if (error) {
    throw new Error(`No se pudo verificar el modo de inventario: ${error.message}`);
  }

  if (data !== 'legacy' && data !== 'opening' && data !== 'canonical') {
    throw new Error('Supabase devolvió un modo de inventario inválido.');
  }

  return data;
}

async function resetDeliveredOrderInventoryDeductions(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  orderId: number
) {
  const { data: existingSaleMovements, error: existingSaleMovementsError } = await supabase
    .from('inventory_movements')
    .select('id, inventory_item_id, quantity_units')
    .eq('order_id', orderId)
    .eq('movement_type', 'sale_out');

  if (existingSaleMovementsError) {
    throw new Error(existingSaleMovementsError.message);
  }

  if ((existingSaleMovements ?? []).length === 0) {
    return;
  }

  const restoreByItemId = new Map<number, number>();
  for (const movement of existingSaleMovements ?? []) {
    const inventoryItemId = Number(movement.inventory_item_id);
    const quantityUnits = Math.max(0, toSafeNumber(movement.quantity_units, 0));
    if (inventoryItemId <= 0 || quantityUnits <= 0) continue;

    restoreByItemId.set(
      inventoryItemId,
      (restoreByItemId.get(inventoryItemId) ?? 0) + quantityUnits
    );
  }

  const inventoryItemIds = Array.from(restoreByItemId.keys());
  if (inventoryItemIds.length > 0) {
    const { data: inventoryItems, error: inventoryItemsError } = await supabase
      .from('inventory_items')
      .select('id, current_stock_units')
      .in('id', inventoryItemIds);

    if (inventoryItemsError) {
      throw new Error(inventoryItemsError.message);
    }

    const inventoryById = new Map(
      (inventoryItems ?? []).map((row) => [
        Number(row.id),
        toSafeNumber(row.current_stock_units, 0),
      ])
    );

    for (const inventoryItemId of inventoryItemIds) {
      const currentStockUnits = inventoryById.get(inventoryItemId);
      if (currentStockUnits == null) {
        throw new Error(`No se encontró el item interno ${inventoryItemId} para restaurar inventario.`);
      }

      const restoreQty = restoreByItemId.get(inventoryItemId) ?? 0;
      const { error: restoreError } = await supabase
        .from('inventory_items')
        .update({ current_stock_units: currentStockUnits + restoreQty })
        .eq('id', inventoryItemId);

      if (restoreError) {
        throw new Error(restoreError.message);
      }
    }
  }

  const movementIds = (existingSaleMovements ?? [])
    .map((movement) => Number(movement.id))
    .filter((id) => id > 0);

  if (movementIds.length > 0) {
    const { error: deleteMovementsError } = await supabase
      .from('inventory_movements')
      .delete()
      .in('id', movementIds);

    if (deleteMovementsError) {
      throw new Error(deleteMovementsError.message);
    }
  }
}


export async function searchClientsAction(input: {
  query: string;
  limit?: number;
  includeRecentWhenEmpty?: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadMasterClientCommercialProfileAction(input: {
  clientId: number;
  purchaseWindow?: number;
  recentLimit?: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function getOrderOperationalDate(order: { created_at?: unknown; extra_fields?: unknown }) {
  const extraFields =
    order.extra_fields && typeof order.extra_fields === 'object' && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as Record<string, unknown>)
      : {};
  const schedule =
    extraFields.schedule && typeof extraFields.schedule === 'object' && !Array.isArray(extraFields.schedule)
      ? (extraFields.schedule as Record<string, unknown>)
      : {};
  const scheduledDate = normalizeDateOnly(schedule.date);

  if (scheduledDate) return scheduledDate;

  return dateOnlyFromIso(order.created_at) ?? getCaracasDateString(new Date());
}

export async function searchMasterOrdersAction(input: { query: string; limit?: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function searchMasterDirectoryAction(input: { query: string; limit?: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadClientStatsAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function getClientFundSnapshotAction(input: { clientId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createOrderClientQuickAction(input: {
  fullName: string;
  phone: string;
  clientType: 'assigned' | 'own' | 'legacy';
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }



async function createCatalogItemActionImpl(input: {
  sku: string;
  name: string;
  type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
  sourcePriceAmount: number;
  sourcePriceCurrency: 'VES' | 'USD';
  unitsPerService: number;
  isActive: boolean;
  isDetailEditable: boolean;
  detailUnitsLimit: number;
  isInventoryItem: boolean;
  isTemporary: boolean;
  isComboComponentSelectable: boolean;
  commissionMode: 'default' | 'fixed_item' | 'fixed_order';
  commissionValue: number | null;
  commissionNotes: string | null;
  advisorGiftCostUsd: number | null;
  internalRiderPayUsd: number | null;
  inventoryEnabled: boolean;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_good';
  inventoryDeductionMode: 'self' | 'composition';
  inventoryUnitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number | null;
  lowStockThreshold: number | null;
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'beverages' | 'packaging' | 'other';
  inventoryLinks?: Array<{
    inventoryItemId: number;
    quantityUnits: number;
    notes: string | null;
    sortOrder: number;
  }>;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const sku = String(input.sku || '').trim().toUpperCase();
  const name = String(input.name || '').trim();
  const sourcePriceAmount = Number(input.sourcePriceAmount || 0);
  const unitsPerService = Number(input.unitsPerService || 0);
  const detailUnitsLimit = Number(input.detailUnitsLimit || 0);
  const internalRiderPayUsd =
    input.internalRiderPayUsd == null ? null : Math.max(0, Number(input.internalRiderPayUsd || 0));
  const advisorGiftCostUsd =
    input.advisorGiftCostUsd == null ? 0 : Math.max(0, Number(input.advisorGiftCostUsd || 0));
  const packagingSize =
    input.packagingSize == null ? null : Math.max(0, Number(input.packagingSize || 0));
  const currentStockUnits =
    input.currentStockUnits == null ? null : Math.max(0, Number(input.currentStockUnits || 0));
  const lowStockThreshold =
    input.lowStockThreshold == null ? null : Math.max(0, Number(input.lowStockThreshold || 0));

  if (!sku) throw new Error('El SKU es obligatorio.');
  if (!name) throw new Error('El nombre es obligatorio.');
  if (!['product', 'combo', 'service', 'promo', 'gambit'].includes(input.type)) {
    throw new Error('Tipo inválido.');
  }
  if (!['VES', 'USD'].includes(input.sourcePriceCurrency)) {
    throw new Error('Moneda inválida.');
  }
  if (!['raw_material', 'prepared_base', 'finished_good'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }
  if (!['raw', 'fried', 'prefried', 'sauces', 'beverages', 'packaging', 'other'].includes(input.inventoryGroup)) {
    throw new Error('Grupo de inventario inválido.');
  }
  if (!['self', 'composition'].includes(input.inventoryDeductionMode)) {
    throw new Error('Modo de descuento de inventario inválido.');
  }
  const normalizedInventoryLinks = (input.inventoryLinks ?? [])
    .map((row, index) => ({
      inventoryItemId: toSafeNumber(row.inventoryItemId, 0),
      quantityUnits: Math.max(0, toSafeNumber(row.quantityUnits, 0)),
      notes: row.notes?.trim() ? row.notes.trim() : null,
      sortOrder: toSafeNumber(row.sortOrder, index + 1) || index + 1,
    }))
    .filter((row) => row.inventoryItemId > 0 && row.quantityUnits > 0);
  const hasConfiguredComponents = input.isDetailEditable;
  if (!Number.isFinite(sourcePriceAmount) || sourcePriceAmount < 0) {
    throw new Error('El monto fuente es inválido.');
  }
  if (!Number.isFinite(unitsPerService) || unitsPerService < 0) {
    throw new Error('Und/servicio inválido.');
  }
  if (!Number.isFinite(detailUnitsLimit) || detailUnitsLimit < 0) {
    throw new Error('Límite de detalle inválido.');
  }
  if (
    input.inventoryEnabled &&
    input.inventoryDeductionMode === 'composition' &&
    normalizedInventoryLinks.length === 0 &&
    !hasConfiguredComponents
  ) {
    throw new Error('Define al menos un item interno para el descuento por composición.');
  }

  const { data: existingSku, error: existingSkuError } = await supabase
    .from('products')
    .select('id')
    .eq('sku', sku)
    .maybeSingle();

  if (existingSkuError) throw new Error(existingSkuError.message);
  if (existingSku) throw new Error('Ya existe un producto con ese SKU.');

  const { data: activeRate, error: activeRateError } = await supabase
    .from('exchange_rates')
    .select('rate_bs_per_usd')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeRateError) throw new Error(activeRateError.message);

  const rate = Number(activeRate?.rate_bs_per_usd || 0);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('No hay una tasa activa válida.');
  }

  let basePriceUsd = 0;
  let basePriceBs = 0;

  if (input.sourcePriceCurrency === 'USD') {
    basePriceUsd = sourcePriceAmount;
    basePriceBs = sourcePriceAmount * rate;
  } else {
    basePriceBs = sourcePriceAmount;
    basePriceUsd = sourcePriceAmount / rate;
  }

  const { data, error } = await supabase
    .from('products')
    .insert({
      sku,
      name,
      type: input.type,
      source_price_amount: sourcePriceAmount,
      source_price_currency: input.sourcePriceCurrency,
      base_price_usd: basePriceUsd,
      base_price_bs: basePriceBs,
      units_per_service: unitsPerService,
      is_active: input.isActive,
      is_detail_editable: input.isDetailEditable,
      detail_units_limit: detailUnitsLimit,
      is_inventory_item: input.isInventoryItem,
      is_temporary: input.isTemporary,
      is_combo_component_selectable: input.isComboComponentSelectable,
      commission_mode: input.commissionMode,
      commission_value: input.commissionMode === 'default' ? null : input.commissionValue,
      commission_notes: input.commissionNotes,
      extra_fields: {
        advisor_gift_cost_usd: advisorGiftCostUsd,
      },
      internal_rider_pay_usd: internalRiderPayUsd,
      inventory_enabled: input.inventoryEnabled,
      inventory_kind: input.inventoryKind,
      inventory_deduction_mode: input.inventoryDeductionMode,
      inventory_unit_name: String(input.inventoryUnitName || 'pieza').trim() || 'pieza',
      packaging_name: input.packagingName?.trim() ? input.packagingName.trim() : null,
      packaging_size: packagingSize,
      current_stock_units: currentStockUnits ?? 0,
      low_stock_threshold: lowStockThreshold,
      inventory_group: input.inventoryGroup,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);

  const selfInventoryItemId = await syncInventoryItemFromCatalogProduct(supabase, {
    nextName: name,
    isActive: input.isActive,
    inventoryEnabled: input.inventoryEnabled,
    isInventoryItem: input.isInventoryItem,
    inventoryDeductionMode: input.inventoryDeductionMode,
    inventoryKind: input.inventoryKind,
    inventoryUnitName: input.inventoryUnitName,
    packagingName: input.packagingName,
    packagingSize,
    currentStockUnits,
    lowStockThreshold,
    inventoryGroup: input.inventoryGroup,
  });

  await replaceProductInventoryLinks(supabase, {
    productId: Number(data.id),
    inventoryDeductionMode: input.inventoryDeductionMode,
    selfInventoryItemId,
    inventoryLinks: normalizedInventoryLinks,
  });

  revalidatePath('/app/master/dashboard');
  return { id: Number(data.id) };
}

export async function createCatalogItemAction(
  input: Parameters<typeof createCatalogItemActionImpl>[0]
): Promise<{ ok: true; id: number } | { ok: false; error: string }> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function duplicateCatalogItemAction(input: {
  sourceProductId: number;
  sku?: string | null;
  name: string;
}): Promise<{ ok: true; id: number; sku: string } | { ok: false; error: string }> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function toggleCatalogItemActiveAction(input: {
  productId: number;
  nextIsActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createMoneyTransferAction(input: {
  requestId: string;
  sourceMoneyAccountId: number;
  targetMoneyAccountId: number;
  sourceAmount: number;
  targetAmount: number;
  feeAmount?: number | null;
  movementDate: string;
  sourceExchangeRateVesPerUsd: number | null;
  targetExchangeRateVesPerUsd: number | null;
  referenceCode: string;
  counterpartyName: string;
  description: string;
  notes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function approveMoneyMovementGroupAction(input: {
  movementId: number;
  movementGroupId: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function rejectMoneyMovementGroupAction(input: {
  movementId: number;
  movementGroupId: string | null;
  reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function voidMoneyMovementGroupAction(input: {
  movementId: number;
  movementGroupId: string | null;
  reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function voidFinancialMovementAction(input: {
  movementId: number;
  movementGroupId: string | null;
  reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createMoneyAccountClosureAction(input: {
  requestId: string;
  moneyAccountId: number;
  closureDate: string;
  closureTime?: string | null;
  countedAmount: number;
  exchangeRateVesPerUsd: number | null;
  targetMoneyAccountId?: number | null;
  reason: string;
  notes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function previewMoneyAccountClosureAction(input: {
  moneyAccountId: number;
  closureDate: string;
  closureTime?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function rejectMoneyAccountClosureAction(input: {
  closureId: number;
  reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }


export async function resolveMoneyAccountReconciliationItemAction(input: {
  itemId: number;
  resolutionNotes: string;
  resolutionMode?: 'note_only' | 'expense' | 'income' | 'fee' | 'adjustment';
  movementAmount?: number | null;
  exchangeRateVesPerUsd?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createInventoryMovementAction(input: {
  inventoryItemId: number;
  movementType:
    | 'inbound'
    | 'damage'
    | 'waste'
    | 'manual_adjustment'
    | 'stock_count';
  quantityUnits: number;
  reasonCode: string | null;
  notes: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createInventoryProductionAction(input: {
  recipeId: number;
  batchMultiplier: number;
  notes: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function deleteCatalogItemAction(input: {
  productId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function buildOrderItemOverrideAuditPayload(item: {
  productNameSnapshot: string;
  unitPriceUsdSnapshot: number;
  adminPriceOverrideUsd: number | null;
  adminPriceOverrideCurrency?: 'USD' | 'VES' | null;
  adminPriceOverrideReason?: string | null;
  sourcePriceCurrency?: 'USD' | 'VES';
  sourcePriceAmount?: number;
  qty: number;
  lineTotalUsd: number;
}) {
  const originalUnitPriceUsd = Number(item.unitPriceUsdSnapshot || 0);
  const overrideUnitPriceUsd = Number(item.adminPriceOverrideUsd || 0);
  const qty = Number(item.qty || 0);
  const originalLineTotalUsd = originalUnitPriceUsd * qty;
  const overrideLineTotalUsd = Number(item.lineTotalUsd || 0);

  return {
    kind: 'item_price_override',
    product_name: item.productNameSnapshot,
    qty,
    original_unit_price_usd: originalUnitPriceUsd,
    override_unit_price_usd: overrideUnitPriceUsd,
    override_source_currency: item.adminPriceOverrideCurrency ?? null,
    override_source_amount:
      item.adminPriceOverrideCurrency && item.sourcePriceAmount != null
        ? Number(item.sourcePriceAmount || 0)
        : null,
    original_line_total_usd: originalLineTotalUsd,
    override_line_total_usd: overrideLineTotalUsd,
    delta_usd: overrideLineTotalUsd - originalLineTotalUsd,
  };
}

function buildOrderItemOverrideAuditSignature(item: {
  productNameSnapshot: string;
  unitPriceUsdSnapshot: number;
  adminPriceOverrideUsd: number | null;
  adminPriceOverrideCurrency?: 'USD' | 'VES' | null;
  adminPriceOverrideReason?: string | null;
  sourcePriceCurrency?: 'USD' | 'VES';
  sourcePriceAmount?: number;
  qty: number;
  lineTotalUsd: number;
}) {
  const payload = buildOrderItemOverrideAuditPayload(item);
  return JSON.stringify({
    product_name: payload.product_name,
    qty: payload.qty,
    original_unit_price_usd: payload.original_unit_price_usd,
    override_unit_price_usd: payload.override_unit_price_usd,
    override_source_currency: payload.override_source_currency,
    override_source_amount: payload.override_source_amount,
    override_line_total_usd: payload.override_line_total_usd,
    reason: String(item.adminPriceOverrideReason || '').trim(),
  });
}

function pad4(n: number) {
  return String(n).padStart(4, '0');
}

function todayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  return `${y}${m}${d}`;
}

function from12hTo24h(hour12: string, minute: string, ampm: 'AM' | 'PM') {
  let h = Number(hour12);
  let m = Number(minute);

  if (!Number.isFinite(h) || h < 1 || h > 12) {
    throw new Error('Hora inválida (1–12).');
  }

  if (!Number.isFinite(m) || m < 0 || m > 59) {
    throw new Error('Minutos inválidos (0–59).');
  }

  if (ampm === 'AM') {
    if (h === 12) h = 0;
  } else {
    if (h !== 12) h = h + 12;
  }

  return `${pad2(h)}:${pad2(m)}`;
}

async function generateUniqueOrderNumber(supabase: Awaited<ReturnType<typeof createSupabaseServer>>) {
  for (let i = 0; i < 20; i++) {
    const orderNumber = `VO-${todayKey()}-${pad4(Math.floor(Math.random() * 10000))}`;

    const { data, error } = await supabase
      .from('orders')
      .select('id')
      .eq('order_number', orderNumber)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      return orderNumber;
    }
  }

  throw new Error('No se pudo generar un número de orden único.');
}

export async function createOrderAction(input: {
  source: 'advisor' | 'master' | 'walk_in';
  attributedAdvisorUserId: string | null;
  fulfillment: 'pickup' | 'delivery';

  selectedClientId: number | null;
  newClientName: string;
  newClientPhone: string;
  newClientType: 'assigned' | 'own' | 'legacy';

  deliveryDate: string;
  deliveryHour12: string;
  deliveryMinute: string;
  deliveryAmPm: 'AM' | 'PM';
  isAsap: boolean;
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  note: string;

  discountEnabled: boolean;
  discountPct: string;
  invoiceTaxPct: string;
  fxRate: string;

  paymentMethod: string;
  paymentCurrency: 'USD' | 'VES';
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: 'USD' | 'VES';
  paymentNote: string;
  useClientFund: boolean;
  clientFundAmountUsd: string;
  hasDeliveryNote: boolean;
  hasInvoice: boolean;
  invoiceDataNote: string;
  invoiceCompanyName: string;
  invoiceTaxId: string;
  invoiceAddress: string;
  invoicePhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  preserveClientCommercialProfile?: boolean;

  items: Array<{
    productId: number;
    skuSnapshot: string | null;
    productNameSnapshot: string;
    qty: number;
    sourcePriceCurrency: 'VES' | 'USD';
    sourcePriceAmount: number;
    unitPriceUsdSnapshot: number;
    lineTotalUsd: number;
    adminPriceOverrideUsd: number | null;
    adminPriceOverrideCurrency?: 'USD' | 'VES' | null;
    adminPriceOverrideReason: string | null;
    orderItemId?: number | null;
    crmPlayMemberId?: number | null;
    crmPlayBenefitId?: number | null;
    crmPlayBenefitUpgradeId?: number | null;
    rewardGrantId?: number | null;
    rewardPurpose?: 'customer_gift' | 'personal_purchase' | null;
    rewardAmountUsd?: number | null;
    commissionInheritedMode?: OrderCommissionMode;
    commissionInheritedValue?: number | null;
    commissionInheritedSource?: 'catalog' | 'event';
    adminCommissionOverrideMode?: OrderCommissionMode | null;
    adminCommissionOverrideValue?: number | null;
    adminCommissionOverrideReason?: string | null;
    adminCommissionOverrideChanged?: boolean;
    editableDetailLines: string[];
  }>;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

type OrderCommissionAdjustmentInput = {
  orderItemId?: number | null;
  productId: number;
  productNameSnapshot: string;
  commissionInheritedMode?: OrderCommissionMode;
  commissionInheritedValue?: number | null;
  commissionInheritedSource?: 'catalog' | 'event';
  adminCommissionOverrideMode?: OrderCommissionMode | null;
  adminCommissionOverrideValue?: number | null;
  adminCommissionOverrideReason?: string | null;
  adminCommissionOverrideChanged?: boolean;
};

function validateOrderCommissionAdjustmentItems(
  items: OrderCommissionAdjustmentInput[],
  isAdmin: boolean
) {
  const hasAdministrativeCommissionInput = items.some(
    (item) => item.adminCommissionOverrideMode != null || item.adminCommissionOverrideChanged
  );
  if (hasAdministrativeCommissionInput && !isAdmin) {
    throw new Error('Solo admin puede ajustar comisiones manualmente.');
  }

  for (const item of items) {
    if (item.adminCommissionOverrideMode != null) {
      validateOrderCommissionTerms(
        item.adminCommissionOverrideMode,
        item.adminCommissionOverrideValue
      );
    }

    if (
      (item.adminCommissionOverrideMode != null || item.adminCommissionOverrideChanged) &&
      !String(item.adminCommissionOverrideReason || '').trim()
    ) {
      throw new Error('Debes indicar el motivo del ajuste de comisión.');
    }
  }

  const fixedOrderValues = new Set(
    items
      .map((item) => {
        const terms = item.adminCommissionOverrideMode != null
          ? validateOrderCommissionTerms(
              item.adminCommissionOverrideMode,
              item.adminCommissionOverrideValue
            )
          : normalizeOrderCommissionTerms(
              item.commissionInheritedMode,
              item.commissionInheritedValue
            );
        return terms.mode === 'fixed_order' ? terms.value : null;
      })
      .filter((value): value is number => value != null)
  );
  if (fixedOrderValues.size > 1) {
    throw new Error(
      'La orden tiene más de un porcentaje fijo para toda la orden. Debes dejar un único porcentaje.'
    );
  }
}

function getOrderCommissionOverrideTerms(
  item: OrderCommissionAdjustmentInput
): OrderCommissionTerms | null {
  if (item.adminCommissionOverrideMode == null) return null;
  return validateOrderCommissionTerms(
    item.adminCommissionOverrideMode,
    item.adminCommissionOverrideValue
  );
}

function buildOrderCommissionAdjustmentPayload(
  item: OrderCommissionAdjustmentInput,
  action: 'set' | 'clear'
) {
  const inheritedTerms = normalizeOrderCommissionTerms(
    item.commissionInheritedMode,
    item.commissionInheritedValue
  );
  const overrideTerms = action === 'set' ? getOrderCommissionOverrideTerms(item) : null;

  return {
    kind: ORDER_COMMISSION_TERMS_KIND,
    schema_version: 1,
    action,
    source: 'admin_order_editor',
    product_id: Number(item.productId),
    product_name: String(item.productNameSnapshot || '').trim() || 'Producto',
    inherited_source: item.commissionInheritedSource ?? 'catalog',
    inherited_mode: inheritedTerms.mode,
    inherited_value: inheritedTerms.value,
    commission_mode: overrideTerms?.mode ?? null,
    commission_value: overrideTerms?.value ?? null,
  };
}

export async function updateDeliveredOrderPaymentIntentAction(input: {
  orderId: number;
  expectedLastModifiedAt?: string | null;
  paymentMethod: string;
  paymentCurrency: 'USD' | 'VES';
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: 'USD' | 'VES';
  paymentNote: string;
  reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateOrderAction(input: {
  orderId: number;
  expectedLastModifiedAt?: string | null;

  source: 'advisor' | 'master' | 'walk_in';
  attributedAdvisorUserId: string | null;
  fulfillment: 'pickup' | 'delivery';

  selectedClientId: number | null;
  newClientName: string;
  newClientPhone: string;
  newClientType: 'assigned' | 'own' | 'legacy';

  deliveryDate: string;
  deliveryHour12: string;
  deliveryMinute: string;
  deliveryAmPm: 'AM' | 'PM';
  isAsap: boolean;
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  note: string;

  discountEnabled: boolean;
  discountPct: string;
  invoiceTaxPct: string;
  fxRate: string;

  paymentMethod: string;
  paymentCurrency: 'USD' | 'VES';
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: 'USD' | 'VES';
  paymentNote: string;
  useClientFund: boolean;
  clientFundAmountUsd: string;
  hasDeliveryNote: boolean;
  hasInvoice: boolean;
  invoiceDataNote: string;
  invoiceCompanyName: string;
  invoiceTaxId: string;
  invoiceAddress: string;
  invoicePhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;

  items: Array<{
    productId: number;
    skuSnapshot: string | null;
    productNameSnapshot: string;
    qty: number;
    sourcePriceCurrency: 'VES' | 'USD';
    sourcePriceAmount: number;
    unitPriceUsdSnapshot: number;
    lineTotalUsd: number;
    adminPriceOverrideUsd: number | null;
    adminPriceOverrideCurrency?: 'USD' | 'VES' | null;
    adminPriceOverrideReason: string | null;
    orderItemId?: number | null;
    crmPlayMemberId?: number | null;
    crmPlayBenefitId?: number | null;
    crmPlayBenefitUpgradeId?: number | null;
    rewardGrantId?: number | null;
    rewardPurpose?: 'customer_gift' | 'personal_purchase' | null;
    rewardAmountUsd?: number | null;
    commissionInheritedMode?: OrderCommissionMode;
    commissionInheritedValue?: number | null;
    commissionInheritedSource?: 'catalog' | 'event';
    adminCommissionOverrideMode?: OrderCommissionMode | null;
    adminCommissionOverrideValue?: number | null;
    adminCommissionOverrideReason?: string | null;
    adminCommissionOverrideChanged?: boolean;
    editableDetailLines: string[];
  }>;
  adminEditReason?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

type AdvisorCommissionOrderItemRow = {
  id: number | string;
  product_id: number | string | null;
  qty: number | string | null;
  unit_price_usd_snapshot: number | string | null;
  line_total_usd: number | string | null;
  admin_price_override_usd: number | string | null;
  product_name_snapshot: string | null;
  sku_snapshot: string | null;
  notes: string | null;
  product:
    | {
        id: number | string;
        name: string | null;
        type: string | null;
        commission_mode: string | null;
        commission_value: number | string | null;
        extra_fields: any;
      }
    | {
        id: number | string;
        name: string | null;
        type: string | null;
        commission_mode: string | null;
        commission_value: number | string | null;
        extra_fields: any;
      }[]
    | null;
};

type AdvisorCommissionOrderRow = {
  id: number | string;
  order_number: string | null;
  client_id: number | string | null;
  attributed_advisor_id: string | null;
  source: string | null;
  status: string | null;
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  created_at: string | null;
  extra_fields: any;
  client:
    | {
        id: number | string | null;
        full_name: string | null;
        phone: string | null;
        created_at: string | null;
        client_type: string | null;
      }
    | {
        id: number | string | null;
        full_name: string | null;
        phone: string | null;
        created_at: string | null;
        client_type: string | null;
      }[]
    | null;
  items: AdvisorCommissionOrderItemRow[] | null;
};

type AdvisorCommissionFirstOrderRow = {
  id: number | string;
  order_number: string | null;
  client_id: number | string | null;
  attributed_advisor_id: string | null;
  source: string | null;
  status: string | null;
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  created_at: string | null;
  extra_fields: any;
};

type AdvisorCommissionFinancialStateRow = {
  order_id: number | string;
  total_usd: number | string | null;
  confirmed_paid_usd: number | string | null;
  pending_usd: number | string | null;
  overpaid_usd: number | string | null;
  payment_status: string | null;
  delivery_reference_date: string | null;
};

type AdvisorCommissionPaymentLedgerEntry = {
  orderId: number;
  operationDate: string;
  amountUsd: number;
};

type AdvisorCommissionManualDeductionSnapshot = {
  id: number;
  kind: string;
  description: string;
  amountUsd: number;
  notes: string | null;
  createdAt: string | null;
};

type AdvisorCommissionItemTerms = {
  mode: 'default' | 'fixed_item' | 'fixed_order' | 'none';
  value: number | null;
};

type AdvisorCommissionGiftOverride = {
  quantity: number;
  advisorChargeUsd: number;
  companyCostUsd: number;
  playName: string | null;
};

const ADVISOR_COMMISSION_CLIENT_IMPORT_CUTOFF = '2026-06-02';

function getAdvisorCommissionClient(order: AdvisorCommissionOrderRow) {
  return Array.isArray(order.client) ? order.client[0] ?? null : order.client ?? null;
}

function getAdvisorCommissionProduct(item: AdvisorCommissionOrderItemRow) {
  return Array.isArray(item.product) ? item.product[0] ?? null : item.product ?? null;
}

function getAdvisorCommissionItemTerms(
  item: AdvisorCommissionOrderItemRow,
  overrides: Map<number, AdvisorCommissionItemTerms>,
  referenceDate?: string | null
): AdvisorCommissionItemTerms {
  const override = overrides.get(Number(item.id));
  if (override) return override;

  const product = getAdvisorCommissionProduct(item);
  return resolveProductCommissionTerms({
    currentMode: product?.commission_mode,
    currentValue: product?.commission_value,
    extraFields: product?.extra_fields,
    referenceDate,
  });
}

function getAdvisorGiftCostUsd(product: ReturnType<typeof getAdvisorCommissionProduct>) {
  const extraFields =
    product?.extra_fields && typeof product.extra_fields === 'object' && !Array.isArray(product.extra_fields)
      ? (product.extra_fields as Record<string, unknown>)
      : {};

  return roundMoney(
    Math.max(
      0,
      toSafeNumber(
        extraFields.advisor_gift_cost_usd ??
          extraFields.advisorGiftCostUsd ??
          extraFields.gift_cost_usd ??
          extraFields.advisor_cost_usd,
        0
      )
    )
  );
}

function getAdvisorCommissionDeliveryDate(
  order: Pick<AdvisorCommissionOrderRow, 'extra_fields' | 'created_at'>
) {
  const stateDate = getOrderDeliveryReferenceDate(order);
  if (stateDate) return stateDate;

  const extraFields =
    order.extra_fields && typeof order.extra_fields === 'object' && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as Record<string, any>)
      : {};

  const scheduledDate = normalizeDateOnly(extraFields.schedule?.date);
  if (scheduledDate) return scheduledDate;

  return dateOnlyFromIso(order.created_at);
}

function getAdvisorCommissionDiscountFactor(order: AdvisorCommissionOrderRow, items: AdvisorCommissionOrderItemRow[]) {
  const rawItemsTotal = items.reduce((sum, item) => sum + getOrderLineTotalUsd(item), 0);
  if (rawItemsTotal <= 0.005) return 1;

  const commercialNetUsd = getOrderCommercialNetUsd(order);
  if (commercialNetUsd <= 0.005) return 1;

  return Math.max(0, Math.min(1, commercialNetUsd / rawItemsTotal));
}

function buildAdvisorCommissionPaymentCompletionDates(params: {
  orders: AdvisorCommissionOrderRow[];
  financialStates: Map<number, AdvisorCommissionFinancialStateRow>;
  ledgerEntries: AdvisorCommissionPaymentLedgerEntry[];
}) {
  const entriesByOrderId = new Map<number, AdvisorCommissionPaymentLedgerEntry[]>();

  for (const entry of params.ledgerEntries) {
    const entries = entriesByOrderId.get(entry.orderId) ?? [];
    entries.push(entry);
    entriesByOrderId.set(entry.orderId, entries);
  }

  const completionDates = new Map<number, string>();

  for (const order of params.orders) {
    const orderId = Number(order.id);
    const financialState = params.financialStates.get(orderId);
    const totalUsd = roundMoney(financialState?.total_usd ?? getOrderMoneySnapshot(order).totalUsd);
    const confirmedPaidUsd = Math.max(0, roundMoney(financialState?.confirmed_paid_usd ?? 0));
    const targetUsd = Math.min(totalUsd, confirmedPaidUsd);

    if (targetUsd <= 0.005) continue;

    const entries = [...(entriesByOrderId.get(orderId) ?? [])].sort(
      (a, b) => a.operationDate.localeCompare(b.operationDate)
    );
    let accumulatedUsd = 0;
    let completionDate: string | null = null;

    for (const entry of entries) {
      const wasComplete = accumulatedUsd >= targetUsd - 0.005;
      accumulatedUsd = Math.max(0, roundMoney(accumulatedUsd + entry.amountUsd));
      const isComplete = accumulatedUsd >= targetUsd - 0.005;

      if (!wasComplete && isComplete) completionDate = entry.operationDate;
      if (wasComplete && !isComplete) completionDate = null;
    }

    if (completionDate) completionDates.set(orderId, completionDate);
  }

  return completionDates;
}

function buildAdvisorCommissionSnapshots(params: {
  orders: AdvisorCommissionOrderRow[];
  financialStates: Map<number, AdvisorCommissionFinancialStateRow>;
  paymentCompletionDates: Map<number, string>;
  firstPurchaseOrdersByClientId: Map<number, AdvisorCommissionFirstOrderRow>;
  advisorIds: string[];
  advisorNamesById: Map<string, string>;
  period: { id: number; name: string; date_from: string; date_to: string };
  defaultBaseCommissionPct: number;
  baseCommissionPctByAdvisor: Map<string, number>;
  commissionTermsByOrderItemId: Map<number, AdvisorCommissionItemTerms>;
  giftOverridesByOrderItemId: Map<number, AdvisorCommissionGiftOverride>;
}) {
  const {
    orders,
    financialStates,
    paymentCompletionDates,
    firstPurchaseOrdersByClientId,
    advisorIds,
    advisorNamesById,
    period,
    defaultBaseCommissionPct,
    baseCommissionPctByAdvisor,
    commissionTermsByOrderItemId,
    giftOverridesByOrderItemId,
  } = params;

  const closuresByAdvisor = new Map<string, {
    advisorUserId: string;
    advisorName: string;
    baseCommissionPct: number;
    orders: Array<Record<string, unknown>>;
    paidOrders: Array<Record<string, unknown>>;
    pendingOrders: Array<Record<string, unknown>>;
    newClients: Array<Record<string, unknown>>;
    products: Array<Record<string, unknown>>;
    gifts: Array<Record<string, unknown>>;
    totals: {
      deliveredOrdersCount: number;
      billedUsd: number;
      regularBaseUsd: number;
      specialItemBaseUsd: number;
      specialOrderBaseUsd: number;
      grossCommissionUsd: number;
      pendingCollectionUsd: number;
      punctualPaidCount: number;
      latePaidCount: number;
      pendingPaymentCount: number;
      newOwnClientsCount: number;
      newAssignedClientsCount: number;
      giftDeductionsUsd: number;
      manualDeductionsUsd: number;
      payableUsd: number;
    };
  }>();

  for (const advisorId of advisorIds) {
    closuresByAdvisor.set(advisorId, {
      advisorUserId: advisorId,
      advisorName: advisorNamesById.get(advisorId) || 'Asesor',
      baseCommissionPct: baseCommissionPctByAdvisor.get(advisorId) ?? defaultBaseCommissionPct,
      orders: [],
      paidOrders: [],
      pendingOrders: [],
      newClients: [],
      products: [],
      gifts: [],
      totals: {
        deliveredOrdersCount: 0,
        billedUsd: 0,
        regularBaseUsd: 0,
        specialItemBaseUsd: 0,
        specialOrderBaseUsd: 0,
        grossCommissionUsd: 0,
        pendingCollectionUsd: 0,
        punctualPaidCount: 0,
        latePaidCount: 0,
        pendingPaymentCount: 0,
        newOwnClientsCount: 0,
        newAssignedClientsCount: 0,
        giftDeductionsUsd: 0,
        manualDeductionsUsd: 0,
        payableUsd: 0,
      },
    });
  }

  for (const order of orders) {
    const advisorId = String(order.attributed_advisor_id || '');
    const closure = closuresByAdvisor.get(advisorId);
    if (!closure) continue;

    const orderId = Number(order.id);
    const items = Array.isArray(order.items) ? order.items : [];
    const financialState = financialStates.get(orderId);
    const moneySnapshot = getOrderMoneySnapshot(order);
    const totalUsd = roundMoney(financialState?.total_usd ?? moneySnapshot.totalUsd);
    const isCommercialOrder = isAdvisorCommercialOrder(totalUsd);
    const pendingUsd = getEffectiveOrderPendingUsd({
      order,
      financialState,
      fallbackPendingUsd: Math.max(0, totalUsd),
    });
    const confirmedPaidUsd = roundMoney(financialState?.confirmed_paid_usd ?? 0);
    const deliveryDate = financialState?.delivery_reference_date || getAdvisorCommissionDeliveryDate(order);
    const discountFactor = isCommercialOrder
      ? getAdvisorCommissionDiscountFactor(order, items)
      : 0;
    const commissionableSubtotalUsd = getOrderCommercialNetUsd(order);

    let regularBaseUsd = 0;
    let specialItemBaseUsd = 0;
    let specialItemCommissionUsd = 0;
    let fixedOrderBaseUsd = 0;
    let fixedOrderPct: number | null = null;
    const fixedOrderTerms = items
      .map((item) =>
        getAdvisorCommissionItemTerms(item, commissionTermsByOrderItemId, deliveryDate)
      )
      .find((terms) => terms.mode === 'fixed_order');

    if (fixedOrderTerms) {
      fixedOrderBaseUsd = commissionableSubtotalUsd;
      fixedOrderPct = Math.max(0, toSafeNumber(fixedOrderTerms.value, 0));
    } else {
      for (const item of items) {
        const product = getAdvisorCommissionProduct(item);
        const commissionTerms = getAdvisorCommissionItemTerms(
          item,
          commissionTermsByOrderItemId,
          deliveryDate
        );
        const lineBaseUsd = Math.max(0, getOrderLineTotalUsd(item) * discountFactor);
        if (commissionTerms.mode === 'fixed_item') {
          const pct = Math.max(0, toSafeNumber(commissionTerms.value, 0));
          specialItemBaseUsd += lineBaseUsd;
          specialItemCommissionUsd += lineBaseUsd * (pct / 100);
        } else if (commissionTerms.mode !== 'none') {
          regularBaseUsd += lineBaseUsd;
        }

        const productType = String(product?.type || '').toLowerCase();
        const productName = item.product_name_snapshot || product?.name || 'Producto';
        const giftOverride = giftOverridesByOrderItemId.get(Number(item.id));
        if (giftOverride || productType === 'gambit' || productName.toLowerCase().includes('obsequio')) {
          const qty = toSafeNumber(item.qty, 0);
          const deductionUsd = giftOverride
            ? roundMoney(giftOverride.advisorChargeUsd)
            : roundMoney(getAdvisorGiftCostUsd(product) * qty);
          const unitDeductionUsd = giftOverride && giftOverride.quantity > 0
            ? roundMoney(deductionUsd / giftOverride.quantity)
            : getAdvisorGiftCostUsd(product);
          closure.totals.giftDeductionsUsd += deductionUsd;
          closure.gifts.push({
            orderId,
            orderNumber: order.order_number,
            productId: product?.id ?? item.product_id,
            productName,
            qty,
            clientName: getAdvisorCommissionClient(order)?.full_name || 'Cliente',
            unitDeductionUsd,
            deductionUsd,
            crmPlayName: giftOverride?.playName ?? null,
            companyCostUsd: giftOverride?.companyCostUsd ?? null,
          });
        }

        closure.products.push({
          orderId,
          orderNumber: order.order_number,
          clientName: getAdvisorCommissionClient(order)?.full_name || 'Cliente',
          productName,
          productType,
          qty: toSafeNumber(item.qty, 0),
          lineBaseUsd: roundMoney(lineBaseUsd),
          commissionMode: commissionTerms.mode,
          commissionValue: commissionTerms.value,
        });
      }

      if (items.length === 0) {
        regularBaseUsd = commissionableSubtotalUsd;
      }
    }

    const regularCommissionUsd = regularBaseUsd * (closure.baseCommissionPct / 100);
    const fixedOrderCommissionUsd =
      fixedOrderPct == null ? 0 : fixedOrderBaseUsd * (fixedOrderPct / 100);
    const orderCommissionUsd = roundMoney(regularCommissionUsd + specialItemCommissionUsd + fixedOrderCommissionUsd);
    const roundingClosure = getOrderRoundingClosureSnapshot(order);
    const paymentStatus = roundingClosure.isClosed
      ? 'closed_by_rounding'
      : String(financialState?.payment_status || '').toLowerCase();
    const isPending = pendingUsd > 0.005;
    const paymentCompletedDate = isPending
      ? null
      : paymentCompletionDates.get(orderId) || deliveryDate || null;
    const paymentTiming = isPending
      ? 'pending'
      : paymentCompletedDate && deliveryDate && paymentCompletedDate > deliveryDate
        ? 'late'
        : 'punctual';

    const client = getAdvisorCommissionClient(order);
    if (isCommercialOrder) {
      const clientCreatedDate = dateOnlyFromIso(client?.created_at);
      const clientType = String(client?.client_type || '').toLowerCase();
      const countedClientType = countedAdvisorNewClientType(clientType);
      const isLegacyImport = Boolean(clientCreatedDate && clientCreatedDate < ADVISOR_COMMISSION_CLIENT_IMPORT_CUTOFF);
      const clientIdNumber = Number(client?.id ?? 0);
      const firstPurchaseOrder = Number.isFinite(clientIdNumber) && clientIdNumber > 0
        ? firstPurchaseOrdersByClientId.get(clientIdNumber) ?? null
        : null;
      const firstOrderId = Number(firstPurchaseOrder?.id ?? 0);
      const isFirstPurchaseForThisAdvisor =
        !isLegacyImport &&
        firstOrderId === orderId &&
        String(firstPurchaseOrder?.source || '') === 'advisor' &&
        String(firstPurchaseOrder?.attributed_advisor_id || '') === advisorId;

      if (isFirstPurchaseForThisAdvisor) {
        const alreadyAdded = closure.newClients.some((row) => String(row.clientId ?? '') === String(client?.id ?? ''));
        if (!alreadyAdded) {
          if (countedClientType === 'own') closure.totals.newOwnClientsCount += 1;
          if (countedClientType === 'assigned') closure.totals.newAssignedClientsCount += 1;
          closure.newClients.push({
            clientId: client?.id,
            clientName: client?.full_name || 'Cliente',
            clientType,
            orderId,
            orderNumber: order.order_number,
            createdAt: client?.created_at,
          });
        }
      }
    }

    const orderSnapshot = {
      orderId,
      orderNumber: order.order_number,
      clientId: client?.id ?? null,
      clientName: client?.full_name || 'Cliente',
      deliveryDate,
      billedUsd: roundMoney(commissionableSubtotalUsd),
      totalUsd,
      confirmedPaidUsd,
      pendingUsd,
      roundingClosedUsd: roundingClosure.shortfallClosedUsd,
      roundingGainClosedUsd: roundingClosure.gainClosedUsd,
      regularBaseUsd: roundMoney(regularBaseUsd),
      specialItemBaseUsd: roundMoney(specialItemBaseUsd),
      specialOrderBaseUsd: roundMoney(fixedOrderBaseUsd),
      commissionUsd: orderCommissionUsd,
      commissionMode: fixedOrderPct == null ? (specialItemBaseUsd > 0 ? 'mixed_items' : 'default') : 'fixed_order',
      paymentStatus,
      paymentCompletedDate,
      paymentTiming,
    };

    if (isCommercialOrder) {
      closure.totals.deliveredOrdersCount += 1;
      closure.totals.billedUsd += commissionableSubtotalUsd;
      closure.totals.regularBaseUsd += regularBaseUsd;
      closure.totals.specialItemBaseUsd += specialItemBaseUsd;
      closure.totals.specialOrderBaseUsd += fixedOrderBaseUsd;
      closure.totals.grossCommissionUsd += orderCommissionUsd;
      closure.totals.pendingCollectionUsd += isPending ? pendingUsd : 0;
      closure.totals.pendingPaymentCount += isPending ? 1 : 0;
      closure.totals.punctualPaidCount += paymentTiming === 'punctual' ? 1 : 0;
      closure.totals.latePaidCount += paymentTiming === 'late' ? 1 : 0;
      closure.orders.push(orderSnapshot);
      if (isPending) {
        closure.pendingOrders.push(orderSnapshot);
      } else {
        closure.paidOrders.push(orderSnapshot);
      }
    }
  }

  return Array.from(closuresByAdvisor.values()).map((closure) => {
    const totals = closure.totals;
    const byDateThenOrder = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      const dateA = String(a.deliveryDate ?? a.createdAt ?? '');
      const dateB = String(b.deliveryDate ?? b.createdAt ?? '');
      const dateCompare = dateA.localeCompare(dateB);
      if (dateCompare !== 0) return dateCompare;
      return Number(a.orderId || 0) - Number(b.orderId || 0);
    };
    const byProductThenOrder = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      const productCompare = String(a.productName || '').localeCompare(String(b.productName || ''));
      if (productCompare !== 0) return productCompare;
      return Number(a.orderId || 0) - Number(b.orderId || 0);
    };

    closure.orders.sort(byDateThenOrder);
    closure.paidOrders.sort(byDateThenOrder);
    closure.pendingOrders.sort(byDateThenOrder);
    closure.newClients.sort((a, b) => {
      const typeCompare = String(a.clientType || '').localeCompare(String(b.clientType || ''));
      if (typeCompare !== 0) return typeCompare;
      return String(a.clientName || '').localeCompare(String(b.clientName || ''));
    });
    closure.products.sort(byProductThenOrder);
    closure.gifts.sort(byProductThenOrder);

    totals.billedUsd = roundMoney(totals.billedUsd);
    totals.regularBaseUsd = roundMoney(totals.regularBaseUsd);
    totals.specialItemBaseUsd = roundMoney(totals.specialItemBaseUsd);
    totals.specialOrderBaseUsd = roundMoney(totals.specialOrderBaseUsd);
    totals.grossCommissionUsd = roundMoney(totals.grossCommissionUsd);
    totals.pendingCollectionUsd = roundMoney(totals.pendingCollectionUsd);
    totals.giftDeductionsUsd = roundMoney(totals.giftDeductionsUsd);
    totals.manualDeductionsUsd = roundMoney(totals.manualDeductionsUsd);
    totals.payableUsd = roundMoney(
      totals.grossCommissionUsd - totals.giftDeductionsUsd - totals.manualDeductionsUsd
    );

    return {
      period_id: period.id,
      advisor_user_id: closure.advisorUserId,
      status: 'preliminary',
      base_commission_pct: closure.baseCommissionPct,
      delivered_orders_count: totals.deliveredOrdersCount,
      billed_usd: totals.billedUsd,
      regular_base_usd: totals.regularBaseUsd,
      special_item_base_usd: totals.specialItemBaseUsd,
      special_order_base_usd: totals.specialOrderBaseUsd,
      gross_commission_usd: totals.grossCommissionUsd,
      pending_collection_usd: totals.pendingCollectionUsd,
      punctual_paid_count: totals.punctualPaidCount,
      late_paid_count: totals.latePaidCount,
      pending_payment_count: totals.pendingPaymentCount,
      new_own_clients_count: totals.newOwnClientsCount,
      new_assigned_clients_count: totals.newAssignedClientsCount,
      gift_deductions_usd: totals.giftDeductionsUsd,
      manual_deductions_usd: totals.manualDeductionsUsd,
      payable_usd: totals.payableUsd,
      snapshot: {
        version: 1,
        generated_at: new Date().toISOString(),
        period,
        advisor: {
          id: closure.advisorUserId,
          name: closure.advisorName,
        },
        base_commission_pct: closure.baseCommissionPct,
        totals,
        orders: closure.orders,
        paid_orders: closure.paidOrders,
        punctual_orders: closure.paidOrders.filter((order) => order.paymentTiming === 'punctual'),
        late_orders: closure.paidOrders.filter((order) => order.paymentTiming === 'late'),
        pending_orders: closure.pendingOrders,
        new_clients: closure.newClients,
        products: closure.products,
        gifts: closure.gifts,
        deductions: [] as AdvisorCommissionManualDeductionSnapshot[],
      },
    };
  });
}

export async function createAdvisorCommissionPeriodAction(input: {
  name?: string;
  dateFrom: string;
  dateTo: string;
  notes?: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function generateAdvisorCommissionClosuresAction(input: {
  periodId: number;
  baseCommissionPct?: number;
  baseCommissionPctByAdvisor?: Record<string, number>;
  advisorUserId?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateAdvisorCommissionClosureStatusAction(input: {
  closureId: number;
  nextStatus: 'preliminary' | 'closed' | 'paid';
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadAdvisorCommissionClosuresAction(input: {
  periodId: number;
  advisorUserId?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadAdvisorCommissionPeriodAdvisorsAction(input: { periodId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

async function syncAdvisorCommissionClosureManualDeductions(supabase: Awaited<ReturnType<typeof requireMasterOrAdmin>>['supabase'], closureId: number) {
  const { data: closure, error: closureError } = await supabase
    .from('advisor_commission_closures')
    .select('id, status, gross_commission_usd, gift_deductions_usd, snapshot')
    .eq('id', closureId)
    .single();

  if (closureError || !closure) {
    throw new Error(closureError?.message || 'No se pudo cargar el cierre.');
  }

  if (closure.status === 'paid') {
    throw new Error('No se pueden cambiar deducibles de un cierre pagado.');
  }

  const { data: deductionRows, error: deductionsError } = await supabase
    .from('advisor_commission_deductions')
    .select('id, deduction_type, description, amount_usd, notes, created_at')
    .eq('closure_id', closureId)
    .neq('deduction_type', 'gift')
    .order('created_at', { ascending: true });

  if (deductionsError) {
    throw new Error(deductionsError.message);
  }

  const manualDeductions = (deductionRows ?? []).map((row) => ({
    id: Number(row.id),
    kind: row.deduction_type || 'manual_expense',
    description: row.description || '',
    amountUsd: roundMoney(row.amount_usd),
    notes: row.notes || null,
    createdAt: row.created_at || null,
  }));
  const manualDeductionsUsd = roundMoney(
    manualDeductions.reduce((sum, deduction) => sum + toSafeNumber(deduction.amountUsd, 0), 0)
  );
  const grossCommissionUsd = roundMoney(closure.gross_commission_usd);
  const giftDeductionsUsd = roundMoney(closure.gift_deductions_usd);
  const payableUsd = roundMoney(grossCommissionUsd - giftDeductionsUsd - manualDeductionsUsd);
  const snapshot =
    closure.snapshot && typeof closure.snapshot === 'object' && !Array.isArray(closure.snapshot)
      ? { ...(closure.snapshot as Record<string, unknown>) }
      : {};
  const totals =
    snapshot.totals && typeof snapshot.totals === 'object' && !Array.isArray(snapshot.totals)
      ? { ...(snapshot.totals as Record<string, unknown>) }
      : {};

  snapshot.totals = {
    ...totals,
    giftDeductionsUsd,
    manualDeductionsUsd,
    payableUsd,
  };
  snapshot.deductions = manualDeductions;

  const { error: updateError } = await supabase
    .from('advisor_commission_closures')
    .update({
      manual_deductions_usd: manualDeductionsUsd,
      payable_usd: payableUsd,
      snapshot,
      updated_at: new Date().toISOString(),
    })
    .eq('id', closureId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return { manualDeductionsUsd, payableUsd };
}

export async function addAdvisorCommissionClosureDeductionAction(input: {
  closureId: number;
  amountUsd: number;
  description: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function deleteAdvisorCommissionClosureDeductionAction(input: {
  closureId: number;
  deductionId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function logoutAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }
