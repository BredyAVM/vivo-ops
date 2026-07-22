"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from "@/lib/pricing/order-snapshots";
import {
  buildComponentDetailLines,
  getVisibleEditableDetailLines,
  parseEditableDetailLines,
} from "@/lib/orders/order-composer";
import { sortOrderItemsByPriority } from "@/lib/orders/order-item-priority";
import { formatOrderDisplayNumber, getPaymentMethodLabel } from "@/lib/orders/order-labels";
import { createOrderAction, searchClientsAction, updateOrderAction } from "../dashboard/actions";
import {
  loadMasterOpsOrderCreateDataAction,
  loadMasterOpsOrderEditDataAction,
  type MasterOpsEditAdvisor,
  type MasterOpsEditCatalogItem,
  type MasterOpsEditClient,
  type MasterOpsEditCurrency,
  type MasterOpsEditData,
  type MasterOpsEditOrder,
  type MasterOpsEditOrderItem,
  type MasterOpsEditProductComponent,
} from "./actions";

type Props = {
  mode?: "create" | "edit";
  orderId?: number | null;
  open?: boolean;
  focusDate?: string;
  roles: string[];
  fallbackActiveRate: number | null;
  onClose: () => void;
  onSaved: () => void;
};

type ClientSearchResult = {
  id: number | string;
  full_name?: string | null;
  phone?: string | null;
  client_type?: string | null;
  fund_balance_usd?: number | string | null;
  recent_addresses?: any;
  billing_company_name?: string | null;
  billing_tax_id?: string | null;
  billing_address?: string | null;
  billing_phone?: string | null;
  delivery_note_name?: string | null;
  delivery_note_document_id?: string | null;
  delivery_note_address?: string | null;
  delivery_note_phone?: string | null;
};

type ConfigSelection = {
  localId: string;
  componentProductId: number;
  componentName: string;
  qty: number;
};

type ConfigState = {
  editingLocalId: string | null;
  productId: number;
  productName: string;
  sku: string | null;
  qty: number;
  sourcePriceCurrency: MasterOpsEditCurrency;
  sourcePriceAmount: number;
  fallbackUnitUsd: number;
  detailUnitsLimit: number;
  alias: string;
  selections: ConfigSelection[];
};

const PAYMENT_METHODS = [
  "cash_usd",
  "cash_ves",
  "payment_mobile",
  "transfer",
  "pos",
  "zelle",
  "wallet_usd",
  "retention",
];

function toNumber(value: unknown, fallback = 0) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function money(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function bs(value: number) {
  return `Bs ${Number(value || 0).toLocaleString("es-VE", { maximumFractionDigits: 2 })}`;
}

function compact(value: number, decimals = 2) {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toFixed(decimals)));
}

