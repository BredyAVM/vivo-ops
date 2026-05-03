import type { ComponentProps } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/supabase/server';
import MasterDashboardClient from './MasterDashboardClient';

type RawOrderRow = {
  id: number;
  order_number: string;
  client_id: number | null;
  attributed_advisor_id: string | null;
  source: 'advisor' | 'master' | 'walk_in';
  fulfillment: 'pickup' | 'delivery';
  delivery_address: string | null;
  status:
    | 'created'
    | 'queued'
    | 'confirmed'
    | 'in_kitchen'
    | 'ready'
    | 'out_for_delivery'
    | 'delivered'
    | 'cancelled';
  total_usd: number | string;
  notes: string | null;
  created_at: string;
  sent_to_kitchen_at: string | null;
  kitchen_started_at: string | null;
  ready_at: string | null;
  extra_fields: any;
  queued_needs_reapproval: boolean;
  external_driver_name: string | null;
  external_partner_id: number | null;
  internal_driver_user_id: string | null;
  eta_minutes: number | string | null;
client: { full_name: string | null; phone: string | null }[] | { full_name: string | null; phone: string | null } | null;
advisor: { full_name: string | null }[] | { full_name: string | null } | null;
creator: { full_name: string | null }[] | { full_name: string | null } | null;
};

type RawOrderItemRow = {
  id: number;
  order_id: number;
  product_id: number;
  qty: number | string;
  unit_price_usd_snapshot: number | string;
  line_total_usd: number | string;
  product_name_snapshot: string;
  sku_snapshot: string | null;
  notes: string | null;
  admin_price_override_usd: number | string | null;
  admin_price_override_reason: string | null;
  admin_price_override_by_user_id: string | null;
  admin_price_override_at: string | null;
};

type RawOrderAdjustmentRow = {
  id: number;
  order_id: number;
  order_item_id: number | null;
  adjustment_type: string;
  reason: string;
  notes: string | null;
  payload: any;
  created_at: string;
  created_by_user_id: string;
};

type RawPaymentReportRow = {
  id: number;
  order_id: number;
  status: 'pending' | 'confirmed' | 'rejected';
  created_at: string | null;
  created_by_user_id: string | null;
  reported_currency_code: string;
  reported_amount: number | string;
  reported_exchange_rate_ves_per_usd: number | string | null;
  reported_amount_usd_equivalent: number | string;
  reported_money_account_id: number;
  reference_code: string | null;
  payer_name: string | null;
  notes: string | null;
};

type PaymentReportDetail = {
  id: number;
  status: 'pending' | 'confirmed' | 'rejected';
  createdAt: string | null;
  reporterUserId: string | null;
  reporterName: string;
  currencyCode: string;
  amount: number;
  exchangeRate: number | null;
  usdEquivalent: number;
  moneyAccountId: number;
  moneyAccountName: string;
  referenceCode: string | null;
  payerName: string | null;
  notes: string | null;
};

type MoneyAccountRow = {
  id: number;
  name: string;
  currency_code: string;
  account_kind: string;
  institution_name: string | null;
  owner_name: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  created_by_user_id: string | null;
};

type RawMoneyMovementRow = {
  id: number;
  movement_date: string;
  created_at: string;
  created_by_user_id: string;
  confirmed_at: string | null;
  confirmed_by_user_id: string | null;
  direction: 'inflow' | 'outflow';
  movement_type:
    | 'adjustment'
    | 'cash_count_adjustment'
    | 'change_given'
    | 'expense_payment'
    | 'fee_charge'
    | 'order_payment'
    | 'other_income'
    | 'withdrawal';
  money_account_id: number;
  currency_code: 'USD' | 'VES';
  amount: number | string;
  exchange_rate_ves_per_usd: number | string | null;
  amount_usd_equivalent: number | string;
  reference_code: string | null;
  counterparty_name: string | null;
  description: string | null;
  notes: string | null;
  order_id: number | null;
  payment_report_id: number | null;
  movement_group_id: string | null;
};

type RawClientRow = {
  id: number;
  full_name: string;
  phone: string | null;
  notes: string | null;
  primary_advisor_id: string | null;
  created_at: string;
  client_type: string | null;
  is_active: boolean;
  birth_date: string | null;
  important_date: string | null;
  billing_company_name: string | null;
  billing_tax_id: string | null;
  billing_address: string | null;
  billing_phone: string | null;
  delivery_note_name: string | null;
  delivery_note_document_id: string | null;
  delivery_note_address: string | null;
  delivery_note_phone: string | null;
  recent_addresses: unknown;
  crm_tags: unknown;
  extra_fields: unknown;
  fund_balance_usd: number | string | null;
  updated_at: string;
};

type RawProfileRow = {
  id: string;
  full_name: string | null;
  is_active: boolean | null;
  created_at: string | null;
};

type RawUserRoleRow = {
  user_id: string;
  role: 'admin' | 'master' | 'advisor' | 'kitchen' | 'driver';
};

type RawMasterInboxItemStateRow = {
  item_id: string;
  item_type: 'task' | 'event' | string;
  order_id: number | string | null;
  status: 'reviewed' | 'resolved' | string;
};

async function loadAuthUserEmailById() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const emailById = new Map<string, string>();

  if (!url || !key) {
    return emailById;
  }

  try {
    const adminSupabase = createClient(url, key, {
      auth: { persistSession: false },
    });
    const perPage = 1000;

    for (let page = 1; page <= 10; page += 1) {
      const { data, error } = await adminSupabase.auth.admin.listUsers({
        page,
        perPage,
      });

      if (error) {
        console.warn('loadAuthUserEmailById skipped', error.message);
        break;
      }

      for (const authUser of data.users ?? []) {
        if (authUser.id && authUser.email) {
          emailById.set(authUser.id, authUser.email);
        }
      }

      if (!data.users || data.users.length < perPage) {
        break;
      }
    }
  } catch (error) {
    console.warn(
      'loadAuthUserEmailById failed',
      error instanceof Error ? error.message : 'unknown auth users error'
    );
  }

  return emailById;
}

type RawProductRow = {
  id: number;
  sku: string | null;
  name: string;
  type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
  is_active: boolean;
  source_price_amount: number | string;
  source_price_currency: 'VES' | 'USD';
  base_price_usd: number | string;
  base_price_bs: number | string;
  units_per_service: number | string;
  is_detail_editable: boolean;
  detail_units_limit: number | string;
  is_inventory_item: boolean;
  is_temporary: boolean;
  is_combo_component_selectable: boolean;
  commission_mode: 'default' | 'fixed_item' | 'fixed_order' | null;
  commission_value: number | string | null;
  commission_notes: string | null;
  internal_rider_pay_usd: number | string | null;
  inventory_enabled: boolean;
  inventory_kind: 'raw_material' | 'prepared_base' | 'finished_good' | null;
  inventory_deduction_mode: 'self' | 'composition' | null;
  inventory_unit_name: string | null;
  packaging_name: string | null;
  packaging_size: number | string | null;
  current_stock_units: number | string | null;
  low_stock_threshold: number | string | null;
  inventory_group: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other' | null;
};

type RawInventoryItemRow = {
  id: number;
  name: string;
  inventory_kind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventory_group: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other' | null;
  unit_name: string;
  packaging_name: string | null;
  packaging_size: number | string | null;
  current_stock_units: number | string;
  low_stock_threshold: number | string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
};

type RawInventoryMovementRow = {
  id: number;
  inventory_item_id: number;
  movement_type:
    | 'inbound'
    | 'sale_out'
    | 'damage'
    | 'waste'
    | 'manual_adjustment'
    | 'stock_count'
    | 'production_out'
    | 'production_in'
    | 'pack_out'
    | 'pack_in';
  quantity_units: number | string;
  reason_code: string | null;
  notes: string | null;
  order_id: number | null;
  created_at: string;
  created_by_user_id: string;
};

type RawInventoryRecipeRow = {
  id: number;
  output_inventory_item_id: number;
  recipe_kind: 'production' | 'packaging';
  output_quantity_units: number | string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
};

type RawInventoryRecipeComponentRow = {
  id: number;
  recipe_id: number;
  input_inventory_item_id: number;
  quantity_units: number | string;
  sort_order: number | string;
};

type RawProductInventoryLinkRow = {
  id: number;
  product_id: number;
  inventory_item_id: number;
  deduction_mode: 'self_link' | 'recipe';
  quantity_units: number | string;
  sort_order: number | string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
};

type RawExchangeRateRow = {
  id: number;
  rate_bs_per_usd: number | string;
  effective_at: string;
  is_active: boolean;
};

