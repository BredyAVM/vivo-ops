'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/supabase/server';
import { requireAuthContext, requireMasterOrAdminContext } from '@/lib/auth';
import { sendPushToAdvisorDevices, sendPushToRoleDevices } from '@/lib/push';
import { getPaymentReportRequirements } from '@/lib/payments/payment-report-rules';
import { assertNoActivePaymentDuplicate } from '@/lib/payments/payment-duplicates';
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from '@/lib/pricing/order-snapshots';
import { getPhoneSearchTerms, normalizePhone } from '@/lib/phone/normalize-phone';
import { normalizeRemoteSearchValue } from '@/lib/search/normalize-search';
import { formatOrderDisplayLabel } from '@/lib/orders/order-labels';
import { isOrderPriceProtected } from '@/lib/domain/order-domain';
import {
  getOrderCommercialNetUsd,
  getOrderLineTotalUsd,
  getOrderMoneySnapshot,
  getOrderRoundingClosureSnapshot,
} from '@/lib/orders/order-money';
import { getMasterDashboardPermissions } from './permissions';

const MASTER_DASHBOARD_FINANCIAL_REFERENCES_TAG = 'master-dashboard-financial-references';
const STALE_ORDER_EDIT_MESSAGE =
  'No se guardaron los cambios porque otra persona actualizó esta orden después de que la abriste. Para evitar pisar su trabajo, actualiza la orden, revisa lo nuevo y vuelve a guardar si todavía aplica.';

function revalidateMasterDashboardFinancialReferences() {
  updateTag(MASTER_DASHBOARD_FINANCIAL_REFERENCES_TAG);
  revalidatePath('/app/master/dashboard');
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

function buildCaracasTimestamp(isoDate: string, timeValue: string | null | undefined) {
  const date = String(isoDate || '').trim();
  const rawTime = String(timeValue || '').trim();
  const time = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : '23:59';
  const parsed = new Date(`${date}T${time}:00-04:00`);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('La fecha y hora del cierre no son validas.');
  }

  return parsed.toISOString();
}

function getMovementRecordedAtMs(movement: {
  movement_date?: string | null;
  confirmed_at?: string | null;
  created_at?: string | null;
}) {
  const timestamp = movement.confirmed_at || movement.created_at;
  if (!timestamp) return null;

  const parsedTimestamp = new Date(timestamp);
  return Number.isNaN(parsedTimestamp.getTime()) ? null : parsedTimestamp.getTime();
}

function getDefaultMoneyAccountClosureProfile(input: {
  accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
  currencyCode: 'USD' | 'VES';
}) {
  if (input.accountKind === 'pos') {
    return {
      closureKind: 'pos',
      requiresZeroDifference: true,
      allowsClassifiedDifference: false,
      generatesTransferOnClose: true,
      baselineRequired: true,
    };
  }

  if (input.accountKind === 'cash') {
    return {
      closureKind: 'cash',
      requiresZeroDifference: true,
      allowsClassifiedDifference: false,
      generatesTransferOnClose: false,
      baselineRequired: true,
    };
  }

  if (input.accountKind === 'bank') {
    return {
      closureKind: 'bank',
      requiresZeroDifference: false,
      allowsClassifiedDifference: true,
      generatesTransferOnClose: false,
      baselineRequired: true,
    };
  }

  if (input.accountKind === 'fund') {
    return {
      closureKind: 'fund',
      requiresZeroDifference: false,
      allowsClassifiedDifference: true,
      generatesTransferOnClose: false,
      baselineRequired: true,
    };
  }

  if (input.accountKind === 'wallet' && input.currencyCode === 'USD') {
    return {
      closureKind: 'wallet_usd',
      requiresZeroDifference: false,
      allowsClassifiedDifference: true,
      generatesTransferOnClose: false,
      baselineRequired: true,
    };
  }

  return {
    closureKind: 'other',
    requiresZeroDifference: false,
    allowsClassifiedDifference: true,
    generatesTransferOnClose: false,
    baselineRequired: true,
  };
}

async function ensureMoneyAccountClosureProfile(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    accountId: number;
    accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
    currencyCode: 'USD' | 'VES';
    defaultTargetMoneyAccountId: number | null;
  }
) {
  let targetMoneyAccountId =
    Number.isFinite(Number(input.defaultTargetMoneyAccountId || 0)) && Number(input.defaultTargetMoneyAccountId || 0) > 0
      ? Number(input.defaultTargetMoneyAccountId)
      : null;

  if (targetMoneyAccountId !== null) {
    if (targetMoneyAccountId === input.accountId) {
      throw new Error('La cuenta destino del cierre debe ser distinta al punto.');
    }

    const { data: targetAccount, error: targetAccountError } = await supabase
      .from('money_accounts')
      .select('id, currency_code, account_kind, is_active')
      .eq('id', targetMoneyAccountId)
      .single();

    if (targetAccountError || !targetAccount) {
      throw new Error(targetAccountError?.message || 'No se pudo cargar la cuenta destino del cierre.');
    }

    if (!targetAccount.is_active) {
      throw new Error('La cuenta destino del cierre debe estar activa.');
    }

    if (targetAccount.account_kind !== 'bank') {
      throw new Error('La cuenta destino del cierre debe ser una cuenta banco.');
    }

    if (String(targetAccount.currency_code || '').toUpperCase() !== input.currencyCode) {
      throw new Error('La cuenta destino del cierre debe tener la misma moneda.');
    }
  }

  const { data: existingProfile, error: existingProfileError } = await supabase
    .from('money_account_closure_profiles')
    .select('money_account_id')
    .eq('money_account_id', input.accountId)
    .maybeSingle();

  if (existingProfileError) throw new Error(existingProfileError.message);

  if (existingProfile) {
    const { error } = await supabase
      .from('money_account_closure_profiles')
      .update({ default_target_money_account_id: targetMoneyAccountId })
      .eq('money_account_id', input.accountId);

    if (error) throw new Error(error.message);
    return;
  }

  const defaultProfile = getDefaultMoneyAccountClosureProfile({
    accountKind: input.accountKind,
    currencyCode: input.currencyCode,
  });

  if (!defaultProfile.generatesTransferOnClose) {
    targetMoneyAccountId = null;
  }

  const { error } = await supabase.from('money_account_closure_profiles').insert({
    money_account_id: input.accountId,
    closure_kind: defaultProfile.closureKind,
    requires_zero_difference: defaultProfile.requiresZeroDifference,
    allows_classified_difference: defaultProfile.allowsClassifiedDifference,
    generates_transfer_on_close: defaultProfile.generatesTransferOnClose,
    default_target_money_account_id: targetMoneyAccountId,
    baseline_required: defaultProfile.baselineRequired,
  });

  if (error) throw new Error(error.message);
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

const ORDER_ROUNDING_SHORTFALL_CLOSE_MAX_USD = 0.09;
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

const APP_USER_ROLES_VALUES: AppUserRole[] = ['admin', 'master', 'advisor', 'kitchen', 'counter', 'driver'];
const APP_USER_ROLES = new Set<AppUserRole>(['admin', 'master', 'advisor', 'kitchen', 'counter', 'driver']);
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

function normalizeUserRoles(input: unknown): AppUserRole[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<AppUserRole>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    if (!APP_USER_ROLES.has(value as AppUserRole)) continue;
    seen.add(value as AppUserRole);
  }

  return Array.from(seen);
}

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
};

async function updateDashboardUserActionLegacy(input: {
  userId: string;
  fullName: string;
  isActive: boolean;
  roles: AppUserRole[];
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const userId = String(input.userId || '').trim();
  if (!userId) {
    throw new Error('Usuario inválido.');
  }

  const nextRoles = normalizeUserRoles(input.roles);
  if (nextRoles.length === 0) {
    throw new Error('Selecciona al menos un rol.');
  }

  if (userId === user.id && !nextRoles.some((role) => role === 'admin' || role === 'master')) {
    throw new Error('No puedes quitarte tu propio acceso al dashboard master.');
  }

  const fullName = String(input.fullName || '').trim();

  const { error: profileError } = await supabase
    .from('profiles')
    .update({
      full_name: fullName || null,
      is_active: Boolean(input.isActive),
    })
    .eq('id', userId);

  if (profileError) throw new Error(profileError.message);

  const { data: currentRoleRows, error: currentRolesError } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId);

  if (currentRolesError) throw new Error(currentRolesError.message);

  const currentRoles = normalizeUserRoles((currentRoleRows ?? []).map((row) => row.role));
  const rolesToAdd = nextRoles.filter((role) => !currentRoles.includes(role));
  const rolesToRemove = currentRoles.filter((role) => !nextRoles.includes(role));

  if (rolesToRemove.length > 0) {
    const { error: deleteRolesError } = await supabase
      .from('user_roles')
      .delete()
      .eq('user_id', userId)
      .in('role', rolesToRemove);

    if (deleteRolesError) throw new Error(deleteRolesError.message);
  }

  if (rolesToAdd.length > 0) {
    const { error: insertRolesError } = await supabase
      .from('user_roles')
      .insert(rolesToAdd.map((role) => ({ user_id: userId, role })));

    if (insertRolesError) throw new Error(insertRolesError.message);
  }

  revalidatePath('/app/master/dashboard');
}

export async function updateDashboardUserAction(input: {
  userId: string;
  fullName: string;
  isActive: boolean;
  roles: AppUserRole[];
}) {
  try {
    const { user, roles } = await requireMasterOrAdmin();
    requireAdminRole(roles);

    const userId = String(input.userId || '').trim();
    if (!userId) {
      return { ok: false, error: 'Usuario invalido.' };
    }

    const nextRoles = normalizeUserRoles(input.roles);
    if (nextRoles.length === 0) {
      return { ok: false, error: 'Selecciona al menos un rol.' };
    }

    if (userId === user.id && !nextRoles.some((role) => role === 'admin' || role === 'master')) {
      return { ok: false, error: 'No puedes quitarte tu propio acceso al dashboard master.' };
    }

    const adminSupabase = createSupabaseServiceRoleServer();
    const fullName = String(input.fullName || '').trim();

    const { error: profileError } = await adminSupabase
      .from('profiles')
      .update({
        full_name: fullName || null,
        is_active: Boolean(input.isActive),
      })
      .eq('id', userId);

    if (profileError) return { ok: false, error: profileError.message };

    const rolesToKeep = APP_USER_ROLES_VALUES.filter((role) => nextRoles.includes(role));
    const rolesToRemove = APP_USER_ROLES_VALUES.filter((role) => !nextRoles.includes(role));

    if (rolesToRemove.length > 0) {
      const { error: deleteRolesError } = await adminSupabase
        .from('user_roles')
        .delete()
        .eq('user_id', userId)
        .in('role', rolesToRemove);

      if (deleteRolesError) return { ok: false, error: deleteRolesError.message };
    }

    if (rolesToKeep.length > 0) {
      const { error: upsertRolesError } = await adminSupabase
        .from('user_roles')
        .upsert(
          rolesToKeep.map((role) => ({ user_id: userId, role })),
          { onConflict: 'user_id,role' }
        );

      if (upsertRolesError) return { ok: false, error: upsertRolesError.message };
    }

    revalidatePath('/app/master/dashboard');
    return { ok: true };
  } catch (error) {
    console.error('updateDashboardUserAction failed', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo actualizar el usuario.',
    };
  }
}

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

