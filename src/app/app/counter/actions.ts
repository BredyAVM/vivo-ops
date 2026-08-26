'use server';

import { revalidatePath } from 'next/cache';
import { requireCounterOperatorContext } from '@/lib/auth';
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
): Promise<CounterPaymentOperationResult> {
  const ctx = await requireCounterOperatorContext();
  const orderId = Math.trunc(Number(input.orderId || 0));
  const idempotencyKey = String(input.idempotencyKey || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('La orden indicada no es valida.');
  }
  if (!isUuid(idempotencyKey)) {
    throw new Error('La operacion de cobro no tiene una clave valida.');
  }
  if (!Array.isArray(input.paymentLines) || input.paymentLines.length < 1 || input.paymentLines.length > 12) {
    throw new Error('El cobro debe tener entre una y doce lineas de pago.');
  }
  if (!Array.isArray(input.changeLines) || input.changeLines.length > 12) {
    throw new Error('El cambio no puede tener mas de doce lineas.');
  }

  const paymentLines = input.paymentLines.map((line) => {
    const lineKey = String(line.lineKey || '').trim();
    const moneyAccountId = Math.trunc(Number(line.moneyAccountId || 0));
    const paymentMethod = String(line.paymentMethod || '').trim().toLowerCase();
    const currencyCode = line.currencyCode === 'VES' ? 'VES' : 'USD';
    const amount = roundCounterMoney(line.amount);
    const exchangeRate =
      currencyCode === 'VES' ? Number(line.exchangeRateVesPerUsd || 0) : null;
    const operationDate = String(line.operationDate || '').trim();
    const referenceCode = String(line.referenceCode || '').trim();

    if (!lineKey || !Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
      throw new Error('Una linea de pago no tiene cuenta o identificador valido.');
    }
    if (!paymentMethod || amount <= 0) {
      throw new Error('Una linea de pago no tiene metodo o monto valido.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) {
      throw new Error('Indica una fecha de operacion valida en cada pago.');
    }
    if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate) || Number(exchangeRate) <= 0)) {
      throw new Error('Cada pago en bolivares requiere una tasa valida.');
    }
    if (paymentMethod === 'pos' && !/^\d{4}$/.test(referenceCode)) {
      throw new Error('Cada pago por punto requiere los ultimos cuatro digitos de la referencia.');
    }

    return {
      line_key: lineKey,
      money_account_id: moneyAccountId,
      payment_method: paymentMethod,
      currency_code: currencyCode,
      amount,
      exchange_rate_ves_per_usd: currencyCode === 'VES' ? Number(exchangeRate) : null,
      operation_date: operationDate,
      reference_code: referenceCode || null,
      bank_name: String(line.bankName || '').trim() || null,
      payer_name: String(line.payerName || '').trim() || null,
      notes: String(line.notes || '').trim() || null,
    };
  });

  const changeLines = input.changeLines.map((line) => {
    const lineKey = String(line.lineKey || '').trim();
    const changeMode = line.changeMode === 'digital_pending' ? 'digital_pending' : 'cash';
    const moneyAccountId =
      line.moneyAccountId == null ? null : Math.trunc(Number(line.moneyAccountId || 0));
    const paymentMethod = String(line.paymentMethod || '').trim().toLowerCase() || null;
    const currencyCode = line.currencyCode === 'VES' ? 'VES' : 'USD';
    const amount = roundCounterMoney(line.amount);
    const exchangeRate =
      currencyCode === 'VES' ? Number(line.exchangeRateVesPerUsd || 0) : null;

    if (!lineKey || amount <= 0) {
      throw new Error('Una linea de cambio no tiene identificador o monto valido.');
    }
    if (changeMode === 'cash' && (!moneyAccountId || moneyAccountId <= 0)) {
      throw new Error('Cada cambio en efectivo requiere una caja valida.');
    }
    if (changeMode === 'digital_pending' && !paymentMethod) {
      throw new Error('Cada cambio digital requiere indicar el metodo solicitado.');
    }
    if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate) || Number(exchangeRate) <= 0)) {
      throw new Error('Cada cambio en bolivares requiere una tasa valida.');
    }

    return {
      line_key: lineKey,
      change_mode: changeMode,
      money_account_id: changeMode === 'cash' ? moneyAccountId : null,
      payment_method: changeMode === 'digital_pending' ? paymentMethod : null,
      currency_code: currencyCode,
      amount,
      exchange_rate_ves_per_usd: currencyCode === 'VES' ? Number(exchangeRate) : null,
      notes: String(line.notes || '').trim() || null,
    };
  });

  const overpaymentHandling =
    input.overpaymentHandling === 'store_fund' || input.overpaymentHandling === 'change_given'
      ? input.overpaymentHandling
      : null;

  const { data, error } = await ctx.supabase.rpc('counter_apply_order_payments', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_payment_lines: paymentLines,
    p_overpayment_handling: overpaymentHandling,
    p_change_lines: changeLines,
    p_notes: String(input.notes || '').trim() || null,
  });

  if (error) throw new Error(error.message);
  const result = asRecord(data);
  const reports = Array.isArray(result.reports) ? result.reports.map(asRecord) : [];
  const confirmedReportCount = reports.filter((report) => report.status === 'confirmed').length;
  const pendingReportCount = reports.filter((report) => report.status === 'pending').length;

  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');

  return {
    ok: true,
    idempotencyKey,
    orderId,
    reportCount: reports.length,
    confirmedReportCount,
    pendingReportCount,
    confirmedPaymentUsd: roundCounterMoney(result.confirmed_payment_usd),
    pendingPaymentUsd: roundCounterMoney(result.pending_payment_usd),
    cashChangeUsd: roundCounterMoney(result.cash_change_usd),
    digitalChangePendingUsd: roundCounterMoney(result.digital_change_pending_usd),
    fundCreditUsd: roundCounterMoney(result.fund_credit_usd),
    pendingUsd: roundCounterMoney(result.pending_usd),
    overpaidUsd: roundCounterMoney(result.overpaid_usd),
  };
}

