'use server';

import { revalidatePath } from 'next/cache';
import { requireCounterOperatorContext } from '@/lib/auth';
import { sendPushToAdvisorDevices } from '@/lib/push';
import type {
  CounterGiveChangeIntent,
  CounterGiveChangeResult,
  CounterPaymentIntent,
  CounterPaymentOperationResult,
  CounterWaiveChangeIntent,
  CounterWaiveChangeResult,
  CounterRefundExecutionIntent,
  CounterRefundExecutionResult,
  CounterRefundRequestIntent,
  CounterRefundRequestResult,
} from './payment-contract';
import type {
  CounterPickupCompletionResult,
  CounterPickupItemChangeIntent,
  CounterPickupItemChangeResult,
  CounterPickupScheduleIntent,
  CounterPickupScheduleResult,
} from './pickup-contract';
import type {
  CounterDeliveryCashLine,
  CounterDeliveryDispatchIntent,
  CounterDeliveryDispatchResult,
  CounterDeliveryReturnIntent,
  CounterDeliveryReturnResult,
  CounterDeliveryValueLine,
} from './delivery-contract';
import type {
  CounterDirectSaleIntent,
  CounterDirectSaleActionResult,
  CounterDirectSaleFailure,
  CounterDirectSaleResult,
} from './direct-sale-contract';

export type CounterClientSearchResult = {
  id: number;
  fullName: string;
  phone: string | null;
  clientType: string | null;
  fundBalanceUsd: number;
  advisorUserId: string | null;
  advisorName: string | null;
  advisorSource: 'primary' | 'last_order' | 'none';
  advisorIsActive: boolean | null;
  advisorLastOrderAt: string | null;
};

type CounterCashMovementInput = {
  idempotencyKey: string;
  direction: 'inflow' | 'outflow';
  moneyAccountId: number;
  amount: number;
  movementDate: string;
  exchangeRateVesPerUsd: number | null;
  referenceCode?: string | null;
  counterpartyName?: string | null;
  description: string;
  notes?: string | null;
};

type CounterCashClosureInput = {
  idempotencyKey: string;
  moneyAccountId: number;
  closureDate: string;
  closureTime: string;
  countedAmount: number;
  exchangeRateVesPerUsd: number | null;
  reason: string;
  notes?: string | null;
};

export type CounterHistoricalSearchStatus =
  | 'created'
  | 'queued'
  | 'confirmed'
  | 'in_kitchen'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export type CounterHistoricalSearchResult = {
  id: number;
  displayNumber: string;
  orderNumber: string | null;
  status: CounterHistoricalSearchStatus;
  fulfillment: 'pickup' | 'delivery';
  clientName: string;
  clientPhone: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  sentToKitchenAt: string | null;
  kitchenStartedAt: string | null;
  readyAt: string | null;
  deliveredAt: string | null;
  totalUsd: number;
  totalBs: number;
  confirmedPaidUsd: number;
  balanceUsd: number;
  paymentStatus: string;
  pendingReportsCount: number;
  itemCount: number;
  productSummary: string[];
  note: string | null;
  createdAt: string;
};

export type CounterHistoricalSearchCursor = {
  createdAt: string;
  id: number;
};

export type CounterHistoricalSearchPage = {
  results: CounterHistoricalSearchResult[];
  nextCursor: CounterHistoricalSearchCursor | null;
};

export type CounterDailyHistoryCursor = {
  deliveredAt: string;
  id: number;
};

export type CounterDailyHistoryPage = {
  serviceDate: string;
  results: CounterHistoricalSearchResult[];
  nextCursor: CounterDailyHistoryCursor | null;
};

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function roundCounterMoney(value: unknown) {
  return Number(toSafeNumber(value, 0).toFixed(2));
}