async function saveMasterInboxItemsState(
  input: { items: MasterInboxStateItemInput[] },
  status: 'reviewed' | 'resolved'
) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  const items = normalizeMasterInboxStateItems(input.items);

  if (items.length === 0) return;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('master_inbox_item_states')
    .upsert(
      items.map((item) => ({
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

  revalidatePath('/app/master/dashboard');
}

export async function markMasterInboxItemsReviewedAction(input: { items: MasterInboxStateItemInput[] }) {
  await saveMasterInboxItemsState(input, 'reviewed');
}

export async function resolveMasterInboxItemsAction(input: { items: MasterInboxStateItemInput[] }) {
  await saveMasterInboxItemsState(input, 'resolved');
}

export async function reopenMasterInboxItemsAction(input: { itemIds: string[] }) {
  const { supabase } = await requireMasterOrAdmin();
  const itemIds = Array.from(
    new Set(
      Array.isArray(input.itemIds)
        ? input.itemIds.map((value) => String(value || '').trim()).filter((value) => value && value.length <= 160)
        : []
    )
  );

  if (itemIds.length === 0) return;

  const { error } = await supabase.from('master_inbox_item_states').delete().in('item_id', itemIds);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/app/master/dashboard');
}

export async function loadMasterOrderEventsAction(input: { orderId: number }) {
  const { supabase } = await requireMasterOrAdmin();
  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  const [legacyEventsResult, timelineEventsResult, orderResult] = await Promise.all([
    supabase
      .from('order_events')
      .select('id, event, performed_by, meta, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false }),
    supabase
      .from('order_timeline_events')
      .select('id, event_type, event_group, title, message, severity, actor_user_id, payload, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false }),
    supabase
      .from('orders')
      .select('created_at, created_by_user_id')
      .eq('id', orderId)
      .maybeSingle(),
  ]);
  const { data: legacyEventsData, error: legacyEventsError } = legacyEventsResult;
  const { data: timelineEventsData, error: timelineEventsError } = timelineEventsResult;

  if (legacyEventsError) throw new Error(legacyEventsError.message);
  if (timelineEventsError) throw new Error(timelineEventsError.message);

  const legacyEvents = (legacyEventsData ?? []) as Array<{
    id: number | string;
    event: string | null;
    performed_by: string | null;
    meta: unknown;
    created_at: string | null;
  }>;
  const timelineEvents = (timelineEventsData ?? []) as Array<{
    id: number | string;
    event_type: string | null;
    event_group: string | null;
    title: string | null;
    message: string | null;
    severity: OrderEventSeverity | null;
    actor_user_id: string | null;
    payload: unknown;
    created_at: string | null;
  }>;
  if (orderResult.error) throw new Error(orderResult.error.message);

  const actorIds = Array.from(new Set([
    ...legacyEvents.map((event) => String(event.performed_by || '').trim()),
    ...timelineEvents.map((event) => String(event.actor_user_id || '').trim()),
    String(orderResult.data?.created_by_user_id || '').trim(),
  ].filter(Boolean)));
  const { data: actorsData, error: actorsError } = actorIds.length > 0
    ? await supabase.from('profiles').select('id, full_name').in('id', actorIds)
    : { data: [], error: null };
  if (actorsError) throw new Error(actorsError.message);

  const actorNameById = new Map<string, string>();
  for (const actor of (actorsData ?? []) as Array<{ id: string; full_name: string | null }>) {
    actorNameById.set(String(actor.id), String(actor.full_name || 'Usuario').trim() || 'Usuario');
  }

  const presentationByEvent: Record<string, { eventType: string; eventGroup: string; title: string; message: string | null; severity: OrderEventSeverity }> = {
    approved: { eventType: 'order_approved', eventGroup: 'approval', title: 'Orden aprobada', message: 'La orden fue aprobada.', severity: 'info' },
    modified: { eventType: 'order_modified', eventGroup: 'modification', title: 'Orden modificada', message: null, severity: 'warning' },
    returned: { eventType: 'order_returned_to_review', eventGroup: 'approval', title: 'Pedido devuelto para ajuste', message: null, severity: 'warning' },
    reapproved: { eventType: 'order_reapproved', eventGroup: 'approval', title: 'Orden re-aprobada', message: 'La orden fue re-aprobada.', severity: 'info' },
    queued_reapproved: { eventType: 'order_reapproved', eventGroup: 'approval', title: 'Orden re-aprobada', message: 'La orden fue re-aprobada.', severity: 'info' },
    sent_to_kitchen: { eventType: 'order_sent_to_kitchen', eventGroup: 'kitchen', title: 'Enviada a cocina', message: 'La orden fue enviada a cocina.', severity: 'info' },
    kitchen_started: { eventType: 'kitchen_taken', eventGroup: 'kitchen', title: 'Cocina tomó la orden', message: 'Cocina inició la preparación.', severity: 'info' },
    ready: { eventType: 'order_ready', eventGroup: 'kitchen', title: 'Orden preparada', message: 'La orden quedó preparada.', severity: 'info' },
    driver_assigned_internal: { eventType: 'driver_assigned', eventGroup: 'delivery', title: 'Motorizado interno asignado', message: 'Se asignó un motorizado interno a la orden.', severity: 'info' },
    driver_assigned_external: { eventType: 'driver_assigned', eventGroup: 'delivery', title: 'Partner externo asignado', message: 'Se asignó un partner externo a la orden.', severity: 'info' },
    assign_driver_task_closed: { eventType: 'driver_assigned', eventGroup: 'delivery', title: 'Asignación de motorizado completada', message: 'La asignación de motorizado fue completada.', severity: 'info' },
    clear_delivery_assignment: { eventType: 'driver_unassigned', eventGroup: 'delivery', title: 'Asignación de delivery removida', message: 'La orden quedó sin asignación de delivery.', severity: 'warning' },
    returned_to_queue: { eventType: 'order_returned_to_review', eventGroup: 'approval', title: 'Orden devuelta a cola', message: 'La orden regresó a cola de revisión.', severity: 'warning' },
    out_for_delivery: { eventType: 'out_for_delivery', eventGroup: 'delivery', title: 'Orden en camino', message: 'La orden salió en camino.', severity: 'info' },
    delivered: { eventType: 'order_delivered', eventGroup: 'delivery', title: 'Orden entregada', message: 'La orden fue entregada.', severity: 'info' },
    payment_rejected: { eventType: 'payment_rejected', eventGroup: 'payment', title: 'Pago rechazado: corrección requerida', message: 'El pago fue rechazado y requiere corrección.', severity: 'critical' },
  };

  type OrderHistoryEvent = {
    id: string;
    eventType: string;
    dedupeKey: string;
    eventGroup: string;
    title: string;
    message: string | null;
    severity: OrderEventSeverity;
    actorUserId: string | null;
    actorName: string;
    payload: Record<string, unknown>;
    createdAt: string;
    recipientRequiresAction: boolean;
    recipientReadAt: null;
    sourcePriority: number;
  };

  const normalizedEvents: OrderHistoryEvent[] = legacyEvents.map((event) => {
    const rawType = String(event.event || '').trim();
    const presentation = presentationByEvent[rawType] ?? {
      eventType: rawType || 'event',
      eventGroup: 'operation',
      title: 'Evento operativo',
      message: rawType ? 'Se registró un movimiento operativo en la orden.' : 'Se registró un evento en la orden.',
      severity: 'info' as OrderEventSeverity,
    };
    const payload = event.meta && typeof event.meta === 'object' && !Array.isArray(event.meta)
      ? (event.meta as Record<string, unknown>)
      : {};

    return {
      id: `order-event-${String(event.id)}`,
      ...presentation,
      dedupeKey: rawType === 'assign_driver_task_closed' ? rawType : presentation.eventType,
      actorUserId: event.performed_by ?? null,
      actorName: actorNameById.get(String(event.performed_by || '')) || 'Sistema',
      payload,
      createdAt: String(event.created_at || ''),
      recipientRequiresAction: presentation.eventType === 'payment_rejected' || presentation.eventType === 'order_returned_to_review',
      recipientReadAt: null,
      sourcePriority: 1,
    };
  });

  for (const event of timelineEvents) {
    const eventType = String(event.event_type || '').trim();
    if (!eventType) continue;

    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};

    normalizedEvents.push({
      id: `timeline-event-${String(event.id)}`,
      eventType,
      dedupeKey: eventType,
      eventGroup: String(event.event_group || 'operation'),
      title: String(event.title || 'Evento operativo'),
      message: event.message == null ? null : String(event.message),
      severity: event.severity === 'warning' || event.severity === 'critical' ? event.severity : 'info',
      actorUserId: event.actor_user_id ?? null,
      actorName: actorNameById.get(String(event.actor_user_id || '')) || 'Sistema',
      payload,
      createdAt: String(event.created_at || ''),
      recipientRequiresAction: eventType === 'payment_rejected' || eventType === 'order_returned_to_review',
      recipientReadAt: null,
      sourcePriority: 2,
    });
  }

  const createdAt = String(orderResult.data?.created_at || '');
  if (createdAt) {
    normalizedEvents.push({
      id: `order-created-${orderId}`,
      eventType: 'order_created',
      dedupeKey: 'order_created',
      eventGroup: 'approval',
      title: 'Orden creada',
      message: 'La orden fue creada y quedó pendiente de aprobación.',
      severity: 'info',
      actorUserId: orderResult.data?.created_by_user_id ?? null,
      actorName: actorNameById.get(String(orderResult.data?.created_by_user_id || '')) || 'Sistema',
      payload: { order_id: orderId },
      createdAt,
      recipientRequiresAction: false,
      recipientReadAt: null,
      sourcePriority: 0,
    });
  }

  const eventTime = (value: string) => {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  };
  const deduplicated: OrderHistoryEvent[] = [];

  for (const event of normalizedEvents
    .filter((event) => event.eventType && event.createdAt)
    .sort((a, b) => eventTime(b.createdAt) - eventTime(a.createdAt) || b.sourcePriority - a.sourcePriority)) {
    const duplicateIndex = deduplicated.findIndex((saved) =>
      saved.dedupeKey === event.dedupeKey
      && saved.sourcePriority !== event.sourcePriority
      && Math.abs(eventTime(saved.createdAt) - eventTime(event.createdAt)) <= 2_000,
    );

    if (duplicateIndex === -1) {
      deduplicated.push(event);
    } else if (event.sourcePriority > deduplicated[duplicateIndex].sourcePriority) {
      deduplicated[duplicateIndex] = event;
    }
  }

  return deduplicated
    .sort((a, b) => eventTime(b.createdAt) - eventTime(a.createdAt))
    .map(({ sourcePriority: _sourcePriority, dedupeKey: _dedupeKey, ...event }) => event);
}

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

    const { data: insertedEvent, error: insertEventError } = await supabase
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
    const kitchenRequiresAction = (input.recipients ?? []).some(
      (recipient) => recipient.targetRole === 'kitchen' && recipient.requiresAction,
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

    if (kitchenRequiresAction) {
      try {
        const orderLabel = formatOrderDisplayLabel(input.orderId);
        const clientLabel = context?.clientName ? `${context.clientName}. ` : '';
        await sendPushToRoleDevices({
          roles: ['kitchen'],
          title: `${orderLabel}: nueva orden en cola`,
          body: `${clientLabel}${input.message || 'Hay una orden nueva para tomar en cocina.'}`,
          url: '/app/kitchen',
          tag: `kitchen-order-${input.orderId}-${input.eventType}`,
          tone: input.eventType === 'order_sent_to_kitchen' ? 'critical' : 'warning',
          requireInteraction: input.eventType === 'order_sent_to_kitchen',
        });
      } catch (pushError) {
        console.warn(
          'appendOrderEvent kitchen push skipped',
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
    inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
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
}) {
  const { supabase, user, roles } = await requirePaymentReportOperator();
  const paymentMethod = normalizePaymentMethodCode(input.paymentMethod);
  const isMasterOrAdmin = roles.includes('admin') || roles.includes('master');

  if (!isMasterOrAdmin) {
    if (!paymentMethod) {
      throw new Error('Debes indicar el metodo de pago.');
    }

    const { data: allowedRule, error: allowedRuleError } = await supabase
      .from('money_account_payment_rules')
      .select('id')
      .eq('money_account_id', input.reportedMoneyAccountId)
      .eq('payment_method_code', paymentMethod)
      .eq('can_report_payment', true)
      .eq('is_active', true)
      .in('role', roles)
      .limit(1)
      .maybeSingle();

    if (allowedRuleError) {
      throw new Error(allowedRuleError.message);
    }

    if (!allowedRule) {
      throw new Error('No tienes permiso para reportar pagos en esta cuenta.');
    }
  }

  const requirements = getPaymentReportRequirements(paymentMethod);
  const requiresOperationData = requirements.requiresOperationDate;
  const requiresBank = requirements.requiresBank;
  const requiresHolderName = requirements.requiresHolderName;
  const requiresInvoiceNumber = requirements.requiresInvoiceNumber;
  const operationDate = String(input.operationDate || '').trim();
  const referenceCode = String(input.referenceCode || '').trim();
  const bankName = String(input.bankName || '').trim();
  const payerName = String(input.payerName || '').trim();

  if (!operationDate) {
    throw new Error('Debes indicar la fecha de la operaciÃ³n.');
  }

  if (requiresOperationData && !operationDate) {
    throw new Error('Debes indicar la fecha de la operación.');
  }

  if (requiresOperationData && !referenceCode) {
    throw new Error('Debes indicar la referencia de la operación.');
  }

  if (requiresBank && !bankName) {
    throw new Error('Debes indicar el banco de la operación.');
  }

  if (requiresHolderName && !payerName) {
    throw new Error('Debes indicar el nombre del titular de Zelle.');
  }

  if (requiresInvoiceNumber && !payerName) {
    throw new Error('Debes indicar el numero de factura.');
  }

  const notesParts = [
    paymentMethod === 'retention' && referenceCode ? `Comprobante retencion: ${referenceCode}` : null,
    paymentMethod === 'retention' && payerName ? `Factura: ${payerName}` : null,
    operationDate ? `Fecha operación: ${operationDate}` : null,
    requiresBank && bankName ? `Banco: ${bankName}` : null,
    requiresHolderName && payerName ? `Titular: ${payerName}` : null,
    input.notes ? String(input.notes).trim() : null,
  ].filter((part): part is string => Boolean(part));
  const reportNotes = notesParts.length > 0 ? notesParts.join('\n') : null;
  const reportPayerName = paymentMethod === 'retention' ? null : requirements.requiresBank ? bankName : payerName || null;
  const reportedCurrency = String(input.reportedCurrency || '').trim().toUpperCase();

  await assertNoActivePaymentDuplicate(supabase, {
    moneyAccountId: input.reportedMoneyAccountId,
    operationDate,
    currencyCode: reportedCurrency,
    amount: input.reportedAmount,
    referenceCode,
  });

  let snapshotEquivalentUsd: number | null = null;

  if (reportedCurrency === 'VES') {
    const financialState = await loadOrderFinancialState(supabase, {
      orderId: input.orderId,
      operationDate: normalizeDateOnly(operationDate),
      activeBsRate: input.reportedExchangeRateVesPerUsd,
    });
    snapshotEquivalentUsd = getSnapshotEquivalentUsdFromFinancialState({
      state: financialState,
      reportedAmount: input.reportedAmount,
    });
  }

  const effectiveReportedExchangeRate =
    snapshotEquivalentUsd != null && snapshotEquivalentUsd > 0.005
      ? Number((input.reportedAmount / snapshotEquivalentUsd).toFixed(6))
      : input.reportedExchangeRateVesPerUsd;
  let createdPaymentReportId: number | null = null;

  if (paymentMethod === 'retention') {
    const reportedAmount = roundMoney(input.reportedAmount);
    const exchangeRate = toSafeNumber(effectiveReportedExchangeRate, 0);
    const reportedAmountUsdEquivalent =
      reportedCurrency === 'VES'
        ? exchangeRate > 0
          ? roundMoney(reportedAmount / exchangeRate)
          : 0
        : reportedAmount;

    if (reportedCurrency === 'VES' && exchangeRate <= 0) {
      throw new Error('Debes indicar una tasa válida para registrar la retención.');
    }

    if (reportedAmountUsdEquivalent <= 0.005) {
      throw new Error('El monto de la retención no es válido.');
    }

    const { data: insertedRetention, error: insertRetentionError } = await supabase
      .from('payment_reports')
      .insert({
        order_id: input.orderId,
        status: 'pending',
        created_by_user_id: user.id,
        reported_currency_code: reportedCurrency,
        reported_amount: reportedAmount,
        reported_exchange_rate_ves_per_usd:
          reportedCurrency === 'VES' ? exchangeRate : null,
        reported_amount_usd_equivalent: reportedAmountUsdEquivalent,
        reported_money_account_id: input.reportedMoneyAccountId,
        reference_code: referenceCode || null,
        payer_name: reportPayerName,
        notes: reportNotes,
        operation_date: operationDate || null,
      })
      .select('id')
      .single();

    if (insertRetentionError) throw new Error(insertRetentionError.message);
    createdPaymentReportId = Number(insertedRetention?.id || 0) || null;
  } else {
    const { data: createdReportId, error } = await supabase.rpc('create_payment_report', {
      p_order_id: input.orderId,
      p_reported_money_account_id: input.reportedMoneyAccountId,
      p_reported_currency: input.reportedCurrency,
      p_reported_amount: input.reportedAmount,
      p_reported_exchange_rate_ves_per_usd: effectiveReportedExchangeRate,
      p_reference_code: referenceCode || null,
      p_payer_name: reportPayerName,
      p_notes: reportNotes,
    });

    if (error) throw new Error(error.message);

    createdPaymentReportId = Number(createdReportId || 0) || null;
    await savePaymentReportOperationDate(createdReportId, operationDate);
  }

  if (snapshotEquivalentUsd != null && snapshotEquivalentUsd > 0.005) {
    const impliedRate = Number((input.reportedAmount / snapshotEquivalentUsd).toFixed(6));
    const { data: latestReport } = await supabase
      .from('payment_reports')
      .select('id')
      .eq('order_id', input.orderId)
      .eq('status', 'pending')
      .eq('reported_currency_code', 'VES')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestReport?.id) {
      createdPaymentReportId = Number(latestReport.id || 0) || createdPaymentReportId;
      const { error: updateEquivalentError } = await supabase
        .from('payment_reports')
        .update({
          reported_amount_usd_equivalent: snapshotEquivalentUsd,
          reported_exchange_rate_ves_per_usd: impliedRate,
        })
        .eq('id', latestReport.id);

      if (updateEquivalentError) throw new Error(updateEquivalentError.message);
    }
  }

  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'payment_reported',
    eventGroup: 'payment',
    title: 'Pago reportado',
    message: 'Se registro un nuevo reporte de pago.',
    severity: 'warning',
    actorUserId: user.id,
    payload: {
      reported_money_account_id: input.reportedMoneyAccountId,
      reported_currency: input.reportedCurrency,
      reported_amount: input.reportedAmount,
      exchange_rate_ves_per_usd: input.reportedExchangeRateVesPerUsd,
      payment_method: paymentMethod,
      operation_date: operationDate || null,
      reference_code: referenceCode || null,
      bank_name: bankName || null,
      payer_name: reportPayerName,
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetRole: 'admin', requiresAction: true },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/counter');

  return {
    reportId: createdPaymentReportId,
  };
}

export async function confirmPaymentReportAction(input: {
  reportId: number;
  orderId?: number | null;
  clientId?: number | null;
  confirmedMoneyAccountId: number;
  confirmedCurrency: string;
  confirmedAmount: number;
  movementDate: string;
  confirmedExchangeRateVesPerUsd: number | null;
  reviewNotes: string;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
  paymentKind?: 'retention' | null;
  overpaymentHandling?: 'change_given' | 'store_fund' | 'close_difference' | null;
  overpaymentNotes?: string | null;
  changeLines?: Array<{
    moneyAccountId: number;
    currencyCode: string;
    amount: number;
    exchangeRateVesPerUsd?: number | null;
    notes?: string | null;
  }>;
  changeMoneyAccountId?: number | null;
  changeCurrency?: string | null;
  changeAmount?: number | null;
  changeExchangeRateVesPerUsd?: number | null;
}) {
  const { supabase, user, roles } = await requirePaymentReportOperator();
  const { data: paymentReportForDate, error: paymentReportForDateError } = await supabase
    .from('payment_reports')
    .select('operation_date, reported_amount_usd_equivalent, created_by_user_id, reported_money_account_id')
    .eq('id', input.reportId)
    .maybeSingle();

  if (paymentReportForDateError) throw new Error(paymentReportForDateError.message);
  if (!paymentReportForDate) throw new Error('No se encontro el reporte de pago.');

  const isMasterOrAdmin = roles.includes('admin') || roles.includes('master');
  if (!isMasterOrAdmin) {
    const reportAccountId = Number(paymentReportForDate.reported_money_account_id || 0);
    if (paymentReportForDate.created_by_user_id !== user.id || reportAccountId !== input.confirmedMoneyAccountId) {
      throw new Error('No tienes permiso para confirmar este reporte.');
    }

    const { data: allowedRule, error: allowedRuleError } = await supabase
      .from('money_account_payment_rules')
      .select('id')
      .eq('money_account_id', input.confirmedMoneyAccountId)
      .eq('is_active', true)
      .in('role', roles)
      .or('can_confirm_payment.eq.true,auto_confirms_report.eq.true')
      .limit(1)
      .maybeSingle();

    if (allowedRuleError) {
      throw new Error(allowedRuleError.message);
    }

    if (!allowedRule) {
      throw new Error('No tienes permiso para confirmar pagos en esta cuenta.');
    }
  }

  const effectiveMovementDate =
    normalizeDateOnly(paymentReportForDate?.operation_date) ||
    normalizeDateOnly(input.movementDate) ||
    getCaracasDateString(new Date());

  const { error } = await supabase.rpc('confirm_payment_report', {
    p_report_id: input.reportId,
    p_confirmed_money_account_id: input.confirmedMoneyAccountId,
    p_confirmed_currency: input.confirmedCurrency,
    p_confirmed_amount: input.confirmedAmount,
    p_movement_date: effectiveMovementDate,
    p_confirmed_exchange_rate_ves_per_usd: input.confirmedExchangeRateVesPerUsd,
    p_review_notes: input.reviewNotes,
    p_reference_code: input.referenceCode,
    p_counterparty_name: input.counterpartyName,
    p_description: input.description,
  });

  if (error) throw new Error(error.message);

  const orderId = Number(input.orderId || 0);
  if (Number.isFinite(orderId) && orderId > 0) {
    const eventContext = await loadOrderEventContext(supabase, orderId);
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id, total_usd, total_bs_snapshot, extra_fields')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo recalcular el saldo de la orden.');
    }

    const financialState = await loadOrderFinancialState(supabase, {
      orderId,
      operationDate: effectiveMovementDate,
      activeBsRate: input.confirmedExchangeRateVesPerUsd,
    });
    let fallbackConfirmedPaidUsd = 0;
    if (!financialState) {
      const { data: orderMovements, error: orderMovementsError } = await supabase
        .from('money_movements')
        .select('direction, amount_usd_equivalent')
        .eq('order_id', orderId)
        .eq('status', 'confirmed');

      if (orderMovementsError) {
        throw new Error(orderMovementsError.message);
      }

      fallbackConfirmedPaidUsd = roundMoney((orderMovements ?? []).reduce((sum, row) => {
        const signedAmount =
          toSafeNumber(row.amount_usd_equivalent, 0) *
          (row.direction === 'outflow' ? -1 : 1);
        return sum + signedAmount;
      }, 0));
    }
    const confirmedPaidUsd = financialState
      ? roundMoney(financialState.confirmed_paid_usd)
      : fallbackConfirmedPaidUsd;
    const currentTotalUsd = financialState
      ? roundMoney(financialState.total_usd)
      : getEffectiveOrderTotalUsd(currentOrder);
    const currentTotalBs = financialState
      ? roundMoney(financialState.total_bs)
      : getEffectiveOrderTotalBs(currentOrder);
    const excessUsd = financialState
      ? roundMoney(financialState.overpaid_usd)
      : roundMoney(Math.max(0, confirmedPaidUsd - currentTotalUsd));
    const isRetentionPayment = input.paymentKind === 'retention';
    const reportUsdEquivalent = roundMoney(paymentReportForDate?.reported_amount_usd_equivalent);
    const storeableExcessUsd =
      reportUsdEquivalent > 0.005
        ? roundMoney(Math.min(excessUsd, reportUsdEquivalent))
        : excessUsd;
    const handling = input.overpaymentHandling ?? (excessUsd > 0.005 ? 'store_fund' : null);
    const notes = String(input.overpaymentNotes || '').trim() || null;
    let excessStoredInFundUsd = handling === 'store_fund' ? storeableExcessUsd : 0;

    if (excessUsd > 0.005 && handling === 'change_given') {
      const inputChangeLines =
        Array.isArray(input.changeLines) && input.changeLines.length > 0
          ? input.changeLines
          : [
              {
                moneyAccountId: Number(input.changeMoneyAccountId || 0),
                currencyCode: String(input.changeCurrency || '').trim().toUpperCase(),
                amount:
                  input.changeAmount != null && Number.isFinite(Number(input.changeAmount))
                    ? Number(input.changeAmount)
                    : toNativeAmountFromUsd(
                        excessUsd,
                        String(input.changeCurrency || '').trim().toUpperCase(),
                        input.changeExchangeRateVesPerUsd ?? null
                      ),
                exchangeRateVesPerUsd: input.changeExchangeRateVesPerUsd ?? null,
                notes,
              },
            ];

      const changeLines = inputChangeLines
        .map((line) => {
          const moneyAccountId = Number(line.moneyAccountId || 0);
          const currencyCode = String(line.currencyCode || '').trim().toUpperCase();
          const amount = Number(toSafeNumber(line.amount, 0).toFixed(2));
          const exchangeRate =
            line.exchangeRateVesPerUsd == null
              ? null
              : Number(toSafeNumber(line.exchangeRateVesPerUsd, 0).toFixed(6));
          const amountUsd = Number(
            (currencyCode === 'VES' ? amount / Number(exchangeRate || 0) : amount).toFixed(2)
          );

          return {
            moneyAccountId,
            currencyCode,
            amount,
            exchangeRate,
            amountUsd,
            notes: String(line.notes || notes || '').trim() || null,
          };
        })
        .filter((line) => line.moneyAccountId > 0 && line.currencyCode && line.amount > 0);

      if (changeLines.length === 0) {
        throw new Error('Debes agregar al menos una linea de devolucion.');
      }

      if (!isMasterOrAdmin) {
        const changeAccountIds = Array.from(new Set(changeLines.map((line) => line.moneyAccountId)));
        const { data: changeRules, error: changeRulesError } = await supabase
          .from('money_account_payment_rules')
          .select('money_account_id, payment_method_code')
          .in('money_account_id', changeAccountIds)
          .eq('is_active', true)
          .in('role', roles)
          .or('can_confirm_payment.eq.true,auto_confirms_report.eq.true');

        if (changeRulesError) {
          throw new Error(changeRulesError.message);
        }

        const allowedChangeAccounts = new Set(
          (changeRules ?? []).map((rule) => Number(rule.money_account_id))
        );

        if (changeAccountIds.some((accountId) => !allowedChangeAccounts.has(accountId))) {
          throw new Error('No tienes permiso para entregar cambio desde una de estas cuentas.');
        }
      }

      for (const line of changeLines) {
        if (line.currencyCode === 'VES' && (!line.exchangeRate || line.exchangeRate <= 0)) {
          throw new Error('Debes indicar una tasa valida para cada devolucion en Bs.');
        }
        if (!Number.isFinite(line.amountUsd) || line.amountUsd <= 0) {
          throw new Error('Una linea de devolucion tiene monto invalido.');
        }
      }

      const totalChangeUsd = roundMoney(changeLines.reduce((sum, line) => sum + line.amountUsd, 0));
      excessStoredInFundUsd = roundMoney(Math.max(0, excessUsd - totalChangeUsd));
      const groupId =
        changeLines.length > 1 ||
        excessStoredInFundUsd > 0.005 ||
        totalChangeUsd > excessUsd + 0.005
          ? crypto.randomUUID()
          : null;
      const confirmedAt = new Date().toISOString();

      const { error: changeMovementError } = await supabase
        .from('money_movements')
        .insert(changeLines.map((line, index) => ({
          movement_date: effectiveMovementDate,
          created_by_user_id: user.id,
          confirmed_at: confirmedAt,
          confirmed_by_user_id: user.id,
          status: 'confirmed',
          direction: 'outflow',
          movement_type: isRetentionPayment ? 'withdrawal' : 'change_given',
          money_account_id: line.moneyAccountId,
          currency_code: line.currencyCode,
          amount: line.amount,
          exchange_rate_ves_per_usd: line.currencyCode === 'VES' ? line.exchangeRate : null,
          amount_usd_equivalent: line.amountUsd,
          reference_code: input.referenceCode,
          counterparty_name: input.counterpartyName,
          description:
            input.description
              ? `${input.description} - ${isRetentionPayment ? 'devolucion de retencion' : 'cambio entregado'} ${index + 1}`
              : `${isRetentionPayment ? 'Devolucion de retencion' : 'Cambio entregado'} - linea ${index + 1} - orden ${orderId} - reporte ${input.reportId}`,
          notes: line.notes,
          order_id: orderId,
          payment_report_id: null,
          movement_group_id: groupId,
        })));

      if (changeMovementError) throw new Error(changeMovementError.message);
    }

    if (false && excessUsd > 0.005 && handling === 'change_given') {
      const changeMoneyAccountId = Number(input.changeMoneyAccountId || 0);
      if (!Number.isFinite(changeMoneyAccountId) || changeMoneyAccountId <= 0) {
        throw new Error('Debes seleccionar la cuenta desde la cual se dará el cambio.');
      }

      const changeCurrency = String(input.changeCurrency || '').trim().toUpperCase();
      if (!changeCurrency) {
        throw new Error('No se pudo determinar la moneda del cambio.');
      }

      const changeAmount =
        input.changeAmount != null && Number.isFinite(Number(input.changeAmount))
          ? Number(Number(input.changeAmount).toFixed(2))
          : toNativeAmountFromUsd(
              excessUsd,
              changeCurrency,
              input.changeExchangeRateVesPerUsd ?? null
            );

      if (!Number.isFinite(changeAmount) || changeAmount <= 0) {
        throw new Error('El monto del cambio no es válido.');
      }

      const { error: changeMovementError } = await supabase
        .from('money_movements')
        .insert({
          movement_date: effectiveMovementDate,
          created_by_user_id: user.id,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: user.id,
          direction: 'outflow',
          movement_type: isRetentionPayment ? 'withdrawal' : 'change_given',
          money_account_id: changeMoneyAccountId,
          currency_code: changeCurrency,
          amount: changeAmount,
          exchange_rate_ves_per_usd:
            changeCurrency === 'VES'
              ? input.changeExchangeRateVesPerUsd ?? null
              : null,
          amount_usd_equivalent: excessUsd,
          reference_code: input.referenceCode,
          counterparty_name: input.counterpartyName,
          description:
            input.description
              ? `${input.description} · ${isRetentionPayment ? 'devolución de retención' : 'cambio entregado'}`
              : `${isRetentionPayment ? 'Devolución de retención' : 'Cambio entregado'} · orden ${orderId} · reporte ${input.reportId}`,
          notes,
          order_id: orderId,
          payment_report_id: null,
          movement_group_id: null,
        });

      if (changeMovementError) {
        throw new Error(changeMovementError?.message || 'Error registrando el cambio.');
      }
    }

    if (excessStoredInFundUsd > 0.005) {
      const clientId = Number(input.clientId || currentOrder.client_id || 0);
      if (!Number.isFinite(clientId) || clientId <= 0) {
        throw new Error('La orden no tiene un cliente válido para guardar el fondo.');
      }

      const nativeAmount = toNativeAmountFromUsd(
        excessStoredInFundUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { data: currentClient, error: currentClientError } = await supabase
        .from('clients')
        .select('id, fund_balance_usd')
        .eq('id', clientId)
        .single();

      if (currentClientError || !currentClient) {
        throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
      }

      const { error: updateClientFundError } = await supabase
        .from('clients')
        .update({
          fund_balance_usd: Number((toSafeNumber(currentClient.fund_balance_usd, 0) + excessStoredInFundUsd).toFixed(2)),
        })
        .eq('id', clientId);

      if (updateClientFundError) {
        throw new Error(updateClientFundError.message);
      }

      const { error: fundMovementError } = await supabase
        .from('client_fund_movements')
        .insert({
          client_id: clientId,
          movement_type: 'credit',
          currency_code: input.confirmedCurrency,
          amount: nativeAmount,
          amount_usd: excessStoredInFundUsd,
          money_account_id: input.confirmedMoneyAccountId,
          order_id: orderId,
          payment_report_id: input.reportId,
          reason_code: isRetentionPayment ? 'retention_overage_stored' : 'payment_overage_stored',
          notes,
          created_by_user_id: user.id,
        });

      if (fundMovementError) {
        throw new Error(fundMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'close_difference') {
      if (!getMasterDashboardPermissions(roles).isAdmin) {
        throw new Error('Solo admin puede cerrar excedentes por redondeo.');
      }

      if (excessUsd > ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD) {
        throw new Error(
          `Solo se pueden cerrar diferencias de hasta ${ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD.toFixed(2)} USD.`
        );
      }

      const extraFields =
        currentOrder.extra_fields &&
        typeof currentOrder.extra_fields === 'object' &&
        !Array.isArray(currentOrder.extra_fields)
          ? ({ ...currentOrder.extra_fields } as Record<string, any>)
          : {};

      const pricing =
        extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
          ? { ...extraFields.pricing }
          : {};

      const payment =
        extraFields.payment && typeof extraFields.payment === 'object' && !Array.isArray(extraFields.payment)
          ? { ...extraFields.payment }
          : {};

      const fxRate = toSafeNumber(pricing.fx_rate, 0);
      const nextTotalUsd = Number(confirmedPaidUsd.toFixed(2));
      const nextTotalBs =
        fxRate > 0
          ? Number((nextTotalUsd * fxRate).toFixed(2))
          : currentTotalUsd > 0
            ? Number(((currentTotalBs / currentTotalUsd) * nextTotalUsd).toFixed(2))
            : currentTotalBs;

      pricing.total_usd = nextTotalUsd;
      pricing.total_bs = nextTotalBs;
      pricing.rounding_gain_closed_usd = excessUsd;
      pricing.rounding_gain_close_applied_at = new Date().toISOString();
      pricing.rounding_gain_close_applied_by = user.id;

      payment.rounding_gain_close = {
        closed_balance_usd: excessUsd,
        previous_total_usd: Number(currentTotalUsd.toFixed(2)),
        next_total_usd: nextTotalUsd,
        applied_at: new Date().toISOString(),
        applied_by: user.id,
        notes,
      };

      extraFields.pricing = pricing;
      extraFields.payment = payment;

      const { error: updateOrderError } = await supabase
        .from('orders')
        .update({
          total_usd: nextTotalUsd,
          total_bs_snapshot: nextTotalBs,
          extra_fields: extraFields,
          last_modified_at: new Date().toISOString(),
          last_modified_by: user.id,
        })
        .eq('id', orderId);

      if (updateOrderError) {
        throw new Error(updateOrderError.message);
      }

      const { error: adjustmentError } = await supabase
        .from('order_admin_adjustments')
        .insert({
          order_id: orderId,
          order_item_id: null,
          adjustment_type: 'other',
          reason: 'Cierre de excedente por redondeo',
          notes,
          payload: {
            kind: 'rounding_gain_close',
            delta_usd: excessUsd,
            original_unit_price_usd: Number(currentTotalUsd.toFixed(2)),
            override_unit_price_usd: nextTotalUsd,
            product_name: 'Cierre por redondeo',
            qty: 1,
            closed_balance_usd: excessUsd,
            previous_total_usd: Number(currentTotalUsd.toFixed(2)),
            previous_total_bs: Number(currentTotalBs.toFixed(2)),
            confirmed_paid_usd: Number(confirmedPaidUsd.toFixed(2)),
            next_total_usd: nextTotalUsd,
            next_total_bs: nextTotalBs,
            payment_report_id: input.reportId,
          },
          created_by_user_id: user.id,
        });

      if (adjustmentError) {
        throw new Error(adjustmentError.message);
      }
    }

    await appendOrderEvent(supabase, {
      orderId,
      context: eventContext,
      eventType: 'payment_confirmed',
      eventGroup: 'payment',
      title: 'Pago confirmado',
      message: 'El pago reportado fue confirmado.',
      severity: 'info',
      actorUserId: user.id,
      payload: {
        report_id: input.reportId,
        confirmed_money_account_id: input.confirmedMoneyAccountId,
        confirmed_currency: input.confirmedCurrency,
        confirmed_amount: input.confirmedAmount,
        movement_date: effectiveMovementDate,
        exchange_rate_ves_per_usd: input.confirmedExchangeRateVesPerUsd,
      },
      recipients: [
        { targetRole: 'master' },
        { targetUserId: eventContext?.advisorUserId },
      ],
    });
  }

  revalidatePath('/app/master/dashboard');
}

export async function applyStaffPayrollPaymentAction(input: {
  orderId: number;
  moneyAccountId: number;
  amountUsd?: number | string | null;
  operationDate?: string | null;
  notes?: string | null;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const orderId = Number(input.orderId || 0);
  const moneyAccountId = Number(input.moneyAccountId || 0);
  const requestedAmountUsd =
    input.amountUsd == null || String(input.amountUsd).trim() === ''
      ? null
      : roundMoney(Number(String(input.amountUsd).replace(',', '.')));
  const operationDate =
    normalizeDateOnly(input.operationDate) || getCaracasDateString(new Date());
  const notes = String(input.notes || '').trim() || null;

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Debes seleccionar la cuenta interna de personal.');
  }

  const { data: account, error: accountError } = await supabase
    .from('money_accounts')
    .select('id, name, currency_code, is_active')
    .eq('id', moneyAccountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message || 'No se pudo cargar la cuenta interna.');
  }

  if (!account.is_active) {
    throw new Error('La cuenta interna seleccionada esta inactiva.');
  }

  const currencyCode = String(account.currency_code || '').trim().toUpperCase();
  if (currencyCode !== 'USD' && currencyCode !== 'VES') {
    throw new Error('La moneda de la cuenta interna no es valida.');
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select(`
      id,
      order_number,
      client_id,
      status,
      total_usd,
      total_bs_snapshot,
      extra_fields,
      client:clients!orders_client_id_fkey(full_name)
    `)
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  const activeRate = currencyCode === 'VES' ? await loadActiveExchangeRate(supabase) : null;
  const financialState = await loadOrderFinancialState(supabase, {
    orderId,
    operationDate,
    activeBsRate: activeRate,
  });

  let pendingUsd = financialState ? roundMoney(financialState.pending_usd) : 0;

  if (!financialState) {
    const { data: orderMovements, error: orderMovementsError } = await supabase
      .from('money_movements')
      .select('direction, amount_usd_equivalent')
      .eq('order_id', orderId)
      .eq('status', 'confirmed');

    if (orderMovementsError) throw new Error(orderMovementsError.message);

    const confirmedPaidUsd = roundMoney((orderMovements ?? []).reduce((sum, row) => {
      const signedAmount =
        toSafeNumber((row as { amount_usd_equivalent?: unknown }).amount_usd_equivalent, 0) *
        (((row as { direction?: string | null }).direction ?? 'inflow') === 'outflow' ? -1 : 1);
      return sum + signedAmount;
    }, 0));

    pendingUsd = roundMoney(Math.max(0, getEffectiveOrderTotalUsd(order) - confirmedPaidUsd));
  }

  if (pendingUsd <= 0.005) {
    throw new Error('Esta orden ya no tiene saldo pendiente.');
  }

  if (requestedAmountUsd != null && (!Number.isFinite(requestedAmountUsd) || requestedAmountUsd <= 0.005)) {
    throw new Error('El monto por nomina debe ser mayor a cero.');
  }

  const paymentUsd = roundMoney(requestedAmountUsd ?? pendingUsd);

  if (paymentUsd - pendingUsd > 0.005) {
    throw new Error('El monto por nomina no puede superar el saldo pendiente de la orden.');
  }

  const statePendingBs = financialState ? roundMoney(financialState.pending_bs) : 0;
  const exchangeRate =
    currencyCode === 'VES'
      ? Number(
          (
            statePendingBs > 0.005 && pendingUsd > 0.005
              ? statePendingBs / pendingUsd
              : activeRate || 0
          ).toFixed(6)
        )
      : null;

  if (currencyCode === 'VES' && (!exchangeRate || exchangeRate <= 0)) {
    throw new Error('No se pudo determinar una tasa valida para aplicar el pago por nomina.');
  }

  const paysFullBalance = Math.abs(paymentUsd - pendingUsd) <= 0.005;
  const nativeAmount =
    currencyCode === 'VES'
      ? Number(
          (
            paysFullBalance && statePendingBs > 0.005
              ? statePendingBs
              : paymentUsd * Number(exchangeRate || 0)
          ).toFixed(2)
        )
      : paymentUsd;

  if (!Number.isFinite(nativeAmount) || nativeAmount <= 0) {
    throw new Error('No se pudo determinar el monto a pagar por nomina.');
  }

  const clientRow = Array.isArray((order as any).client)
    ? ((order as any).client[0] ?? null)
    : ((order as any).client ?? null);
  const clientName = String(clientRow?.full_name || '').trim() || 'Personal';
  const orderLabel = String((order as any).order_number || `Orden ${orderId}`);
  const referenceCode = `NOM-${orderId}-${Date.now().toString(36).toUpperCase()}`;
  const reportNotes = [
    'Pago interno por descuento de personal.',
    `Cuenta puente: ${account.name}.`,
    notes,
  ].filter(Boolean).join('\n');

  const { data: reportRow, error: reportError } = await supabase
    .from('payment_reports')
    .insert({
      order_id: orderId,
      status: 'pending',
      created_by_user_id: user.id,
      reported_currency_code: currencyCode,
      reported_amount: nativeAmount,
      reported_exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
      reported_amount_usd_equivalent: paymentUsd,
      reported_money_account_id: moneyAccountId,
      reference_code: referenceCode,
      payer_name: clientName,
      notes: reportNotes,
      operation_date: operationDate,
    })
    .select('id')
    .single();

  if (reportError || !reportRow) {
    throw new Error(reportError?.message || 'No se pudo crear el pago interno.');
  }

  const reportId = Number(reportRow.id);
  if (!Number.isFinite(reportId) || reportId <= 0) {
    throw new Error('No se pudo identificar el pago interno creado.');
  }

  await confirmPaymentReportAction({
    reportId,
    orderId,
    clientId: (order as any).client_id == null ? null : Number((order as any).client_id),
    confirmedMoneyAccountId: moneyAccountId,
    confirmedCurrency: currencyCode,
    confirmedAmount: nativeAmount,
    movementDate: operationDate,
    confirmedExchangeRateVesPerUsd: currencyCode === 'VES' ? exchangeRate : null,
    reviewNotes: notes || 'Pago aplicado por descuento de personal.',
    referenceCode,
    counterpartyName: clientName,
    description: `Pago por nomina - ${orderLabel}`,
    overpaymentHandling: null,
    overpaymentNotes: null,
  });

  const movementGroupId = crypto.randomUUID();
  const { error: movementGroupError } = await supabase
    .from('money_movements')
    .update({ movement_group_id: movementGroupId })
    .eq('payment_report_id', reportId)
    .eq('direction', 'inflow');

  if (movementGroupError) {
    console.warn('staff payroll payment group update skipped', movementGroupError.message);
  }

  const { error: offsetError } = await supabase
    .from('money_movements')
    .insert({
      movement_date: operationDate,
      created_by_user_id: user.id,
      confirmed_at: new Date().toISOString(),
      confirmed_by_user_id: user.id,
      status: 'confirmed',
      approval_required: false,
      approval_required_reason: null,
      direction: 'outflow',
      movement_type: 'adjustment',
      money_account_id: moneyAccountId,
      currency_code: currencyCode,
      amount: nativeAmount,
      exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
      amount_usd_equivalent: paymentUsd,
      reference_code: referenceCode,
      counterparty_name: clientName,
      description: `Compensacion nomina - ${orderLabel}`,
      notes: [
        'Salida espejo para que la cuenta interna de personal quede en cero.',
        `Pago interno reporte #${reportId}.`,
        notes,
      ].filter(Boolean).join('\n'),
      order_id: null,
      payment_report_id: null,
      movement_group_id: movementGroupId,
    });

  if (offsetError) {
    throw new Error(offsetError.message);
  }

  const eventContext = await loadOrderEventContext(supabase, orderId);
  await appendOrderEvent(supabase, {
    orderId,
    context: eventContext,
    eventType: 'staff_payroll_payment',
    eventGroup: 'payment',
    title: 'Pago por nomina aplicado',
    message: paysFullBalance
      ? 'La orden fue saldada con descuento de personal y compensada en la cuenta interna.'
      : 'Se aplico un abono por descuento de personal y se compenso en la cuenta interna.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      report_id: reportId,
      money_account_id: moneyAccountId,
      money_account_name: account.name,
      currency: currencyCode,
      amount: nativeAmount,
      amount_usd: paymentUsd,
      pending_usd_before_payment: pendingUsd,
      movement_date: operationDate,
      reference_code: referenceCode,
      movement_group_id: movementGroupId,
      payroll_offset_for_order_id: orderId,
    },
    recipients: [
      { targetRole: 'master' },
      { targetRole: 'admin' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });

  revalidateMasterDashboardFinancialReferences();
}

export async function applyClientFundPaymentAction(input: {
  orderId: number;
  amountUsd: number;
  notes?: string | null;
}) {
  const { user } = await requireMasterOrAdmin();
  const supabase = createSupabaseServiceRoleServer();

  const orderId = Number(input.orderId || 0);
  const requestedAmountUsd = roundMoney(input.amountUsd);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  if (!Number.isFinite(requestedAmountUsd) || requestedAmountUsd <= 0) {
    throw new Error('El monto del fondo no es válido.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, client_id, total_usd, extra_fields')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  const clientId = Number(currentOrder.client_id || 0);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error('La orden no tiene cliente asociado.');
  }

  const previousFundUsedUsd = roundMoney((currentOrder.extra_fields as any)?.payment?.client_fund_used_usd);
  const financialState = await loadOrderFinancialState(supabase, { orderId });
  let pendingUsd = financialState ? roundMoney(financialState.pending_usd) : 0;

  if (!financialState) {
    const totalUsd = getEffectiveOrderTotalUsd(currentOrder);
    const { data: orderMovements, error: orderMovementsError } = await supabase
      .from('money_movements')
      .select('direction, amount_usd_equivalent')
      .eq('order_id', orderId)
      .eq('status', 'confirmed');

    if (orderMovementsError) {
      throw new Error(orderMovementsError.message);
    }

    const confirmedPaidUsd = roundMoney((orderMovements ?? []).reduce((sum, row) => {
      const signedAmount =
        toSafeNumber(
          (row as { amount_usd_equivalent?: number | string | null }).amount_usd_equivalent,
          0
        ) * (((row as { direction?: string | null }).direction ?? 'inflow') === 'outflow' ? -1 : 1);
      return sum + signedAmount;
    }, 0));

    pendingUsd = roundMoney(Math.max(0, totalUsd - confirmedPaidUsd - previousFundUsedUsd));
  }

  if (pendingUsd <= 0.005) {
    throw new Error('Esta orden ya no tiene saldo pendiente.');
  }

  const applicableAmountUsd = roundMoney(Math.min(requestedAmountUsd, pendingUsd));

  if (applicableAmountUsd <= 0.005) {
    throw new Error('El monto del fondo no es aplicable a esta orden.');
  }

  await applyClientFundToOrder(supabase, {
    clientId,
    orderId,
    amountUsd: applicableAmountUsd,
    userId: user.id,
    notes: input.notes ?? 'Fondo aplicado desde pagos',
  });

  try {
    const nextExtraFields = {
      ...(currentOrder.extra_fields && typeof currentOrder.extra_fields === 'object'
        ? (currentOrder.extra_fields as Record<string, unknown>)
        : {}),
      payment: {
        ...(((currentOrder.extra_fields as any)?.payment ?? {}) as Record<string, unknown>),
        client_fund_used_usd: roundMoney(previousFundUsedUsd + applicableAmountUsd),
      },
    };

    const { error: updateOrderError } = await supabase
      .from('orders')
      .update({
        extra_fields: nextExtraFields,
      })
      .eq('id', orderId);

    if (updateOrderError) {
      throw new Error(updateOrderError.message);
    }
  } catch (error) {
    await restoreClientFundToOrder(supabase, {
      clientId,
      orderId,
      amountUsd: applicableAmountUsd,
      userId: user.id,
      notes: 'Reverso por error aplicando fondo a la orden',
    });
    throw error;
  }

  revalidatePath('/app/master/dashboard');
}

export async function deliverClientFundChangeAction(input: {
  orderId: number;
  moneyAccountId: number;
  currencyCode: string;
  amount: number;
  exchangeRateVesPerUsd?: number | null;
  notes?: string | null;
}) {
  try {
    const { supabase, user } = await requireMasterOrAdmin();

    const orderId = Number(input.orderId || 0);
    const moneyAccountId = Number(input.moneyAccountId || 0);
    const nativeAmount = Number(toSafeNumber(input.amount, 0).toFixed(2));
    const currencyCode = String(input.currencyCode || '').trim().toUpperCase();
    const exchangeRate =
      input.exchangeRateVesPerUsd == null ? null : Number(toSafeNumber(input.exchangeRateVesPerUsd, 0).toFixed(6));

    if (!Number.isFinite(orderId) || orderId <= 0) throw new Error('Orden inválida.');
    if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) throw new Error('Cuenta inválida.');
    if (!currencyCode) throw new Error('Moneda inválida.');
    if (!Number.isFinite(nativeAmount) || nativeAmount <= 0) throw new Error('Monto inválido.');
    if (currencyCode === 'VES' && (!exchangeRate || exchangeRate <= 0)) {
      throw new Error('Debes indicar una tasa válida para el cambio en Bs.');
    }

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
    }

    const clientId = Number(currentOrder.client_id || 0);
    if (!Number.isFinite(clientId) || clientId <= 0) {
      throw new Error('La orden no tiene cliente asociado.');
    }

    const { data: currentClient, error: currentClientError } = await supabase
      .from('clients')
      .select('id, fund_balance_usd')
      .eq('id', clientId)
      .single();

    if (currentClientError || !currentClient) {
      throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
    }

    const amountUsd = Number(
      (currencyCode === 'VES' ? nativeAmount / Number(exchangeRate) : nativeAmount).toFixed(2)
    );
    const currentBalanceUsd = Number(toSafeNumber(currentClient.fund_balance_usd, 0).toFixed(2));
    const availableFundUsd = Math.max(0, currentBalanceUsd);
    const fundCoveredUsd = roundMoney(Math.min(availableFundUsd, amountUsd));
    const fundCoveredAmount =
      currencyCode === 'VES' ? roundMoney(fundCoveredUsd * Number(exchangeRate || 0)) : fundCoveredUsd;

    const { error: updateClientError } = await supabase
      .from('clients')
      .update({
        fund_balance_usd: roundMoney(currentBalanceUsd - fundCoveredUsd),
      })
      .eq('id', clientId);

    if (updateClientError) {
      throw new Error(updateClientError.message);
    }

    try {
      if (fundCoveredUsd > 0.005) {
        const { error: fundMovementError } = await supabase
          .from('client_fund_movements')
          .insert({
            client_id: clientId,
            movement_type: 'debit',
            currency_code: currencyCode,
            amount: fundCoveredAmount,
            amount_usd: fundCoveredUsd,
            money_account_id: moneyAccountId,
            order_id: orderId,
            payment_report_id: null,
            reason_code: 'change_given_from_fund',
            notes: String(input.notes || '').trim() || null,
            created_by_user_id: user.id,
          });

        if (fundMovementError) {
          throw new Error(fundMovementError.message);
        }
      }

      const { error: moneyMovementError } = await supabase
        .from('money_movements')
        .insert({
          movement_date: new Date().toISOString().slice(0, 10),
          created_by_user_id: user.id,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: user.id,
          direction: 'outflow',
          movement_type: 'change_given',
          money_account_id: moneyAccountId,
          currency_code: currencyCode,
          amount: nativeAmount,
          exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
          amount_usd_equivalent: amountUsd,
          reference_code: null,
          counterparty_name: null,
          description: `Cambio entregado desde fondo · orden ${orderId}`,
          notes: String(input.notes || '').trim() || null,
          order_id: orderId,
          payment_report_id: null,
          movement_group_id: null,
        });

      if (moneyMovementError) {
        throw new Error(moneyMovementError.message);
      }
    } catch (error) {
      await supabase
        .from('clients')
        .update({
          fund_balance_usd: currentBalanceUsd,
        })
        .eq('id', clientId);
      throw error;
    }

    revalidatePath('/app/master/dashboard');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error entregando el cambio.',
    };
  }
}

export async function settleClientFundPayoutAction(input: {
  orderId: number;
  lines: Array<{
    moneyAccountId: number;
    currencyCode: string;
    amount: number;
    exchangeRateVesPerUsd?: number | null;
    notes?: string | null;
  }>;
  notes?: string | null;
}) {
  try {
    const { supabase, user } = await requireMasterOrAdmin();

    const orderId = Number(input.orderId || 0);
    if (!Number.isFinite(orderId) || orderId <= 0) throw new Error('Orden invalida.');

    const cleanLines = (Array.isArray(input.lines) ? input.lines : [])
      .map((line) => {
        const moneyAccountId = Number(line.moneyAccountId || 0);
        const currencyCode = String(line.currencyCode || '').trim().toUpperCase();
        const amount = Number(toSafeNumber(line.amount, 0).toFixed(2));
        const exchangeRate =
          line.exchangeRateVesPerUsd == null
            ? null
            : Number(toSafeNumber(line.exchangeRateVesPerUsd, 0).toFixed(6));
        const amountUsd = Number(
          (currencyCode === 'VES' ? amount / Number(exchangeRate || 0) : amount).toFixed(2)
        );

        return {
          moneyAccountId,
          currencyCode,
          amount,
          exchangeRate,
          amountUsd,
          notes: String(line.notes || input.notes || '').trim() || null,
        };
      })
      .filter((line) => line.moneyAccountId > 0 && line.currencyCode && line.amount > 0);

    if (cleanLines.length === 0) {
      throw new Error('Debes agregar al menos una linea de devolucion.');
    }

    for (const line of cleanLines) {
      if (line.currencyCode === 'VES' && (!line.exchangeRate || line.exchangeRate <= 0)) {
        throw new Error('Debes indicar una tasa valida para cada devolucion en Bs.');
      }

      if (!Number.isFinite(line.amountUsd) || line.amountUsd <= 0) {
        throw new Error('Una linea de devolucion tiene monto invalido.');
      }
    }

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
    }

    const clientId = Number(currentOrder.client_id || 0);
    if (!Number.isFinite(clientId) || clientId <= 0) {
      throw new Error('La orden no tiene cliente asociado.');
    }

    const { data: currentClient, error: currentClientError } = await supabase
      .from('clients')
      .select('id, fund_balance_usd')
      .eq('id', clientId)
      .single();

    if (currentClientError || !currentClient) {
      throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
    }

    const currentBalanceUsd = roundMoney(currentClient.fund_balance_usd);
    const totalAmountUsd = roundMoney(cleanLines.reduce((sum, line) => sum + line.amountUsd, 0));
    const availableFundUsd = Math.max(0, currentBalanceUsd);
    const fundCoveredTotalUsd = roundMoney(Math.min(availableFundUsd, totalAmountUsd));

    const groupId = crypto.randomUUID();
    const now = new Date().toISOString();
    const movementDate = now.slice(0, 10);
    const sharedNotes = String(input.notes || '').trim() || null;

    const { error: updateClientError } = await supabase
      .from('clients')
      .update({
        fund_balance_usd: roundMoney(currentBalanceUsd - fundCoveredTotalUsd),
      })
      .eq('id', clientId);

    if (updateClientError) throw new Error(updateClientError.message);

    let insertedMoneyMovementIds: number[] = [];
    try {
      const moneyRows = cleanLines.map((line, index) => ({
        movement_date: movementDate,
        created_by_user_id: user.id,
        confirmed_at: now,
        confirmed_by_user_id: user.id,
        status: 'confirmed',
        direction: 'outflow',
        movement_type: 'withdrawal',
        money_account_id: line.moneyAccountId,
        currency_code: line.currencyCode,
        amount: line.amount,
        exchange_rate_ves_per_usd: line.currencyCode === 'VES' ? line.exchangeRate : null,
        amount_usd_equivalent: line.amountUsd,
        reference_code: null,
        counterparty_name: null,
        description: `Devolucion de fondo cliente - linea ${index + 1} - orden ${orderId}`,
        notes: line.notes ?? sharedNotes,
        order_id: null,
        payment_report_id: null,
        movement_group_id: groupId,
      }));

      const { data: insertedMoneyMovements, error: moneyMovementError } = await supabase
        .from('money_movements')
        .insert(moneyRows)
        .select('id');

      if (moneyMovementError) throw new Error(moneyMovementError.message);
      insertedMoneyMovementIds = (insertedMoneyMovements ?? [])
        .map((movement) => Number(movement.id || 0))
        .filter((id) => id > 0);

      let remainingFundUsd = fundCoveredTotalUsd;
      const fundRows = cleanLines.flatMap((line) => {
        const lineFundUsd = roundMoney(Math.min(remainingFundUsd, line.amountUsd));
        remainingFundUsd = roundMoney(Math.max(0, remainingFundUsd - line.amountUsd));
        if (lineFundUsd <= 0.005) return [];

        return [
          {
            client_id: clientId,
            movement_type: 'debit',
            currency_code: line.currencyCode,
            amount:
              line.currencyCode === 'VES'
                ? roundMoney(lineFundUsd * Number(line.exchangeRate || 0))
                : lineFundUsd,
            amount_usd: lineFundUsd,
            money_account_id: line.moneyAccountId,
            order_id: orderId,
            payment_report_id: null,
            reason_code: 'client_fund_payout',
            notes: line.notes,
            created_by_user_id: user.id,
          },
        ];
      });

      if (fundRows.length > 0) {
        const { error: fundMovementError } = await supabase
          .from('client_fund_movements')
          .insert(fundRows);

        if (fundMovementError) throw new Error(fundMovementError.message);
      }
    } catch (error) {
      await supabase
        .from('clients')
        .update({ fund_balance_usd: currentBalanceUsd })
        .eq('id', clientId);

      if (insertedMoneyMovementIds.length > 0) {
        await supabase
          .from('money_movements')
          .update({
            status: 'voided',
            reviewed_at: now,
            reviewed_by_user_id: user.id,
            voided_at: now,
            voided_by_user_id: user.id,
            void_reason: 'Anulacion automatica por fallo registrando ledger de fondo.',
          })
          .in('id', insertedMoneyMovementIds);
      }
      throw error;
    }

    revalidatePath('/app/master/dashboard');
    return { ok: true as const, groupId };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error devolviendo fondo del cliente.',
    };
  }
}

export async function rejectPaymentReportAction(input: {
  reportId: number;
  reviewNotes: string;
}) {
  const { supabase } = await requireMasterOrAdmin();
  const reviewNotes = String(input.reviewNotes || '').trim();

  if (!reviewNotes) {
    throw new Error('Debes indicar un motivo de rechazo.');
  }

  const { data: currentReport } = await supabase
    .from('payment_reports')
    .select('id, order_id')
    .eq('id', input.reportId)
    .maybeSingle();

  if (!currentReport) {
    throw new Error('No se encontró el reporte de pago.');
  }

  const orderId = Number(currentReport.order_id);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('El reporte no tiene una orden válida.');
  }

  const { error } = await supabase.rpc('reject_payment_report', {
    p_report_id: input.reportId,
    p_review_notes: reviewNotes,
  });

  if (error) throw new Error(error.message);

  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');
}

export async function approveOrderAction(input: {
  orderId: number;
}) {
  try {
    const { supabase, user } = await requireMasterOrAdmin();
    const eventContext = await loadOrderEventContext(supabase, input.orderId);

    const { error } = await supabase.rpc('approve_order', {
      p_order_id: input.orderId,
    });

    if (error) throw new Error(error.message);
    await appendOrderEvent(supabase, {
      orderId: input.orderId,
      context: eventContext,
      eventType: 'order_approved',
      eventGroup: 'approval',
      title: 'Orden aprobada',
      message: 'La orden fue aprobada y ya puede avanzar en operación.',
      severity: 'info',
      actorUserId: user.id,
      recipients: [
        { targetRole: 'master' },
        { targetUserId: eventContext?.advisorUserId },
      ],
    });
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error aprobando la orden.',
    };
  }
}

export async function reapproveQueuedOrderAction(input: {
  orderId: number;
  notes: string;
}) {
  try {
    const { supabase, user } = await requireMasterOrAdmin();
    const eventContext = await loadOrderEventContext(supabase, input.orderId);

    const { error } = await supabase.rpc('reapprove_queued_order', {
      p_order_id: input.orderId,
      p_notes: input.notes,
    });

    if (error) throw new Error(error.message);
    await appendOrderEvent(supabase, {
      orderId: input.orderId,
      context: eventContext,
      eventType: 'order_reapproved',
      eventGroup: 'approval',
      title: 'Orden re-aprobada',
      message: input.notes?.trim() ? `Notas de revisión: ${input.notes.trim()}` : 'La orden fue re-aprobada.',
      severity: 'info',
      actorUserId: user.id,
      payload: {
        review_notes: input.notes?.trim() || null,
      },
      recipients: [
        { targetRole: 'master' },
        { targetUserId: eventContext?.advisorUserId },
      ],
    });
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error re-aprobando la orden.',
    };
  }
}

export async function sendToKitchenAction(input: {
  orderId: number;
}) {
  try {
    const { supabase, user } = await requireMasterOrAdmin();
    const eventContext = await loadOrderEventContext(supabase, input.orderId);

    const { error } = await supabase.rpc('send_to_kitchen', {
      p_order_id: input.orderId,
    });

    if (error) throw new Error(error.message);
    await appendOrderEvent(supabase, {
      orderId: input.orderId,
      context: eventContext,
      eventType: 'order_sent_to_kitchen',
      eventGroup: 'kitchen',
      title: 'Enviada a cocina',
      message: 'Nueva orden en cola para tomar en cocina.',
      severity: 'critical',
      actorUserId: user.id,
      recipients: [
        { targetRole: 'kitchen', requiresAction: true },
        { targetRole: 'master' },
        { targetUserId: eventContext?.advisorUserId },
      ],
    });
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error enviando a cocina.',
    };
  }
}

export async function returnToCreatedAction(input: {
  orderId: number;
  reason: string;
  recalculatePricing?: boolean;
}) {
  const { user } = await requireMasterOrAdmin();
  const supabase = createSupabaseServiceRoleServer();

  const reason = input.reason?.trim();
  if (!reason) {
    throw new Error('Debes indicar un motivo.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, notes, extra_fields')
    .eq('id', input.orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (!['created', 'queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(currentOrder.status)) {
    throw new Error('Solo se puede devolver al asesor una orden activa.');
  }

  const nowIso = new Date().toISOString();
  const extraFields =
    currentOrder.extra_fields && typeof currentOrder.extra_fields === 'object' && !Array.isArray(currentOrder.extra_fields)
      ? { ...(currentOrder.extra_fields as Record<string, unknown>) }
      : {};
  const previousPricing =
    extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
      ? { ...(extraFields.pricing as Record<string, unknown>) }
      : {};
  const activeRate = input.recalculatePricing ? await loadActiveExchangeRate(supabase) : null;

  if (input.recalculatePricing) {
    extraFields.pricing = {
      ...previousPricing,
      recalculation_required: true,
      recalculation_requested_at: nowIso,
      recalculation_requested_by: user.id,
      recalculation_reason: reason,
      recalculation_fx_rate: activeRate,
      previous_fx_rate:
        toSafeNumber(previousPricing.fx_rate, 0) > 0
          ? toSafeNumber(previousPricing.fx_rate, 0)
          : null,
    };
    extraFields.ui = {
      ...(extraFields.ui && typeof extraFields.ui === 'object' && !Array.isArray(extraFields.ui)
        ? (extraFields.ui as Record<string, unknown>)
        : {}),
      recalculation_required: true,
    };
  }

  extraFields.review = {
    ...(extraFields.review && typeof extraFields.review === 'object' && !Array.isArray(extraFields.review)
      ? (extraFields.review as Record<string, unknown>)
      : {}),
    returned_to_advisor: true,
    returned_to_advisor_at: nowIso,
    returned_to_advisor_by: user.id,
    returned_to_advisor_reason: reason,
  };

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'created',
      queued_needs_reapproval: false,
      queued_last_modified_at: null,
      queued_last_modified_by: null,
      sent_to_kitchen_at: null,
      sent_to_kitchen_by: null,
      eta_minutes: null,
      kitchen_started_at: null,
      kitchen_operator_id: null,
      ready_at: null,
      internal_driver_user_id: null,
      external_partner_id: null,
      external_driver_name: null,
      external_driver_phone: null,
      external_reference: null,
      review_notes: reason,
      extra_fields: extraFields,
      last_modified_at: nowIso,
      last_modified_by: user.id,
    })
    .eq('id', input.orderId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'order_returned_to_review',
    eventGroup: 'approval',
    title: 'Pedido devuelto: corrección requerida',
    message: 'El pedido fue devuelto y requiere corrección.',
    severity: 'warning',
    actorUserId: user.id,
    payload: {
      reason,
      order_created_at: eventContext?.createdAt ?? null,
      previous_status: currentOrder.status,
      recalculation_required: Boolean(input.recalculatePricing),
      recalculation_fx_rate: activeRate,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId, requiresAction: true },
      ...(currentOrder.status === 'confirmed' || currentOrder.status === 'in_kitchen' || currentOrder.status === 'ready'
        ? [{ targetRole: 'kitchen' as const }]
        : []),
      ...(currentOrder.status === 'out_for_delivery'
        ? [{ targetUserId: eventContext?.internalDriverUserId }]
        : []),
    ],
  });

  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');
}