export async function giveCounterOrderChangeAction(
  input: CounterGiveChangeIntent
): Promise<CounterGiveChangeResult> {
  const ctx = await requireCounterOperatorContext();
  const orderId = Math.trunc(Number(input.orderId || 0));
  const moneyAccountId = Math.trunc(Number(input.moneyAccountId || 0));
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const amount = roundCounterMoney(input.amount);
  const operationDate = String(input.operationDate || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('La orden indicada no es valida.');
  }
  if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Selecciona una caja valida para entregar el cambio.');
  }
  if (!isUuid(idempotencyKey)) {
    throw new Error('La entrega de cambio no tiene una clave valida.');
  }
  if (amount <= 0) {
    throw new Error('El monto del cambio debe ser mayor que cero.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) {
    throw new Error('Indica una fecha valida para entregar el cambio.');
  }

  const { data, error } = await ctx.supabase.rpc('counter_give_order_change', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_money_account_id: moneyAccountId,
    p_amount: amount,
    p_operation_date: operationDate,
    p_notes: String(input.notes || '').trim() || null,
  });

  if (error) throw new Error(error.message);
  const result = asRecord(data);

  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');

  return {
    ok: true,
    idempotencyKey: String(result.idempotency_key || idempotencyKey),
    orderId: Math.trunc(Number(result.order_id || orderId)),
    movementId: Math.trunc(Number(result.movement_id || 0)),
    moneyAccountId: Math.trunc(Number(result.money_account_id || moneyAccountId)),
    accountName: String(result.account_name || 'Caja'),
    currencyCode: result.currency_code === 'VES' ? 'VES' : 'USD',
    amount: roundCounterMoney(result.amount),
    exchangeRateVesPerUsd:
      result.exchange_rate_ves_per_usd == null
        ? null
        : Number(result.exchange_rate_ves_per_usd),
    amountUsdEquivalent: roundCounterMoney(result.amount_usd_equivalent),
    remainingChangeUsd: roundCounterMoney(result.remaining_change_usd),
  };
}