function directSaleErrorMessage(message: string) {
  const errors: Array<[string, string]> = [
    ['counter_access_denied', 'Tu usuario no tiene permiso para crear ventas de Mostrador.'],
    ['counter_idempotency_key_reused', 'La venta cambió después de iniciar. Cierra el formulario y vuelve a intentarlo.'],
    ['counter_client_name_required', 'Indica el nombre del cliente.'],
    ['counter_client_phone_invalid', 'Indica un teléfono válido del cliente.'],
    ['counter_client_not_found', 'El cliente seleccionado ya no existe. Vuelve a buscarlo.'],
    ['counter_client_inactive', 'El cliente seleccionado está inactivo. Solicita revisión a Master.'],
    ['counter_client_phone_mismatch', 'El teléfono no coincide con el cliente seleccionado. Vuelve a buscarlo.'],
    ['counter_client_phone_conflict', 'Ese teléfono ya pertenece a otro cliente. Vuelve a buscarlo.'],
    ['counter_receiver_phone_invalid', 'El teléfono de quien recibe no es válido.'],
    ['counter_delivery_address_required', 'La dirección es obligatoria para delivery.'],
    ['counter_invoice_phone_invalid', 'El teléfono fiscal no es válido.'],
    ['counter_delivery_note_phone_invalid', 'El teléfono de la nota de entrega no es válido.'],
    ['counter_exchange_rate_unavailable', 'No hay una tasa activa válida.'],
    ['counter_payment_method_invalid', 'El método de pago esperado no es válido.'],
    ['counter_payment_currency_invalid', 'La moneda no corresponde al método de pago seleccionado.'],
    ['counter_payment_change_amount_invalid', 'Indica para cuánto dinero requiere cambio el cliente.'],
    ['counter_discount_rule_not_applicable', 'La regla de descuento venció, fue desactivada o ya no aplica a esta venta.'],
    ['counter_schedule_must_be_future', 'La fecha y hora agendadas deben estar en el futuro.'],
    ['counter_schedule_invalid', 'Indica una fecha y hora válidas para agendar.'],
    ['counter_items_count_invalid', 'La venta debe tener entre uno y cien productos.'],
    ['counter_product_unavailable', 'Uno de los productos o componentes ya no está disponible.'],
    ['counter_product_suspended', 'Máster detuvo temporalmente uno de los productos o componentes para esa fecha.'],
    ['counter_product_protected_balance', 'La cantidad supera el saldo protegido disponible para esa fecha. Reduce la cantidad o consulta a Máster.'],
    ['counter_configurable_product_quantity_must_be_one', 'Los productos configurables se agregan uno por uno.'],
    ['counter_item_component_unavailable', 'La configuración contiene un componente no disponible.'],
    ['counter_item_fixed_component_quantity_invalid', 'La cantidad de un componente fijo cambió. Vuelve a armar el producto.'],
    ['counter_item_required_component_missing', 'Falta un componente obligatorio. Vuelve a armar el producto.'],
    ['counter_item_detail_limit_mismatch', 'La configuración no completa la cantidad de piezas requerida.'],
  ];
  return errors.find(([code]) => message.includes(code))?.[1] ?? message;
}

function directSaleFailure(message: string): CounterDirectSaleFailure {
  const knownCodes = [
    'counter_access_denied',
    'counter_idempotency_key_reused',
    'counter_client_name_required',
    'counter_client_phone_invalid',
    'counter_client_not_found',
    'counter_client_inactive',
    'counter_client_phone_mismatch',
    'counter_client_phone_conflict',
    'counter_receiver_phone_invalid',
    'counter_delivery_address_required',
    'counter_invoice_phone_invalid',
    'counter_delivery_note_phone_invalid',
    'counter_exchange_rate_unavailable',
    'counter_payment_method_invalid',
    'counter_payment_currency_invalid',
    'counter_payment_change_amount_invalid',
    'counter_discount_rule_not_applicable',
    'counter_schedule_must_be_future',
    'counter_schedule_invalid',
    'counter_items_count_invalid',
    'counter_product_unavailable',
    'counter_product_suspended',
    'counter_product_protected_balance',
    'counter_configurable_product_quantity_must_be_one',
    'counter_item_component_unavailable',
    'counter_item_fixed_component_quantity_invalid',
    'counter_item_required_component_missing',
    'counter_item_detail_limit_mismatch',
  ];
  const reason = knownCodes.find((code) => message.includes(code)) ?? 'counter_direct_sale_failed';
  const refreshCatalog = [
    'counter_product_unavailable',
    'counter_product_suspended',
    'counter_product_protected_balance',
    'counter_item_component_unavailable',
    'counter_item_fixed_component_quantity_invalid',
    'counter_item_required_component_missing',
    'counter_item_detail_limit_mismatch',
  ].includes(reason);

  return {
    ok: false,
    reason,
    refreshCatalog,
    message: reason === 'counter_direct_sale_failed'
      ? 'No se pudo crear la venta. Revisa los datos e intenta nuevamente.'
      : directSaleErrorMessage(reason),
  };
}