export async function cancelOrderAction(input: {
  orderId: number;
  reason: string;
  paidHandling?: 'store_fund' | 'refund' | null;
  refundLines?: Array<{
    moneyAccountId: number;
    currencyCode: string;
    amount: number;
    exchangeRateVesPerUsd?: number | null;
    notes?: string | null;
  }>;
  refundMoneyAccountId?: number | null;
  refundCurrency?: string | null;
  refundExchangeRateVesPerUsd?: number | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const orderId = Number(input.orderId);
  const reason = String(input.reason || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  if (!reason) {
    throw new Error('Debes indicar un motivo de cancelación.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, client_id, status, notes, extra_fields')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (currentOrder.status === 'cancelled') {
    throw new Error('La orden ya está cancelada.');
  }

  const clientId = Number(currentOrder.client_id || 0);
  const previousFundUsedUsd = roundMoney((currentOrder.extra_fields as any)?.payment?.client_fund_used_usd);
  const { data: orderMovements, error: orderMovementsError } = await supabase
    .from('money_movements')
    .select('direction, amount_usd_equivalent, status, confirmed_at')
    .eq('order_id', orderId);

  if (orderMovementsError) {
    throw new Error(orderMovementsError.message);
  }

  const confirmedPaidUsd = roundMoney((orderMovements ?? []).reduce((sum, row) => {
    const isConfirmed = row.status === 'confirmed' || Boolean(row.confirmed_at);
    if (!isConfirmed) return sum;

    const signedAmount =
      toSafeNumber(row.amount_usd_equivalent, 0) *
      (row.direction === 'outflow' ? -1 : 1);
    return sum + signedAmount;
  }, 0));

  const hasClientFundsToRestore = previousFundUsedUsd > 0.005;
  const hasConfirmedMoneyToSettle = confirmedPaidUsd > 0.005;
  const paidHandling = input.paidHandling ?? null;
  const cleanRefundLines =
    hasConfirmedMoneyToSettle && paidHandling === 'refund'
      ? (Array.isArray(input.refundLines) && input.refundLines.length > 0
          ? input.refundLines
          : [
              {
                moneyAccountId: Number(input.refundMoneyAccountId || 0),
                currencyCode: String(input.refundCurrency || '').trim().toUpperCase(),
                amount: toNativeAmountFromUsd(
                  confirmedPaidUsd,
                  String(input.refundCurrency || '').trim().toUpperCase(),
                  input.refundExchangeRateVesPerUsd ?? null
                ),
                exchangeRateVesPerUsd: input.refundExchangeRateVesPerUsd ?? null,
                notes: reason,
              },
            ]
        )
          .map((line) => {
            const moneyAccountId = Number(line.moneyAccountId || 0);
            const currencyCode = String(line.currencyCode || '').trim().toUpperCase();
            const amount = Number(toSafeNumber(line.amount, 0).toFixed(2));
            const exchangeRate =
              line.exchangeRateVesPerUsd == null
                ? null
                : Number(toSafeNumber(line.exchangeRateVesPerUsd, 0).toFixed(6));
            const amountUsd = Number(
              (currencyCode === 'VES' ? amount / Number(exchangeRate || 0) : amount).toFixed(2)
            );

            return {
              moneyAccountId,
              currencyCode,
              amount,
              exchangeRate,
              amountUsd,
              notes: String(line.notes || reason || '').trim() || null,
            };
          })
          .filter((line) => line.moneyAccountId > 0 && line.currencyCode && line.amount > 0)
      : [];
  const cleanRefundUsd = roundMoney(cleanRefundLines.reduce((sum, line) => sum + line.amountUsd, 0));
  const refundRemainderUsd = roundMoney(Math.max(0, confirmedPaidUsd - cleanRefundUsd));

  if ((hasClientFundsToRestore || hasConfirmedMoneyToSettle) && (!Number.isFinite(clientId) || clientId <= 0)) {
    throw new Error('La orden tiene dinero involucrado, pero no tiene cliente asociado para ajustar fondo/devoluciÃ³n.');
  }

  if (hasConfirmedMoneyToSettle && paidHandling !== 'store_fund' && paidHandling !== 'refund') {
    throw new Error('Debes indicar si el pago confirmado se enviarÃ¡ al fondo o se registrarÃ¡ como devoluciÃ³n.');
  }

  if (hasConfirmedMoneyToSettle && paidHandling === 'refund') {
    if (cleanRefundLines.length === 0) {
      throw new Error('Debes agregar al menos una linea de devolucion.');
    }

    for (const line of cleanRefundLines) {
      if (line.currencyCode === 'VES' && (!line.exchangeRate || line.exchangeRate <= 0)) {
        throw new Error('Debes indicar una tasa valida para cada devolucion en Bs.');
      }
      if (!Number.isFinite(line.amountUsd) || line.amountUsd <= 0) {
        throw new Error('Una linea de devolucion tiene monto invalido.');
      }
    }

    if (cleanRefundUsd > confirmedPaidUsd + 0.01) {
      throw new Error('La devolucion no puede superar el pago confirmado.');
    }
  }

  if (false && hasConfirmedMoneyToSettle && paidHandling === 'refund') {
    const refundMoneyAccountId = Number(input.refundMoneyAccountId || 0);
    const refundCurrency = String(input.refundCurrency || '').trim().toUpperCase();
    if (!Number.isFinite(refundMoneyAccountId) || refundMoneyAccountId <= 0) {
      throw new Error('Debes seleccionar la cuenta desde la cual se harÃ¡ la devoluciÃ³n.');
    }
    if (!refundCurrency) {
      throw new Error('Debes indicar la moneda de la devoluciÃ³n.');
    }
    if (refundCurrency === 'VES' && toSafeNumber(input.refundExchangeRateVesPerUsd, 0) <= 0) {
      throw new Error('Debes indicar una tasa vÃ¡lida para la devoluciÃ³n en bolÃ­vares.');
    }
  }

  if (hasClientFundsToRestore) {
    await restoreClientFundToOrder(supabase, {
      clientId,
      orderId,
      amountUsd: previousFundUsedUsd,
      userId: user.id,
      notes: `Fondo restaurado por cancelaciÃ³n: ${reason}`,
    });
  }

  if (hasConfirmedMoneyToSettle && paidHandling === 'store_fund') {
    await restoreClientFundToOrder(supabase, {
      clientId,
      orderId,
      amountUsd: confirmedPaidUsd,
      userId: user.id,
      notes: `Pago enviado a fondo por cancelaciÃ³n: ${reason}`,
    });
  }

  if (false && hasConfirmedMoneyToSettle && paidHandling === 'refund') {
    const refundCurrency = String(input.refundCurrency || '').trim().toUpperCase();
    const refundExchangeRate =
      refundCurrency === 'VES'
        ? Number(toSafeNumber(input.refundExchangeRateVesPerUsd, 0).toFixed(6))
        : null;
    const refundAmount = toNativeAmountFromUsd(confirmedPaidUsd, refundCurrency, refundExchangeRate);

    const { error: refundMovementError } = await supabase
      .from('money_movements')
      .insert({
        movement_date: new Date().toISOString().slice(0, 10),
        created_by_user_id: user.id,
        confirmed_at: new Date().toISOString(),
        confirmed_by_user_id: user.id,
        status: 'confirmed',
        approval_required: false,
        direction: 'outflow',
        movement_type: 'withdrawal',
        money_account_id: Number(input.refundMoneyAccountId),
        currency_code: refundCurrency,
        amount: refundAmount,
        exchange_rate_ves_per_usd: refundExchangeRate,
        amount_usd_equivalent: confirmedPaidUsd,
        reference_code: null,
        counterparty_name: null,
        description: `DevoluciÃ³n por orden cancelada #${orderId}`,
        notes: reason,
        order_id: orderId,
        payment_report_id: null,
        movement_group_id: null,
      });

    if (refundMovementError) {
      throw new Error(refundMovementError?.message || 'Error registrando la devolucion.');
    }
  }

  if (hasConfirmedMoneyToSettle && paidHandling === 'refund') {
    const movementGroupId = cleanRefundLines.length > 1 || refundRemainderUsd > 0.005 ? crypto.randomUUID() : null;
    const now = new Date().toISOString();

    const { error: refundMovementError } = await supabase
      .from('money_movements')
      .insert(cleanRefundLines.map((line, index) => ({
        movement_date: now.slice(0, 10),
        created_by_user_id: user.id,
        confirmed_at: now,
        confirmed_by_user_id: user.id,
        status: 'confirmed',
        approval_required: false,
        direction: 'outflow',
        movement_type: 'withdrawal',
        money_account_id: line.moneyAccountId,
        currency_code: line.currencyCode,
        amount: line.amount,
        exchange_rate_ves_per_usd: line.currencyCode === 'VES' ? line.exchangeRate : null,
        amount_usd_equivalent: line.amountUsd,
        reference_code: null,
        counterparty_name: null,
        description: `Devolucion por orden cancelada #${orderId} - linea ${index + 1}`,
        notes: line.notes,
        order_id: orderId,
        payment_report_id: null,
        movement_group_id: movementGroupId,
      })));

    if (refundMovementError) {
      throw new Error(refundMovementError?.message || 'Error registrando la devolucion.');
    }

    if (refundRemainderUsd > 0.005) {
      await restoreClientFundToOrder(supabase, {
        clientId,
        orderId,
        amountUsd: refundRemainderUsd,
        userId: user.id,
        notes: `Resto de devolucion enviado a fondo por cancelacion: ${reason}`,
      });
    }
  }

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'cancelled',
      review_notes: reason,
      queued_needs_reapproval: false,
      queued_last_modified_at: null,
      queued_last_modified_by: null,
      last_modified_at: new Date().toISOString(),
      last_modified_by: user.id,
    })
    .eq('id', orderId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  const eventContext = await loadOrderEventContext(supabase, orderId);
  await appendOrderEvent(supabase, {
    orderId,
    context: eventContext,
    eventType: 'order_cancelled',
    eventGroup: 'approval',
    title: 'Orden cancelada',
    message: reason,
    severity: 'critical',
    actorUserId: user.id,
    payload: {
      reason,
      paid_handling: paidHandling,
      confirmed_paid_usd: confirmedPaidUsd,
      restored_fund_usd: previousFundUsedUsd,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
      { targetUserId: eventContext?.internalDriverUserId },
      { targetRole: 'kitchen' },
    ],
  });

  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');
}

export async function assignInternalDriverAction(input: {
  orderId: number;
  driverUserId: string;
  costUsd?: number | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('assign_internal_driver', {
    p_order_id: input.orderId,
    p_driver_user_id: input.driverUserId,
  });

  if (error) throw new Error(error.message);

  const { data: orderRow, error: orderFetchError } = await supabase
    .from('orders')
    .select('extra_fields')
    .eq('id', input.orderId)
    .single();

  if (orderFetchError) throw new Error(orderFetchError.message);

  const extraFields =
    orderRow?.extra_fields && typeof orderRow.extra_fields === 'object' && !Array.isArray(orderRow.extra_fields)
      ? (orderRow.extra_fields as Record<string, unknown>)
      : {};
  const currentDelivery =
    extraFields.delivery && typeof extraFields.delivery === 'object' && !Array.isArray(extraFields.delivery)
      ? (extraFields.delivery as Record<string, unknown>)
      : {};

  const { error: snapshotError } = await supabase
    .from('orders')
    .update({
      extra_fields: {
        ...extraFields,
        delivery: {
          ...currentDelivery,
          cost_usd: input.costUsd != null ? Math.max(0, Number(input.costUsd || 0)) : currentDelivery.cost_usd ?? null,
          cost_source: 'internal_product',
        },
      },
    })
    .eq('id', input.orderId);

  if (snapshotError) throw new Error(snapshotError.message);
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'driver_assigned',
    eventGroup: 'delivery',
    title: 'Driver asignado',
    message: 'Se asignó un driver interno a la orden.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      driver_user_id: input.driverUserId,
      cost_usd: input.costUsd ?? null,
      assignment_kind: 'internal',
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
      { targetUserId: input.driverUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function assignExternalPartnerAction(input: {
  orderId: number;
  partnerId: number;
  reference: string | null;
  distanceKm?: number | null;
  costUsd?: number | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('assign_external_partner', {
    p_order_id: input.orderId,
    p_partner_id: input.partnerId,
    p_reference: input.reference,
  });

  if (error) throw new Error(error.message);
  const { data: orderRow, error: orderFetchError } = await supabase
    .from('orders')
    .select('extra_fields')
    .eq('id', input.orderId)
    .single();

  if (orderFetchError) throw new Error(orderFetchError.message);

  const extraFields =
    orderRow?.extra_fields && typeof orderRow.extra_fields === 'object' && !Array.isArray(orderRow.extra_fields)
      ? (orderRow.extra_fields as Record<string, unknown>)
      : {};
  const currentDelivery =
    extraFields.delivery && typeof extraFields.delivery === 'object' && !Array.isArray(extraFields.delivery)
      ? (extraFields.delivery as Record<string, unknown>)
      : {};

  const { error: snapshotError } = await supabase
    .from('orders')
    .update({
      extra_fields: {
        ...extraFields,
        delivery: {
          ...currentDelivery,
          distance_km:
            input.distanceKm != null ? Math.max(0, Number(input.distanceKm || 0)) : currentDelivery.distance_km ?? null,
          cost_usd: input.costUsd != null ? Math.max(0, Number(input.costUsd || 0)) : currentDelivery.cost_usd ?? null,
          cost_source: 'external_partner_manual',
        },
      },
    })
    .eq('id', input.orderId);

  if (snapshotError) throw new Error(snapshotError.message);
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'driver_assigned',
    eventGroup: 'delivery',
    title: 'Partner externo asignado',
    message: 'Se asignó un partner externo a la orden.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      partner_id: input.partnerId,
      reference: input.reference,
      distance_km: input.distanceKm ?? null,
      cost_usd: input.costUsd ?? null,
      assignment_kind: 'external',
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function correctDeliveredDeliveryAssignmentAction(input: {
  orderId: number;
  assignmentKind: 'internal' | 'external';
  driverUserId?: string | null;
  partnerId?: number | null;
  reference?: string | null;
  distanceKm?: number | null;
  costUsd?: number | null;
  notes: string;
}) {
  try {
    const { user, roles } = await requireMasterOrAdmin();
    requireAdminRole(roles);

    const supabase = createSupabaseServiceRoleServer();
    const orderId = Number(input.orderId || 0);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return { ok: false as const, message: 'Orden invalida.' };
    }

    const notes = String(input.notes || '').trim();
    if (notes.length < 6) {
      return { ok: false as const, message: 'Indica un motivo claro para la correccion.' };
    }

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select(
        'id, status, fulfillment, delivery_mode, extra_fields, internal_driver_user_id, external_partner_id, external_driver_name, external_driver_phone, external_reference'
      )
      .eq('id', orderId)
      .single();

    if (currentOrderError) throw new Error(currentOrderError.message);
    if (!currentOrder) {
      return { ok: false as const, message: 'No se pudo cargar la orden.' };
    }

    if (currentOrder.fulfillment !== 'delivery' || currentOrder.status !== 'delivered') {
      return {
        ok: false as const,
        message: 'Esta correccion solo aplica a pedidos delivery ya entregados.',
      };
    }

    const extraFields =
      currentOrder.extra_fields &&
      typeof currentOrder.extra_fields === 'object' &&
      !Array.isArray(currentOrder.extra_fields)
        ? (currentOrder.extra_fields as Record<string, unknown>)
        : {};
    const currentDelivery =
      extraFields.delivery && typeof extraFields.delivery === 'object' && !Array.isArray(extraFields.delivery)
        ? (extraFields.delivery as Record<string, unknown>)
        : {};
    const nowIso = new Date().toISOString();
    const normalizedCostUsd =
      input.costUsd != null && Number.isFinite(Number(input.costUsd))
        ? Math.max(0, roundMoney(input.costUsd))
        : null;
    const previousDelivery = {
      internal_driver_user_id: currentOrder.internal_driver_user_id ?? null,
      external_partner_id: currentOrder.external_partner_id ?? null,
      external_driver_name: currentOrder.external_driver_name ?? null,
      external_driver_phone: currentOrder.external_driver_phone ?? null,
      external_reference: currentOrder.external_reference ?? null,
      delivery_mode: currentOrder.delivery_mode ?? null,
      distance_km: currentDelivery.distance_km ?? null,
      cost_usd: currentDelivery.cost_usd ?? null,
      cost_source: currentDelivery.cost_source ?? null,
    };

    const updatePayload: Record<string, unknown> = {
      last_modified_at: nowIso,
      last_modified_by: user.id,
    };
    const eventPayload: Record<string, unknown> = {
      assignment_kind: input.assignmentKind,
      notes,
      previous: previousDelivery,
    };
    const recipients: OrderEventRecipientInput[] = [{ targetRole: 'master' }];

    if (input.assignmentKind === 'internal') {
      const driverUserId = String(input.driverUserId || '').trim();
      if (!driverUserId) {
        return { ok: false as const, message: 'Selecciona el driver interno.' };
      }

      updatePayload.internal_driver_user_id = driverUserId;
      updatePayload.delivery_mode = 'internal';
      updatePayload.external_partner_id = null;
      updatePayload.external_driver_name = null;
      updatePayload.external_driver_phone = null;
      updatePayload.external_reference = null;
      updatePayload.extra_fields = {
        ...extraFields,
        delivery: {
          ...currentDelivery,
          delivery_mode: 'internal',
          cost_usd: normalizedCostUsd,
          cost_source: 'admin_delivered_correction_internal',
          corrected_at: nowIso,
          corrected_by_user_id: user.id,
          correction_notes: notes,
        },
      };

      eventPayload.driver_user_id = driverUserId;
      eventPayload.cost_usd = normalizedCostUsd;
      recipients.push({ targetUserId: driverUserId });
    } else {
      const partnerId = Number(input.partnerId || 0);
      if (!Number.isFinite(partnerId) || partnerId <= 0) {
        return { ok: false as const, message: 'Selecciona el partner externo.' };
      }

      const distanceKm = Number(input.distanceKm);
      if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
        return { ok: false as const, message: 'Indica la distancia en km.' };
      }

      const { data: partner, error: partnerError } = await supabase
        .from('delivery_partners')
        .select('id, name, whatsapp_phone')
        .eq('id', partnerId)
        .single();

      if (partnerError) throw new Error(partnerError.message);
      if (!partner) {
        return { ok: false as const, message: 'No se pudo cargar el partner externo.' };
      }

      const reference = String(input.reference || '').trim() || null;
      updatePayload.internal_driver_user_id = null;
      updatePayload.delivery_mode = 'external';
      updatePayload.external_partner_id = partnerId;
      updatePayload.external_driver_name = partner.name ?? null;
      updatePayload.external_driver_phone = partner.whatsapp_phone ?? null;
      updatePayload.external_reference = reference;
      updatePayload.extra_fields = {
        ...extraFields,
        delivery: {
          ...currentDelivery,
          delivery_mode: 'external',
          distance_km: Math.max(0, roundMoney(distanceKm)),
          cost_usd: normalizedCostUsd,
          cost_source: 'admin_delivered_correction_external',
          corrected_at: nowIso,
          corrected_by_user_id: user.id,
          correction_notes: notes,
        },
      };

      eventPayload.partner_id = partnerId;
      eventPayload.partner_name = partner.name ?? null;
      eventPayload.reference = reference;
      eventPayload.distance_km = Math.max(0, roundMoney(distanceKm));
      eventPayload.cost_usd = normalizedCostUsd;
    }

    const { error: updateError } = await supabase
      .from('orders')
      .update(updatePayload)
      .eq('id', orderId)
      .eq('status', 'delivered')
      .eq('fulfillment', 'delivery');

    if (updateError) throw new Error(updateError.message);

    const eventContext = await loadOrderEventContext(supabase as any, orderId);
    await appendOrderEvent(supabase as any, {
      orderId,
      context: eventContext,
      eventType: 'delivery_assignment_corrected',
      eventGroup: 'delivery',
      title: 'Entrega corregida',
      message: notes,
      severity: 'warning',
      actorUserId: user.id,
      payload: eventPayload,
      recipients: [
        ...recipients,
        { targetUserId: eventContext?.advisorUserId },
        { targetUserId: eventContext?.internalDriverUserId },
      ],
    });

    revalidatePath('/app/master/dashboard');
    revalidatePath('/app/advisor');
    revalidatePath('/app/advisor/orders');
    revalidatePath('/app/advisor/inbox');
    return { ok: true as const };
  } catch (error) {
    console.error('correctDeliveredDeliveryAssignmentAction failed', error);
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'No se pudo corregir la entrega.',
    };
  }
}

export async function reviewOrderChangesAction(input: {
  orderId: number;
  approved: boolean;
  notes: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('review_order_changes', {
    p_order_id: input.orderId,
    p_approved: input.approved,
    p_notes: input.notes,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function kitchenTakeAction(input: {
  orderId: number;
  etaMinutes: number;
}) {
  const { supabase, user } = await requireKitchenOperator();

  const { error } = await supabase.rpc('kitchen_take', {
    p_order_id: input.orderId,
    p_eta_minutes: input.etaMinutes,
  });

  if (error) throw new Error(error.message);
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'kitchen_taken',
    eventGroup: 'kitchen',
    title: 'Cocina tomo la orden',
    message: `Cocina registro ${input.etaMinutes} min de preparacion.`,
    severity: 'info',
    actorUserId: user.id,
    payload: {
      prep_eta_minutes: input.etaMinutes,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/dashboard');
}

export async function updateKitchenEtaAction(input: {
  orderId: number;
  etaMinutes: number;
}) {
  const { supabase, user } = await requireKitchenOperator();
  const etaMinutes = Math.round(Number(input.etaMinutes));

  if (!Number.isFinite(etaMinutes) || etaMinutes <= 0) {
    throw new Error('Indica un tiempo de preparacion valido.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, eta_minutes')
    .eq('id', input.orderId)
    .maybeSingle();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (currentOrder.status !== 'in_kitchen') {
    throw new Error('Solo se puede actualizar el tiempo de una orden en preparacion.');
  }

  const previousEtaMinutes = toSafeNumber(currentOrder.eta_minutes, 0);
  const { error: updateError } = await supabase
    .from('orders')
    .update({ eta_minutes: etaMinutes })
    .eq('id', input.orderId)
    .eq('status', 'in_kitchen');

  if (updateError) throw new Error(updateError.message);

  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  const delayed = previousEtaMinutes > 0 && etaMinutes > previousEtaMinutes;
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: delayed ? 'kitchen_delayed_prep' : 'kitchen_eta_updated',
    eventGroup: 'kitchen',
    title: delayed ? 'Cocina reporto retraso' : 'Cocina actualizo el tiempo estimado',
    message: delayed ? `Retraso reportado. Nuevo estimado: ${etaMinutes} min.` : `Nuevo estimado: ${etaMinutes} min.`,
    severity: delayed ? 'warning' : 'info',
    actorUserId: user.id,
    payload: {
      prep_eta_minutes: etaMinutes,
      previous_prep_eta_minutes: previousEtaMinutes || null,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });

  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');
}

export async function protectOrderPriceAction(input: { orderId: number }) {
  const { user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);
  const orderId = Number(input.orderId);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  const supabase = createSupabaseServiceRoleServer();
  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, is_price_locked')
    .eq('id', orderId)
    .maybeSingle();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (['cancelled', 'delivered'].includes(String(currentOrder.status || ''))) {
    throw new Error('No se puede proteger precio de una orden cerrada.');
  }

  if (currentOrder.is_price_locked) {
    return { ok: true as const, alreadyProtected: true };
  }

  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabase
    .from('orders')
    .update({
      is_price_locked: true,
      last_modified_at: nowIso,
      last_modified_by: user.id,
    })
    .eq('id', orderId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  const eventContext = await loadOrderEventContext(supabase, orderId);
  await appendOrderEvent(supabase, {
    orderId,
    context: eventContext,
    eventType: 'order_price_protected',
    eventGroup: 'modification',
    title: 'Precio protegido manualmente',
    message: 'Admin protegió el snapshot de precio por acuerdo con el cliente.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      protected_at: nowIso,
      protection_source: 'admin_manual',
    },
    recipients: [
      { targetRole: 'master' },
      { targetRole: 'admin' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });

  revalidatePath('/app/master/dashboard');
  revalidatePath(`/app/advisor/orders/${orderId}`);
  return { ok: true as const, alreadyProtected: false };
}

export async function reportKitchenIncidentAction(input: {
  orderId: number;
  reason: string;
  note?: string | null;
}) {
  const { supabase, user } = await requireKitchenOperator();
  const orderId = Number(input.orderId || 0);
  const reason = String(input.reason || '').trim();
  const note = String(input.note || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  if (!reason) {
    throw new Error('Selecciona el motivo de la incidencia.');
  }

  const eventContext = await loadOrderEventContext(supabase, orderId);
  if (!eventContext || !['confirmed', 'in_kitchen', 'ready'].includes(String(eventContext.status || ''))) {
    throw new Error('Solo se pueden reportar incidencias de pedidos en cocina.');
  }

  const message = note ? `${reason}. ${note}` : reason;
  await appendOrderEvent(supabase, {
    orderId,
    context: eventContext,
    eventType: 'kitchen_incident',
    eventGroup: 'kitchen',
    title: 'Incidencia en cocina',
    message,
    severity: 'critical',
    actorUserId: user.id,
    payload: {
      reason,
      note: note || null,
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetUserId: eventContext.advisorUserId },
    ],
  });

  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');
}

export async function markReadyAction(input: {
  orderId: number;
}) {
  const { supabase, user } = await requireKitchenOperator();

  const { error } = await supabase.rpc('mark_ready', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);

  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  const isPickup = eventContext?.fulfillment === 'pickup';
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: isPickup ? 'pickup_ready' : 'order_ready',
    eventGroup: 'kitchen',
    title: isPickup ? 'Pedido listo para retiro' : 'Pedido preparado',
    message: isPickup
      ? 'Cocina marco el pedido como listo para retiro.'
      : 'Cocina marco el pedido como preparado.',
    severity: 'info',
    actorUserId: user.id,
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });

  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');
}

export async function outForDeliveryAction(input: {
  orderId: number;
  etaMinutes?: number | null;
}) {
  const { supabase, user } = await requireDeliveryOperator();
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  const normalizedEta =
    input.etaMinutes != null && Number.isFinite(input.etaMinutes) && input.etaMinutes > 0
      ? Math.round(input.etaMinutes)
      : null;

  let existingExtraFields: Record<string, unknown> = {};

  if (normalizedEta != null) {
    const { data: orderRow, error: orderError } = await supabase
      .from('orders')
      .select('extra_fields')
      .eq('id', input.orderId)
      .single();

    if (orderError) throw new Error(orderError.message);

    if (
      orderRow?.extra_fields &&
      typeof orderRow.extra_fields === 'object' &&
      !Array.isArray(orderRow.extra_fields)
    ) {
      existingExtraFields = orderRow.extra_fields as Record<string, unknown>;
    }
  }

  const { error } = await supabase.rpc('out_for_delivery', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);

  if (normalizedEta != null) {
    const currentDelivery =
      existingExtraFields.delivery &&
      typeof existingExtraFields.delivery === 'object' &&
      !Array.isArray(existingExtraFields.delivery)
        ? (existingExtraFields.delivery as Record<string, unknown>)
        : {};

    const nextExtraFields = {
      ...existingExtraFields,
      delivery: {
        ...currentDelivery,
        eta_minutes: normalizedEta,
        eta_recorded_at: new Date().toISOString(),
      },
    };

    const { error: updateError } = await supabase
      .from('orders')
      .update({
        eta_minutes: normalizedEta,
        extra_fields: nextExtraFields,
      })
      .eq('id', input.orderId);

    if (updateError) throw new Error(updateError.message);
  }

  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'out_for_delivery',
    eventGroup: 'delivery',
    title: 'Orden en camino',
    message:
      normalizedEta != null
        ? `La orden salio en camino con ETA de ${normalizedEta} min.`
        : 'La orden salio en camino.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      delivery_eta_minutes: normalizedEta,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
      { targetUserId: eventContext?.internalDriverUserId },
    ],
  });

  revalidatePath('/app/counter');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');
}

export async function markDeliveredAction(input: {
  orderId: number;
}) {
  const { supabase, user } = await requireDeliveryOperator();

  let existingExtraFields: Record<string, unknown> = {};

  const { data: orderRow, error: orderError } = await supabase
    .from('orders')
    .select('extra_fields')
    .eq('id', input.orderId)
    .single();

  if (orderError) throw new Error(orderError.message);

  if (
    orderRow?.extra_fields &&
    typeof orderRow.extra_fields === 'object' &&
    !Array.isArray(orderRow.extra_fields)
  ) {
    existingExtraFields = orderRow.extra_fields as Record<string, unknown>;
  }

  const { error } = await supabase.rpc('mark_delivered', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);

  const currentDelivery =
    existingExtraFields.delivery &&
    typeof existingExtraFields.delivery === 'object' &&
    !Array.isArray(existingExtraFields.delivery)
      ? (existingExtraFields.delivery as Record<string, unknown>)
      : {};

  const nextExtraFields = {
    ...existingExtraFields,
    delivery: {
      ...currentDelivery,
      completed_at: new Date().toISOString(),
    },
  };

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      extra_fields: nextExtraFields,
    })
    .eq('id', input.orderId);

  if (updateError) throw new Error(updateError.message);

  await applyDeliveredOrderInventoryDeductions(supabase, user.id, input.orderId);
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: eventContext?.fulfillment === 'pickup' ? 'pickup_collected' : 'order_delivered',
    eventGroup: 'delivery',
    title: eventContext?.fulfillment === 'pickup' ? 'Orden retirada' : 'Orden entregada',
    message:
      eventContext?.fulfillment === 'pickup'
        ? 'La orden fue retirada por el cliente.'
        : 'La orden fue entregada al cliente.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      fulfillment: eventContext?.fulfillment ?? null,
      completed_at: nextExtraFields.delivery.completed_at,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
      { targetUserId: eventContext?.internalDriverUserId },
    ],
  });

  revalidatePath('/app/counter');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');
}

export async function clearDeliveryAssignmentAction(input: {
  orderId: number;
  notes: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();
  const eventContext = await loadOrderEventContext(supabase, input.orderId);

  const { error } = await supabase.rpc('clear_delivery_assignment', {
    p_order_id: input.orderId,
    p_notes: input.notes,
  });

  if (error) throw new Error(error.message);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'driver_unassigned',
    eventGroup: 'delivery',
    title: 'Asignacion removida',
    message: 'La orden quedo sin driver asignado.',
    severity: 'warning',
    actorUserId: user.id,
    payload: {
      notes: input.notes,
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function returnFromKitchenToQueueAction(input: {
  orderId: number;
  reason: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const reason = input.reason?.trim();
  if (!reason) {
    throw new Error('Debes indicar un motivo.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, notes')
    .eq('id', input.orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (!['confirmed', 'in_kitchen', 'ready'].includes(currentOrder.status)) {
    throw new Error('Solo se puede devolver a cola una orden que está en cocina/preparación/lista.');
  }

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'queued',
      review_notes: reason,
      sent_to_kitchen_at: null,
      sent_to_kitchen_by: null,
      eta_minutes: null,
      kitchen_started_at: null,
      kitchen_operator_id: null,
      ready_at: null,
      internal_driver_user_id: null,
      external_partner_id: null,
      external_driver_name: null,
      external_driver_phone: null,
      external_reference: null,
      last_modified_at: new Date().toISOString(),
      last_modified_by: user.id,
    })
    .eq('id', input.orderId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  revalidatePath('/app/master/dashboard');
}

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
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
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
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  if (!Number.isFinite(input.productId) || input.productId <= 0) {
    throw new Error('Producto inválido.');
  }

  if (!['product', 'combo', 'service', 'promo', 'gambit'].includes(input.type)) {
    throw new Error('Tipo de producto inválido.');
  }

  const sourcePriceAmount = toSafeNumber(input.sourcePriceAmount, 0);
  const unitsPerService = Math.max(0, toSafeNumber(input.unitsPerService, 0));
  const detailUnitsLimit = Math.max(0, toSafeNumber(input.detailUnitsLimit, 0));
  const internalRiderPayUsd =
    input.internalRiderPayUsd == null ? null : Math.max(0, toSafeNumber(input.internalRiderPayUsd, 0));
  const advisorGiftCostUsd =
    input.advisorGiftCostUsd == null ? 0 : Math.max(0, toSafeNumber(input.advisorGiftCostUsd, 0));
  const packagingSize =
    input.packagingSize == null ? null : Math.max(0, toSafeNumber(input.packagingSize, 0));
  const currentStockUnits =
    input.currentStockUnits == null ? null : Math.max(0, toSafeNumber(input.currentStockUnits, 0));
  const lowStockThreshold =
    input.lowStockThreshold == null ? null : Math.max(0, toSafeNumber(input.lowStockThreshold, 0));

  if (!['default', 'fixed_item', 'fixed_order'].includes(input.commissionMode)) {
    throw new Error('Modo de comisión inválido.');
  }
  if (!['raw_material', 'prepared_base', 'finished_good'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }
  if (!['raw', 'fried', 'prefried', 'sauces', 'packaging', 'other'].includes(input.inventoryGroup)) {
    throw new Error('Grupo de inventario inválido.');
  }
  if (!['self', 'composition'].includes(input.inventoryDeductionMode)) {
    throw new Error('Modo de descuento de inventario inválido.');
  }
  if (!['VES', 'USD'].includes(input.sourcePriceCurrency)) {
    throw new Error('Moneda inválida.');
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

  if (
    input.inventoryEnabled &&
    input.inventoryDeductionMode === 'composition' &&
    normalizedInventoryLinks.length === 0 &&
    !hasConfiguredComponents
  ) {
    throw new Error('Define al menos un item interno para el descuento por composición.');
  }

  const { data: currentProduct, error: productError } = await supabase
    .from('products')
    .select('id, sku, name, source_price_amount, source_price_currency, extra_fields')
    .eq('id', input.productId)
    .single();

  if (productError || !currentProduct) {
    throw new Error(productError?.message || 'No se pudo cargar el producto.');
  }

  const { data: exchangeRateData, error: exchangeRateError } = await supabase
    .from('exchange_rates')
    .select('id, rate_bs_per_usd')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (exchangeRateError) {
    throw new Error(exchangeRateError.message);
  }

  const rateBsPerUsd = toSafeNumber(exchangeRateData?.rate_bs_per_usd, 0);

  if (rateBsPerUsd <= 0) {
    throw new Error('No hay una tasa activa válida.');
  }

  let basePriceUsd = 0;
  let basePriceBs = 0;

  if (input.sourcePriceCurrency === 'USD') {
    basePriceUsd = sourcePriceAmount;
    basePriceBs = sourcePriceAmount * rateBsPerUsd;
  } else {
    basePriceBs = sourcePriceAmount;
    basePriceUsd = sourcePriceAmount / rateBsPerUsd;
  }

  const normalizedComponents = (input.components ?? [])
    .map((row, index) => ({
      componentProductId: toSafeNumber(row.componentProductId, 0),
      componentMode: row.componentMode === 'selectable' ? 'selectable' : 'fixed',
      quantity: Math.max(0, toSafeNumber(row.quantity, 0)),
      countsTowardDetailLimit: !!row.countsTowardDetailLimit,
      isRequired: !!row.isRequired,
      sortOrder: toSafeNumber(row.sortOrder, index + 1),
      notes: row.notes?.trim() ? row.notes.trim() : null,
    }))
    .filter((row) => row.componentProductId > 0 && row.quantity > 0);

  const componentIds = Array.from(
    new Set(normalizedComponents.map((row) => row.componentProductId))
  );

  if (componentIds.length > 0) {
    const { data: componentProducts, error: componentCheckError } = await supabase
      .from('products')
      .select('id')
      .in('id', componentIds);

    if (componentCheckError) {
      throw new Error(componentCheckError.message);
    }

    const foundIds = new Set((componentProducts ?? []).map((row) => Number(row.id)));
    const missing = componentIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Hay componentes inválidos: ${missing.join(', ')}`);
    }
  }

  const { data: updatedProduct, error: updateProductError } = await supabase
    .from('products')
    .update({
      type: input.type,
      source_price_amount: sourcePriceAmount,
      source_price_currency: input.sourcePriceCurrency,
      base_price_usd: basePriceUsd,
      base_price_bs: basePriceBs,
      is_active: input.isActive,
      units_per_service: unitsPerService,
      is_detail_editable: input.isDetailEditable,
      detail_units_limit: detailUnitsLimit,
      is_inventory_item: input.isInventoryItem,
      is_temporary: input.isTemporary,
      is_combo_component_selectable: input.isComboComponentSelectable,
      commission_mode: input.commissionMode,
      commission_value: input.commissionMode === 'default' ? null : input.commissionValue,
      commission_notes: input.commissionNotes,
      extra_fields: {
        ...(
          currentProduct.extra_fields &&
          typeof currentProduct.extra_fields === 'object' &&
          !Array.isArray(currentProduct.extra_fields)
            ? (currentProduct.extra_fields as Record<string, unknown>)
            : {}
        ),
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
    })
    .eq('id', input.productId)
    .select('id')
    .maybeSingle();

  if (updateProductError) {
    throw new Error(updateProductError.message);
  }

  if (!updatedProduct) {
    throw new Error('No se pudo actualizar el producto. Revisa los permisos de update sobre products.');
  }

  const selfInventoryItemId = await syncInventoryItemFromCatalogProduct(supabase, {
    currentName: currentProduct.name,
    nextName: currentProduct.name,
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
    productId: input.productId,
    inventoryDeductionMode: input.inventoryDeductionMode,
    selfInventoryItemId,
    inventoryLinks: normalizedInventoryLinks,
  });

  const { error: deleteComponentsError } = await supabase
    .from('product_components')
    .delete()
    .eq('parent_product_id', input.productId);

  if (deleteComponentsError) {
    throw new Error(deleteComponentsError.message);
  }

  if (normalizedComponents.length > 0) {
    const rowsToInsert = normalizedComponents.map((row) => ({
      parent_product_id: input.productId,
      component_product_id: row.componentProductId,
      component_mode: row.componentMode,
      quantity: row.quantity,
      counts_toward_detail_limit: row.countsTowardDetailLimit,
      is_required: row.isRequired,
      sort_order: row.sortOrder,
      notes: row.notes,
    }));

    const { error: insertComponentsError } = await supabase
      .from('product_components')
      .insert(rowsToInsert);

    if (insertComponentsError) {
      throw new Error(insertComponentsError.message);
    }
  }

  await notifyOpenOrdersAffectedByCatalogPriceChange(supabase, {
    productId: input.productId,
    productName: String(currentProduct.name || 'Producto'),
    previousCurrency: currentProduct.source_price_currency === 'VES' ? 'VES' : 'USD',
    previousAmount: toSafeNumber(currentProduct.source_price_amount, 0),
    nextCurrency: input.sourcePriceCurrency,
    nextAmount: sourcePriceAmount,
    actorUserId: user.id,
  });

  revalidatePath('/app/master/dashboard');
}

export async function updateExchangeRateAction(input: {
  rateBsPerUsd: number;
}) {
  const supabase = await createSupabaseServer();

  const rate = Number(input.rateBsPerUsd);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('La tasa debe ser mayor a 0.');
  }

  const { error: disableError } = await supabase
    .from('exchange_rates')
    .update({ is_active: false })
    .eq('is_active', true);

  if (disableError) {
    throw new Error(disableError.message);
  }

  const { error: insertError } = await supabase
    .from('exchange_rates')
    .insert({
      rate_bs_per_usd: rate,
      is_active: true,
      effective_at: new Date().toISOString(),
    });

  if (insertError) {
    throw new Error(insertError.message);
  }

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, source_price_amount, source_price_currency');

  if (productsError) {
    throw new Error(productsError.message);
  }

  for (const product of products ?? []) {
    const sourceAmount = Number(product.source_price_amount || 0);
    const sourceCurrency = String(product.source_price_currency || '');

    if (!Number.isFinite(sourceAmount) || sourceAmount < 0) {
      continue;
    }

    const basePriceUsd =
      sourceCurrency === 'VES' ? sourceAmount / rate : sourceAmount;
    const basePriceBs =
      sourceCurrency === 'VES' ? sourceAmount : sourceAmount * rate;

    const { error: updateProductError } = await supabase
      .from('products')
      .update({
        base_price_usd: Number(basePriceUsd.toFixed(2)),
        base_price_bs: Number(basePriceBs.toFixed(2)),
      })
      .eq('id', product.id);

    if (updateProductError) {
      throw new Error(updateProductError.message);
    }
  }

  revalidatePath('/app/master/dashboard');
}

export async function updateCatalogPricesQuickAction(input: {
  items: Array<{
    productId: number;
    sourcePriceAmount: number;
  }>;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const items = (input.items ?? [])
    .map((row) => ({
      productId: toSafeNumber(row.productId, 0),
      sourcePriceAmount: toSafeNumber(row.sourcePriceAmount, NaN),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.productId) &&
        row.productId > 0 &&
        Number.isFinite(row.sourcePriceAmount) &&
        row.sourcePriceAmount >= 0
    );

  if (items.length === 0) {
    throw new Error('No hay precios válidos para actualizar.');
  }

  const productIds = items.map((row) => row.productId);

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, name, source_price_currency, source_price_amount')
    .in('id', productIds);

  if (productsError) throw new Error(productsError.message);

  const { data: exchangeRateData, error: exchangeRateError } = await supabase
    .from('exchange_rates')
    .select('id, rate_bs_per_usd')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (exchangeRateError) throw new Error(exchangeRateError.message);

  const rateBsPerUsd = toSafeNumber(exchangeRateData?.rate_bs_per_usd, 0);

  if (rateBsPerUsd <= 0) {
    throw new Error('No hay una tasa activa válida.');
  }

  const productById = new Map<number, {
    id: number;
    name: string | null;
    source_price_currency: string | null;
    source_price_amount: number | string | null;
  }>();
  for (const product of products ?? []) {
    productById.set(Number(product.id), product);
  }

  for (const item of items) {
    const product = productById.get(item.productId);
    const sourcePriceCurrency = product?.source_price_currency === 'VES' ? 'VES' : 'USD';

    if (!product) {
      throw new Error(`No se pudo cargar el producto ${item.productId}.`);
    }

    let basePriceUsd = 0;
    let basePriceBs = 0;

    if (sourcePriceCurrency === 'USD') {
      basePriceUsd = item.sourcePriceAmount;
      basePriceBs = item.sourcePriceAmount * rateBsPerUsd;
    } else {
      basePriceBs = item.sourcePriceAmount;
      basePriceUsd = item.sourcePriceAmount / rateBsPerUsd;
    }

    const { error: updateError } = await supabase
      .from('products')
      .update({
        source_price_amount: item.sourcePriceAmount,
        base_price_usd: basePriceUsd,
        base_price_bs: basePriceBs,
      })
      .eq('id', item.productId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    await notifyOpenOrdersAffectedByCatalogPriceChange(supabase, {
      productId: item.productId,
      productName: String(product.name || 'Producto'),
      previousCurrency: product.source_price_currency === 'VES' ? 'VES' : 'USD',
      previousAmount: toSafeNumber(product.source_price_amount, 0),
      nextCurrency: sourcePriceCurrency,
      nextAmount: item.sourcePriceAmount,
      actorUserId: user.id,
    });
  }

  revalidatePath('/app/master/dashboard');
}

export async function createMoneyAccountAction(input: {
  name: string;
  currencyCode: 'USD' | 'VES';
  accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
  institutionName: string;
  ownerName: string;
  notes: string;
  isActive: boolean;
  closureDefaultTargetMoneyAccountId?: number | null;
}) {
  const { user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);
  const supabase = createSupabaseServiceRoleServer();

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre de la cuenta es obligatorio.');

  const { data: insertedAccount, error } = await supabase.from('money_accounts').insert({
    name,
    currency_code: input.currencyCode,
    account_kind: input.accountKind,
    institution_name: input.institutionName.trim() || null,
    owner_name: input.ownerName.trim() || null,
    notes: input.notes.trim() || null,
    is_active: input.isActive,
    created_by_user_id: user.id,
  }).select('id').single();

  if (error) throw new Error(error.message);

  const insertedAccountId = Number(insertedAccount?.id || 0);
  if (insertedAccountId > 0) {
    await ensureMoneyAccountClosureProfile(supabase, {
      accountId: insertedAccountId,
      accountKind: input.accountKind,
      currencyCode: input.currencyCode,
      defaultTargetMoneyAccountId: input.closureDefaultTargetMoneyAccountId ?? null,
    });
  }

  revalidateMasterDashboardFinancialReferences();
}

export async function updateMoneyAccountAction(input: {
  accountId: number;
  name: string;
  currencyCode: 'USD' | 'VES';
  accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
  institutionName: string;
  ownerName: string;
  notes: string;
  isActive: boolean;
  closureDefaultTargetMoneyAccountId?: number | null;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('Cuenta inválida.');
  }

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre de la cuenta es obligatorio.');

  const { error } = await supabase
    .from('money_accounts')
    .update({
      name,
      currency_code: input.currencyCode,
      account_kind: input.accountKind,
      institution_name: input.institutionName.trim() || null,
      owner_name: input.ownerName.trim() || null,
      notes: input.notes.trim() || null,
      is_active: input.isActive,
    })
    .eq('id', accountId);

  if (error) throw new Error(error.message);

  await ensureMoneyAccountClosureProfile(supabase, {
    accountId,
    accountKind: input.accountKind,
    currencyCode: input.currencyCode,
    defaultTargetMoneyAccountId: input.closureDefaultTargetMoneyAccountId ?? null,
  });

  revalidateMasterDashboardFinancialReferences();
}

export async function toggleMoneyAccountActiveAction(input: {
  accountId: number;
  nextIsActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('Cuenta inválida.');
  }

  const { error } = await supabase
    .from('money_accounts')
    .update({ is_active: input.nextIsActive })
    .eq('id', accountId);

  if (error) throw new Error(error.message);

  revalidateMasterDashboardFinancialReferences();
}

export async function updateMoneyAccountPaymentRulesAction(input: {
  accountId: number;
  rules: Array<{
    role: AppUserRole;
    paymentMethodCode: string;
    canViewAccount: boolean;
    canShareWithClient: boolean;
    canReportPayment: boolean;
    canConfirmPayment: boolean;
    autoConfirmsReport: boolean;
    reviewRequired: boolean;
    reviewRoles: AppUserRole[];
    isActive: boolean;
  }>;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('Cuenta inválida.');
  }

  const rawRules = Array.isArray(input.rules) ? input.rules : [];
  const now = new Date().toISOString();
  const rows = rawRules
    .map((rule) => {
      const role = typeof rule.role === 'string' && APP_USER_ROLES.has(rule.role) ? rule.role : null;
      const paymentMethodCode = normalizePaymentMethodCode(rule.paymentMethodCode);
      if (!role || !paymentMethodCode) return null;

      const autoConfirmsReport = Boolean(rule.autoConfirmsReport);
      const reviewRequired = autoConfirmsReport ? false : Boolean(rule.reviewRequired);
      const reviewRoles = reviewRequired ? normalizeUserRoles(rule.reviewRoles) : [];
      const normalizedReviewRoles = reviewRequired && reviewRoles.length === 0 ? ['master', 'admin'] : reviewRoles;
      const canReportPayment = Boolean(rule.canReportPayment);
      const canConfirmPayment = autoConfirmsReport ? true : Boolean(rule.canConfirmPayment);
      const canViewAccount =
        Boolean(rule.canViewAccount) ||
        Boolean(rule.canShareWithClient) ||
        canReportPayment ||
        canConfirmPayment ||
        reviewRequired;

      return {
        money_account_id: accountId,
        role,
        payment_method_code: paymentMethodCode,
        can_view_account: canViewAccount,
        can_share_with_client: Boolean(rule.canShareWithClient),
        can_report_payment: canReportPayment,
        can_confirm_payment: canConfirmPayment,
        auto_confirms_report: autoConfirmsReport,
        review_required: reviewRequired,
        review_roles: normalizedReviewRoles,
        is_active: Boolean(rule.isActive),
        updated_at: now,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) {
    throw new Error('No hay reglas válidas para guardar.');
  }

  const { error: deactivateError } = await supabase
    .from('money_account_payment_rules')
    .update({ is_active: false, updated_at: now })
    .eq('money_account_id', accountId);

  if (deactivateError) throw new Error(deactivateError.message);

  const { error } = await supabase
    .from('money_account_payment_rules')
    .upsert(rows, { onConflict: 'money_account_id,role,payment_method_code' });

  if (error) throw new Error(error.message);

  revalidateMasterDashboardFinancialReferences();
}

export async function loadMoneyActivityAction(input?: {
  movementLimit?: number;
  closureLimit?: number;
  reconciliationLimit?: number;
  movementDateFrom?: string;
  movementDateTo?: string;
  moneyAccountId?: number;
}) {
  const { supabase } = await requireMasterOrAdmin();
  const moneyAccountId = Number(input?.moneyAccountId ?? 0);
  const hasMoneyAccountFilter = Number.isFinite(moneyAccountId) && moneyAccountId > 0;
  const movementDateFrom =
    typeof input?.movementDateFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.movementDateFrom.trim())
      ? input.movementDateFrom.trim()
      : '';
  const movementDateTo =
    typeof input?.movementDateTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.movementDateTo.trim())
      ? input.movementDateTo.trim()
      : '';
  const hasMovementDateRange = Boolean(movementDateFrom || movementDateTo);
  const movementLimit = Math.max(
    50,
    Math.min(
      hasMovementDateRange || hasMoneyAccountFilter ? 2500 : 800,
      Math.floor(Number(input?.movementLimit ?? (hasMovementDateRange || hasMoneyAccountFilter ? 1200 : 350)) || 350)
    )
  );
  const closureLimit = Math.max(25, Math.min(300, Math.floor(Number(input?.closureLimit ?? 120) || 120)));
  const reconciliationLimit = Math.max(
    25,
    Math.min(300, Math.floor(Number(input?.reconciliationLimit ?? 120) || 120))
  );

  let movementsQuery = supabase
    .from('money_movements')
    .select(`
      id,
      movement_date,
      created_at,
      created_by_user_id,
      confirmed_at,
      confirmed_by_user_id,
      status,
      approval_required,
      approval_required_reason,
      reviewed_at,
      reviewed_by_user_id,
      rejected_at,
      rejected_by_user_id,
      rejection_reason,
      voided_at,
      voided_by_user_id,
      void_reason,
      direction,
      movement_type,
      money_account_id,
      currency_code,
      amount,
      exchange_rate_ves_per_usd,
      amount_usd_equivalent,
      reference_code,
      counterparty_name,
      description,
      notes,
      order_id,
      payment_report_id,
      movement_group_id
    `);

  if (movementDateFrom) {
    movementsQuery = movementsQuery.gte('movement_date', movementDateFrom);
  }
  if (movementDateTo) {
    movementsQuery = movementsQuery.lte('movement_date', movementDateTo);
  }
  if (hasMoneyAccountFilter) {
    movementsQuery = movementsQuery.eq('money_account_id', moneyAccountId);
  }

  let closuresQuery = supabase
    .from('money_account_closures')
    .select(`
        id,
        money_account_id,
        closure_date,
        closure_at,
        expected_amount,
        counted_amount,
        difference_amount,
        expected_amount_usd,
        counted_amount_usd,
        difference_amount_usd,
        currency_code,
        exchange_rate_ves_per_usd,
        reason,
        notes,
        status,
        created_by_user_id,
        created_at,
        reviewed_by_user_id,
        reviewed_at
      `);

  let baselinesQuery = supabase
    .from('money_account_closure_baselines')
    .select(`
        id,
        money_account_id,
        baseline_date,
        baseline_at,
        expected_amount,
        counted_amount,
        difference_amount,
        expected_amount_usd,
        counted_amount_usd,
        difference_amount_usd,
        currency_code,
        exchange_rate_ves_per_usd,
        reason,
        notes,
        status,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason
      `)
    .eq('status', 'active');

  let reconciliationItemsQuery = supabase
    .from('money_account_reconciliation_items')
    .select(`
        id,
        money_account_id,
        source_kind,
        source_id,
        item_type,
        direction,
        currency_code,
        amount,
        amount_usd_equivalent,
        operation_date,
        reference_code,
        counterparty_name,
        description,
        status,
        created_by_user_id,
        created_at,
        resolved_by_user_id,
        resolved_at,
        resolution_notes,
        voided_by_user_id,
        voided_at,
        void_reason
      `);

  if (hasMoneyAccountFilter) {
    closuresQuery = closuresQuery.eq('money_account_id', moneyAccountId);
    baselinesQuery = baselinesQuery.eq('money_account_id', moneyAccountId);
    reconciliationItemsQuery = reconciliationItemsQuery.eq('money_account_id', moneyAccountId);
  }

  const [movementsResult, closuresResult, baselinesResult, reconciliationItemsResult] = await Promise.all([
    movementsQuery
      .order('movement_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(movementLimit),
    closuresQuery
      .order('closure_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(closureLimit),
    baselinesQuery.order('baseline_at', { ascending: false }),
    reconciliationItemsQuery.order('created_at', { ascending: false }).limit(reconciliationLimit),
  ]);

  if (movementsResult.error) throw new Error(movementsResult.error.message);
  if (closuresResult.error) throw new Error(closuresResult.error.message);
  if (baselinesResult.error) throw new Error(baselinesResult.error.message);
  if (reconciliationItemsResult.error) throw new Error(reconciliationItemsResult.error.message);

  const movementRows = (movementsResult.data ?? []) as any[];
  const movementOrderIds = Array.from(
    new Set(
      movementRows
        .map((mv) => Number(mv.order_id || 0))
        .filter((orderId) => Number.isFinite(orderId) && orderId > 0)
    )
  );
  const { data: movementOrdersData, error: movementOrdersError } =
    movementOrderIds.length > 0
      ? await supabase
          .from('orders')
          .select('id, client_id, client:clients!orders_client_id_fkey(full_name, phone)')
          .in('id', movementOrderIds)
      : { data: [], error: null };

  if (movementOrdersError) throw new Error(movementOrdersError.message);

  const movementOrderClientById = new Map<
    number,
    { clientId: number | null; clientName: string | null; clientPhone: string | null }
  >();

  for (const order of (movementOrdersData ?? []) as any[]) {
    const client = Array.isArray(order.client) ? order.client[0] ?? null : order.client ?? null;
    movementOrderClientById.set(Number(order.id), {
      clientId: order.client_id == null ? null : Number(order.client_id),
      clientName: client?.full_name == null ? null : String(client.full_name),
      clientPhone: client?.phone == null ? null : String(client.phone),
    });
  }

  const movements = movementRows.map((mv) => {
    const orderId = mv.order_id == null ? null : Number(mv.order_id);
    const orderClient = orderId ? movementOrderClientById.get(orderId) ?? null : null;

    return {
    id: Number(mv.id),
    movementDate: mv.movement_date,
    createdAt: mv.created_at,
    createdByUserId: mv.created_by_user_id,
    confirmedAt: mv.confirmed_at,
    confirmedByUserId: mv.confirmed_by_user_id,
    status: mv.status ?? (mv.confirmed_at ? 'confirmed' : 'pending'),
    approvalRequired: Boolean(mv.approval_required),
    approvalRequiredReason: mv.approval_required_reason ?? null,
    reviewedAt: mv.reviewed_at ?? null,
    reviewedByUserId: mv.reviewed_by_user_id ?? null,
    rejectedAt: mv.rejected_at ?? null,
    rejectedByUserId: mv.rejected_by_user_id ?? null,
    rejectionReason: mv.rejection_reason ?? null,
    voidedAt: mv.voided_at ?? null,
    voidedByUserId: mv.voided_by_user_id ?? null,
    voidReason: mv.void_reason ?? null,
    direction: mv.direction,
    movementType: mv.movement_type,
    moneyAccountId: Number(mv.money_account_id),
    currencyCode: mv.currency_code,
    amount: toSafeNumber(mv.amount, 0),
    exchangeRateVesPerUsd:
      mv.exchange_rate_ves_per_usd == null ? null : toSafeNumber(mv.exchange_rate_ves_per_usd, 0),
    amountUsdEquivalent: toSafeNumber(mv.amount_usd_equivalent, 0),
    referenceCode: mv.reference_code ?? null,
    counterpartyName: mv.counterparty_name ?? null,
    description: mv.description ?? null,
    notes: mv.notes ?? null,
    orderId,
    clientId: orderClient?.clientId ?? null,
    clientName: orderClient?.clientName ?? null,
    clientPhone: orderClient?.clientPhone ?? null,
    paymentReportId: mv.payment_report_id == null ? null : Number(mv.payment_report_id),
    movementGroupId: mv.movement_group_id ?? null,
    };
  });

  const closures = ((closuresResult.data ?? []) as any[]).map((row) => ({
    id: Number(row.id),
    moneyAccountId: Number(row.money_account_id),
    closureDate: row.closure_date,
    closureAt: row.closure_at ?? null,
    expectedAmount: toSafeNumber(row.expected_amount, 0),
    countedAmount: toSafeNumber(row.counted_amount, 0),
    differenceAmount: toSafeNumber(row.difference_amount, 0),
    expectedAmountUsd: toSafeNumber(row.expected_amount_usd, 0),
    countedAmountUsd: toSafeNumber(row.counted_amount_usd, 0),
    differenceAmountUsd: toSafeNumber(row.difference_amount_usd, 0),
    currencyCode: row.currency_code,
    exchangeRateVesPerUsd:
      row.exchange_rate_ves_per_usd == null ? null : toSafeNumber(row.exchange_rate_ves_per_usd, 0),
    reason: row.reason ?? null,
    notes: row.notes ?? null,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    reviewedByUserId: row.reviewed_by_user_id ?? null,
    reviewedAt: row.reviewed_at ?? null,
  }));

  const baselines = ((baselinesResult.data ?? []) as any[]).map((row) => ({
    id: Number(row.id),
    moneyAccountId: Number(row.money_account_id),
    baselineDate: row.baseline_date,
    baselineAt: row.baseline_at,
    expectedAmount: toSafeNumber(row.expected_amount, 0),
    countedAmount: toSafeNumber(row.counted_amount, 0),
    differenceAmount: toSafeNumber(row.difference_amount, 0),
    expectedAmountUsd: toSafeNumber(row.expected_amount_usd, 0),
    countedAmountUsd: toSafeNumber(row.counted_amount_usd, 0),
    differenceAmountUsd: toSafeNumber(row.difference_amount_usd, 0),
    currencyCode: row.currency_code,
    exchangeRateVesPerUsd:
      row.exchange_rate_ves_per_usd == null ? null : toSafeNumber(row.exchange_rate_ves_per_usd, 0),
    reason: row.reason ?? null,
    notes: row.notes ?? null,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    voidedByUserId: row.voided_by_user_id ?? null,
    voidedAt: row.voided_at ?? null,
    voidReason: row.void_reason ?? null,
  }));

  const reconciliationItems = ((reconciliationItemsResult.data ?? []) as any[]).map((row) => ({
    id: Number(row.id),
    moneyAccountId: Number(row.money_account_id),
    sourceKind: row.source_kind,
    sourceId: row.source_id == null ? null : Number(row.source_id),
    itemType: row.item_type,
    direction: row.direction,
    currencyCode: row.currency_code,
    amount: toSafeNumber(row.amount, 0),
    amountUsdEquivalent: toSafeNumber(row.amount_usd_equivalent, 0),
    operationDate: row.operation_date ?? null,
    referenceCode: row.reference_code ?? null,
    counterpartyName: row.counterparty_name ?? null,
    description: row.description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    resolvedByUserId: row.resolved_by_user_id ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolutionNotes: row.resolution_notes ?? null,
    voidedByUserId: row.voided_by_user_id ?? null,
    voidedAt: row.voided_at ?? null,
    voidReason: row.void_reason ?? null,
  }));

  return { movements, closures, baselines, reconciliationItems };
}

export async function loadInventoryMovementsAction(input?: {
  movementLimit?: number;
}) {
  const { supabase } = await requireMasterOrAdmin();
  const movementLimit = Math.max(50, Math.min(500, Math.floor(Number(input?.movementLimit ?? 150) || 150)));

  const { data, error } = await supabase
    .from('inventory_movements')
    .select(`
      id,
      inventory_item_id,
      movement_type,
      quantity_units,
      reason_code,
      notes,
      order_id,
      created_at,
      created_by_user_id
    `)
    .order('created_at', { ascending: false })
    .limit(movementLimit);

  if (error) throw new Error(error.message);

  const movements = ((data ?? []) as any[]).map((row) => ({
    id: Number(row.id),
    inventoryItemId: Number(row.inventory_item_id),
    movementType: row.movement_type,
    quantityUnits: toSafeNumber(row.quantity_units, 0),
    reasonCode: row.reason_code ?? null,
    notes: row.notes ?? null,
    orderId: row.order_id == null ? null : Number(row.order_id),
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
  }));

  return { movements };
}

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
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  const direction = input.direction === 'outflow' ? 'outflow' : 'inflow';
  const outflowPurpose = input.outflowPurpose === 'change' ? 'change' : 'expense';
  const moneyAccountId = Number(input.moneyAccountId || 0);
  const amount = Number(input.amount || 0);
  const feeAmount = direction === 'outflow' ? Number(input.feeAmount || 0) : 0;
  const movementDate = String(input.movementDate || '').trim();
  const referenceCode = String(input.referenceCode || '').trim() || null;
  const counterpartyName = String(input.counterpartyName || '').trim() || null;
  const description = String(input.description || '').trim();
  const notes = String(input.notes || '').trim() || null;

  if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Debes seleccionar una cuenta.');
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('El monto debe ser mayor a 0.');
  }

  if (!Number.isFinite(feeAmount) || feeAmount < 0) {
    throw new Error('La comisión no es válida.');
  }

  if (!movementDate) {
    throw new Error('Debes indicar la fecha del movimiento.');
  }

  if (!description) {
    throw new Error('Debes indicar el motivo o descripción.');
  }

  const { data: account, error: accountError } = await supabase
    .from('money_accounts')
    .select('id, currency_code, is_active')
    .eq('id', moneyAccountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message || 'No se pudo cargar la cuenta.');
  }

  if (!account.is_active) {
    throw new Error('La cuenta seleccionada está inactiva.');
  }

  const currencyCode = String(account.currency_code || '').toUpperCase();
  if (currencyCode !== 'USD' && currencyCode !== 'VES') {
    throw new Error('La moneda de la cuenta no es válida.');
  }

  const exchangeRate =
    currencyCode === 'VES'
      ? Number(input.exchangeRateVesPerUsd || 0)
      : null;

  if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate ?? NaN) || (exchangeRate ?? 0) <= 0)) {
    throw new Error('Debes indicar una tasa válida para movimientos en Bs.');
  }

  const amountUsdEquivalent =
    currencyCode === 'USD'
      ? Number(amount.toFixed(2))
      : Number((amount / (exchangeRate ?? 1)).toFixed(2));
  const feeAmountUsdEquivalent =
    currencyCode === 'USD'
      ? Number(feeAmount.toFixed(2))
      : Number((feeAmount / (exchangeRate ?? 1)).toFixed(2));

  const movementType =
    direction === 'inflow'
      ? 'other_income'
      : outflowPurpose === 'change'
        ? 'change_given'
        : 'expense_payment';
  const movementGroupId = feeAmount > 0 ? crypto.randomUUID() : null;
  const requiresApproval = requiresAdminMovementApproval(
    roles,
    direction,
    Number((amountUsdEquivalent + feeAmountUsdEquivalent).toFixed(2)),
    movementType
  );
  const movementStatus = requiresApproval ? 'pending' : 'confirmed';
  const confirmedAt = requiresApproval ? null : new Date().toISOString();
  const approvalReason = requiresApproval
    ? `Gasto igual o mayor a ${MASTER_OUTFLOW_ADMIN_APPROVAL_MIN_USD.toFixed(2)} USD requiere aprobación admin.`
    : null;

  const movementRows = [
    {
    movement_date: movementDate,
    created_by_user_id: user.id,
    confirmed_at: confirmedAt,
    confirmed_by_user_id: requiresApproval ? null : user.id,
    status: movementStatus,
    approval_required: requiresApproval,
    approval_required_reason: approvalReason,
    direction,
    movement_type: movementType,
    money_account_id: moneyAccountId,
    currency_code: currencyCode,
    amount: Number(amount.toFixed(2)),
    exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
    amount_usd_equivalent: amountUsdEquivalent,
    reference_code: referenceCode,
    counterparty_name: counterpartyName,
    description,
    notes,
    order_id: null,
    payment_report_id: null,
      movement_group_id: movementGroupId,
    },
  ];

  if (direction === 'outflow' && feeAmount > 0) {
    movementRows.push({
      movement_date: movementDate,
      created_by_user_id: user.id,
      confirmed_at: confirmedAt,
      confirmed_by_user_id: requiresApproval ? null : user.id,
      status: movementStatus,
      approval_required: requiresApproval,
      approval_required_reason: approvalReason,
      direction,
      movement_type: 'fee_charge',
      money_account_id: moneyAccountId,
      currency_code: currencyCode,
      amount: Number(feeAmount.toFixed(2)),
      exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
      amount_usd_equivalent: feeAmountUsdEquivalent,
      reference_code: referenceCode,
      counterparty_name: counterpartyName,
      description: `Comisión · ${description}`,
      notes,
      order_id: null,
      payment_report_id: null,
      movement_group_id: movementGroupId,
    });
  }

  const { error } = await supabase.from('money_movements').insert(movementRows);

  if (error) throw new Error(error.message);

  if (requiresApproval) {
    await notifyAdminMoneyApproval({
      title: 'Egreso pendiente de aprobacion',
      body: `${description} · ${Number((amountUsdEquivalent + feeAmountUsdEquivalent).toFixed(2)).toFixed(2)} USD requiere revision admin.`,
      tag: `admin-money-movement-${movementGroupId || moneyAccountId}-${movementDate}`,
    });
  }

  revalidatePath('/app/master/dashboard');

  /* const orderId = Number(input.orderId || 0);
  if (Number.isFinite(orderId) && orderId > 0) {
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id, total_usd, total_bs_snapshot, extra_fields')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo recalcular el saldo de la orden.');
    }

    const { data: orderMovements, error: orderMovementsError } = await supabase
      .from('money_movements')
      .select('direction, amount_usd_equivalent')
      .eq('order_id', orderId)
      .eq('status', 'confirmed');

    if (orderMovementsError) {
      throw new Error(orderMovementsError.message);
    }

    const confirmedPaidUsd = roundMoney((orderMovements ?? []).reduce((sum, row) => {
      const signedAmount =
        toSafeNumber(row.amount_usd_equivalent, 0) *
        (row.direction === 'outflow' ? -1 : 1);
      return sum + signedAmount;
    }, 0));

    const currentTotalUsd = getEffectiveOrderTotalUsd(currentOrder);
    const currentTotalBs = getEffectiveOrderTotalBs(currentOrder);
    const excessUsd = roundMoney(Math.max(0, confirmedPaidUsd - currentTotalUsd));
    const handling = input.overpaymentHandling ?? null;
    const notes = String(input.overpaymentNotes || '').trim() || null;

    if (excessUsd > 0.005 && handling === 'change_given') {
      const changeNativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { error: changeMovementError } = await supabase
        .from('money_movements')
        .insert({
          movement_date: input.movementDate,
          created_by_user_id: user.id,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: user.id,
          direction: 'outflow',
          movement_type: 'change_given',
          money_account_id: input.confirmedMoneyAccountId,
          currency_code: input.confirmedCurrency,
          amount: changeNativeAmount,
          exchange_rate_ves_per_usd:
            String(input.confirmedCurrency).toUpperCase() === 'VES'
              ? input.confirmedExchangeRateVesPerUsd
              : null,
          amount_usd_equivalent: excessUsd,
          reference_code: input.referenceCode,
          counterparty_name: input.counterpartyName,
          description:
            input.description
              ? `${input.description} · cambio entregado`
              : `Cambio entregado · orden ${orderId} · reporte ${input.reportId}`,
          notes,
          order_id: orderId,
          payment_report_id: input.reportId,
          movement_group_id: `change-${orderId}-${input.reportId}`,
        });

      if (changeMovementError) {
        throw new Error(changeMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'store_fund') {
      const clientId = Number(input.clientId || currentOrder.client_id || 0);
      if (!Number.isFinite(clientId) || clientId <= 0) {
        throw new Error('La orden no tiene un cliente válido para guardar el fondo.');
      }

      const nativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { data: currentClient, error: currentClientError } = await supabase
        .from('clients')
        .select('id, fund_balance_usd')
        .eq('id', clientId)
        .single();

      if (currentClientError || !currentClient) {
        throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
      }

      const { error: updateClientFundError } = await supabase
        .from('clients')
        .update({
          fund_balance_usd: roundMoney(toSafeNumber(currentClient.fund_balance_usd, 0) + excessUsd),
        })
        .eq('id', clientId);

      if (updateClientFundError) {
        throw new Error(updateClientFundError.message);
      }

      const { error: fundMovementError } = await supabase
        .from('client_fund_movements')
        .insert({
          client_id: clientId,
          movement_type: 'credit',
          currency_code: input.confirmedCurrency,
          amount: nativeAmount,
          amount_usd: excessUsd,
          money_account_id: input.confirmedMoneyAccountId,
          order_id: orderId,
          payment_report_id: input.reportId,
          reason_code: 'payment_overage_stored',
          notes,
          created_by_user_id: user.id,
        });

      if (fundMovementError) {
        throw new Error(fundMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'close_difference') {
      if (!getMasterDashboardPermissions(roles).isAdmin) {
        throw new Error('Solo admin puede cerrar excedentes por redondeo.');
      }

      if (excessUsd > ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD) {
        throw new Error(
          `Solo se pueden cerrar diferencias de hasta ${ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD.toFixed(2)} USD.`
        );
      }

      const extraFields =
        currentOrder.extra_fields &&
        typeof currentOrder.extra_fields === 'object' &&
        !Array.isArray(currentOrder.extra_fields)
          ? ({ ...currentOrder.extra_fields } as Record<string, any>)
          : {};

      const pricing =
        extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
          ? { ...extraFields.pricing }
          : {};

      const payment =
        extraFields.payment && typeof extraFields.payment === 'object' && !Array.isArray(extraFields.payment)
          ? { ...extraFields.payment }
          : {};

      const fxRate = toSafeNumber(pricing.fx_rate, 0);
      const nextTotalUsd = Number(confirmedPaidUsd.toFixed(2));
      const nextTotalBs =
        fxRate > 0
          ? Number((nextTotalUsd * fxRate).toFixed(2))
          : currentTotalUsd > 0
            ? Number(((currentTotalBs / currentTotalUsd) * nextTotalUsd).toFixed(2))
            : currentTotalBs;

      pricing.total_usd = nextTotalUsd;
      pricing.total_bs = nextTotalBs;
      pricing.rounding_gain_closed_usd = excessUsd;
      pricing.rounding_gain_close_applied_at = new Date().toISOString();
      pricing.rounding_gain_close_applied_by = user.id;

      payment.rounding_gain_close = {
        closed_balance_usd: excessUsd,
        previous_total_usd: Number(currentTotalUsd.toFixed(2)),
        next_total_usd: nextTotalUsd,
        applied_at: new Date().toISOString(),
        applied_by: user.id,
        notes,
      };

      extraFields.pricing = pricing;
      extraFields.payment = payment;

      const { error: updateOrderError } = await supabase
        .from('orders')
        .update({
          total_usd: nextTotalUsd,
          total_bs_snapshot: nextTotalBs,
          extra_fields: extraFields,
          last_modified_at: new Date().toISOString(),
          last_modified_by: user.id,
        })
        .eq('id', orderId);

      if (updateOrderError) {
        throw new Error(updateOrderError.message);
      }

      const { error: adjustmentError } = await supabase
        .from('order_admin_adjustments')
        .insert({
          order_id: orderId,
          order_item_id: null,
          adjustment_type: 'other',
          reason: 'Cierre de excedente por redondeo',
          notes,
          payload: {
            kind: 'rounding_gain_close',
            delta_usd: excessUsd,
            original_unit_price_usd: Number(currentTotalUsd.toFixed(2)),
            override_unit_price_usd: nextTotalUsd,
            product_name: 'Cierre por redondeo',
            qty: 1,
            closed_balance_usd: excessUsd,
            previous_total_usd: Number(currentTotalUsd.toFixed(2)),
            previous_total_bs: Number(currentTotalBs.toFixed(2)),
            confirmed_paid_usd: Number(confirmedPaidUsd.toFixed(2)),
            next_total_usd: nextTotalUsd,
            next_total_bs: nextTotalBs,
            payment_report_id: input.reportId,
          },
          created_by_user_id: user.id,
        });

      if (adjustmentError) {
        throw new Error(adjustmentError.message);
      }
    }
  } */
  revalidatePath('/app/master/dashboard');
}

export async function createInventoryItemAction(input: {
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  isActive: boolean;
  notes: string | null;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del item es obligatorio.');
  if (!['raw_material', 'prepared_base', 'finished_stock', 'packaging'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }
  if (!['raw', 'fried', 'prefried', 'sauces', 'packaging', 'other'].includes(input.inventoryGroup)) {
    throw new Error('Grupo de inventario inválido.');
  }

  const { error } = await supabase.from('inventory_items').insert({
    name,
    inventory_kind: input.inventoryKind,
    unit_name: String(input.unitName || '').trim() || 'pieza',
    packaging_name: String(input.packagingName || '').trim() || null,
    packaging_size:
      input.packagingSize == null ? null : Math.max(0, toSafeNumber(input.packagingSize, 0)),
    current_stock_units: Math.max(0, toSafeNumber(input.currentStockUnits, 0)),
    low_stock_threshold:
      input.lowStockThreshold == null ? null : Math.max(0, toSafeNumber(input.lowStockThreshold, 0)),
    inventory_group: input.inventoryGroup,
    is_active: !!input.isActive,
    notes: String(input.notes || '').trim() || null,
  });

  if (error) throw new Error(error.message);
  /*

  const orderId = Number(input.orderId || 0);
  if (Number.isFinite(orderId) && orderId > 0) {
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id, total_usd, total_bs_snapshot, extra_fields')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo recalcular el saldo de la orden.');
    }

    const { data: orderMovements, error: orderMovementsError } = await supabase
      .from('money_movements')
      .select('direction, amount_usd_equivalent')
      .eq('order_id', orderId)
      .eq('status', 'confirmed');

    if (orderMovementsError) {
      throw new Error(orderMovementsError.message);
    }

    const confirmedPaidUsd = roundMoney((orderMovements ?? []).reduce((sum, row) => {
      const signedAmount =
        toSafeNumber(row.amount_usd_equivalent, 0) *
        (row.direction === 'outflow' ? -1 : 1);
      return sum + signedAmount;
    }, 0));

    const currentTotalUsd = getEffectiveOrderTotalUsd(currentOrder);
    const currentTotalBs = getEffectiveOrderTotalBs(currentOrder);
    const excessUsd = roundMoney(Math.max(0, confirmedPaidUsd - currentTotalUsd));
    const handling = input.overpaymentHandling ?? null;
    const notes = String(input.overpaymentNotes || '').trim() || null;

    if (excessUsd > 0.005 && handling === 'change_given') {
      const changeNativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { error: changeMovementError } = await supabase
        .from('money_movements')
        .insert({
          movement_date: input.movementDate,
          created_by_user_id: user.id,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: user.id,
          direction: 'outflow',
          movement_type: 'change_given',
          money_account_id: input.confirmedMoneyAccountId,
          currency_code: input.confirmedCurrency,
          amount: changeNativeAmount,
          exchange_rate_ves_per_usd:
            String(input.confirmedCurrency).toUpperCase() === 'VES'
              ? input.confirmedExchangeRateVesPerUsd
              : null,
          amount_usd_equivalent: excessUsd,
          reference_code: input.referenceCode,
          counterparty_name: input.counterpartyName,
          description:
            input.description
              ? `${input.description} · cambio entregado`
              : `Cambio entregado · orden ${orderId} · reporte ${input.reportId}`,
          notes,
          order_id: orderId,
          payment_report_id: input.reportId,
          movement_group_id: `change-${orderId}-${input.reportId}`,
        });

      if (changeMovementError) {
        throw new Error(changeMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'store_fund') {
      const clientId = Number(input.clientId || currentOrder.client_id || 0);
      if (!Number.isFinite(clientId) || clientId <= 0) {
        throw new Error('La orden no tiene un cliente válido para guardar el fondo.');
      }

      const nativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { data: currentClient, error: currentClientError } = await supabase
        .from('clients')
        .select('id, fund_balance_usd')
        .eq('id', clientId)
        .single();

      if (currentClientError || !currentClient) {
        throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
      }

      const { error: updateClientFundError } = await supabase
        .from('clients')
        .update({
          fund_balance_usd: roundMoney(toSafeNumber(currentClient.fund_balance_usd, 0) + excessUsd),
        })
        .eq('id', clientId);

      if (updateClientFundError) {
        throw new Error(updateClientFundError.message);
      }

      const { error: fundMovementError } = await supabase
        .from('client_fund_movements')
        .insert({
          client_id: clientId,
          movement_type: 'credit',
          currency_code: input.confirmedCurrency,
          amount: nativeAmount,
          amount_usd: excessUsd,
          money_account_id: input.confirmedMoneyAccountId,
          order_id: orderId,
          payment_report_id: input.reportId,
          reason_code: 'payment_overage_stored',
          notes,
          created_by_user_id: user.id,
        });

      if (fundMovementError) {
        throw new Error(fundMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'close_difference') {
      if (!getMasterDashboardPermissions(roles).isAdmin) {
        throw new Error('Solo admin puede cerrar excedentes por redondeo.');
      }

      if (excessUsd > ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD) {
        throw new Error(
          `Solo se pueden cerrar diferencias de hasta ${ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD.toFixed(2)} USD.`
        );
      }

      const extraFields =
        currentOrder.extra_fields &&
        typeof currentOrder.extra_fields === 'object' &&
        !Array.isArray(currentOrder.extra_fields)
          ? ({ ...currentOrder.extra_fields } as Record<string, any>)
          : {};

      const pricing =
        extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
          ? { ...extraFields.pricing }
          : {};

      const payment =
        extraFields.payment && typeof extraFields.payment === 'object' && !Array.isArray(extraFields.payment)
          ? { ...extraFields.payment }
          : {};

      const fxRate = toSafeNumber(pricing.fx_rate, 0);
      const nextTotalUsd = Number(confirmedPaidUsd.toFixed(2));
      const nextTotalBs =
        fxRate > 0
          ? Number((nextTotalUsd * fxRate).toFixed(2))
          : currentTotalUsd > 0
            ? Number(((currentTotalBs / currentTotalUsd) * nextTotalUsd).toFixed(2))
            : currentTotalBs;

      pricing.total_usd = nextTotalUsd;
      pricing.total_bs = nextTotalBs;
      pricing.rounding_gain_closed_usd = excessUsd;
      pricing.rounding_gain_close_applied_at = new Date().toISOString();
      pricing.rounding_gain_close_applied_by = user.id;

      payment.rounding_gain_close = {
        closed_balance_usd: excessUsd,
        previous_total_usd: Number(currentTotalUsd.toFixed(2)),
        next_total_usd: nextTotalUsd,
        applied_at: new Date().toISOString(),
        applied_by: user.id,
        notes,
      };

      extraFields.pricing = pricing;
      extraFields.payment = payment;

      const { error: updateOrderError } = await supabase
        .from('orders')
        .update({
          total_usd: nextTotalUsd,
          total_bs_snapshot: nextTotalBs,
          extra_fields: extraFields,
          last_modified_at: new Date().toISOString(),
          last_modified_by: user.id,
        })
        .eq('id', orderId);

      if (updateOrderError) {
        throw new Error(updateOrderError.message);
      }

      const { error: adjustmentError } = await supabase
        .from('order_admin_adjustments')
        .insert({
          order_id: orderId,
          order_item_id: null,
          adjustment_type: 'other',
          reason: 'Cierre de excedente por redondeo',
          notes,
          payload: {
            kind: 'rounding_gain_close',
            delta_usd: excessUsd,
            original_unit_price_usd: Number(currentTotalUsd.toFixed(2)),
            override_unit_price_usd: nextTotalUsd,
            product_name: 'Cierre por redondeo',
            qty: 1,
            closed_balance_usd: excessUsd,
            previous_total_usd: Number(currentTotalUsd.toFixed(2)),
            previous_total_bs: Number(currentTotalBs.toFixed(2)),
            confirmed_paid_usd: Number(confirmedPaidUsd.toFixed(2)),
            next_total_usd: nextTotalUsd,
            next_total_bs: nextTotalBs,
            payment_report_id: input.reportId,
          },
          created_by_user_id: user.id,
        });

      if (adjustmentError) {
        throw new Error(adjustmentError.message);
      }
    }
  }
  */

  revalidatePath('/app/master/dashboard');
}

export async function updateInventoryItemAction(input: {
  inventoryItemId: number;
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  isActive: boolean;
  notes: string | null;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const inventoryItemId = Number(input.inventoryItemId);
  if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
    throw new Error('Item de inventario inválido.');
  }

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del item es obligatorio.');
  if (!['raw_material', 'prepared_base', 'finished_stock', 'packaging'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }
  if (!['raw', 'fried', 'prefried', 'sauces', 'packaging', 'other'].includes(input.inventoryGroup)) {
    throw new Error('Grupo de inventario inválido.');
  }

  const { error } = await supabase
    .from('inventory_items')
    .update({
      name,
      inventory_kind: input.inventoryKind,
      unit_name: String(input.unitName || '').trim() || 'pieza',
      packaging_name: String(input.packagingName || '').trim() || null,
      packaging_size:
        input.packagingSize == null ? null : Math.max(0, toSafeNumber(input.packagingSize, 0)),
      current_stock_units: Math.max(0, toSafeNumber(input.currentStockUnits, 0)),
      low_stock_threshold:
        input.lowStockThreshold == null ? null : Math.max(0, toSafeNumber(input.lowStockThreshold, 0)),
      inventory_group: input.inventoryGroup,
      is_active: !!input.isActive,
      notes: String(input.notes || '').trim() || null,
    })
    .eq('id', inventoryItemId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function toggleInventoryItemActiveAction(input: {
  inventoryItemId: number;
  nextIsActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const inventoryItemId = Number(input.inventoryItemId);
  if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
    throw new Error('Item de inventario inválido.');
  }

  const { error } = await supabase
    .from('inventory_items')
    .update({ is_active: !!input.nextIsActive })
    .eq('id', inventoryItemId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

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
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const inventoryItemId = toSafeNumber(input.inventoryItemId, 0);
  const recipeId = input.recipeId == null ? null : toSafeNumber(input.recipeId, 0);
  const outputQuantityUnits = toSafeNumber(input.outputQuantityUnits, 0);

  if (inventoryItemId <= 0) throw new Error('Item de inventario invalido.');
  if (recipeId != null && recipeId <= 0) throw new Error('Receta invalida.');
  if (!['production', 'packaging'].includes(input.recipeKind)) {
    throw new Error('Tipo de receta invalido.');
  }
  if (!Number.isFinite(outputQuantityUnits) || outputQuantityUnits <= 0) {
    throw new Error('La salida de la receta debe ser mayor a 0.');
  }

  const normalizedComponents = (input.components ?? [])
    .map((component, index) => ({
      inputInventoryItemId: toSafeNumber(component.inputInventoryItemId, 0),
      quantityUnits: toSafeNumber(component.quantityUnits, 0),
      sortOrder: toSafeNumber(component.sortOrder, index + 1),
    }))
    .filter(
      (component) =>
        component.inputInventoryItemId > 0 &&
        component.inputInventoryItemId !== inventoryItemId &&
        Number.isFinite(component.quantityUnits) &&
        component.quantityUnits > 0
    )
    .map((component, index) => ({
      ...component,
      sortOrder: component.sortOrder > 0 ? component.sortOrder : index + 1,
    }));

  if (normalizedComponents.length === 0) {
    throw new Error('Agrega al menos un insumo a la receta.');
  }

  let nextRecipeId = recipeId;

  if (nextRecipeId) {
    const { data, error } = await supabase
      .from('inventory_recipes')
      .update({
        recipe_kind: input.recipeKind,
        output_quantity_units: outputQuantityUnits,
        notes: input.notes?.trim() ? input.notes.trim() : null,
        is_active: true,
      })
      .eq('id', nextRecipeId)
      .eq('output_inventory_item_id', inventoryItemId)
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    if (!data?.id) throw new Error('No se pudo actualizar la receta.');
    nextRecipeId = Number(data.id);

    const { error: deleteError } = await supabase
      .from('inventory_recipe_components')
      .delete()
      .eq('recipe_id', nextRecipeId);

    if (deleteError) throw new Error(deleteError.message);
  } else {
    const { data, error } = await supabase
      .from('inventory_recipes')
      .insert({
        output_inventory_item_id: inventoryItemId,
        recipe_kind: input.recipeKind,
        output_quantity_units: outputQuantityUnits,
        notes: input.notes?.trim() ? input.notes.trim() : null,
        is_active: true,
      })
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    if (!data?.id) throw new Error('No se pudo crear la receta.');
    nextRecipeId = Number(data.id);
  }

  const { error: insertComponentsError } = await supabase
    .from('inventory_recipe_components')
    .insert(
      normalizedComponents.map((component) => ({
        recipe_id: nextRecipeId,
        input_inventory_item_id: component.inputInventoryItemId,
        quantity_units: component.quantityUnits,
        sort_order: component.sortOrder,
      }))
    );

  if (insertComponentsError) throw new Error(insertComponentsError.message);

  revalidatePath('/app/master/dashboard');
  return { recipeId: nextRecipeId };
}

export async function createDeliveryPartnerAction(input: {
  name: string;
  partnerType: string;
  whatsappPhone: string;
  isActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del partner es obligatorio.');
  const partnerType =
    String(input.partnerType || '').trim() === 'direct_driver'
      ? 'direct_driver'
      : 'company_dispatch';

  const { data, error } = await supabase
    .from('delivery_partners')
    .insert({
      name,
      partner_type: partnerType,
      whatsapp_phone: normalizePhone(String(input.whatsappPhone || '')) || null,
      is_active: !!input.isActive,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  if (!data?.id) {
    throw new Error('No se pudo crear el partner externo.');
  }
  revalidatePath('/app/master/dashboard');
}

export async function updateDeliveryPartnerAction(input: {
  partnerId: number;
  name: string;
  partnerType: string;
  whatsappPhone: string;
  isActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const partnerId = Number(input.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    throw new Error('Partner inválido.');
  }

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del partner es obligatorio.');
  const partnerType =
    String(input.partnerType || '').trim() === 'direct_driver'
      ? 'direct_driver'
      : 'company_dispatch';

  const { data, error } = await supabase
    .from('delivery_partners')
    .update({
      name,
      partner_type: partnerType,
      whatsapp_phone: normalizePhone(String(input.whatsappPhone || '')) || null,
      is_active: !!input.isActive,
    })
    .eq('id', partnerId)
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  if (!data?.id) {
    throw new Error('No se pudo actualizar el partner externo.');
  }
  revalidatePath('/app/master/dashboard');
}

export async function toggleDeliveryPartnerActiveAction(input: {
  partnerId: number;
  nextIsActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const partnerId = Number(input.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    throw new Error('Partner inválido.');
  }

  const { error } = await supabase
    .from('delivery_partners')
    .update({ is_active: !!input.nextIsActive })
    .eq('id', partnerId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function loadDeliveryPartnerRatesAction() {
  const { supabase } = await requireMasterOrAdmin();

  const { data, error } = await supabase
    .from('delivery_partner_rates')
    .select('id, partner_id, km_from, km_to, price_usd, is_active, created_at')
    .order('partner_id', { ascending: true })
    .order('km_from', { ascending: true });

  if (error) throw new Error(error.message);

  const rates = ((data ?? []) as any[]).map((row) => ({
    id: Number(row.id),
    partnerId: Number(row.partner_id),
    kmFrom: toSafeNumber(row.km_from, 0),
    kmTo: row.km_to == null ? null : toSafeNumber(row.km_to, 0),
    priceUsd: toSafeNumber(row.price_usd, 0),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  }));

  return { rates };
}

export async function createDeliveryPartnerRateAction(input: {
  partnerId: number;
  kmFrom: number;
  kmTo: number | null;
  priceUsd: number;
  isActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const partnerId = Number(input.partnerId);
  const kmFrom = Number(input.kmFrom);
  const kmTo = input.kmTo == null ? null : Number(input.kmTo);
  const priceUsd = Number(input.priceUsd);

  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    throw new Error('Partner invalido.');
  }
  if (!Number.isFinite(kmFrom) || kmFrom < 0) {
    throw new Error('Km desde invalido.');
  }
  if (kmTo != null && (!Number.isFinite(kmTo) || kmTo < kmFrom)) {
    throw new Error('Km hasta invalido.');
  }
  if (!Number.isFinite(priceUsd) || priceUsd < 0) {
    throw new Error('Tarifa invalida.');
  }

  const { data, error } = await supabase
    .from('delivery_partner_rates')
    .insert({
      partner_id: partnerId,
      km_from: kmFrom,
      km_to: kmTo,
      price_usd: priceUsd,
      is_active: !!input.isActive,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  if (!data?.id) {
    throw new Error('No se pudo crear la tarifa.');
  }
  revalidatePath('/app/master/dashboard');
}

export async function updateDeliveryPartnerRateAction(input: {
  rateId: number;
  kmFrom: number;
  kmTo: number | null;
  priceUsd: number;
  isActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const rateId = Number(input.rateId);
  const kmFrom = Number(input.kmFrom);
  const kmTo = input.kmTo == null ? null : Number(input.kmTo);
  const priceUsd = Number(input.priceUsd);

  if (!Number.isFinite(rateId) || rateId <= 0) {
    throw new Error('Tarifa invalida.');
  }
  if (!Number.isFinite(kmFrom) || kmFrom < 0) {
    throw new Error('Km desde invalido.');
  }
  if (kmTo != null && (!Number.isFinite(kmTo) || kmTo < kmFrom)) {
    throw new Error('Km hasta invalido.');
  }
  if (!Number.isFinite(priceUsd) || priceUsd < 0) {
    throw new Error('Tarifa invalida.');
  }

  const { data, error } = await supabase
    .from('delivery_partner_rates')
    .update({
      km_from: kmFrom,
      km_to: kmTo,
      price_usd: priceUsd,
      is_active: !!input.isActive,
    })
    .eq('id', rateId)
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  if (!data?.id) {
    throw new Error('No se pudo actualizar la tarifa.');
  }
  revalidatePath('/app/master/dashboard');
}

export async function toggleDeliveryPartnerRateActiveAction(input: {
  rateId: number;
  nextIsActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const rateId = Number(input.rateId);
  if (!Number.isFinite(rateId) || rateId <= 0) {
    throw new Error('Tarifa invalida.');
  }

  const { error } = await supabase
    .from('delivery_partner_rates')
    .update({ is_active: !!input.nextIsActive })
    .eq('id', rateId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

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
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  if (!getMasterDashboardPermissions(roles).isAdmin) {
    throw new Error('Solo admin puede crear ajustes administrativos.');
  }

  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  const kind = String(input.kind || '').trim();
  if (!['advisor_change', 'client_change', 'schedule_change'].includes(kind)) {
    throw new Error('Tipo de ajuste inválido.');
  }

  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new Error('Debes indicar el motivo del ajuste.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, client_id, attributed_advisor_id, extra_fields')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown> = { kind };
  const updatePayload: Record<string, unknown> = {
    last_modified_at: nowIso,
    last_modified_by: user.id,
  };

  if (kind === 'advisor_change') {
    const nextAdvisorUserId = String(input.nextAdvisorUserId || '').trim();
    if (!nextAdvisorUserId) {
      throw new Error('Debes seleccionar el nuevo asesor.');
    }

    updatePayload.attributed_advisor_id = nextAdvisorUserId;
    payload.previous_advisor_user_id = currentOrder.attributed_advisor_id ?? null;
    payload.next_advisor_user_id = nextAdvisorUserId;
  }

  if (kind === 'client_change') {
    const nextClientId = Number(input.nextClientId || 0);
    if (!Number.isFinite(nextClientId) || nextClientId <= 0) {
      throw new Error('Debes seleccionar el nuevo cliente.');
    }

    updatePayload.client_id = nextClientId;
    payload.previous_client_id = currentOrder.client_id ?? null;
    payload.next_client_id = nextClientId;
  }

  if (kind === 'schedule_change') {
    const nextDate = String(input.nextDeliveryDate || '').trim();
    const nextHour12 = String(input.nextDeliveryHour12 || '').trim();
    const nextMinute = String(input.nextDeliveryMinute || '').trim();
    const nextAmPm = input.nextDeliveryAmPm;

    if (!nextDate || !nextHour12 || !nextMinute || (nextAmPm !== 'AM' && nextAmPm !== 'PM')) {
      throw new Error('Debes completar la nueva fecha y hora.');
    }

    const nextTime24 = from12hTo24h(nextHour12, nextMinute, nextAmPm);
    const currentExtraFields =
      currentOrder.extra_fields && typeof currentOrder.extra_fields === 'object' && !Array.isArray(currentOrder.extra_fields)
        ? (currentOrder.extra_fields as Record<string, unknown>)
        : {};

    updatePayload.extra_fields = {
      ...currentExtraFields,
      schedule: {
        date: nextDate,
        time_12: `${nextHour12}:${pad2(Number(nextMinute || 0))} ${nextAmPm}`,
        time_24: nextTime24,
      },
    };

    payload.previous_schedule =
      currentExtraFields.schedule && typeof currentExtraFields.schedule === 'object'
        ? currentExtraFields.schedule
        : null;
    payload.next_schedule = {
      date: nextDate,
      time_12: `${nextHour12}:${pad2(Number(nextMinute || 0))} ${nextAmPm}`,
      time_24: nextTime24,
    };
  }

  const { error: updateOrderError } = await supabase
    .from('orders')
    .update(updatePayload)
    .eq('id', orderId);

  if (updateOrderError) {
    throw new Error(updateOrderError.message);
  }

  const { error: adjustmentError } = await supabase
    .from('order_admin_adjustments')
    .insert({
      order_id: orderId,
      order_item_id: null,
      adjustment_type: 'other',
      reason,
      notes: String(input.notes || '').trim() || null,
      payload,
      created_by_user_id: user.id,
    });

  if (adjustmentError) {
    throw new Error(adjustmentError.message);
  }

  revalidatePath('/app/master/dashboard');
  return { id: orderId };
}

export async function closeOrderRoundingBalanceAction(input: {
  orderId: number;
  notes?: string | null;
}) {
  try {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  if (!getMasterDashboardPermissions(roles).canCloseOrderRoundingBalance) {
    throw new Error('No tienes permiso para cerrar diferencias de redondeo.');
  }

  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, total_usd, total_bs_snapshot, extra_fields')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (currentOrder.status === 'cancelled') {
    throw new Error('No puedes cerrar diferencias en una orden cancelada.');
  }

  const { data: orderMovements, error: orderMovementsError } = await supabase
    .from('money_movements')
    .select('direction, amount_usd_equivalent')
    .eq('order_id', orderId)
    .eq('status', 'confirmed');

  if (orderMovementsError) {
    throw new Error(orderMovementsError.message);
  }

  const confirmedPaidUsd = roundMoney((orderMovements ?? []).reduce(
    (sum, row) =>
      sum +
      toSafeNumber(row.amount_usd_equivalent, 0) *
        (row.direction === 'outflow' ? -1 : 1),
    0
  ));

  const currentTotalUsd = getEffectiveOrderTotalUsd(currentOrder);
  const currentTotalBs = getEffectiveOrderTotalBs(currentOrder);
  const pendingUsd = roundMoney(Math.max(0, currentTotalUsd - confirmedPaidUsd));

  if (pendingUsd <= 0.005) {
    throw new Error('Esta orden ya no tiene una diferencia pendiente por cerrar.');
  }

  if (pendingUsd > ORDER_ROUNDING_SHORTFALL_CLOSE_MAX_USD) {
    throw new Error(
      `Solo se pueden cerrar diferencias de hasta ${ORDER_ROUNDING_SHORTFALL_CLOSE_MAX_USD.toFixed(2)} USD.`
    );
  }

  const extraFields =
    currentOrder.extra_fields &&
    typeof currentOrder.extra_fields === 'object' &&
    !Array.isArray(currentOrder.extra_fields)
      ? ({ ...currentOrder.extra_fields } as Record<string, any>)
      : {};

  const pricing =
    extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
      ? { ...extraFields.pricing }
      : {};

  const payment =
    extraFields.payment && typeof extraFields.payment === 'object' && !Array.isArray(extraFields.payment)
      ? { ...extraFields.payment }
      : {};

  const fxRate = toSafeNumber(pricing.fx_rate, 0);
  const nextTotalUsd = roundMoney(confirmedPaidUsd);
  const nextTotalBs =
    fxRate > 0
      ? Number((nextTotalUsd * fxRate).toFixed(2))
      : currentTotalUsd > 0
        ? Number(((currentTotalBs / currentTotalUsd) * nextTotalUsd).toFixed(2))
        : currentTotalBs;

  const nowIso = new Date().toISOString();
  const roundedPendingUsd = roundMoney(pendingUsd);

  pricing.total_usd = nextTotalUsd;
  pricing.total_bs = nextTotalBs;
  pricing.rounding_closed_usd = roundedPendingUsd;
  pricing.rounding_close_applied_at = nowIso;
  pricing.rounding_close_applied_by = user.id;

  payment.rounding_close = {
    closed_balance_usd: roundedPendingUsd,
    previous_total_usd: Number(currentTotalUsd.toFixed(2)),
    next_total_usd: nextTotalUsd,
    applied_at: nowIso,
    applied_by: user.id,
    notes: String(input.notes || '').trim() || null,
  };

  extraFields.pricing = pricing;
  extraFields.payment = payment;

  const { error: updateOrderError } = await supabase
    .from('orders')
    .update({
      total_usd: nextTotalUsd,
      total_bs_snapshot: nextTotalBs,
      extra_fields: extraFields,
      last_modified_at: nowIso,
      last_modified_by: user.id,
    })
    .eq('id', orderId);

  if (updateOrderError) {
    throw new Error(updateOrderError.message);
  }

  const { error: adjustmentError } = await supabase
    .from('order_admin_adjustments')
    .insert({
      order_id: orderId,
      order_item_id: null,
      adjustment_type: 'other',
      reason: 'Cierre de diferencia por redondeo',
      notes: String(input.notes || '').trim() || null,
      payload: {
        kind: 'rounding_writeoff',
        delta_usd: -roundedPendingUsd,
        original_unit_price_usd: Number(currentTotalUsd.toFixed(2)),
        override_unit_price_usd: nextTotalUsd,
        product_name: 'Cierre por redondeo',
        qty: 1,
        closed_balance_usd: roundedPendingUsd,
        previous_total_usd: Number(currentTotalUsd.toFixed(2)),
        previous_total_bs: Number(currentTotalBs.toFixed(2)),
        confirmed_paid_usd: Number(confirmedPaidUsd.toFixed(2)),
        next_total_usd: nextTotalUsd,
        next_total_bs: nextTotalBs,
      },
      created_by_user_id: user.id,
    });

  if (adjustmentError) {
    console.warn('rounding adjustment audit insert skipped', adjustmentError.message);
  }

  revalidatePath('/app/master/dashboard');
  return { ok: true, id: orderId, auditWarning: adjustmentError?.message ?? null };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Error cerrando la diferencia por redondeo.',
    };
  }
}

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

export async function createClientAction(input: {
  fullName: string;
  phone: string;
  notes: string;
  primaryAdvisorId: string | null;
  clientType: string;
  isActive: boolean;
  birthDate: string;
  importantDate: string;
  billingCompanyName: string;
  billingTaxId: string;
  billingAddress: string;
  billingPhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  recentAddresses: Array<{ addressText: string; gpsUrl: string }>;
  crmTags: string[];
}) {
  const { supabase } = await requireMasterOrAdmin();

  const fullName = String(input.fullName || '').trim();
  if (!fullName) throw new Error('El nombre del cliente es obligatorio.');

  const phone = normalizePhone(String(input.phone || ''));
  const billingPhone = normalizePhone(String(input.billingPhone || ''));
  const deliveryNotePhone = normalizePhone(String(input.deliveryNotePhone || ''));

  if (phone) {
    const { data: existingClients, error: existingClientError } = await supabase
      .from('clients')
      .select('id, full_name')
      .or(buildClientPhoneOrFilters(phone).join(','))
      .limit(1);

    if (existingClientError) throw new Error(existingClientError.message);
    const existingClient = existingClients?.[0];
    if (existingClient) {
      throw new Error(`Ya existe un cliente con este telefono: ${existingClient.full_name ?? `#${existingClient.id}`}.`);
    }
  }

  const { data: createdClient, error } = await supabase.from('clients').insert({
    full_name: fullName,
    phone: phone || null,
    notes: String(input.notes || '').trim() || null,
    primary_advisor_id: input.primaryAdvisorId || null,
    client_type: String(input.clientType || '').trim() || null,
    is_active: !!input.isActive,
    birth_date: String(input.birthDate || '').trim() || null,
    important_date: String(input.importantDate || '').trim() || null,
    billing_company_name: String(input.billingCompanyName || '').trim() || null,
    billing_tax_id: String(input.billingTaxId || '').trim() || null,
    billing_address: String(input.billingAddress || '').trim() || null,
    billing_phone: billingPhone || null,
    delivery_note_name: String(input.deliveryNoteName || '').trim() || null,
    delivery_note_document_id: String(input.deliveryNoteDocumentId || '').trim() || null,
    delivery_note_address: String(input.deliveryNoteAddress || '').trim() || null,
    delivery_note_phone: deliveryNotePhone || null,
    recent_addresses: normalizeRecentAddresses(input.recentAddresses),
    crm_tags: normalizeTagList(input.crmTags),
  }).select(`
    id,
    full_name,
    phone,
    notes,
    primary_advisor_id,
    created_at,
    client_type,
    is_active,
    birth_date,
    important_date,
    billing_company_name,
    billing_tax_id,
    billing_address,
    billing_phone,
    delivery_note_name,
    delivery_note_document_id,
    delivery_note_address,
    delivery_note_phone,
    recent_addresses,
    crm_tags,
    extra_fields,
    fund_balance_usd,
    updated_at
  `).single();

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');

  return createdClient;
}

export async function searchClientsAction(input: {
  query: string;
  limit?: number;
  includeRecentWhenEmpty?: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();
  const query = normalizeRemoteSearchValue(input.query);
  const includeRecentWhenEmpty = Boolean(input.includeRecentWhenEmpty);

  if (query.length < 2 && !includeRecentWhenEmpty) {
    return [];
  }

  const limit = Math.max(1, Math.min(120, Math.floor(Number(input.limit ?? 15) || 15)));

  if (query.length >= 2) {
    const { data: accentSafeClients, error: accentSafeError } = await supabase.rpc('search_clients_unaccent', {
      p_query: query,
      p_limit: limit,
    });

    if (!accentSafeError && Array.isArray(accentSafeClients)) {
      return accentSafeClients;
    }
  }

  const pattern = `%${query}%`;
  const phonePatterns = getPhoneSearchTerms(query)
    .map((term) => term.replace(/[,%]/g, ' '))
    .filter(Boolean)
    .slice(0, 5)
    .map((term) => `phone.ilike.%${term}%`);

  let clientsQuery = supabase
    .from('clients')
    .select(`
      id,
      full_name,
      phone,
      notes,
      primary_advisor_id,
      created_at,
      client_type,
      is_active,
      birth_date,
      important_date,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses,
      crm_tags,
      extra_fields,
      fund_balance_usd,
      updated_at
    `)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (query.length >= 2) {
    clientsQuery = clientsQuery.or(
      [
        `full_name.ilike.${pattern}`,
        `phone.ilike.${pattern}`,
        ...phonePatterns,
        `billing_company_name.ilike.${pattern}`,
        `billing_tax_id.ilike.${pattern}`,
        `delivery_note_name.ilike.${pattern}`,
      ].join(',')
    );
  }

  const { data, error } = await clientsQuery;

  if (error) throw new Error(error.message);

  return data ?? [];
}

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

export async function searchMasterOrdersAction(input: { query: string; limit?: number }) {
  const { supabase } = await requireMasterOrAdmin();
  const query = normalizeRemoteSearchValue(input.query);

  if (query.length < 2) {
    return [];
  }

  const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit ?? 10) || 10)));
  const { data, error } = await supabase.rpc('search_master_orders', {
    p_query: query,
    p_limit: limit,
  });

  if (error) throw new Error(error.message);

  return (data ?? []).map((order: Record<string, unknown>) => ({
    id: Number(order.id),
    orderNumber: String(order.order_number || order.id),
    matchPriority: Number(order.match_priority ?? Number.MAX_SAFE_INTEGER),
    status: String(order.status || ''),
    fulfillment: String(order.fulfillment || ''),
    clientName: String(order.client_name || 'Sin cliente'),
    clientPhone: order.client_phone ? String(order.client_phone) : null,
    advisorName: String(order.advisor_name || ''),
    totalUsd: getEffectiveOrderTotalUsd(order),
    totalBs: getEffectiveOrderTotalBs(order),
    createdAt: String(order.created_at || ''),
    operationalDate: getOrderOperationalDate(order),
  }));
}

export async function loadClientStatsAction() {
  const { supabase } = await requireMasterOrAdmin();

  const [
    { count: total, error: totalError },
    { count: active, error: activeError },
  ] = await Promise.all([
    supabase.from('clients').select('id', { count: 'exact', head: true }),
    supabase.from('clients').select('id', { count: 'exact', head: true }).eq('is_active', true),
  ]);

  if (totalError) throw new Error(totalError.message);
  if (activeError) throw new Error(activeError.message);

  return {
    total: total ?? 0,
    active: active ?? 0,
  };
}

export async function getClientFundSnapshotAction(input: { clientId: number }) {
  const { supabase } = await requireMasterOrAdmin();
  const clientId = Number(input.clientId || 0);

  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error('Cliente invalido.');
  }

  const { data, error } = await supabase
    .from('clients')
    .select('id, fund_balance_usd, updated_at')
    .eq('id', clientId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('No se encontro el cliente.');

  return {
    id: Number(data.id),
    fund_balance_usd: data.fund_balance_usd,
    updated_at: data.updated_at ?? null,
  };
}

export async function createOrderClientQuickAction(input: {
  fullName: string;
  phone: string;
  clientType: 'assigned' | 'own' | 'legacy';
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const fullName = String(input.fullName || '').trim();
  const phone = normalizePhone(String(input.phone || ''));

  if (!fullName) {
    throw new Error('Debes colocar el nombre del cliente.');
  }

  if (!phone) {
    throw new Error('Debes colocar el teléfono del cliente.');
  }

  const { data: existingClients, error: existingClientError } = await supabase
    .from('clients')
    .select(`
      id,
      full_name,
      phone,
      notes,
      primary_advisor_id,
      created_at,
      client_type,
      is_active,
      birth_date,
      important_date,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses,
      crm_tags,
      extra_fields,
      fund_balance_usd,
      updated_at
    `)
    .or(buildClientPhoneOrFilters(phone).join(','))
    .limit(1);

  if (existingClientError) {
    throw new Error(existingClientError.message);
  }

  const existingClient = existingClients?.[0];
  if (existingClient) {
    return { client: existingClient, alreadyExisted: true };
  }

  const { data: createdClient, error: createClientError } = await supabase
    .from('clients')
    .insert({
      full_name: fullName,
      phone,
      client_type: input.clientType,
    })
    .select(`
      id,
      full_name,
      phone,
      notes,
      primary_advisor_id,
      created_at,
      client_type,
      is_active,
      birth_date,
      important_date,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses,
      crm_tags,
      extra_fields,
      fund_balance_usd,
      updated_at
    `)
    .single();

  if (createClientError) {
    console.error('createOrderClientQuickAction insert failed', {
      fullName,
      phone,
      clientType: input.clientType,
      message: createClientError.message,
    });
    throw new Error(createClientError.message);
  }

  revalidatePath('/app/master/dashboard');

  return { client: createdClient, alreadyExisted: false };
}

export async function updateClientAction(input: {
  clientId: number;
  fullName: string;
  phone: string;
  notes: string;
  primaryAdvisorId: string | null;
  clientType: string;
  isActive: boolean;
  birthDate: string;
  importantDate: string;
  billingCompanyName: string;
  billingTaxId: string;
  billingAddress: string;
  billingPhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  recentAddresses: Array<{ addressText: string; gpsUrl: string }>;
  crmTags: string[];
}) {
  const { supabase } = await requireMasterOrAdmin();

  const clientId = Number(input.clientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error('Cliente inválido.');
  }

  const fullName = String(input.fullName || '').trim();
  if (!fullName) throw new Error('El nombre del cliente es obligatorio.');

  const phone = normalizePhone(String(input.phone || ''));
  const billingPhone = normalizePhone(String(input.billingPhone || ''));
  const deliveryNotePhone = normalizePhone(String(input.deliveryNotePhone || ''));

  if (phone) {
    const { data: existingClients, error: existingClientError } = await supabase
      .from('clients')
      .select('id, full_name')
      .or(buildClientPhoneOrFilters(phone).join(','))
      .neq('id', clientId)
      .limit(1);

    if (existingClientError) throw new Error(existingClientError.message);
    const existingClient = existingClients?.[0];
    if (existingClient) {
      throw new Error(`Este telefono ya pertenece a ${existingClient.full_name ?? `cliente #${existingClient.id}`}.`);
    }
  }

  const { error } = await supabase
    .from('clients')
    .update({
      full_name: fullName,
      phone: phone || null,
      notes: String(input.notes || '').trim() || null,
      primary_advisor_id: input.primaryAdvisorId || null,
      client_type: String(input.clientType || '').trim() || null,
      is_active: !!input.isActive,
      birth_date: String(input.birthDate || '').trim() || null,
      important_date: String(input.importantDate || '').trim() || null,
      billing_company_name: String(input.billingCompanyName || '').trim() || null,
      billing_tax_id: String(input.billingTaxId || '').trim() || null,
      billing_address: String(input.billingAddress || '').trim() || null,
      billing_phone: billingPhone || null,
      delivery_note_name: String(input.deliveryNoteName || '').trim() || null,
      delivery_note_document_id: String(input.deliveryNoteDocumentId || '').trim() || null,
      delivery_note_address: String(input.deliveryNoteAddress || '').trim() || null,
      delivery_note_phone: deliveryNotePhone || null,
      recent_addresses: normalizeRecentAddresses(input.recentAddresses),
      crm_tags: normalizeTagList(input.crmTags),
    })
    .eq('id', clientId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function toggleClientActiveAction(input: {
  clientId: number;
  nextIsActive: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const clientId = Number(input.clientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error('Cliente inválido.');
  }

  const { error } = await supabase
    .from('clients')
    .update({ is_active: !!input.nextIsActive })
    .eq('id', clientId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

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
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
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
  if (!['raw', 'fried', 'prefried', 'sauces', 'packaging', 'other'].includes(input.inventoryGroup)) {
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

export async function createCatalogItemAction(input: Parameters<typeof createCatalogItemActionImpl>[0]) {
  try {
    const result = await createCatalogItemActionImpl(input);
    return { ok: true as const, id: result.id };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'No se pudo crear el item de catalogo.',
    };
  }
}

export async function duplicateCatalogItemAction(input: {
  sourceProductId: number;
  sku?: string | null;
  name: string;
}) {
  try {
    const { supabase, roles } = await requireMasterOrAdmin();
    requireAdminRole(roles);

    const sourceProductId = toSafeNumber(input.sourceProductId, 0);
    const name = String(input.name || '').trim();
    const requestedSku = String(input.sku || '').trim().toUpperCase();

    if (sourceProductId <= 0) {
      throw new Error('Selecciona el producto que quieres copiar.');
    }
    if (!name) {
      throw new Error('El nombre del nuevo producto es obligatorio.');
    }

    const { data: source, error: sourceError } = await supabase
      .from('products')
      .select(`
        id,
        sku,
        name,
        type,
        source_price_amount,
        source_price_currency,
        base_price_usd,
        base_price_bs,
        units_per_service,
        is_active,
        is_detail_editable,
        detail_units_limit,
        is_inventory_item,
        is_temporary,
        is_combo_component_selectable,
        commission_mode,
        commission_value,
        commission_notes,
        extra_fields,
        internal_rider_pay_usd,
        inventory_enabled,
        inventory_kind,
        inventory_deduction_mode,
        inventory_unit_name,
        packaging_name,
        packaging_size,
        low_stock_threshold,
        inventory_group
      `)
      .eq('id', sourceProductId)
      .single();

    if (sourceError || !source) {
      throw new Error(sourceError?.message || 'No se pudo cargar el producto base.');
    }

    async function ensureUniqueSku(baseSku: string) {
      const normalized = baseSku.trim().toUpperCase();
      if (!normalized) {
        throw new Error('El SKU es obligatorio.');
      }

      const { data: existingSku, error: existingSkuError } = await supabase
        .from('products')
        .select('id')
        .eq('sku', normalized)
        .maybeSingle();

      if (existingSkuError) throw new Error(existingSkuError.message);
      if (!existingSku) return normalized;

      if (requestedSku) {
        throw new Error('Ya existe un producto con ese SKU.');
      }

      for (let index = 2; index <= 99; index += 1) {
        const candidate = `${normalized}-${index}`;
        const { data: candidateExists, error: candidateError } = await supabase
          .from('products')
          .select('id')
          .eq('sku', candidate)
          .maybeSingle();

        if (candidateError) throw new Error(candidateError.message);
        if (!candidateExists) return candidate;
      }

      throw new Error('No se pudo generar un SKU disponible para la copia.');
    }

    const sourceSku = String(source.sku || '').trim().toUpperCase();
    const copySku = await ensureUniqueSku(requestedSku || `${sourceSku || 'ITEM'}-COPY`);

    const { data: createdProduct, error: createError } = await supabase
      .from('products')
      .insert({
        sku: copySku,
        name,
        type: source.type,
        source_price_amount: toSafeNumber(source.source_price_amount, 0),
        source_price_currency: source.source_price_currency === 'USD' ? 'USD' : 'VES',
        base_price_usd: toSafeNumber(source.base_price_usd, 0),
        base_price_bs: toSafeNumber(source.base_price_bs, 0),
        units_per_service: toSafeNumber(source.units_per_service, 0),
        is_active: !!source.is_active,
        is_detail_editable: !!source.is_detail_editable,
        detail_units_limit: toSafeNumber(source.detail_units_limit, 0),
        is_inventory_item: !!source.is_inventory_item,
        is_temporary: !!source.is_temporary,
        is_combo_component_selectable: !!source.is_combo_component_selectable,
        commission_mode: source.commission_mode || 'default',
        commission_value: source.commission_value == null ? null : toSafeNumber(source.commission_value, 0),
        commission_notes: source.commission_notes || null,
        extra_fields:
          source.extra_fields && typeof source.extra_fields === 'object' && !Array.isArray(source.extra_fields)
            ? source.extra_fields
            : {},
        internal_rider_pay_usd:
          source.internal_rider_pay_usd == null ? null : toSafeNumber(source.internal_rider_pay_usd, 0),
        inventory_enabled: !!source.inventory_enabled,
        inventory_kind: source.inventory_kind || 'finished_good',
        inventory_deduction_mode: source.inventory_deduction_mode || 'self',
        inventory_unit_name: String(source.inventory_unit_name || 'pieza').trim() || 'pieza',
        packaging_name: source.packaging_name || null,
        packaging_size: source.packaging_size == null ? null : toSafeNumber(source.packaging_size, 0),
        current_stock_units: 0,
        low_stock_threshold: source.low_stock_threshold == null ? null : toSafeNumber(source.low_stock_threshold, 0),
        inventory_group: source.inventory_group || 'other',
      })
      .select('id')
      .single();

    if (createError || !createdProduct) {
      throw new Error(createError?.message || 'No se pudo crear la copia del producto.');
    }

    const newProductId = Number(createdProduct.id);

    const { data: sourceComponents, error: componentsError } = await supabase
      .from('product_components')
      .select('component_product_id, component_mode, quantity, counts_toward_detail_limit, is_required, sort_order, notes')
      .eq('parent_product_id', sourceProductId)
      .order('sort_order', { ascending: true });

    if (componentsError) {
      throw new Error(componentsError.message);
    }

    if ((sourceComponents ?? []).length > 0) {
      const { error: insertComponentsError } = await supabase.from('product_components').insert(
        (sourceComponents ?? []).map((row) => ({
          parent_product_id: newProductId,
          component_product_id: Number(row.component_product_id),
          component_mode: row.component_mode === 'selectable' ? 'selectable' : 'fixed',
          quantity: toSafeNumber(row.quantity, 0),
          counts_toward_detail_limit: !!row.counts_toward_detail_limit,
          is_required: !!row.is_required,
          sort_order: toSafeNumber(row.sort_order, 1),
          notes: row.notes || null,
        }))
      );

      if (insertComponentsError) {
        throw new Error(insertComponentsError.message);
      }
    }

    const { data: sourceInventoryLinks, error: inventoryLinksError } = await supabase
      .from('product_inventory_links')
      .select('inventory_item_id, deduction_mode, quantity_units, sort_order, notes, is_active')
      .eq('product_id', sourceProductId)
      .order('sort_order', { ascending: true });

    if (inventoryLinksError) {
      throw new Error(inventoryLinksError.message);
    }

    if (source.inventory_deduction_mode === 'self') {
      const selfInventoryItemId = await syncInventoryItemFromCatalogProduct(supabase, {
        nextName: name,
        isActive: !!source.is_active,
        inventoryEnabled: !!source.inventory_enabled,
        isInventoryItem: !!source.is_inventory_item,
        inventoryDeductionMode: 'self',
        inventoryKind: source.inventory_kind || 'finished_good',
        inventoryUnitName: String(source.inventory_unit_name || 'pieza'),
        packagingName: source.packaging_name || null,
        packagingSize: source.packaging_size == null ? null : toSafeNumber(source.packaging_size, 0),
        currentStockUnits: 0,
        lowStockThreshold: source.low_stock_threshold == null ? null : toSafeNumber(source.low_stock_threshold, 0),
        inventoryGroup: source.inventory_group || 'other',
      });

      await replaceProductInventoryLinks(supabase, {
        productId: newProductId,
        inventoryDeductionMode: 'self',
        selfInventoryItemId,
        inventoryLinks: [],
      });
    } else if ((sourceInventoryLinks ?? []).length > 0) {
      await replaceProductInventoryLinks(supabase, {
        productId: newProductId,
        inventoryDeductionMode: 'composition',
        inventoryLinks: (sourceInventoryLinks ?? [])
          .filter((row) => row.deduction_mode !== 'self_link' && row.is_active !== false)
          .map((row, index) => ({
            inventoryItemId: Number(row.inventory_item_id),
            quantityUnits: toSafeNumber(row.quantity_units, 0),
            notes: row.notes || null,
            sortOrder: toSafeNumber(row.sort_order, index + 1),
          })),
      });
    }

    revalidatePath('/app/master/dashboard');
    return { ok: true as const, id: newProductId, sku: copySku };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'No se pudo copiar el item de catalogo.',
    };
  }
}

export async function toggleCatalogItemActiveAction(input: {
  productId: number;
  nextIsActive: boolean;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const { error } = await supabase
    .from('products')
    .update({
      is_active: input.nextIsActive,
    })
    .eq('id', input.productId);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/app/master/dashboard');
}

export async function createMoneyTransferAction(input: {
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
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const sourceMoneyAccountId = Number(input.sourceMoneyAccountId || 0);
  const targetMoneyAccountId = Number(input.targetMoneyAccountId || 0);
  const sourceAmount = Number(input.sourceAmount || 0);
  const targetAmount = Number(input.targetAmount || 0);
  const feeAmount = Number(input.feeAmount || 0);
  const movementDate = String(input.movementDate || '').trim();
  const referenceCode = String(input.referenceCode || '').trim() || null;
  const counterpartyName = String(input.counterpartyName || '').trim() || null;
  const description = String(input.description || '').trim() || 'Traspaso entre cuentas';
  const notes = String(input.notes || '').trim() || null;

  if (!Number.isFinite(sourceMoneyAccountId) || sourceMoneyAccountId <= 0) {
    throw new Error('Debes seleccionar la cuenta origen.');
  }

  if (!Number.isFinite(targetMoneyAccountId) || targetMoneyAccountId <= 0) {
    throw new Error('Debes seleccionar la cuenta destino.');
  }

  if (sourceMoneyAccountId === targetMoneyAccountId) {
    throw new Error('La cuenta origen y destino deben ser distintas.');
  }

  if (!Number.isFinite(sourceAmount) || sourceAmount <= 0) {
    throw new Error('El monto de salida debe ser mayor a 0.');
  }

  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    throw new Error('El monto de entrada debe ser mayor a 0.');
  }

  if (!Number.isFinite(feeAmount) || feeAmount < 0) {
    throw new Error('La comisión no es válida.');
  }

  if (!movementDate) {
    throw new Error('Debes indicar la fecha del traspaso.');
  }

  const { data: accounts, error: accountsError } = await supabase
    .from('money_accounts')
    .select('id, currency_code, is_active')
    .in('id', [sourceMoneyAccountId, targetMoneyAccountId]);

  if (accountsError) throw new Error(accountsError.message);

  const sourceAccount = (accounts ?? []).find((account) => Number(account.id) === sourceMoneyAccountId);
  const targetAccount = (accounts ?? []).find((account) => Number(account.id) === targetMoneyAccountId);

  if (!sourceAccount || !targetAccount) {
    throw new Error('No se pudieron cargar las cuentas del traspaso.');
  }

  if (!sourceAccount.is_active || !targetAccount.is_active) {
    throw new Error('Ambas cuentas deben estar activas.');
  }

  const sourceCurrency = String(sourceAccount.currency_code || '').toUpperCase();
  const targetCurrency = String(targetAccount.currency_code || '').toUpperCase();
  if (!['USD', 'VES'].includes(sourceCurrency) || !['USD', 'VES'].includes(targetCurrency)) {
    throw new Error('Las monedas de las cuentas no son válidas.');
  }

  const sourceExchangeRate = sourceCurrency === 'VES' ? Number(input.sourceExchangeRateVesPerUsd || 0) : null;
  const targetExchangeRate = targetCurrency === 'VES' ? Number(input.targetExchangeRateVesPerUsd || 0) : null;

  if (sourceCurrency === 'VES' && (!Number.isFinite(sourceExchangeRate ?? NaN) || (sourceExchangeRate ?? 0) <= 0)) {
    throw new Error('Debes indicar la tasa de la cuenta origen.');
  }

  if (targetCurrency === 'VES' && (!Number.isFinite(targetExchangeRate ?? NaN) || (targetExchangeRate ?? 0) <= 0)) {
    throw new Error('Debes indicar la tasa de la cuenta destino.');
  }

  const sourceAmountUsdEquivalent =
    sourceCurrency === 'USD'
      ? Number(sourceAmount.toFixed(2))
      : Number((sourceAmount / (sourceExchangeRate ?? 1)).toFixed(2));
  const targetAmountUsdEquivalent =
    targetCurrency === 'USD'
      ? Number(targetAmount.toFixed(2))
      : Number((targetAmount / (targetExchangeRate ?? 1)).toFixed(2));
  const feeAmountUsdEquivalent =
    sourceCurrency === 'USD' ? Number(feeAmount.toFixed(2)) : Number((feeAmount / (sourceExchangeRate ?? 1)).toFixed(2));
  const groupId = crypto.randomUUID();
  const now = new Date().toISOString();
  const requiresApproval = requiresAdminMovementApproval(
    roles,
    'outflow',
    Number((sourceAmountUsdEquivalent + feeAmountUsdEquivalent).toFixed(2))
  );
  const movementStatus = requiresApproval ? 'pending' : 'confirmed';
  const confirmedAt = requiresApproval ? null : now;
  const approvalReason = requiresApproval
    ? `Traspaso igual o mayor a ${MASTER_OUTFLOW_ADMIN_APPROVAL_MIN_USD.toFixed(2)} USD requiere aprobación admin.`
    : null;

  const movementRows = [
    {
      movement_date: movementDate,
      created_by_user_id: user.id,
      confirmed_at: confirmedAt,
      confirmed_by_user_id: requiresApproval ? null : user.id,
      status: movementStatus,
      approval_required: requiresApproval,
      approval_required_reason: approvalReason,
      direction: 'outflow',
      movement_type: 'withdrawal',
      money_account_id: sourceMoneyAccountId,
      currency_code: sourceCurrency,
      amount: Number(sourceAmount.toFixed(2)),
      exchange_rate_ves_per_usd: sourceCurrency === 'VES' ? sourceExchangeRate : null,
      amount_usd_equivalent: sourceAmountUsdEquivalent,
      reference_code: referenceCode,
      counterparty_name: counterpartyName,
      description: `Traspaso salida · ${description}`,
      notes,
      order_id: null,
      payment_report_id: null,
      movement_group_id: groupId,
    },
    {
      movement_date: movementDate,
      created_by_user_id: user.id,
      confirmed_at: confirmedAt,
      confirmed_by_user_id: requiresApproval ? null : user.id,
      status: movementStatus,
      approval_required: requiresApproval,
      approval_required_reason: approvalReason,
      direction: 'inflow',
      movement_type: 'other_income',
      money_account_id: targetMoneyAccountId,
      currency_code: targetCurrency,
      amount: Number(targetAmount.toFixed(2)),
      exchange_rate_ves_per_usd: targetCurrency === 'VES' ? targetExchangeRate : null,
      amount_usd_equivalent: targetAmountUsdEquivalent,
      reference_code: referenceCode,
      counterparty_name: counterpartyName,
      description: `Traspaso entrada · ${description}`,
      notes,
      order_id: null,
      payment_report_id: null,
      movement_group_id: groupId,
    },
  ];

  if (feeAmount > 0) {
    movementRows.push({
      movement_date: movementDate,
      created_by_user_id: user.id,
      confirmed_at: confirmedAt,
      confirmed_by_user_id: requiresApproval ? null : user.id,
      status: movementStatus,
      approval_required: requiresApproval,
      approval_required_reason: approvalReason,
      direction: 'outflow',
      movement_type: 'fee_charge',
      money_account_id: sourceMoneyAccountId,
      currency_code: sourceCurrency,
      amount: Number(feeAmount.toFixed(2)),
      exchange_rate_ves_per_usd: sourceCurrency === 'VES' ? sourceExchangeRate : null,
      amount_usd_equivalent: feeAmountUsdEquivalent,
      reference_code: referenceCode,
      counterparty_name: counterpartyName,
      description: `Comisión · ${description}`,
      notes,
      order_id: null,
      payment_report_id: null,
      movement_group_id: groupId,
    });
  }

  const { error } = await supabase.from('money_movements').insert(movementRows);

  if (error) throw new Error(error.message);

  if (requiresApproval) {
    await notifyAdminMoneyApproval({
      title: 'Traspaso pendiente de aprobacion',
      body: `${description} · ${Number((sourceAmountUsdEquivalent + feeAmountUsdEquivalent).toFixed(2)).toFixed(2)} USD requiere revision admin.`,
      tag: `admin-money-transfer-${groupId}`,
    });
  }

  revalidatePath('/app/master/dashboard');
}

export async function approveMoneyMovementGroupAction(input: {
  movementId: number;
  movementGroupId: string | null;
}) {
  const { user, roles } = await requireMasterOrAdmin();
  if (!getMasterDashboardPermissions(roles).isAdmin) {
    return { ok: false as const, message: 'Solo admin puede aprobar movimientos pendientes.' };
  }
  const supabase = createSupabaseServiceRoleServer();

  const movementId = Number(input.movementId || 0);
  const movementGroupId = String(input.movementGroupId || '').trim() || null;
  if ((!Number.isFinite(movementId) || movementId <= 0) && !movementGroupId) {
    throw new Error('Movimiento inválido.');
  }

  const now = new Date().toISOString();
  const updatePayload = {
    status: 'confirmed',
    confirmed_at: now,
    confirmed_by_user_id: user.id,
    approval_required: false,
    approval_required_reason: null,
    reviewed_at: now,
    reviewed_by_user_id: user.id,
    rejected_at: null,
    rejected_by_user_id: null,
    rejection_reason: null,
  };

  const query = supabase.from('money_movements').update(updatePayload).eq('status', 'pending');
  const { data, error } = movementGroupId
    ? await query.eq('movement_group_id', movementGroupId).select('id')
    : await query.eq('id', movementId).select('id');

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    return { ok: false as const, message: 'No hubo movimientos pendientes disponibles para aprobar.' };
  }

  revalidatePath('/app/master/dashboard');
  return { ok: true as const, movementIds: data.map((movement) => movement.id) };
}

export async function rejectMoneyMovementGroupAction(input: {
  movementId: number;
  movementGroupId: string | null;
  reason: string;
}) {
  const { user, roles } = await requireMasterOrAdmin();
  if (!getMasterDashboardPermissions(roles).isAdmin) {
    return { ok: false as const, message: 'Solo admin puede rechazar movimientos pendientes.' };
  }
  const supabase = createSupabaseServiceRoleServer();

  const movementId = Number(input.movementId || 0);
  const movementGroupId = String(input.movementGroupId || '').trim() || null;
  if ((!Number.isFinite(movementId) || movementId <= 0) && !movementGroupId) {
    throw new Error('Movimiento inválido.');
  }

  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new Error('Debes indicar el motivo del rechazo.');
  }

  const now = new Date().toISOString();
  const updatePayload = {
    status: 'rejected',
    approval_required: false,
    approval_required_reason: null,
    reviewed_at: now,
    reviewed_by_user_id: user.id,
    rejected_at: now,
    rejected_by_user_id: user.id,
    rejection_reason: reason,
  };

  const query = supabase.from('money_movements').update(updatePayload).eq('status', 'pending');
  const { data, error } = movementGroupId
    ? await query.eq('movement_group_id', movementGroupId).select('id')
    : await query.eq('id', movementId).select('id');

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    return { ok: false as const, message: 'No hubo movimientos pendientes disponibles para rechazar.' };
  }

  revalidatePath('/app/master/dashboard');
  return { ok: true as const, movementIds: data.map((movement) => movement.id) };
}

export async function voidMoneyMovementGroupAction(input: {
  movementId: number;
  movementGroupId: string | null;
  reason: string;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  if (!getMasterDashboardPermissions(roles).isAdmin) {
    throw new Error('Solo admin puede anular movimientos financieros.');
  }

  const movementId = Number(input.movementId || 0);
  const movementGroupId = String(input.movementGroupId || '').trim() || null;
  if ((!Number.isFinite(movementId) || movementId <= 0) && !movementGroupId) {
    throw new Error('Movimiento invÃ¡lido.');
  }

  const reason = String(input.reason || '').trim();
  if (reason.length < 6) {
    throw new Error('Debes indicar un motivo claro para anular.');
  }

  const now = new Date().toISOString();
  const updatePayload = {
    status: 'voided',
    reviewed_at: now,
    reviewed_by_user_id: user.id,
    voided_at: now,
    voided_by_user_id: user.id,
    void_reason: reason,
  };

  const query = supabase
    .from('money_movements')
    .update(updatePayload)
    .in('status', ['pending', 'confirmed']);
  const { data, error } = movementGroupId
    ? await query.eq('movement_group_id', movementGroupId).select('id')
    : await query.eq('id', movementId).select('id');

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error('No hubo movimientos disponibles para anular.');
  }

  revalidatePath('/app/master/dashboard');
}

export async function voidFinancialMovementAction(input: {
  movementId: number;
  movementGroupId: string | null;
  reason: string;
}) {
  try {
    const { user, roles } = await requireMasterOrAdmin();
    if (!getMasterDashboardPermissions(roles).isAdmin) {
      return { ok: false as const, message: 'Solo admin puede anular movimientos financieros.' };
    }
    const supabase = createSupabaseServiceRoleServer();

    const movementId = Number(input.movementId || 0);
    const movementGroupId = String(input.movementGroupId || '').trim() || null;
    if ((!Number.isFinite(movementId) || movementId <= 0) && !movementGroupId) {
      return { ok: false as const, message: 'Movimiento invalido.' };
    }

    const reason = String(input.reason || '').trim();
    if (reason.length < 6) {
      return { ok: false as const, message: 'Debes indicar un motivo claro para anular.' };
    }

    const movementsQuery = supabase
      .from('money_movements')
      .select('id, payment_report_id, status, confirmed_at');
    const { data: movementsToVoid, error: movementsToVoidError } = movementGroupId
      ? await movementsQuery.eq('movement_group_id', movementGroupId)
      : await movementsQuery.eq('id', movementId);

    if (movementsToVoidError) throw new Error(movementsToVoidError.message);
    if (!movementsToVoid || movementsToVoid.length === 0) {
      return { ok: false as const, message: 'No hubo movimientos disponibles para anular.' };
    }

    const movementIds = movementsToVoid
      .filter((movement) => {
        const effectiveStatus = movement.status ?? (movement.confirmed_at ? 'confirmed' : 'pending');
        return ['pending', 'confirmed'].includes(String(effectiveStatus));
      })
      .map((movement) => Number(movement.id))
      .filter((id) => id > 0);
    const paymentReportIds = Array.from(
      new Set(
        movementsToVoid
          .map((movement) => Number(movement.payment_report_id || 0))
          .filter((id) => id > 0)
      )
    );

    if (movementIds.length > 0 && paymentReportIds.length > 0) {
      const { data: reportRows, error: reportRowsError } = await supabase
        .from('payment_reports')
        .select('id, order_id')
        .in('id', paymentReportIds);

      if (reportRowsError) throw new Error(reportRowsError.message);

      const orderIdByPaymentReportId = new Map<number, number>();
      for (const report of reportRows ?? []) {
        const reportId = Number(report.id || 0);
        const orderId = Number(report.order_id || 0);
        if (reportId > 0 && orderId > 0) orderIdByPaymentReportId.set(reportId, orderId);
      }

      const { data: fundCredits, error: fundCreditsError } = await supabase
        .from('client_fund_movements')
        .select('client_id, order_id, payment_report_id, amount_usd')
        .in('payment_report_id', paymentReportIds)
        .eq('movement_type', 'credit');

      if (fundCreditsError) throw new Error(fundCreditsError.message);

      const fundCreditGroups = new Map<
        string,
        {
          clientId: number;
          orderId: number | null;
          paymentReportId: number | null;
          amountUsd: number;
        }
      >();

      for (const credit of fundCredits ?? []) {
        const clientId = Number(credit.client_id || 0);
        const paymentReportId = Number(credit.payment_report_id || 0);
        const creditOrderId = Number(credit.order_id || 0);
        const orderId =
          creditOrderId > 0
            ? creditOrderId
            : orderIdByPaymentReportId.get(paymentReportId) ?? 0;
        const amountUsd = roundMoney(credit.amount_usd);
        if (!Number.isFinite(clientId) || clientId <= 0 || amountUsd <= 0) continue;

        const key = `${clientId}:${orderId || 0}:${paymentReportId || 0}`;
        const current = fundCreditGroups.get(key) ?? {
          clientId,
          orderId: orderId > 0 ? orderId : null,
          paymentReportId: paymentReportId > 0 ? paymentReportId : null,
          amountUsd: 0,
        };
        current.amountUsd = roundMoney(current.amountUsd + amountUsd);
        fundCreditGroups.set(key, current);
      }

      for (const creditGroup of fundCreditGroups.values()) {
        const { data: currentClient, error: currentClientError } = await supabase
          .from('clients')
          .select('id, fund_balance_usd')
          .eq('id', creditGroup.clientId)
          .single();

        if (currentClientError || !currentClient) {
          throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
        }

        const currentFundUsd = roundMoney(currentClient.fund_balance_usd);
        if (currentFundUsd + 0.0001 < creditGroup.amountUsd) {
          return {
            ok: false as const,
            message:
              'Este pago envio dinero al fondo, pero el cliente ya no tiene saldo suficiente para revertirlo automaticamente.',
          };
        }

        const { error: updateFundError } = await supabase
          .from('clients')
          .update({ fund_balance_usd: roundMoney(currentFundUsd - creditGroup.amountUsd) })
          .eq('id', creditGroup.clientId);

        if (updateFundError) throw new Error(updateFundError.message);

        const { error: fundMovementError } = await supabase
          .from('client_fund_movements')
          .insert({
            client_id: creditGroup.clientId,
            movement_type: 'debit',
            currency_code: 'USD',
            amount: creditGroup.amountUsd,
            amount_usd: creditGroup.amountUsd,
            money_account_id: null,
            order_id: creditGroup.orderId,
            payment_report_id: creditGroup.paymentReportId,
            reason_code: 'payment_void_fund_reversal',
            notes: `Reverso por anulacion financiera: ${reason}`,
            created_by_user_id: user.id,
          });

        if (fundMovementError) throw new Error(fundMovementError.message);
      }
    }

    const now = new Date().toISOString();

    let voidedMovementIds: number[] = [];
    if (movementIds.length > 0) {
      const { data: voidedRows, error: voidError } = await supabase
        .from('money_movements')
        .update({
          status: 'voided',
          reviewed_at: now,
          reviewed_by_user_id: user.id,
          voided_at: now,
          voided_by_user_id: user.id,
          void_reason: reason,
        })
        .in('id', movementIds)
        .select('id');

      if (voidError) throw new Error(voidError.message);
      voidedMovementIds = (voidedRows ?? [])
        .map((movement) => Number(movement.id))
        .filter((id) => id > 0);

      if (voidedMovementIds.length !== movementIds.length) {
        throw new Error(
          `La anulacion no se guardo completa en movimientos financieros (${voidedMovementIds.length}/${movementIds.length}).`
        );
      }
    }

    let rejectedPaymentReportIds: number[] = [];
    if (paymentReportIds.length > 0) {
      const { data: reportsToReject, error: reportsToRejectError } = await supabase
        .from('payment_reports')
        .select('id, notes')
        .in('id', paymentReportIds);

      if (reportsToRejectError) throw new Error(reportsToRejectError.message);

      const { data: rejectedRows, error: reportError } = await supabase
        .from('payment_reports')
        .update({
          status: 'rejected',
          confirmed_movement_id: null,
          reviewed_at: now,
          reviewed_by_user_id: user.id,
        })
        .in('id', paymentReportIds)
        .select('id');

      if (reportError) throw new Error(reportError.message);
      rejectedPaymentReportIds = (rejectedRows ?? [])
        .map((report) => Number(report.id))
        .filter((id) => id > 0);

      if (rejectedPaymentReportIds.length !== paymentReportIds.length) {
        throw new Error(
          `La anulacion no se guardo completa en reportes de pago (${rejectedPaymentReportIds.length}/${paymentReportIds.length}).`
        );
      }

      for (const report of reportsToReject ?? []) {
        const previousNotes = String(report.notes || '').trim();
        const voidNote = `Anulado desde cuentas: ${reason}`;
        const nextNotes = previousNotes ? `${previousNotes}\n${voidNote}` : voidNote;
        const { error: notesError } = await supabase
          .from('payment_reports')
          .update({ notes: nextNotes })
          .eq('id', Number(report.id));

        if (notesError) throw new Error(notesError.message);
      }
    }

    revalidatePath('/app/master/dashboard');
    return { ok: true as const, movementIds: voidedMovementIds, paymentReportIds: rejectedPaymentReportIds };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'No se pudo anular el movimiento.',
    };
  }
}

export async function createMoneyAccountClosureAction(input: {
  moneyAccountId: number;
  closureDate: string;
  closureTime?: string | null;
  countedAmount: number;
  exchangeRateVesPerUsd: number | null;
  targetMoneyAccountId?: number | null;
  reason: string;
  notes: string;
}) {
  try {
    const { user } = await requireMasterOrAdmin();
    const supabase = createSupabaseServiceRoleServer();

    const moneyAccountId = Number(input.moneyAccountId || 0);
    const closureDate = String(input.closureDate || '').trim();
    const closureAt = buildCaracasTimestamp(closureDate, input.closureTime);
    const closureAtMs = new Date(closureAt).getTime();
    const countedAmount = Number(input.countedAmount || 0);
    const reason = String(input.reason || '').trim() || null;
    const notes = String(input.notes || '').trim() || null;

  if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Cuenta invÃ¡lida.');
  }

  if (!closureDate) {
    throw new Error('Debes indicar la fecha del cierre.');
  }

  if (!Number.isFinite(countedAmount) || countedAmount < 0) {
    throw new Error('El monto contado no es vÃ¡lido.');
  }

  const { data: account, error: accountError } = await supabase
    .from('money_accounts')
    .select('id, name, currency_code')
    .eq('id', moneyAccountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message || 'No se pudo cargar la cuenta.');
  }

  const currencyCode = String(account.currency_code || '').toUpperCase();
  if (currencyCode !== 'USD' && currencyCode !== 'VES') {
    throw new Error('La moneda de la cuenta no es vÃ¡lida.');
  }

  const exchangeRate =
    currencyCode === 'VES' ? Number(input.exchangeRateVesPerUsd || 0) : null;
  if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate ?? NaN) || (exchangeRate ?? 0) <= 0)) {
    throw new Error('Debes indicar una tasa vÃ¡lida para cerrar una cuenta en Bs.');
  }

    const { data: existingActiveClosures, error: existingActiveClosureError } = await supabase
    .from('money_account_closures')
    .select('id')
    .eq('money_account_id', moneyAccountId)
    .eq('closure_at', closureAt)
    .in('status', ['recorded', 'approved'])
    .limit(1);

  if (existingActiveClosureError) throw new Error(existingActiveClosureError.message);
  if ((existingActiveClosures ?? []).length > 0) {
    throw new Error('Ya existe un cierre activo para esta cuenta en esa fecha y hora. Ajusta la hora o anula el cierre anterior.');
  }

  const { data: profile, error: profileError } = await supabase
    .from('money_account_closure_profiles')
    .select(
      'closure_kind, requires_zero_difference, allows_classified_difference, generates_transfer_on_close, default_target_money_account_id'
    )
    .eq('money_account_id', moneyAccountId)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);

  const { data: activeBaseline, error: baselineError } = await supabase
    .from('money_account_closure_baselines')
    .select('baseline_date, baseline_at, counted_amount, counted_amount_usd')
    .eq('money_account_id', moneyAccountId)
    .eq('status', 'active')
    .maybeSingle();

  if (baselineError) throw new Error(baselineError.message);

  const { data: previousClosure, error: previousClosureError } = await supabase
    .from('money_account_closures')
    .select('closure_date, closure_at, counted_amount, counted_amount_usd')
    .eq('money_account_id', moneyAccountId)
    .in('status', ['recorded', 'approved'])
    .lt('closure_at', closureAt)
    .order('closure_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (previousClosureError) throw new Error(previousClosureError.message);

  let movementsQuery = supabase
    .from('money_movements')
    .select('direction, amount, amount_usd_equivalent, movement_date, confirmed_at, created_at')
    .eq('money_account_id', moneyAccountId)
    .eq('status', 'confirmed')
    .lte('movement_date', closureDate);

  if (previousClosure?.closure_date) {
    movementsQuery = movementsQuery.gte('movement_date', previousClosure.closure_date);
  } else if (activeBaseline?.baseline_date) {
    movementsQuery = movementsQuery.gt('movement_date', activeBaseline.baseline_date);
  }

  const { data: movements, error: movementsError } = await movementsQuery;

  if (movementsError) throw new Error(movementsError.message);

  let expectedAmount = previousClosure
    ? toSafeNumber(previousClosure.counted_amount, 0)
    : activeBaseline
      ? toSafeNumber(activeBaseline.counted_amount, 0)
      : 0;
  let expectedAmountUsd = previousClosure
    ? toSafeNumber(previousClosure.counted_amount_usd, 0)
    : activeBaseline
      ? toSafeNumber(activeBaseline.counted_amount_usd, 0)
      : 0;
  const previousClosureDate = previousClosure?.closure_date ? String(previousClosure.closure_date) : null;
  const previousClosureAtMs = previousClosure?.closure_at ? new Date(previousClosure.closure_at).getTime() : null;

  for (const movement of movements ?? []) {
    const movementDate = String(movement.movement_date || '');
    const movementRecordedAtMs = getMovementRecordedAtMs(movement);

    if (movementDate > closureDate) continue;
    if (movementDate === closureDate && movementRecordedAtMs != null && movementRecordedAtMs > closureAtMs) continue;
    if (previousClosureDate) {
      if (movementDate < previousClosureDate) continue;
      if (
        movementDate === previousClosureDate &&
        previousClosureAtMs != null &&
        movementRecordedAtMs != null &&
        movementRecordedAtMs <= previousClosureAtMs
      ) {
        continue;
      }
    }

    const signed = movement.direction === 'inflow' ? 1 : -1;
    expectedAmount += signed * toSafeNumber(movement.amount, 0);
    expectedAmountUsd += signed * toSafeNumber(movement.amount_usd_equivalent, 0);
  }

  expectedAmount = Number(expectedAmount.toFixed(2));
  expectedAmountUsd = Number(expectedAmountUsd.toFixed(2));
  const countedAmountRounded = Number(countedAmount.toFixed(2));
  const countedAmountUsd =
    currencyCode === 'USD'
      ? countedAmountRounded
      : Number((countedAmountRounded / (exchangeRate ?? 1)).toFixed(2));
  const differenceAmount = Number((countedAmountRounded - expectedAmount).toFixed(2));
  const differenceAmountUsd = Number((countedAmountUsd - expectedAmountUsd).toFixed(2));

  if (Boolean(profile?.requires_zero_difference) && Math.abs(differenceAmount) > 0.009) {
    throw new Error('Esta cuenta debe cerrar con diferencia cero antes de registrar el cierre.');
  }

  const { data: insertedClosure, error } = await supabase.from('money_account_closures').insert({
    money_account_id: moneyAccountId,
    closure_date: closureDate,
    closure_at: closureAt,
    expected_amount: expectedAmount,
    counted_amount: countedAmountRounded,
    difference_amount: differenceAmount,
    expected_amount_usd: expectedAmountUsd,
    counted_amount_usd: countedAmountUsd,
    difference_amount_usd: differenceAmountUsd,
    currency_code: currencyCode,
    exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
    reason,
    notes,
    status: 'recorded',
    created_by_user_id: user.id,
  }).select('id').single();

  if (error) throw new Error(error.message);

  const closureId = Number(insertedClosure?.id || 0);
  const shouldCreateReconciliationItem =
    Boolean(profile?.allows_classified_difference) && Math.abs(differenceAmount) > 0.009;

  if (shouldCreateReconciliationItem) {
    const absoluteDifference = Math.abs(differenceAmount);
    const absoluteDifferenceUsd = Math.abs(differenceAmountUsd);
    const { error: reconciliationError } = await supabase.from('money_account_reconciliation_items').insert({
      money_account_id: moneyAccountId,
      source_kind: 'closure',
      source_id: closureId > 0 ? closureId : null,
      item_type: 'other_pending',
      direction: differenceAmount > 0 ? 'surplus' : 'shortage',
      currency_code: currencyCode,
      amount: absoluteDifference,
      amount_usd_equivalent: absoluteDifferenceUsd,
      operation_date: closureDate,
      reference_code: closureId > 0 ? `closure-${closureId}` : `closure-${moneyAccountId}-${closureDate}`,
      counterparty_name: null,
      description:
        differenceAmount > 0
          ? `Pendiente por identificar en cierre de ${account.name}`
          : `Faltante pendiente por explicar en cierre de ${account.name}`,
      status: 'open',
      created_by_user_id: user.id,
    });

    if (reconciliationError) throw new Error(reconciliationError.message);
  }

  revalidatePath('/app/master/dashboard');
  return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'No se pudo registrar el cierre.',
    };
  }
}

export async function previewMoneyAccountClosureAction(input: {
  moneyAccountId: number;
  closureDate: string;
  closureTime?: string | null;
}) {
  const { user } = await requireMasterOrAdmin();
  const supabase = createSupabaseServiceRoleServer();

  const moneyAccountId = Number(input.moneyAccountId || 0);
  const closureDate = String(input.closureDate || '').trim();
  const closureAt = buildCaracasTimestamp(closureDate, input.closureTime);
  const closureAtMs = new Date(closureAt).getTime();

  if (!user.id) {
    throw new Error('Sesion invalida.');
  }

  if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Cuenta invalida.');
  }

  if (!closureDate) {
    throw new Error('Debes indicar la fecha del cierre.');
  }

  const { data: account, error: accountError } = await supabase
    .from('money_accounts')
    .select('id, currency_code')
    .eq('id', moneyAccountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message || 'No se pudo cargar la cuenta.');
  }

  const { data: activeBaseline, error: baselineError } = await supabase
    .from('money_account_closure_baselines')
    .select('baseline_date, baseline_at, counted_amount, counted_amount_usd')
    .eq('money_account_id', moneyAccountId)
    .eq('status', 'active')
    .maybeSingle();

  if (baselineError) throw new Error(baselineError.message);

  const { data: previousClosure, error: previousClosureError } = await supabase
    .from('money_account_closures')
    .select('closure_date, closure_at, counted_amount, counted_amount_usd')
    .eq('money_account_id', moneyAccountId)
    .in('status', ['recorded', 'approved'])
    .lt('closure_at', closureAt)
    .order('closure_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (previousClosureError) throw new Error(previousClosureError.message);

  let movementsQuery = supabase
    .from('money_movements')
    .select('direction, amount, amount_usd_equivalent, movement_date, confirmed_at, created_at')
    .eq('money_account_id', moneyAccountId)
    .eq('status', 'confirmed')
    .lte('movement_date', closureDate);

  if (previousClosure?.closure_date) {
    movementsQuery = movementsQuery.gte('movement_date', previousClosure.closure_date);
  } else if (activeBaseline?.baseline_date) {
    movementsQuery = movementsQuery.gt('movement_date', activeBaseline.baseline_date);
  }

  const { data: movements, error: movementsError } = await movementsQuery;

  if (movementsError) throw new Error(movementsError.message);

  let expectedAmount = previousClosure
    ? toSafeNumber(previousClosure.counted_amount, 0)
    : activeBaseline
      ? toSafeNumber(activeBaseline.counted_amount, 0)
      : 0;
  let expectedAmountUsd = previousClosure
    ? toSafeNumber(previousClosure.counted_amount_usd, 0)
    : activeBaseline
      ? toSafeNumber(activeBaseline.counted_amount_usd, 0)
      : 0;
  const previousClosureDate = previousClosure?.closure_date ? String(previousClosure.closure_date) : null;
  const previousClosureAtMs = previousClosure?.closure_at ? new Date(previousClosure.closure_at).getTime() : null;

  for (const movement of movements ?? []) {
    const movementDate = String(movement.movement_date || '');
    const movementRecordedAtMs = getMovementRecordedAtMs(movement);

    if (movementDate > closureDate) continue;
    if (movementDate === closureDate && movementRecordedAtMs != null && movementRecordedAtMs > closureAtMs) continue;
    if (previousClosureDate) {
      if (movementDate < previousClosureDate) continue;
      if (
        movementDate === previousClosureDate &&
        previousClosureAtMs != null &&
        movementRecordedAtMs != null &&
        movementRecordedAtMs <= previousClosureAtMs
      ) {
        continue;
      }
    }

    const signed = movement.direction === 'inflow' ? 1 : -1;
    expectedAmount += signed * toSafeNumber(movement.amount, 0);
    expectedAmountUsd += signed * toSafeNumber(movement.amount_usd_equivalent, 0);
  }

  return {
    moneyAccountId,
    closureDate,
    closureAt,
    expectedAmount: Number(expectedAmount.toFixed(2)),
    expectedAmountUsd: Number(expectedAmountUsd.toFixed(2)),
    currencyCode: String(account.currency_code || '').toUpperCase(),
  };
}

export async function rejectMoneyAccountClosureAction(input: {
  closureId: number;
  reason: string;
}) {
  const { user, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);
  const supabase = createSupabaseServiceRoleServer();

  const closureId = Number(input.closureId || 0);
  const reason = String(input.reason || '').trim();

  if (!Number.isFinite(closureId) || closureId <= 0) {
    throw new Error('Cierre invalido.');
  }

  if (reason.length < 6) {
    throw new Error('Indica un motivo claro para anular el cierre.');
  }

  const { data: closure, error: closureError } = await supabase
    .from('money_account_closures')
    .select('id, status, notes')
    .eq('id', closureId)
    .single();

  if (closureError || !closure) {
    throw new Error(closureError?.message || 'No se pudo cargar el cierre.');
  }

  if (closure.status === 'rejected') {
    throw new Error('Este cierre ya esta anulado.');
  }

  const now = new Date().toISOString();
  const previousNotes = String(closure.notes || '').trim();
  const nextNotes = [previousNotes, `Anulado: ${reason}`].filter(Boolean).join('\n') || null;
  const transferReference = `closure-${closureId}`;

  const { error: movementError } = await supabase
    .from('money_movements')
    .update({
      status: 'voided',
      reviewed_by_user_id: user.id,
      reviewed_at: now,
      voided_by_user_id: user.id,
      voided_at: now,
      void_reason: `Cierre anulado: ${reason}`,
    })
    .eq('reference_code', transferReference)
    .neq('status', 'voided');

  if (movementError) throw new Error(movementError.message);

  const { error: updateError } = await supabase
    .from('money_account_closures')
    .update({
      status: 'rejected',
      reviewed_by_user_id: user.id,
      reviewed_at: now,
      notes: nextNotes,
    })
    .eq('id', closureId);

  if (updateError) throw new Error(updateError.message);

  revalidatePath('/app/master/dashboard');
}

export async function createMoneyAccountBaselineAction(input: {
  moneyAccountId: number;
  baselineDate: string;
  countedAmount: number;
  exchangeRateVesPerUsd: number | null;
  reason: string;
  notes: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const moneyAccountId = Number(input.moneyAccountId || 0);
  const baselineDate = String(input.baselineDate || '').trim();
  const countedAmount = Number(input.countedAmount || 0);
  const reason = String(input.reason || '').trim() || null;
  const notes = String(input.notes || '').trim() || null;

  if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Cuenta inválida.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(baselineDate)) {
    throw new Error('Debes indicar una fecha válida para la línea base.');
  }

  if (!Number.isFinite(countedAmount) || countedAmount < 0) {
    throw new Error('El saldo real no es válido.');
  }

  const { data: existingBaseline, error: existingBaselineError } = await supabase
    .from('money_account_closure_baselines')
    .select('id')
    .eq('money_account_id', moneyAccountId)
    .eq('status', 'active')
    .maybeSingle();

  if (existingBaselineError) throw new Error(existingBaselineError.message);
  if (existingBaseline) {
    throw new Error('Esta cuenta ya tiene una línea base activa.');
  }

  const { data: account, error: accountError } = await supabase
    .from('money_accounts')
    .select('id, currency_code')
    .eq('id', moneyAccountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message || 'No se pudo cargar la cuenta.');
  }

  const currencyCode = String(account.currency_code || '').toUpperCase();
  if (currencyCode !== 'USD' && currencyCode !== 'VES') {
    throw new Error('La moneda de la cuenta no es válida.');
  }

  const exchangeRate =
    currencyCode === 'VES' ? Number(input.exchangeRateVesPerUsd || 0) : null;
  if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate ?? NaN) || (exchangeRate ?? 0) <= 0)) {
    throw new Error('Debes indicar una tasa válida para una línea base en Bs.');
  }

  const { data: movements, error: movementsError } = await supabase
    .from('money_movements')
    .select('direction, amount, amount_usd_equivalent')
    .eq('money_account_id', moneyAccountId)
    .eq('status', 'confirmed')
    .lte('movement_date', baselineDate);

  if (movementsError) throw new Error(movementsError.message);

  let expectedAmount = 0;
  let expectedAmountUsd = 0;

  for (const movement of movements ?? []) {
    const signed = movement.direction === 'inflow' ? 1 : -1;
    expectedAmount += signed * toSafeNumber(movement.amount, 0);
    expectedAmountUsd += signed * toSafeNumber(movement.amount_usd_equivalent, 0);
  }

  expectedAmount = Number(expectedAmount.toFixed(2));
  expectedAmountUsd = Number(expectedAmountUsd.toFixed(2));
  const countedAmountRounded = Number(countedAmount.toFixed(2));
  const countedAmountUsd =
    currencyCode === 'USD'
      ? countedAmountRounded
      : Number((countedAmountRounded / (exchangeRate ?? 1)).toFixed(2));
  const differenceAmount = Number((countedAmountRounded - expectedAmount).toFixed(2));
  const differenceAmountUsd = Number((countedAmountUsd - expectedAmountUsd).toFixed(2));

  const { error } = await supabase.from('money_account_closure_baselines').insert({
    money_account_id: moneyAccountId,
    baseline_date: baselineDate,
    baseline_at: `${baselineDate}T23:59:59-04:00`,
    expected_amount: expectedAmount,
    counted_amount: countedAmountRounded,
    difference_amount: differenceAmount,
    expected_amount_usd: expectedAmountUsd,
    counted_amount_usd: countedAmountUsd,
    difference_amount_usd: differenceAmountUsd,
    currency_code: currencyCode,
    exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
    reason,
    notes,
    status: 'active',
    created_by_user_id: user.id,
  });

  if (error) throw new Error(error.message);

  revalidatePath('/app/master/dashboard');
}

export async function resolveMoneyAccountReconciliationItemAction(input: {
  itemId: number;
  resolutionNotes: string;
  resolutionMode?: 'note_only' | 'expense' | 'income' | 'fee' | 'adjustment';
  movementAmount?: number | null;
  exchangeRateVesPerUsd?: number | null;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();
  const itemId = Number(input.itemId || 0);
  const resolutionNotes = String(input.resolutionNotes || '').trim();
  const resolutionMode = input.resolutionMode ?? 'note_only';
  const movementAmount = Number(input.movementAmount || 0);

  if (!Number.isFinite(itemId) || itemId <= 0) {
    throw new Error('Pendiente de conciliaciÃ³n invÃ¡lido.');
  }

  if (!resolutionNotes) {
    throw new Error('Debes indicar una nota de resoluciÃ³n.');
  }

  if (!['note_only', 'expense', 'income', 'fee', 'adjustment'].includes(resolutionMode)) {
    throw new Error('Modo de resolucion invalido.');
  }

  const { data: item, error: itemError } = await supabase
    .from('money_account_reconciliation_items')
    .select(`
      id,
      money_account_id,
      item_type,
      direction,
      currency_code,
      amount,
      amount_usd_equivalent,
      operation_date,
      reference_code,
      counterparty_name,
      description,
      status
    `)
    .eq('id', itemId)
    .single();

  if (itemError || !item) {
    throw new Error(itemError?.message || 'No se pudo cargar el pendiente de conciliacion.');
  }

  if (item.status !== 'open') {
    throw new Error('Este pendiente ya no esta abierto.');
  }

  let movementSummary: string | null = null;

  if (resolutionMode !== 'note_only') {
    requireAdminRole(roles);

    if (!Number.isFinite(movementAmount) || movementAmount <= 0) {
      throw new Error('Debes indicar un monto de movimiento mayor a 0.');
    }

    const itemAmount = toSafeNumber(item.amount, 0);
    if (movementAmount > itemAmount + 0.01) {
      throw new Error('El monto del movimiento no puede superar el pendiente.');
    }

    const currencyCode = String(item.currency_code || '').toUpperCase();
    if (currencyCode !== 'USD' && currencyCode !== 'VES') {
      throw new Error('La moneda del pendiente no es valida.');
    }

    const exchangeRate =
      currencyCode === 'VES'
        ? Number(input.exchangeRateVesPerUsd || 0)
        : null;

    if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate ?? NaN) || (exchangeRate ?? 0) <= 0)) {
      throw new Error('Debes indicar una tasa valida para registrar el movimiento.');
    }

    const movementDirection =
      resolutionMode === 'income'
        ? 'inflow'
        : resolutionMode === 'expense' || resolutionMode === 'fee'
          ? 'outflow'
          : item.direction === 'surplus'
            ? 'inflow'
            : 'outflow';

    const movementType =
      resolutionMode === 'income'
        ? 'other_income'
        : resolutionMode === 'fee'
          ? 'fee_charge'
          : resolutionMode === 'adjustment'
            ? 'adjustment'
            : 'expense_payment';

    const amountUsdEquivalent =
      currencyCode === 'USD'
        ? Number(movementAmount.toFixed(2))
        : Number((movementAmount / (exchangeRate ?? 1)).toFixed(2));
    const itemUsdEquivalent = toSafeNumber(item.amount_usd_equivalent, 0);
    const remainingAmount = Number(Math.max(0, itemAmount - movementAmount).toFixed(2));
    const remainingUsdEquivalent = Number(Math.max(0, itemUsdEquivalent - amountUsdEquivalent).toFixed(2));

    const referenceCode = `reconciliation-${itemId}`;

    const { data: existingMovement, error: existingMovementError } = await supabase
      .from('money_movements')
      .select('id')
      .eq('money_account_id', Number(item.money_account_id))
      .eq('reference_code', referenceCode)
      .neq('status', 'voided')
      .limit(1);

    if (existingMovementError) throw new Error(existingMovementError.message);
    if ((existingMovement ?? []).length > 0) {
      throw new Error('Ya existe un movimiento activo con esa referencia de conciliacion.');
    }

    const movementLabel =
      resolutionMode === 'income'
        ? 'Ingreso por conciliacion'
        : resolutionMode === 'fee'
          ? 'Comision por conciliacion'
          : resolutionMode === 'adjustment'
            ? 'Ajuste por conciliacion'
            : 'Egreso por conciliacion';

    const { error: movementError } = await supabase.from('money_movements').insert({
      movement_date: item.operation_date || getCaracasDateString(new Date()),
      created_by_user_id: user.id,
      confirmed_at: new Date().toISOString(),
      confirmed_by_user_id: user.id,
      status: 'confirmed',
      approval_required: false,
      approval_required_reason: null,
      direction: movementDirection,
      movement_type: movementType,
      money_account_id: Number(item.money_account_id),
      currency_code: currencyCode,
      amount: Number(movementAmount.toFixed(2)),
      exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
      amount_usd_equivalent: amountUsdEquivalent,
      reference_code: referenceCode,
      counterparty_name: item.counterparty_name ?? null,
      description: `${movementLabel} #${itemId}`,
      notes: [
        resolutionNotes,
        item.reference_code ? `Referencia original: ${item.reference_code}` : null,
        item.description ? `Pendiente: ${item.description}` : null,
        `Pendiente de conciliacion #${itemId}.`,
      ].filter(Boolean).join('\n'),
      order_id: null,
      payment_report_id: null,
      movement_group_id: crypto.randomUUID(),
    });

    if (movementError) throw new Error(movementError.message);

    movementSummary = `${movementLabel}: ${Number(movementAmount.toFixed(2))} ${currencyCode}.`;

    if (remainingAmount > 0.01) {
      const { error: residualError } = await supabase.from('money_account_reconciliation_items').insert({
        money_account_id: Number(item.money_account_id),
        source_kind: 'reconciliation_residual',
        source_id: itemId,
        item_type: item.item_type ?? 'other_pending',
        direction: item.direction,
        currency_code: currencyCode,
        amount: remainingAmount,
        amount_usd_equivalent: remainingUsdEquivalent,
        operation_date: item.operation_date ?? null,
        reference_code: item.reference_code ?? null,
        counterparty_name: item.counterparty_name ?? null,
        description: `Saldo restante de conciliacion #${itemId}: ${item.description}`,
        status: 'open',
        created_by_user_id: user.id,
      });

      if (residualError) throw new Error(residualError.message);

      movementSummary = `${movementSummary}\nSaldo restante pendiente: ${remainingAmount} ${currencyCode}.`;
    }
  }

  const { error } = await supabase
    .from('money_account_reconciliation_items')
    .update({
      status: 'resolved',
      resolved_by_user_id: user.id,
      resolved_at: new Date().toISOString(),
      resolution_notes: [resolutionNotes, movementSummary].filter(Boolean).join('\n'),
    })
    .eq('id', itemId)
    .eq('status', 'open');

  if (error) throw new Error(error.message);

  revalidatePath('/app/master/dashboard');
}

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
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const inventoryItemId = toSafeNumber(input.inventoryItemId, 0);
  const quantityUnits = toSafeNumber(input.quantityUnits, 0);

  if (inventoryItemId <= 0) throw new Error('Item de inventario inválido.');
  if (!['inbound', 'damage', 'waste', 'manual_adjustment', 'stock_count'].includes(input.movementType)) {
    throw new Error('Movimiento inválido.');
  }
  if (!Number.isFinite(quantityUnits) || quantityUnits < 0) {
    throw new Error('Cantidad inválida.');
  }

  const { data: inventoryItem, error: inventoryItemError } = await supabase
    .from('inventory_items')
    .select('id, current_stock_units')
    .eq('id', inventoryItemId)
    .single();

  if (inventoryItemError || !inventoryItem) {
    throw new Error(inventoryItemError?.message || 'No se pudo cargar el item de inventario.');
  }

  const currentStock = toSafeNumber(inventoryItem.current_stock_units, 0);
  const signedDelta =
    input.movementType === 'inbound'
      ? quantityUnits
      : input.movementType === 'stock_count'
        ? quantityUnits - currentStock
        : -quantityUnits;

  const nextStock = currentStock + signedDelta;
  if (nextStock < 0) {
    throw new Error('El movimiento dejaría el inventario en negativo.');
  }

  const { error: movementError } = await supabase
    .from('inventory_movements')
    .insert({
      inventory_item_id: inventoryItemId,
      movement_type: input.movementType,
      quantity_units: quantityUnits,
      reason_code: input.reasonCode?.trim() ? input.reasonCode.trim() : null,
      notes: input.notes?.trim() ? input.notes.trim() : null,
      order_id: null,
      created_by_user_id: user.id,
    });

  if (movementError) throw new Error(movementError.message);

  const { error: stockError } = await supabase
    .from('inventory_items')
    .update({
      current_stock_units: nextStock,
    })
    .eq('id', inventoryItemId);

  if (stockError) throw new Error(stockError.message);

  revalidatePath('/app/master/dashboard');
}

export async function createInventoryProductionAction(input: {
  recipeId: number;
  batchMultiplier: number;
  notes: string | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const recipeId = toSafeNumber(input.recipeId, 0);
  const batchMultiplier = toSafeNumber(input.batchMultiplier, 0);

  if (recipeId <= 0) throw new Error('Receta inválida.');
  if (!Number.isFinite(batchMultiplier) || batchMultiplier <= 0) {
    throw new Error('La cantidad a producir es inválida.');
  }

  const { data: recipe, error: recipeError } = await supabase
    .from('inventory_recipes')
    .select('id, output_inventory_item_id, recipe_kind, output_quantity_units, notes, is_active')
    .eq('id', recipeId)
    .single();

  if (recipeError || !recipe) {
    throw new Error(recipeError?.message || 'No se pudo cargar la receta.');
  }

  if (!recipe.is_active) {
    throw new Error('La receta está inactiva.');
  }

  const { data: components, error: componentsError } = await supabase
    .from('inventory_recipe_components')
    .select('id, input_inventory_item_id, quantity_units, sort_order')
    .eq('recipe_id', recipeId)
    .order('sort_order', { ascending: true });

  if (componentsError) {
    throw new Error(componentsError.message);
  }

  if ((components ?? []).length === 0) {
    throw new Error('La receta no tiene componentes cargados.');
  }

  const inputInventoryItemIds = Array.from(
    new Set((components ?? []).map((component) => Number(component.input_inventory_item_id)).filter((id) => id > 0))
  );

  const allInventoryItemIds = Array.from(
    new Set([...inputInventoryItemIds, Number(recipe.output_inventory_item_id)])
  );

  const { data: inventoryItems, error: inventoryItemsError } = await supabase
    .from('inventory_items')
    .select('id, name, current_stock_units')
    .in('id', allInventoryItemIds);

  if (inventoryItemsError) {
    throw new Error(inventoryItemsError.message);
  }

  const inventoryItemById = new Map((inventoryItems ?? []).map((item) => [Number(item.id), item]));
  const outputInventoryItem = inventoryItemById.get(Number(recipe.output_inventory_item_id));

  if (!outputInventoryItem) {
    throw new Error('No se pudo cargar el item resultante.');
  }

  const componentRows = (components ?? []).map((component) => {
    const inputInventoryItemId = Number(component.input_inventory_item_id);
    const inputInventoryItem = inventoryItemById.get(inputInventoryItemId);
    const baseQuantity = toSafeNumber(component.quantity_units, 0);
    const quantityUnits = baseQuantity * batchMultiplier;

    if (!inputInventoryItem) {
      throw new Error('No se pudo cargar un insumo de la receta.');
    }

    const currentStock = toSafeNumber(inputInventoryItem.current_stock_units, 0);
    if (currentStock < quantityUnits) {
      throw new Error(`Stock insuficiente en ${inputInventoryItem.name}.`);
    }

    return {
      inventoryItemId: inputInventoryItemId,
      inventoryItemName: String(inputInventoryItem.name || 'Insumo'),
      quantityUnits,
      nextStock: currentStock - quantityUnits,
    };
  });

  const outputQuantityUnits = toSafeNumber(recipe.output_quantity_units, 0) * batchMultiplier;
  if (!Number.isFinite(outputQuantityUnits) || outputQuantityUnits <= 0) {
    throw new Error('La receta tiene una salida inválida.');
  }

  const outputCurrentStock = toSafeNumber(outputInventoryItem.current_stock_units, 0);
  const outputNextStock = outputCurrentStock + outputQuantityUnits;
  const notes = input.notes?.trim() || null;
  const recipeLabel = recipe.recipe_kind === 'packaging' ? 'Empaque' : 'Producción';

  for (const component of componentRows) {
    const { error: movementError } = await supabase
      .from('inventory_movements')
      .insert({
        inventory_item_id: component.inventoryItemId,
        movement_type: recipe.recipe_kind === 'packaging' ? 'pack_out' : 'production_out',
        quantity_units: component.quantityUnits,
        reason_code: 'recipe_output',
        notes:
          notes ??
          `${recipeLabel}: ${outputInventoryItem.name}`,
        order_id: null,
        created_by_user_id: user.id,
      });

    if (movementError) throw new Error(movementError.message);

    const { error: stockError } = await supabase
      .from('inventory_items')
      .update({ current_stock_units: component.nextStock })
      .eq('id', component.inventoryItemId);

    if (stockError) throw new Error(stockError.message);
  }

  const { error: outputMovementError } = await supabase
    .from('inventory_movements')
    .insert({
      inventory_item_id: Number(recipe.output_inventory_item_id),
      movement_type: recipe.recipe_kind === 'packaging' ? 'pack_in' : 'production_in',
      quantity_units: outputQuantityUnits,
      reason_code: 'recipe_output',
      notes:
        notes ??
        `${recipeLabel}: ${outputInventoryItem.name}`,
      order_id: null,
      created_by_user_id: user.id,
    });

  if (outputMovementError) throw new Error(outputMovementError.message);

  const { error: outputStockError } = await supabase
    .from('inventory_items')
    .update({ current_stock_units: outputNextStock })
    .eq('id', Number(recipe.output_inventory_item_id));

  if (outputStockError) throw new Error(outputStockError.message);

  revalidatePath('/app/master/dashboard');
}

export async function deleteCatalogItemAction(input: {
  productId: number;
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const productId = Number(input.productId);
  if (!Number.isFinite(productId) || productId <= 0) {
    throw new Error('Producto inválido.');
  }

  const { data: orderUse, error: orderUseError } = await supabase
    .from('order_items')
    .select('id')
    .eq('product_id', productId)
    .limit(1);

  if (orderUseError) {
    throw new Error(orderUseError.message);
  }

  if ((orderUse ?? []).length > 0) {
    throw new Error('No se puede eliminar: el producto ya fue usado en Órdenes.');
  }

  const { data: parentUse, error: parentUseError } = await supabase
    .from('product_components')
    .select('id')
    .eq('parent_product_id', productId)
    .limit(1);

  if (parentUseError) {
    throw new Error(parentUseError.message);
  }

  if ((parentUse ?? []).length > 0) {
    throw new Error('No se puede eliminar: el producto tiene composición cargada.');
  }

  const { data: componentUse, error: componentUseError } = await supabase
    .from('product_components')
    .select('id')
    .eq('component_product_id', productId)
    .limit(1);

  if (componentUseError) {
    throw new Error(componentUseError.message);
  }

  if ((componentUse ?? []).length > 0) {
    throw new Error('No se puede eliminar: el producto está siendo usado como componente de otro.');
  }

  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/app/master/dashboard');
}

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
    editableDetailLines: string[];
  }>;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  const source = input.source;
  const fulfillment = input.fulfillment;

  if (!['advisor', 'master', 'walk_in'].includes(source)) {
    throw new Error('Source inválido.');
  }

  if (!['pickup', 'delivery'].includes(fulfillment)) {
    throw new Error('Fulfillment inválido.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Debes agregar al menos un ítem.');
  }

  if (
    input.items.some((item) => item.adminPriceOverrideUsd != null) &&
    !getMasterDashboardPermissions(roles).isAdmin
  ) {
    throw new Error('Solo admin puede ajustar precios manualmente.');
  }

  if (source === 'advisor' && !input.attributedAdvisorUserId) {
    throw new Error('Debes seleccionar un asesor.');
  }

  if (fulfillment === 'delivery' && !input.deliveryAddress.trim()) {
    throw new Error('La dirección es obligatoria para delivery.');
  }

  if (fulfillment === 'delivery') {
    await assertDeliveryItemForOrder(supabase, input.items);
  }

  const deliveryTime24 = from12hTo24h(
    input.deliveryHour12,
    input.deliveryMinute,
    input.deliveryAmPm
  );

  const fxRate = Number(input.fxRate || 0);
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error('La tasa de la orden es inválida.');
  }

  let clientId = input.selectedClientId;

  if (!clientId) {
    const fullName = String(input.newClientName || '').trim();
    const phone = normalizePhone(input.newClientPhone || '');

    if (!fullName) {
      throw new Error('Nombre del cliente es obligatorio.');
    }

    if (!phone) {
      throw new Error('Teléfono del cliente es obligatorio.');
    }

    const { data: existingClients, error: existingClientError } = await supabase
      .from('clients')
      .select('id')
      .or(buildClientPhoneOrFilters(phone).join(','))
      .limit(1);

    if (existingClientError) {
      throw new Error(existingClientError.message);
    }

    const existingClient = existingClients?.[0];
    if (existingClient) {
      clientId = Number(existingClient.id);
    } else {
      const { data: createdClient, error: createClientError } = await supabase
        .from('clients')
        .insert({
          full_name: fullName,
          phone,
          client_type: input.newClientType,
        })
        .select('id')
        .single();

      if (createClientError) {
        throw new Error(createClientError.message);
      }

      clientId = Number(createdClient.id);
    }
  }

  if (!clientId) {
    throw new Error('No se pudo resolver el cliente.');
  }

  const { data: clientAddressData, error: clientAddressError } = await supabase
    .from('clients')
    .select('recent_addresses')
    .eq('id', clientId)
    .maybeSingle();

  if (clientAddressError) {
    throw new Error(clientAddressError.message);
  }

  const { data: clientProfile, error: updateClientProfileError } = await supabase
    .from('clients')
    .update({
      billing_company_name: input.hasInvoice
        ? String(input.invoiceCompanyName || '').trim() || null
        : null,
      billing_tax_id: input.hasInvoice
        ? String(input.invoiceTaxId || '').trim() || null
        : null,
      billing_address: input.hasInvoice
        ? String(input.invoiceAddress || '').trim() || null
        : null,
      billing_phone: input.hasInvoice
        ? normalizePhone(String(input.invoicePhone || '')) || null
        : null,
      delivery_note_name: input.hasDeliveryNote
        ? String(input.deliveryNoteName || '').trim() || null
        : null,
      delivery_note_document_id: input.hasDeliveryNote
        ? String(input.deliveryNoteDocumentId || '').trim() || null
        : null,
      delivery_note_address: input.hasDeliveryNote
        ? String(input.deliveryNoteAddress || '').trim() || null
        : null,
      delivery_note_phone: input.hasDeliveryNote
        ? normalizePhone(String(input.deliveryNotePhone || '')) || null
        : null,
      recent_addresses:
        fulfillment === 'delivery'
          ? mergeRecentAddresses(
              clientAddressData?.recent_addresses,
              input.deliveryAddress,
              input.deliveryGpsUrl
            )
          : clientAddressData?.recent_addresses ?? [],
    })
    .eq('id', clientId)
    .select(`
      full_name,
      phone,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses
    `)
    .single();

  if (updateClientProfileError) {
    console.error('createOrderAction client sync failed', {
      clientId,
      hasInvoice: input.hasInvoice,
      hasDeliveryNote: input.hasDeliveryNote,
      fulfillment,
      message: updateClientProfileError.message,
    });
    throw new Error(updateClientProfileError.message);
  }

  if (!clientProfile) {
    throw new Error('No se pudo confirmar la actualización del cliente.');
  }

  const attributedAdvisorId =
    source === 'advisor' ? input.attributedAdvisorUserId : user.id;

  if (!attributedAdvisorId) {
    throw new Error('No se pudo resolver el asesor atribuido.');
  }

  const fxRateNumber = Math.max(0, Number(input.fxRate || 0));

  const itemSnapshots = input.items.map((item) =>
    calculateOrderLineSnapshot({
      sourceCurrency: item.sourcePriceCurrency,
      sourceAmount: Number(item.sourcePriceAmount || 0),
      quantity: Number(item.qty || 0),
      fxRate: fxRateNumber,
      overrideUnitUsd: item.adminPriceOverrideCurrency ? null : item.adminPriceOverrideUsd,
      fallbackUnitUsd: Number(item.unitPriceUsdSnapshot || 0),
    })
  );

  const subtotalBs = itemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineBs, 0);
  const subtotalUsd = itemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineUsd, 0);

  const discountPctNumber = Math.max(
    0,
    Math.min(100, Number(input.discountPct || 0))
  );

  const invoiceTaxPctNumber = input.hasInvoice
    ? Math.max(0, Number(String(input.invoiceTaxPct || '16').replace(',', '.')) || 0)
    : 0;
  const totalsSnapshot = calculateOrderTotalsSnapshot({
    subtotalUsd,
    subtotalBs,
    discountPct: input.discountEnabled ? discountPctNumber : 0,
    invoiceTaxPct: invoiceTaxPctNumber,
  });
  const discountAmountUsd = totalsSnapshot.discountAmountUsd;
  const discountAmountBs = totalsSnapshot.discountAmountBs;
  const subtotalAfterDiscountUsd = totalsSnapshot.subtotalAfterDiscountUsd;
  const subtotalAfterDiscountBs = totalsSnapshot.subtotalAfterDiscountBs;
  const invoiceTaxAmountUsd = totalsSnapshot.invoiceTaxAmountUsd;
  const invoiceTaxAmountBs = totalsSnapshot.invoiceTaxAmountBs;
  const totalUsd = totalsSnapshot.totalUsd;
  const totalBs = totalsSnapshot.totalBs;

  const requestedClientFundUsd = Number(
    String(input.clientFundAmountUsd || '').replace(',', '.')
  );
  const clientFundUsedUsd = input.useClientFund
    ? Number(Math.max(0, Math.min(totalUsd, Number.isFinite(requestedClientFundUsd) ? requestedClientFundUsd : 0)).toFixed(2))
    : 0;

  const orderNumber = await generateUniqueOrderNumber(supabase);

  const extraFields = {
    schedule: {
      date: input.deliveryDate,
      time_12: `${input.deliveryHour12}:${pad2(Number(input.deliveryMinute || 0))} ${input.deliveryAmPm}`,
      time_24: deliveryTime24,
      asap: Boolean(input.isAsap),
    },
    receiver: {
      name: input.receiverName.trim() || null,
      phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
    },
    delivery: {
      address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
      gps_url: fulfillment === 'delivery' ? String(input.deliveryGpsUrl || '').trim() || null : null,
    },
    payment: {
      method: input.paymentMethod || null,
      currency: input.paymentCurrency || null,
      requires_change: !!input.paymentRequiresChange,
      change_for: input.paymentChangeFor.trim()
        ? Number(input.paymentChangeFor)
        : null,
      change_currency: input.paymentChangeCurrency || null,
      notes: input.paymentNote.trim() || null,
      client_fund_used_usd: clientFundUsedUsd > 0.005 ? clientFundUsedUsd : 0,
    },
    documents: {
      has_delivery_note: !!input.hasDeliveryNote,
      has_invoice: !!input.hasInvoice,
      invoice_data_note: input.invoiceDataNote.trim() || null,
      invoice_snapshot: input.hasInvoice
        ? {
            company_name: clientProfile?.billing_company_name ?? null,
            tax_id: clientProfile?.billing_tax_id ?? null,
            address: clientProfile?.billing_address ?? null,
            phone: clientProfile?.billing_phone ?? null,
          }
        : null,
      delivery_note_snapshot: input.hasDeliveryNote
        ? {
            name: clientProfile?.delivery_note_name ?? null,
            document_id: clientProfile?.delivery_note_document_id ?? null,
            address: clientProfile?.delivery_note_address ?? null,
            phone: clientProfile?.delivery_note_phone ?? null,
          }
        : null,
    },
    pricing: {
      fx_rate: fxRateNumber > 0 ? fxRateNumber : null,
      discount_enabled: !!input.discountEnabled,
      discount_pct: input.discountEnabled ? discountPctNumber : 0,
      discount_amount_usd: input.discountEnabled ? discountAmountUsd : 0,
      discount_amount_bs: input.discountEnabled ? discountAmountBs : 0,
      invoice_tax_pct: input.hasInvoice ? invoiceTaxPctNumber : 0,
      invoice_tax_amount_usd: input.hasInvoice ? invoiceTaxAmountUsd : 0,
      invoice_tax_amount_bs: input.hasInvoice ? invoiceTaxAmountBs : 0,
      subtotal_usd: subtotalUsd,
      subtotal_bs: subtotalBs,
      subtotal_after_discount_usd: subtotalAfterDiscountUsd,
      subtotal_after_discount_bs: subtotalAfterDiscountBs,
      total_usd: totalUsd,
      total_bs: totalBs,
    },
    note: input.note.trim() || null,
    ui: {
      quote_only: false,
    },
  };

  const { data: createdOrder, error: orderError } = await supabase
    .from('orders')
    .insert({
      order_number: orderNumber,
      client_id: clientId,
      created_by_user_id: user.id,
      attributed_advisor_id: attributedAdvisorId,
      source,
      fulfillment,
      status: 'created',
      total_usd: totalUsd,
      total_bs_snapshot: totalBs,
      is_price_locked: false,
      delivery_address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
      receiver_name: input.receiverName.trim() || null,
      receiver_phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
      notes: input.note.trim() || null,
      extra_fields: extraFields,
    })
    .select('id')
    .single();

  if (orderError) {
    throw new Error(orderError.message);
  }

  const orderId = Number(createdOrder.id);

  const adminOverrideTimestamp = new Date().toISOString();

  const itemsPayload = input.items.map((item, idx) => {
    const snapshot = itemSnapshots[idx];

    return {
    order_id: orderId,
    product_id: item.productId,
    qty: Number(item.qty || 0),
    pricing_origin_currency: item.sourcePriceCurrency,
    pricing_origin_amount: Number(item.sourcePriceAmount || 0),
    unit_price_usd_snapshot: snapshot.unitUsd,
    line_total_usd: snapshot.lineUsd,
    unit_price_bs_snapshot: snapshot.unitBs,
    line_total_bs_snapshot: snapshot.lineBs,
    admin_price_override_usd:
      item.adminPriceOverrideUsd != null
        ? Number(item.adminPriceOverrideUsd || 0)
        : null,
    admin_price_override_reason: item.adminPriceOverrideReason || null,
    admin_price_override_by_user_id:
      item.adminPriceOverrideUsd != null ? user.id : null,
    admin_price_override_at:
      item.adminPriceOverrideUsd != null ? adminOverrideTimestamp : null,
    sku_snapshot: item.skuSnapshot,
    product_name_snapshot: item.productNameSnapshot,
    notes:
      item.editableDetailLines && item.editableDetailLines.length > 0
        ? item.editableDetailLines.join('\n')
        : null,
    };
  });

  const { data: insertedItems, error: itemsError } = await supabase
    .from('order_items')
    .insert(itemsPayload)
    .select('id');

  if (itemsError) {
    throw new Error(itemsError.message);
  }

  const createAdjustmentRows = input.items
    .map((item, idx) => {
      if (item.adminPriceOverrideUsd == null) return null;

      return {
        order_id: orderId,
        order_item_id: Number(insertedItems?.[idx]?.id || 0) || null,
        adjustment_type: 'item_price_override',
        reason:
          String(item.adminPriceOverrideReason || '').trim() ||
          'Ajuste administrativo de precio',
        notes: null,
        payload: buildOrderItemOverrideAuditPayload(item),
        created_by_user_id: user.id,
      };
    })
    .filter(Boolean);

  if (createAdjustmentRows.length > 0) {
    const { error: createAdjustmentsError } = await supabase
      .from('order_admin_adjustments')
      .insert(createAdjustmentRows);

    if (createAdjustmentsError) {
      throw new Error(createAdjustmentsError.message);
    }
  }

  const { error: finalizeTotalsError } = await supabase
    .from('orders')
    .update({
      total_usd: totalUsd,
      total_bs_snapshot: totalBs,
      extra_fields: extraFields,
    })
    .eq('id', orderId);

  if (finalizeTotalsError) {
    throw new Error(finalizeTotalsError.message);
  }

  if (clientFundUsedUsd > 0.005) {
    await applyClientFundToOrder(supabase, {
      clientId,
      orderId,
      amountUsd: clientFundUsedUsd,
      userId: user.id,
      notes: 'Fondo aplicado al crear orden',
    });
  }

  await appendOrderEvent(supabase, {
    orderId,
    eventType: 'order_created',
    eventGroup: 'approval',
    title: 'Orden creada',
    message: 'La orden fue creada y quedo pendiente de aprobacion.',
    severity: 'warning',
    actorUserId: user.id,
    payload: {
      order_number: orderNumber,
      fulfillment,
      source,
      urgent: Boolean(input.isAsap),
      delivery_time: `${input.deliveryDate} ${deliveryTime24}`,
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetUserId: attributedAdvisorId },
    ],
  });

  revalidatePath('/app/master/dashboard');

  return { id: orderId, orderNumber };
}

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
    editableDetailLines: string[];
  }>;
  adminEditReason?: string | null;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  const source = input.source;
  const fulfillment = input.fulfillment;

  if (!['advisor', 'master', 'walk_in'].includes(source)) {
    throw new Error('Source inválido.');
  }

  if (!['pickup', 'delivery'].includes(fulfillment)) {
    throw new Error('Fulfillment inválido.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Debes agregar al menos un ítem.');
  }

  if (
    input.items.some((item) => item.adminPriceOverrideUsd != null) &&
    !getMasterDashboardPermissions(roles).isAdmin
  ) {
    throw new Error('Solo admin puede ajustar precios manualmente.');
  }

  if (source === 'advisor' && !input.attributedAdvisorUserId) {
    throw new Error('Debes seleccionar un asesor.');
  }

  if (fulfillment === 'delivery' && !input.deliveryAddress.trim()) {
    throw new Error('La dirección es obligatoria para delivery.');
  }

  if (fulfillment === 'delivery') {
    await assertDeliveryItemForOrder(supabase, input.items);
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, client_id, attributed_advisor_id, source, fulfillment, delivery_address, receiver_name, receiver_phone, notes, total_usd, total_bs_snapshot, extra_fields, last_modified_at')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  const expectedLastModifiedAt =
    typeof input.expectedLastModifiedAt === 'string' && input.expectedLastModifiedAt.trim()
      ? input.expectedLastModifiedAt.trim()
      : null;
  const currentLastModifiedAt =
    typeof currentOrder.last_modified_at === 'string' && currentOrder.last_modified_at.trim()
      ? currentOrder.last_modified_at.trim()
      : null;

  if (expectedLastModifiedAt !== currentLastModifiedAt) {
    return { ok: false as const, code: 'stale_order_edit', message: STALE_ORDER_EDIT_MESSAGE };
  }

  const isAdvancedOrderEdit = !['created', 'queued'].includes(currentOrder.status);

  if (isAdvancedOrderEdit && !String(input.adminEditReason || '').trim()) {
    throw new Error('Debes indicar el motivo de la modificación.');
  }

  const deliveryTime24 = from12hTo24h(
    input.deliveryHour12,
    input.deliveryMinute,
    input.deliveryAmPm
  );

  let clientId = input.selectedClientId;

  if (!clientId) {
    const fullName = String(input.newClientName || '').trim();
    const phone = normalizePhone(input.newClientPhone || '');

    if (!fullName) {
      throw new Error('Nombre del cliente es obligatorio.');
    }

    if (!phone) {
      throw new Error('Teléfono del cliente es obligatorio.');
    }

    const { data: existingClients, error: existingClientError } = await supabase
      .from('clients')
      .select('id')
      .or(buildClientPhoneOrFilters(phone).join(','))
      .limit(1);

    if (existingClientError) {
      throw new Error(existingClientError.message);
    }

    const existingClient = existingClients?.[0];
    if (existingClient) {
      clientId = Number(existingClient.id);
    } else {
      const { data: createdClient, error: createClientError } = await supabase
        .from('clients')
        .insert({
          full_name: fullName,
          phone,
          client_type: input.newClientType,
        })
        .select('id')
        .single();

      if (createClientError) {
        throw new Error(createClientError.message);
      }

      clientId = Number(createdClient.id);
    }
  }

  if (!clientId) {
    throw new Error('No se pudo resolver el cliente.');
  }

  const { data: clientAddressData, error: clientAddressError } = await supabase
    .from('clients')
    .select('recent_addresses')
    .eq('id', clientId)
    .maybeSingle();

  if (clientAddressError) {
    throw new Error(clientAddressError.message);
  }

  const { data: clientProfile, error: updateClientProfileError } = await supabase
    .from('clients')
    .update({
      billing_company_name: input.hasInvoice
        ? String(input.invoiceCompanyName || '').trim() || null
        : null,
      billing_tax_id: input.hasInvoice
        ? String(input.invoiceTaxId || '').trim() || null
        : null,
      billing_address: input.hasInvoice
        ? String(input.invoiceAddress || '').trim() || null
        : null,
      billing_phone: input.hasInvoice
        ? normalizePhone(String(input.invoicePhone || '')) || null
        : null,
      delivery_note_name: input.hasDeliveryNote
        ? String(input.deliveryNoteName || '').trim() || null
        : null,
      delivery_note_document_id: input.hasDeliveryNote
        ? String(input.deliveryNoteDocumentId || '').trim() || null
        : null,
      delivery_note_address: input.hasDeliveryNote
        ? String(input.deliveryNoteAddress || '').trim() || null
        : null,
      delivery_note_phone: input.hasDeliveryNote
        ? normalizePhone(String(input.deliveryNotePhone || '')) || null
        : null,
      recent_addresses:
        fulfillment === 'delivery'
          ? mergeRecentAddresses(
              clientAddressData?.recent_addresses,
              input.deliveryAddress,
              input.deliveryGpsUrl
            )
          : clientAddressData?.recent_addresses ?? [],
    })
    .eq('id', clientId)
    .select(`
      full_name,
      phone,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses
    `)
    .single();

  if (updateClientProfileError) {
    console.error('updateOrderAction client sync failed', {
      orderId,
      clientId,
      hasInvoice: input.hasInvoice,
      hasDeliveryNote: input.hasDeliveryNote,
      fulfillment,
      message: updateClientProfileError.message,
    });
    throw new Error(updateClientProfileError.message);
  }

  if (!clientProfile) {
    throw new Error('No se pudo confirmar la actualización del cliente.');
  }

  const attributedAdvisorId =
    source === 'advisor' ? input.attributedAdvisorUserId : user.id;

  if (!attributedAdvisorId) {
    throw new Error('No se pudo resolver el asesor atribuido.');
  }

  const fxRateNumber = Math.max(0, Number(input.fxRate || 0));

  const itemSnapshots = input.items.map((item) =>
    calculateOrderLineSnapshot({
      sourceCurrency: item.sourcePriceCurrency,
      sourceAmount: Number(item.sourcePriceAmount || 0),
      quantity: Number(item.qty || 0),
      fxRate: fxRateNumber,
      overrideUnitUsd: item.adminPriceOverrideCurrency ? null : item.adminPriceOverrideUsd,
      fallbackUnitUsd: Number(item.unitPriceUsdSnapshot || 0),
    })
  );

  const subtotalBs = itemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineBs, 0);
  const subtotalUsd = itemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineUsd, 0);

  const discountPctNumber = Math.max(
    0,
    Math.min(100, Number(input.discountPct || 0))
  );

  const invoiceTaxPctNumber = input.hasInvoice
    ? Math.max(0, Number(String(input.invoiceTaxPct || '16').replace(',', '.')) || 0)
    : 0;
  const totalsSnapshot = calculateOrderTotalsSnapshot({
    subtotalUsd,
    subtotalBs,
    discountPct: input.discountEnabled ? discountPctNumber : 0,
    invoiceTaxPct: invoiceTaxPctNumber,
  });
  const discountAmountUsd = totalsSnapshot.discountAmountUsd;
  const discountAmountBs = totalsSnapshot.discountAmountBs;
  const subtotalAfterDiscountUsd = totalsSnapshot.subtotalAfterDiscountUsd;
  const subtotalAfterDiscountBs = totalsSnapshot.subtotalAfterDiscountBs;
  const invoiceTaxAmountUsd = totalsSnapshot.invoiceTaxAmountUsd;
  const invoiceTaxAmountBs = totalsSnapshot.invoiceTaxAmountBs;
  const totalUsd = totalsSnapshot.totalUsd;
  const totalBs = totalsSnapshot.totalBs;

  const requestedClientFundUsd = Number(
    String(input.clientFundAmountUsd || '').replace(',', '.')
  );
  const clientFundUsedUsd = input.useClientFund
    ? Number(Math.max(0, Math.min(totalUsd, Number.isFinite(requestedClientFundUsd) ? requestedClientFundUsd : 0)).toFixed(2))
    : 0;
  const previousClientFundUsedUsd = Number(
    toSafeNumber((currentOrder.extra_fields as any)?.payment?.client_fund_used_usd, 0).toFixed(2)
  );

  const nowIso = new Date().toISOString();
  const previousPricing =
    currentOrder.extra_fields &&
    typeof currentOrder.extra_fields === 'object' &&
    !Array.isArray(currentOrder.extra_fields)
      ? ((currentOrder.extra_fields as any).pricing ?? {})
      : {};
  const previousFxRate = toSafeNumber(previousPricing?.fx_rate, 0);
  const fxRateChanged =
    (previousFxRate > 0 || fxRateNumber > 0) &&
    Math.abs(previousFxRate - fxRateNumber) >= 0.000001;
  const previousFxRateAdjustments = Array.isArray(previousPricing?.fx_rate_adjustments)
    ? previousPricing.fx_rate_adjustments
    : [];
  const fxRateAdjustmentEntry = fxRateChanged
    ? {
        previous_fx_rate: previousFxRate > 0 ? previousFxRate : null,
        next_fx_rate: fxRateNumber > 0 ? fxRateNumber : null,
        adjusted_at: nowIso,
        adjusted_by_user_id: user.id,
        reason:
          String(input.adminEditReason || '').trim() ||
          'Correccion de tasa snapshot',
      }
    : null;

  const extraFields = {
    schedule: {
      date: input.deliveryDate,
      time_12: `${input.deliveryHour12}:${pad2(Number(input.deliveryMinute || 0))} ${input.deliveryAmPm}`,
      time_24: deliveryTime24,
      asap: Boolean(input.isAsap),
    },
    receiver: {
      name: input.receiverName.trim() || null,
      phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
    },
    delivery: {
      address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
      gps_url: fulfillment === 'delivery' ? String(input.deliveryGpsUrl || '').trim() || null : null,
    },
    payment: {
      method: input.paymentMethod || null,
      currency: input.paymentCurrency || null,
      requires_change: !!input.paymentRequiresChange,
      change_for: input.paymentChangeFor.trim()
        ? Number(input.paymentChangeFor)
        : null,
      change_currency: input.paymentChangeCurrency || null,
      notes: input.paymentNote.trim() || null,
      client_fund_used_usd: clientFundUsedUsd > 0.005 ? clientFundUsedUsd : 0,
    },
    documents: {
      has_delivery_note: !!input.hasDeliveryNote,
      has_invoice: !!input.hasInvoice,
      invoice_data_note: input.invoiceDataNote.trim() || null,
      invoice_snapshot: input.hasInvoice
        ? {
            company_name: clientProfile?.billing_company_name ?? null,
            tax_id: clientProfile?.billing_tax_id ?? null,
            address: clientProfile?.billing_address ?? null,
            phone: clientProfile?.billing_phone ?? null,
          }
        : null,
      delivery_note_snapshot: input.hasDeliveryNote
        ? {
            name: clientProfile?.delivery_note_name ?? null,
            document_id: clientProfile?.delivery_note_document_id ?? null,
            address: clientProfile?.delivery_note_address ?? null,
            phone: clientProfile?.delivery_note_phone ?? null,
          }
        : null,
    },
    pricing: {
      fx_rate: fxRateNumber > 0 ? fxRateNumber : null,
      discount_enabled: !!input.discountEnabled,
      discount_pct: input.discountEnabled ? discountPctNumber : 0,
      discount_amount_usd: input.discountEnabled ? discountAmountUsd : 0,
      discount_amount_bs: input.discountEnabled ? discountAmountBs : 0,
      invoice_tax_pct: input.hasInvoice ? invoiceTaxPctNumber : 0,
      invoice_tax_amount_usd: input.hasInvoice ? invoiceTaxAmountUsd : 0,
      invoice_tax_amount_bs: input.hasInvoice ? invoiceTaxAmountBs : 0,
      subtotal_usd: subtotalUsd,
      subtotal_bs: subtotalBs,
      subtotal_after_discount_usd: subtotalAfterDiscountUsd,
      subtotal_after_discount_bs: subtotalAfterDiscountBs,
      total_usd: totalUsd,
      total_bs: totalBs,
      ...(previousFxRateAdjustments.length > 0 || fxRateAdjustmentEntry
        ? {
            fx_rate_adjustments: [
              ...previousFxRateAdjustments,
              ...(fxRateAdjustmentEntry ? [fxRateAdjustmentEntry] : []),
            ].slice(-20),
          }
        : {}),
    },
    note: input.note.trim() || null,
    ui: {
      quote_only: false,
    },
  };

  const orderUpdatePayload: Record<string, any> = {
    client_id: clientId,
    attributed_advisor_id: attributedAdvisorId,
    source,
    fulfillment,
    total_usd: totalUsd,
    total_bs_snapshot: totalBs,
    delivery_address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
    receiver_name: input.receiverName.trim() || null,
    receiver_phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
    notes: input.note.trim() || null,
    extra_fields: extraFields,
    last_modified_at: nowIso,
    last_modified_by: user.id,
  };

  if (currentOrder.status === 'queued') {
    orderUpdatePayload.queued_needs_reapproval = true;
    orderUpdatePayload.queued_last_modified_at = nowIso;
    orderUpdatePayload.queued_last_modified_by = user.id;
  }

  if (currentOrder.status === 'created') {
    orderUpdatePayload.queued_needs_reapproval = false;
    orderUpdatePayload.queued_last_modified_at = null;
    orderUpdatePayload.queued_last_modified_by = null;
  }

  const previousClientId = Number(currentOrder.client_id || 0);
  if (previousClientFundUsedUsd > 0.005 && Number.isFinite(previousClientId) && previousClientId > 0) {
    await restoreClientFundToOrder(supabase, {
      clientId: previousClientId,
      orderId,
      amountUsd: previousClientFundUsedUsd,
      userId: user.id,
      notes: 'Restitución de fondo por edición de orden',
    });
  }

  if (clientFundUsedUsd > 0.005) {
    await applyClientFundToOrder(supabase, {
      clientId,
      orderId,
      amountUsd: clientFundUsedUsd,
      userId: user.id,
      notes: 'Fondo aplicado por edición de orden',
    });
  }

  let updateOrderQuery = supabase
    .from('orders')
    .update(orderUpdatePayload)
    .eq('id', orderId);
  updateOrderQuery =
    expectedLastModifiedAt === null
      ? updateOrderQuery.is('last_modified_at', null)
      : updateOrderQuery.eq('last_modified_at', expectedLastModifiedAt);

  const { data: updatedOrderRows, error: updateOrderError } = await updateOrderQuery.select('id');

  if (updateOrderError) {
    throw new Error(updateOrderError.message);
  }

  if (!updatedOrderRows || updatedOrderRows.length === 0) {
    return { ok: false as const, code: 'stale_order_edit', message: STALE_ORDER_EDIT_MESSAGE };
  }

  const { data: previousOrderItems, error: previousOrderItemsError } = await supabase
    .from('order_items')
    .select(`
      id,
      product_name_snapshot,
      pricing_origin_currency,
      pricing_origin_amount,
      unit_price_usd_snapshot,
      unit_price_bs_snapshot,
      admin_price_override_usd,
      admin_price_override_reason,
      qty,
      line_total_usd
    `)
    .eq('order_id', orderId);

  if (previousOrderItemsError) {
    throw new Error(previousOrderItemsError.message);
  }

  const { error: deleteItemsError } = await supabase
    .from('order_items')
    .delete()
    .eq('order_id', orderId);

  if (deleteItemsError) {
    throw new Error(deleteItemsError.message);
  }

  const adminOverrideTimestamp = new Date().toISOString();

  const itemsPayload = input.items.map((item, idx) => {
    const snapshot = itemSnapshots[idx];

    return {
    order_id: orderId,
    product_id: item.productId,
    qty: Number(item.qty || 0),
    pricing_origin_currency: item.sourcePriceCurrency,
    pricing_origin_amount: Number(item.sourcePriceAmount || 0),
    unit_price_usd_snapshot: snapshot.unitUsd,
    line_total_usd: snapshot.lineUsd,
    unit_price_bs_snapshot: snapshot.unitBs,
    line_total_bs_snapshot: snapshot.lineBs,
    admin_price_override_usd:
      item.adminPriceOverrideUsd != null
        ? Number(item.adminPriceOverrideUsd || 0)
        : null,
    admin_price_override_reason: item.adminPriceOverrideReason || null,
    admin_price_override_by_user_id:
      item.adminPriceOverrideUsd != null ? user.id : null,
    admin_price_override_at:
      item.adminPriceOverrideUsd != null ? adminOverrideTimestamp : null,
    sku_snapshot: item.skuSnapshot,
    product_name_snapshot: item.productNameSnapshot,
    notes:
      item.editableDetailLines && item.editableDetailLines.length > 0
        ? item.editableDetailLines.join('\n')
        : null,
    };
  });

  const { data: insertedItems, error: insertItemsError } = await supabase
    .from('order_items')
    .insert(itemsPayload)
    .select('id');

  if (insertItemsError) {
    throw new Error(insertItemsError.message);
  }

  const previousOverrideSignatureCounts = new Map<string, number>();
  for (const previousItem of previousOrderItems ?? []) {
    if (previousItem.admin_price_override_usd == null) continue;
    const previousOriginCurrency: 'USD' | 'VES' =
      previousItem.pricing_origin_currency === 'VES' ? 'VES' : 'USD';
    const previousOriginAmount = Number(previousItem.pricing_origin_amount || 0);
    const previousUnitPriceUsd = Number(previousItem.unit_price_usd_snapshot || 0);
    const previousUnitPriceBs = Number(previousItem.unit_price_bs_snapshot || 0);
    const previousOverrideCurrency: 'USD' | 'VES' | null =
      previousOriginCurrency === 'VES' &&
      Math.abs(previousOriginAmount - previousUnitPriceBs) < 0.01
        ? 'VES'
        : previousOriginCurrency === 'USD' &&
            Math.abs(previousOriginAmount - previousUnitPriceUsd) < 0.000001
          ? 'USD'
          : null;
    const signature = buildOrderItemOverrideAuditSignature({
      productNameSnapshot: String(previousItem.product_name_snapshot || ''),
      sourcePriceCurrency: previousOriginCurrency,
      sourcePriceAmount: previousOriginAmount,
      unitPriceUsdSnapshot: previousUnitPriceUsd,
      adminPriceOverrideUsd: Number(previousItem.admin_price_override_usd || 0),
      adminPriceOverrideCurrency: previousOverrideCurrency,
      adminPriceOverrideReason: previousItem.admin_price_override_reason ?? null,
      qty: Number(previousItem.qty || 0),
      lineTotalUsd: Number(previousItem.line_total_usd || 0),
    });
    previousOverrideSignatureCounts.set(
      signature,
      (previousOverrideSignatureCounts.get(signature) ?? 0) + 1
    );
  }

  const updateAdjustmentRows = input.items
    .map((item, idx) => {
      if (item.adminPriceOverrideUsd == null) return null;

      const signature = buildOrderItemOverrideAuditSignature(item);
      const previousCount = previousOverrideSignatureCounts.get(signature) ?? 0;
      if (previousCount > 0) {
        previousOverrideSignatureCounts.set(signature, previousCount - 1);
        return null;
      }

      return {
        order_id: orderId,
        order_item_id: Number(insertedItems?.[idx]?.id || 0) || null,
        adjustment_type: 'item_price_override',
        reason:
          String(item.adminPriceOverrideReason || '').trim() ||
          'Ajuste administrativo de precio',
        notes: null,
        payload: buildOrderItemOverrideAuditPayload(item),
        created_by_user_id: user.id,
      };
    })
    .filter(Boolean);

  if (updateAdjustmentRows.length > 0) {
    const { error: updateAdjustmentsError } = await supabase
      .from('order_admin_adjustments')
      .insert(updateAdjustmentRows);

    if (updateAdjustmentsError) {
      throw new Error(updateAdjustmentsError.message);
    }
  }

  const { error: finalizeTotalsError } = await supabase
    .from('orders')
    .update({
      total_usd: totalUsd,
      total_bs_snapshot: totalBs,
      extra_fields: extraFields,
      last_modified_at: nowIso,
      last_modified_by: user.id,
    })
    .eq('id', orderId);

  if (finalizeTotalsError) {
    throw new Error(finalizeTotalsError.message);
  }

  if (fxRateAdjustmentEntry) {
    const { error: fxRateAuditError } = await supabase
      .from('order_admin_adjustments')
      .insert({
        order_id: orderId,
        order_item_id: null,
        adjustment_type: 'other',
        reason: fxRateAdjustmentEntry.reason,
        notes: null,
        payload: {
          kind: 'snapshot_fx_rate_update',
          previous_fx_rate: fxRateAdjustmentEntry.previous_fx_rate,
          next_fx_rate: fxRateAdjustmentEntry.next_fx_rate,
          previous_total_usd: Number(currentOrder.total_usd ?? 0),
          previous_total_bs: Number(currentOrder.total_bs_snapshot ?? 0),
          next_total_usd: totalUsd,
          next_total_bs: totalBs,
        },
        created_by_user_id: user.id,
      });

    if (fxRateAuditError) {
      console.warn('snapshot fx rate audit skipped', fxRateAuditError.message);
    }
  }

  if (isAdvancedOrderEdit) {
    const beforeExtraFields =
      currentOrder.extra_fields && typeof currentOrder.extra_fields === 'object' && !Array.isArray(currentOrder.extra_fields)
        ? currentOrder.extra_fields
        : {};

    const beforeSnapshot = {
      source: currentOrder.source ?? null,
      fulfillment: currentOrder.fulfillment ?? null,
      client_id: currentOrder.client_id ?? null,
      attributed_advisor_id: currentOrder.attributed_advisor_id ?? null,
      delivery_address: currentOrder.delivery_address ?? null,
      receiver_name: currentOrder.receiver_name ?? null,
      receiver_phone: currentOrder.receiver_phone ?? null,
      notes: currentOrder.notes ?? null,
      total_usd: Number(currentOrder.total_usd ?? 0),
      total_bs_snapshot: Number(currentOrder.total_bs_snapshot ?? 0),
      extra_fields: beforeExtraFields,
    };

    const afterSnapshot = {
      source,
      fulfillment,
      client_id: clientId,
      attributed_advisor_id: attributedAdvisorId,
      delivery_address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
      receiver_name: input.receiverName.trim() || null,
      receiver_phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
      notes: input.note.trim() || null,
      total_usd: totalUsd,
      total_bs_snapshot: totalBs,
      extra_fields: extraFields,
    };

    const changedFields = Object.keys(afterSnapshot).filter((key) => {
      const beforeValue = beforeSnapshot[key as keyof typeof beforeSnapshot];
      const afterValue = afterSnapshot[key as keyof typeof afterSnapshot];
      return !valuesEquivalent(key, beforeValue, afterValue);
    });

    const { error: createAuditError } = await supabase
      .from('order_admin_adjustments')
      .insert({
        order_id: orderId,
        order_item_id: null,
        adjustment_type: 'other',
        reason: String(input.adminEditReason || '').trim(),
        notes: null,
        payload: {
          kind: getMasterDashboardPermissions(roles).isAdmin ? 'admin_full_edit' : 'master_full_edit',
          changed_fields: changedFields,
          before: beforeSnapshot,
          after: afterSnapshot,
        },
        created_by_user_id: user.id,
      });

    if (createAuditError) {
      console.warn('advanced order edit audit skipped', createAuditError.message);
    }
  }

  if (currentOrder.status === 'delivered') {
    await resetDeliveredOrderInventoryDeductions(supabase, orderId);
    await applyDeliveredOrderInventoryDeductions(supabase, user.id, orderId);
  }

  const beforeExtraFields =
    currentOrder.extra_fields && typeof currentOrder.extra_fields === 'object' && !Array.isArray(currentOrder.extra_fields)
      ? currentOrder.extra_fields
      : {};

  const beforeSnapshot = {
    source: currentOrder.source ?? null,
    fulfillment: currentOrder.fulfillment ?? null,
    client_id: currentOrder.client_id ?? null,
    attributed_advisor_id: currentOrder.attributed_advisor_id ?? null,
    delivery_address: currentOrder.delivery_address ?? null,
    receiver_name: currentOrder.receiver_name ?? null,
    receiver_phone: currentOrder.receiver_phone ?? null,
    notes: currentOrder.notes ?? null,
    total_usd: Number(currentOrder.total_usd ?? 0),
    total_bs_snapshot: Number(currentOrder.total_bs_snapshot ?? 0),
    extra_fields: beforeExtraFields,
  };

  const afterSnapshot = {
    source,
    fulfillment,
    client_id: clientId,
    attributed_advisor_id: attributedAdvisorId,
    delivery_address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
    receiver_name: input.receiverName.trim() || null,
    receiver_phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
    notes: input.note.trim() || null,
    total_usd: totalUsd,
    total_bs_snapshot: totalBs,
    extra_fields: extraFields,
  };

  const changedFields = Object.keys(afterSnapshot).filter((key) => {
    const beforeValue = beforeSnapshot[key as keyof typeof beforeSnapshot];
    const afterValue = afterSnapshot[key as keyof typeof afterSnapshot];
    return !valuesEquivalent(key, beforeValue, afterValue);
  });

  const previousItemsSignature = stableStringify(
    (previousOrderItems ?? []).map((item) => ({
      product_name_snapshot: item.product_name_snapshot,
      qty: Number(item.qty || 0),
      line_total_usd: Number(item.line_total_usd || 0),
    })),
  );
  const nextItemsSignature = stableStringify(
    input.items.map((item) => ({
      product_name_snapshot: item.productNameSnapshot,
      qty: Number(item.qty || 0),
      line_total_usd: Number(item.lineTotalUsd || 0),
    })),
  );
  const itemsChanged = previousItemsSignature !== nextItemsSignature;
  const changeMeta = getChangeSectionsSummary({
    changedFields,
    itemsChanged,
  });

  if (changedFields.length > 0 || itemsChanged) {
    const eventContext = await loadOrderEventContext(supabase, orderId);
    await appendOrderEvent(supabase, {
      orderId,
      context: eventContext,
      eventType: 'order_modified',
      eventGroup: 'modification',
      title: currentOrder.status === 'queued' ? 'Orden modificada para re-aprobacion' : 'Orden modificada',
      message:
        changeMeta.summary.length > 0
          ? changeMeta.summary.join(' ')
          : 'Se realizaron cambios en la orden.',
      severity: currentOrder.status === 'queued' ? 'warning' : 'info',
      actorUserId: user.id,
      payload: {
        changed_sections: changeMeta.sections,
        change_summary: changeMeta.summary,
        reason: String(input.adminEditReason || '').trim() || null,
        queued_needs_reapproval: currentOrder.status === 'queued',
      },
      recipients: [
        { targetRole: 'master', requiresAction: currentOrder.status === 'queued' },
        { targetUserId: attributedAdvisorId },
      ],
    });
  }

  revalidatePath('/app/master/dashboard');

  return { ok: true as const, id: orderId };
}

