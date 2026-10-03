'use server';
export async function createDashboardUserAction(input: {email:string;password:string;fullName:string;isActive:boolean;receivesCommissions:boolean;roles:AppUserRole[]}) {
  await requireAtomicConfiguration();
  const ctx=await requireAdminContext();
  const email=String(input.email||'').trim().toLowerCase();
  const name=String(input.fullName||'').trim();
  const selected=normalizeUserRoles(input.roles);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||selected.length===0||String(input.password||'').length<6)
    throw new Error('Revisa nombre, correo, contraseña (mínimo 6 caracteres) y al menos un rol.');
  const service=createSupabaseServiceRoleServer();
  const created=await service.auth.admin.createUser({email,password:input.password,email_confirm:true,user_metadata:{full_name:name}});
  if(created.error||!created.data.user) throw new Error(created.error?.message||'No se pudo crear el usuario.');
  const userId=created.data.user.id;
  try {
    const profile=await service.from('profiles').upsert({id:userId,full_name:name,is_active:input.isActive,receives_commissions:selected.includes('advisor')&&input.receivesCommissions},{onConflict:'id'});
    if(profile.error)throw new Error(profile.error.message);
    const result=await ctx.supabase.rpc('admin_user_configuration_v1',{p_input:{userId,fullName:name,isActive:input.isActive,receivesCommissions:input.receivesCommissions,roles:selected}});
    if(result.error)throw new Error(result.error.message);
  } catch {
    // Compensate only the fresh Auth ID returned by this creation, never an existing user.
    const removed=await service.auth.admin.deleteUser(userId);
    if(removed.error)throw new Error('El alta quedó incompleta. Revisa el usuario en configuración antes de repetir.');
    throw new Error('No se completó el alta; se revirtió el usuario nuevo. Puedes intentar otra vez.');
  }
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/admin','layout');
  return {ok:true};
}
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
}) {
  try {
    await requireAtomicConfiguration();
    const {supabase}=await requireAdminContext();
    const roles=normalizeUserRoles(input.roles);
    if(!roles.length || !String(input.fullName||'').trim()) return {ok:false,error:'Revisa nombre y roles.'};
    const {error}=await supabase.rpc('admin_user_configuration_v1',{p_input:{...input,roles}});
    if(error)return {ok:false,error:error.message};
    revalidatePath('/app/master/dashboard');
    revalidatePath('/app/admin','layout');
    return {ok:true};
  } catch(error) {
    return {ok:false,error:error instanceof Error?error.message:'No se pudo actualizar el usuario.'};
  }
}

export async function updateExchangeRateAction(input: {
  rateBsPerUsd: number;
  operationId: string;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const rate = Number(input.rateBsPerUsd);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('La tasa debe ser mayor a 0.');
  }

  const operationId = String(input.operationId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new Error('No se pudo identificar de forma segura esta actualización. Intenta nuevamente.');
  }

  const { error } = await supabase.rpc('set_active_exchange_rate', {
    p_rate_bs_per_usd: rate,
    p_operation_id: operationId,
    p_reason: 'Actualización diaria de la tasa general.',
  });

  if (error) throw new Error(error.message);

  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/admin', 'layout');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/admin/ordenes');
}

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
}) {
  const {supabase}=await requireAdminContext();
  await requireAtomicConfiguration();
  const {error}=await supabase.rpc('admin_account_configuration_v1',{p_input:input,p_operation_id:input.operationId ?? randomUUID()});
  if(error)throw new Error(error.message);
  revalidateMasterDashboardFinancialReferences();
}

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
}) {
  const {supabase}=await requireAdminContext();
  await requireAtomicConfiguration();
  const {error}=await supabase.rpc('admin_account_configuration_v1',{p_input:input,p_operation_id:input.operationId ?? randomUUID()});
  if(error)throw new Error(error.message);
  revalidateMasterDashboardFinancialReferences();
}

export async function toggleMoneyAccountActiveAction(input: {
  accountId: number;
  nextIsActive: boolean;
}) {
  const { supabase } = await requireAdminContext();
  await requireAtomicConfiguration();

  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('Cuenta inválida.');
  }

  const { error } = await supabase.rpc('admin_account_configuration_v1', {
    p_input: { accountId, activeOnly: true, isActive: input.nextIsActive },
    p_operation_id: randomUUID(),
  });

  if (error) throw new Error(error.message);

  revalidateMasterDashboardFinancialReferences();
}

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
}) {
  const { supabase, roles } = await requireMasterOrAdmin();
  requireAdminRole(roles);

  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('Cuenta inválida.');
  }

  const rawRules = Array.isArray(input.rules) ? input.rules : [];
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
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) {
    throw new Error('No hay reglas válidas para guardar.');
  }

  await requireAtomicConfiguration();
  const {error}=await supabase.rpc('admin_account_rules_v1',{p_account_id:accountId,p_rules:rows,p_operation_id:input.operationId ?? randomUUID()});
  if(error)throw new Error(error.message);

  revalidateMasterDashboardFinancialReferences();
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
  revalidatePath('/app/admin', 'layout');
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
  revalidatePath('/app/admin', 'layout');
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
  revalidatePath('/app/admin', 'layout');
}

export async function loadDeliveryPartnerRatesAction() {
  const { supabase } = await requireMasterOrAdmin();

  const { data, error } = await supabase
    .from('delivery_partner_rates')
    .select('id, partner_id, km_from, km_to, price_usd, is_active, created_at')
    .order('partner_id', { ascending: true })
    .order('km_from', { ascending: true });

  if (error) throw new Error(error.message);

  const rates = ((data ?? []) as Array<{id:number|string;partner_id:number|string;km_from:number|string;km_to:number|string|null;price_usd:number|string;is_active:boolean;created_at:string}>).map((row) => ({
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
  revalidatePath('/app/admin', 'layout');
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
  revalidatePath('/app/admin', 'layout');
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
  revalidatePath('/app/admin', 'layout');
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
  revalidatePath('/app/admin', 'layout');

  return createdClient;
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
  revalidatePath('/app/admin', 'layout');
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
  revalidatePath('/app/admin', 'layout');
}

export async function createMoneyAccountBaselineAction(input: {
  operationId?: string;
  moneyAccountId: number;
  baselineDate: string;
  countedAmount: number;
  exchangeRateVesPerUsd: number | null;
  reason: string;
  notes: string;
}) {
  const {supabase,roles}=await requireMasterOrAdmin();
  // Master retains its existing baseline permission; the RPC independently verifies
  // the active session. A missing function fails closed without a legacy write.
  if (roles.includes('admin')) await requireAtomicConfiguration();
  const {error}=await supabase.rpc('admin_account_baseline_v1',{p_input:input,p_operation_id:input.operationId ?? randomUUID()});
  if(error)throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/admin','layout');
}
