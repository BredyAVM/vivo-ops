'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildComponentDetailLines,
  getVisibleEditableDetailLines,
} from '@/lib/orders/order-composer';
import {
  calculateOrderLineSnapshot,
  calculateOrderTotalsSnapshot,
} from '@/lib/pricing/order-snapshots';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import {
  searchCounterClientsAction,
  type CounterClientSearchResult,
} from './actions';
import type {
  CounterDirectSaleIntent,
  CounterDiscountRuleOption,
} from './direct-sale-contract';
import type {
  CounterQuickSaleProductComponent,
  CounterQuickSaleProductOption,
} from './CounterClient';
import { getCounterUiErrorMessage } from './ui-errors';

type CounterQuickSaleCartItem = {
  id: string;
  productId: number;
  qty: string;
  notes: string;
  editableDetailLines: string[];
};

type CounterProductAvailability = {
  product_id: number;
  availability_state: string;
  message: string;
  requires_master_review: boolean;
  inventory_blocks_submission: boolean;
};

const QUICK_SALE_PAYMENT_METHODS = [
  { code: 'pos', label: 'Punto' },
  { code: 'payment_mobile', label: 'Pago móvil' },
  { code: 'transfer', label: 'Transferencia' },
  { code: 'cash_usd', label: 'Efectivo USD' },
  { code: 'cash_ves', label: 'Efectivo Bs' },
  { code: 'zelle', label: 'Zelle' },
  { code: 'mixed', label: 'Mixto' },
];

function getQuickSalePaymentCurrency(method: string): 'USD' | 'VES' | null {
  if (method === 'mixed') return null;
  if (method === 'cash_usd' || method === 'zelle') return 'USD';
  return 'VES';
}

function getTodayKey() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function toDecimalInput(value: string) {
  return Number(String(value || '').replace(',', '.'));
}