type RawDeliveryPartnerRateRow = {
  id: number;
  partner_id: number;
  km_from: number | string;
  km_to: number | string | null;
  price_usd: number | string;
  is_active: boolean;
  created_at: string;
};

type RawAdvisorRow = {
  id: string;
  full_name: string | null;
  is_active: boolean | null;
};


type RawProductComponentRow = {
  id: number;
  parent_product_id: number;
  component_product_id: number;
  component_mode: 'fixed' | 'selectable';
  quantity: number | string;
  counts_toward_detail_limit: boolean;
  is_required: boolean;
  sort_order: number | string;
  notes: string | null;
parent_product:
  | {
      id: number;
      sku: string | null;
      name: string;
      type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
    }
  | {
      id: number;
      sku: string | null;
      name: string;
      type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
    }[]
  | null;

component_product:
  | {
      id: number;
      sku: string | null;
      name: string;
      type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
    }
  | {
      id: number;
      sku: string | null;
      name: string;
      type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
    }[]
  | null;
};

type RawOrderEventRow = {
  id: string;
  order_id: number;
  event_type: string | null;
  event_group: string | null;
  title: string | null;
  message: string | null;
  severity: 'info' | 'warning' | 'critical' | string;
  actor_user_id: string | null;
  payload: any;
  created_at: string;
  event?: string | null;
  performed_by?: string | null;
  meta?: any;
  order_number?: string | null;
};

function toNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function repairDisplayText(value: string | null | undefined) {
  return String(value ?? '')
    .replace(/Â·/g, '·')
    .replace(/â€¦/g, '…')
    .replace(/â€”/g, '—')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ')
    .replace(/Ã/g, 'Á')
    .replace(/Ã‰/g, 'É')
    .replace(/Ã/g, 'Í')
    .replace(/Ã“/g, 'Ó')
    .replace(/Ãš/g, 'Ú')
    .replace(/Ã‘/g, 'Ñ')
    .trim();
}

function normalizeLegacyOrderEvent(params: {
  event: RawOrderEventRow;
  fulfillment: 'pickup' | 'delivery';
}) {
  const legacyType = String(params.event.event || '').trim();
  const meta =
    params.event.meta && typeof params.event.meta === 'object' && !Array.isArray(params.event.meta)
      ? (params.event.meta as Record<string, unknown>)
      : {};

  switch (legacyType) {
    case 'approved':
      return {
        eventType: 'approved',
        eventGroup: 'approval',
        title: 'Orden aprobada',
        message: 'La orden fue aprobada.',
        severity: 'info' as const,
        payload: meta,
      };
    case 'sent_to_kitchen':
      return {
        eventType: 'sent_to_kitchen',
        eventGroup: 'kitchen',
        title: 'Enviada a cocina',
        message: 'La orden fue enviada a cocina.',
        severity: 'info' as const,
        payload: meta,
      };
    case 'kitchen_started':
      return {
        eventType: 'kitchen_started',
        eventGroup: 'kitchen',
        title: 'Cocina tomó la orden',
        message:
          typeof meta.eta_minutes === 'number'
            ? `Tiempo estimado de preparación: ${meta.eta_minutes} min.`
            : 'Cocina inició la preparación.',
        severity: 'info' as const,
        payload: meta,
      };
    case 'ready':
      return {
        eventType: 'ready',
        eventGroup: 'kitchen',
        title: params.fulfillment === 'pickup' ? 'Lista para retiro' : 'Orden preparada',
        message:
          params.fulfillment === 'pickup'
            ? 'La orden quedó lista para retiro.'
            : 'La orden quedó preparada para despacho.',
        severity: 'info' as const,
        payload: meta,
      };
    case 'out_for_delivery':
      return {
        eventType: 'out_for_delivery',
        eventGroup: 'delivery',
        title: 'En camino',
        message: 'La orden salió en camino.',
        severity: 'info' as const,
        payload: meta,
      };
    case 'delivered':
      return {
        eventType: 'delivered',
        eventGroup: 'delivery',
        title: params.fulfillment === 'pickup' ? 'Orden retirada' : 'Orden entregada',
        message:
          params.fulfillment === 'pickup'
            ? 'La orden fue retirada.'
            : 'La orden fue entregada.',
        severity: 'info' as const,
        payload: meta,
      };
    case 'internal_driver_assigned':
      return {
        eventType: 'internal_driver_assigned',
        eventGroup: 'delivery',
        title: 'Motorizado interno asignado',
        message: 'Se asignó un motorizado interno a la orden.',
        severity: 'info' as const,
        payload: meta,
      };
    case 'external_partner_assigned':
      return {
        eventType: 'external_partner_assigned',
        eventGroup: 'delivery',
        title: 'Partner externo asignado',
        message: 'Se asignó un partner externo a la orden.',
        severity: 'info' as const,
        payload: meta,
      };
    default:
      return {
        eventType: legacyType || 'legacy',
        eventGroup: 'legacy',
        title: 'Evento de orden',
        message: legacyType ? repairDisplayText(legacyType.replace(/_/g, ' ')) : 'Evento registrado.',
        severity: 'info' as const,
        payload: meta,
      };
  }
}

function buildDeliveryISO(extraFields: any, fallbackISO: string) {
  const schedule = extraFields?.schedule;
  const date = schedule?.date;
  const time24 = schedule?.time_24;

  if (typeof date === 'string' && typeof time24 === 'string') {
    const candidate = new Date(`${date}T${time24}:00-04:00`);
    if (!Number.isNaN(candidate.getTime())) {
      return candidate.toISOString();
    }
  }

  return fallbackISO;
}

function extractUnitsPerServiceFromName(name: string) {
  const match = name.match(/\((\d+)\s*UND\)/i);
  if (!match) return 0;

  const units = Number(match[1]);
  return Number.isFinite(units) ? units : 0;
}

function estimateBsFromUsd(usd: number, rateBsPerUsd: number) {
  if (!Number.isFinite(usd) || !Number.isFinite(rateBsPerUsd) || rateBsPerUsd <= 0) return 0;
  return usd * rateBsPerUsd;
}

export default async function MasterDashboardPage() {
  const supabase = await createSupabaseServer();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    redirect('/login');
  }

  const { data: rolesData, error: rolesError } = await supabase.rpc('get_my_roles');

  if (rolesError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando roles</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los roles del usuario.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {rolesError.message}
          </pre>
        </div>
      </div>
    );
  }

  const roles: string[] = Array.isArray(rolesData)
    ? rolesData
    : rolesData
      ? [rolesData]
      : [];

  const isAllowed = roles.includes('master') || roles.includes('admin');

  if (!isAllowed) {
    redirect('/app');
  }
const { data: currentProfile, error: currentProfileError } = await supabase
  .from('profiles')
  .select('full_name')
  .eq('id', user.id)
  .maybeSingle();

if (currentProfileError) {
  return (
    <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
      <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-lg font-semibold">Error cargando perfil actual</div>
        <div className="mt-2 text-sm text-[#B7B7C2]">
          No se pudo obtener el perfil del usuario actual.
        </div>
        <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
          {currentProfileError.message}
        </pre>
      </div>
    </div>
  );
}

const { data: userProfilesData, error: userProfilesError } = await supabase
  .from('profiles')
  .select('id, full_name, is_active, created_at')
  .order('created_at', { ascending: false })
  .limit(500);

if (userProfilesError) {
  return (
    <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
      <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-lg font-semibold">Error cargando usuarios</div>
        <div className="mt-2 text-sm text-[#B7B7C2]">
          No se pudieron obtener los perfiles de usuarios.
        </div>
        <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
          {userProfilesError.message}
        </pre>
      </div>
    </div>
  );
}

const { data: userRolesData, error: userRolesError } = await supabase.rpc('admin_list_user_roles');

if (userRolesError) {
  return (
    <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
      <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-lg font-semibold">Error cargando roles de usuarios</div>
        <div className="mt-2 text-sm text-[#B7B7C2]">
          No se pudieron obtener los roles administrativos.
        </div>
        <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
          {userRolesError.message}
        </pre>
      </div>
    </div>
  );
}

const authUserEmailById = await loadAuthUserEmailById();

const dashboardUsers = ((userProfilesData ?? []) as RawProfileRow[]).map((row) => ({
  id: String(row.id),
  fullName: row.full_name?.trim() || '',
  email: authUserEmailById.get(String(row.id)) ?? null,
  isActive: Boolean(row.is_active ?? true),
  createdAt: row.created_at ?? null,
}));