function normalizeSearchValue(value: unknown) {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeClientType(value: unknown): "assigned" | "own" | "legacy" {
  const text = String(value || "");
  if (text === "own" || text === "legacy") return text;
  return "assigned";
}

function mapClientSearchResult(row: ClientSearchResult): MasterOpsEditClient {
  return {
    id: Number(row.id),
    fullName: String(row.full_name || "Cliente").trim(),
    phone: String(row.phone || "").trim(),
    clientType: normalizeClientType(row.client_type),
    fundBalanceUsd: toNumber(row.fund_balance_usd, 0),
    recentAddresses: Array.isArray(row.recent_addresses) ? row.recent_addresses : [],
    billingCompanyName: String(row.billing_company_name || "").trim(),
    billingTaxId: String(row.billing_tax_id || "").trim(),
    billingAddress: String(row.billing_address || "").trim(),
    billingPhone: String(row.billing_phone || "").trim(),
    deliveryNoteName: String(row.delivery_note_name || "").trim(),
    deliveryNoteDocumentId: String(row.delivery_note_document_id || "").trim(),
    deliveryNoteAddress: String(row.delivery_note_address || "").trim(),
    deliveryNotePhone: String(row.delivery_note_phone || "").trim(),
  };
}

function fieldClass(className = "") {
  return [
    "w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#6F6F7C]",
    "focus:border-[#FEEF00]/60 focus:outline-none",
    className,
  ].join(" ");
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-[11px] text-[#B7B7C2] ${className}`}>
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#F5F5F7]">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function itemKey(localId: string) {
  return localId || `${Date.now()}-${Math.random()}`;
}

function recalculateItem(item: MasterOpsEditOrderItem, fxRate: number): MasterOpsEditOrderItem {
  const snapshot = calculateOrderLineSnapshot({
    sourceCurrency: item.sourcePriceCurrency,
    sourceAmount: item.sourcePriceAmount,
    quantity: item.qty,
    fxRate,
    overrideUnitUsd: item.adminPriceOverrideCurrency ? null : item.adminPriceOverrideUsd,
    fallbackUnitUsd: item.unitPriceUsdSnapshot,
  });

  return {
    ...item,
    unitPriceUsdSnapshot:
      item.adminPriceOverrideUsd != null && !item.adminPriceOverrideCurrency
        ? item.unitPriceUsdSnapshot
        : snapshot.unitUsd,
    lineTotalUsd: snapshot.lineUsd,
  };
}

function createPriorityInput(catalogItems: MasterOpsEditCatalogItem[], item: MasterOpsEditOrderItem) {
  const catalogItem = catalogItems.find((catalog) => catalog.id === item.productId);
  return {
    productType: catalogItem?.type,
    productName: item.productNameSnapshot,
    internalRiderPayUsd: catalogItem?.internalRiderPayUsd ?? null,
  };
}

function initialNewClientFromOrder(order: MasterOpsEditOrder | null) {
  return {
    name: order?.client?.fullName ?? "",
    phone: order?.client?.phone ?? "",
    type: order?.client?.clientType ?? ("assigned" as const),
  };
}

export default function MasterOpsOrderEditor({
  mode = "edit",
  orderId = null,
  open = false,
  focusDate,
  roles,
  fallbackActiveRate,
  onClose,
  onSaved,
}: Props) {
  const isCreateMode = mode === "create";
  const isOpen = isCreateMode ? open : Boolean(orderId);
  const isAdmin = roles.includes("admin");
  const [data, setData] = useState<MasterOpsEditData | null>(null);
  const [form, setForm] = useState<MasterOpsEditOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [adminEditReason, setAdminEditReason] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [clientResults, setClientResults] = useState<MasterOpsEditClient[]>([]);
  const [clientSearching, setClientSearching] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientType, setNewClientType] = useState<"assigned" | "own" | "legacy">("assigned");
  const [productSearch, setProductSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<number | "">("");
  const [productQty, setProductQty] = useState("1");
  const [configState, setConfigState] = useState<ConfigState | null>(null);
  const productQtyRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setData(null);
      setForm(null);
      return;
    }
    if (!isCreateMode && !orderId) {
      setData(null);
      setForm(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSuccess(null);

    const loadData = isCreateMode
      ? loadMasterOpsOrderCreateDataAction(focusDate)
      : loadMasterOpsOrderEditDataAction(Number(orderId));

    loadData
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setForm({ ...result.order, items: result.order.items.map((item) => ({ ...item })) });
        const initialClient = initialNewClientFromOrder(result.order);
        setNewClientName(initialClient.name);
        setNewClientPhone(initialClient.phone);
        setNewClientType(initialClient.type);
        setAdminEditReason("");
        setProductSearch("");
        setSelectedProductId("");
        setProductQty("1");
        setConfigState(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "No se pudo cargar la orden.");
        setData(null);
        setForm(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [focusDate, isCreateMode, isOpen, orderId]);

  useEffect(() => {
    const query = clientSearch.trim();
    if (query.length < 2) {
      setClientResults([]);
      setClientSearching(false);
      return;
    }

    let cancelled = false;
    setClientSearching(true);
    const timer = window.setTimeout(() => {
      searchClientsAction({ query, limit: 8 })
        .then((rows) => {
          if (cancelled) return;
          setClientResults(((rows ?? []) as ClientSearchResult[]).map(mapClientSearchResult));
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "No se pudo buscar clientes.");
          setClientResults([]);
        })
        .finally(() => {
          if (!cancelled) setClientSearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clientSearch]);

  const activeRate = data?.activeRate ?? fallbackActiveRate ?? null;
  const fxRate = Math.max(0, toNumber(form?.fxRate, activeRate ?? 0));

  const componentsByParentId = useMemo(() => {
    const map = new Map<number, MasterOpsEditProductComponent[]>();
    for (const component of data?.productComponents ?? []) {
      const bucket = map.get(component.parentProductId) ?? [];
      bucket.push(component);
      map.set(component.parentProductId, bucket);
    }
    return map;
  }, [data?.productComponents]);

  const catalogById = useMemo(
    () => new Map((data?.catalogItems ?? []).map((item) => [item.id, item] as const)),
    [data?.catalogItems]
  );

  const filteredProducts = useMemo(() => {
    const q = normalizeSearchValue(productSearch);
    return (data?.catalogItems ?? [])
      .filter((item) => item.isActive)
      .filter((item) => {
        if (!q) return true;
        const haystack = normalizeSearchValue(`${item.name} ${item.sku ?? ""}`);
        return haystack.includes(q);
      })
      .slice(0, 18);
  }, [data?.catalogItems, productSearch]);

  const selectedProduct = selectedProductId ? catalogById.get(Number(selectedProductId)) ?? null : null;

  const calculatedItems = useMemo(
    () => (form?.items ?? []).map((item) => recalculateItem(item, fxRate)),
    [form?.items, fxRate]
  );

  const orderedItems = useMemo(
    () => sortOrderItemsByPriority(calculatedItems, (item) => createPriorityInput(data?.catalogItems ?? [], item)),
    [calculatedItems, data?.catalogItems]
  );

  const totals = useMemo(() => {
    const lineSnapshots = calculatedItems.map((item) =>
      calculateOrderLineSnapshot({
        sourceCurrency: item.sourcePriceCurrency,
        sourceAmount: item.sourcePriceAmount,
        quantity: item.qty,
        fxRate,
        overrideUnitUsd: item.adminPriceOverrideCurrency ? null : item.adminPriceOverrideUsd,
        fallbackUnitUsd: item.unitPriceUsdSnapshot,
      })
    );
    const subtotalUsd = lineSnapshots.reduce((sum, snapshot) => sum + snapshot.lineUsd, 0);
    const subtotalBs = lineSnapshots.reduce((sum, snapshot) => sum + snapshot.lineBs, 0);
    return calculateOrderTotalsSnapshot({
      subtotalUsd,
      subtotalBs,
      discountPct: form?.discountEnabled ? toNumber(form.discountPct, 0) : 0,
      invoiceTaxPct: form?.hasInvoice ? toNumber(form.invoiceTaxPct || "16", 16) : 0,
    });
  }, [calculatedItems, form?.discountEnabled, form?.discountPct, form?.hasInvoice, form?.invoiceTaxPct, fxRate]);

  const isAdvancedOrderEdit = form && !isCreateMode ? !["created", "queued"].includes(form.status) : false;
  const canSave =
    Boolean(form) &&
    (Boolean(form?.selectedClientId) || (newClientName.trim().length > 1 && newClientPhone.trim().length > 4)) &&
    calculatedItems.length > 0 &&
    fxRate > 0 &&
    (!isAdvancedOrderEdit || adminEditReason.trim().length >= 4);

  function patchForm(patch: Partial<MasterOpsEditOrder>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  function patchItem(localId: string, patch: Partial<MasterOpsEditOrderItem>) {
    setForm((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
          }
        : current
    );
  }

  function removeItem(localId: string) {
    setForm((current) =>
      current ? { ...current, items: current.items.filter((item) => item.localId !== localId) } : current
    );
  }

  function selectClient(client: MasterOpsEditClient) {
    patchForm({
      selectedClientId: client.id,
      client,
      invoiceCompanyName: client.billingCompanyName,
      invoiceTaxId: client.billingTaxId,
      invoiceAddress: client.billingAddress,
      invoicePhone: client.billingPhone,
      deliveryNoteName: client.deliveryNoteName,
      deliveryNoteDocumentId: client.deliveryNoteDocumentId,
      deliveryNoteAddress: client.deliveryNoteAddress,
      deliveryNotePhone: client.deliveryNotePhone,
    });
    setNewClientName(client.fullName);
    setNewClientPhone(client.phone);
    setNewClientType(client.clientType);
    setClientSearch("");
    setClientResults([]);
  }

  function useNewClient() {
    patchForm({ selectedClientId: null, client: null });
    setClientSearch("");
    setClientResults([]);
  }

  function selectProduct(product: MasterOpsEditCatalogItem) {
    setSelectedProductId(product.id);
    setProductSearch(product.name);
    setError(null);
    window.setTimeout(() => {
      productQtyRef.current?.focus();
      productQtyRef.current?.select();
    }, 0);
  }

  function updateProductSearch(value: string) {
    setProductSearch(value);
    const query = normalizeSearchValue(value);
    if (!query) {
      setSelectedProductId("");
      return;
    }
    const firstMatch =
      (data?.catalogItems ?? [])
        .filter((item) => item.isActive)
        .find((item) => normalizeSearchValue(`${item.name} ${item.sku ?? ""}`).includes(query)) ?? null;
    setSelectedProductId(firstMatch?.id ?? "");
  }

  function openConfig(product: MasterOpsEditCatalogItem, editingItem?: MasterOpsEditOrderItem | null) {
    const components = componentsByParentId.get(product.id) ?? [];
    const parsed = editingItem ? parseEditableDetailLines(editingItem.editableDetailLines) : { alias: "", selections: [] };
    const editableComponents = components.filter(
      (component) =>
        component.componentMode === "selectable" ||
        (component.componentMode === "fixed" && !component.isRequired)
    );
    const selections: ConfigSelection[] = [];

    if (editingItem) {
      for (const parsedRow of parsed.selections) {
        const match =
          (parsedRow.componentProductId != null
            ? editableComponents.find((component) => component.componentProductId === parsedRow.componentProductId)
            : null) ??
          editableComponents.find(
            (component) =>
              component.componentName.trim().toLowerCase() === parsedRow.componentName.trim().toLowerCase()
          );
        if (!match) continue;
        selections.push({
          localId: String(match.componentProductId),
          componentProductId: match.componentProductId,
          componentName: match.componentName,
          qty: parsedRow.qty,
        });
      }
    } else {
      for (const component of components) {
        if (component.componentMode === "fixed" && !component.isRequired && component.quantity > 0) {
          selections.push({
            localId: String(component.componentProductId),
            componentProductId: component.componentProductId,
            componentName: component.componentName,
            qty: component.quantity,
          });
        }
      }
    }

    setConfigState({
      editingLocalId: editingItem?.localId ?? null,
      productId: product.id,
      productName: editingItem?.productNameSnapshot ?? product.name,
      sku: editingItem?.skuSnapshot ?? product.sku,
      qty: editingItem?.qty ?? 1,
      sourcePriceCurrency: editingItem?.sourcePriceCurrency ?? product.sourcePriceCurrency,
      sourcePriceAmount: editingItem?.sourcePriceAmount ?? product.sourcePriceAmount,
      fallbackUnitUsd: editingItem?.unitPriceUsdSnapshot ?? product.basePriceUsd,
      detailUnitsLimit: product.detailUnitsLimit,
      alias: parsed.alias,
      selections,
    });
  }

  function addProduct() {
    if (!form) return;
    const productId = Number(selectedProductId || 0);
    const product = catalogById.get(productId);
    const qty = toNumber(productQty, 0);

    if (!product) {
      setError("Selecciona un producto.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("La cantidad debe ser mayor a 0.");
      return;
    }
    if (product.isDetailEditable) {
      if (qty !== 1) {
        setError("Los productos configurables se cargan uno por uno.");
        return;
      }
      openConfig(product, null);
      setProductSearch("");
      setSelectedProductId("");
      setProductQty("1");
      return;
    }

    const snapshot = calculateOrderLineSnapshot({
      sourceCurrency: product.sourcePriceCurrency,
      sourceAmount: product.sourcePriceAmount,
      quantity: qty,
      fxRate,
      fallbackUnitUsd: product.basePriceUsd,
    });
    const detailLines = buildComponentDetailLines(componentsByParentId.get(product.id) ?? [], {
      totalMultiplier: qty,
    });

    patchForm({
      items: [
        ...form.items,
        {
          localId: `${Date.now()}-${Math.random()}`,
          productId: product.id,
          skuSnapshot: product.sku,
          productNameSnapshot: product.name,
          qty,
          sourcePriceCurrency: product.sourcePriceCurrency,
          sourcePriceAmount: product.sourcePriceAmount,
          unitPriceUsdSnapshot: snapshot.unitUsd,
          lineTotalUsd: snapshot.lineUsd,
          editableDetailLines: detailLines,
          adminPriceOverrideUsd: null,
          adminPriceOverrideCurrency: null,
          adminPriceOverrideReason: null,
          adminPriceOverrideByUserId: null,
          adminPriceOverrideAt: null,
        },
      ],
    });
    setProductSearch("");
    setSelectedProductId("");
    setProductQty("1");
    setError(null);
  }

  const configSelectedUnits = useMemo(() => {
    if (!configState) return 0;
    const componentById = new Map(
      (componentsByParentId.get(configState.productId) ?? []).map((component) => [
        component.componentProductId,
        component,
      ] as const)
    );
    return configState.selections.reduce((sum, selection) => {
      const component = componentById.get(selection.componentProductId);
      if (component && !component.countsTowardDetailLimit) return sum;
      return sum + Number(selection.qty || 0);
    }, 0);
  }, [componentsByParentId, configState]);

  function updateConfigSelection(component: MasterOpsEditProductComponent, qtyInput: number) {
    if (!configState) return;
    const qty = Math.max(0, Math.floor(Number(qtyInput || 0)));
    setConfigState((current) => {
      if (!current) return current;
      const others = current.selections.filter(
        (selection) => selection.componentProductId !== component.componentProductId
      );
      if (qty <= 0) return { ...current, selections: others };
      return {
        ...current,
        selections: [
          ...others,
          {
            localId: String(component.componentProductId),
            componentProductId: component.componentProductId,
            componentName: component.componentName,
            qty,
          },
        ],
      };
    });
  }

  function saveConfig() {
    if (!form || !configState) return;
    if (configState.detailUnitsLimit > 0 && configSelectedUnits !== configState.detailUnitsLimit) {
      setError(`Debes seleccionar exactamente ${configState.detailUnitsLimit} piezas.`);
      return;
    }

    const selectedByProductId = new Map(
      configState.selections
        .filter((selection) => selection.qty > 0)
        .map((selection) => [selection.componentProductId, selection.qty] as const)
    );
    const detailLines = [
      ...(configState.alias.trim() ? [`Para: ${configState.alias.trim()}`] : []),
      ...buildComponentDetailLines(componentsByParentId.get(configState.productId) ?? [], {
        selectedByProductId,
        includeMetadata: true,
      }),
    ];
    const snapshot = calculateOrderLineSnapshot({
      sourceCurrency: configState.sourcePriceCurrency,
      sourceAmount: configState.sourcePriceAmount,
      quantity: configState.qty,
      fxRate,
      fallbackUnitUsd: configState.fallbackUnitUsd,
    });
    const existingItem = configState.editingLocalId
      ? form.items.find((item) => item.localId === configState.editingLocalId) ?? null
      : null;
    const nextItem: MasterOpsEditOrderItem = {
      localId: configState.editingLocalId ?? `${Date.now()}-${Math.random()}`,
      productId: configState.productId,
      skuSnapshot: configState.sku,
      productNameSnapshot: configState.productName,
      qty: configState.qty,
      sourcePriceCurrency: existingItem?.adminPriceOverrideCurrency
        ? existingItem.sourcePriceCurrency
        : configState.sourcePriceCurrency,
      sourcePriceAmount: existingItem?.adminPriceOverrideCurrency
        ? existingItem.sourcePriceAmount
        : configState.sourcePriceAmount,
      unitPriceUsdSnapshot: existingItem?.adminPriceOverrideCurrency
        ? recalculateItem(existingItem, fxRate).unitPriceUsdSnapshot
        : snapshot.unitUsd,
      lineTotalUsd: existingItem?.adminPriceOverrideCurrency
        ? recalculateItem(existingItem, fxRate).lineTotalUsd
        : snapshot.lineUsd,
      editableDetailLines: detailLines,
      adminPriceOverrideUsd: existingItem?.adminPriceOverrideUsd ?? null,
      adminPriceOverrideCurrency: existingItem?.adminPriceOverrideCurrency ?? null,
      adminPriceOverrideReason: existingItem?.adminPriceOverrideReason ?? null,
      adminPriceOverrideByUserId: existingItem?.adminPriceOverrideByUserId ?? null,
      adminPriceOverrideAt: existingItem?.adminPriceOverrideAt ?? null,
    };

    patchForm({
      items: configState.editingLocalId
        ? form.items.map((item) => (item.localId === configState.editingLocalId ? nextItem : item))
        : [...form.items, nextItem],
    });
    setConfigState(null);
    setError(null);
  }

  function updateItemOverride(item: MasterOpsEditOrderItem, currency: MasterOpsEditCurrency, rawValue: string) {
    const amount = toNumber(rawValue, Number.NaN);
    if (!Number.isFinite(amount) || amount < 0) return;
    const unitUsd = currency === "VES" && fxRate > 0 ? amount / fxRate : amount;
    const snapshot = calculateOrderLineSnapshot({
      sourceCurrency: currency,
      sourceAmount: amount,
      quantity: item.qty,
      fxRate,
      fallbackUnitUsd: item.unitPriceUsdSnapshot,
    });
    patchItem(item.localId, {
      sourcePriceCurrency: currency,
      sourcePriceAmount: amount,
      unitPriceUsdSnapshot: snapshot.unitUsd,
      lineTotalUsd: snapshot.lineUsd,
      adminPriceOverrideUsd: unitUsd,
      adminPriceOverrideCurrency: currency,
      adminPriceOverrideReason: item.adminPriceOverrideReason || "Ajuste administrativo",
    });
  }

  async function saveOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    if (!canSave) {
      setError("Faltan datos obligatorios para guardar.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const itemsPayload = orderedItems.map((item) => recalculateItem(item, fxRate));
      const orderPayload = {
        source: form.source,
        attributedAdvisorUserId: form.source === "advisor" ? form.attributedAdvisorUserId : null,
        fulfillment: form.fulfillment,
        selectedClientId: form.selectedClientId,
        newClientName: form.selectedClientId ? "" : newClientName,
        newClientPhone: form.selectedClientId ? "" : newClientPhone,
        newClientType,
        deliveryDate: form.deliveryDate,
        deliveryHour12: form.deliveryHour12,
        deliveryMinute: form.deliveryMinute,
        deliveryAmPm: form.deliveryAmPm,
        isAsap: form.isAsap,
        receiverName: form.receiverName,
        receiverPhone: form.receiverPhone,
        deliveryAddress: form.deliveryAddress,
        deliveryGpsUrl: form.deliveryGpsUrl,
        note: form.note,
        discountEnabled: form.discountEnabled,
        discountPct: form.discountPct,
        invoiceTaxPct: form.invoiceTaxPct,
        fxRate: form.fxRate,
        paymentMethod: form.paymentMethod,
        paymentCurrency: form.paymentCurrency,
        paymentRequiresChange: form.paymentRequiresChange,
        paymentChangeFor: form.paymentChangeFor,
        paymentChangeCurrency: form.paymentChangeCurrency,
        paymentNote: form.paymentNote,
        useClientFund: form.useClientFund,
        clientFundAmountUsd: form.useClientFund ? form.clientFundAmountUsd : "",
        hasDeliveryNote: form.hasDeliveryNote,
        hasInvoice: form.hasInvoice,
        invoiceDataNote: [
          form.invoiceCompanyName,
          form.invoiceTaxId,
          form.invoiceAddress,
          form.invoicePhone,
        ]
          .filter(Boolean)
          .join(" | "),
        invoiceCompanyName: form.invoiceCompanyName,
        invoiceTaxId: form.invoiceTaxId,
        invoiceAddress: form.invoiceAddress,
        invoicePhone: form.invoicePhone,
        deliveryNoteName: form.deliveryNoteName,
        deliveryNoteDocumentId: form.deliveryNoteDocumentId,
        deliveryNoteAddress: form.deliveryNoteAddress,
        deliveryNotePhone: form.deliveryNotePhone,
        items: itemsPayload.map((item) => ({
          productId: item.productId,
          skuSnapshot: item.skuSnapshot,
          productNameSnapshot: item.productNameSnapshot,
          qty: item.qty,
          sourcePriceCurrency: item.sourcePriceCurrency,
          sourcePriceAmount: item.sourcePriceAmount,
          unitPriceUsdSnapshot: item.unitPriceUsdSnapshot,
          lineTotalUsd: item.lineTotalUsd,
          editableDetailLines: item.editableDetailLines,
          adminPriceOverrideUsd: item.adminPriceOverrideUsd,
          adminPriceOverrideCurrency: item.adminPriceOverrideCurrency,
          adminPriceOverrideReason: item.adminPriceOverrideReason,
        })),
      };
      const result = isCreateMode
        ? await createOrderAction(orderPayload)
        : await updateOrderAction({
            orderId: form.id,
            expectedLastModifiedAt: form.lastModifiedAtISO,
            ...orderPayload,
            adminEditReason: isAdvancedOrderEdit ? adminEditReason.trim() : null,
          });

      if (result && "ok" in result && !result.ok) {
        setError(result.message);
        return;
      }

      setSuccess(isCreateMode ? "Orden creada." : "Orden actualizada.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la orden.");
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[80] bg-black/70">
      <div className="ml-auto flex h-full w-full max-w-[1180px] flex-col border-l border-[#242433] bg-[#0B0B0D] text-[#F5F5F7] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#242433] px-5 py-3">
          <div>
            <div className="text-lg font-semibold">
              {isCreateMode
                ? "Nuevo pedido"
                : form
                  ? `Modificar orden #${formatOrderDisplayNumber(form.id)}`
                  : "Modificar orden"}
            </div>
            <div className="mt-0.5 text-xs text-[#8A8A96]">
              {isCreateMode
                ? "Crea una orden desde el modulo master con la logica canonica."
                : "Editor operativo del modulo master. Carga datos solo para esta orden."}
            </div>
          </div>
          <button
            className="rounded-xl border border-[#242433] bg-[#121218] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50"
            type="button"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[#B7B7C2]">Cargando editor...</div>
        ) : null}

        {!loading && form ? (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={saveOrder}>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="grid gap-4 xl:grid-cols-[0.95fr_1.25fr]">
                <div className="space-y-4">
                  <Section title="Cliente y origen">
                    <div className="grid gap-3">
                      {form.selectedClientId && form.client ? (
                        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-sm font-semibold text-[#F5F5F7]">{form.client.fullName}</div>
                              <div className="mt-1 text-xs text-[#B7B7C2]">{form.client.phone || "Sin telefono"}</div>
                              <div className="mt-1 text-xs text-emerald-200">
                                Fondo {money(form.client.fundBalanceUsd)}
                              </div>
                            </div>
                            <button
                              className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-2 py-1 text-xs text-[#F5F5F7]"
                              type="button"
                              onClick={useNewClient}
                            >
                              Cambiar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-[#FEEF00]/25 bg-[#FEEF00]/10 p-3">
                          <div className="text-xs font-semibold text-[#FEEF00]">Cliente nuevo o sin seleccionar</div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <input
                              className={fieldClass()}
                              value={newClientName}
                              onChange={(event) => setNewClientName(event.target.value)}
                              placeholder="Nombre"
                            />
                            <input
                              className={fieldClass()}
                              value={newClientPhone}
                              onChange={(event) => setNewClientPhone(event.target.value)}
                              placeholder="Telefono"
                            />
                          </div>
                          <select
                            className={`${fieldClass()} mt-2`}
                            value={newClientType}
                            onChange={(event) => setNewClientType(event.target.value as "assigned" | "own" | "legacy")}
                          >
                            <option value="assigned">Asignado</option>
                            <option value="own">Propio</option>
                            <option value="legacy">Antiguo</option>
                          </select>
                        </div>
                      )}

                      <Field label="Buscar cliente">
                        <input
                          className={fieldClass()}
                          value={clientSearch}
                          onChange={(event) => setClientSearch(event.target.value)}
                          placeholder="Nombre o telefono"
                        />
                      </Field>
                      {clientSearch.trim().length >= 2 ? (
                        <div className="rounded-xl border border-[#242433] bg-[#0B0B0D]">
                          {clientSearching ? (
                            <div className="px-3 py-2 text-xs text-[#8A8A96]">Buscando...</div>
                          ) : null}
                          {!clientSearching && clientResults.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-[#8A8A96]">Sin resultados.</div>
                          ) : null}
                          {clientResults.map((client) => (
                            <button
                              key={client.id}
                              className="block w-full border-t border-[#181824] px-3 py-2 text-left text-sm hover:bg-[#121218]"
                              type="button"
                              onClick={() => selectClient(client)}
                            >
                              <span className="font-semibold text-[#F5F5F7]">{client.fullName}</span>
                              <span className="ml-2 text-xs text-[#8A8A96]">{client.phone}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Origen">
                          <select
                            className={fieldClass()}
                            value={form.source}
                            onChange={(event) =>
                              patchForm({ source: event.target.value as "advisor" | "master" | "walk_in" })
                            }
                          >
                            <option value="advisor">Asesor</option>
                            <option value="master">Master</option>
                            <option value="walk_in">Mostrador</option>
                          </select>
                        </Field>
                        {form.source === "advisor" ? (
                          <Field label="Asesor">
                            <select
                              className={fieldClass()}
                              value={form.attributedAdvisorUserId ?? ""}
                              onChange={(event) => patchForm({ attributedAdvisorUserId: event.target.value || null })}
                            >
                              <option value="">Selecciona asesor</option>
                              {(data?.advisors ?? []).map((advisor: MasterOpsEditAdvisor) => (
                                <option key={advisor.id} value={advisor.id}>
                                  {advisor.fullName}
                                </option>
                              ))}
                            </select>
                          </Field>
                        ) : null}
                      </div>
                    </div>
                  </Section>

                  <Section title="Entrega">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Tipo">
                        <select
                          className={fieldClass()}
                          value={form.fulfillment}
                          onChange={(event) => patchForm({ fulfillment: event.target.value as "pickup" | "delivery" })}
                        >
                          <option value="pickup">Pickup</option>
                          <option value="delivery">Delivery</option>
                        </select>
                      </Field>
                      <Field label="Fecha">
                        <input
                          className={fieldClass()}
                          type="date"
                          value={form.deliveryDate}
                          onChange={(event) => patchForm({ deliveryDate: event.target.value })}
                        />
                      </Field>
                      <Field label="Hora">
                        <div className="grid grid-cols-[1fr_1fr_0.8fr] gap-2">
                          <input
                            className={fieldClass()}
                            value={form.deliveryHour12}
                            onChange={(event) => patchForm({ deliveryHour12: event.target.value })}
                            inputMode="numeric"
                          />
                          <input
                            className={fieldClass()}
                            value={form.deliveryMinute}
                            onChange={(event) => patchForm({ deliveryMinute: event.target.value })}
                            inputMode="numeric"
                          />
                          <select
                            className={fieldClass()}
                            value={form.deliveryAmPm}
                            onChange={(event) => patchForm({ deliveryAmPm: event.target.value as "AM" | "PM" })}
                          >
                            <option value="AM">AM</option>
                            <option value="PM">PM</option>
                          </select>
                        </div>
                      </Field>
                      <label className="flex items-end gap-2 pb-2 text-sm text-[#F5F5F7]">
                        <input
                          className="accent-[#FEEF00]"
                          type="checkbox"
                          checked={form.isAsap}
                          onChange={(event) => patchForm({ isAsap: event.target.checked })}
                        />
                        Lo antes posible
                      </label>
                      <Field label="Recibe">
                        <input
                          className={fieldClass()}
                          value={form.receiverName}
                          onChange={(event) => patchForm({ receiverName: event.target.value })}
                          placeholder="Solo si recibe otra persona"
                        />
                      </Field>
                      <Field label="Telefono recibe">
                        <input
                          className={fieldClass()}
                          value={form.receiverPhone}
                          onChange={(event) => patchForm({ receiverPhone: event.target.value })}
                          placeholder="Opcional"
                        />
                      </Field>
                      {form.fulfillment === "delivery" ? (
                        <>
                          <Field label="Direccion" className="sm:col-span-2">
                            <textarea
                              className={`${fieldClass()} min-h-[74px]`}
                              value={form.deliveryAddress}
                              onChange={(event) => patchForm({ deliveryAddress: event.target.value })}
                              placeholder="Direccion completa"
                            />
                          </Field>
                          <Field label="GPS" className="sm:col-span-2">
                            <input
                              className={fieldClass()}
                              value={form.deliveryGpsUrl}
                              onChange={(event) => patchForm({ deliveryGpsUrl: event.target.value })}
                              placeholder="Link de ubicacion"
                            />
                          </Field>
                        </>
                      ) : null}
                      <Field label="Nota del pedido" className="sm:col-span-2">
                        <textarea
                          className={`${fieldClass()} min-h-[74px]`}
                          value={form.note}
                          onChange={(event) => patchForm({ note: event.target.value })}
                          placeholder="Notas de preparacion, empaque o entrega"
                        />
                      </Field>
                    </div>
                  </Section>

                  <Section title="Pago y documentos">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Metodo">
                        <select
                          className={fieldClass()}
                          value={form.paymentMethod}
                          onChange={(event) => patchForm({ paymentMethod: event.target.value })}
                        >
                          <option value="">Sin definir</option>
                          {PAYMENT_METHODS.map((method) => (
                            <option key={method} value={method}>
                              {getPaymentMethodLabel(method) || method}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Moneda">
                        <select
                          className={fieldClass()}
                          value={form.paymentCurrency}
                          onChange={(event) => patchForm({ paymentCurrency: event.target.value as MasterOpsEditCurrency })}
                        >
                          <option value="USD">USD</option>
                          <option value="VES">VES</option>
                        </select>
                      </Field>
                      <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
                        <input
                          className="accent-[#FEEF00]"
                          type="checkbox"
                          checked={form.paymentRequiresChange}
                          onChange={(event) => patchForm({ paymentRequiresChange: event.target.checked })}
                        />
                        Requiere cambio
                      </label>
                      {form.paymentRequiresChange ? (
                        <div className="grid grid-cols-[1fr_0.7fr] gap-2">
                          <input
                            className={fieldClass()}
                            value={form.paymentChangeFor}
                            onChange={(event) => patchForm({ paymentChangeFor: event.target.value })}
                            placeholder="Cambio para"
                            inputMode="decimal"
                          />
                          <select
                            className={fieldClass()}
                            value={form.paymentChangeCurrency}
                            onChange={(event) =>
                              patchForm({ paymentChangeCurrency: event.target.value as MasterOpsEditCurrency })
                            }
                          >
                            <option value="USD">USD</option>
                            <option value="VES">VES</option>
                          </select>
                        </div>
                      ) : null}
                      <Field label="Nota pago" className="sm:col-span-2">
                        <input
                          className={fieldClass()}
                          value={form.paymentNote}
                          onChange={(event) => patchForm({ paymentNote: event.target.value })}
                          placeholder="Banco, referencia esperada, cambio, etc."
                        />
                      </Field>
                      <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
                        <input
                          className="accent-[#FEEF00]"
                          type="checkbox"
                          checked={form.hasDeliveryNote}
                          onChange={(event) => patchForm({ hasDeliveryNote: event.target.checked })}
                        />
                        Nota de entrega
                      </label>
                      <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
                        <input
                          className="accent-[#FEEF00]"
                          type="checkbox"
                          checked={form.hasInvoice}
                          onChange={(event) => patchForm({ hasInvoice: event.target.checked })}
                        />
                        Factura
                      </label>
                      {form.hasDeliveryNote ? (
                        <div className="grid gap-2 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 sm:col-span-2 sm:grid-cols-2">
                          <input className={fieldClass()} value={form.deliveryNoteName} onChange={(event) => patchForm({ deliveryNoteName: event.target.value })} placeholder="Nombre nota" />
                          <input className={fieldClass()} value={form.deliveryNoteDocumentId} onChange={(event) => patchForm({ deliveryNoteDocumentId: event.target.value })} placeholder="Documento" />
                          <input className={fieldClass()} value={form.deliveryNoteAddress} onChange={(event) => patchForm({ deliveryNoteAddress: event.target.value })} placeholder="Direccion" />
                          <input className={fieldClass()} value={form.deliveryNotePhone} onChange={(event) => patchForm({ deliveryNotePhone: event.target.value })} placeholder="Telefono" />
                        </div>
                      ) : null}
                      {form.hasInvoice ? (
                        <div className="grid gap-2 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 sm:col-span-2 sm:grid-cols-2">
                          <input className={fieldClass()} value={form.invoiceCompanyName} onChange={(event) => patchForm({ invoiceCompanyName: event.target.value })} placeholder="Razon social" />
                          <input className={fieldClass()} value={form.invoiceTaxId} onChange={(event) => patchForm({ invoiceTaxId: event.target.value })} placeholder="RIF/CI" />
                          <input className={fieldClass()} value={form.invoiceAddress} onChange={(event) => patchForm({ invoiceAddress: event.target.value })} placeholder="Direccion fiscal" />
                          <input className={fieldClass()} value={form.invoicePhone} onChange={(event) => patchForm({ invoicePhone: event.target.value })} placeholder="Telefono" />
                          <input className={fieldClass("sm:col-span-2")} value={form.invoiceTaxPct} onChange={(event) => patchForm({ invoiceTaxPct: event.target.value })} placeholder="% IVA" inputMode="decimal" />
                        </div>
                      ) : null}
                    </div>
                  </Section>
                </div>

                <div className="space-y-4">
                  <Section
                    title="Pedido"
                    aside={
                      <div className="text-right text-xs text-[#B7B7C2]">
                        <div>{orderedItems.length} item(s)</div>
                        <div className="font-semibold text-[#FEEF00]">{money(totals.totalUsd)} / {bs(totals.totalBs)}</div>
                      </div>
                    }
                  >
                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_84px_92px]">
                      <div className="relative">
                        <input
                          className={fieldClass()}
                          value={productSearch}
                          onChange={(event) => updateProductSearch(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            const product = filteredProducts[0];
                            if (!product) return;
                            event.preventDefault();
                            selectProduct(product);
                          }}
                          placeholder="Buscar producto"
                        />
                        {productSearch.trim() ? (
                          <div className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-[#242433] bg-[#0B0B0D] shadow-2xl">
                            {filteredProducts.length > 0 ? (
                              filteredProducts.map((product) => {
                                const isSelected = selectedProductId === product.id;
                                return (
                                  <button
                                    key={product.id}
                                    className={[
                                      "block w-full border-b border-[#181824] px-3 py-2 text-left text-sm last:border-b-0 hover:bg-[#121218]",
                                      isSelected ? "bg-[#FEEF00]/10 text-[#FEEF00]" : "text-[#F5F5F7]",
                                    ].join(" ")}
                                    type="button"
                                    onClick={() => selectProduct(product)}
                                  >
                                    <span className="font-semibold">{product.name}</span>
                                    <span className="ml-2 text-xs text-[#8A8A96]">{product.sku || "Sin SKU"}</span>
                                    <span className="float-right text-xs text-[#B7B7C2]">
                                      {product.sourcePriceCurrency === "VES"
                                        ? bs(product.sourcePriceAmount)
                                        : money(product.sourcePriceAmount)}
                                    </span>
                                  </button>
                                );
                              })
                            ) : (
                              <div className="px-3 py-2 text-xs text-[#8A8A96]">Sin productos activos para esa busqueda.</div>
                            )}
                          </div>
                        ) : null}
                        {selectedProduct ? (
                          <div className="mt-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                            Seleccionado: <span className="font-semibold">{selectedProduct.name}</span>
                          </div>
                        ) : (
                          <div className="mt-2 text-xs text-[#8A8A96]">
                            Busca por nombre o SKU. Solo aparecen productos activos.
                          </div>
                        )}
                      </div>
                      <input
                        ref={productQtyRef}
                        className={fieldClass()}
                        value={productQty}
                        onChange={(event) => setProductQty(event.target.value)}
                        inputMode="decimal"
                        placeholder="Cant."
                      />
                      <button
                        className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-[#0B0B0D] disabled:opacity-50"
                        type="button"
                        onClick={addProduct}
                      >
                        Agregar
                      </button>
                    </div>

                    <div className="mt-4 space-y-2">
                      {orderedItems.map((item) => {
                        const product = catalogById.get(item.productId);
                        const visibleDetailLines = getVisibleEditableDetailLines(item.editableDetailLines);
                        const itemUnitBs = fxRate > 0 ? item.unitPriceUsdSnapshot * fxRate : 0;
                        return (
                          <div key={itemKey(item.localId)} className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
                            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_82px_120px_auto] md:items-start">
                              <div className="min-w-0">
                                <div className="font-semibold text-[#F5F5F7]">
                                  {item.qty} {item.productNameSnapshot}
                                </div>
                                <div className="mt-1 text-xs text-[#8A8A96]">
                                  Unit. {money(item.unitPriceUsdSnapshot)} / {bs(itemUnitBs)}
                                </div>
                                {visibleDetailLines.length > 0 ? (
                                  <div className="mt-2 space-y-1 border-l border-[#242433] pl-3 text-sm text-[#D8D8DE]">
                                    {visibleDetailLines.map((line) => (
                                      <div key={line}>- {line}</div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                              <input
                                className={fieldClass()}
                                value={String(item.qty)}
                                onChange={(event) => patchItem(item.localId, { qty: toNumber(event.target.value, item.qty) })}
                                inputMode="decimal"
                              />
                              <div className="text-sm font-semibold text-[#F5F5F7]">
                                {money(item.lineTotalUsd)}
                                <div className="mt-1 text-xs font-normal text-[#8A8A96]">{bs(item.lineTotalUsd * fxRate)}</div>
                              </div>
                              <div className="flex flex-wrap gap-2 md:justify-end">
                                {product?.isDetailEditable ? (
                                  <button
                                    className="rounded-lg border border-[#242433] px-2 py-1 text-xs text-[#F5F5F7] hover:border-[#FEEF00]/50"
                                    type="button"
                                    onClick={() => openConfig(product, item)}
                                  >
                                    Config.
                                  </button>
                                ) : null}
                                <button
                                  className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-200"
                                  type="button"
                                  onClick={() => removeItem(item.localId)}
                                >
                                  Quitar
                                </button>
                              </div>
                            </div>

                            {isAdmin ? (
                              <details className="mt-3 rounded-lg border border-[#242433] bg-[#121218] p-2">
                                <summary className="cursor-pointer text-xs font-semibold text-[#B7B7C2]">
                                  Ajuste admin de precio
                                </summary>
                                <div className="mt-2 grid gap-2 md:grid-cols-[1fr_1fr_minmax(0,1.3fr)_auto]">
                                  <input
                                    className={fieldClass()}
                                    value={item.sourcePriceCurrency === "USD" ? compact(item.sourcePriceAmount, 6) : compact(item.unitPriceUsdSnapshot, 6)}
                                    onChange={(event) => updateItemOverride(item, "USD", event.target.value)}
                                    inputMode="decimal"
                                    placeholder="USD unit."
                                  />
                                  <input
                                    className={fieldClass()}
                                    value={item.sourcePriceCurrency === "VES" ? compact(item.sourcePriceAmount, 2) : compact(item.unitPriceUsdSnapshot * fxRate, 2)}
                                    onChange={(event) => updateItemOverride(item, "VES", event.target.value)}
                                    inputMode="decimal"
                                    placeholder="Bs unit."
                                  />
                                  <input
                                    className={fieldClass()}
                                    value={item.adminPriceOverrideReason ?? ""}
                                    onChange={(event) => patchItem(item.localId, { adminPriceOverrideReason: event.target.value })}
                                    placeholder="Motivo"
                                  />
                                  <button
                                    className="rounded-xl border border-[#242433] px-3 py-2 text-xs text-[#B7B7C2]"
                                    type="button"
                                    onClick={() => {
                                      const productBase = catalogById.get(item.productId);
                                      if (!productBase) return;
                                      const snapshot = calculateOrderLineSnapshot({
                                        sourceCurrency: productBase.sourcePriceCurrency,
                                        sourceAmount: productBase.sourcePriceAmount,
                                        quantity: item.qty,
                                        fxRate,
                                        fallbackUnitUsd: productBase.basePriceUsd,
                                      });
                                      patchItem(item.localId, {
                                        sourcePriceCurrency: productBase.sourcePriceCurrency,
                                        sourcePriceAmount: productBase.sourcePriceAmount,
                                        unitPriceUsdSnapshot: snapshot.unitUsd,
                                        lineTotalUsd: snapshot.lineUsd,
                                        adminPriceOverrideUsd: null,
                                        adminPriceOverrideCurrency: null,
                                        adminPriceOverrideReason: null,
                                      });
                                    }}
                                  >
                                    Limpiar
                                  </button>
                                </div>
                              </details>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </Section>

                  <Section title="Totales">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Tasa snapshot">
                        <input
                          className={fieldClass()}
                          value={form.fxRate}
                          onChange={(event) => patchForm({ fxRate: event.target.value })}
                          inputMode="decimal"
                        />
                      </Field>
                      <label className="flex items-end gap-2 pb-2 text-sm text-[#F5F5F7]">
                        <input
                          className="accent-[#FEEF00]"
                          type="checkbox"
                          checked={form.discountEnabled}
                          onChange={(event) => patchForm({ discountEnabled: event.target.checked })}
                        />
                        Descuento
                      </label>
                      {form.discountEnabled ? (
                        <Field label="% descuento">
                          <input
                            className={fieldClass()}
                            value={form.discountPct}
                            onChange={(event) => patchForm({ discountPct: event.target.value })}
                            inputMode="decimal"
                          />
                        </Field>
                      ) : null}
                    </div>
                    <div className="mt-4 grid gap-2 text-sm">
                      <div className="flex justify-between border-b border-[#242433] pb-2">
                        <span className="text-[#B7B7C2]">Subtotal</span>
                        <span>{money(totals.subtotalAfterDiscountUsd + totals.discountAmountUsd)} / {bs(totals.subtotalAfterDiscountBs + totals.discountAmountBs)}</span>
                      </div>
                      {form.discountEnabled ? (
                        <div className="flex justify-between border-b border-[#242433] pb-2 text-[#FEEF00]">
                          <span>Descuento</span>
                          <span>-{money(totals.discountAmountUsd)} / -{bs(totals.discountAmountBs)}</span>
                        </div>
                      ) : null}
                      {form.hasInvoice ? (
                        <div className="flex justify-between border-b border-[#242433] pb-2">
                          <span className="text-[#B7B7C2]">IVA</span>
                          <span>{money(totals.invoiceTaxAmountUsd)} / {bs(totals.invoiceTaxAmountBs)}</span>
                        </div>
                      ) : null}
                      <div className="flex justify-between text-base font-semibold">
                        <span>Total</span>
                        <span>{money(totals.totalUsd)} / {bs(totals.totalBs)}</span>
                      </div>
                    </div>
                  </Section>

                  {isAdvancedOrderEdit ? (
                    <Section title="Motivo de modificacion">
                      <textarea
                        className={`${fieldClass()} min-h-[74px] border-orange-500/30`}
                        value={adminEditReason}
                        onChange={(event) => setAdminEditReason(event.target.value)}
                        placeholder="Obligatorio porque la orden ya avanzo en el flujo."
                      />
                    </Section>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="shrink-0 border-t border-[#242433] bg-[#0B0B0D] px-5 py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-h-5 text-sm">
                  {error ? <span className="text-red-300">{error}</span> : null}
                  {success ? <span className="text-emerald-300">{success}</span> : null}
                  {!error && !success ? <span className="text-[#8A8A96]">Se guarda con la logica canonica de ordenes.</span> : null}
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    className="rounded-xl border border-[#242433] bg-[#121218] px-4 py-2 text-sm font-semibold text-[#F5F5F7]"
                    type="button"
                    onClick={onClose}
                    disabled={saving}
                  >
                    Cancelar
                  </button>
                  <button
                    className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-5 py-2 text-sm font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                    type="submit"
                    disabled={!canSave || saving}
                  >
                    {saving ? "Guardando..." : isCreateMode ? "Crear pedido" : "Guardar modificacion"}
                  </button>
                </div>
              </div>
            </div>
          </form>
        ) : null}

        {!loading && !form && error ? (
          <div className="m-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        ) : null}
      </div>

      {configState ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 px-4">
          <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[#242433] bg-[#121218] p-4 text-[#F5F5F7] shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold">Configurar {configState.productName}</div>
                <div className="mt-1 text-xs text-[#8A8A96]">
                  Piezas {configSelectedUnits} / {configState.detailUnitsLimit || "--"}
                </div>
              </div>
              <button
                className="rounded-xl border border-[#242433] px-3 py-2 text-sm text-[#F5F5F7]"
                type="button"
                onClick={() => setConfigState(null)}
              >
                Cerrar
              </button>
            </div>

            <div className="mt-4 grid gap-3">
              <Field label="Para">
                <input
                  className={fieldClass()}
                  value={configState.alias}
                  onChange={(event) => setConfigState((current) => current ? { ...current, alias: event.target.value } : current)}
                  placeholder="Nombre o referencia interna"
                />
              </Field>

              <div className="space-y-2">
                {(componentsByParentId.get(configState.productId) ?? [])
                  .filter(
                    (component) =>
                      component.componentMode === "selectable" ||
                      (component.componentMode === "fixed" && !component.isRequired)
                  )
                  .map((component) => {
                    const selection = configState.selections.find(
                      (row) => row.componentProductId === component.componentProductId
                    );
                    return (
                      <div
                        key={component.id}
                        className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3"
                      >
                        <div>
                          <div className="text-sm font-semibold">{component.componentName}</div>
                          <div className="mt-0.5 text-xs text-[#8A8A96]">
                            {component.countsTowardDetailLimit ? "Cuenta para limite" : "Extra"}
                          </div>
                        </div>
                        <input
                          className={fieldClass()}
                          value={selection?.qty ?? 0}
                          onChange={(event) => updateConfigSelection(component, Number(event.target.value))}
                          inputMode="numeric"
                        />
                      </div>
                    );
                  })}
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-xl border border-[#242433] px-4 py-2 text-sm font-semibold text-[#F5F5F7]"
                type="button"
                onClick={() => setConfigState(null)}
              >
                Cancelar
              </button>
              <button
                className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-5 py-2 text-sm font-semibold text-[#0B0B0D]"
                type="button"
                onClick={saveConfig}
              >
                Guardar configuracion
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