function buildOrderItemNotes(input: {
  notes?: string | null;
  editableDetailLines?: string[] | null;
}) {
  const lines = [
    String(input.notes || '').trim(),
    ...(input.editableDetailLines ?? []).map((line) => String(line || '').trim()),
  ].filter(Boolean);

  return lines.length > 0 ? lines.join('\n') : null;
}

function buildCounterCaracasTimestamp(isoDate: string, timeValue: string | null | undefined) {
  const date = String(isoDate || '').trim();
  const rawTime = String(timeValue || '').trim();
  const time = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : '23:59';
  const parsed = new Date(`${date}T${time}:00-04:00`);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('La fecha y hora del cierre no son validas.');
  }

  return parsed.toISOString();
}

export async function applyCounterPaymentAction(
  input: CounterPaymentIntent
): Promise<CounterPaymentOperationResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function giveCounterOrderChangeAction(
  input: CounterGiveChangeIntent
): Promise<CounterGiveChangeResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function waiveCounterOrderChangeAction(
  input: CounterWaiveChangeIntent
): Promise<CounterWaiveChangeResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function requestCounterRefundAction(
  input: CounterRefundRequestIntent
): Promise<CounterRefundRequestResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function executeCounterRefundAction(
  input: CounterRefundExecutionIntent
): Promise<CounterRefundExecutionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function normalizeCounterDeliveryValueLines(
  lines: CounterDeliveryValueLine[],
  label: string
) {
  if (!Array.isArray(lines) || lines.length > 12) {
    throw new Error(`${label} no puede tener mas de doce lineas.`);
  }

  return lines.map((line) => {
    const lineKey = String(line.lineKey || '').trim();
    const currencyCode = line.currencyCode === 'VES' ? 'VES' : 'USD';
    const amount = roundCounterMoney(line.amount);
    const exchangeRate =
      currencyCode === 'VES' ? Number(line.exchangeRateVesPerUsd || 0) : null;

    if (!lineKey || amount <= 0) {
      throw new Error(`Revisa el identificador y monto de ${label.toLocaleLowerCase('es-VE')}.`);
    }
    if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate) || Number(exchangeRate) <= 0)) {
      throw new Error(`${label} en bolivares requiere una tasa valida.`);
    }

    return {
      line_key: lineKey,
      currency_code: currencyCode,
      amount,
      exchange_rate_ves_per_usd: currencyCode === 'VES' ? Number(exchangeRate) : null,
      reference_code: String(line.referenceCode || '').trim() || null,
      notes: String(line.notes || '').trim() || null,
    };
  });
}