const dashboardUserRoles = ((userRolesData ?? []) as RawUserRoleRow[]).map((row) => ({
  userId: String(row.user_id),
  role: row.role,
}));

const {
  data: masterInboxStatesData,
  error: masterInboxStatesError,
} = await supabase
  .from('master_inbox_item_states')
  .select('item_id, item_type, order_id, status')
  .in('status', ['reviewed', 'resolved'])
  .limit(1000);

if (masterInboxStatesError) {
  const message = masterInboxStatesError.message || '';
  const code = 'code' in masterInboxStatesError ? String(masterInboxStatesError.code || '') : '';
  const missingTable =
    code === '42P01' ||
    code === 'PGRST205' ||
    message.toLowerCase().includes('does not exist') ||
    message.toLowerCase().includes('could not find') ||
    message.toLowerCase().includes('schema cache');

  if (!missingTable) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando estado del inbox</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los estados revisados del inbox operativo.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {masterInboxStatesError.message}
          </pre>
        </div>
      </div>
    );
  }

  console.warn('master_inbox_item_states not available yet', masterInboxStatesError.message);
}

const initialMasterInboxItemStates = ((masterInboxStatesData ?? []) as RawMasterInboxItemStateRow[])
  .filter((row) => row.status === 'reviewed' || row.status === 'resolved')
  .map((row) => ({
    itemId: String(row.item_id),
    itemType: row.item_type === 'event' ? 'event' as const : 'task' as const,
    orderId: row.order_id == null ? null : Number(row.order_id),
    status: row.status === 'resolved' ? 'resolved' as const : 'reviewed' as const,
  }));

const { data: deliveryPartnersData, error: deliveryPartnersError } = await supabase
  .from('delivery_partners')
  .select('id, name, partner_type, whatsapp_phone, is_active')
  .order('name', { ascending: true });

if (deliveryPartnersError) {
  return (
    <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
      <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-lg font-semibold">Error cargando partners de delivery</div>
        <div className="mt-2 text-sm text-[#B7B7C2]">
          No se pudieron obtener los partners externos de delivery.
        </div>
        <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
          {deliveryPartnersError.message}
        </pre>
      </div>
    </div>
  );
}

const deliveryPartnerOptions = ((deliveryPartnersData ?? []) as Array<{
  id: number;
  name: string;
  partner_type: string;
  whatsapp_phone: string | null;
  is_active: boolean;
}>).map((row) => ({
  id: Number(row.id),
  name: row.name,
  partnerType: row.partner_type,
  whatsappPhone: row.whatsapp_phone ?? null,
  isActive: row.is_active,
  rates: [] as Array<{
    id: number;
    partnerId: number;
    kmFrom: number;
    kmTo: number | null;
    priceUsd: number;
    isActive: boolean;
    createdAt: string;
  }>,
}));

const { data: deliveryPartnerRatesData, error: deliveryPartnerRatesError } = await supabase
  .from('delivery_partner_rates')
  .select('id, partner_id, km_from, km_to, price_usd, is_active, created_at')
  .order('partner_id', { ascending: true })
  .order('km_from', { ascending: true });

if (deliveryPartnerRatesError) {
  return (
    <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
      <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-lg font-semibold">Error cargando tarifas de delivery</div>
        <div className="mt-2 text-sm text-[#B7B7C2]">
          No se pudieron obtener las tarifas por partner externo.
        </div>
        <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
          {deliveryPartnerRatesError.message}
        </pre>
      </div>
    </div>
  );
}

const partnerRatesById = new Map<number, Array<{
  id: number;
  partnerId: number;
  kmFrom: number;
  kmTo: number | null;
  priceUsd: number;
  isActive: boolean;
  createdAt: string;
}>>();

for (const row of (deliveryPartnerRatesData ?? []) as RawDeliveryPartnerRateRow[]) {
  const partnerId = Number(row.partner_id);
  const current = partnerRatesById.get(partnerId) ?? [];
  current.push({
    id: Number(row.id),
    partnerId,
    kmFrom: toNumber(row.km_from, 0),
    kmTo: row.km_to == null ? null : toNumber(row.km_to, 0),
    priceUsd: toNumber(row.price_usd, 0),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  });
  partnerRatesById.set(partnerId, current);
}

for (const partner of deliveryPartnerOptions) {
  partner.rates = (partnerRatesById.get(partner.id) ?? []).sort((a, b) => a.kmFrom - b.kmFrom);
}

const deliveryPartnerNameById = new Map<number, string>(
  deliveryPartnerOptions.map((partner) => [partner.id, partner.name])
);

const { data: advisorsRpcData, error: advisorsRpcError } = await supabase.rpc(
  'get_advisor_profiles'
);

const { data: driversRpcData, error: driversRpcError } = await supabase.rpc(
  'get_driver_profiles'
);

if (driversRpcError) {
  return (
    <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
      <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-lg font-semibold">Error cargando drivers</div>
        <div className="mt-2 text-sm text-[#B7B7C2]">
          No se pudieron obtener los drivers internos.
        </div>
        <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
          {driversRpcError.message}
        </pre>
      </div>
    </div>
  );
}

const driverOptions = ((driversRpcData ?? []) as Array<{
  user_id: string;
  full_name: string | null;
  is_active: boolean | null;
}>)
  .map((row) => ({
    id: String(row.user_id),
    fullName: row.full_name?.trim() || 'Sin nombre',
  }))
  .sort((a, b) => a.fullName.localeCompare(b.fullName));

if (advisorsRpcError) {
  return (
    <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
      <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-lg font-semibold">Error cargando asesores</div>
        <div className="mt-2 text-sm text-[#B7B7C2]">
          No se pudieron obtener los advisors.
        </div>
        <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
          {advisorsRpcError.message}
        </pre>
      </div>
    </div>
  );
}

const advisorOptions = ((advisorsRpcData ?? []) as Array<{
  user_id: string;
  full_name: string | null;
  is_active: boolean | null;
}>)
  .map((row) => ({
    userId: String(row.user_id),
    fullName: row.full_name?.trim() || 'Sin nombre',
    isActive: Boolean(row.is_active ?? true),
  }))
  .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const { data: exchangeRateData, error: exchangeRateError } = await supabase
    .from('exchange_rates')
    .select('id, rate_bs_per_usd, effective_at, is_active')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (exchangeRateError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando tasa activa</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudo obtener la tasa activa.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {exchangeRateError.message}
          </pre>
        </div>
      </div>
    );
  }

  const activeRateRow = exchangeRateData as RawExchangeRateRow | null;
  const activeRateBsPerUsd = activeRateRow ? toNumber(activeRateRow.rate_bs_per_usd, 0) : 0;