type AdvisorCommissionOrderItemRow = {
  id: number | string;
  product_id: number | string | null;
  qty: number | string | null;
  unit_price_usd_snapshot: number | string | null;
  line_total_usd: number | string | null;
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

const ADVISOR_COMMISSION_CLIENT_IMPORT_CUTOFF = '2026-06-02';

function getAdvisorCommissionClient(order: AdvisorCommissionOrderRow) {
  return Array.isArray(order.client) ? order.client[0] ?? null : order.client ?? null;
}

function getAdvisorCommissionProduct(item: AdvisorCommissionOrderItemRow) {
  return Array.isArray(item.product) ? item.product[0] ?? null : item.product ?? null;
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

function getAdvisorCommissionDeliveryDate(order: AdvisorCommissionOrderRow) {
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

function buildAdvisorCommissionSnapshots(params: {
  orders: AdvisorCommissionOrderRow[];
  financialStates: Map<number, AdvisorCommissionFinancialStateRow>;
  firstPurchaseOrdersByClientId: Map<number, AdvisorCommissionFirstOrderRow>;
  advisorIds: string[];
  advisorNamesById: Map<string, string>;
  period: { id: number; name: string; date_from: string; date_to: string };
  baseCommissionPct: number;
}) {
  const {
    orders,
    financialStates,
    firstPurchaseOrdersByClientId,
    advisorIds,
    advisorNamesById,
    period,
    baseCommissionPct,
  } = params;

  const closuresByAdvisor = new Map<string, {
    advisorUserId: string;
    advisorName: string;
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
    const pendingUsd = getEffectiveOrderPendingUsd({
      order,
      financialState,
      fallbackPendingUsd: Math.max(0, totalUsd),
    });
    const confirmedPaidUsd = roundMoney(financialState?.confirmed_paid_usd ?? 0);
    const deliveryDate = financialState?.delivery_reference_date || getAdvisorCommissionDeliveryDate(order);
    const discountFactor = getAdvisorCommissionDiscountFactor(order, items);
    const commissionableSubtotalUsd = getOrderCommercialNetUsd(order);

    let regularBaseUsd = 0;
    let specialItemBaseUsd = 0;
    let specialItemCommissionUsd = 0;
    let fixedOrderBaseUsd = 0;
    let fixedOrderPct: number | null = null;
    const fixedOrderProduct = items
      .map(getAdvisorCommissionProduct)
      .find((product) => String(product?.commission_mode || '') === 'fixed_order');

    if (fixedOrderProduct) {
      fixedOrderBaseUsd = commissionableSubtotalUsd;
      fixedOrderPct = Math.max(0, toSafeNumber(fixedOrderProduct.commission_value, 0));
    } else {
      for (const item of items) {
        const product = getAdvisorCommissionProduct(item);
        const lineBaseUsd = Math.max(0, getOrderLineTotalUsd(item) * discountFactor);
        if (String(product?.commission_mode || '') === 'fixed_item') {
          const pct = Math.max(0, toSafeNumber(product?.commission_value, 0));
          specialItemBaseUsd += lineBaseUsd;
          specialItemCommissionUsd += lineBaseUsd * (pct / 100);
        } else {
          regularBaseUsd += lineBaseUsd;
        }

        const productType = String(product?.type || '').toLowerCase();
        const productName = item.product_name_snapshot || product?.name || 'Producto';
        if (productType === 'gambit' || productName.toLowerCase().includes('obsequio')) {
          const qty = toSafeNumber(item.qty, 0);
          const unitDeductionUsd = getAdvisorGiftCostUsd(product);
          const deductionUsd = roundMoney(unitDeductionUsd * qty);
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
          commissionMode: String(product?.commission_mode || 'default'),
          commissionValue: product?.commission_value ?? null,
        });
      }

      if (items.length === 0) {
        regularBaseUsd = commissionableSubtotalUsd;
      }
    }

    const regularCommissionUsd = regularBaseUsd * (baseCommissionPct / 100);
    const fixedOrderCommissionUsd =
      fixedOrderPct == null ? 0 : fixedOrderBaseUsd * (fixedOrderPct / 100);
    const orderCommissionUsd = roundMoney(regularCommissionUsd + specialItemCommissionUsd + fixedOrderCommissionUsd);
    const roundingClosure = getOrderRoundingClosureSnapshot(order);
    const paymentStatus = roundingClosure.isClosed
      ? 'closed_by_rounding'
      : String(financialState?.payment_status || '').toLowerCase();
    const isPending = pendingUsd > 0.005;

    closure.totals.deliveredOrdersCount += 1;
    closure.totals.billedUsd += commissionableSubtotalUsd;
    closure.totals.regularBaseUsd += regularBaseUsd;
    closure.totals.specialItemBaseUsd += specialItemBaseUsd;
    closure.totals.specialOrderBaseUsd += fixedOrderBaseUsd;
    closure.totals.grossCommissionUsd += orderCommissionUsd;
    closure.totals.pendingCollectionUsd += isPending ? pendingUsd : 0;
    closure.totals.pendingPaymentCount += isPending ? 1 : 0;
    closure.totals.punctualPaidCount += !isPending ? 1 : 0;

    const client = getAdvisorCommissionClient(order);
    const clientCreatedDate = dateOnlyFromIso(client?.created_at);
    const clientType = String(client?.client_type || '').toLowerCase();
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
        if (clientType === 'own') closure.totals.newOwnClientsCount += 1;
        if (clientType === 'assigned') closure.totals.newAssignedClientsCount += 1;
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

    const orderSnapshot = {
      orderId,
      orderNumber: order.order_number,
      clientId: client?.id ?? null,
      clientName: client?.full_name || 'Cliente',
      deliveryDate,
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
    };

    closure.orders.push(orderSnapshot);
    if (isPending) {
      closure.pendingOrders.push(orderSnapshot);
    } else {
      closure.paidOrders.push(orderSnapshot);
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
      base_commission_pct: baseCommissionPct,
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
        base_commission_pct: baseCommissionPct,
        totals,
        orders: closure.orders,
        paid_orders: closure.paidOrders,
        pending_orders: closure.pendingOrders,
        new_clients: closure.newClients,
        products: closure.products,
        gifts: closure.gifts,
        deductions: [],
      },
    };
  });
}