function normalizeCounterDeliveryCashLines(
  lines: CounterDeliveryCashLine[],
  label: string
) {
  const valueLines = normalizeCounterDeliveryValueLines(lines, label);

  return valueLines.map((line, index) => {
    const source = lines[index];
    const moneyAccountId = Math.trunc(Number(source.moneyAccountId || 0));
    const operationDate = String(source.operationDate || '').trim();

    if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
      throw new Error(`${label} requiere una caja valida.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) {
      throw new Error(`${label} requiere una fecha de operacion valida.`);
    }

    return {
      ...line,
      money_account_id: moneyAccountId,
      operation_date: operationDate,
    };
  });
}

export async function dispatchCounterDeliveryAction(
  input: CounterDeliveryDispatchIntent
): Promise<CounterDeliveryDispatchResult | { status: 'rejected'; message: string }> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function recordCounterDeliveryReturnAction(
  input: CounterDeliveryReturnIntent
): Promise<CounterDeliveryReturnResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

async function executeCounterQuickSaleAction(
  input: CounterDirectSaleIntent
): Promise<CounterDirectSaleResult> {
  const ctx = await requireCounterOperatorContext();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!isUuid(idempotencyKey)) {
    throw new Error('La venta no tiene un identificador valido.');
  }

  const items = (input.items || []).map((item) => ({
    productId: Math.trunc(Number(item.productId || 0)),
    qty: Number(item.qty || 0),
    notes: String(item.notes || '').trim() || null,
    editableDetailLines: Array.isArray(item.editableDetailLines)
      ? item.editableDetailLines.map((line) => String(line || '').trim()).filter(Boolean)
      : [],
  }));

  if (items.length === 0) throw new Error('Agrega al menos un producto.');
  if (items.some((item) => item.productId <= 0 || !Number.isFinite(item.qty) || item.qty <= 0)) {
    throw new Error('Uno de los productos tiene una cantidad invalida.');
  }

  const payload = {
    clientId: input.clientId ?? null,
    clientName: String(input.clientName || '').trim(),
    clientPhone: String(input.clientPhone || '').trim(),
    clientType:
      input.clientType === 'assigned' || input.clientType === 'legacy'
        ? input.clientType
        : 'own',
    fulfillment: input.fulfillment === 'delivery' ? 'delivery' : 'pickup',
    deliveryAddress: String(input.deliveryAddress || '').trim(),
    deliveryGpsUrl: String(input.deliveryGpsUrl || '').trim(),
    receiverName: String(input.receiverName || '').trim(),
    receiverPhone: String(input.receiverPhone || '').trim(),
    note: String(input.note || '').trim(),
    scheduleAsap: Boolean(input.scheduleAsap),
    scheduledDate: String(input.scheduledDate || '').trim(),
    scheduledTime: String(input.scheduledTime || '').trim(),
    paymentMethod: String(input.paymentMethod || '').trim(),
    paymentCurrency: input.paymentCurrency === 'USD' ? 'USD' : 'VES',
    paymentRequiresChange: Boolean(input.paymentRequiresChange),
    paymentChangeFor: String(input.paymentChangeFor || '').trim(),
    paymentChangeCurrency: input.paymentChangeCurrency === 'VES' ? 'VES' : 'USD',
    paymentNote: String(input.paymentNote || '').trim(),
    discountRuleId:
      input.discountRuleId == null ? null : Math.trunc(Number(input.discountRuleId)),
    hasDeliveryNote: Boolean(input.hasDeliveryNote),
    hasInvoice: Boolean(input.hasInvoice),
    invoiceTaxPct: String(input.invoiceTaxPct ?? '16').trim(),
    invoiceDataNote: String(input.invoiceDataNote || '').trim(),
    invoiceCompanyName: String(input.invoiceCompanyName || '').trim(),
    invoiceTaxId: String(input.invoiceTaxId || '').trim(),
    invoiceAddress: String(input.invoiceAddress || '').trim(),
    invoicePhone: String(input.invoicePhone || '').trim(),
    deliveryNoteName: String(input.deliveryNoteName || '').trim(),
    deliveryNoteDocumentId: String(input.deliveryNoteDocumentId || '').trim(),
    deliveryNoteAddress: String(input.deliveryNoteAddress || '').trim(),
    deliveryNotePhone: String(input.deliveryNotePhone || '').trim(),
    items,
  };

  const inventoryProductIds = Array.from(new Set([
    ...items.map((item) => item.productId),
    ...items.flatMap((item) => item.editableDetailLines.flatMap((line) => {
      const match = line.match(/^@sel\|([1-9][0-9]*)\|/);
      return match ? [Number(match[1])] : [];
    })),
  ])).slice(0, 200);
  const targetAt = input.scheduleAsap
    ? new Date().toISOString()
    : `${String(input.scheduledDate || '').trim()}T${String(input.scheduledTime || '').trim()}:00-04:00`;
  const { data: availabilityData, error: availabilityError } = await ctx.supabase.rpc(
    'inventory_catalog_availability_v1',
    {
      p_target_at: targetAt,
      p_product_ids: inventoryProductIds,
      p_surface: 'counter_inventory',
    },
  );
  if (!availabilityError) {
    const availabilityRows = Array.isArray(availabilityData?.products)
      ? availabilityData.products as Array<{
          product_id?: number;
          availability_state?: string;
          inventory_blocks_submission?: boolean;
          is_commercially_suspended?: boolean;
          protected_balance_active?: boolean;
          protected_maximum_quantity?: number | null;
          protected_available_component_units?: number | null;
        }>
      : [];
    if (availabilityRows.some(
      (row) => row.is_commercially_suspended === true
        || row.availability_state === 'declared_unavailable',
    )) {
      throw new Error('counter_product_suspended');
    }
    const availabilityByProductId = new Map(
      availabilityRows.map((row) => [Number(row.product_id), row]),
    );
    const productQuantities = new Map<number, number>();
    const componentQuantities = new Map<number, number>();
    for (const item of items) {
      productQuantities.set(
        item.productId,
        (productQuantities.get(item.productId) ?? 0) + item.qty,
      );
      for (const line of item.editableDetailLines) {
        const match = line.match(/^@sel\|([1-9][0-9]*)\|([0-9]+(?:\.[0-9]+)?)$/);
        if (!match) continue;
        const componentId = Number(match[1]);
        const quantity = Number(match[2]);
        componentQuantities.set(
          componentId,
          (componentQuantities.get(componentId) ?? 0) + quantity,
        );
      }
    }
    const exceedsProductProtection = Array.from(productQuantities).some(([productId, quantity]) => {
      const availability = availabilityByProductId.get(productId);
      const maximum = Number(availability?.protected_maximum_quantity);
      return availability?.protected_balance_active === true
        && Number.isFinite(maximum)
        && quantity > maximum + 0.0001;
    });
    const exceedsComponentProtection = Array.from(componentQuantities).some(([productId, quantity]) => {
      const availability = availabilityByProductId.get(productId);
      const maximum = Number(availability?.protected_available_component_units);
      return availability?.protected_balance_active === true
        && Number.isFinite(maximum)
        && quantity > maximum + 0.0001;
    });
    if (exceedsProductProtection || exceedsComponentProtection) {
      throw new Error('counter_product_protected_balance');
    }
  }

  const { data, error } = await ctx.supabase.rpc('counter_create_direct_sale', {
    p_idempotency_key: idempotencyKey,
    p_payload: payload,
  });
  if (error) throw new Error(directSaleErrorMessage(error.message));
  const result = asRecord(data);
  const orderId = Math.trunc(toSafeNumber(result.id, 0));
  if (orderId <= 0) throw new Error('La venta se creo sin un numero de orden valido.');

  const { error: protectionError } = await ctx.supabase.rpc(
    'inventory_refresh_order_protected_allocations_v1',
    { p_order_id: orderId },
  );
  if (protectionError) throw new Error(protectionError.message);

  revalidatePath('/app/counter');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');

  return {
    id: orderId,
    orderNumber: String(result.orderNumber || ''),
    sentToKitchen: Boolean(result.sentToKitchen),
    scheduled: Boolean(result.scheduled),
    clientId: Math.trunc(toSafeNumber(result.clientId, 0)),
    clientCreated: Boolean(result.clientCreated),
    fxRate: toSafeNumber(result.fxRate, 0),
    subtotalUsd: roundCounterMoney(result.subtotalUsd),
    subtotalBs: roundCounterMoney(result.subtotalBs),
    totalUsd: roundCounterMoney(result.totalUsd),
    totalBs: roundCounterMoney(result.totalBs),
    discountRuleId:
      result.discountRuleId == null
        ? null
        : Math.trunc(toSafeNumber(result.discountRuleId, 0)),
    discountPct: toSafeNumber(result.discountPct, 0),
    openPaymentAfterCreate: Boolean(input.openPaymentAfterCreate),
  };
}

export async function createCounterQuickSaleAction(
  input: CounterDirectSaleIntent
): Promise<CounterDirectSaleActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateCounterPickupScheduleAction(
  input: CounterPickupScheduleIntent
): Promise<CounterPickupScheduleResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function changeCounterPickupItemsAction(
  input: CounterPickupItemChangeIntent
): Promise<CounterPickupItemChangeResult | { status: 'rejected'; message: string }> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function completeCounterPickupAction(input: {
  idempotencyKey: string;
  orderId: number;
  notes?: string | null;
}): Promise<CounterPickupCompletionResult | { status: 'rejected'; message: string }> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createCounterCashMovementAction(input: CounterCashMovementInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createCounterCashClosureAction(input: CounterCashClosureInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function searchCounterClientsAction(input: { query: string }): Promise<CounterClientSearchResult[]> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function searchCounterHistoricalOrdersAction(input: {
  query: string;
  cursor?: CounterHistoricalSearchCursor | null;
}): Promise<CounterHistoricalSearchPage> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadCounterDailyHistoryAction(input: {
  cursor?: CounterDailyHistoryCursor | null;
} = {}): Promise<CounterDailyHistoryPage> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
