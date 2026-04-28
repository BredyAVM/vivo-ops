'use client';

import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

type ClientType = 'assigned' | 'own' | 'legacy';
type FulfillmentType = 'pickup' | 'delivery';
type PaymentMethod =
  | 'pending'
  | 'payment_mobile'
  | 'transfer'
  | 'cash_usd'
  | 'cash_ves'
  | 'zelle'
  | 'mixed';
type CurrencyCode = 'USD' | 'VES';

type ClientRow = {
  id: number;
  full_name: string;
  phone: string | null;
  client_type: string | null;
  fund_balance_usd?: number | string | null;
  recent_addresses?: unknown;
  billing_company_name?: string | null;
  billing_tax_id?: string | null;
  billing_address?: string | null;
  billing_phone?: string | null;
  delivery_note_name?: string | null;
  delivery_note_document_id?: string | null;
  delivery_note_address?: string | null;
  delivery_note_phone?: string | null;
};

type ProductRow = {
  id: number;
  sku: string | null;
  name: string;
  base_price_usd: number | string | null;
  source_price_currency: CurrencyCode | null;
  source_price_amount: number | string | null;
  is_detail_editable: boolean | null;
  detail_units_limit: number | null;
};

type ProductComponentRow = {
  parent_product_id: number;
  component_product_id: number;
  component_mode: 'fixed' | 'selectable';
  quantity: number | null;
  counts_toward_detail_limit: boolean | null;
  is_required: boolean | null;
  sort_order: number | null;
};

type ConfigSelection = {
  componentProductId: number;
  name: string;
  qty: number;
};

type DraftItem = {
  localId: string;
  product_id: number;
  sku_snapshot: string | null;
  product_name_snapshot: string;
  qty: number;
  source_price_currency: CurrencyCode;
  source_price_amount: number;
  unit_price_usd_snapshot: number;
  line_total_usd: number;
  editable_detail_lines: string[];
};

type ClientAddress = {
  addressText: string;
  gpsUrl: string;
};

type RecentClientChip = {
  id: number;
  full_name: string;
  phone: string | null;
  client_type: string | null;
  fund_balance_usd?: number | string | null;
  recent_addresses?: unknown;
  billing_company_name?: string | null;
  billing_tax_id?: string | null;
  billing_address?: string | null;
  billing_phone?: string | null;
  delivery_note_name?: string | null;
  delivery_note_document_id?: string | null;
  delivery_note_address?: string | null;
  delivery_note_phone?: string | null;
};

type ExistingOrderRow = {
  id: number;
  order_number?: string | null;
  total_usd?: number | string | null;
  status: string | null;
  fulfillment: FulfillmentType;
  delivery_address: string | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  notes: string | null;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      asap?: boolean | null;
    } | null;
    delivery?: {
      gps_url?: string | null;
    } | null;
    payment?: {
      method?: PaymentMethod | null;
      currency?: CurrencyCode | null;
      requires_change?: boolean | null;
      change_for?: string | number | null;
      change_currency?: CurrencyCode | null;
      notes?: string | null;
    } | null;
    pricing?: {
      discount_enabled?: boolean | null;
      discount_pct?: number | string | null;
      fx_rate?: number | string | null;
      invoice_tax_pct?: number | string | null;
      invoice_tax_amount_usd?: number | string | null;
      invoice_tax_amount_bs?: number | string | null;
      total_bs?: number | string | null;
    } | null;
    documents?: {
      has_delivery_note?: boolean | null;
      has_invoice?: boolean | null;
      invoice_data_note?: string | null;
      invoice_snapshot?: {
        company_name?: string | null;
        tax_id?: string | null;
        address?: string | null;
        phone?: string | null;
      } | null;
      delivery_note_snapshot?: {
        name?: string | null;
        document_id?: string | null;
        address?: string | null;
        phone?: string | null;
      } | null;
    } | null;
    note?: string | null;
  } | null;
  client:
    | ClientRow[]
    | ClientRow
    | null;
};

type ExistingOrderItemRow = {
  id: number;
  product_id: number;
  qty: number | string;
  pricing_origin_currency: CurrencyCode | null;
  pricing_origin_amount: number | string | null;
  unit_price_usd_snapshot: number | string | null;
  line_total_usd: number | string | null;
  sku_snapshot: string | null;
  product_name_snapshot: string | null;
  notes: string | null;
};

type OrderEditSnapshot = {
  clientId: number | null;
  fulfillment: FulfillmentType;
  deliveryDate: string;
  deliveryTime12: string;
  isAsap: boolean;
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  orderNote: string;
  paymentMethod: PaymentMethod;
  paymentCurrency: CurrencyCode;
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: CurrencyCode;
  paymentNote: string;
  fxRate: string;
  discountEnabled: boolean;
  discountPct: string;
  hasInvoice: boolean;
  invoiceTaxPct: string;
  hasDeliveryNote: boolean;
  invoiceCompanyName: string;
  invoiceTaxId: string;
  invoiceAddress: string;
  invoicePhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  totalUsd: number;
  totalBs: number;
  items: Array<{
    productId: number;
    productName: string;
    qty: number;
    lineTotalUsd: number;
    detailLines: string[];
  }>;
};

const STORAGE_KEYS = {
  recentClients: 'advisor_recent_clients_v1',
  recentProducts: 'advisor_recent_products_v1',
  favoriteProducts: 'advisor_favorite_products_v1',
  recentAddresses: 'advisor_recent_addresses_v1',
} as const;

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function pad4(n: number) {
  return String(n).padStart(4, '0');
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

function getTodayInputValue() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function getRoundedTime() {
  const date = new Date();
  date.setSeconds(0, 0);
  const mins = date.getMinutes();

  if (mins > 0 && mins < 30) date.setMinutes(30);
  else if (mins > 30) {
    date.setHours(date.getHours() + 1);
    date.setMinutes(0);
  }

  return date;
}

function to12h(date: Date) {
  const hour24 = date.getHours();
  const minute = date.getMinutes();
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12: String(hour12), minute: pad2(minute), ampm };
}