export async function waiveCounterOrderChangeAction(
  input: CounterWaiveChangeIntent
): Promise<CounterWaiveChangeResult> {
  const ctx = await requireCounterOperatorContext();
  const orderId = Math.trunc(Number(input.orderId || 0));
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const expectedAmountUsd = roundCounterMoney(input.expectedAmountUsd);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('La orden indicada no es valida.');
  }
  if (!isUuid(idempotencyKey)) {
    throw new Error('El cierre de la diferencia no tiene una clave valida.');
  }
  if (expectedAmountUsd <= 0 || expectedAmountUsd > 1) {
    throw new Error('Counter solo puede cerrar diferencias de hasta $1,00.');
  }

  const { data, error } = await ctx.supabase.rpc('counter_waive_order_change', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_expected_amount_usd: expectedAmountUsd,
    p_notes: String(input.notes || '').trim() || null,
  });

  if (error) {
    const message = String(error.message || '');
    if (message.includes('no change remainder')) {
      throw new Error('Esta orden ya no tiene una diferencia pendiente.');
    }
    if (message.includes('remainder changed')) {
      throw new Error('La diferencia cambió. Cierra y vuelve a abrir el cobro para revisar el monto actual.');
    }
    if (message.includes('up to 1.00 USD')) {
      throw new Error('Counter solo puede cerrar diferencias de hasta $1,00.');
    }
    throw new Error(message || 'No se pudo cerrar la diferencia.');
  }

  const result = asRecord(data);

  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');

  return {
    ok: true,
    idempotencyKey: String(result.idempotency_key || idempotencyKey),
    orderId: Math.trunc(Number(result.order_id || orderId)),
    waivedAmountUsd: roundCounterMoney(result.waived_amount_usd),
    fundMovementId: Math.trunc(Number(result.fund_movement_id || 0)),
    adjustmentId: Math.trunc(Number(result.adjustment_id || 0)),
    remainingChangeUsd: roundCounterMoney(result.remaining_change_usd),
  };
}

export async function requestCounterRefundAction(
  input: CounterRefundRequestIntent
): Promise<CounterRefundRequestResult> {
  const ctx = await requireCounterOperatorContext();
  const orderId = Math.trunc(Number(input.orderId || 0));
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const reason = String(input.reason || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('La orden indicada no es valida.');
  }
  if (!isUuid(idempotencyKey)) {
    throw new Error('La solicitud de devolucion no tiene una clave valida.');
  }
  if (!reason) {
    throw new Error('La devolucion requiere un motivo.');
  }
  if (!Array.isArray(input.refundLines) || input.refundLines.length < 1 || input.refundLines.length > 12) {
    throw new Error('La devolucion debe tener entre una y doce lineas.');
  }

  const refundLines = input.refundLines.map((line) => {
    const lineKey = String(line.lineKey || '').trim();
    const moneyAccountId = Math.trunc(Number(line.moneyAccountId || 0));
    const currencyCode = line.currencyCode === 'VES' ? 'VES' : 'USD';
    const amount = roundCounterMoney(line.amount);
    const exchangeRate =
      currencyCode === 'VES' ? Number(line.exchangeRateVesPerUsd || 0) : null;

    if (!lineKey || !Number.isFinite(moneyAccountId) || moneyAccountId <= 0 || amount <= 0) {
      throw new Error('Revisa la cuenta y el monto de cada devolucion.');
    }
    if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate) || Number(exchangeRate) <= 0)) {
      throw new Error('Cada devolucion en bolivares requiere una tasa valida.');
    }

    return {
      line_key: lineKey,
      money_account_id: moneyAccountId,
      currency_code: currencyCode,
      amount,
      exchange_rate_ves_per_usd: currencyCode === 'VES' ? Number(exchangeRate) : null,
      reference_code: String(line.referenceCode || '').trim() || null,
      notes: String(line.notes || '').trim() || null,
    };
  });

  const { data, error } = await ctx.supabase.rpc('counter_request_refund', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_refund_lines: refundLines,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  const result = asRecord(data);
  const movementGroupId = String(result.movement_group_id || idempotencyKey);

  revalidatePath('/app/master/ops');

  return {
    ok: true,
    idempotencyKey,
    movementGroupId,
    status: 'pending',
    amountUsdEquivalent: roundCounterMoney(result.amount_usd_equivalent),
  };
}

