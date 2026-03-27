import { redirect } from 'next/navigation';
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
  extra_fields: any;
  queued_needs_reapproval: boolean;
  external_driver_name: string | null;
  external_partner_id: number | null;
  internal_driver_user_id: string | null;
client: { full_name: string | null; phone: string | null }[] | null;
advisor: { full_name: string | null }[] | null;
creator: { full_name: string | null }[] | null;
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
  is_active: boolean;
};

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
};

type RawExchangeRateRow = {
  id: number;
  rate_bs_per_usd: number | string;
  effective_at: string;
  is_active: boolean;
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

function toNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildDeliveryISO(extraFields: any, fallbackISO: string) {
  const schedule = extraFields?.schedule;
  const date = schedule?.date;
  const time24 = schedule?.time_24;

  if (typeof date === 'string' && typeof time24 === 'string') {
    const candidate = new Date(`${date}T${time24}:00`);
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


const { data: deliveryPartnersData, error: deliveryPartnersError } = await supabase
  .from('delivery_partners')
  .select('id, name, partner_type, whatsapp_phone, is_active')
  .eq('is_active', true)
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
}));

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
      notes,
      created_at,
      extra_fields,
      queued_needs_reapproval,
      external_driver_name,
      external_partner_id,
      internal_driver_user_id,
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
          <div className="text-lg font-semibold">Error cargando órdenes</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener las órdenes.
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
      unit_price_usd_snapshot,
      line_total_usd,
      product_name_snapshot,
      sku_snapshot,
      notes
    `)
  .in('order_id', orderIds.length > 0 ? orderIds : [-1]);

  if (orderItemsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando items de órdenes</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudieron obtener los items de las órdenes.
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

  const { data: movementsData } = await supabase
    .from('money_movements')
    .select('order_id, amount_usd_equivalent')
    .in('order_id', orderIds.length > 0 ? orderIds : [-1]);

  const rawOrderItems = (orderItemsData ?? []) as RawOrderItemRow[];

  const { data: moneyAccountsData, error: moneyAccountsError } = await supabase
    .from('money_accounts')
    .select('id, name, currency_code, account_kind, is_active')
    .eq('is_active', true)
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

  const moneyAccounts = ((moneyAccountsData ?? []) as MoneyAccountRow[]).map((a) => ({
    id: Number(a.id),
    name: a.name,
    currencyCode: a.currency_code,
    accountKind: a.account_kind,
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
    const amt = toNumber(mv.amount_usd_equivalent, 0);
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
      is_combo_component_selectable
    `)
    .order('id', { ascending: true });

  if (productsError) {
    return (
      <div className="min-h-screen bg-[#0B0B0D] p-6 text-[#F5F5F7]">
        <div className="mx-auto max-w-xl rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-lg font-semibold">Error cargando catálogo</div>
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
          <div className="text-lg font-semibold">Error cargando composición de productos</div>
          <div className="mt-2 text-sm text-[#B7B7C2]">
            No se pudo obtener la composición de combos/productos.
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
  const initialOrders = rawOrders.map((row) => {
    const confirmedPaidUsd = confirmedPaidByOrder.get(row.id) ?? 0;
    const totalUsd = toNumber(row.total_usd, 0);
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

const creatorName = row.creator?.[0]?.full_name?.trim() || 'Usuario';
const advisorProfileName = row.advisor?.[0]?.full_name?.trim() || null;

const advisorName =
  row.source === 'master'
    ? `Máster (${creatorName})`
    : row.source === 'walk_in'
      ? `Walk-in (${creatorName})`
      : advisorProfileName || creatorName || 'Sin asesor';


const clientName =
  row.client?.[0]?.full_name?.trim() ||
  row.extra_fields?.receiver?.name?.trim() ||
  'Cliente sin nombre';

    const deliveryAtISO = buildDeliveryISO(row.extra_fields, row.created_at);

    const rowItems = itemsByOrder.get(row.id) ?? [];
    const paymentReports = paymentReportsByOrder.get(row.id) ?? [];

const draftItems = rowItems.map((item) => {
  const qty = toNumber(item.qty, 0);
  const unitPriceUsdSnapshot = toNumber(item.unit_price_usd_snapshot, 0);
  const lineTotalUsd = toNumber(item.line_total_usd, unitPriceUsdSnapshot * qty);

  return {
    localId: `existing-${item.id}`,
    productId: Number(item.product_id),
    skuSnapshot: item.sku_snapshot ?? null,
    productNameSnapshot: item.product_name_snapshot?.trim() || 'Producto',
    qty,
    unitPriceUsdSnapshot,
    lineTotalUsd,
    editableDetailLines: item.notes
      ? item.notes
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
      : [],
  };
});

const lines = rowItems.map((item) => {
  const productName = item.product_name_snapshot?.trim() || 'Producto';
  const qty = toNumber(item.qty, 0);
  const unitsPerService = extractUnitsPerServiceFromName(productName);
  const unitPriceUsd = toNumber(item.unit_price_usd_snapshot, 0);

  const isDelivery =
    productName.toLowerCase().startsWith('delivery') ||
    productName.toLowerCase().includes('delivery');

  return {
    name: productName,
    qty,
    unitsPerService,
    priceBs: estimateBsFromUsd(unitPriceUsd, activeRateBsPerUsd),
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
  createdAtISO: row.created_at,
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
      totalBs: estimateBsFromUsd(totalUsd, activeRateBsPerUsd),
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
        receiverName: row.extra_fields?.receiver?.name ?? null,
        receiverPhone: row.extra_fields?.receiver?.phone ?? null,
        paymentMethod: row.extra_fields?.payment?.method ?? null,
        paymentCurrency: row.extra_fields?.payment?.currency ?? null,
        paymentRequiresChange: Boolean(row.extra_fields?.payment?.requires_change ?? false),
        paymentChangeFor:
          row.extra_fields?.payment?.change_for != null
            ? String(row.extra_fields.payment.change_for)
            : null,
        paymentChangeCurrency: row.extra_fields?.payment?.change_currency ?? null,
        paymentNote: row.extra_fields?.payment?.notes ?? null,
        hasDeliveryNote: Boolean(row.extra_fields?.documents?.has_delivery_note ?? false),
        hasInvoice: Boolean(row.extra_fields?.documents?.has_invoice ?? false),
        invoiceDataNote: row.extra_fields?.documents?.invoice_data_note ?? null,
        fxRate:
          row.extra_fields?.pricing?.fx_rate != null
            ? toNumber(row.extra_fields.pricing.fx_rate, 0)
            : null,
        discountEnabled: Boolean(row.extra_fields?.pricing?.discount_enabled ?? false),
        discountPct:
          row.extra_fields?.pricing?.discount_pct != null
            ? toNumber(row.extra_fields.pricing.discount_pct, 0)
            : null,
      },
      draftItems,
      paymentReports,
      riderName:
        (row.internal_driver_user_id
          ? internalDriverNameById.get(row.internal_driver_user_id)
          : null) ||
        row.external_driver_name ||
        undefined,
      externalPartner: row.external_partner_id ? `Partner #${row.external_partner_id}` : undefined,
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
      advisors={advisorOptions}
      drivers={driverOptions}
      deliveryPartners={deliveryPartnerOptions}
      initialOrders={initialOrders}
      moneyAccounts={moneyAccounts}
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