function moneyUsd(value: number) {
  return `$${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function moneyBs(value: number) {
  return `Bs ${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function qtyLabel(value: number) {
  if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
  return value.toLocaleString('es-VE', { maximumFractionDigits: 2 });
}

function availabilityLabel(availability: CounterProductAvailability | null) {
  switch (availability?.availability_state) {
    case 'available': return 'Disponible';
    case 'low': return 'Quedan pocos';
    case 'unavailable': return 'Sin disponibilidad protegida';
    case 'declared_unavailable': return 'Venta detenida por Máster';
    case 'relies_on_incoming': return 'Depende de reposición';
    case 'outside_horizon': return 'Fuera de 10 días';
    case 'selection_required': return 'Depende de la selección';
    case 'not_tracked': return 'No inventariable';
    default: return availability ? 'Revisión de Máster' : 'Sin lectura';
  }
}

function availabilityTone(availability: CounterProductAvailability | null) {
  if (availability?.availability_state === 'available') {
    return 'border-emerald-400/35 bg-emerald-400/10 text-emerald-100';
  }
  if (availability?.availability_state === 'declared_unavailable') {
    return 'border-red-500/45 bg-red-500/10 text-red-100';
  }
  if (availability?.availability_state === 'not_tracked' || !availability) {
    return 'border-sky-400/30 bg-sky-400/10 text-sky-100';
  }
  return 'border-amber-300/35 bg-amber-300/10 text-amber-100';
}

function clientAdvisorLabel(client: CounterClientSearchResult) {
  if (!client.advisorName) return 'Sin asesor identificado';
  if (client.advisorSource === 'primary') return `Asesor habitual: ${client.advisorName}`;
  return `Ultimo asesor: ${client.advisorName}`;
}

function phoneMatchKey(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-7) : null;
}

function clientsMatchingPhone(
  key: string,
  clients: CounterClientSearchResult[]
) {
  return clients.filter((client) => phoneMatchKey(client.phone || '') === key);
}

export function CounterQuickSalePanel({
  products,
  productComponents,
  discountRules,
  activeBsRate,
  isWorking,
  onCancel,
  onSubmit,
}: {
  products: CounterQuickSaleProductOption[];
  productComponents: CounterQuickSaleProductComponent[];
  discountRules: CounterDiscountRuleOption[];
  activeBsRate: number;
  isWorking: boolean;
  onCancel: () => void;
  onSubmit: (input: CounterDirectSaleIntent) => void;
}) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [clientSearch, setClientSearch] = useState('');
  const [clientSearchResults, setClientSearchResults] = useState<CounterClientSearchResult[]>([]);
  const [clientSearchLoading, setClientSearchLoading] = useState(false);
  const [phoneLookupLoading, setPhoneLookupLoading] = useState(false);
  const [phoneLookup, setPhoneLookup] = useState<{
    key: string;
    clients: CounterClientSearchResult[];
  } | null>(null);
  const phoneLookupRequestRef = useRef(0);
  const [selectedClient, setSelectedClient] = useState<CounterClientSearchResult | null>(null);
  const [newClientMode, setNewClientMode] = useState(false);
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientType, setClientType] = useState<'own' | 'assigned' | 'legacy'>('own');
  const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>('pickup');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryGpsUrl, setDeliveryGpsUrl] = useState('');
  const [receiverIsDifferent, setReceiverIsDifferent] = useState(false);
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [note, setNote] = useState('');
  const [scheduleMode, setScheduleMode] = useState<'now' | 'scheduled'>('now');
  const [scheduledDate, setScheduledDate] = useState(getTodayKey());
  const [scheduledTime, setScheduledTime] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('pos');
  const [paymentCurrency, setPaymentCurrency] = useState<'USD' | 'VES'>('VES');
  const [paymentRequiresChange, setPaymentRequiresChange] = useState(false);
  const [paymentChangeFor, setPaymentChangeFor] = useState('');
  const [paymentChangeCurrency, setPaymentChangeCurrency] = useState<'USD' | 'VES'>('USD');
  const [paymentNote, setPaymentNote] = useState('');
  const [discountRuleId, setDiscountRuleId] = useState('');
  const [openPaymentAfterCreate, setOpenPaymentAfterCreate] = useState(true);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [hasDeliveryNote, setHasDeliveryNote] = useState(false);
  const [hasInvoice, setHasInvoice] = useState(false);
  const [invoiceTaxPct, setInvoiceTaxPct] = useState('16');
  const [invoiceDataNote, setInvoiceDataNote] = useState('');
  const [invoiceCompanyName, setInvoiceCompanyName] = useState('');
  const [invoiceTaxId, setInvoiceTaxId] = useState('');
  const [invoiceAddress, setInvoiceAddress] = useState('');
  const [invoicePhone, setInvoicePhone] = useState('');
  const [deliveryNoteName, setDeliveryNoteName] = useState('');
  const [deliveryNoteDocumentId, setDeliveryNoteDocumentId] = useState('');
  const [deliveryNoteAddress, setDeliveryNoteAddress] = useState('');
  const [deliveryNotePhone, setDeliveryNotePhone] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [itemNotes, setItemNotes] = useState('');
  const [cartItems, setCartItems] = useState<CounterQuickSaleCartItem[]>([]);
  const [availabilityByProductId, setAvailabilityByProductId] = useState<Map<number, CounterProductAvailability>>(new Map());
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [configProductId, setConfigProductId] = useState<number | null>(null);
  const [configAlias, setConfigAlias] = useState('');
  const [configSelections, setConfigSelections] = useState<Array<{
    localId: string;
    componentProductId: number;
    componentName: string;
    qty: number;
  }>>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const nextCurrency = getQuickSalePaymentCurrency(paymentMethod);
    if (nextCurrency) setPaymentCurrency(nextCurrency);
  }, [paymentMethod]);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );
  const componentsByParentId = useMemo(() => {
    const map = new Map<number, CounterQuickSaleProductComponent[]>();
    for (const component of productComponents) {
      const current = map.get(component.parentProductId) ?? [];
      current.push(component);
      map.set(component.parentProductId, current);
    }
    return map;
  }, [productComponents]);
  const selectedProduct = selectedProductId ? productsById.get(Number(selectedProductId)) ?? null : null;
  const phoneCandidate = newClientMode ? clientPhone : clientSearch;
  const currentPhoneMatchKey = phoneMatchKey(phoneCandidate);
  const registeredPhoneClients =
    currentPhoneMatchKey && phoneLookup?.key === currentPhoneMatchKey
      ? phoneLookup.clients
      : [];
  const availabilityTargetAt = useMemo(() => {
    if (scheduleMode === 'now') return new Date().toISOString();
    if (!scheduledDate || !/^\d{2}:\d{2}$/.test(scheduledTime)) return null;
    return `${scheduledDate}T${scheduledTime}:00-04:00`;
  }, [scheduleMode, scheduledDate, scheduledTime]);
  const configProduct = configProductId ? productsById.get(configProductId) ?? null : null;
  const configComponents = configProductId ? componentsByParentId.get(configProductId) ?? [] : [];
  const configSelectableComponents = configComponents.filter(
    (component) => component.componentMode === 'selectable' || (component.componentMode === 'fixed' && !component.isRequired)
  );
  const configSelectedUnits = configSelections.reduce((sum, row) => {
    const component = configComponents.find((item) => item.componentProductId === row.componentProductId);
    return sum + (component?.countsTowardDetailLimit ? Number(row.qty || 0) : 0);
  }, 0);
  const filteredProducts = useMemo(() => {
    const term = productSearch.trim().toLocaleLowerCase('es-VE');
    if (!term) return products.slice(0, 80);
    return products
      .filter((product) =>
        [product.name, product.sku, product.type]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase('es-VE').includes(term))
      )
      .slice(0, 80);
  }, [productSearch, products]);

  useEffect(() => {
    if (!availabilityTargetAt || products.length === 0) {
      setAvailabilityByProductId(new Map());
      setAvailabilityError(null);
      setAvailabilityLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setAvailabilityLoading(true);
      setAvailabilityError(null);
      const { data, error } = await supabase.rpc('inventory_catalog_availability_v1', {
        p_target_at: availabilityTargetAt,
        p_product_ids: products.map((product) => product.id).slice(0, 200),
        p_surface: 'counter_inventory',
      });
      if (cancelled) return;
      if (error) {
        setAvailabilityByProductId(new Map());
        setAvailabilityError('No se pudo consultar inventario. La venta puede continuar y Máster revisará la solicitud.');
      } else {
        const rows = Array.isArray(data?.products) ? data.products as CounterProductAvailability[] : [];
        setAvailabilityByProductId(new Map(rows.map((row) => [Number(row.product_id), row])));
      }
      setAvailabilityLoading(false);
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [availabilityTargetAt, products, supabase]);
  const lineRows = useMemo(() => {
    return cartItems.map((item) => {
      const product = productsById.get(item.productId) ?? null;
      const itemQty = Math.max(0, toDecimalInput(item.qty));
      const sourceAmount =
        product?.sourcePriceCurrency === 'VES'
          ? product.sourcePriceAmount || product.basePriceBs
          : product?.sourcePriceAmount || product?.basePriceUsd || 0;
      const snapshot = product
        ? calculateOrderLineSnapshot({
            sourceCurrency: product.sourcePriceCurrency,
            sourceAmount,
            quantity: itemQty,
            fxRate: activeBsRate,
            fallbackUnitUsd: product.basePriceUsd,
          })
        : { unitUsd: 0, lineUsd: 0, unitBs: 0, lineBs: 0 };

      return {
        item,
        product,
        qty: itemQty,
        snapshot,
      };
    });
  }, [activeBsRate, cartItems, productsById]);
  const cartSubtotal = useMemo(
    () => ({
      usd: lineRows.reduce((sum, row) => sum + row.snapshot.lineUsd, 0),
      bs: lineRows.reduce((sum, row) => sum + row.snapshot.lineBs, 0),
    }),
    [lineRows]
  );
  const applicableDiscountRules = useMemo(
    () => discountRules.filter((rule) =>
      (rule.paymentMethodCodes.length === 0 || rule.paymentMethodCodes.includes(paymentMethod)) &&
      (rule.paymentCurrencies.length === 0 || rule.paymentCurrencies.includes(paymentCurrency)) &&
      (rule.fulfillments.length === 0 || rule.fulfillments.includes(fulfillment))
    ),
    [discountRules, fulfillment, paymentCurrency, paymentMethod]
  );
  const selectedDiscountRule =
    applicableDiscountRules.find((rule) => rule.id === Number(discountRuleId)) ?? null;
  const totals = useMemo(() => {
    return calculateOrderTotalsSnapshot({
      subtotalUsd: cartSubtotal.usd,
      subtotalBs: cartSubtotal.bs,
      discountPct: selectedDiscountRule?.discountPct ?? 0,
      invoiceTaxPct: hasInvoice ? toDecimalInput(invoiceTaxPct) : 0,
    });
  }, [cartSubtotal.bs, cartSubtotal.usd, hasInvoice, invoiceTaxPct, selectedDiscountRule]);
  const customerCashAmount = toDecimalInput(paymentChangeFor);
  const changeBaseAmount = paymentChangeCurrency === 'VES' ? totals.totalBs : totals.totalUsd;
  const calculatedDeliveryChange = Math.max(customerCashAmount - changeBaseAmount, 0);

  useEffect(() => {
    if (discountRuleId && !selectedDiscountRule) setDiscountRuleId('');
  }, [discountRuleId, selectedDiscountRule]);

  useEffect(() => {
    const key = phoneMatchKey(phoneCandidate);
    const requestId = ++phoneLookupRequestRef.current;
    if (selectedClient || !key) {
      setPhoneLookup(null);
      setPhoneLookupLoading(false);
      return;
    }

    setPhoneLookupLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const results = await searchCounterClientsAction({ query: phoneCandidate });
        if (phoneLookupRequestRef.current !== requestId) return;
        const matches = clientsMatchingPhone(key, results);
        setPhoneLookup({ key, clients: matches });
        if (matches.length > 0) {
          setClientSearchResults(matches);
          setLocalError(null);
        }
      } catch (error) {
        if (phoneLookupRequestRef.current !== requestId) return;
        setLocalError(getCounterUiErrorMessage(
          error,
          'No se pudo verificar el teléfono en la base de clientes. Intenta nuevamente.'
        ));
      } finally {
        if (phoneLookupRequestRef.current === requestId) setPhoneLookupLoading(false);
      }
    }, 650);

    return () => window.clearTimeout(timer);
  }, [phoneCandidate, selectedClient]);

  async function handleClientSearch() {
    const query = clientSearch.trim();
    if (query.length < 2) {
      setLocalError('Escribe telefono o nombre para buscar el cliente.');
      return;
    }

    setClientSearchLoading(true);
    setLocalError(null);
    try {
      const results = await searchCounterClientsAction({ query });
      setClientSearchResults(results);
      const key = phoneMatchKey(query);
      setPhoneLookup(key ? { key, clients: clientsMatchingPhone(key, results) } : null);
      if (results.length === 0) {
        setNewClientMode(true);
        setSelectedClient(null);
        if (query.replace(/\D/g, '').length >= 5) {
          setClientPhone(query);
        } else {
          setClientName(query);
        }
      }
    } catch (error) {
      setLocalError(getCounterUiErrorMessage(
        error,
        'No se pudo buscar el cliente. Intenta nuevamente.'
      ));
    } finally {
      setClientSearchLoading(false);
    }
  }

  function selectClient(client: CounterClientSearchResult) {
    setSelectedClient(client);
    setNewClientMode(false);
    setClientSearchResults([]);
    setPhoneLookup(null);
    setClientName(client.fullName);
    setClientPhone(client.phone || '');
    setClientType(
      client.clientType === 'assigned' || client.clientType === 'legacy' || client.clientType === 'own'
        ? client.clientType
        : 'own'
    );
    setLocalError(null);
  }

  async function startNewClient() {
    const query = clientSearch.trim();
    const key = phoneMatchKey(clientPhone || query);
    if (key) {
      const knownMatches = phoneLookup?.key === key ? phoneLookup.clients : [];
      if (knownMatches.length > 0) {
        setLocalError(`Ese teléfono ya está registrado a nombre de ${knownMatches[0].fullName}. Usa el cliente existente.`);
        return;
      }

      setClientSearchLoading(true);
      setLocalError(null);
      try {
        const results = await searchCounterClientsAction({ query: clientPhone || query });
        const matches = clientsMatchingPhone(key, results);
        setPhoneLookup({ key, clients: matches });
        if (matches.length > 0) {
          setClientSearchResults(matches);
          setLocalError(`Ese teléfono ya está registrado a nombre de ${matches[0].fullName}. Usa el cliente existente.`);
          return;
        }
      } catch (error) {
        setLocalError(getCounterUiErrorMessage(
          error,
          'No se pudo verificar el teléfono. Intenta nuevamente antes de crear el cliente.'
        ));
        return;
      } finally {
        setClientSearchLoading(false);
      }
    }

    setSelectedClient(null);
    setNewClientMode(true);
    setClientSearchResults([]);
    if (!clientName && query && query.replace(/\D/g, '').length < 5) setClientName(query);
    if (!clientPhone && query.replace(/\D/g, '').length >= 5) setClientPhone(query);
    setLocalError(null);
  }

  function changeScheduleMode(nextMode: 'now' | 'scheduled') {
    setScheduleMode(nextMode);
    setOpenPaymentAfterCreate(nextMode === 'now');
  }

  function addCartItem() {
    const productId = Number(selectedProductId || 0);
    const product = productsById.get(productId);
    const productConfigComponents = componentsByParentId.get(productId) ?? [];
    const itemQty = toDecimalInput(qty);

    if (!product) {
      setLocalError('Selecciona un producto valido.');
      return;
    }
    if (availabilityByProductId.get(product.id)?.inventory_blocks_submission) {
      setLocalError(
        availabilityByProductId.get(product.id)?.message
          ?? 'Máster detuvo temporalmente la venta de este producto.',
      );
      return;
    }
    if (!Number.isFinite(itemQty) || itemQty <= 0) {
      setLocalError('Indica una cantidad valida.');
      return;
    }

    if (product.isDetailEditable) {
      if (itemQty !== 1) {
        setLocalError('Los productos configurables se cargan uno por uno. Usa cantidad 1.');
        return;
      }

      const optionalFixedSelections = productConfigComponents
        .filter((component) => component.componentMode === 'fixed' && !component.isRequired && Number(component.quantity || 0) > 0)
        .map((component) => ({
          localId: `fixed-${component.componentProductId}`,
          componentProductId: component.componentProductId,
          componentName: component.componentName,
          qty: Number(component.quantity || 0),
        }));

      setConfigProductId(product.id);
      setConfigAlias('');
      setConfigSelections(optionalFixedSelections);
      setLocalError(null);
      return;
    }

    setCartItems((current) => [
      ...current,
      {
        id: `cart-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        productId,
        qty,
        notes: itemNotes.trim(),
        editableDetailLines: buildComponentDetailLines(productConfigComponents, {
          totalMultiplier: itemQty,
        }),
      },
    ]);
    setQty('1');
    setItemNotes('');
    setProductSearch('');
    setSelectedProductId('');
    setLocalError(null);
  }

  function setConfigSelectionQty(
    componentProductId: number,
    componentName: string,
    qtyValue: number
  ) {
    const safeQty = Math.max(0, Math.floor(Number(qtyValue || 0)));
    setConfigSelections((current) => {
      const others = current.filter((row) => row.componentProductId !== componentProductId);
      if (safeQty === 0) return others;
      return [
        ...others,
        {
          localId: String(componentProductId),
          componentProductId,
          componentName,
          qty: safeQty,
        },
      ];
    });
  }

  function closeProductConfig() {
    setConfigProductId(null);
    setConfigAlias('');
    setConfigSelections([]);
  }

  function confirmProductConfig() {
    if (!configProduct) return;

    const suspendedSelection = configSelections.find(
      (selection) =>
        selection.qty > 0
        && availabilityByProductId.get(selection.componentProductId)?.inventory_blocks_submission,
    );
    if (suspendedSelection) {
      setLocalError(`${suspendedSelection.componentName} está detenido temporalmente por Máster.`);
      return;
    }

    const limit = Number(configProduct.detailUnitsLimit || 0);
    if (limit > 0 && configSelectedUnits !== limit) {
      setLocalError(`Debes seleccionar exactamente ${limit} piezas.`);
      return;
    }

    const selectedByProductId = new Map(
      configSelections
        .filter((row) => row.qty > 0)
        .map((row) => [row.componentProductId, row.qty] as const)
    );
    const detailLines: string[] = [];

    if (configAlias.trim()) {
      detailLines.push(`Para: ${configAlias.trim()}`);
    }

    detailLines.push(
      ...buildComponentDetailLines(configComponents, {
        selectedByProductId,
        includeMetadata: true,
      })
    );

    setCartItems((current) => [
      ...current,
      {
        id: `cart-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        productId: configProduct.id,
        qty: '1',
        notes: itemNotes.trim(),
        editableDetailLines: detailLines,
      },
    ]);
    setQty('1');
    setItemNotes('');
    setProductSearch('');
    setSelectedProductId('');
    closeProductConfig();
    setLocalError(null);
  }

  function submitQuickSale() {
    if (!selectedClient && !newClientMode) {
      setLocalError('Busca un cliente existente o marca crear cliente nuevo.');
      return;
    }
    if (!clientName.trim()) {
      setLocalError('Indica el nombre del cliente.');
      return;
    }
    if (!clientPhone.trim()) {
      setLocalError('Indica el telefono del cliente.');
      return;
    }
    if (newClientMode && phoneLookupLoading) {
      setLocalError('Espera un momento mientras verificamos si el teléfono ya está registrado.');
      return;
    }
    if (newClientMode && registeredPhoneClients.length > 0) {
      setLocalError(`Ese teléfono ya está registrado a nombre de ${registeredPhoneClients[0].fullName}. Selecciona el cliente existente.`);
      return;
    }
    if (fulfillment === 'delivery' && !deliveryAddress.trim()) {
      setLocalError('Indica la direccion para delivery.');
      return;
    }
    if (scheduleMode === 'scheduled' && (!scheduledDate || !scheduledTime)) {
      setLocalError('Indica fecha y hora para agendar el pedido.');
      return;
    }
    if (cartItems.length === 0) {
      setLocalError('Agrega al menos un producto.');
      return;
    }
    if (paymentRequiresChange && customerCashAmount <= changeBaseAmount + 0.005) {
      setLocalError(
        'El monto que entregará el cliente debe ser mayor al total para que exista cambio.'
      );
      return;
    }
    const blockedItem = cartItems.find((item) =>
      availabilityByProductId.get(item.productId)?.inventory_blocks_submission,
    );
    if (blockedItem) {
      setLocalError(
        availabilityByProductId.get(blockedItem.productId)?.message
          ?? 'Máster detuvo temporalmente uno de los productos de la venta.',
      );
      return;
    }

    onSubmit({
      idempotencyKey,
      openPaymentAfterCreate,
      clientId: selectedClient?.id ?? null,
      clientName: clientName.trim(),
      clientPhone: clientPhone.trim(),
      clientType,
      fulfillment,
      deliveryAddress: deliveryAddress.trim(),
      deliveryGpsUrl: deliveryGpsUrl.trim(),
      receiverName: receiverIsDifferent ? receiverName.trim() : '',
      receiverPhone: receiverIsDifferent ? receiverPhone.trim() : '',
      note: note.trim(),
      scheduleAsap: scheduleMode === 'now',
      scheduledDate,
      scheduledTime,
      paymentMethod,
      paymentCurrency,
      paymentRequiresChange,
      paymentChangeFor,
      paymentChangeCurrency,
      paymentNote: paymentNote.trim(),
      discountRuleId: selectedDiscountRule?.id ?? null,
      hasDeliveryNote,
      hasInvoice,
      invoiceTaxPct,
      invoiceDataNote: invoiceDataNote.trim(),
      invoiceCompanyName: invoiceCompanyName.trim(),
      invoiceTaxId: invoiceTaxId.trim(),
      invoiceAddress: invoiceAddress.trim(),
      invoicePhone: invoicePhone.trim(),
      deliveryNoteName: deliveryNoteName.trim(),
      deliveryNoteDocumentId: deliveryNoteDocumentId.trim(),
      deliveryNoteAddress: deliveryNoteAddress.trim(),
      deliveryNotePhone: deliveryNotePhone.trim(),
      items: cartItems.map((item) => ({
        productId: item.productId,
        qty: toDecimalInput(item.qty),
        notes: item.notes.trim() || null,
        editableDetailLines: item.editableDetailLines,
      })),
    });
  }

  return (
    <section className="rounded-[8px] border border-[#FEEF00]/35 bg-[#15150F] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Nueva venta</h2>
          <p className="mt-1 text-xs text-[#B9B9A8]">
            Crea una orden directa, calcula con la tasa activa y la envia a cocina.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-[#303044] px-3 py-1 text-xs font-semibold text-[#C7C8D1]">
            Tasa {activeBsRate > 0 ? moneyBs(activeBsRate) : 'sin tasa'}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1.5 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50"
          >
            Cerrar
          </button>
        </div>
      </div>

      {localError ? (
        <div className="mt-4 rounded-[8px] border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm font-semibold text-red-200">
          {localError}
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <h3 className="text-sm font-semibold">Cliente</h3>
          <div className="grid gap-2 md:grid-cols-[1fr_120px_145px]">
            <input
              value={clientSearch}
              onChange={(event) => {
                setClientSearch(event.target.value);
                setLocalError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleClientSearch();
                }
              }}
              placeholder="Buscar por telefono o nombre"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
            <button
              type="button"
              onClick={() => void handleClientSearch()}
              disabled={clientSearchLoading}
              className="rounded-[8px] border border-[#303044] bg-[#15151C] px-3 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50 disabled:opacity-60"
            >
              {clientSearchLoading ? 'Buscando...' : 'Buscar'}
            </button>
            <button
              type="button"
              onClick={() => void startNewClient()}
              disabled={clientSearchLoading || phoneLookupLoading || registeredPhoneClients.length > 0}
              className="rounded-[8px] border border-[#FEEF00]/60 bg-[#FEEF00]/10 px-3 py-2 text-sm font-semibold text-[#FEEF00] hover:bg-[#FEEF00]/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {registeredPhoneClients.length > 0 ? 'Cliente ya existe' : 'Crear cliente'}
            </button>
          </div>

          {phoneLookupLoading ? (
            <div role="status" className="rounded-[8px] border border-sky-300/25 bg-sky-300/10 px-3 py-2 text-sm text-sky-100">
              Verificando si este teléfono ya está registrado...
            </div>
          ) : null}

          {registeredPhoneClients.length > 0 ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-[8px] border border-emerald-300/45 bg-emerald-300/10 p-3"
            >
              <div className="text-sm font-bold text-emerald-100">Cliente ya registrado</div>
              <p className="mt-1 text-sm leading-5 text-emerald-100/85">
                {registeredPhoneClients.length === 1 ? (
                  <>
                    El número <strong>{phoneCandidate}</strong> ya está en la base de datos, registrado a nombre de{' '}
                    <strong>{registeredPhoneClients[0].fullName}</strong>.
                  </>
                ) : (
                  <>
                    Los últimos siete dígitos de <strong>{phoneCandidate}</strong> coinciden con clientes registrados.
                    Selecciona el nombre correcto antes de continuar.
                  </>
                )}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {registeredPhoneClients.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    onClick={() => selectClient(client)}
                    className="min-h-11 rounded-[8px] border border-emerald-200/45 bg-emerald-200/15 px-3 py-2 text-left text-sm font-semibold text-emerald-50 hover:bg-emerald-200/20"
                  >
                    Usar cliente: {client.fullName}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {clientSearchResults.length > 0 && registeredPhoneClients.length === 0 ? (
            <div className="max-h-[180px] overflow-y-auto rounded-[8px] border border-[#242433] bg-[#111118]">
              <div className="border-b border-[#242433] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#9FA0AA]">
                Clientes encontrados en la base de datos
              </div>
              {clientSearchResults.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => selectClient(client)}
                  className="w-full border-b border-[#242433] px-3 py-2 text-left last:border-b-0 hover:bg-[#1A1A22]"
                >
                  <div className="text-xs font-semibold text-emerald-200">Cliente registrado</div>
                  <div className="mt-0.5 text-sm font-semibold text-[#F5F5F7]">
                    Registrado como: {client.fullName}
                  </div>
                  <div className="mt-0.5 text-xs text-[#9FA0AA]">
                    {client.phone || 'Sin telefono'} - {client.clientType || 'sin tipo'} - Fondo {moneyUsd(client.fundBalanceUsd)}
                  </div>
                  <div className={[
                    'mt-1 text-xs font-semibold',
                    client.advisorName ? 'text-sky-200' : 'text-amber-200',
                  ].join(' ')}>
                    {clientAdvisorLabel(client)}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          {selectedClient ? (
            <div className="space-y-2 rounded-[8px] border border-emerald-400/30 bg-emerald-400/10 px-3 py-2">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-emerald-100/70">
                Cliente registrado seleccionado
              </div>
              <div className="text-sm text-emerald-100">
                Este número está registrado a nombre de <strong>{selectedClient.fullName}</strong>.
              </div>
              <div className="text-xs text-emerald-100/75">
                {selectedClient.phone || 'Sin telefono'} - {selectedClient.clientType || 'sin tipo'} - Fondo {moneyUsd(selectedClient.fundBalanceUsd)}
              </div>
              <div className={[
                'rounded-[8px] border px-2.5 py-2 text-xs font-semibold',
                selectedClient.advisorName
                  ? 'border-sky-300/25 bg-sky-300/10 text-sky-100'
                  : 'border-amber-300/25 bg-amber-300/10 text-amber-100',
              ].join(' ')}>
                {clientAdvisorLabel(selectedClient)}
                {!selectedClient.advisorName ? (
                  <span className="mt-0.5 block font-normal">
                    Master podra asignar un responsable si la orden queda para seguimiento.
                  </span>
                ) : null}
              </div>
              <label className="block text-xs text-emerald-100/75">
                Teléfono confirmado para esta venta
                <input
                  value={clientPhone}
                  onChange={(event) => setClientPhone(event.target.value)}
                  inputMode="tel"
                  placeholder="Obligatorio"
                  className="mt-1 w-full rounded-[8px] border border-emerald-200/30 bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                />
              </label>
            </div>
          ) : null}
          {newClientMode ? (
            <div className="space-y-2 rounded-[8px] border border-[#303044] bg-[#111118] p-3">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9FA0AA]">Cliente nuevo</div>
              <div className="rounded-[8px] border border-amber-300/25 bg-amber-300/10 px-2.5 py-2 text-xs text-amber-100">
                Este cliente aun no tiene asesor. Master podra asignarlo cuando revise una orden agendada.
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-[#9FA0AA]">
                  Nombre
                  <input
                    value={clientName}
                    onChange={(event) => setClientName(event.target.value)}
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
                <label className="text-xs text-[#9FA0AA]">
                  Telefono
                  <input
                    value={clientPhone}
                    onChange={(event) => {
                      setClientPhone(event.target.value);
                      setLocalError(null);
                    }}
                    inputMode="tel"
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                  <span className="mt-1 block text-[11px] text-[#777988]">
                    Al completar el número verificaremos automáticamente los últimos siete dígitos.
                  </span>
                </label>
              </div>
              <label className="text-xs text-[#9FA0AA]">
                Tipo
                <select
                  value={clientType}
                  onChange={(event) =>
                    setClientType(
                      event.target.value === 'assigned' || event.target.value === 'legacy' ? event.target.value : 'own'
                    )
                  }
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                >
                  <option value="own">Propio</option>
                  <option value="assigned">Asignado</option>
                  <option value="legacy">Antiguo</option>
                </select>
              </label>
            </div>
          ) : null}
        </div>

        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <h3 className="text-sm font-semibold">Cuándo se necesita</h3>
          <p className="text-xs text-[#9FA0AA]">
            La fecha se define antes de escoger productos para consultar el inventario correcto.
          </p>
          <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => changeScheduleMode('now')}
                className={[
                  'rounded-[8px] border px-3 py-1.5 text-sm font-semibold',
                  scheduleMode === 'now'
                    ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                    : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1]',
                ].join(' ')}
              >
                Ahora
              </button>
              <button
                type="button"
                onClick={() => changeScheduleMode('scheduled')}
                className={[
                  'rounded-[8px] border px-3 py-1.5 text-sm font-semibold',
                  scheduleMode === 'scheduled'
                    ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                    : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1]',
                ].join(' ')}
              >
                Agendar
              </button>
            </div>
            {scheduleMode === 'scheduled' ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-sm text-[#9FA0AA]">
                  Fecha
                  <input
                    type="date"
                    value={scheduledDate}
                    min={getTodayKey()}
                    onChange={(event) => setScheduledDate(event.target.value)}
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
                <label className="text-sm text-[#9FA0AA]">
                  Hora
                  <input
                    type="time"
                    value={scheduledTime}
                    onChange={(event) => setScheduledTime(event.target.value)}
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
            ) : (
              <div className="mt-3 text-xs text-[#9FA0AA]">Se enviará a cocina con la hora actual.</div>
            )}
          </div>
          <div className="rounded-[8px] border border-sky-400/25 bg-sky-400/5 px-3 py-2 text-xs leading-5 text-sky-100">
            {availabilityLoading
              ? 'Consultando disponibilidad…'
              : availabilityError
                ? availabilityError
                : availabilityTargetAt
                  ? 'Fecha lista. Las señales son informativas y no impiden crear la venta.'
                  : 'Completa fecha y hora para abrir el catálogo.'}
          </div>
        </div>

        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Pedido</h3>
            <span className="text-sm font-semibold text-[#F5F5F7]">{cartItems.length} item(s)</span>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_110px]">
            <input
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              disabled={!availabilityTargetAt}
              placeholder={availabilityTargetAt ? 'Buscar producto' : 'Primero define fecha y hora'}
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70 disabled:cursor-not-allowed disabled:opacity-55"
            />
            <input
              value={qty}
              onChange={(event) => setQty(event.target.value)}
              inputMode="decimal"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            />
          </div>
          {productSearch.trim() ? (
            <div className="max-h-[210px] overflow-y-auto rounded-[8px] border border-[#242433] bg-[#111118]">
              {filteredProducts.length === 0 ? (
                <div className="px-3 py-3 text-sm text-[#9FA0AA]">Sin resultados.</div>
              ) : (
                filteredProducts.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => {
                      setSelectedProductId(String(product.id));
                      setProductSearch(product.name);
                    }}
                    className={[
                      'w-full border-b border-[#242433] px-3 py-2 text-left last:border-b-0 hover:bg-[#1A1A22]',
                      selectedProductId === String(product.id) ? 'bg-[#1A1A22]' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#F5F5F7]">{product.name}</div>
                        <div className="mt-0.5 text-xs text-[#9FA0AA]">
                          {product.unitsPerService > 0 ? `${product.unitsPerService} und/serv` : 'Sin unidades'} -{' '}
                          {moneyUsd(product.basePriceUsd)} / {moneyBs(product.basePriceBs)}
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${availabilityTone(availabilityByProductId.get(product.id) ?? null)}`}>
                        {availabilityLoading ? 'Consultando…' : availabilityLabel(availabilityByProductId.get(product.id) ?? null)}
                      </span>
                    </div>
                    {availabilityByProductId.get(product.id)?.message ? (
                      <div className="mt-1.5 text-xs leading-5 text-[#C7C8D1]">
                        {availabilityByProductId.get(product.id)?.message}
                      </div>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          ) : null}

          {selectedProduct ? (
            <div className="rounded-[8px] border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <div className="font-semibold text-emerald-100">{selectedProduct.name}</div>
                {selectedProduct.isDetailEditable ? (
                  <span className="rounded-full border border-emerald-200/30 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                    Armable
                  </span>
                ) : (componentsByParentId.get(selectedProduct.id) ?? []).length > 0 ? (
                  <span className="rounded-full border border-emerald-200/30 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                    Combo
                  </span>
                ) : null}
              </div>
              <div className="mt-1 text-xs text-emerald-100/75">
                {selectedProduct.unitsPerService > 0 ? `${selectedProduct.unitsPerService} und/serv` : 'Sin unidades'} -{' '}
                {moneyUsd(selectedProduct.basePriceUsd)} / {moneyBs(selectedProduct.basePriceBs)}
              </div>
              <div className={`mt-2 rounded-[8px] border px-3 py-2 text-xs leading-5 ${availabilityTone(availabilityByProductId.get(selectedProduct.id) ?? null)}`}>
                <div className="font-semibold">
                  {availabilityLoading ? 'Consultando inventario…' : availabilityLabel(availabilityByProductId.get(selectedProduct.id) ?? null)}
                </div>
                <div className="mt-0.5">
                  {availabilityByProductId.get(selectedProduct.id)?.message
                    ?? 'La lectura no está disponible; puedes continuar y Máster revisará la venta.'}
                </div>
              </div>
            </div>
          ) : null}
          {configProduct ? (
            <div className="space-y-3 rounded-[8px] border border-[#FEEF00]/40 bg-[#181807] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-[#F5F5F7]">Armar {configProduct.name}</div>
                  <div className="mt-1 text-xs text-[#B9B9A8]">
                    {configProduct.detailUnitsLimit > 0
                      ? `${configSelectedUnits}/${configProduct.detailUnitsLimit} piezas seleccionadas`
                      : `${configSelectedUnits} piezas seleccionadas`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeProductConfig}
                  className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1 text-xs font-semibold text-[#F5F5F7]"
                >
                  Cerrar
                </button>
              </div>
              <input
                value={configAlias}
                onChange={(event) => setConfigAlias(event.target.value)}
                placeholder="Para / nombre dentro del pedido (opcional)"
                className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
              <div className="grid gap-2 md:grid-cols-2">
                {configSelectableComponents.map((component) => {
                  const currentQty =
                    configSelections.find((row) => row.componentProductId === component.componentProductId)?.qty ?? 0;
                  const componentSuspended = Boolean(
                    availabilityByProductId.get(component.componentProductId)?.inventory_blocks_submission,
                  );

                  return (
                    <label
                      key={component.componentProductId}
                      className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-2 text-sm text-[#F5F5F7]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{component.componentName}</span>
                        <input
                          value={currentQty ? String(currentQty) : ''}
                          disabled={componentSuspended}
                          onChange={(event) =>
                            setConfigSelectionQty(
                              component.componentProductId,
                              component.componentName,
                              Number(event.target.value || 0)
                            )
                          }
                          inputMode="numeric"
                          className="h-9 w-20 rounded-[8px] border border-[#303044] bg-[#111118] px-2 text-right text-sm outline-none focus:border-[#FEEF00]/70 disabled:cursor-not-allowed disabled:opacity-45"
                        />
                      </div>
                      <div className="mt-1 text-[11px] text-[#9FA0AA]">
                        {componentSuspended
                          ? 'No disponible por decisión de Máster'
                          : component.componentMode === 'fixed' ? 'Fijo opcional' : 'Seleccionable'}
                        {component.countsTowardDetailLimit ? ' · cuenta para limite' : ''}
                      </div>
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={confirmProductConfig}
                className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c]"
              >
                Guardar armado
              </button>
            </div>
          ) : null}
          <div className="grid gap-2 md:grid-cols-[1fr_130px]">
            <input
              value={itemNotes}
              onChange={(event) => setItemNotes(event.target.value)}
              placeholder="Nota del item (opcional)"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
            <button
              type="button"
              onClick={addCartItem}
              disabled={products.length === 0 || activeBsRate <= 0}
              className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Agregar
            </button>
          </div>

          <div className="max-h-[240px] overflow-y-auto rounded-[8px] border border-[#242433]">
            {lineRows.length === 0 ? (
              <div className="p-4 text-sm text-[#9FA0AA]">Sin productos agregados.</div>
            ) : (
              <div className="divide-y divide-[#242433]">
                {lineRows.map((row) => (
                  <div key={row.item.id} className="grid gap-2 p-3 sm:grid-cols-[60px_1fr_145px_auto]">
                    <div className="text-sm font-semibold text-[#FEEF00]">x{qtyLabel(row.qty)}</div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{row.product?.name || 'Producto'}</div>
                      <div className="mt-1 text-xs text-[#9FA0AA]">
                        Unit. {moneyUsd(row.snapshot.unitUsd)} / {moneyBs(row.snapshot.unitBs)}
                      </div>
                      {row.item.notes ? <div className="mt-1 text-xs text-[#9FA0AA]">{row.item.notes}</div> : null}
                      {getVisibleEditableDetailLines(row.item.editableDetailLines).length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-[#C7C8D1]">
                          {getVisibleEditableDetailLines(row.item.editableDetailLines).map((detail, detailIdx) => (
                            <li key={`${row.item.id}-${detailIdx}`}>• {detail}</li>
                          ))}
                        </ul>
                      ) : null}
                      {availabilityByProductId.get(row.item.productId)?.requires_master_review ? (
                        <div className="mt-2 rounded-[8px] border border-amber-300/30 bg-amber-300/10 px-2 py-1.5 text-xs leading-5 text-amber-100">
                          {availabilityByProductId.get(row.item.productId)?.message}
                          <div className="font-semibold">La venta puede crearse; Máster decide la confirmación final.</div>
                        </div>
                      ) : null}
                    </div>
                    <div className="text-sm font-semibold sm:text-right">
                      <div>{moneyUsd(row.snapshot.lineUsd)}</div>
                      <div className="mt-0.5 text-xs text-[#9FA0AA]">{moneyBs(row.snapshot.lineBs)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCartItems((current) => current.filter((item) => item.id !== row.item.id))}
                      className="rounded-[8px] border border-red-400/40 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-400/10"
                    >
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
            <label className="text-xs text-[#9FA0AA]">
              Regla de descuento
              <select
                value={discountRuleId}
                onChange={(event) => setDiscountRuleId(event.target.value)}
                disabled={applicableDiscountRules.length === 0}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70 disabled:opacity-60"
              >
                <option value="">
                  {applicableDiscountRules.length === 0
                    ? 'No hay reglas activas aplicables'
                    : 'Sin descuento'}
                </option>
                {applicableDiscountRules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.name} ({rule.discountPct}%)
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-[11px] text-[#9FA0AA]">
              Mostrador solo puede aplicar reglas generales activas. La vigencia se vuelve a validar al confirmar.
            </p>
          </div>
        </div>

        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <h3 className="text-sm font-semibold">Entrega</h3>
          <div className="grid grid-cols-2 gap-2">
            {(['pickup', 'delivery'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFulfillment(option)}
                className={[
                  'rounded-[8px] border px-3 py-2 text-sm font-semibold',
                  fulfillment === option
                    ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                    : 'border-[#303044] bg-[#111118] text-[#C7C8D1]',
                ].join(' ')}
              >
                {option === 'pickup' ? 'Pickup' : 'Delivery'}
              </button>
            ))}
          </div>
          {fulfillment === 'delivery' ? (
            <div className="space-y-2">
              <label className="text-sm text-[#9FA0AA]">
                Direccion
                <textarea
                  value={deliveryAddress}
                  onChange={(event) => setDeliveryAddress(event.target.value)}
                  rows={2}
                  className="mt-1 w-full resize-none rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                />
              </label>
              <label className="text-sm text-[#9FA0AA]">
                GPS
                <input
                  value={deliveryGpsUrl}
                  onChange={(event) => setDeliveryGpsUrl(event.target.value)}
                  placeholder="Link de ubicacion (opcional)"
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                />
              </label>
              <label className="flex items-center gap-2 rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-sm text-[#F5F5F7]">
                <input
                  type="checkbox"
                  checked={receiverIsDifferent}
                  onChange={(event) => setReceiverIsDifferent(event.target.checked)}
                />
                Recibe otra persona
              </label>
              {receiverIsDifferent ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-[#9FA0AA]">
                    Nombre recibe
                    <input
                      value={receiverName}
                      onChange={(event) => setReceiverName(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    Telefono recibe
                    <input
                      value={receiverPhone}
                      onChange={(event) => setReceiverPhone(event.target.value)}
                      inputMode="tel"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}
          <label className="text-xs text-[#9FA0AA]">
            Nota de orden
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Opcional"
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
          </label>
        </div>

        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <div>
            <h3 className="text-sm font-semibold">Pago previsto y documentos</h3>
            <p className="mt-1 text-xs text-[#9FA0AA]">
              El metodo indica como se espera cobrar. Crear la orden no registra dinero por si solo.
            </p>
          </div>
          <div className="grid gap-2 rounded-[8px] border border-[#303044] bg-[#111118] p-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={hasDeliveryNote}
                onChange={(event) => setHasDeliveryNote(event.target.checked)}
              />
              Nota de entrega
            </label>
            <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={hasInvoice}
                onChange={(event) => setHasInvoice(event.target.checked)}
              />
              Factura
            </label>
            {hasInvoice ? (
              <div className="space-y-2 sm:col-span-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-[#9FA0AA]">
                    Razon social
                    <input
                      value={invoiceCompanyName}
                      onChange={(event) => setInvoiceCompanyName(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    RIF / Cedula
                    <input
                      value={invoiceTaxId}
                      onChange={(event) => setInvoiceTaxId(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    Telefono fiscal
                    <input
                      value={invoicePhone}
                      onChange={(event) => setInvoicePhone(event.target.value)}
                      inputMode="tel"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    IVA %
                    <input
                      value={invoiceTaxPct}
                      onChange={(event) => setInvoiceTaxPct(event.target.value)}
                      inputMode="decimal"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                </div>
                <label className="text-xs text-[#9FA0AA]">
                  Direccion fiscal
                  <textarea
                    value={invoiceAddress}
                    onChange={(event) => setInvoiceAddress(event.target.value)}
                    rows={2}
                    className="mt-1 w-full resize-none rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
                <label className="text-xs text-[#9FA0AA]">
                  Datos factura
                  <input
                    value={invoiceDataNote}
                    onChange={(event) => setInvoiceDataNote(event.target.value)}
                    placeholder="Observacion fiscal opcional"
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
            ) : null}
            {hasDeliveryNote ? (
              <div className="space-y-2 sm:col-span-2">
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="text-xs text-[#9FA0AA]">
                    Nombre nota
                    <input
                      value={deliveryNoteName}
                      onChange={(event) => setDeliveryNoteName(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    Documento
                    <input
                      value={deliveryNoteDocumentId}
                      onChange={(event) => setDeliveryNoteDocumentId(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    Telefono nota
                    <input
                      value={deliveryNotePhone}
                      onChange={(event) => setDeliveryNotePhone(event.target.value)}
                      inputMode="tel"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                </div>
                <label className="text-xs text-[#9FA0AA]">
                  Direccion nota de entrega
                  <textarea
                    value={deliveryNoteAddress}
                    onChange={(event) => setDeliveryNoteAddress(event.target.value)}
                    rows={2}
                    className="mt-1 w-full resize-none rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
            ) : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-[#9FA0AA]">
            Metodo
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            >
              {QUICK_SALE_PAYMENT_METHODS.map((method) => (
                <option key={method.code} value={method.code}>
                  {method.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[#9FA0AA]">
            Moneda
            <select
              value={paymentCurrency}
              onChange={(event) => setPaymentCurrency(event.target.value === 'VES' ? 'VES' : 'USD')}
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            >
              <option value="VES">VES</option>
              <option value="USD">USD</option>
            </select>
          </label>
          </div>
          <label className="flex items-center gap-2 rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={paymentRequiresChange}
              onChange={(event) => {
                const checked = event.target.checked;
                setPaymentRequiresChange(checked);
                if (checked) {
                  const changeCurrency = paymentMethod === 'cash_usd'
                    ? 'USD'
                    : paymentMethod === 'cash_ves'
                      ? 'VES'
                      : paymentCurrency;
                  const cashMethod = changeCurrency === 'VES' ? 'cash_ves' : 'cash_usd';
                  setPaymentChangeCurrency(changeCurrency);
                  setPaymentMethod(cashMethod);
                  setPaymentCurrency(changeCurrency);
                }
              }}
            />
            El cliente necesita cambio
          </label>
          {paymentRequiresChange ? (
            <div className="rounded-[8px] border border-orange-400/30 bg-orange-950/15 p-3">
              <div className="text-xs font-semibold text-orange-100">¿Con cuánto pagará el cliente?</div>
              <p className="mt-1 text-[11px] leading-relaxed text-orange-100/70">
                Escribe el billete o monto que entregará, no el cambio. Ejemplo: venta $15, paga con $20.
              </p>
              <div className="mt-2 grid grid-cols-[1fr_90px] gap-2">
                <input
                  value={paymentChangeFor}
                  onChange={(event) => setPaymentChangeFor(event.target.value)}
                  placeholder="Monto que entrega"
                  inputMode="decimal"
                  aria-label="Monto con el que pagara el cliente"
                  className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                />
                <select
                  value={paymentChangeCurrency}
                  onChange={(event) => {
                    const currency = event.target.value === 'VES' ? 'VES' : 'USD';
                    setPaymentChangeCurrency(currency);
                    setPaymentCurrency(currency);
                    setPaymentMethod(currency === 'VES' ? 'cash_ves' : 'cash_usd');
                  }}
                  aria-label="Moneda del efectivo que entregara el cliente"
                  className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                >
                  <option value="USD">USD</option>
                  <option value="VES">VES</option>
                </select>
              </div>
              {customerCashAmount > 0 ? (
                <div className="mt-2 text-xs font-semibold text-[#FEEF00]">
                  Cambio calculado: {paymentChangeCurrency === 'VES'
                    ? moneyBs(calculatedDeliveryChange)
                    : moneyUsd(calculatedDeliveryChange)}
                </div>
              ) : null}
            </div>
          ) : null}
          <label className="text-xs text-[#9FA0AA]">
            Nota de pago
            <input
              value={paymentNote}
              onChange={(event) => setPaymentNote(event.target.value)}
              placeholder="Opcional"
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
          </label>

          <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between gap-3 text-[#C7C8D1]">
                <span>Subtotal</span>
                <span>{moneyUsd(cartSubtotal.usd)} / {moneyBs(cartSubtotal.bs)}</span>
              </div>
              {selectedDiscountRule ? (
                <div className="flex justify-between gap-3 text-emerald-200">
                  <span>Descuento ({selectedDiscountRule.discountPct}%)</span>
                  <span>-{moneyUsd(totals.discountAmountUsd)} / -{moneyBs(totals.discountAmountBs)}</span>
                </div>
              ) : null}
              {hasInvoice && toDecimalInput(invoiceTaxPct) > 0 ? (
                <div className="flex justify-between gap-3 text-[#FEEF00]">
                  <span>IVA ({toDecimalInput(invoiceTaxPct)}%)</span>
                  <span>+{moneyUsd(totals.invoiceTaxAmountUsd)} / +{moneyBs(totals.invoiceTaxAmountBs)}</span>
                </div>
              ) : null}
              <div className="flex justify-between gap-3 border-t border-[#303044] pt-2 text-base font-semibold text-[#F5F5F7]">
                <span>Total</span>
                <span>{moneyUsd(totals.totalUsd)} / {moneyBs(totals.totalBs)}</span>
              </div>
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={openPaymentAfterCreate}
              onChange={(event) => setOpenPaymentAfterCreate(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              {scheduleMode === 'scheduled' ? 'Cobrar ahora despues de agendar' : 'Abrir cobro al crear'}
              <span className="mt-0.5 block text-xs font-normal text-[#9FA0AA]">
                {scheduleMode === 'scheduled'
                  ? 'Es opcional. Si no lo marcas, la agenda queda pendiente de pago para seguimiento de Master o del asesor asignado.'
                  : 'La orden entra a cocina y luego abre el motor de pagos mixtos de Mostrador.'}
              </span>
            </span>
          </label>

          {scheduleMode === 'scheduled' ? (
            <div className={[
              'rounded-[8px] border px-3 py-2 text-xs leading-5',
              openPaymentAfterCreate
                ? 'border-sky-300/30 bg-sky-300/10 text-sky-100'
                : 'border-amber-300/30 bg-amber-300/10 text-amber-100',
            ].join(' ')}>
              {openPaymentAfterCreate
                ? 'La agenda se crea primero y el cobro se abre despues; el pago no es requisito para guardar el pedido.'
                : 'La agenda se guardara sin cobro. La orden conservara su saldo pendiente y podra pagarse mas adelante.'}
            </div>
          ) : null}

          <button
            type="button"
            onClick={submitQuickSale}
            disabled={isWorking || activeBsRate <= 0 || cartItems.length === 0}
            className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-2.5 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isWorking
              ? 'Creando...'
              : scheduleMode === 'scheduled'
                ? openPaymentAfterCreate
                  ? 'Crear agenda y abrir cobro'
                  : 'Crear agenda sin cobrar'
                : 'Crear y enviar a cocina'}
          </button>
        </div>
      </div>
    </section>
  );
}