export async function executeCounterRefundAction(
  input: CounterRefundExecutionIntent
): Promise<CounterRefundExecutionResult> {
  const ctx = await requireCounterOperatorContext();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const refundGroupId = String(input.refundGroupId || '').trim();
  const operationDate = String(input.operationDate || '').trim();

  if (!isUuid(idempotencyKey) || !isUuid(refundGroupId)) {
    throw new Error('La devolucion no tiene identificadores validos.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) {
    throw new Error('Indica una fecha valida para ejecutar la devolucion.');
  }

  const { data, error } = await ctx.supabase.rpc('counter_execute_refund', {
    p_idempotency_key: idempotencyKey,
    p_refund_group_id: refundGroupId,
    p_operation_date: operationDate,
    p_execution_notes: String(input.notes || '').trim() || null,
  });
  if (error) throw new Error(error.message);
  const result = asRecord(data);

  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');

  return {
    ok: true,
    idempotencyKey,
    movementGroupId: String(result.movement_group_id || refundGroupId),
    status: 'executed',
    amountUsdEquivalent: roundCounterMoney(result.amount_usd_equivalent),
  };
}

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
): Promise<CounterDeliveryDispatchResult> {
  const ctx = await requireCounterOperatorContext();
  const orderId = Math.trunc(Number(input.orderId || 0));
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const etaMinutes = Math.round(Number(input.etaMinutes || 0));

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('La orden indicada no es valida.');
  }
  if (!isUuid(idempotencyKey)) {
    throw new Error('La salida de delivery no tiene una clave valida.');
  }
  if (!Number.isFinite(etaMinutes) || etaMinutes < 1 || etaMinutes > 1440) {
    throw new Error('El tiempo estimado debe estar entre 1 y 1440 minutos.');
  }

  const expectedCollectionLines = normalizeCounterDeliveryValueLines(
    input.expectedCollectionLines,
    'El cobro esperado'
  );
  const cashChangeLines = normalizeCounterDeliveryCashLines(
    input.cashChangeLines,
    'El cambio en efectivo'
  );
  const digitalBaseLines = normalizeCounterDeliveryValueLines(
    input.digitalChangeLines,
    'El cambio digital'
  );
  const digitalChangeLines = digitalBaseLines.map((line, index) => {
    const method = input.digitalChangeLines[index].paymentMethodCode;
    if (!['payment_mobile', 'transfer', 'zelle', 'other'].includes(method)) {
      throw new Error('El cambio digital requiere un metodo valido.');
    }
    return { ...line, payment_method_code: method };
  });

  const { data, error } = await ctx.supabase.rpc('counter_dispatch_delivery', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_eta_minutes: etaMinutes,
    p_expected_collection_lines: expectedCollectionLines,
    p_cash_change_lines: cashChangeLines,
    p_digital_change_lines: digitalChangeLines,
    p_notes: String(input.notes || '').trim() || null,
  });

  if (error) {
    if (error.message.includes('counter_delivery_expected_collection_required')) {
      throw new Error('La orden prescribe efectivo o cambio. Debes conservar el cobro esperado para abrir su liquidacion.');
    }
    throw new Error(error.message);
  }
  const result = asRecord(data);

  revalidatePath('/app/counter');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');

  return {
    ok: true,
    orderId,
    orderStatus: 'out_for_delivery',
    deliverySettlementId: Math.trunc(toSafeNumber(result.delivery_settlement_id, 0)),
    settlementStatus: String(result.settlement_status || 'open') as CounterDeliveryDispatchResult['settlementStatus'],
    etaMinutes,
    expectedCollectionUsd: roundCounterMoney(result.expected_collection_usd),
    cashChangeUsd: roundCounterMoney(result.cash_change_usd),
    digitalChangeUsd: roundCounterMoney(result.digital_change_usd),
    requiredChangeUsd: roundCounterMoney(result.required_change_usd),
  };
}

