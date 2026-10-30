'use server';
export async function createDashboardUserAction(input: {email:string;password:string;fullName:string;isActive:boolean;receivesCommissions:boolean;roles:AppUserRole[]}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
import { randomUUID } from 'node:crypto';
import { requireAtomicConfiguration } from './capabilities';
import { revalidatePath, updateTag } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { requireAdminContext, requireMasterOrAdminContext } from '@/lib/auth';
import { getPhoneSearchTerms, normalizePhone } from '@/lib/phone/normalize-phone';
import { getMasterDashboardPermissions } from '@/app/app/master/dashboard/permissions';
const MASTER_DASHBOARD_FINANCIAL_REFERENCES_TAG = 'master-dashboard-financial-references';

function revalidateMasterDashboardFinancialReferences() {
  updateTag(MASTER_DASHBOARD_FINANCIAL_REFERENCES_TAG);
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/admin', 'layout');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/admin/ordenes');
}

async function requireMasterOrAdmin() {
  return requireMasterOrAdminContext();
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

function toSafeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

type AppUserRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'counter' | 'driver';

type PaymentMethodCode = 'payment_mobile' | 'transfer' | 'zelle' | 'wallet_usd' | 'cash_usd' | 'cash_ves' | 'pos' | 'retention';



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

function requireAdminRole(roles: readonly string[]) {
  if (!getMasterDashboardPermissions(roles).isAdmin) {
    throw new Error('Esta acción requiere permisos de administrador.');
  }
}

export async function updateDashboardUserAction(input: {
  userId: string;
  fullName: string;
  isActive: boolean;
  receivesCommissions: boolean;
  roles: AppUserRole[];
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateExchangeRateAction(input: {
  rateBsPerUsd: number;
  operationId: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createMoneyAccountAction(input: {
  operationId?: string;
  name: string;
  currencyCode: 'USD' | 'VES';
  accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
  institutionName: string;
  ownerName: string;
  notes: string;
  isActive: boolean;
  closureDefaultTargetMoneyAccountId?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateMoneyAccountAction(input: {
  operationId?: string;
  accountId: number;
  name: string;
  currencyCode: 'USD' | 'VES';
  accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
  institutionName: string;
  ownerName: string;
  notes: string;
  isActive: boolean;
  closureDefaultTargetMoneyAccountId?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function toggleMoneyAccountActiveAction(input: {
  accountId: number;
  nextIsActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateMoneyAccountPaymentRulesAction(input: {
  operationId?: string;
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
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createDeliveryPartnerAction(input: {
  name: string;
  partnerType: string;
  whatsappPhone: string;
  isActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateDeliveryPartnerAction(input: {
  partnerId: number;
  name: string;
  partnerType: string;
  whatsappPhone: string;
  isActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function toggleDeliveryPartnerActiveAction(input: {
  partnerId: number;
  nextIsActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadDeliveryPartnerRatesAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createDeliveryPartnerRateAction(input: {
  partnerId: number;
  kmFrom: number;
  kmTo: number | null;
  priceUsd: number;
  isActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateDeliveryPartnerRateAction(input: {
  rateId: number;
  kmFrom: number;
  kmTo: number | null;
  priceUsd: number;
  isActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function toggleDeliveryPartnerRateActiveAction(input: {
  rateId: number;
  nextIsActive: boolean;
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
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

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
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function toggleClientActiveAction(input: {
  clientId: number;
  nextIsActive: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createMoneyAccountBaselineAction(input: {
  operationId?: string;
  moneyAccountId: number;
  baselineDate: string;
  countedAmount: number;
  exchangeRateVesPerUsd: number | null;
  reason: string;
  notes: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