export async function createAdvisorCommissionPeriodAction(input: {
  name?: string;
  dateFrom: string;
  dateTo: string;
  notes?: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();
  const dateFrom = normalizeDateOnly(input.dateFrom);
  const dateTo = normalizeDateOnly(input.dateTo);

  if (!dateFrom || !dateTo) {
    throw new Error('Indica desde y hasta para crear el periodo.');
  }

  if (dateFrom > dateTo) {
    throw new Error('La fecha desde no puede ser mayor a la fecha hasta.');
  }

  const name = String(input.name || '').trim() || `Periodo ${dateFrom} / ${dateTo}`;

  const { data, error } = await supabase
    .from('advisor_commission_periods')
    .insert({
      name,
      date_from: dateFrom,
      date_to: dateTo,
      status: 'open',
      notes: String(input.notes || '').trim() || null,
      created_by_user_id: user.id,
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/app/master/dashboard');
  return { ok: true as const, id: Number(data.id) };
}

export async function generateAdvisorCommissionClosuresAction(input: {
  periodId: number;
  baseCommissionPct: number;
  advisorUserId?: string | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();
  const periodId = Number(input.periodId || 0);
  const baseCommissionPct = Math.max(0, toSafeNumber(input.baseCommissionPct, 0));
  const advisorUserId = String(input.advisorUserId || '').trim() || null;

  if (!Number.isFinite(periodId) || periodId <= 0) {
    throw new Error('Selecciona un periodo valido.');
  }

  const { data: period, error: periodError } = await supabase
    .from('advisor_commission_periods')
    .select('id, name, date_from, date_to, status')
    .eq('id', periodId)
    .single();

  if (periodError) {
    throw new Error(periodError.message);
  }

  if (period.status !== 'open') {
    throw new Error('Solo se pueden generar preliminares en periodos abiertos.');
  }

  const { data: advisorsData, error: advisorsError } = await supabase.rpc('get_advisor_profiles');
  if (advisorsError) {
    throw new Error(advisorsError.message);
  }

  const advisors = ((advisorsData ?? []) as Array<{
    user_id: string;
    full_name: string | null;
    is_active: boolean | null;
  }>)
    .filter((advisor) => Boolean(advisor.is_active ?? true))
    .filter((advisor) => !advisorUserId || String(advisor.user_id) === advisorUserId);

  if (advisors.length === 0) {
    throw new Error('No hay asesores activos para generar.');
  }

  const advisorIds = advisors.map((advisor) => String(advisor.user_id));
  const advisorNamesById = new Map(
    advisors.map((advisor) => [String(advisor.user_id), advisor.full_name?.trim() || 'Asesor'])
  );
  const endExclusive = new Date(`${period.date_to}T00:00:00-04:00`);
  endExclusive.setDate(endExclusive.getDate() + 1);
  const endExclusiveDate = getCaracasDateString(endExclusive);
  const orderSelect = `
    id,
    order_number,
    client_id,
    attributed_advisor_id,
    source,
    status,
    total_usd,
    total_bs_snapshot,
    created_at,
    extra_fields,
    client:clients!orders_client_id_fkey (
      id,
      full_name,
      phone,
      created_at,
      client_type
    ),
    items:order_items (
      id,
      product_id,
      qty,
      unit_price_usd_snapshot,
      line_total_usd,
      product_name_snapshot,
      sku_snapshot,
      notes,
      product:products!order_items_product_id_fkey (
        id,
        name,
        type,
        commission_mode,
        commission_value,
        extra_fields
      )
    )
  `;

  const periodStartIso = `${period.date_from}T00:00:00-04:00`;
  const periodEndIso = `${endExclusiveDate}T00:00:00-04:00`;
  const [scheduledOrdersResult, createdOrdersResult] = await Promise.all([
    supabase
      .from('orders')
      .select(orderSelect)
      .eq('status', 'delivered')
      .eq('source', 'advisor')
      .in('attributed_advisor_id', advisorIds)
      .gte('extra_fields->schedule->>date', period.date_from)
      .lt('extra_fields->schedule->>date', endExclusiveDate)
      .limit(5000),
    supabase
      .from('orders')
      .select(orderSelect)
      .eq('status', 'delivered')
      .eq('source', 'advisor')
      .in('attributed_advisor_id', advisorIds)
      .gte('created_at', periodStartIso)
      .lt('created_at', periodEndIso)
      .limit(5000),
  ]);

  const ordersError = scheduledOrdersResult.error ?? createdOrdersResult.error;
  if (ordersError) {
    throw new Error(ordersError.message);
  }

  const ordersById = new Map<number, AdvisorCommissionOrderRow>();
  for (const order of [
    ...((scheduledOrdersResult.data ?? []) as AdvisorCommissionOrderRow[]),
    ...((createdOrdersResult.data ?? []) as AdvisorCommissionOrderRow[]),
  ]) {
    const deliveryDate = getAdvisorCommissionDeliveryDate(order);
    if (!deliveryDate || deliveryDate < period.date_from || deliveryDate > period.date_to) continue;
    ordersById.set(Number(order.id), order);
  }

  const orders = Array.from(ordersById.values());
  const orderIds = orders.map((order) => Number(order.id)).filter((id) => Number.isFinite(id) && id > 0);
  const clientIds = Array.from(new Set(
    orders
      .map((order) => Number(order.client_id ?? 0))
      .filter((id) => Number.isFinite(id) && id > 0)
  ));
  const financialStates = new Map<number, AdvisorCommissionFinancialStateRow>();
  const firstPurchaseOrdersByClientId = new Map<number, AdvisorCommissionFirstOrderRow>();

  if (orderIds.length > 0) {
    const { data: financialStateData, error: financialStateError } = await (supabase as any).rpc(
      'get_orders_financial_state',
      {
        p_order_ids: orderIds,
        p_operation_date: null,
        p_active_bs_rate: null,
      }
    );

    if (financialStateError) {
      throw new Error(financialStateError.message);
    }

    for (const state of (financialStateData ?? []) as AdvisorCommissionFinancialStateRow[]) {
      const orderId = Number(state.order_id);
      if (Number.isFinite(orderId) && orderId > 0) {
        financialStates.set(orderId, state);
      }
    }
  }

  if (clientIds.length > 0) {
    const { data: firstOrderCandidates, error: firstOrderCandidatesError } = await supabase
      .from('orders')
      .select('id, order_number, client_id, attributed_advisor_id, source, status, created_at, extra_fields')
      .neq('status', 'cancelled')
      .in('client_id', clientIds)
      .order('created_at', { ascending: true })
      .limit(10000);

    if (firstOrderCandidatesError) {
      throw new Error(firstOrderCandidatesError.message);
    }

    for (const candidate of (firstOrderCandidates ?? []) as AdvisorCommissionFirstOrderRow[]) {
      const clientId = Number(candidate.client_id ?? 0);
      if (!Number.isFinite(clientId) || clientId <= 0) continue;

      const current = firstPurchaseOrdersByClientId.get(clientId);
      if (!current) {
        firstPurchaseOrdersByClientId.set(clientId, candidate);
        continue;
      }

      const candidateDate =
        getOrderDeliveryReferenceDate(candidate) || dateOnlyFromIso(candidate.created_at) || '';
      const currentDate =
        getOrderDeliveryReferenceDate(current) || dateOnlyFromIso(current.created_at) || '';
      if (candidateDate && (!currentDate || candidateDate < currentDate)) {
        firstPurchaseOrdersByClientId.set(clientId, candidate);
      }
    }
  }

  const { data: existingClosures, error: existingError } = await supabase
    .from('advisor_commission_closures')
    .select('advisor_user_id, status')
    .eq('period_id', periodId);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const lockedAdvisorIds = new Set(
    ((existingClosures ?? []) as Array<{ advisor_user_id: string; status: string }>)
      .filter((closure) => closure.status === 'closed' || closure.status === 'paid')
      .map((closure) => closure.advisor_user_id)
  );

  const snapshots = buildAdvisorCommissionSnapshots({
    orders,
    financialStates,
    firstPurchaseOrdersByClientId,
    advisorIds: advisorIds.filter((id) => !lockedAdvisorIds.has(id)),
    advisorNamesById,
    period: {
      id: Number(period.id),
      name: String(period.name || ''),
      date_from: String(period.date_from),
      date_to: String(period.date_to),
    },
    baseCommissionPct,
  });

  if (snapshots.length > 0) {
    const nowIso = new Date().toISOString();
    const payload = snapshots.map((snapshot) => ({
      ...snapshot,
      generated_by_user_id: user.id,
      generated_at: nowIso,
      updated_at: nowIso,
    }));

    const { error: upsertError } = await supabase
      .from('advisor_commission_closures')
      .upsert(payload, { onConflict: 'period_id,advisor_user_id' });

    if (upsertError) {
      throw new Error(upsertError.message);
    }
  }

  revalidatePath('/app/master/dashboard');

  return {
    ok: true as const,
    generated: snapshots.length,
    skippedLocked: lockedAdvisorIds.size,
  };
}

export async function updateAdvisorCommissionClosureStatusAction(input: {
  closureId: number;
  nextStatus: 'preliminary' | 'closed' | 'paid';
}) {
  const { supabase, user } = await requireMasterOrAdmin();
  const closureId = Number(input.closureId || 0);
  const nextStatus = input.nextStatus;

  if (!Number.isFinite(closureId) || closureId <= 0) {
    throw new Error('Selecciona un cierre valido.');
  }

  if (nextStatus !== 'preliminary' && nextStatus !== 'closed' && nextStatus !== 'paid') {
    throw new Error('Estado de cierre invalido.');
  }

  const { data: currentClosure, error: currentClosureError } = await supabase
    .from('advisor_commission_closures')
    .select('id, status')
    .eq('id', closureId)
    .single();

  if (currentClosureError || !currentClosure) {
    throw new Error(currentClosureError?.message || 'No se pudo cargar el cierre.');
  }

  const currentStatus = String(currentClosure.status || '');
  if (nextStatus === 'closed' && currentStatus !== 'preliminary') {
    throw new Error('Solo un preliminar puede pasar a cierre.');
  }

  if (nextStatus === 'preliminary' && currentStatus !== 'closed') {
    throw new Error('Solo un cierre confirmado puede reabrirse a preliminar.');
  }

  if (nextStatus === 'paid' && currentStatus !== 'closed') {
    throw new Error('Solo un cierre confirmado puede marcarse como pagado.');
  }

  const nowIso = new Date().toISOString();
  const payload =
    nextStatus === 'preliminary'
      ? {
          status: 'preliminary',
          closed_at: null,
          closed_by_user_id: null,
          updated_at: nowIso,
        }
      : nextStatus === 'closed'
        ? {
            status: 'closed',
            closed_at: nowIso,
            closed_by_user_id: user.id,
            updated_at: nowIso,
          }
        : {
            status: 'paid',
            paid_at: nowIso,
            paid_by_user_id: user.id,
            updated_at: nowIso,
          };

  const { error: updateError } = await supabase
    .from('advisor_commission_closures')
    .update(payload)
    .eq('id', closureId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  revalidatePath('/app/master/dashboard');
  return { ok: true as const };
}

export async function loadAdvisorCommissionClosuresAction(input: {
  periodId: number;
  advisorUserId?: string | null;
}) {
  const { supabase } = await requireMasterOrAdmin();
  const periodId = Number(input.periodId || 0);
  const advisorUserId = String(input.advisorUserId || '').trim();

  if (!Number.isFinite(periodId) || periodId <= 0) {
    throw new Error('Selecciona un periodo valido.');
  }

  let query = supabase
    .from('advisor_commission_closures')
    .select(`
      id,
      period_id,
      advisor_user_id,
      status,
      base_commission_pct,
      delivered_orders_count,
      billed_usd,
      gross_commission_usd,
      pending_collection_usd,
      punctual_paid_count,
      late_paid_count,
      pending_payment_count,
      new_own_clients_count,
      new_assigned_clients_count,
      gift_deductions_usd,
      manual_deductions_usd,
      payable_usd,
      snapshot,
      generated_at,
      closed_at,
      paid_at,
      deductions:advisor_commission_deductions (
        id,
        deduction_type,
        description,
        amount_usd,
        notes,
        created_at
      )
    `)
    .eq('period_id', periodId)
    .order('generated_at', { ascending: false })
    .limit(80);

  if (advisorUserId) {
    query = query.eq('advisor_user_id', advisorUserId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return {
    ok: true as const,
    closures: ((data ?? []) as any[]).map((row) => ({
      id: Number(row.id),
      periodId: Number(row.period_id),
      advisorUserId: row.advisor_user_id,
      status: row.status,
      baseCommissionPct: toSafeNumber(row.base_commission_pct, 0),
      deliveredOrdersCount: toSafeNumber(row.delivered_orders_count, 0),
      billedUsd: roundMoney(row.billed_usd),
      grossCommissionUsd: roundMoney(row.gross_commission_usd),
      pendingCollectionUsd: roundMoney(row.pending_collection_usd),
      punctualPaidCount: toSafeNumber(row.punctual_paid_count, 0),
      latePaidCount: toSafeNumber(row.late_paid_count, 0),
      pendingPaymentCount: toSafeNumber(row.pending_payment_count, 0),
      newOwnClientsCount: toSafeNumber(row.new_own_clients_count, 0),
      newAssignedClientsCount: toSafeNumber(row.new_assigned_clients_count, 0),
      giftDeductionsUsd: roundMoney(row.gift_deductions_usd),
      manualDeductionsUsd: roundMoney(row.manual_deductions_usd),
      payableUsd: roundMoney(row.payable_usd),
      snapshot: row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {},
      manualDeductions: (row.deductions ?? [])
        .filter((deduction: any) => String(deduction.deduction_type || '') !== 'gift')
        .map((deduction: any) => ({
          id: Number(deduction.id),
          kind: deduction.deduction_type,
          description: deduction.description || '',
          amountUsd: roundMoney(deduction.amount_usd),
          notes: deduction.notes,
          createdAt: deduction.created_at,
        })),
      generatedAt: row.generated_at,
      closedAt: row.closed_at,
      paidAt: row.paid_at,
    })),
  };
}

export async function loadAdvisorCommissionPeriodAdvisorsAction(input: { periodId: number }) {
  const { supabase } = await requireMasterOrAdmin();
  const periodId = Number(input.periodId || 0);

  if (!Number.isFinite(periodId) || periodId <= 0) {
    throw new Error('Selecciona un periodo valido.');
  }

  const [advisorsResult, closuresResult] = await Promise.all([
    supabase.rpc('get_advisor_profiles'),
    supabase
      .from('advisor_commission_closures')
      .select('advisor_user_id, status, generated_at')
      .eq('period_id', periodId)
      .order('generated_at', { ascending: false })
      .limit(200),
  ]);

  if (advisorsResult.error) {
    throw new Error(advisorsResult.error.message);
  }

  if (closuresResult.error) {
    throw new Error(closuresResult.error.message);
  }

  const advisorIds = Array.from(
    new Set(
      [
        ...((advisorsResult.data ?? []) as Array<{ user_id: string | null; is_active: boolean | null }>)
          .filter((advisor) => Boolean(advisor.is_active ?? true))
          .map((advisor) => String(advisor.user_id || '').trim()),
        ...((closuresResult.data ?? []) as Array<{ advisor_user_id: string | null }>)
          .map((row) => String(row.advisor_user_id || '').trim()),
      ].filter(Boolean)
    )
  );

  return { ok: true as const, advisorIds };
}

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
}) {
  const { supabase, user } = await requireMasterOrAdmin();
  const closureId = Number(input.closureId || 0);
  const amountUsd = roundMoney(Math.max(0, toSafeNumber(input.amountUsd, 0)));
  const description = String(input.description || '').trim();

  if (!Number.isFinite(closureId) || closureId <= 0) {
    throw new Error('Selecciona un cierre valido.');
  }
  if (amountUsd <= 0) {
    throw new Error('El deducible debe ser mayor a cero.');
  }
  if (!description) {
    throw new Error('Indica el detalle del deducible.');
  }

  const { data: closure, error: closureError } = await supabase
    .from('advisor_commission_closures')
    .select('id, status')
    .eq('id', closureId)
    .single();

  if (closureError || !closure) {
    throw new Error(closureError?.message || 'No se pudo cargar el cierre.');
  }
  if (closure.status === 'paid') {
    throw new Error('No se pueden cambiar deducibles de un cierre pagado.');
  }

  const { error: insertError } = await supabase.from('advisor_commission_deductions').insert({
    closure_id: closureId,
    deduction_type: 'manual_expense',
    description,
    amount_usd: amountUsd,
    created_by_user_id: user.id,
  });

  if (insertError) {
    throw new Error(insertError.message);
  }

  const totals = await syncAdvisorCommissionClosureManualDeductions(supabase, closureId);

  revalidatePath('/app/master/dashboard');
  return { ok: true as const, ...totals };
}

export async function deleteAdvisorCommissionClosureDeductionAction(input: {
  closureId: number;
  deductionId: number;
}) {
  const { supabase } = await requireMasterOrAdmin();
  const closureId = Number(input.closureId || 0);
  const deductionId = Number(input.deductionId || 0);

  if (!Number.isFinite(closureId) || closureId <= 0 || !Number.isFinite(deductionId) || deductionId <= 0) {
    throw new Error('Selecciona un deducible valido.');
  }

  const { data: closure, error: closureError } = await supabase
    .from('advisor_commission_closures')
    .select('id, status')
    .eq('id', closureId)
    .single();

  if (closureError || !closure) {
    throw new Error(closureError?.message || 'No se pudo cargar el cierre.');
  }
  if (closure.status === 'paid') {
    throw new Error('No se pueden cambiar deducibles de un cierre pagado.');
  }

  const { error: deleteError } = await supabase
    .from('advisor_commission_deductions')
    .delete()
    .eq('id', deductionId)
    .eq('closure_id', closureId)
    .neq('deduction_type', 'gift');

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  const totals = await syncAdvisorCommissionClosureManualDeductions(supabase, closureId);

  revalidatePath('/app/master/dashboard');
  return { ok: true as const, ...totals };
}

export async function logoutAction() {
  const supabase = await createSupabaseServer();

  const { error } = await supabase.auth.signOut();

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/login');
  revalidatePath('/app');
  revalidatePath('/app/master/dashboard');

  redirect('/login');
}