export async function recordCounterDeliveryReturnAction(
  input: CounterDeliveryReturnIntent
): Promise<CounterDeliveryReturnResult> {
  const ctx = await requireCounterOperatorContext();
  const orderId = Math.trunc(Number(input.orderId || 0));
  const idempotencyKey = String(input.idempotencyKey || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('La orden indicada no es valida.');
  }
  if (!isUuid(idempotencyKey)) {
    throw new Error('El retorno de delivery no tiene una clave valida.');
  }

  const customerCollectionLines = normalizeCounterDeliveryValueLines(
    input.customerCollectionLines,
    'El cobro recibido por el motorizado'
  );
  const cashReturnLines = normalizeCounterDeliveryCashLines(
    input.cashReturnLines,
    'El efectivo entregado a caja'
  );

  if (
    customerCollectionLines.length === 0 &&
    cashReturnLines.length === 0 &&
    !input.collectionFinal
  ) {
    throw new Error('Agrega un cobro, un retorno de efectivo o marca la cobranza como final.');
  }

  const { data, error } = await ctx.supabase.rpc('counter_record_delivery_return', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_customer_collection_lines: customerCollectionLines,
    p_cash_return_lines: cashReturnLines,
    p_collection_final: Boolean(input.collectionFinal),
    p_notes: String(input.notes || '').trim() || null,
  });

  if (error) throw new Error(error.message);
  const result = asRecord(data);

  revalidatePath('/app/counter');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');

  return {
    ok: true,
    orderId,
    deliverySettlementId: Math.trunc(toSafeNumber(result.delivery_settlement_id, 0)),
    settlementStatus: String(result.settlement_status || 'open') as CounterDeliveryReturnResult['settlementStatus'],
    collectionFinal: Boolean(result.collection_final),
  };
}

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
      ? availabilityData.products as Array<{ inventory_blocks_submission?: boolean }>
      : [];
    if (availabilityRows.some((row) => row.inventory_blocks_submission === true)) {
      throw new Error('counter_product_suspended');
    }
  }

  const { data, error } = await ctx.supabase.rpc('counter_create_direct_sale', {
    p_idempotency_key: idempotencyKey,
    p_payload: payload,
  });
  if (error) throw new Error(error.message);
  const result = asRecord(data);
  const orderId = Math.trunc(toSafeNumber(result.id, 0));
  if (orderId <= 0) throw new Error('La venta se creo sin un numero de orden valido.');

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
): Promise<CounterDirectSaleActionResult> {
  try {
    return {
      ok: true,
      sale: await executeCounterQuickSaleAction(input),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const failure = directSaleFailure(message);
    console.error(JSON.stringify({
      level: 'error',
      message: 'counter_direct_sale_failed',
      reason: failure.reason,
    }));
    return failure;
  }
}

export async function updateCounterPickupScheduleAction(
  input: CounterPickupScheduleIntent
): Promise<CounterPickupScheduleResult> {
  const ctx = await requireCounterOperatorContext();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const orderId = Number(input.orderId || 0);
  const scheduledDate = String(input.scheduledDate || '').trim();
  const scheduledTime = String(input.scheduledTime || '').trim();
  const reason = String(input.reason || '').trim();

  if (!isUuid(idempotencyKey)) throw new Error('La correccion no tiene un identificador valido.');
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Orden invalida.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) throw new Error('Indica una fecha valida.');
  if (!/^\d{2}:\d{2}$/.test(scheduledTime)) throw new Error('Indica una hora valida.');
  if (reason.length < 4) throw new Error('Indica el motivo de la correccion.');

  const { data, error } = await ctx.supabase.rpc('counter_update_pickup_schedule', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_schedule_date: scheduledDate,
    p_schedule_time: scheduledTime,
    p_reason: reason,
    p_send_to_kitchen: Boolean(input.sendToKitchen),
  });
  if (error) throw new Error(error.message);
  const result = asRecord(data);

  revalidatePath('/app/counter');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');

  return {
    status: result.status === 'sent_to_kitchen' ? 'sent_to_kitchen' : 'schedule_updated',
    orderId: Math.trunc(toSafeNumber(result.orderId, orderId)),
    scheduleDate: String(result.scheduleDate || scheduledDate),
    scheduleTime: String(result.scheduleTime || scheduledTime),
    sentToKitchen: Boolean(result.sentToKitchen),
  };
}