const { data: ordersData, error: ordersError } = await supabase
  .from('orders')
  .select(`
      id,
      order_number,
      client_id,
      attributed_advisor_id,
      source,
      fulfillment,
      delivery_address,
      status,
      total_usd,
      total_bs_snapshot,
      notes,
      created_at,
      sent_to_kitchen_at,
      kitchen_started_at,
      ready_at,
      extra_fields,
      queued_needs_reapproval,
      external_driver_name,
      external_partner_id,
      internal_driver_user_id,
      eta_minutes,
      client:clients!orders_client_id_fkey (
        full_name,
        phone
      ),
      advisor:profiles!orders_attributed_advisor_id_fkey (
        full_name
      ),
      creator:profiles!orders_created_by_user_id_fkey (
        full_name
      )
    `)
    .order('created_at', { ascending: false })
    .limit(200);

  if (ordersError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando Ã³rdenes</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener las Ã³rdenes.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {ordersError.message}
          </pre>
        </div>
      </div>
    );
  }

  const rawOrders = (ordersData ?? []) as RawOrderRow[];
  const orderIds = rawOrders.map((o) => o.id);

  const orderEventsByOrder = new Map<
    number,
    Array<{
      id: string;
      eventType: string;
      eventGroup: string;
      title: string;
      message: string | null;
      severity: 'info' | 'warning' | 'critical';
      actorUserId: string | null;
      actorName: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }>
  >();

  try {
    const { data: orderEventsData, error: orderEventsError } = await supabase
      .from('order_timeline_events')
      .select('id, order_id, event_type, event_group, title, message, severity, actor_user_id, payload, created_at')
      .in('order_id', orderIds.length > 0 ? orderIds : [-1])
      .order('created_at', { ascending: false });

    const { data: legacyOrderEventsData, error: legacyOrderEventsError } = await supabase
      .from('order_events')
      .select('id, order_id, order_number, event_type, event_group, title, message, severity, actor_user_id, payload, created_at, event, performed_by, meta')
      .in('order_id', orderIds.length > 0 ? orderIds : [-1])
      .order('created_at', { ascending: false });

    const rawOrderEvents = [
      ...(orderEventsError ? [] : ((orderEventsData ?? []) as RawOrderEventRow[])),
      ...(legacyOrderEventsError ? [] : ((legacyOrderEventsData ?? []) as RawOrderEventRow[])),
    ];
    const orderEventActorIds = Array.from(
      new Set(
        rawOrderEvents
          .flatMap((event) => [event.actor_user_id, event.performed_by ?? null])
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const { data: orderEventActorsData } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in(
        'id',
        orderEventActorIds.length > 0
          ? orderEventActorIds
          : ['00000000-0000-0000-0000-000000000000'],
      );

    const orderEventActorNameById = new Map<string, string>();
    for (const row of orderEventActorsData ?? []) {
      orderEventActorNameById.set(
        String(row.id),
        repairDisplayText(row.full_name?.trim() || 'Usuario'),
      );
    }

    for (const event of rawOrderEvents) {
      const orderId = Number(event.order_id);
      if (!Number.isFinite(orderId) || orderId <= 0) continue;

      const sourceOrder = rawOrders.find((row) => row.id === orderId);
      const isLegacyEvent = !event.event_type && !!event.event;
      const normalizedLegacy = isLegacyEvent
        ? normalizeLegacyOrderEvent({
            event,
            fulfillment: sourceOrder?.fulfillment === 'delivery' ? 'delivery' : 'pickup',
          })
        : null;
      const actorUserId = event.actor_user_id ?? event.performed_by ?? null;
      const bucket = orderEventsByOrder.get(orderId) ?? [];
      bucket.push({
        id: `${isLegacyEvent ? 'legacy' : 'timeline'}-${String(event.id ?? '')}`,
        eventType: normalizedLegacy?.eventType ?? String(event.event_type || ''),
        eventGroup: normalizedLegacy?.eventGroup ?? String(event.event_group || ''),
        title: repairDisplayText(normalizedLegacy?.title ?? String(event.title || 'Evento')),
        message: normalizedLegacy?.message
          ? repairDisplayText(normalizedLegacy.message)
          : event.message
            ? repairDisplayText(String(event.message))
            : null,
        severity:
          (normalizedLegacy?.severity ?? event.severity) === 'warning' || (normalizedLegacy?.severity ?? event.severity) === 'critical'
            ? ((normalizedLegacy?.severity ?? event.severity) as 'warning' | 'critical')
            : 'info',
        actorUserId,
        actorName: orderEventActorNameById.get(String(actorUserId || '')) || 'Sistema',
        payload: normalizedLegacy?.payload ?? (
          event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {}
        ),
        createdAt: String(event.created_at || ''),
      });
      orderEventsByOrder.set(orderId, bucket);
    }

    for (const [orderId, bucket] of orderEventsByOrder.entries()) {
      bucket.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      orderEventsByOrder.set(orderId, bucket);
    }
  } catch {
    // If notifications are partially configured or malformed, keep the dashboard usable.
  }

  const internalDriverIds = Array.from(
    new Set(
      rawOrders
        .map((o) => o.internal_driver_user_id)
        .filter((x): x is string => !!x)
    )
  );

  const { data: internalDriversData, error: internalDriversError } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in(
      'id',
      internalDriverIds.length > 0
        ? internalDriverIds
        : ['00000000-0000-0000-0000-000000000000']
    );

  if (internalDriversError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando drivers internos</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los drivers internos.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {internalDriversError.message}
          </pre>
        </div>
      </div>
    );
  }

  const internalDriverNameById = new Map<string, string>();
  for (const d of internalDriversData ?? []) {
    internalDriverNameById.set(String(d.id), d.full_name ?? 'Driver');
  }

  const { data: orderItemsData, error: orderItemsError } = await supabase
  .from('order_items')
  .select(`
      id,
      order_id,
      product_id,
      qty,
      pricing_origin_currency,
      pricing_origin_amount,
      unit_price_usd_snapshot,
      line_total_usd,
      admin_price_override_usd,
      admin_price_override_reason,
      admin_price_override_by_user_id,
      admin_price_override_at,
      unit_price_bs_snapshot,
      line_total_bs_snapshot,
      product_name_snapshot,
      sku_snapshot,
      notes
    `)
  .in('order_id', orderIds.length > 0 ? orderIds : [-1]);

  if (orderItemsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando items de Ã³rdenes</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los items de las Ã³rdenes.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {orderItemsError.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data: reportsData } = await supabase
    .from('payment_reports')
    .select(`
      id,
      order_id,
      status,
      created_at,
      created_by_user_id,
      reported_currency_code,
      reported_amount,
      reported_exchange_rate_ves_per_usd,
      reported_amount_usd_equivalent,
      reported_money_account_id,
      reference_code,
      payer_name,
      notes
    `)
    .in('order_id', orderIds.length > 0 ? orderIds : [-1])
    .order('created_at', { ascending: false });

  const { data: movementsData, error: movementsError } = await supabase
    .from('money_movements')
    .select(`
      id,
      movement_date,
      created_at,
      created_by_user_id,
      confirmed_at,
      confirmed_by_user_id,
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
    `)
    .order('movement_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1000);

  const rawOrderItems = (orderItemsData ?? []) as RawOrderItemRow[];

  const { data: orderAdjustmentsData, error: orderAdjustmentsError } = await supabase
    .from('order_admin_adjustments')
    .select(
      'id, order_id, order_item_id, adjustment_type, reason, notes, payload, created_at, created_by_user_id'
    )
    .in('order_id', orderIds)
    .order('created_at', { ascending: false });

  if (orderAdjustmentsError) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Error cargando ajustes administrativos</h1>
        <pre>{orderAdjustmentsError.message}</pre>
      </div>
    );
  }

  const rawOrderAdjustments = (orderAdjustmentsData ?? []) as RawOrderAdjustmentRow[];

  const adjustmentCreatorIds = Array.from(
    new Set(
      rawOrderAdjustments
        .map((row) => row.created_by_user_id)
        .filter((x): x is string => !!x)
    )
  );

  const { data: adjustmentCreatorsData, error: adjustmentCreatorsError } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in(
      'id',
      adjustmentCreatorIds.length > 0
        ? adjustmentCreatorIds
        : ['00000000-0000-0000-0000-000000000000']
    );

  if (adjustmentCreatorsError) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Error cargando autores de ajustes</h1>
        <pre>{adjustmentCreatorsError.message}</pre>
      </div>
    );
  }

  const adjustmentCreatorNameById = new Map<string, string>();
  for (const row of adjustmentCreatorsData ?? []) {
    adjustmentCreatorNameById.set(String(row.id), row.full_name ?? 'Admin');
  }

  const { data: moneyAccountsData, error: moneyAccountsError } = await supabase
    .from('money_accounts')
    .select('id, name, currency_code, account_kind, institution_name, owner_name, notes, is_active, created_at, created_by_user_id')
    .order('id', { ascending: true });

  const rawReports = (reportsData ?? []) as RawPaymentReportRow[];
  const reporterIds = Array.from(
    new Set(
      rawReports
        .map((r) => r.created_by_user_id)
        .filter((x): x is string => !!x)
    )
  );

  const { data: reportersData, error: reportersError } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in(
      'id',
      reporterIds.length > 0
        ? reporterIds
        : ['00000000-0000-0000-0000-000000000000']
    );

  if (reportersError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando reportadores</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los usuarios que reportaron pagos.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {reportersError.message}
          </pre>
        </div>
      </div>
    );
  }

  const reporterNameById = new Map<string, string>();
  for (const r of reportersData ?? []) {
    reporterNameById.set(String(r.id), r.full_name ?? 'Usuario');
  }

  if (moneyAccountsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando cuentas</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener las cuentas activas.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {moneyAccountsError.message}
          </pre>
        </div>
      </div>
    );
  }

  if (movementsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando movimientos</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los movimientos de cuentas.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {movementsError.message}
          </pre>
        </div>
      </div>
    );
  }

  const moneyAccounts = ((moneyAccountsData ?? []) as MoneyAccountRow[]).map((a) => ({
    id: Number(a.id),
    name: a.name,
    currencyCode: a.currency_code as 'USD' | 'VES',
    accountKind: a.account_kind as 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet',
    institutionName: a.institution_name ?? '',
    ownerName: a.owner_name ?? '',
    notes: a.notes ?? '',
    isActive: a.is_active,
    createdAt: a.created_at,
    createdByUserId: a.created_by_user_id,
  }));

  const moneyMovements = ((movementsData ?? []) as RawMoneyMovementRow[]).map((mv) => ({
    id: Number(mv.id),
    movementDate: mv.movement_date,
    createdAt: mv.created_at,
    createdByUserId: mv.created_by_user_id,
    confirmedAt: mv.confirmed_at,
    confirmedByUserId: mv.confirmed_by_user_id,
    direction: mv.direction,
    movementType: mv.movement_type,
    moneyAccountId: Number(mv.money_account_id),
    currencyCode: mv.currency_code,
    amount: toNumber(mv.amount, 0),
    exchangeRateVesPerUsd:
      mv.exchange_rate_ves_per_usd == null ? null : toNumber(mv.exchange_rate_ves_per_usd, 0),
    amountUsdEquivalent: toNumber(mv.amount_usd_equivalent, 0),
    referenceCode: mv.reference_code ?? null,
    counterpartyName: mv.counterparty_name ?? null,
    description: mv.description ?? null,
    notes: mv.notes ?? null,
    orderId: mv.order_id == null ? null : Number(mv.order_id),
    paymentReportId: mv.payment_report_id == null ? null : Number(mv.payment_report_id),
    movementGroupId: mv.movement_group_id ?? null,
  }));

  const { count: clientTotalCount, error: clientTotalCountError } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true });

  if (clientTotalCountError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error contando clientes</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudo obtener el total de clientes.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {clientTotalCountError.message}
          </pre>
        </div>
      </div>
    );
  }

  const { count: clientActiveCount, error: clientActiveCountError } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true);

  if (clientActiveCountError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error contando clientes activos</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudo obtener el total de clientes activos.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {clientActiveCountError.message}
          </pre>
        </div>
      </div>
    );
  }

  const clientSelect = `
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
    `;

  const clientsPageSize = 1000;
  let clientsError: { message: string } | null = null;
  const clientsRows: RawClientRow[] = [];

  for (let pageFrom = 0; pageFrom < 10000; pageFrom += clientsPageSize) {
    const pageTo = pageFrom + clientsPageSize - 1;
    const { data, error } = await supabase
      .from('clients')
      .select(clientSelect)
      .order('updated_at', { ascending: false })
      .range(pageFrom, pageTo);

    if (error) {
      clientsError = error;
      break;
    }

    const batch = (data ?? []) as RawClientRow[];
    clientsRows.push(...batch);

    if (batch.length < clientsPageSize) {
      break;
    }
  }

  if (clientsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando clientes</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudo obtener la ficha de clientes.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {clientsError.message}
          </pre>
        </div>
      </div>
    );
  }

  const clients = clientsRows.map((client) => ({
    id: Number(client.id),
    fullName: client.full_name,
    phone: client.phone ?? '',
    notes: client.notes ?? '',
    primaryAdvisorId: client.primary_advisor_id ?? null,
    createdAt: client.created_at,
    clientType: client.client_type ?? '',
    isActive: client.is_active,
    birthDate: client.birth_date ?? '',
    importantDate: client.important_date ?? '',
    billingCompanyName: client.billing_company_name ?? '',
    billingTaxId: client.billing_tax_id ?? '',
    billingAddress: client.billing_address ?? '',
    billingPhone: client.billing_phone ?? '',
    deliveryNoteName: client.delivery_note_name ?? '',
    deliveryNoteDocumentId: client.delivery_note_document_id ?? '',
    deliveryNoteAddress: client.delivery_note_address ?? '',
    deliveryNotePhone: client.delivery_note_phone ?? '',
    recentAddresses: Array.isArray(client.recent_addresses) ? client.recent_addresses : [],
    crmTags: Array.isArray(client.crm_tags) ? client.crm_tags : [],
    fundBalanceUsd: toNumber(client.fund_balance_usd, 0),
    extraFields:
      client.extra_fields && typeof client.extra_fields === 'object'
        ? (client.extra_fields as Record<string, unknown>)
        : ({} as Record<string, unknown>),
    updatedAt: client.updated_at,
  }));

  const moneyAccountNameById = new Map<number, string>();
  for (const a of moneyAccounts) {
    moneyAccountNameById.set(Number(a.id), a.name);
  }

  const itemsByOrder = new Map<number, RawOrderItemRow[]>();
  for (const item of rawOrderItems) {
    const orderId = Number(item.order_id);
    const arr = itemsByOrder.get(orderId) ?? [];
    arr.push(item);
    itemsByOrder.set(orderId, arr);
  }

  const adjustmentsByOrder = new Map<number, RawOrderAdjustmentRow[]>();
  for (const adjustment of rawOrderAdjustments) {
    const orderId = Number(adjustment.order_id);
    const arr = adjustmentsByOrder.get(orderId) ?? [];
    arr.push(adjustment);
    adjustmentsByOrder.set(orderId, arr);
  }

  const paymentReportsByOrder = new Map<number, PaymentReportDetail[]>();

  for (const rp of rawReports) {
    const orderId = Number(rp.order_id);

    const detail: PaymentReportDetail = {
      id: Number(rp.id),
      status: rp.status,
      createdAt: rp.created_at ?? null,
      reporterUserId: rp.created_by_user_id ?? null,
      reporterName: rp.created_by_user_id
        ? reporterNameById.get(rp.created_by_user_id) ?? 'Usuario'
        : 'Usuario',
      currencyCode: String(rp.reported_currency_code),
      amount: toNumber(rp.reported_amount, 0),
      exchangeRate:
        rp.reported_exchange_rate_ves_per_usd == null
          ? null
          : toNumber(rp.reported_exchange_rate_ves_per_usd, 0),
      usdEquivalent: toNumber(rp.reported_amount_usd_equivalent, 0),
      moneyAccountId: Number(rp.reported_money_account_id),
      moneyAccountName:
        moneyAccountNameById.get(Number(rp.reported_money_account_id)) ??
        `Cuenta #${rp.reported_money_account_id}`,
      referenceCode: rp.reference_code ?? null,
      payerName: rp.payer_name ?? null,
      notes: rp.notes ?? null,
    };

    const arr = paymentReportsByOrder.get(orderId) ?? [];
    arr.push(detail);
    paymentReportsByOrder.set(orderId, arr);
  }

  const confirmedPaidByOrder = new Map<number, number>();
  for (const mv of movementsData ?? []) {
    const orderId = Number(mv.order_id);
    const amt =
      toNumber(mv.amount_usd_equivalent, 0) *
      (mv.direction === 'outflow' ? -1 : 1);
    confirmedPaidByOrder.set(orderId, (confirmedPaidByOrder.get(orderId) ?? 0) + amt);
  }

  const reportsByOrder = new Map<
    number,
    {
      pendingCount: number;
      confirmedCount: number;
      rejectedCount: number;
      pendingUsd: number;
      rejectedUsd: number;
      latestPendingReport: {
        id: number;
        created_at: string | null;
        reported_currency_code: string;
        reported_amount: number;
        reported_exchange_rate_ves_per_usd: number | null;
        reported_amount_usd_equivalent: number;
        reported_money_account_id: number;
        reference_code: string | null;
        payer_name: string | null;
        notes: string | null;
      } | null;
    }
  >();

  for (const rp of reportsData ?? []) {
    const orderId = Number(rp.order_id);
    const amountUsd = toNumber(rp.reported_amount_usd_equivalent, 0);

    let state = reportsByOrder.get(orderId);

    if (!state) {
      state = {
        pendingCount: 0,
        confirmedCount: 0,
        rejectedCount: 0,
        pendingUsd: 0,
        rejectedUsd: 0,
        latestPendingReport: null,
      };
      reportsByOrder.set(orderId, state);
    }

    if (rp.status === 'pending') {
      state.pendingCount += 1;
      state.pendingUsd += amountUsd;

      if (!state.latestPendingReport) {
        state.latestPendingReport = {
          id: Number(rp.id),
          created_at: rp.created_at ?? null,
          reported_currency_code: String(rp.reported_currency_code),
          reported_amount: toNumber(rp.reported_amount, 0),
          reported_exchange_rate_ves_per_usd:
            rp.reported_exchange_rate_ves_per_usd == null
              ? null
              : toNumber(rp.reported_exchange_rate_ves_per_usd, 0),
          reported_amount_usd_equivalent: amountUsd,
          reported_money_account_id: Number(rp.reported_money_account_id),
          reference_code: rp.reference_code ?? null,
          payer_name: rp.payer_name ?? null,
          notes: rp.notes ?? null,
        };
      }
    } else if (rp.status === 'confirmed') {
      state.confirmedCount += 1;
    } else if (rp.status === 'rejected') {
      state.rejectedCount += 1;
      state.rejectedUsd += amountUsd;
    }
  }

  const { data: productsData, error: productsError } = await supabase
    .from('products')
    .select(`
      id,
      sku,
      name,
      type,
      is_active,
      source_price_amount,
      source_price_currency,
      base_price_usd,
      base_price_bs,
      units_per_service,
      is_detail_editable,
      detail_units_limit,
      is_inventory_item,
      is_temporary,
      is_combo_component_selectable,
      commission_mode,
      commission_value,
      commission_notes,
      internal_rider_pay_usd,
      inventory_enabled,
      inventory_kind,
      inventory_deduction_mode,
      inventory_unit_name,
      packaging_name,
      packaging_size,
      current_stock_units,
      low_stock_threshold,
      inventory_group
    `)
    .order('id', { ascending: true });

  const { data: inventoryItemsData, error: inventoryItemsError } = await supabase
    .from('inventory_items')
    .select(`
      id,
      name,
      inventory_kind,
      unit_name,
      packaging_name,
      packaging_size,
      current_stock_units,
      low_stock_threshold,
      inventory_group,
      is_active,
      notes,
      created_at
    `)
    .order('is_active', { ascending: false })
    .order('name', { ascending: true });

  if (inventoryItemsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando inventario interno</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los items internos de inventario.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {inventoryItemsError.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data: inventoryMovementsData, error: inventoryMovementsError } = await supabase
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
    .limit(500);

  if (productsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando catÃ¡logo</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudo obtener la tabla de productos.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {productsError.message}
          </pre>
        </div>
      </div>
    );
  }

  if (inventoryMovementsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando inventario</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los movimientos de inventario.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {inventoryMovementsError.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data: inventoryRecipesData, error: inventoryRecipesError } = await supabase
    .from('inventory_recipes')
    .select(`
      id,
      output_inventory_item_id,
      recipe_kind,
      output_quantity_units,
      notes,
      is_active,
      created_at
    `)
    .order('created_at', { ascending: false });

  if (inventoryRecipesError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando recetas de inventario</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener las recetas de producciÃ³n/empaque.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {inventoryRecipesError.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data: inventoryRecipeComponentsData, error: inventoryRecipeComponentsError } = await supabase
    .from('inventory_recipe_components')
    .select(`
      id,
      recipe_id,
      input_inventory_item_id,
      quantity_units,
      sort_order
    `)
    .order('recipe_id', { ascending: true })
    .order('sort_order', { ascending: true });

  if (inventoryRecipeComponentsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando componentes de recetas</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los componentes de producciÃ³n/empaque.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {inventoryRecipeComponentsError.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data: productInventoryLinksData, error: productInventoryLinksError } = await supabase
    .from('product_inventory_links')
    .select(`
      id,
      product_id,
      inventory_item_id,
      deduction_mode,
      quantity_units,
      sort_order,
      notes,
      is_active,
      created_at
    `)
    .order('product_id', { ascending: true })
    .order('sort_order', { ascending: true });

  if (productInventoryLinksError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando enlaces de inventario</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los descuentos por composiciÃ³n del catÃ¡logo.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {productInventoryLinksError.message}
          </pre>
        </div>
      </div>
    );
  }

  const { data: productComponentsData, error: productComponentsError } = await supabase
    .from('product_components')
    .select(`
      id,
      parent_product_id,
      component_product_id,
      component_mode,
      quantity,
      counts_toward_detail_limit,
      is_required,
      sort_order,
      notes,
      parent_product:products!product_components_parent_product_id_fkey (
        id,
        sku,
        name,
        type
      ),
      component_product:products!product_components_component_product_id_fkey (
        id,
        sku,
        name,
        type
      )
    `)
    .order('parent_product_id', { ascending: true })
    .order('sort_order', { ascending: true });

  if (productComponentsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando composiciÃ³n de productos</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudo obtener la composiciÃ³n de combos/productos.
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-[#0B0B0D] p-3 text-xs text-[#B7B7C2]">
            {productComponentsError.message}
          </pre>
        </div>
      </div>
    );
  }

  const catalogItems = ((productsData ?? []) as RawProductRow[]).map((p) => ({
    id: Number(p.id),
    sku: p.sku ?? '',
    name: p.name,
    type: p.type,
    isActive: p.is_active,
    sourcePriceAmount: toNumber(p.source_price_amount, 0),
    sourcePriceCurrency: p.source_price_currency,
    basePriceUsd: toNumber(p.base_price_usd, 0),
    basePriceBs: toNumber(p.base_price_bs, 0),
    unitsPerService: toNumber(p.units_per_service, 0),
    isDetailEditable: p.is_detail_editable,
    detailUnitsLimit: toNumber(p.detail_units_limit, 0),
    isInventoryItem: p.is_inventory_item,
    isTemporary: p.is_temporary,
    isComboComponentSelectable: p.is_combo_component_selectable,
    commissionMode:
      p.commission_mode === 'fixed_item'
        ? ('fixed_item' as const)
        : p.commission_mode === 'fixed_order'
          ? ('fixed_order' as const)
          : ('default' as const),
    commissionValue: p.commission_value == null ? null : toNumber(p.commission_value, 0),
    commissionNotes: p.commission_notes ?? null,
    internalRiderPayUsd: p.internal_rider_pay_usd == null ? null : toNumber(p.internal_rider_pay_usd, 0),
    inventoryEnabled: p.inventory_enabled,
    inventoryKind:
      p.inventory_kind === 'raw_material'
        ? ('raw_material' as const)
        : p.inventory_kind === 'prepared_base'
          ? ('prepared_base' as const)
          : ('finished_good' as const),
    inventoryDeductionMode:
      p.inventory_deduction_mode === 'composition'
        ? ('composition' as const)
        : ('self' as const),
    inventoryUnitName: p.inventory_unit_name ?? 'pieza',
    packagingName: p.packaging_name ?? null,
    packagingSize: p.packaging_size == null ? null : toNumber(p.packaging_size, 0),
    currentStockUnits: toNumber(p.current_stock_units, 0),
    lowStockThreshold: p.low_stock_threshold == null ? null : toNumber(p.low_stock_threshold, 0),
    inventoryGroup:
      p.inventory_group === 'raw' ||
      p.inventory_group === 'fried' ||
      p.inventory_group === 'prefried' ||
      p.inventory_group === 'sauces' ||
      p.inventory_group === 'packaging'
        ? p.inventory_group
        : ('other' as const),
  }));

  const catalogItemById = new Map(catalogItems.map((item) => [item.id, item]));

  const inventoryItems = ((inventoryItemsData ?? []) as RawInventoryItemRow[]).map((row) => ({
    id: Number(row.id),
    name: row.name,
    inventoryKind: row.inventory_kind,
    unitName: row.unit_name ?? 'pieza',
    packagingName: row.packaging_name ?? null,
    packagingSize: row.packaging_size == null ? null : toNumber(row.packaging_size, 0),
    currentStockUnits: toNumber(row.current_stock_units, 0),
    lowStockThreshold: row.low_stock_threshold == null ? null : toNumber(row.low_stock_threshold, 0),
    inventoryGroup:
      row.inventory_group === 'raw' ||
      row.inventory_group === 'fried' ||
      row.inventory_group === 'prefried' ||
      row.inventory_group === 'sauces' ||
      row.inventory_group === 'packaging'
        ? row.inventory_group
        : ('other' as const),
    isActive: Boolean(row.is_active),
    notes: row.notes ?? null,
    createdAt: row.created_at,
  }));

  const inventoryMovements = ((inventoryMovementsData ?? []) as RawInventoryMovementRow[]).map((row) => ({
    id: Number(row.id),
    inventoryItemId: Number(row.inventory_item_id),
    movementType: row.movement_type,
    quantityUnits: toNumber(row.quantity_units, 0),
    reasonCode: row.reason_code ?? null,
    notes: row.notes ?? null,
    orderId: row.order_id == null ? null : Number(row.order_id),
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
  }));

  const inventoryRecipes = ((inventoryRecipesData ?? []) as RawInventoryRecipeRow[]).map((row) => ({
    id: Number(row.id),
    outputInventoryItemId: Number(row.output_inventory_item_id),
    recipeKind: row.recipe_kind,
    outputQuantityUnits: toNumber(row.output_quantity_units, 0),
    notes: row.notes ?? null,
    isActive: row.is_active,
    createdAt: row.created_at,
  }));

  const inventoryRecipeComponents = ((inventoryRecipeComponentsData ?? []) as RawInventoryRecipeComponentRow[]).map((row) => ({
    id: Number(row.id),
    recipeId: Number(row.recipe_id),
    inputInventoryItemId: Number(row.input_inventory_item_id),
    quantityUnits: toNumber(row.quantity_units, 0),
    sortOrder: toNumber(row.sort_order, 0),
  }));

  const productInventoryLinks = ((productInventoryLinksData ?? []) as RawProductInventoryLinkRow[]).map((row) => ({
    id: Number(row.id),
    productId: Number(row.product_id),
    inventoryItemId: Number(row.inventory_item_id),
    deductionMode: row.deduction_mode === 'recipe' ? ('recipe' as const) : ('self_link' as const),
    quantityUnits: toNumber(row.quantity_units, 0),
    sortOrder: toNumber(row.sort_order, 0),
    notes: row.notes ?? null,
    isActive: !!row.is_active,
    createdAt: row.created_at,
  }));

const productComponents = ((productComponentsData ?? []) as RawProductComponentRow[])
  .map((row) => {
    const parent = Array.isArray(row.parent_product)
      ? row.parent_product[0]
      : row.parent_product;

    const component = Array.isArray(row.component_product)
      ? row.component_product[0]
      : row.component_product;

    return {
      id: Number(row.id),
      parentProductId: Number(row.parent_product_id),
      componentProductId: Number(row.component_product_id),
      componentMode: row.component_mode,
      quantity: toNumber(row.quantity, 0),
      countsTowardDetailLimit: row.counts_toward_detail_limit,
      isRequired: row.is_required,
      sortOrder: toNumber(row.sort_order, 0),
      notes: row.notes ?? null,
      parentSku: parent?.sku ?? '',
      parentName: parent?.name ?? 'Producto padre',
      componentSku: component?.sku ?? '',
      componentName: component?.name ?? 'Componente',
      componentType: component?.type ?? 'product',
    };
  })
  .filter((row) => row.parentProductId && row.componentProductId);
  const initialOrders: ComponentProps<typeof MasterDashboardClient>['initialOrders'] = rawOrders.map((row) => {
    const clientFundUsedUsd = toNumber(row.extra_fields?.payment?.client_fund_used_usd, 0);
    const confirmedPaidUsd = (confirmedPaidByOrder.get(row.id) ?? 0) + clientFundUsedUsd;
    const totalUsd = toNumber(
      row.extra_fields?.pricing?.total_usd,
      toNumber(row.total_usd, 0)
    );
    const balanceUsd = Math.max(0, totalUsd - confirmedPaidUsd);

    const reportState = reportsByOrder.get(row.id) ?? {
      pendingCount: 0,
      confirmedCount: 0,
      rejectedCount: 0,
      pendingUsd: 0,
      rejectedUsd: 0,
      latestPendingReport: null,
    };

    let paymentVerify: 'none' | 'pending' | 'confirmed' | 'rejected' = 'none';
    if (reportState.pendingCount > 0) paymentVerify = 'pending';
    else if (reportState.rejectedCount > 0) paymentVerify = 'rejected';
    else if (confirmedPaidUsd > 0.01 || reportState.confirmedCount > 0) paymentVerify = 'confirmed';

const creatorRow = Array.isArray(row.creator) ? row.creator[0] : row.creator;
const advisorRow = Array.isArray(row.advisor) ? row.advisor[0] : row.advisor;
const clientRow = Array.isArray(row.client) ? row.client[0] : row.client;

const creatorName = repairDisplayText(creatorRow?.full_name?.trim() || 'Usuario');
const advisorProfileName = repairDisplayText(advisorRow?.full_name?.trim() || null);

const advisorName =
  row.source === 'master'
    ? `M\u00E1ster (${creatorName})`
    : row.source === 'walk_in'
      ? `Walk-in (${creatorName})`
      : advisorProfileName || creatorName || 'Sin asesor';

const clientName = repairDisplayText(
  clientRow?.full_name?.trim() ||
  row.extra_fields?.receiver?.name?.trim() ||
  'Cliente sin nombre'
);

    const deliveryAtISO = buildDeliveryISO(row.extra_fields, row.created_at);

    const rowItems = itemsByOrder.get(row.id) ?? [];
    const paymentReports = paymentReportsByOrder.get(row.id) ?? [];
    const orderEvents = orderEventsByOrder.get(row.id) ?? [];
    const adminAdjustments = (adjustmentsByOrder.get(row.id) ?? []).map((adjustment) => ({
      id: Number(adjustment.id),
      orderItemId:
        adjustment.order_item_id == null ? null : Number(adjustment.order_item_id),
      adjustmentType: String(adjustment.adjustment_type || ''),
      reason: String(adjustment.reason || '').trim(),
      notes: adjustment.notes ?? null,
      payload: adjustment.payload ?? {},
      createdAt: adjustment.created_at,
      createdByUserId: adjustment.created_by_user_id,
      createdByName:
        adjustmentCreatorNameById.get(adjustment.created_by_user_id) ??
        'Admin',
    }));

const draftItems = rowItems.map((item) => {
  const qty = toNumber(item.qty, 0);
  const unitPriceUsdSnapshot = toNumber(item.unit_price_usd_snapshot, 0);
  const lineTotalUsd = toNumber(item.line_total_usd, unitPriceUsdSnapshot * qty);
const pricingOriginCurrency: 'VES' | 'USD' =
  (item as any).pricing_origin_currency === 'VES' ? 'VES' : 'USD';
  const pricingOriginAmount = toNumber(
    (item as any).pricing_origin_amount,
    pricingOriginCurrency === 'VES'
      ? toNumber((item as any).unit_price_bs_snapshot, 0)
      : unitPriceUsdSnapshot
  );

  return {
    localId: `existing-${item.id}`,
    productId: Number(item.product_id),
    skuSnapshot: item.sku_snapshot ?? null,
    productNameSnapshot: item.product_name_snapshot?.trim() || 'Producto',
    qty,
    sourcePriceCurrency: pricingOriginCurrency,
    sourcePriceAmount: pricingOriginAmount,
    unitPriceUsdSnapshot,
    lineTotalUsd,
    editableDetailLines: item.notes
      ? item.notes
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
      : [],
    adminPriceOverrideUsd:
      (item as any).admin_price_override_usd == null
        ? null
        : toNumber((item as any).admin_price_override_usd, 0),
    adminPriceOverrideReason: (item as any).admin_price_override_reason ?? null,
    adminPriceOverrideByUserId: (item as any).admin_price_override_by_user_id ?? null,
    adminPriceOverrideAt: (item as any).admin_price_override_at ?? null,
  };
});

const lines = rowItems.map((item) => {
  const productName = item.product_name_snapshot?.trim() || 'Producto';
  const qty = toNumber(item.qty, 0);
  const productId = Number(item.product_id);
  const productUnitsPerService = catalogItemById.get(productId)?.unitsPerService ?? 0;
  const unitsPerService =
    productUnitsPerService > 0
      ? productUnitsPerService
      : extractUnitsPerServiceFromName(productName);
  const unitPriceUsd = toNumber(item.unit_price_usd_snapshot, 0);
  const unitPriceBs = toNumber(
    (item as any).unit_price_bs_snapshot,
    estimateBsFromUsd(unitPriceUsd, activeRateBsPerUsd)
  );

  const isDelivery =
    productName.toLowerCase().startsWith('delivery') ||
    productName.toLowerCase().includes('delivery');

  return {
    name: productName,
    qty,
    unitsPerService,
    priceBs: unitPriceBs,
    productType: catalogItemById.get(productId)?.type,
    isDelivery,
    editableDetailLines: item.notes
      ? item.notes
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
      : [],
  };
});

return {
  id: row.id,
  orderNumber: row.order_number,
  createdAtISO: row.created_at,
  sentToKitchenAtISO: row.sent_to_kitchen_at ?? null,
  kitchenStartedAtISO: row.kitchen_started_at ?? null,
  readyAtISO: row.ready_at ?? null,
  deliveryAtISO,
  source: row.source,
  clientId: row.client_id ?? null,
  attributedAdvisorUserId: row.attributed_advisor_id ?? null,
      advisorName,
      clientName,
      fulfillment: row.fulfillment,
      address: row.delivery_address ?? undefined,
      status: row.status,
      queuedNeedsReapproval: row.queued_needs_reapproval ?? false,
      totalUsd,
      balanceUsd,
      totalBs: toNumber((row as any).total_bs_snapshot, toNumber(row.extra_fields?.pricing?.total_bs, estimateBsFromUsd(totalUsd, activeRateBsPerUsd))),
      paymentVerify,
      confirmedPaidUsd,
      pendingReportedUsd: reportState.pendingUsd,
      rejectedReportedUsd: reportState.rejectedUsd,
      latestPendingReportId: reportState.latestPendingReport?.id,
      latestPendingReportAmountUsd: reportState.latestPendingReport?.reported_amount_usd_equivalent,
      latestPendingReportCurrency: reportState.latestPendingReport?.reported_currency_code,
      latestPendingReportAmount: reportState.latestPendingReport?.reported_amount,
      latestPendingReportExchangeRate: reportState.latestPendingReport?.reported_exchange_rate_ves_per_usd ?? null,
      latestPendingReportMoneyAccountId: reportState.latestPendingReport?.reported_money_account_id,
      latestPendingReportReferenceCode: reportState.latestPendingReport?.reference_code ?? null,
      latestPendingReportPayerName: reportState.latestPendingReport?.payer_name ?? null,
      latestPendingReportNotes: reportState.latestPendingReport?.notes ?? null,
      latestPendingReportCreatedAt: reportState.latestPendingReport?.created_at ?? null,
      notes: row.notes ?? '',
      lines,
            editMeta: {
        clientId: row.client_id ?? null,
        source: row.source,
        attributedAdvisorUserId: row.attributed_advisor_id ?? null,
        isAsap: Boolean(row.extra_fields?.schedule?.asap ?? false),
        receiverName: row.extra_fields?.receiver?.name ?? null,
        receiverPhone: row.extra_fields?.receiver?.phone ?? null,
        deliveryGpsUrl: row.extra_fields?.delivery?.gps_url ?? null,
        kitchenEtaMinutes:
          row.eta_minutes != null
            ? toNumber(row.eta_minutes, 0)
            : null,
        deliveryEtaMinutes:
          row.extra_fields?.delivery?.eta_minutes != null
            ? toNumber(row.extra_fields.delivery.eta_minutes, 0)
            : row.eta_minutes != null
              ? toNumber(row.eta_minutes, 0)
              : null,
        deliveryEtaRecordedAtISO:
          row.extra_fields?.delivery?.eta_recorded_at != null
            ? String(row.extra_fields.delivery.eta_recorded_at)
            : null,
        deliveryCompletedAtISO:
          row.extra_fields?.delivery?.completed_at != null
            ? String(row.extra_fields.delivery.completed_at)
            : null,
        deliveryDistanceKm:
          row.extra_fields?.delivery?.distance_km != null
            ? toNumber(row.extra_fields.delivery.distance_km, 0)
            : null,
        deliveryCostUsd:
          row.extra_fields?.delivery?.cost_usd != null
            ? toNumber(row.extra_fields.delivery.cost_usd, 0)
            : null,
        deliveryCostSource:
          row.extra_fields?.delivery?.cost_source != null
            ? String(row.extra_fields.delivery.cost_source)
            : null,
        paymentMethod: row.extra_fields?.payment?.method ?? null,
        paymentCurrency: row.extra_fields?.payment?.currency ?? null,
        paymentRequiresChange: Boolean(row.extra_fields?.payment?.requires_change ?? false),
        paymentChangeFor:
          row.extra_fields?.payment?.change_for != null
            ? String(row.extra_fields.payment.change_for)
            : null,
        paymentChangeCurrency: row.extra_fields?.payment?.change_currency ?? null,
        paymentNote: row.extra_fields?.payment?.notes ?? null,
        clientFundUsedUsd:
          row.extra_fields?.payment?.client_fund_used_usd != null
            ? toNumber(row.extra_fields.payment.client_fund_used_usd, 0)
            : null,
        hasDeliveryNote: Boolean(row.extra_fields?.documents?.has_delivery_note ?? false),
        hasInvoice: Boolean(row.extra_fields?.documents?.has_invoice ?? false),
        invoiceDataNote: row.extra_fields?.documents?.invoice_data_note ?? null,
        invoiceSnapshot: row.extra_fields?.documents?.invoice_snapshot
          ? {
              companyName: row.extra_fields.documents.invoice_snapshot.company_name ?? null,
              taxId: row.extra_fields.documents.invoice_snapshot.tax_id ?? null,
              address: row.extra_fields.documents.invoice_snapshot.address ?? null,
              phone: row.extra_fields.documents.invoice_snapshot.phone ?? null,
            }
          : null,
        deliveryNoteSnapshot: row.extra_fields?.documents?.delivery_note_snapshot
          ? {
              name: row.extra_fields.documents.delivery_note_snapshot.name ?? null,
              documentId: row.extra_fields.documents.delivery_note_snapshot.document_id ?? null,
              address: row.extra_fields.documents.delivery_note_snapshot.address ?? null,
              phone: row.extra_fields.documents.delivery_note_snapshot.phone ?? null,
            }
          : null,
        fxRate:
          row.extra_fields?.pricing?.fx_rate != null
            ? toNumber(row.extra_fields.pricing.fx_rate, 0)
            : null,
        discountEnabled: Boolean(row.extra_fields?.pricing?.discount_enabled ?? false),
        discountPct:
          row.extra_fields?.pricing?.discount_pct != null
            ? toNumber(row.extra_fields.pricing.discount_pct, 0)
            : null,
        invoiceTaxPct:
          row.extra_fields?.pricing?.invoice_tax_pct != null
            ? toNumber(row.extra_fields.pricing.invoice_tax_pct, 0)
            : null,
        invoiceTaxAmountUsd:
          row.extra_fields?.pricing?.invoice_tax_amount_usd != null
            ? toNumber(row.extra_fields.pricing.invoice_tax_amount_usd, 0)
            : null,
        invoiceTaxAmountBs:
          row.extra_fields?.pricing?.invoice_tax_amount_bs != null
            ? toNumber(row.extra_fields.pricing.invoice_tax_amount_bs, 0)
            : null,
        subtotalBs:
          row.extra_fields?.pricing?.subtotal_bs != null
            ? toNumber(row.extra_fields.pricing.subtotal_bs, 0)
            : null,
        subtotalUsd:
          row.extra_fields?.pricing?.subtotal_usd != null
            ? toNumber(row.extra_fields.pricing.subtotal_usd, 0)
            : null,
        subtotalAfterDiscountBs:
          row.extra_fields?.pricing?.subtotal_after_discount_bs != null
            ? toNumber(row.extra_fields.pricing.subtotal_after_discount_bs, 0)
            : null,
        subtotalAfterDiscountUsd:
          row.extra_fields?.pricing?.subtotal_after_discount_usd != null
            ? toNumber(row.extra_fields.pricing.subtotal_after_discount_usd, 0)
            : null,
      },
      draftItems,
      events: orderEvents,
      paymentReports,
      adminAdjustments,
      internalDriverUserId: row.internal_driver_user_id ?? null,
      externalPartnerId: row.external_partner_id ?? null,
      riderName:
        (row.internal_driver_user_id
          ? internalDriverNameById.get(row.internal_driver_user_id)
          : null) ||
        row.external_driver_name ||
        undefined,
      externalPartner: row.external_partner_id
        ? deliveryPartnerNameById.get(Number(row.external_partner_id)) ||
          `Partner #${row.external_partner_id}`
        : undefined,
    };
  });

  return (
    <MasterDashboardClient
currentUser={{
  id: user.id,
  email: user.email ?? '',
  fullName: currentProfile?.full_name?.trim() || user.email || '',
}}


      roles={roles}
      dashboardUsers={dashboardUsers}
      dashboardUserRoles={dashboardUserRoles}
      initialMasterInboxItemStates={initialMasterInboxItemStates}
      advisors={advisorOptions}
      drivers={driverOptions}
      deliveryPartners={deliveryPartnerOptions}
      initialOrders={initialOrders}
      moneyAccounts={moneyAccounts}
      moneyMovements={moneyMovements}
      inventoryItems={inventoryItems}
      inventoryMovements={inventoryMovements}
      inventoryRecipes={inventoryRecipes}
      inventoryRecipeComponents={inventoryRecipeComponents}
      productInventoryLinks={productInventoryLinks}
      clients={clients}
      clientTotalCount={clientTotalCount ?? clients.length}
      clientActiveCount={clientActiveCount ?? clients.filter((client) => client.isActive).length}
      catalogItems={catalogItems}
      productComponents={productComponents}
      activeExchangeRate={
        activeRateRow
          ? {
              id: Number(activeRateRow.id),
              rateBsPerUsd: toNumber(activeRateRow.rate_bs_per_usd, 0),
              effectiveAt: activeRateRow.effective_at,
            }
          : null
      }
    />
  );
}