function from12hTo24h(hour12: string, minute: string, ampm: 'AM' | 'PM') {
  let hour = Number(hour12);
  const mins = Number(minute);

  if (!Number.isFinite(hour) || hour < 1 || hour > 12) throw new Error('Hora invalida.');
  if (!Number.isFinite(mins) || mins < 0 || mins > 59) throw new Error('Minutos invalidos.');

  if (ampm === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return `${pad2(hour)}:${pad2(mins)}`;
}

function parseStoredTime12(value: string | null | undefined, fallback: { hour12: string; minute: string; ampm: 'AM' | 'PM' }) {
  const match = String(value || '')
    .trim()
    .match(/^(\d{1,2})[:.](\d{2})\s*(AM|PM)$/i);

  if (!match) return fallback;

  return {
    hour12: String(Number(match[1] || fallback.hour12)),
    minute: pad2(Number(match[2] || fallback.minute)),
    ampm: String(match[3] || fallback.ampm).toUpperCase() === 'PM' ? 'PM' : 'AM',
  } as const;
}

function normalizePhone(value: string) {
  return value.replace(/[^\d+]/g, '');
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

function formatBs(value: number) {
  return `Bs ${value.toFixed(2)}`;
}

function formatBsWhatsApp(value: number) {
  return `Bs ${new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function clientTypeLabel(value: string | null | undefined) {
  if (value === 'assigned') return 'Asignado';
  if (value === 'own') return 'Propio';
  if (value === 'legacy') return 'Antiguo';
  return 'Sin clasificar';
}

function normalizeClientAddresses(input: unknown): ClientAddress[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((row) => {
      const data = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      const addressText = String(data.address_text ?? data.addressText ?? '').trim();
      const gpsUrl = String(data.gps_url ?? data.gpsUrl ?? '').trim();
      return { addressText, gpsUrl };
    })
    .filter((row) => row.addressText || row.gpsUrl)
    .slice(0, 2);
}

function mergeRecentAddresses(currentValue: unknown, nextAddressText: string, nextGpsUrl: string) {
  const current = normalizeClientAddresses(currentValue).map((row) => ({
    address_text: row.addressText,
    gps_url: row.gpsUrl || null,
  }));
  const normalizedAddressText = String(nextAddressText || '').trim();
  const normalizedGpsUrl = String(nextGpsUrl || '').trim() || null;

  if (!normalizedAddressText && !normalizedGpsUrl) {
    return current.slice(0, 2);
  }

  const nextEntry = {
    address_text: normalizedAddressText,
    gps_url: normalizedGpsUrl,
  };

  return [
    nextEntry,
    ...current.filter(
      (row) =>
        !(
          String(row.address_text || '').trim() === normalizedAddressText &&
          String(row.gps_url || '').trim() === String(normalizedGpsUrl || '').trim()
        ),
    ),
  ].slice(0, 2);
}

function readStoredJson<T>(key: string, fallback: T) {
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeSnapshotText(value: string | null | undefined) {
  return String(value || '').trim();
}

function buildDraftItemsSnapshot(items: DraftItem[]) {
  return items.map((item) => ({
    productId: Number(item.product_id || 0),
    productName: normalizeSnapshotText(item.product_name_snapshot),
    qty: Number(item.qty || 0),
    lineTotalUsd: Number(Number(item.line_total_usd || 0).toFixed(2)),
    detailLines: item.editable_detail_lines.map((line) => normalizeSnapshotText(line)).filter(Boolean),
  }));
}

function buildOrderEditChangeSummary(before: OrderEditSnapshot, after: OrderEditSnapshot) {
  const sections = new Set<string>();
  const summary: string[] = [];

  if (JSON.stringify(before.items) !== JSON.stringify(after.items)) {
    sections.add('pedido');
    summary.push('Se modificó el pedido.');
  }

  if (before.clientId !== after.clientId) {
    sections.add('cliente');
    summary.push('Se cambió el cliente.');
  }

  if (
    before.fulfillment !== after.fulfillment ||
    before.deliveryDate !== after.deliveryDate ||
    before.deliveryTime12 !== after.deliveryTime12 ||
    before.isAsap !== after.isAsap ||
    before.receiverName !== after.receiverName ||
    before.receiverPhone !== after.receiverPhone
  ) {
    sections.add('entrega');
    summary.push('Se modificaron datos de entrega.');
  }

  if (before.deliveryAddress !== after.deliveryAddress || before.deliveryGpsUrl !== after.deliveryGpsUrl) {
    sections.add('direccion');
    summary.push('Se modificó la dirección.');
  }

  if (
    before.paymentMethod !== after.paymentMethod ||
    before.paymentCurrency !== after.paymentCurrency ||
    before.paymentRequiresChange !== after.paymentRequiresChange ||
    before.paymentChangeFor !== after.paymentChangeFor ||
    before.paymentChangeCurrency !== after.paymentChangeCurrency ||
    before.paymentNote !== after.paymentNote
  ) {
    sections.add('pago');
    summary.push('Se modificaron datos de pago.');
  }

  if (
    before.fxRate !== after.fxRate ||
    before.discountEnabled !== after.discountEnabled ||
    before.discountPct !== after.discountPct ||
    before.hasInvoice !== after.hasInvoice ||
    before.invoiceTaxPct !== after.invoiceTaxPct ||
    before.totalUsd !== after.totalUsd ||
    before.totalBs !== after.totalBs
  ) {
    sections.add('precio');
    summary.push('Se modificó el total de la orden.');
  }

  if (
    before.hasInvoice !== after.hasInvoice ||
    before.invoiceCompanyName !== after.invoiceCompanyName ||
    before.invoiceTaxId !== after.invoiceTaxId ||
    before.invoiceAddress !== after.invoiceAddress ||
    before.invoicePhone !== after.invoicePhone
  ) {
    sections.add('factura');
    summary.push('Se modificaron datos de factura.');
  }

  if (
    before.hasDeliveryNote !== after.hasDeliveryNote ||
    before.deliveryNoteName !== after.deliveryNoteName ||
    before.deliveryNoteDocumentId !== after.deliveryNoteDocumentId ||
    before.deliveryNoteAddress !== after.deliveryNoteAddress ||
    before.deliveryNotePhone !== after.deliveryNotePhone
  ) {
    sections.add('nota_entrega');
    summary.push('Se modificaron datos de nota de entrega.');
  }

  if (before.orderNote !== after.orderNote) {
    sections.add('nota');
    summary.push('Se modificó la nota de la orden.');
  }

  return {
    sections: Array.from(sections),
    summary: Array.from(new Set(summary)),
  };
}

function inputClass(multiline = false) {
  return [
    'min-w-0 w-full rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 text-sm text-[#F5F7FB] placeholder:text-[#636C80]',
    multiline ? 'min-h-[92px] py-3' : 'h-11',
  ].join(' ');
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12px] font-medium text-[#AAB2C5]">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-[11px] leading-5 text-[#6F7890]">{hint}</div> : null}
    </label>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-4">
      <h2 className="text-base font-semibold text-[#F5F7FB]">{title}</h2>
      {subtitle ? <p className="mt-1 text-xs leading-5 text-[#8B93A7]">{subtitle}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function parseEditableDetailLines(lines: string[]) {
  let alias = '';
  const selections: Array<{ componentName: string; qty: number }> = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    if (/^para\s*:/i.test(line)) {
      alias = line.replace(/^para\s*:/i, '').trim();
      continue;
    }

    const match = line.match(/^(\d+)\s+(.+)$/i);
    if (!match) continue;

    const qty = Number(match[1]);
    const componentName = match[2].trim();

    if (Number.isFinite(qty) && qty > 0 && componentName) {
      selections.push({ componentName, qty });
    }
  }

  return { alias, selections };
}

function ConfigSheet(props: {
  open: boolean;
  title: string;
  alias: string;
  setAlias: (value: string) => void;
  totalSelected: number;
  totalLimit: number;
  options: ProductRow[];
  selections: ConfigSelection[];
  onChangeQty: (product: ProductRow, qty: number) => void;
  onClose: () => void;
  onConfirm: () => void;
  isEditing: boolean;
}) {
  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-[#040507]/84 backdrop-blur-sm">
      <div className="absolute inset-x-0 bottom-0 rounded-t-[28px] border border-[#232632] bg-[#0C1017] px-4 pb-6 pt-4">
        <div className="mx-auto max-w-screen-md space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">
                Configurar producto
              </div>
              <h3 className="mt-1 text-lg font-semibold text-[#F5F7FB]">{props.title}</h3>
              <div className="mt-1 text-xs text-[#8B93A7]">
                Seleccionado {props.totalSelected} de {props.totalLimit || 0} piezas
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3 text-sm text-[#F5F7FB]"
            >
              Cerrar
            </button>
          </div>

          <Field label="Para">
            <input
              value={props.alias}
              onChange={(e) => props.setAlias(e.target.value)}
              className={inputClass()}
              placeholder="Nombre o referencia"
            />
          </Field>

          <div className="space-y-2">
            {props.options.length === 0 ? (
              <div className="rounded-[18px] border border-dashed border-[#2A3040] bg-[#0F131B] px-4 py-4 text-sm text-[#AAB2C5]">
                Este producto no tiene opciones configuradas.
              </div>
            ) : (
              props.options.map((option) => {
                const currentQty =
                  props.selections.find((item) => item.componentProductId === option.id)?.qty || 0;

                return (
                  <div
                    key={option.id}
                    className="grid grid-cols-[1fr_88px] items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">{option.name}</div>
                      <div className="mt-1 text-xs text-[#8B93A7]">{option.sku || 'Sin codigo'}</div>
                    </div>
                    <input
                      value={String(currentQty)}
                      onChange={(e) => props.onChangeQty(option, Number(e.target.value || 0))}
                      className={inputClass()}
                      inputMode="numeric"
                    />
                  </div>
                );
              })
            )}
          </div>

          <button
            type="button"
            onClick={props.onConfirm}
            className="h-11 w-full rounded-[16px] bg-[#F0D000] text-sm font-semibold text-[#17191E]"
          >
            {props.isEditing ? 'Guardar composicion' : 'Confirmar composicion'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdvisorOrderComposer({
  existingOrderId = null,
  templateOrderId = null,
}: {
  existingOrderId?: number | null;
  templateOrderId?: number | null;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const rounded = useMemo(() => to12h(getRoundedTime()), []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchingClient, setSearchingClient] = useState(false);
  const [creatingClient, setCreatingClient] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [authUserId, setAuthUserId] = useState('');
  const [authUserLabel, setAuthUserLabel] = useState('Asesor');
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [productComponents, setProductComponents] = useState<ProductComponentRow[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [productActiveIndex, setProductActiveIndex] = useState<number>(-1);
  const [selectedProductId, setSelectedProductId] = useState<number | ''>('');
  const [recentProductIds, setRecentProductIds] = useState<number[]>([]);
  const [favoriteProductIds, setFavoriteProductIds] = useState<number[]>([]);
  const [qty, setQty] = useState('1');
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);

  const [searchTerm, setSearchTerm] = useState('');
  const [clientResults, setClientResults] = useState<ClientRow[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientRow | null>(null);
  const [recentClients, setRecentClients] = useState<RecentClientChip[]>([]);
  const [isNewClientMode, setIsNewClientMode] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [newClientType, setNewClientType] = useState<ClientType>('assigned');

  const [fulfillment, setFulfillment] = useState<FulfillmentType>('pickup');
  const [deliveryDate, setDeliveryDate] = useState(getTodayInputValue());
  const [deliveryHour12, setDeliveryHour12] = useState(rounded.hour12);
  const [deliveryMinute, setDeliveryMinute] = useState(rounded.minute);
  const [deliveryAmPm, setDeliveryAmPm] = useState<'AM' | 'PM'>(rounded.ampm);
  const [isAsap, setIsAsap] = useState(false);
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryGpsUrl, setDeliveryGpsUrl] = useState('');
  const [recentAddresses, setRecentAddresses] = useState<ClientAddress[]>([]);
  const [orderNote, setOrderNote] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pending');
  const [paymentCurrency, setPaymentCurrency] = useState<CurrencyCode>('USD');
  const [paymentRequiresChange, setPaymentRequiresChange] = useState(false);
  const [paymentChangeFor, setPaymentChangeFor] = useState('');
  const [paymentChangeCurrency, setPaymentChangeCurrency] = useState<CurrencyCode>('USD');
  const [paymentNote, setPaymentNote] = useState('');
  const [fxRate, setFxRate] = useState('');
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountPct, setDiscountPct] = useState('0');
  const [invoiceTaxPct, setInvoiceTaxPct] = useState('16');
  const [hasDeliveryNote, setHasDeliveryNote] = useState(false);
  const [hasInvoice, setHasInvoice] = useState(false);
  const [invoiceCompanyName, setInvoiceCompanyName] = useState('');
  const [invoiceTaxId, setInvoiceTaxId] = useState('');
  const [invoiceAddress, setInvoiceAddress] = useState('');
  const [invoicePhone, setInvoicePhone] = useState('');
  const [deliveryNoteName, setDeliveryNoteName] = useState('');
  const [deliveryNoteDocumentId, setDeliveryNoteDocumentId] = useState('');
  const [deliveryNoteAddress, setDeliveryNoteAddress] = useState('');
  const [deliveryNotePhone, setDeliveryNotePhone] = useState('');
  const [copyingQuote, setCopyingQuote] = useState(false);
  const [originalEditSnapshot, setOriginalEditSnapshot] = useState<OrderEditSnapshot | null>(null);
  const [existingOrderNumber, setExistingOrderNumber] = useState('');
  const [existingOrderStatus, setExistingOrderStatus] = useState('');

  const [configOpen, setConfigOpen] = useState(false);
  const [configEditingLocalId, setConfigEditingLocalId] = useState<string | null>(null);
  const [configProductId, setConfigProductId] = useState<number | null>(null);
  const [configQty, setConfigQty] = useState(1);
  const [configAlias, setConfigAlias] = useState('');
  const [configSelections, setConfigSelections] = useState<ConfigSelection[]>([]);
  const isEditingOrder = Number.isFinite(existingOrderId) && Number(existingOrderId) > 0;
  const sourceOrderId =
    Number.isFinite(existingOrderId) && Number(existingOrderId) > 0
      ? Number(existingOrderId)
      : Number.isFinite(templateOrderId) && Number(templateOrderId) > 0
        ? Number(templateOrderId)
        : null;
  const isRepeatingOrder = !isEditingOrder && sourceOrderId != null;

  const selectedProduct = useMemo(() => {
    if (selectedProductId === '') return null;
    return products.find((product) => product.id === selectedProductId) ?? null;
  }, [products, selectedProductId]);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const favoriteProducts = useMemo(
    () =>
      favoriteProductIds
        .map((id) => productById.get(id))
        .filter((product): product is ProductRow => !!product),
    [favoriteProductIds, productById]
  );
  const recentProducts = useMemo(
    () =>
      recentProductIds
        .map((id) => productById.get(id))
        .filter((product): product is ProductRow => !!product && !favoriteProductIds.includes(product.id)),
    [favoriteProductIds, productById, recentProductIds]
  );
  const draftTotalUsd = useMemo(
    () => draftItems.reduce((sum, item) => sum + Number(item.line_total_usd || 0), 0),
    [draftItems]
  );
  const selectedClientFundUsd = Number(selectedClient?.fund_balance_usd ?? 0) || 0;
  const selectedClientAddresses = useMemo(
    () => normalizeClientAddresses(selectedClient?.recent_addresses),
    [selectedClient]
  );
  const quickAddresses = useMemo(() => {
    const seen = new Set<string>();
    return [...selectedClientAddresses, ...recentAddresses].filter((address) => {
      const key = `${address.addressText.trim()}|${address.gpsUrl.trim()}`;
      if (!address.addressText.trim() && !address.gpsUrl.trim()) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [recentAddresses, selectedClientAddresses]);
  const fxRateNumber = Math.max(0, Number(String(fxRate || '0').replace(',', '.')) || 0);
  const discountPctNumber = Math.max(0, Math.min(100, Number(discountPct || 0) || 0));
  const invoiceTaxPctNumber = hasInvoice
    ? Math.max(0, Number(String(invoiceTaxPct || '0').replace(',', '.')) || 0)
    : 0;
  const draftSubtotalBs = useMemo(
    () =>
      draftItems.reduce((sum, item) => {
        const lineBs =
          item.source_price_currency === 'VES'
            ? Number(item.source_price_amount || 0) * Number(item.qty || 0)
            : Number(item.line_total_usd || 0) * fxRateNumber;
        return sum + lineBs;
      }, 0),
    [draftItems, fxRateNumber]
  );
  const discountAmountBs = discountEnabled ? draftSubtotalBs * (discountPctNumber / 100) : 0;
  const subtotalAfterDiscountBs = Math.max(0, draftSubtotalBs - discountAmountBs);
  const invoiceTaxAmountBs = hasInvoice ? subtotalAfterDiscountBs * (invoiceTaxPctNumber / 100) : 0;
  const finalTotalBs = subtotalAfterDiscountBs + invoiceTaxAmountBs;
  const discountAmountUsd = fxRateNumber > 0 ? Number((discountAmountBs / fxRateNumber).toFixed(2)) : 0;
  const invoiceTaxAmountUsd = fxRateNumber > 0 ? Number((invoiceTaxAmountBs / fxRateNumber).toFixed(2)) : 0;
  const finalTotalUsd =
    fxRateNumber > 0
      ? Number((finalTotalBs / fxRateNumber).toFixed(2))
      : Number(Math.max(0, draftTotalUsd - discountAmountUsd).toFixed(2));

  const configProduct = useMemo(
    () => (configProductId ? productById.get(configProductId) ?? null : null),
    [configProductId, productById]
  );

  const configOptions = useMemo(() => {
    if (!configProductId) return [];
    return productComponents
      .filter((row) => row.parent_product_id === configProductId && row.component_mode === 'selectable')
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
      .map((row) => productById.get(row.component_product_id))
      .filter((row): row is ProductRow => !!row);
  }, [configProductId, productById, productComponents]);

  const configBaseLimit = Number(configProduct?.detail_units_limit || 0);
  const configTotalLimit = configBaseLimit > 0 ? configBaseLimit * Math.max(1, configQty) : 0;
  const configSelectedUnits = configSelections.reduce((sum, item) => sum + Number(item.qty || 0), 0);

  const createReady =
    draftItems.length > 0 &&
    (!!selectedClient || (isNewClientMode && newClientName.trim() && newClientPhone.trim())) &&
    (fulfillment === 'pickup' || deliveryAddress.trim().length > 0) &&
    fxRateNumber > 0;
  const filteredProducts = useMemo(() => {
    const query = productSearch.trim().toLowerCase();
    if (!query) return [];
    return products.filter((product) => {
      return (
        product.name.toLowerCase().includes(query) ||
        String(product.sku || '').toLowerCase().includes(query)
      );
    });
  }, [productSearch, products]);

  useEffect(() => {
    setRecentClients(readStoredJson<RecentClientChip[]>(STORAGE_KEYS.recentClients, []));
    setRecentProductIds(readStoredJson<number[]>(STORAGE_KEYS.recentProducts, []));
    setFavoriteProductIds(readStoredJson<number[]>(STORAGE_KEYS.favoriteProducts, []));
    setRecentAddresses(readStoredJson<ClientAddress[]>(STORAGE_KEYS.recentAddresses, []));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.recentClients, JSON.stringify(recentClients.slice(0, 6)));
  }, [recentClients]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.recentProducts, JSON.stringify(recentProductIds.slice(0, 8)));
  }, [recentProductIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.favoriteProducts, JSON.stringify(favoriteProductIds.slice(0, 8)));
  }, [favoriteProductIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.recentAddresses, JSON.stringify(recentAddresses.slice(0, 6)));
  }, [recentAddresses]);

  useEffect(() => {
    async function boot() {
      setLoading(true);
      setError(null);

      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError) {
        setError(authError.message);
        setLoading(false);
        return;
      }

      const user = authData.user;
      if (!user) {
        router.push('/login');
        return;
      }

      setAuthUserId(user.id);
      setAuthUserLabel(
        String(
          user.user_metadata?.full_name ||
            user.user_metadata?.name ||
            user.email?.split('@')[0] ||
            'Asesor'
        ).trim() || 'Asesor'
      );

      const baseRequests = [
        supabase
          .from('products')
          .select(
            'id, sku, name, base_price_usd, source_price_currency, source_price_amount, is_detail_editable, detail_units_limit'
          )
          .eq('is_active', true)
          .order('name', { ascending: true }),
        supabase
          .from('product_components')
          .select(
            'parent_product_id, component_product_id, component_mode, quantity, counts_toward_detail_limit, is_required, sort_order'
          )
          .order('parent_product_id', { ascending: true })
          .order('sort_order', { ascending: true }),
        supabase
          .from('exchange_rates')
          .select('rate_bs_per_usd')
          .eq('is_active', true)
          .order('effective_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ] as const;

      const editRequests = sourceOrderId
        ? ([
            supabase
              .from('orders')
              .select(
                'id, order_number, total_usd, status, fulfillment, delivery_address, receiver_name, receiver_phone, notes, extra_fields, client:clients!orders_client_id_fkey(id, full_name, phone, client_type, fund_balance_usd, recent_addresses, billing_company_name, billing_tax_id, billing_address, billing_phone, delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone)'
              )
              .eq('id', Number(sourceOrderId))
              .eq('attributed_advisor_id', user.id)
              .maybeSingle(),
            supabase
              .from('order_items')
              .select(
                'id, product_id, qty, pricing_origin_currency, pricing_origin_amount, unit_price_usd_snapshot, line_total_usd, sku_snapshot, product_name_snapshot, notes'
              )
              .eq('order_id', Number(sourceOrderId))
              .order('id', { ascending: true }),
          ] as const)
        : null;

      const results = editRequests
        ? await Promise.all([...baseRequests, ...editRequests])
        : await Promise.all(baseRequests);

      const [productResult, componentResult, exchangeRateResult, existingOrderResult, existingItemsResult] = results as [
        Awaited<(typeof baseRequests)[0]>,
        Awaited<(typeof baseRequests)[1]>,
        Awaited<(typeof baseRequests)[2]>,
        | Awaited<NonNullable<typeof editRequests>[0]>
        | undefined,
        | Awaited<NonNullable<typeof editRequests>[1]>
        | undefined,
      ];

      const { data: productData, error: productError } = productResult;
      const { data: componentData, error: componentError } = componentResult;
      const activeRate = toSafeNumber(exchangeRateResult.data?.rate_bs_per_usd, 0);

      if (productError) setError(productError.message);
      else setProducts((productData ?? []) as ProductRow[]);

      if (componentError) setError(componentError.message);
      else setProductComponents((componentData ?? []) as ProductComponentRow[]);

      if (!isEditingOrder && activeRate > 0) {
        setFxRate(String(Number(activeRate.toFixed(2))));
      }

      if (!isEditingOrder) {
        setOriginalEditSnapshot(null);
        setExistingOrderNumber('');
        setExistingOrderStatus('');
      }

      if (sourceOrderId) {
        if (existingOrderResult?.error) {
          setError(existingOrderResult.error.message);
        } else if (!existingOrderResult?.data) {
          setError(isEditingOrder ? 'No se pudo cargar la orden para corregir.' : 'No se pudo cargar la orden base.');
        } else {
          const order = existingOrderResult.data as ExistingOrderRow;
          const orderClient = Array.isArray(order.client) ? order.client[0] ?? null : order.client;
          const orderItems = ((existingItemsResult?.data ?? []) as ExistingOrderItemRow[]).map((item) => ({
            localId: `existing-${item.id}`,
            product_id: Number(item.product_id),
            sku_snapshot: item.sku_snapshot,
            product_name_snapshot: String(item.product_name_snapshot || 'Item'),
            qty: Number(item.qty || 0),
            source_price_currency: (item.pricing_origin_currency || 'USD') as CurrencyCode,
            source_price_amount: Number(item.pricing_origin_amount ?? item.unit_price_usd_snapshot ?? 0) || 0,
            unit_price_usd_snapshot: Number(item.unit_price_usd_snapshot ?? 0) || 0,
            line_total_usd: Number(item.line_total_usd ?? 0) || 0,
            editable_detail_lines: item.notes?.trim() ? item.notes.split('\n').map((line) => line.trim()).filter(Boolean) : [],
          }));
          const schedule = order.extra_fields?.schedule;
          const paymentData = order.extra_fields?.payment;
          const pricing = order.extra_fields?.pricing;
          const documents = order.extra_fields?.documents;
          const parsedTime = parseStoredTime12(schedule?.time_12, rounded);

          setSelectedClient(orderClient ? (orderClient as ClientRow) : null);
          if (orderClient) rememberClient(orderClient as ClientRow);
          setSearchTerm(orderClient?.phone || orderClient?.full_name || '');
          setClientResults([]);
          setIsNewClientMode(false);
          setDraftItems(orderItems);
          setFulfillment(order.fulfillment || 'pickup');
          setDeliveryDate(schedule?.date || getTodayInputValue());
          setDeliveryHour12(parsedTime.hour12);
          setDeliveryMinute(parsedTime.minute);
          setDeliveryAmPm(parsedTime.ampm);
          setIsAsap(Boolean(schedule?.asap));
          setReceiverName(order.receiver_name || '');
          setReceiverPhone(order.receiver_phone || '');
          setDeliveryAddress(order.delivery_address || '');
          setDeliveryGpsUrl(order.extra_fields?.delivery?.gps_url || '');
          rememberAddress(order.delivery_address || '', order.extra_fields?.delivery?.gps_url || '');
          setOrderNote(order.notes || order.extra_fields?.note || '');
          setPaymentMethod((paymentData?.method as PaymentMethod) || 'pending');
          setPaymentCurrency((paymentData?.currency as CurrencyCode) || 'USD');
          setPaymentRequiresChange(Boolean(paymentData?.requires_change));
          setPaymentChangeFor(
            paymentData?.change_for == null ? '' : String(paymentData.change_for)
          );
          setPaymentChangeCurrency((paymentData?.change_currency as CurrencyCode) || 'USD');
          setPaymentNote(paymentData?.notes || '');
          setFxRate(pricing?.fx_rate == null ? (activeRate > 0 ? String(Number(activeRate.toFixed(2))) : '') : String(pricing.fx_rate));
          setDiscountEnabled(Boolean(pricing?.discount_enabled));
          setDiscountPct(
            pricing?.discount_pct == null ? '0' : String(pricing.discount_pct)
          );
          setInvoiceTaxPct(
            pricing?.invoice_tax_pct == null ? '16' : String(pricing.invoice_tax_pct)
          );
          setHasDeliveryNote(Boolean(documents?.has_delivery_note));
          setHasInvoice(Boolean(documents?.has_invoice));
          setInvoiceCompanyName(
            documents?.invoice_snapshot?.company_name ||
              orderClient?.billing_company_name ||
              ''
          );
          setInvoiceTaxId(
            documents?.invoice_snapshot?.tax_id || orderClient?.billing_tax_id || ''
          );
          setInvoiceAddress(
            documents?.invoice_snapshot?.address || orderClient?.billing_address || ''
          );
          setInvoicePhone(
            documents?.invoice_snapshot?.phone || orderClient?.billing_phone || ''
          );
          setDeliveryNoteName(
            documents?.delivery_note_snapshot?.name || orderClient?.delivery_note_name || ''
          );
          setDeliveryNoteDocumentId(
            documents?.delivery_note_snapshot?.document_id ||
              orderClient?.delivery_note_document_id ||
              ''
          );
          setDeliveryNoteAddress(
            documents?.delivery_note_snapshot?.address ||
              orderClient?.delivery_note_address ||
              ''
          );
          setDeliveryNotePhone(
            documents?.delivery_note_snapshot?.phone || orderClient?.delivery_note_phone || ''
          );
          setExistingOrderNumber(String(order.order_number || ''));
          setExistingOrderStatus(String(order.status || ''));

          if (isEditingOrder) {
            setOriginalEditSnapshot({
              clientId: orderClient?.id ? Number(orderClient.id) : null,
              fulfillment: (order.fulfillment || 'pickup') as FulfillmentType,
              deliveryDate: normalizeSnapshotText(schedule?.date || getTodayInputValue()),
              deliveryTime12: normalizeSnapshotText(`${parsedTime.hour12}:${parsedTime.minute} ${parsedTime.ampm}`),
              isAsap: Boolean(schedule?.asap),
              receiverName: normalizeSnapshotText(order.receiver_name),
              receiverPhone: normalizeSnapshotText(order.receiver_phone),
              deliveryAddress: normalizeSnapshotText(order.delivery_address),
              deliveryGpsUrl: normalizeSnapshotText(order.extra_fields?.delivery?.gps_url),
              orderNote: normalizeSnapshotText(order.notes || order.extra_fields?.note),
              paymentMethod: ((paymentData?.method as PaymentMethod) || 'pending'),
              paymentCurrency: ((paymentData?.currency as CurrencyCode) || 'USD'),
              paymentRequiresChange: Boolean(paymentData?.requires_change),
              paymentChangeFor: normalizeSnapshotText(
                paymentData?.change_for == null ? '' : String(paymentData.change_for)
              ),
              paymentChangeCurrency: ((paymentData?.change_currency as CurrencyCode) || 'USD'),
              paymentNote: normalizeSnapshotText(paymentData?.notes),
              fxRate: normalizeSnapshotText(
                pricing?.fx_rate == null
                  ? activeRate > 0
                    ? String(Number(activeRate.toFixed(2)))
                    : ''
                  : String(pricing.fx_rate)
              ),
              discountEnabled: Boolean(pricing?.discount_enabled),
              discountPct: normalizeSnapshotText(
                pricing?.discount_pct == null ? '0' : String(pricing.discount_pct)
              ),
              hasInvoice: Boolean(documents?.has_invoice),
              invoiceTaxPct: normalizeSnapshotText(
                pricing?.invoice_tax_pct == null ? '16' : String(pricing.invoice_tax_pct)
              ),
              hasDeliveryNote: Boolean(documents?.has_delivery_note),
              invoiceCompanyName: normalizeSnapshotText(
                documents?.invoice_snapshot?.company_name || orderClient?.billing_company_name
              ),
              invoiceTaxId: normalizeSnapshotText(
                documents?.invoice_snapshot?.tax_id || orderClient?.billing_tax_id
              ),
              invoiceAddress: normalizeSnapshotText(
                documents?.invoice_snapshot?.address || orderClient?.billing_address
              ),
              invoicePhone: normalizeSnapshotText(
                documents?.invoice_snapshot?.phone || orderClient?.billing_phone
              ),
              deliveryNoteName: normalizeSnapshotText(
                documents?.delivery_note_snapshot?.name || orderClient?.delivery_note_name
              ),
              deliveryNoteDocumentId: normalizeSnapshotText(
                documents?.delivery_note_snapshot?.document_id ||
                  orderClient?.delivery_note_document_id
              ),
              deliveryNoteAddress: normalizeSnapshotText(
                documents?.delivery_note_snapshot?.address || orderClient?.delivery_note_address
              ),
              deliveryNotePhone: normalizeSnapshotText(
                documents?.delivery_note_snapshot?.phone || orderClient?.delivery_note_phone
              ),
              totalUsd: Number(Number(order.total_usd || 0).toFixed(2)),
              totalBs: Number(
                toSafeNumber(pricing?.total_bs, activeRate > 0 ? Number(order.total_usd || 0) * activeRate : 0).toFixed(2)
              ),
              items: orderItems.map((item) => ({
                productId: Number(item.product_id || 0),
                productName: normalizeSnapshotText(item.product_name_snapshot),
                qty: Number(item.qty || 0),
                lineTotalUsd: Number(Number(item.line_total_usd || 0).toFixed(2)),
                detailLines: item.editable_detail_lines
                  .map((line) => normalizeSnapshotText(line))
                  .filter(Boolean),
              })),
            });
            setInfo('Pedido listo para corregir.');
          } else {
            setOriginalEditSnapshot(null);
            setExistingOrderNumber('');
            setExistingOrderStatus('');
            setInfo('Pedido base listo para repetir.');
          }
        }
      }

      setLoading(false);
    }

    void boot();
  }, [isEditingOrder, rounded, router, sourceOrderId, supabase]);

  useEffect(() => {
    if (paymentMethod === 'cash_ves' || paymentMethod === 'transfer' || paymentMethod === 'payment_mobile') {
      setPaymentCurrency('VES');
    } else if (paymentMethod === 'cash_usd' || paymentMethod === 'zelle' || paymentMethod === 'pending') {
      setPaymentCurrency('USD');
    }
  }, [paymentMethod]);

  useEffect(() => {
    if (
      fulfillment === 'delivery' &&
      !deliveryAddress.trim() &&
      selectedClientAddresses.length > 0
    ) {
      setDeliveryAddress(selectedClientAddresses[0].addressText);
      setDeliveryGpsUrl(selectedClientAddresses[0].gpsUrl);
    }
  }, [deliveryAddress, deliveryGpsUrl, fulfillment, selectedClientAddresses]);

  function clearMessages() {
    setError(null);
    setInfo(null);
  }

  function rememberClient(client: ClientRow | RecentClientChip) {
    const nextClient = {
      id: Number(client.id),
      full_name: String(client.full_name || 'Cliente'),
      phone: client.phone || null,
      client_type: client.client_type || null,
      fund_balance_usd: client.fund_balance_usd ?? null,
      recent_addresses: client.recent_addresses,
      billing_company_name: client.billing_company_name ?? null,
      billing_tax_id: client.billing_tax_id ?? null,
      billing_address: client.billing_address ?? null,
      billing_phone: client.billing_phone ?? null,
      delivery_note_name: client.delivery_note_name ?? null,
      delivery_note_document_id: client.delivery_note_document_id ?? null,
      delivery_note_address: client.delivery_note_address ?? null,
      delivery_note_phone: client.delivery_note_phone ?? null,
    } satisfies RecentClientChip;

    setRecentClients((current) => [
      nextClient,
      ...current.filter((row) => row.id !== nextClient.id),
    ].slice(0, 6));
  }

  function rememberProduct(productId: number) {
    setRecentProductIds((current) => [productId, ...current.filter((id) => id !== productId)].slice(0, 8));
  }

  function rememberAddress(addressText: string, gpsUrl: string) {
    const normalized = {
      addressText: String(addressText || '').trim(),
      gpsUrl: String(gpsUrl || '').trim(),
    };
    if (!normalized.addressText && !normalized.gpsUrl) return;

    setRecentAddresses((current) => [
      normalized,
      ...current.filter(
        (row) =>
          row.addressText.trim() !== normalized.addressText || row.gpsUrl.trim() !== normalized.gpsUrl
      ),
    ].slice(0, 6));
  }

  function toggleFavoriteProduct(productId: number) {
    setFavoriteProductIds((current) =>
      current.includes(productId) ? current.filter((id) => id !== productId) : [productId, ...current].slice(0, 8)
    );
  }

  function buildCurrentEditSnapshot(clientId: number | null): OrderEditSnapshot {
    return {
      clientId,
      fulfillment,
      deliveryDate: normalizeSnapshotText(deliveryDate),
      deliveryTime12: normalizeSnapshotText(`${deliveryHour12}:${deliveryMinute} ${deliveryAmPm}`),
      isAsap,
      receiverName: normalizeSnapshotText(receiverName),
      receiverPhone: normalizeSnapshotText(receiverPhone),
      deliveryAddress: normalizeSnapshotText(deliveryAddress),
      deliveryGpsUrl: normalizeSnapshotText(deliveryGpsUrl),
      orderNote: normalizeSnapshotText(orderNote),
      paymentMethod,
      paymentCurrency,
      paymentRequiresChange,
      paymentChangeFor: normalizeSnapshotText(paymentChangeFor),
      paymentChangeCurrency,
      paymentNote: normalizeSnapshotText(paymentNote),
      fxRate: normalizeSnapshotText(fxRate),
      discountEnabled,
      discountPct: normalizeSnapshotText(discountPct),
      hasInvoice,
      invoiceTaxPct: normalizeSnapshotText(invoiceTaxPct),
      hasDeliveryNote,
      invoiceCompanyName: normalizeSnapshotText(invoiceCompanyName),
      invoiceTaxId: normalizeSnapshotText(invoiceTaxId),
      invoiceAddress: normalizeSnapshotText(invoiceAddress),
      invoicePhone: normalizeSnapshotText(invoicePhone),
      deliveryNoteName: normalizeSnapshotText(deliveryNoteName),
      deliveryNoteDocumentId: normalizeSnapshotText(deliveryNoteDocumentId),
      deliveryNoteAddress: normalizeSnapshotText(deliveryNoteAddress),
      deliveryNotePhone: normalizeSnapshotText(deliveryNotePhone),
      totalUsd: Number(finalTotalUsd.toFixed(2)),
      totalBs: Number(finalTotalBs.toFixed(2)),
      items: buildDraftItemsSnapshot(draftItems),
    };
  }

  function applyClientProfile(client: ClientRow) {
    setInvoiceCompanyName(client.billing_company_name || '');
    setInvoiceTaxId(client.billing_tax_id || '');
    setInvoiceAddress(client.billing_address || '');
    setInvoicePhone(client.billing_phone || '');
    setDeliveryNoteName(client.delivery_note_name || '');
    setDeliveryNoteDocumentId(client.delivery_note_document_id || '');
    setDeliveryNoteAddress(client.delivery_note_address || '');
    setDeliveryNotePhone(client.delivery_note_phone || '');
  }

  async function handleSearchClients(e?: FormEvent) {
    e?.preventDefault();
    clearMessages();

    const query = searchTerm.trim();
    if (!query) {
      setClientResults([]);
      return;
    }

    setSearchingClient(true);

    const { data, error: searchError } = await supabase
      .from('clients')
      .select('id, full_name, phone, client_type, fund_balance_usd, recent_addresses, billing_company_name, billing_tax_id, billing_address, billing_phone, delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone')
      .or(`phone.ilike.%${query}%,full_name.ilike.%${query}%`)
      .order('id', { ascending: false })
      .limit(12);

    setSearchingClient(false);

    if (searchError) {
      setError(searchError.message);
      return;
    }

    setClientResults((data ?? []) as ClientRow[]);
    setInfo((data ?? []).length > 0 ? 'Cliente encontrado.' : 'No hubo coincidencias.');
  }

  async function createClientNow() {
    clearMessages();
    const full_name = newClientName.trim();
    const phone = normalizePhone(newClientPhone.trim());

    if (!full_name) throw new Error('Falta el nombre del cliente.');
    if (!phone) throw new Error('Falta el telefono del cliente.');

    setCreatingClient(true);

    try {
      const { data: existing, error: existingError } = await supabase
        .from('clients')
        .select('id, full_name, phone, client_type, fund_balance_usd, recent_addresses, billing_company_name, billing_tax_id, billing_address, billing_phone, delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone')
        .eq('phone', phone)
        .limit(1);

      if (existingError) throw new Error(existingError.message);

      if (existing && existing.length > 0) {
        const current = existing[0] as ClientRow;
        setSelectedClient(current);
        rememberClient(current);
        applyClientProfile(current);
        setSearchTerm(current.phone ?? current.full_name);
        setIsNewClientMode(false);
        setClientResults([]);
        setInfo(`Cliente listo: ${current.full_name}`);
        return current.id;
      }

      const { data: created, error: createError } = await supabase
        .from('clients')
        .insert({ full_name, phone, client_type: newClientType })
        .select('id, full_name, phone, client_type, fund_balance_usd, recent_addresses, billing_company_name, billing_tax_id, billing_address, billing_phone, delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone')
        .single();

      if (createError) throw new Error(createError.message);

      const client = created as ClientRow;
      setSelectedClient(client);
      rememberClient(client);
      applyClientProfile(client);
      setSearchTerm(client.phone ?? client.full_name);
      setIsNewClientMode(false);
      setClientResults([]);
      setInfo(`Cliente creado: ${client.full_name}`);
      return client.id;
    } finally {
      setCreatingClient(false);
    }
  }

  function resetConfig() {
    setConfigOpen(false);
    setConfigEditingLocalId(null);
    setConfigProductId(null);
    setConfigQty(1);
    setConfigAlias('');
    setConfigSelections([]);
  }

  function applyClientAddress(address: ClientAddress) {
    setDeliveryAddress(address.addressText);
    setDeliveryGpsUrl(address.gpsUrl);
    rememberAddress(address.addressText, address.gpsUrl);
  }

  function chooseProduct(product: ProductRow) {
    setSelectedProductId(product.id);
    setProductSearch(product.name);
    setProductActiveIndex(filteredProducts.findIndex((row) => row.id === product.id));
  }

  function buildDraftItem(product: ProductRow, quantity: number, lines: string[]) {
    const unitPriceUsd = Number(product.base_price_usd ?? 0);
    const lineTotal = Number((unitPriceUsd * quantity).toFixed(2));

    return {
      localId: `${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      product_id: product.id,
      sku_snapshot: product.sku,
      product_name_snapshot: product.name,
      qty: quantity,
      source_price_currency: (product.source_price_currency || 'USD') as CurrencyCode,
      source_price_amount: Number(product.source_price_amount ?? product.base_price_usd ?? 0) || 0,
      unit_price_usd_snapshot: unitPriceUsd,
      line_total_usd: lineTotal,
      editable_detail_lines: lines,
    } satisfies DraftItem;
  }

  function openConfigForProduct(product: ProductRow, quantity: number) {
    setConfigEditingLocalId(null);
    setConfigProductId(product.id);
    setConfigQty(quantity);
    setConfigAlias('');
    setConfigSelections([]);
    setConfigOpen(true);
  }

  function openEditConfig(item: DraftItem) {
    const parsed = parseEditableDetailLines(item.editable_detail_lines);
    const product = productById.get(item.product_id);
    if (!product) {
      setError('No se pudo cargar la configuracion del item.');
      return;
    }

    const nextOptions = productComponents
      .filter((row) => row.parent_product_id === product.id && row.component_mode === 'selectable')
      .map((row) => productById.get(row.component_product_id))
      .filter((row): row is ProductRow => !!row);

    setConfigEditingLocalId(item.localId);
    setConfigProductId(item.product_id);
    setConfigQty(item.qty);
    setConfigAlias(parsed.alias);
    setConfigSelections(
      parsed.selections
        .map((selection) => {
          const option =
            nextOptions.find((row) => row.name === selection.componentName) ??
            products.find((row) => row.name === selection.componentName);
          if (!option) return null;
          return {
            componentProductId: option.id,
            name: option.name,
            qty: selection.qty,
          };
        })
        .filter((row): row is ConfigSelection => !!row)
    );
    setConfigOpen(true);
  }

  function addDraftItem() {
    clearMessages();
    if (!selectedProduct) {
      setError('Selecciona un producto.');
      return;
    }

    const quantity = Number(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('La cantidad debe ser mayor que cero.');
      return;
    }

    const hasSelectableComponents = productComponents.some(
      (row) => row.parent_product_id === selectedProduct.id && row.component_mode === 'selectable'
    );

    if (selectedProduct.is_detail_editable || hasSelectableComponents) {
      openConfigForProduct(selectedProduct, quantity);
      return;
    }

    rememberProduct(selectedProduct.id);
    setDraftItems((current) => [...current, buildDraftItem(selectedProduct, quantity, [])]);
    setQty('1');
    setSelectedProductId('');
    setProductSearch('');
    setProductActiveIndex(-1);
  }

  function removeDraftItem(localId: string) {
    setDraftItems((current) => current.filter((item) => item.localId !== localId));
  }

  function setConfigSelectionQty(product: ProductRow, quantity: number) {
    const nextQty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0;

    setConfigSelections((current) => {
      const rest = current.filter((item) => item.componentProductId !== product.id);
      if (nextQty <= 0) return rest;
      return [...rest, { componentProductId: product.id, name: product.name, qty: nextQty }];
    });
  }

  function confirmConfig() {
    if (!configProduct) {
      setError('No se encontro el producto a configurar.');
      return;
    }

    if (configTotalLimit > 0 && configSelectedUnits !== configTotalLimit) {
      setError(`Debes completar ${configTotalLimit} piezas para este producto.`);
      return;
    }

    if (configOptions.length > 0 && configSelections.length === 0) {
      setError('Selecciona la composicion interna del producto.');
      return;
    }

    const detailLines = [
      configAlias.trim() ? `Para: ${configAlias.trim()}` : null,
      ...configSelections
        .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .map((item) => `${item.qty} ${item.name}`),
    ].filter((line): line is string => !!line);

    const item = buildDraftItem(configProduct, configQty, detailLines);

    if (configEditingLocalId) {
      setDraftItems((current) =>
        current.map((draft) =>
          draft.localId === configEditingLocalId ? { ...item, localId: draft.localId } : draft
        )
      );
    } else {
      rememberProduct(configProduct.id);
      setDraftItems((current) => [...current, item]);
    }

    setQty('1');
    setSelectedProductId('');
    setProductSearch('');
    setProductActiveIndex(-1);
    resetConfig();
  }

  function buildQuoteSummary() {
    const parts: string[] = [];
    const clientName = selectedClient?.full_name || newClientName.trim() || 'Cliente';
    const clientPhone = selectedClient?.phone || newClientPhone.trim();
    const deliveryDayLabel = new Date(`${deliveryDate}T12:00:00`).toLocaleDateString('es-VE', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      timeZone: 'America/Caracas',
    });
    const deliveryHourLabel = `${deliveryHour12}:${deliveryMinute}${deliveryAmPm.toLowerCase()}`;
    const paymentLabelMap: Record<PaymentMethod, string> = {
      pending: 'pendiente',
      payment_mobile: 'pago movil',
      transfer: 'transferencia',
      cash_usd: 'efectivo USD',
      cash_ves: 'efectivo Bs',
      zelle: 'zelle',
      mixed: 'mixto',
    };

    parts.push('*Resumen de Pedido*');
    parts.push('');
    parts.push(`✅ Vendedor: ${authUserLabel}`);
    parts.push('');
    parts.push(`✅ Cliente: ${clientName}`);

    if (clientPhone) {
      parts.push('');
      parts.push(`✅ Telefono: ${clientPhone}`);
    }

    parts.push('');
    parts.push('✅ Pedido:');
    parts.push('');

    if (draftItems.length === 0) {
      parts.push('- Sin items cargados');
    } else {
      for (const item of draftItems) {
        const lineBs =
          item.source_price_currency === 'VES'
            ? Number(item.source_price_amount || 0) * Number(item.qty || 0)
            : Number(item.line_total_usd || 0) * fxRateNumber;
        parts.push(`▪ ${item.qty} ${item.product_name_snapshot}: ${formatBsWhatsApp(lineBs)}`);
        if (item.editable_detail_lines.length > 0) {
          for (const detail of item.editable_detail_lines) {
            parts.push(`▪ ${detail}`);
          }
        }
      }
    }

    parts.push('');
    parts.push(`TOTAL: ${formatBsWhatsApp(finalTotalBs)} / ${finalTotalUsd.toFixed(2)}$`);
    parts.push('');
    parts.push(`✅ Forma de pago: ${paymentLabelMap[paymentMethod]}`);
    parts.push('');
    parts.push('✅ Estatus de pago: Pendiente');
    parts.push('');
    parts.push(
      `✅ Dia de entrega ${isAsap ? 'lo antes posible' : deliveryDayLabel}`
    );

    if (!isAsap) {
      parts.push('');
      parts.push(`✅ Hora: ${deliveryHourLabel}`);
    }

    if (fulfillment === 'delivery' && deliveryAddress.trim()) {
      parts.push('');
      parts.push(`✅ Direccion: ${deliveryAddress.trim()}`);
    }

    if (orderNote.trim()) {
      parts.push('');
      parts.push(`✅ Nota: ${orderNote.trim()}`);
    }

    return parts.join('\n');
  }

  function buildCleanQuoteSummary() {
    const parts: string[] = [];
    const clientName = selectedClient?.full_name || newClientName.trim() || 'Cliente';
    const clientPhone = selectedClient?.phone || newClientPhone.trim();
    const deliveryDayLabel = new Date(`${deliveryDate}T12:00:00`).toLocaleDateString('es-VE', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      timeZone: 'America/Caracas',
    });
    const deliveryHourLabel = `${deliveryHour12}:${deliveryMinute}${deliveryAmPm.toLowerCase()}`;
    const paymentLabelMap: Record<PaymentMethod, string> = {
      pending: 'pendiente',
      payment_mobile: 'pago móvil',
      transfer: 'transferencia',
      cash_usd: 'efectivo USD',
      cash_ves: 'efectivo Bs',
      zelle: 'zelle',
      mixed: 'mixto',
    };

    parts.push('*Resumen de Pedido*');
    parts.push('');
    parts.push(`✅ Vendedor: ${authUserLabel}`);
    parts.push('');
    parts.push(`✅ Cliente: ${clientName}`);

    if (clientPhone) {
      parts.push('');
      parts.push(`✅ Teléfono: ${clientPhone}`);
    }

    parts.push('');
    parts.push('✅ Pedido:');
    parts.push('');

    if (draftItems.length === 0) {
      parts.push('- Sin items cargados');
    } else {
      for (const item of draftItems) {
        const lineBs =
          item.source_price_currency === 'VES'
            ? Number(item.source_price_amount || 0) * Number(item.qty || 0)
            : Number(item.line_total_usd || 0) * fxRateNumber;
        parts.push(`▪ ${item.qty} ${item.product_name_snapshot}: ${formatBsWhatsApp(lineBs)}`);
        for (const detail of item.editable_detail_lines) {
          const normalizedDetail = String(detail || '').trim();
          if (normalizedDetail) parts.push(`▪ ${normalizedDetail}`);
        }
      }
    }

    parts.push('');
    parts.push(`TOTAL: ${formatBsWhatsApp(finalTotalBs)} / ${finalTotalUsd.toFixed(2)}$`);
    parts.push('');
    parts.push(`✅ Forma de pago: ${paymentLabelMap[paymentMethod]}`);
    parts.push('');
    parts.push('✅ Estatus de pago: Pendiente');
    parts.push('');
    parts.push(`✅ Día de entrega ${isAsap ? 'lo antes posible' : deliveryDayLabel}`);

    if (!isAsap) {
      parts.push('');
      parts.push(`✅ Hora: ${deliveryHourLabel}`);
    }

    if (fulfillment === 'delivery' && deliveryAddress.trim()) {
      parts.push('');
      parts.push(`✅ Dirección: ${deliveryAddress.trim()}`);
    }

    if (orderNote.trim()) {
      parts.push('');
      parts.push(`✅ Nota: ${orderNote.trim()}`);
    }

    return parts.join('\n');
  }

  async function handleCopyQuote() {
    clearMessages();
    if (draftItems.length === 0) {
      setError('Agrega al menos un item para copiar el presupuesto.');
      return;
    }

    setCopyingQuote(true);
    try {
      void buildQuoteSummary;
      await navigator.clipboard.writeText(buildCleanQuoteSummary());
      setInfo('Resumen copiado para WhatsApp.');
    } catch {
      setError('No se pudo copiar el resumen.');
    } finally {
      setCopyingQuote(false);
    }
  }

  async function ensureClientId() {
    if (selectedClient) return selectedClient.id;
    if (!isNewClientMode) throw new Error('Selecciona o crea un cliente.');
    return createClientNow();
  }

  async function generateOrderNumber() {
    const randomNumber = Math.floor(Math.random() * 10000);
    return `VO-${todayKey()}-${pad4(randomNumber)}`;
  }

  function buildExtraFields() {
    const deliveryTime24 = from12hTo24h(deliveryHour12, deliveryMinute, deliveryAmPm);
    const invoiceDataNote = [
      invoiceCompanyName.trim(),
      invoiceTaxId.trim(),
      invoiceAddress.trim(),
      invoicePhone.trim(),
    ]
      .filter(Boolean)
      .join(' | ');

    return {
      schedule: {
        date: deliveryDate,
        time_12: `${deliveryHour12}:${deliveryMinute} ${deliveryAmPm}`,
        time_24: deliveryTime24,
        asap: isAsap,
      },
      receiver: {
        name: receiverName.trim() || null,
        phone: receiverPhone.trim() ? normalizePhone(receiverPhone.trim()) : null,
      },
      delivery: {
        address: fulfillment === 'delivery' ? deliveryAddress.trim() || null : null,
        gps_url: fulfillment === 'delivery' ? deliveryGpsUrl.trim() || null : null,
      },
      payment: {
        method: paymentMethod,
        currency: paymentCurrency,
        requires_change: paymentRequiresChange,
        change_for: paymentRequiresChange && paymentChangeFor.trim() ? Number(paymentChangeFor) : null,
        change_currency: paymentRequiresChange ? paymentChangeCurrency : null,
        notes: paymentNote.trim() || null,
      },
      pricing: {
        fx_rate: fxRateNumber > 0 ? fxRateNumber : null,
        discount_enabled: discountEnabled,
        discount_pct: discountEnabled ? discountPctNumber : 0,
        discount_amount_usd: discountEnabled ? discountAmountUsd : 0,
        discount_amount_bs: discountEnabled ? Number(discountAmountBs.toFixed(2)) : 0,
        subtotal_usd: draftTotalUsd,
        subtotal_bs: Number(draftSubtotalBs.toFixed(2)),
        subtotal_after_discount_bs: Number(subtotalAfterDiscountBs.toFixed(2)),
        invoice_tax_pct: hasInvoice ? invoiceTaxPctNumber : 0,
        invoice_tax_amount_usd: hasInvoice ? invoiceTaxAmountUsd : 0,
        invoice_tax_amount_bs: hasInvoice ? Number(invoiceTaxAmountBs.toFixed(2)) : 0,
        total_usd: finalTotalUsd,
        total_bs: Number(finalTotalBs.toFixed(2)),
      },
      documents: {
        has_delivery_note: hasDeliveryNote,
        has_invoice: hasInvoice,
        invoice_data_note: hasInvoice ? invoiceDataNote || null : null,
        invoice_snapshot: hasInvoice
          ? {
              company_name: invoiceCompanyName.trim() || null,
              tax_id: invoiceTaxId.trim() || null,
              address: invoiceAddress.trim() || null,
              phone: normalizePhone(invoicePhone.trim()) || null,
            }
          : null,
        delivery_note_snapshot: hasDeliveryNote
          ? {
              name: deliveryNoteName.trim() || null,
              document_id: deliveryNoteDocumentId.trim() || null,
              address: deliveryNoteAddress.trim() || null,
              phone: normalizePhone(deliveryNotePhone.trim()) || null,
            }
          : null,
      },
      note: orderNote.trim() || null,
      ui: {
        quote_only: false,
        surface: 'advisor_mobile',
      },
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    clearMessages();

    if (!createReady) {
      setError('Completa cliente, items y entrega para continuar.');
      return;
    }

    try {
      from12hTo24h(deliveryHour12, deliveryMinute, deliveryAmPm);
    } catch (timeError) {
      setError(timeError instanceof Error ? timeError.message : 'Hora invalida.');
      return;
    }

    if (fxRateNumber <= 0) {
      setError('Falta una tasa valida para la orden.');
      return;
    }

    setSaving(true);

    try {
      const clientId = await ensureClientId();
      const nextEditSnapshot = isEditingOrder ? buildCurrentEditSnapshot(clientId) : null;
      if (selectedClient) rememberClient(selectedClient);
      if (fulfillment === 'delivery') rememberAddress(deliveryAddress, deliveryGpsUrl);
      const recentAddresses = mergeRecentAddresses(
        selectedClient?.recent_addresses,
        fulfillment === 'delivery' ? deliveryAddress : '',
        fulfillment === 'delivery' ? deliveryGpsUrl : ''
      );

      const { error: clientProfileError } = await supabase
        .from('clients')
        .update({
          billing_company_name: hasInvoice ? invoiceCompanyName.trim() || null : null,
          billing_tax_id: hasInvoice ? invoiceTaxId.trim() || null : null,
          billing_address: hasInvoice ? invoiceAddress.trim() || null : null,
          billing_phone: hasInvoice ? normalizePhone(invoicePhone) || null : null,
          delivery_note_name: hasDeliveryNote ? deliveryNoteName.trim() || null : null,
          delivery_note_document_id: hasDeliveryNote ? deliveryNoteDocumentId.trim() || null : null,
          delivery_note_address: hasDeliveryNote ? deliveryNoteAddress.trim() || null : null,
          delivery_note_phone: hasDeliveryNote ? normalizePhone(deliveryNotePhone) || null : null,
          recent_addresses: recentAddresses,
        })
        .eq('id', clientId);

      if (clientProfileError) throw new Error(clientProfileError.message);

      const payload = {
        client_id: clientId,
        attributed_advisor_id: authUserId,
        source: 'advisor',
        status: 'created',
        fulfillment,
        total_usd: finalTotalUsd,
        total_bs_snapshot: Number(finalTotalBs.toFixed(2)),
        is_price_locked: false,
        delivery_address: fulfillment === 'delivery' ? deliveryAddress.trim() || null : null,
        receiver_name: receiverName.trim() || null,
        receiver_phone: receiverPhone.trim() ? normalizePhone(receiverPhone.trim()) : null,
        notes: orderNote.trim() || null,
        extra_fields: buildExtraFields(),
      };

      let targetOrderId = Number(existingOrderId || 0);

      if (isEditingOrder) {
        const { error: updateOrderError } = await supabase
          .from('orders')
          .update(payload)
          .eq('id', Number(existingOrderId))
          .eq('attributed_advisor_id', authUserId);

        if (updateOrderError) throw new Error(updateOrderError.message);

        const { error: deleteItemsError } = await supabase
          .from('order_items')
          .delete()
          .eq('order_id', Number(existingOrderId));

        if (deleteItemsError) throw new Error(deleteItemsError.message);
      } else {
        const orderNumber = await generateOrderNumber();
        const { data: order, error: orderError } = await supabase
          .from('orders')
          .insert({
            ...payload,
            order_number: orderNumber,
            created_by_user_id: authUserId,
          })
          .select('id')
          .single();

        if (orderError) throw new Error(orderError.message);
        targetOrderId = Number(order.id);
      }

      const itemsPayload = draftItems.map((item) => ({
        order_id: targetOrderId,
        product_id: item.product_id,
        qty: item.qty,
        pricing_origin_currency: item.source_price_currency,
        pricing_origin_amount: item.source_price_amount,
        unit_price_usd_snapshot: item.unit_price_usd_snapshot,
        line_total_usd: item.line_total_usd,
        unit_price_bs_snapshot:
          item.source_price_currency === 'VES'
            ? Number(item.source_price_amount || 0)
            : Number((item.unit_price_usd_snapshot * fxRateNumber).toFixed(2)),
        line_total_bs_snapshot:
          item.source_price_currency === 'VES'
            ? Number((Number(item.source_price_amount || 0) * Number(item.qty || 0)).toFixed(2))
            : Number((Number(item.line_total_usd || 0) * fxRateNumber).toFixed(2)),
        sku_snapshot: item.sku_snapshot,
        product_name_snapshot: item.product_name_snapshot,
        notes: item.editable_detail_lines.length > 0 ? item.editable_detail_lines.join('\n') : null,
      }));

      const { error: itemsError } = await supabase.from('order_items').insert(itemsPayload);
      if (itemsError) throw new Error(itemsError.message);

      if (isEditingOrder && nextEditSnapshot && originalEditSnapshot) {
        const changeMeta = buildOrderEditChangeSummary(originalEditSnapshot, nextEditSnapshot);

        if (changeMeta.summary.length > 0) {
          const { error: timelineError } = await supabase.from('order_timeline_events').insert({
            order_id: targetOrderId,
            order_number: existingOrderNumber || null,
            event_type: 'order_modified',
            event_group: 'modification',
            title: existingOrderStatus === 'queued' ? 'Orden modificada para re-aprobacion' : 'Orden modificada',
            message: changeMeta.summary.join(' '),
            severity: existingOrderStatus === 'queued' ? 'warning' : 'info',
            actor_user_id: authUserId || null,
            payload: {
              changed_sections: changeMeta.sections,
              change_summary: changeMeta.summary,
              source: 'advisor_mobile',
            },
          });

          if (timelineError) {
            console.warn('No se pudo registrar el evento de modificacion.', timelineError.message);
          }
        }
      }

      router.push(`/app/advisor/orders/${targetOrderId}`);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : isEditingOrder
            ? 'No se pudo actualizar la orden.'
            : 'No se pudo crear la orden.'
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-5 text-sm text-[#AAB2C5]">
        {isEditingOrder
          ? 'Cargando pedido para corregir...'
          : isRepeatingOrder
            ? 'Cargando pedido base para repetir...'
            : 'Cargando captura del asesor...'}
      </div>
    );
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4 pb-32">
        {error ? <div className="rounded-[18px] border border-[#5E2229] bg-[#261114] px-4 py-3 text-sm text-[#F0A6AE]">{error}</div> : null}
        {info ? <div className="rounded-[18px] border border-[#1C5036] bg-[#0F2119] px-4 py-3 text-sm text-[#7CE0A9]">{info}</div> : null}

        <Section title="1. Cliente" subtitle="Busca primero y crea solo si no existe.">
          {recentClients.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {recentClients.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => {
                    setSelectedClient(client as ClientRow);
                    applyClientProfile(client as ClientRow);
                    setSearchTerm(client.phone || client.full_name);
                    setClientResults([]);
                    setIsNewClientMode(false);
                    setInfo(`Cliente rapido: ${client.full_name}`);
                  }}
                  className="rounded-[14px] border border-[#232632] bg-[#0F131B] px-3 py-2 text-sm text-[#F5F7FB]"
                >
                  {client.full_name}
                </button>
              ))}
            </div>
          ) : null}

          <Field label="Buscar cliente">
            <div className="flex gap-2">
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.currentTarget as HTMLInputElement).blur();
                    void handleSearchClients();
                  }
                }}
                className={inputClass()}
                placeholder="Telefono o nombre"
              />
              <button type="button" onClick={() => void handleSearchClients()} className="h-11 rounded-[16px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]">
                {searchingClient ? 'Buscando' : 'Buscar'}
              </button>
            </div>
          </Field>

          {selectedClient ? (
            <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              <div className="font-medium">{selectedClient.full_name}</div>
              <div className="mt-1 text-xs text-[#8B93A7]">{selectedClient.phone || 'Sin telefono'}</div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-[14px] border border-[#232632] bg-[#12151d] px-3 py-2">
                  <div className="text-[#8B93A7]">Tipo</div>
                  <div className="mt-1 font-medium text-[#F5F7FB]">
                    {clientTypeLabel(selectedClient.client_type)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#232632] bg-[#12151d] px-3 py-2">
                  <div className="text-[#8B93A7]">Fondo</div>
                  <div className="mt-1 font-medium text-[#F5F7FB]">
                    {selectedClientFundUsd > 0 ? formatUsd(selectedClientFundUsd) : 'Sin fondo'}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {clientResults.length > 0 ? (
            <div className="space-y-2">
              {clientResults.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => {
                    setSelectedClient(client);
                    rememberClient(client);
                    applyClientProfile(client);
                    setIsNewClientMode(false);
                    setClientResults([]);
                    setSearchTerm(client.phone ?? client.full_name);
                    setInfo(`Cliente seleccionado: ${client.full_name}`);
                  }}
                  className="flex w-full items-center justify-between rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-left"
                >
                  <div>
                    <div className="text-sm font-medium text-[#F5F7FB]">{client.full_name}</div>
                    <div className="mt-1 text-xs text-[#8B93A7]">{client.phone || 'Sin telefono'}</div>
                  </div>
                  <div className="text-xs text-[#AAB2C5]">Usar</div>
                </button>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => {
              setIsNewClientMode((current) => !current);
              setSelectedClient(null);
            }}
            className="h-10 rounded-[14px] border border-[#232632] text-sm font-medium text-[#F5F7FB]"
          >
            {isNewClientMode ? 'Cancelar cliente nuevo' : 'Crear cliente nuevo'}
          </button>

          {isNewClientMode ? (
            <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
              <Field label="Nombre">
                <input value={newClientName} onChange={(e) => setNewClientName(e.target.value)} className={inputClass()} placeholder="Nombre completo" />
              </Field>
              <Field label="Telefono">
                <input value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} className={inputClass()} placeholder="0412..." />
              </Field>
              <Field label="Canal">
                <select value={newClientType} onChange={(e) => setNewClientType(e.target.value as ClientType)} className={inputClass()}>
                  <option value="assigned">Asignado</option>
                  <option value="own">Propio</option>
                  <option value="legacy">Antiguo</option>
                </select>
              </Field>
              <button type="button" onClick={() => void createClientNow()} className="h-10 rounded-[14px] bg-[#F0D000] text-sm font-semibold text-[#17191E]">
                {creatingClient ? 'Creando...' : 'Guardar cliente'}
              </button>
            </div>
          ) : null}
        </Section>

        <Section title="2. Pedido" subtitle="Misma logica base de master, compacta para telefono.">
          {favoriteProducts.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[12px] font-medium text-[#AAB2C5]">Favoritos</div>
              <div className="flex flex-wrap gap-2">
                {favoriteProducts.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => chooseProduct(product)}
                    className="rounded-[14px] border border-[#564511] bg-[#2A2209] px-3 py-2 text-sm text-[#F7DA66]"
                  >
                    {product.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {recentProducts.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[12px] font-medium text-[#AAB2C5]">Recientes</div>
              <div className="flex flex-wrap gap-2">
                {recentProducts.slice(0, 6).map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => chooseProduct(product)}
                    className="rounded-[14px] border border-[#232632] bg-[#0F131B] px-3 py-2 text-sm text-[#F5F7FB]"
                  >
                    {product.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="relative">
            <Field label="Producto">
              <input
                value={productSearch}
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setProductActiveIndex(-1);
                  if (!e.target.value.trim()) setSelectedProductId('');
                }}
                onKeyDown={(e) => {
                  if (!productSearch.trim() || filteredProducts.length === 0) return;

                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setProductActiveIndex((prev) => {
                      const next = prev < filteredProducts.length - 1 ? prev + 1 : 0;
                      setSelectedProductId(filteredProducts[next]?.id ?? '');
                      return next;
                    });
                    return;
                  }

                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setProductActiveIndex((prev) => {
                      const next = prev > 0 ? prev - 1 : filteredProducts.length - 1;
                      setSelectedProductId(filteredProducts[next]?.id ?? '');
                      return next;
                    });
                    return;
                  }

                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const selected =
                      productActiveIndex >= 0 ? filteredProducts[productActiveIndex] : filteredProducts[0];
                    if (!selected) return;
                    chooseProduct(selected);
                  }
                }}
                className={inputClass()}
                placeholder="Escribe nombre o codigo"
              />
            </Field>

            {productSearch.trim() && (!selectedProduct || productSearch !== selectedProduct.name) ? (
              <div className="absolute z-20 mt-2 max-h-[260px] w-full overflow-y-auto rounded-[18px] border border-[#232632] bg-[#0F131B]">
                {filteredProducts.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-[#8B93A7]">Sin resultados</div>
                ) : (
                  filteredProducts.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => chooseProduct(product)}
                      className={[
                        'w-full border-b border-[#191926] px-3 py-3 text-left last:border-b-0',
                        filteredProducts[productActiveIndex]?.id === product.id ? 'bg-[#121218]' : 'hover:bg-[#121218]',
                      ].join(' ')}
                    >
                      <div className="text-sm font-medium text-[#F5F7FB]">{product.name}</div>
                      <div className="mt-1 text-xs text-[#8B93A7]">
                        {product.sku || 'Sin codigo'} | ${Number(product.base_price_usd ?? 0).toFixed(2)}
                      </div>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-[1fr_104px] gap-2">
            <div className="rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              {selectedProduct ? selectedProduct.name : 'Selecciona producto'}
            </div>
            <input
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDraftItem();
                }
              }}
              className={inputClass()}
              inputMode="numeric"
              placeholder="Cant."
            />
          </div>

          {selectedProduct ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => toggleFavoriteProduct(selectedProduct.id)}
                className={[
                  'h-9 rounded-[12px] px-3 text-xs font-medium',
                  favoriteProductIds.includes(selectedProduct.id)
                    ? 'border border-[#564511] bg-[#2A2209] text-[#F7DA66]'
                    : 'border border-[#232632] text-[#F5F7FB]',
                ].join(' ')}
              >
                {favoriteProductIds.includes(selectedProduct.id) ? 'Quitar favorito' : 'Marcar favorito'}
              </button>
            </div>
          ) : null}

          <button
            type="button"
            onClick={addDraftItem}
            className={[
              'h-10 rounded-[14px] text-sm font-medium',
              selectedProduct ? 'bg-[#F0D000] text-[#17191E]' : 'border border-[#232632] text-[#F5F7FB]',
            ].join(' ')}
          >
            Confirmar item
          </button>

          {draftItems.length === 0 ? (
            <div className="rounded-[18px] border border-dashed border-[#2A3040] bg-[#0F131B] px-4 py-4 text-sm text-[#AAB2C5]">
              Agrega al menos un producto para activar el pedido.
            </div>
          ) : (
            <div className="space-y-2">
              {draftItems.map((item) => (
                <div key={item.localId} className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">{item.product_name_snapshot}</div>
                      <div className="mt-1 text-xs text-[#8B93A7]">
                        {item.qty} x {formatUsd(item.unit_price_usd_snapshot)}
                      </div>
                    </div>
                    <div className="text-sm font-medium text-[#F0D000]">{formatUsd(item.line_total_usd)}</div>
                  </div>

                  {item.editable_detail_lines.length > 0 ? (
                    <div className="mt-2 space-y-1 rounded-[14px] bg-[#0B0F15] px-3 py-2 text-xs text-[#AAB2C5]">
                      {item.editable_detail_lines.map((line, index) => (
                        <div key={`${item.localId}-${index}`}>- {line}</div>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-3 flex gap-2">
                    {item.editable_detail_lines.length > 0 ? (
                      <button type="button" onClick={() => openEditConfig(item)} className="h-9 rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]">
                        Editar
                      </button>
                    ) : null}
                    <button type="button" onClick={() => removeDraftItem(item.localId)} className="h-9 rounded-[12px] border border-[#5E2229] px-3 text-xs font-medium text-[#F0A6AE]">
                      Quitar
                    </button>
                  </div>
                </div>
              ))}

              <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Tasa del dia (Bs/USD)">
                    <input
                      value={fxRate}
                      onChange={(e) => setFxRate(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      className={inputClass()}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </Field>

                  <label className="flex items-end gap-3 rounded-[16px] border border-[#232632] bg-[#12151d] px-3.5 py-3 text-sm text-[#F5F7FB]">
                    <input
                      type="checkbox"
                      checked={discountEnabled}
                      onChange={(e) => {
                        setDiscountEnabled(e.target.checked);
                        if (!e.target.checked) setDiscountPct('0');
                      }}
                    />
                    <span>Aplicar descuento</span>
                  </label>
                </div>

                {discountEnabled ? (
                  <Field label="% Descuento">
                    <input
                      value={discountPct}
                      onChange={(e) => setDiscountPct(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      className={inputClass()}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </Field>
                ) : null}

                <div className="grid gap-2 text-sm text-[#AAB2C5]">
                  <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                    <span>Subtotal USD</span>
                    <span className="text-[#F5F7FB]">{formatUsd(draftTotalUsd)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                    <span>Subtotal Bs</span>
                    <span className="text-[#F5F7FB]">{fxRateNumber > 0 ? formatBs(draftSubtotalBs) : 'Define la tasa'}</span>
                  </div>
                  {discountEnabled ? (
                    <>
                      <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                        <span>Descuento USD</span>
                        <span className="text-[#F5F7FB]">-{formatUsd(discountAmountUsd)}</span>
                      </div>
                      <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                        <span>Descuento Bs</span>
                        <span className="text-[#F5F7FB]">-{fxRateNumber > 0 ? formatBs(discountAmountBs) : 'Define la tasa'}</span>
                      </div>
                    </>
                  ) : null}
                  {hasInvoice ? (
                    <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                      <span>IVA</span>
                      <span className="text-[#F5F7FB]">
                        {formatUsd(invoiceTaxAmountUsd)}
                        {fxRateNumber > 0 ? ` / ${formatBs(invoiceTaxAmountBs)}` : ''}
                      </span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                    <span>Total</span>
                    <span className="font-semibold text-[#F0D000]">
                      {formatUsd(finalTotalUsd)}
                      {fxRateNumber > 0 ? ` / ${formatBs(finalTotalBs)}` : ''}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </Section>

        <Section title="3. Entrega" subtitle="Con soporte para fecha fija o lo antes posible.">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setFulfillment('pickup')} className={['h-10 rounded-[14px] border px-4 text-sm font-medium', fulfillment === 'pickup' ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]'].join(' ')}>
              Retiro
            </button>
            <button type="button" onClick={() => setFulfillment('delivery')} className={['h-10 rounded-[14px] border px-4 text-sm font-medium', fulfillment === 'delivery' ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]'].join(' ')}>
              Delivery
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsAsap((current) => !current)}
            className={[
              'h-10 rounded-[14px] border px-4 text-sm font-medium',
              isAsap ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]',
            ].join(' ')}
          >
            Lo antes posible
          </button>

          <Field label="Fecha">
            <input
              type="date"
              value={deliveryDate}
              onChange={(e) => {
                setDeliveryDate(e.target.value);
                setIsAsap(false);
              }}
              className={`${inputClass()} [color-scheme:dark]`}
            />
          </Field>

          <Field label="Hora">
            <div className="grid grid-cols-[72px_72px_minmax(92px,1fr)] gap-2">
              <input value={deliveryHour12} onChange={(e) => { setDeliveryHour12(e.target.value); setIsAsap(false); }} className={inputClass()} inputMode="numeric" />
              <input value={deliveryMinute} onChange={(e) => { setDeliveryMinute(e.target.value); setIsAsap(false); }} className={inputClass()} inputMode="numeric" />
              <select value={deliveryAmPm} onChange={(e) => { setDeliveryAmPm(e.target.value as 'AM' | 'PM'); setIsAsap(false); }} className={inputClass()}>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Recibe">
              <input value={receiverName} onChange={(e) => setReceiverName(e.target.value)} className={inputClass()} placeholder="Nombre" />
            </Field>
            <Field label="Telefono">
              <input value={receiverPhone} onChange={(e) => setReceiverPhone(e.target.value)} className={inputClass()} placeholder="Contacto" />
            </Field>
          </div>

          {fulfillment === 'delivery' ? (
            <>
              {quickAddresses.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {quickAddresses.map((address, index) => (
                    <button
                      key={`${address.addressText}-${index}`}
                      type="button"
                      onClick={() => applyClientAddress(address)}
                      className={[
                        'rounded-[14px] border px-3 py-2 text-sm',
                        deliveryAddress.trim() === address.addressText.trim()
                          ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
                          : 'border-[#232632] bg-[#0F131B] text-[#F5F7FB]',
                      ].join(' ')}
                    >
                      Direccion {index + 1}
                    </button>
                  ))}
                </div>
              ) : null}
              <Field label="Direccion" hint="Solo este campo puede crecer mas cuando haga falta.">
                <textarea value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} className={inputClass(true)} placeholder="Direccion completa" />
              </Field>
              <Field label="GPS URL">
                <input value={deliveryGpsUrl} onChange={(e) => setDeliveryGpsUrl(e.target.value)} className={inputClass()} placeholder="Link de ubicacion" />
              </Field>
            </>
          ) : null}
        </Section>

        <Section title="4. Pago y notas" subtitle="Misma operacion base de master, sin ruido extra.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Forma de pago">
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)} className={inputClass()}>
                <option value="pending">Pendiente</option>
                <option value="payment_mobile">Pago movil</option>
                <option value="transfer">Transferencia</option>
                <option value="cash_usd">Efectivo USD</option>
                <option value="cash_ves">Efectivo Bs</option>
                <option value="zelle">Zelle</option>
                <option value="mixed">Mixto</option>
              </select>
            </Field>
            <Field label="Moneda principal">
              <select value={paymentCurrency} onChange={(e) => setPaymentCurrency(e.target.value as CurrencyCode)} className={inputClass()} disabled={paymentMethod !== 'mixed'}>
                <option value="USD">USD</option>
                <option value="VES">Bs</option>
              </select>
            </Field>
          </div>

          <label className="flex items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
            <input type="checkbox" checked={paymentRequiresChange} onChange={(e) => setPaymentRequiresChange(e.target.checked)} />
            <span>Requiere cambio</span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              <input
                type="checkbox"
                checked={hasDeliveryNote}
                onChange={(e) => {
                  setHasDeliveryNote(e.target.checked);
                  if (!e.target.checked) {
                    setDeliveryNoteName('');
                    setDeliveryNoteDocumentId('');
                    setDeliveryNoteAddress('');
                    setDeliveryNotePhone('');
                  }
                }}
              />
              <span>Lleva nota de entrega</span>
            </label>

            <label className="flex items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              <input
                type="checkbox"
                checked={hasInvoice}
                onChange={(e) => {
                  setHasInvoice(e.target.checked);
                  if (e.target.checked && !String(invoiceTaxPct || '').trim()) {
                    setInvoiceTaxPct('16');
                  }
                  if (!e.target.checked) {
                    setInvoiceCompanyName('');
                    setInvoiceTaxId('');
                    setInvoiceAddress('');
                    setInvoicePhone('');
                    setInvoiceTaxPct('16');
                  }
                }}
              />
              <span>Lleva factura</span>
            </label>
          </div>

          {paymentRequiresChange ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cambio para">
                <input value={paymentChangeFor} onChange={(e) => setPaymentChangeFor(e.target.value)} className={inputClass()} inputMode="decimal" placeholder="Monto" />
              </Field>
              <Field label="Moneda del cambio">
                <select value={paymentChangeCurrency} onChange={(e) => setPaymentChangeCurrency(e.target.value as CurrencyCode)} className={inputClass()}>
                  <option value="USD">USD</option>
                  <option value="VES">Bs</option>
                </select>
              </Field>
            </div>
          ) : null}

          {hasInvoice ? (
            <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
              <div className="text-sm font-medium text-[#F5F7FB]">Datos de factura</div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nombre o razon social">
                  <input value={invoiceCompanyName} onChange={(e) => setInvoiceCompanyName(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="RIF o documento">
                  <input value={invoiceTaxId} onChange={(e) => setInvoiceTaxId(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="Telefono">
                  <input value={invoicePhone} onChange={(e) => setInvoicePhone(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="% IVA">
                  <input
                    value={invoiceTaxPct}
                    onChange={(e) => setInvoiceTaxPct(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    className={inputClass()}
                    inputMode="decimal"
                  />
                </Field>
              </div>
              <Field label="Direccion fiscal">
                <textarea value={invoiceAddress} onChange={(e) => setInvoiceAddress(e.target.value)} className={inputClass(true)} />
              </Field>
            </div>
          ) : null}

          {hasDeliveryNote ? (
            <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
              <div className="text-sm font-medium text-[#F5F7FB]">Datos de nota de entrega</div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nombre">
                  <input value={deliveryNoteName} onChange={(e) => setDeliveryNoteName(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="Documento">
                  <input value={deliveryNoteDocumentId} onChange={(e) => setDeliveryNoteDocumentId(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="Telefono">
                  <input value={deliveryNotePhone} onChange={(e) => setDeliveryNotePhone(e.target.value)} className={inputClass()} />
                </Field>
              </div>
              <Field label="Direccion">
                <textarea value={deliveryNoteAddress} onChange={(e) => setDeliveryNoteAddress(e.target.value)} className={inputClass(true)} />
              </Field>
            </div>
          ) : null}

          {(hasInvoice || hasDeliveryNote) && selectedClient ? (
            <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#AAB2C5]">
              {hasInvoice ? (
                <div>
                  <span className="text-[#F5F7FB]">Factura:</span>{' '}
                  {[invoiceCompanyName.trim(), invoiceTaxId.trim(), invoiceAddress.trim(), invoicePhone.trim()]
                    .filter(Boolean)
                    .join(' | ') || 'Sin datos'}
                </div>
              ) : null}
              {hasDeliveryNote ? (
                <div className={hasInvoice ? 'mt-2' : ''}>
                  <span className="text-[#F5F7FB]">Nota de entrega:</span>{' '}
                  {[
                    deliveryNoteName.trim(),
                    deliveryNoteDocumentId.trim(),
                    deliveryNoteAddress.trim(),
                    deliveryNotePhone.trim(),
                  ]
                    .filter(Boolean)
                    .join(' | ') || 'Sin datos'}
                </div>
              ) : null}
            </div>
          ) : null}

          <Field label="Nota de pago">
            <input value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} className={inputClass()} placeholder="Referencia o acuerdo" />
          </Field>

          <Field label="Observaciones del pedido">
            <textarea value={orderNote} onChange={(e) => setOrderNote(e.target.value)} className={inputClass(true)} placeholder="Notas operativas utiles" />
          </Field>
        </Section>

        <div className="fixed inset-x-0 bottom-[68px] z-20 border-t border-[#1A1D26] bg-[#090B10]/96 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-screen-md items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-[#8B93A7]">Total</div>
              <div className="text-lg font-semibold text-[#F5F7FB]">{formatUsd(finalTotalUsd)}</div>
              <div className="text-xs text-[#8B93A7]">{fxRateNumber > 0 ? formatBs(finalTotalBs) : 'Falta tasa del dia'}</div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleCopyQuote()}
                disabled={copyingQuote || draftItems.length === 0}
                className={[
                  'h-11 rounded-[16px] border px-4 text-sm font-semibold',
                  copyingQuote || draftItems.length === 0
                    ? 'border-[#232632] text-[#6F7890]'
                    : 'border-[#232632] text-[#F5F7FB]',
                ].join(' ')}
              >
                {copyingQuote ? 'Copiando...' : 'Copiar WhatsApp'}
              </button>
              <button
                type="submit"
                disabled={saving || !createReady}
                className={[
                  'h-11 rounded-[16px] px-4 text-sm font-semibold',
                  saving || !createReady ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#F0D000] text-[#17191E]',
                ].join(' ')}
              >
                {saving ? 'Guardando...' : isEditingOrder ? 'Guardar cambios' : 'Crear pedido'}
              </button>
            </div>
          </div>
        </div>
      </form>

      <ConfigSheet
        open={configOpen}
        title={configProduct?.name || 'Configurar producto'}
        alias={configAlias}
        setAlias={setConfigAlias}
        totalSelected={configSelectedUnits}
        totalLimit={configTotalLimit}
        options={configOptions}
        selections={configSelections}
        onChangeQty={setConfigSelectionQty}
        onClose={resetConfig}
        onConfirm={confirmConfig}
        isEditing={!!configEditingLocalId}
      />
    </>
  );
}