export async function changeCounterPickupItemsAction(
  input: CounterPickupItemChangeIntent
): Promise<CounterPickupItemChangeResult> {
  const ctx = await requireCounterOperatorContext();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const orderId = Number(input.orderId || 0);
  const existingItems = (input.existingItems || []).map((item) => ({
    item_id: Number(item.itemId || 0),
    qty: Number(item.qty),
  }));
  const addedItems = (input.addedItems || [])
    .map((item) => ({
      product_id: Number(item.productId || 0),
      qty: Math.max(0, Number(item.qty || 0)),
      notes: buildOrderItemNotes(item),
    }))
    .filter((item) => item.product_id > 0 && item.qty > 0);

  if (!isUuid(idempotencyKey)) throw new Error('El cambio no tiene un identificador valido.');
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Orden invalida.');
  if (
    existingItems.some(
      (item) =>
        !Number.isSafeInteger(item.item_id) ||
        item.item_id <= 0 ||
        !Number.isFinite(item.qty) ||
        item.qty < 0 ||
        item.qty > 999
    )
  ) {
    throw new Error('Una linea actual no es valida.');
  }

  const { data, error } = await ctx.supabase.rpc('counter_change_pickup_items', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_existing_items: existingItems,
    p_added_items: addedItems,
    p_reason: String(input.reason || '').trim() || null,
  });
  if (error) throw new Error(error.message);
  const result = asRecord(data);

  revalidatePath('/app/counter');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');

  return {
    status: result.status === 'pending_approval' ? 'pending_approval' : 'applied',
    orderId: Math.trunc(toSafeNumber(result.orderId, orderId)),
    requestId: result.requestId == null ? null : Math.trunc(toSafeNumber(result.requestId, 0)),
    returnedToKitchen: Boolean(result.returnedToKitchen),
    totalUsd: roundCounterMoney(result.totalUsd),
    totalBs: roundCounterMoney(result.totalBs),
  };
}

export async function completeCounterPickupAction(input: {
  idempotencyKey: string;
  orderId: number;
  notes?: string | null;
}): Promise<CounterPickupCompletionResult> {
  const ctx = await requireCounterOperatorContext();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const orderId = Math.trunc(Number(input.orderId || 0));

  if (!isUuid(idempotencyKey)) throw new Error('La entrega no tiene un identificador valido.');
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Orden invalida.');

  const { data, error } = await ctx.supabase.rpc('counter_complete_pickup', {
    p_idempotency_key: idempotencyKey,
    p_order_id: orderId,
    p_notes: String(input.notes || '').trim() || null,
  });
  if (error) throw new Error(error.message);
  const result = asRecord(data);

  revalidatePath('/app/counter');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/inbox');

  return {
    status: 'delivered',
    orderId: Math.trunc(toSafeNumber(result.orderId, orderId)),
    deliveredAt: String(result.deliveredAt || new Date().toISOString()),
    paymentStatus: String(result.paymentStatus || 'unpaid'),
    pendingUsd: roundCounterMoney(result.pendingUsd),
    pendingReportsCount: Math.max(0, Math.trunc(toSafeNumber(result.pendingReportsCount, 0))),
    advisorResponsibleForCollection: Boolean(result.advisorResponsibleForCollection),
  };
}

export async function createCounterCashMovementAction(input: CounterCashMovementInput) {
  const ctx = await requireCounterOperatorContext();

  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const direction = input.direction === 'outflow' ? 'outflow' : 'inflow';
  const moneyAccountId = Math.trunc(Number(input.moneyAccountId || 0));
  const amount = Number(input.amount || 0);
  const movementDate = String(input.movementDate || '').trim();
  const referenceCode = String(input.referenceCode || '').trim() || null;
  const counterpartyName = String(input.counterpartyName || '').trim() || null;
  const description = String(input.description || '').trim();
  const notes = String(input.notes || '').trim() || null;

  if (!isUuid(idempotencyKey)) {
    throw new Error('El movimiento no tiene un identificador valido.');
  }
  if (!Number.isSafeInteger(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Debes seleccionar una cuenta.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('El monto debe ser mayor a 0.');
  }
  if (!movementDate || !/^\d{4}-\d{2}-\d{2}$/.test(movementDate)) {
    throw new Error('Debes indicar una fecha valida.');
  }
  if (!description) {
    throw new Error('Debes indicar el motivo.');
  }

  const { data, error } = await ctx.supabase.rpc('counter_record_manual_movement', {
    p_idempotency_key: idempotencyKey,
    p_direction: direction,
    p_money_account_id: moneyAccountId,
    p_amount: Number(amount.toFixed(2)),
    p_movement_date: movementDate,
    p_exchange_rate_ves_per_usd: input.exchangeRateVesPerUsd,
    p_reference_code: referenceCode,
    p_counterparty_name: counterpartyName,
    p_description: description,
    p_notes: notes,
  });

  if (error) throw new Error(error.message);
  const result = asRecord(data);
  const currencyCode = result.currency_code === 'VES' ? 'VES' as const : 'USD' as const;
  const status = result.status === 'pending' ? 'pending' as const : 'confirmed' as const;

  revalidatePath('/app/counter');

  return {
    ok: true,
    movementId: Math.trunc(toSafeNumber(result.movement_id, 0)),
    movementGroupId: String(result.movement_group_id || idempotencyKey),
    status,
    approvalRequired: Boolean(result.approval_required),
    approvalReason:
      result.approval_required_reason == null
        ? null
        : String(result.approval_required_reason),
    amount: roundCounterMoney(result.amount),
    currencyCode,
    exchangeRateVesPerUsd:
      result.exchange_rate_ves_per_usd == null
        ? null
        : toSafeNumber(result.exchange_rate_ves_per_usd, 0),
    amountUsdEquivalent: roundCounterMoney(result.amount_usd_equivalent),
  };
}

export async function createCounterCashClosureAction(input: CounterCashClosureInput) {
  const ctx = await requireCounterOperatorContext();

  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const moneyAccountId = Math.trunc(Number(input.moneyAccountId || 0));
  const closureDate = String(input.closureDate || '').trim();
  const closureTime = String(input.closureTime || '').trim();
  const closureAt = buildCounterCaracasTimestamp(closureDate, closureTime);
  const countedAmount = Number(input.countedAmount || 0);
  const reason = String(input.reason || '').trim();
  const notes = String(input.notes || '').trim() || null;

  if (!isUuid(idempotencyKey)) {
    throw new Error('El cierre no tiene un identificador valido.');
  }
  if (!Number.isSafeInteger(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Debes seleccionar una cuenta.');
  }
  if (!closureDate || !/^\d{4}-\d{2}-\d{2}$/.test(closureDate)) {
    throw new Error('Debes indicar una fecha valida.');
  }
  if (!/^\d{2}:\d{2}$/.test(closureTime)) {
    throw new Error('Debes indicar una hora valida.');
  }
  if (!Number.isFinite(countedAmount) || countedAmount < 0) {
    throw new Error('El monto contado no es valido.');
  }
  if (!reason) {
    throw new Error('Indica el motivo del cierre.');
  }

  const { data, error } = await ctx.supabase.rpc('counter_close_money_account', {
    p_idempotency_key: idempotencyKey,
    p_money_account_id: moneyAccountId,
    p_closure_at: closureAt,
    p_counted_amount: Number(countedAmount.toFixed(2)),
    p_exchange_rate_ves_per_usd: input.exchangeRateVesPerUsd,
    p_reason: reason,
    p_notes: notes,
  });

  if (error) throw new Error(error.message);
  const result = asRecord(data);
  const currencyCode = result.currency_code === 'VES' ? 'VES' as const : 'USD' as const;

  revalidatePath('/app/counter');
  return {
    ok: true,
    closureId: Math.trunc(toSafeNumber(result.closure_id, 0)),
    expectedAmount: roundCounterMoney(result.expected_amount),
    countedAmount: roundCounterMoney(result.counted_amount),
    differenceAmount: roundCounterMoney(result.difference_amount),
    currencyCode,
  };
}

export async function searchCounterClientsAction(input: { query: string }): Promise<CounterClientSearchResult[]> {
  const ctx = await requireCounterOperatorContext();

  const query = String(input.query || '').trim();
  if (query.length < 2) return [];
  const queryDigits = query.replace(/\D/g, '');
  const isPhoneQuery = queryDigits.length >= 7 && !/[a-záéíóúñ]/i.test(query);
  const normalizedQuery = isPhoneQuery ? queryDigits.slice(-7) : query;

  const { data, error } = await ctx.supabase.rpc('counter_search_clients', {
    p_query: normalizedQuery,
    p_cursor_id: null,
    p_limit: 10,
  });

  if (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'counter_client_search_failed',
      error: error.message,
    }));
    throw new Error('No se pudo consultar la base de clientes. Intenta nuevamente.');
  }

  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? data as { results?: unknown[] }
    : {};
  return Array.isArray(payload.results)
    ? payload.results.map(asRecord).map((client) => {
        const advisorSource = String(client.advisorSource || 'none');
        return {
          id: Math.trunc(toSafeNumber(client.id, 0)),
          fullName: String(client.fullName || 'Cliente'),
          phone: client.phone == null ? null : String(client.phone),
          clientType: client.clientType == null ? null : String(client.clientType),
          fundBalanceUsd: roundCounterMoney(client.fundBalanceUsd),
          advisorUserId: client.advisorUserId == null ? null : String(client.advisorUserId),
          advisorName: client.advisorName == null ? null : String(client.advisorName),
          advisorSource:
            advisorSource === 'primary' || advisorSource === 'last_order'
              ? advisorSource
              : 'none',
          advisorIsActive:
            client.advisorIsActive == null ? null : Boolean(client.advisorIsActive),
          advisorLastOrderAt:
            client.advisorLastOrderAt == null ? null : String(client.advisorLastOrderAt),
        } satisfies CounterClientSearchResult;
      }).filter((client) => client.id > 0)
    : [];
}

export async function searchCounterHistoricalOrdersAction(input: {
  query: string;
  cursor?: CounterHistoricalSearchCursor | null;
}): Promise<CounterHistoricalSearchPage> {
  const ctx = await requireCounterOperatorContext();

  const rawQuery = String(input.query || '').trim();
  if (rawQuery.length < 2 && !/^[0-9]$/.test(rawQuery)) {
    return { results: [], nextCursor: null };
  }
  const query = /^[0-9]$/.test(rawQuery) ? `0${rawQuery}` : rawQuery;

  const { data, error } = await ctx.supabase.rpc('counter_search_orders', {
    p_query: query,
    p_cursor_created_at: input.cursor?.createdAt || null,
    p_cursor_id: input.cursor?.id || null,
    p_limit: 10,
  });
  if (error) throw new Error(error.message);

  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Partial<CounterHistoricalSearchPage>
    : {};
  return {
    results: Array.isArray(payload.results) ? payload.results : [],
    nextCursor:
      payload.nextCursor &&
      typeof payload.nextCursor.createdAt === 'string' &&
      Number.isFinite(Number(payload.nextCursor.id))
        ? {
            createdAt: payload.nextCursor.createdAt,
            id: Number(payload.nextCursor.id),
          }
        : null,
  };
}

export async function loadCounterDailyHistoryAction(input: {
  cursor?: CounterDailyHistoryCursor | null;
} = {}): Promise<CounterDailyHistoryPage> {
  const ctx = await requireCounterOperatorContext();
  const cursor = input.cursor ?? null;

  if (cursor) {
    const deliveredAt = new Date(cursor.deliveredAt);
    const cursorId = Math.trunc(Number(cursor.id));
    if (Number.isNaN(deliveredAt.getTime()) || !Number.isFinite(cursorId) || cursorId <= 0) {
      throw new Error('El cursor del historial diario no es valido.');
    }
  }

  const { data, error } = await ctx.supabase.rpc('counter_list_today_delivered_orders', {
    p_cursor_delivered_at: cursor?.deliveredAt || null,
    p_cursor_id: cursor?.id || null,
    p_limit: 20,
  });
  if (error) throw new Error(error.message);

  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Partial<CounterDailyHistoryPage>
    : {};
  const nextCursor = payload.nextCursor;

  return {
    serviceDate: typeof payload.serviceDate === 'string' ? payload.serviceDate : '',
    results: Array.isArray(payload.results) ? payload.results : [],
    nextCursor:
      nextCursor &&
      typeof nextCursor.deliveredAt === 'string' &&
      Number.isFinite(Number(nextCursor.id))
        ? {
            deliveredAt: nextCursor.deliveredAt,
            id: Number(nextCursor.id),
          }
        : null,
  };
}
