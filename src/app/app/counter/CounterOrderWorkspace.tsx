'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  getOperationalStatusLabel,
  getPaymentMethodLabel,
} from '@/lib/orders/order-labels';
import {
  buildComponentDetailLines,
  getVisibleEditableDetailLines,
} from '@/lib/orders/order-composer';
import { calculateOrderLineSnapshot } from '@/lib/pricing/order-snapshots';
import { CounterPaymentEngine } from './CounterPaymentEngine';
import { CounterRefundPanel } from './CounterRefundPanel';
import {
  CounterDeliveryDispatchPanel,
  CounterDeliverySettlementBox,
} from './CounterDeliveryWorkspace';
import { requiresCounterDeliveryMoneyHandling } from './delivery-contract';
import type {
  CounterDeliveryDispatchIntent,
  CounterDeliveryDispatchResult,
} from './delivery-contract';
import type {
  CounterPaymentIntent,
  CounterPaymentOperationResult,
  CounterRefundExecutionIntent,
  CounterRefundExecutionResult,
  CounterRefundRequestIntent,
  CounterRefundRequestResult,
} from './payment-contract';
import type {
  CounterPickupChangeRequest,
  CounterPickupItemChangeIntent,
  CounterPickupItemChangeResult,
  CounterPickupScheduleIntent,
  CounterPickupScheduleResult,
} from './pickup-contract';
import type {
  CounterOrder,
  CounterPaymentAccountOption,
  CounterPaymentQuote,
  CounterQuickSaleProductComponent,
  CounterQuickSaleProductOption,
} from './CounterClient';

function CounterOperationDialog({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onCloseRef.current();
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="flex max-h-[96dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-[#303044] bg-[#101014] shadow-2xl sm:max-h-[92dvh] sm:rounded-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#242433] px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-[#F5F5F7]">{title}</div>
            <div className="truncate text-xs text-[#9FA0AA]">{subtitle}</div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="min-h-10 shrink-0 rounded-full border border-[#303044] px-4 py-2 text-xs font-semibold text-[#C7C8D1] hover:border-[#FEEF00]/60 hover:text-[#FEEF00]"
          >
            Cerrar
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-3 sm:p-5">{children}</div>
      </div>
    </div>
  );
}

type StableCommandKey = {
  fingerprint: string;
  key: string;
};

type CounterQuickSaleCartItem = {
  id: string;
  productId: number;
  qty: string;
  notes: string;
  editableDetailLines: string[];
};

function stableCommandKey(
  current: StableCommandKey | null,
  payload: unknown
): StableCommandKey {
  const fingerprint = JSON.stringify(payload);
  if (current?.fingerprint === fingerprint) return current;
  return {
    fingerprint,
    key: crypto.randomUUID(),
  };
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

function formatDateTime(value: string | null) {
  if (!value) return 'Sin hora';

  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function getTodayKey() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function toDecimalInput(value: string) {
  return Number(String(value || '').replace(',', '.'));
}

function paymentLabel(order: CounterOrder) {
  if (order.overpaidUsd > 0.005) return 'Saldo a favor';
  if (order.reports.pending > 0) return 'Pago por revisar';
  if (order.balanceUsd <= 0.005) return 'Pagado';
  if (order.confirmedPaidUsd > 0.005) return 'Abonado';
  return 'Pendiente';
}

function paymentClass(order: CounterOrder) {
  if (order.overpaidUsd > 0.005) return 'border-violet-400/40 bg-violet-400/10 text-violet-200';
  if (order.reports.pending > 0) return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
  if (order.balanceUsd <= 0.005) return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.confirmedPaidUsd > 0.005) return 'border-sky-400/40 bg-sky-400/10 text-sky-200';
  return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
}

function isCounterImmediatePaymentMethod(method: string | null | undefined) {
  const normalized = String(method || '').trim();
  return normalized === 'pos' || normalized === 'cash_usd' || normalized === 'cash_ves';
}

function mustSettleBeforeCounterDelivery(order: CounterOrder) {
  if (order.pendingDigitalChangeUsd > 0.005) return true;
  const hasUnconfirmedPayment = order.reports.pending > 0;
  if (order.balanceUsd <= 0.005 && !hasUnconfirmedPayment) return false;
  if (isCounterImmediatePaymentMethod(order.paymentMethod) && order.balanceUsd > 0.005) return true;
  if (order.hasAdvisor && hasUnconfirmedPayment) return false;
  return !order.hasAdvisor && (order.balanceUsd > 0.005 || hasUnconfirmedPayment);
}

function fulfillmentLabel(value: CounterOrder['fulfillment']) {
  return value === 'delivery' ? 'Delivery' : 'Pickup';
}

function counterStatusClass(order: CounterOrder) {
  if (order.status === 'delivered') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.status === 'cancelled') return 'border-red-400/40 bg-red-400/10 text-red-200';
  if (order.status === 'out_for_delivery') return 'border-sky-400/40 bg-sky-400/10 text-sky-200';
  if (order.status === 'in_kitchen') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.status === 'created') return 'border-purple-300/40 bg-purple-300/10 text-purple-100';
  if (order.status === 'queued' || order.status === 'confirmed') return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
  return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
}

function primaryCounterActionLabel(order: CounterOrder) {
  if (order.status === 'delivered') return 'Orden entregada';
  if (order.status === 'cancelled') return 'Orden cancelada';
  if (order.status === 'created') return 'Esperar Master';
  if (order.status === 'queued' || order.status === 'confirmed') return 'En cola de cocina';
  if (order.status === 'in_kitchen') return 'Esperar cocina';
  if (order.status === 'out_for_delivery') return 'Liquidar regreso';
  if (
    order.fulfillment === 'pickup'
    && order.status === 'ready'
    && mustSettleBeforeCounterDelivery(order)
  ) {
    if (order.pendingDigitalChangeUsd > 0.005) return 'Completar cambio';
    if (order.reports.pending > 0) return 'Esperar Master';
    return 'Cobrar ahora';
  }
  if (order.fulfillment === 'delivery' && order.status === 'ready') {
    return order.deliveryAssigneeName ? 'Entregar a motorizado' : 'Esperar asignación';
  }
  return 'Entregar pickup';
}

function deliveryAssigneeLabel(order: CounterOrder) {
  if (order.fulfillment !== 'delivery') return null;
  if (!order.deliveryAssigneeName) return 'Sin asignar';
  return order.deliveryAssigneeKind === 'external'
    ? `Externo: ${order.deliveryAssigneeName}`
    : `Interno: ${order.deliveryAssigneeName}`;
}

function getCounterCurrentAction(order: CounterOrder) {
  const paid = order.balanceUsd <= 0.005;
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);
  const requiresDeliveryMoneyHandling = requiresCounterDeliveryMoneyHandling(order);

  if (order.status === 'cancelled') {
    return {
      title: 'Orden cancelada',
      description: 'Mostrador puede consultar el expediente, pero no modificar ni cobrar esta orden.',
      tone: 'neutral' as const,
      steps: ['Informar al cliente', 'Escalar cualquier correccion a Master o Administracion'],
    };
  }

  if (order.status === 'delivered') {
    return {
      title: paid ? 'Orden entregada y pagada' : 'Cobro pendiente de una orden entregada',
      description: paid
        ? 'El expediente queda disponible solo para consulta operativa.'
        : 'Mostrador puede registrar el pago pendiente sin modificar la orden entregada.',
      tone: paid ? ('good' as const) : ('warn' as const),
      steps: paid
        ? ['Informar el estado al cliente']
        : ['Abrir Pago', 'Registrar el cobro', 'Mantener la orden sin cambios'],
    };
  }

  if (order.status === 'created') {
    return {
      title: 'Agendado para master',
      description: 'El pedido fue creado por mostrador para otro momento. Master debe enviarlo a cocina cuando corresponda.',
      tone: 'warn' as const,
      steps: ['Confirmar hora con el cliente', 'Mantenerlo en agenda', 'Esperar accion del master'],
    };
  }

  if (order.status === 'queued' || order.status === 'confirmed' || order.status === 'in_kitchen') {
    return {
      title: 'Seguimiento de cocina',
      description: 'El pedido todavia no debe entregarse. Mostrador solo informa el estado al cliente.',
      tone: 'neutral' as const,
      steps: ['Ver estado actual', 'Informar al cliente si pregunta', 'Esperar que cocina marque lista'],
    };
  }

  if (order.fulfillment === 'pickup' && order.status === 'ready') {
    return {
      title: paid ? 'Entregar pickup' : mustCollectNow ? 'Cobrar y entregar pickup' : 'Entregar pickup pendiente',
      description: paid
        ? 'El pedido esta listo y pagado. Solo falta entregarlo al cliente.'
        : mustCollectNow
          ? order.hasAdvisor
            ? 'El metodo esperado es efectivo o punto. Registra el cobro antes de entregar.'
            : 'El cliente no tiene asesor. El pago debe quedar confirmado por Master antes de entregar.'
          : 'El pedido puede entregarse pendiente; el asesor queda responsable del cobro.',
      tone: paid ? ('good' as const) : mustCollectNow ? ('warn' as const) : ('neutral' as const),
      steps: paid
        ? ['Validar cliente', 'Entregar pedido', 'Marcar retirado']
        : mustCollectNow
          ? order.hasAdvisor
            ? ['Registrar pago', 'Validar cliente', 'Entregar pedido y marcar retirado']
            : ['Registrar pago', 'Esperar confirmacion de Master', 'Entregar pedido']
          : ['Validar cliente', 'Entregar pedido', 'Marcar retirado como pendiente'],
    };
  }

  if (order.fulfillment === 'delivery' && order.status === 'ready' && !order.deliveryAssigneeName) {
    return {
      title: 'Falta asignacion de delivery',
      description: 'La orden esta lista, pero no debe salir hasta que master asigne motorizado o partner.',
      tone: 'warn' as const,
      steps: ['Avisar a master', 'Esperar asignacion', 'Entregar al motorizado cuando este asignado'],
    };
  }

  if (order.fulfillment === 'delivery' && order.status === 'ready') {
    return {
      title: order.paymentRequiresChange
        ? 'Preparar cambio y entregar'
        : requiresDeliveryMoneyHandling
          ? 'Preparar cobro y entregar'
          : 'Entregar al motorizado',
      description: order.paymentRequiresChange
        ? 'Prepara el cambio indicado antes de entregar el pedido al motorizado.'
        : requiresDeliveryMoneyHandling
          ? 'La orden indica cobro en efectivo. Confirma el monto y el ETA antes de la salida.'
          : order.hasAdvisor && order.balanceUsd > 0.005
            ? 'La orden no indica efectivo ni cambio. El asesor mantiene la cobranza; Mostrador solo registra la salida y el ETA.'
            : 'El pedido esta listo para salir con el motorizado asignado.',
      tone: requiresDeliveryMoneyHandling ? ('warn' as const) : ('good' as const),
      steps: requiresDeliveryMoneyHandling
        ? [
            order.paymentRequiresChange ? 'Preparar cambio' : 'Confirmar cobro esperado',
            'Preguntar ETA',
            'Entregar pedido y marcar en camino',
          ]
        : ['Validar motorizado', 'Preguntar ETA', 'Entregar pedido y marcar en camino'],
    };
  }

  if (order.status === 'out_for_delivery') {
    if (!requiresDeliveryMoneyHandling) {
      return {
        title: paid ? 'En camino · sin liquidacion' : 'En camino · cobranza del asesor',
        description: paid
          ? 'El despacho no llevo efectivo ni cambio. Master confirma la entrega final.'
          : `${order.advisorName || 'El asesor'} mantiene la cobranza. Counter no tiene retorno de caja pendiente.`,
        tone: 'good' as const,
        steps: paid
          ? ['Esperar confirmacion de entrega de Master']
          : ['Mantener cobranza con el asesor', 'Esperar confirmacion de entrega de Master'],
      };
    }

    return {
      title: 'Liquidar custodia',
      description:
        'Counter recibe el efectivo y mantiene la liquidacion abierta el tiempo necesario. Master confirma aparte la entrega al cliente.',
      tone: 'warn' as const,
      steps: [
        'Registrar lo cobrado al cliente',
        'Ingresar el efectivo recibido en caja',
        'Dejar la entrega final a Master',
      ],
    };
  }

  return {
    title: 'Sin accion inmediata',
    description: 'Esta orden no requiere una accion de mostrador en este momento.',
    tone: 'neutral' as const,
    steps: ['Revisar datos', 'Consultar con master si hace falta'],
  };
}

function getCounterWorkflowChecks(order: CounterOrder) {
  const paid = order.balanceUsd <= 0.005;
  const hasPendingReports = order.reports.pending > 0;
  const inKitchenFlow =
    order.status === 'queued' || order.status === 'confirmed' || order.status === 'in_kitchen';
  const immediatePaymentExpected = isCounterImmediatePaymentMethod(order.paymentMethod);
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);
  const requiresDeliveryMoneyHandling = requiresCounterDeliveryMoneyHandling(order);

  if (order.status === 'cancelled') {
    return [
      { label: 'Orden', detail: 'Cancelada', state: 'blocked' as const },
      { label: 'Acciones', detail: 'Solo consulta', state: 'pending' as const },
    ];
  }

  if (order.status === 'delivered') {
    return [
      { label: 'Entrega', detail: 'Completada', state: 'done' as const },
      {
        label: 'Cobro',
        detail: paid ? 'Cubierto' : `Pendiente ${moneyUsd(order.balanceUsd)}`,
        state: paid ? ('done' as const) : ('current' as const),
      },
      { label: 'Edicion', detail: 'Bloqueada', state: 'blocked' as const },
    ];
  }

  if (order.status === 'created') {
    return [
      { label: 'Agenda', detail: 'Master debe enviarlo a cocina', state: 'current' as const },
      { label: 'Cocina', detail: 'Pendiente', state: 'pending' as const },
      { label: 'Entrega', detail: 'Pendiente', state: 'pending' as const },
    ];
  }

  if (inKitchenFlow) {
    return [
      { label: 'Agenda', detail: 'Enviado', state: 'done' as const },
      { label: 'Cocina', detail: order.status === 'in_kitchen' ? 'Preparando' : 'En cola', state: 'current' as const },
      { label: 'Entrega', detail: 'Esperando cocina', state: 'pending' as const },
    ];
  }

  if (order.fulfillment === 'pickup' && order.status === 'ready') {
    const paymentOk = paid && !hasPendingReports;
    return [
      { label: 'Cocina', detail: 'Lista', state: 'done' as const },
      {
        label: 'Cobro',
        detail: paymentOk
          ? 'Cubierto'
          : hasPendingReports && immediatePaymentExpected
            ? 'Pago por revisar'
            : mustCollectNow
              ? !order.hasAdvisor && hasPendingReports
                ? 'Esperar confirmacion de Master'
                : `Cobrar ${moneyUsd(order.balanceUsd)}`
              : `Pendiente asesor ${moneyUsd(order.balanceUsd)}`,
        state: paymentOk ? ('done' as const) : mustCollectNow ? ('current' as const) : ('pending' as const),
      },
      {
        label: 'Retiro',
        detail: paymentOk ? 'Marcar retirado' : mustCollectNow ? 'Bloqueado hasta cobrar' : 'Puede entregarse',
        state: paymentOk || !mustCollectNow ? ('current' as const) : ('blocked' as const),
      },
    ];
  }

  if (order.fulfillment === 'delivery' && order.status === 'ready') {
    return [
      { label: 'Cocina', detail: 'Lista', state: 'done' as const },
      {
        label: 'Asignacion',
        detail: order.deliveryAssigneeName ? deliveryAssigneeLabel(order) || 'Asignado' : 'Falta asignar',
        state: order.deliveryAssigneeName ? ('done' as const) : ('current' as const),
      },
      {
        label: 'Salida',
        detail: order.deliveryAssigneeName ? 'Entregar y marcar en camino' : 'Esperando master',
        state: order.deliveryAssigneeName ? ('current' as const) : ('blocked' as const),
      },
    ];
  }

  if (order.status === 'out_for_delivery') {
    if (!requiresDeliveryMoneyHandling) {
      return [
        { label: 'Salida', detail: 'En camino', state: 'done' as const },
        {
          label: 'Cobranza',
          detail: paid
            ? 'Sin pendiente en caja'
            : `Pendiente asesor ${moneyUsd(order.balanceUsd)}`,
          state: paid ? ('done' as const) : ('pending' as const),
        },
        {
          label: 'Entrega final',
          detail: 'La confirma Master',
          state: 'pending' as const,
        },
      ];
    }

    return [
      { label: 'Salida', detail: 'En camino', state: 'done' as const },
      {
        label: 'Custodia',
        detail: 'Revisar liquidacion exacta',
        state: 'current' as const,
      },
      {
        label: 'Entrega final',
        detail: 'La confirma Master',
        state: 'pending' as const,
      },
    ];
  }

  return [
    { label: 'Revision', detail: 'Sin accion inmediata', state: 'pending' as const },
  ];
}

export function OrderDetail({
  order,
  initialPaymentOpen,
  onInitialPaymentOpened,
  paymentAccounts,
  quickSaleProducts,
  quickSaleProductComponents,
  activeBsRate,
  isWorking,
  isStale,
  isRefreshing,
  onRefreshExact,
  onPrimaryDeliveryAction,
  onDeliverySettlementChanged,
  onCreatePaymentReport,
  onLoadPaymentQuote,
  onRequestRefund,
  onExecuteRefund,
  onChangePickupItems,
  onUpdatePickupSchedule,
  onRequestCatalog,
  catalogLoading,
}: {
  order: CounterOrder;
  initialPaymentOpen: boolean;
  onInitialPaymentOpened: () => void;
  paymentAccounts: CounterPaymentAccountOption[];
  quickSaleProducts: CounterQuickSaleProductOption[];
  quickSaleProductComponents: CounterQuickSaleProductComponent[];
  activeBsRate: number;
  isWorking: boolean;
  isStale: boolean;
  isRefreshing: boolean;
  onRefreshExact: () => void;
  onPrimaryDeliveryAction: (
    order: CounterOrder,
    dispatchIntent?: CounterDeliveryDispatchIntent
  ) => Promise<CounterDeliveryDispatchResult | null>;
  onDeliverySettlementChanged: () => Promise<void>;
  onCreatePaymentReport: (
    order: CounterOrder,
    input: CounterPaymentIntent
  ) => Promise<CounterPaymentOperationResult>;
  onLoadPaymentQuote: (input: {
    orderId: number;
    operationDate: string;
  }) => Promise<CounterPaymentQuote>;
  onRequestRefund: (
    order: CounterOrder,
    input: CounterRefundRequestIntent
  ) => Promise<CounterRefundRequestResult>;
  onExecuteRefund: (
    order: CounterOrder,
    input: CounterRefundExecutionIntent
  ) => Promise<CounterRefundExecutionResult>;
  onChangePickupItems: (
    order: CounterOrder,
    input: CounterPickupItemChangeIntent
  ) => Promise<CounterPickupItemChangeResult>;
  onUpdatePickupSchedule: (
    order: CounterOrder,
    input: CounterPickupScheduleIntent
  ) => Promise<CounterPickupScheduleResult>;
  onRequestCatalog: () => Promise<boolean>;
  catalogLoading: boolean;
}) {
  const paid = order.balanceUsd <= 0.005;
  const isDelivered = order.status === 'delivered';
  const isCancelled = order.status === 'cancelled';
  const isClosedOrder = isDelivered || isCancelled;
  const isDeliverySettlement = order.fulfillment === 'delivery' && order.status === 'out_for_delivery';
  const requiresDeliveryMoneyHandling = requiresCounterDeliveryMoneyHandling(order);
  const deliveryReadyWithoutAssignee =
    order.fulfillment === 'delivery' && order.status === 'ready' && !order.deliveryAssigneeName;
  const waitingForMaster = order.status === 'created';
  const notReadyForCounter =
    waitingForMaster
    || order.status === 'queued'
    || order.status === 'confirmed'
    || order.status === 'in_kitchen';
  const hasPendingReports = order.reports.pending > 0;
  const pendingPickupChange =
    order.pickupChangeRequests.find((request) => request.status === 'pending') ?? null;
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);
  const pickupReadyNeedsPayment =
    order.fulfillment === 'pickup' &&
    order.status === 'ready' &&
    mustCollectNow;
  const pickupCheckoutRequired =
    pickupReadyNeedsPayment
    && order.balanceUsd > 0.005
    && order.pendingDigitalChangeUsd <= 0.005
    && !hasPendingReports
    && !pendingPickupChange;
  const primaryActionBlocked =
    isClosedOrder ||
    notReadyForCounter ||
    Boolean(pendingPickupChange) ||
    pickupReadyNeedsPayment ||
    deliveryReadyWithoutAssignee ||
    isDeliverySettlement;
  const primaryActionBlockedMessage = isCancelled
    ? 'La orden esta cancelada. Counter solo puede consultar el expediente.'
    : isDelivered
      ? 'La orden ya fue entregada. Counter solo puede consultar y registrar pagos pendientes.'
    : pendingPickupChange
    ? 'Master debe aprobar o rechazar el cambio solicitado antes de entregar este pickup.'
    : order.fulfillment === 'pickup' && order.pendingDigitalChangeUsd > 0.005
      ? 'Todavia existe cambio digital pendiente de entregar al cliente. Completa ese cambio antes de marcar el pickup como retirado.'
    : waitingForMaster
    ? 'Esta orden quedo agendada. Master debe enviarla a cocina cuando corresponda.'
    : notReadyForCounter
      ? 'Esta orden aun esta en cocina. Cuando quede lista aparecera para entrega.'
    : pickupReadyNeedsPayment
      ? hasPendingReports
        ? !order.hasAdvisor
          ? 'El cliente no tiene asesor. Master debe confirmar el pago antes de que Counter entregue el pedido.'
          : 'Hay pagos pendientes de revision. No marques retirado hasta que queden confirmados.'
        : isCounterImmediatePaymentMethod(order.paymentMethod) && order.balanceUsd > 0.005
          ? 'El metodo esperado es efectivo o punto. Abre el cobro antes de marcar el pickup como retirado.'
        : 'Master debe confirmar el cobro antes de marcar el pickup como retirado.'
    : deliveryReadyWithoutAssignee
      ? 'Este delivery no tiene motorizado o partner asignado. Asignalo desde master antes de entregarlo.'
      : isDeliverySettlement
        ? requiresDeliveryMoneyHandling
          ? 'Counter liquida la custodia y recibe el efectivo. Solo Master confirma la entrega final al cliente.'
          : order.hasAdvisor && order.balanceUsd > 0.005
            ? `${order.advisorName || 'El asesor'} mantiene la cobranza. Counter no tiene liquidacion de caja pendiente.`
            : 'Este delivery esta en camino sin cobro ni cambio pendiente para Counter. Master confirma la entrega final.'
        : mustCollectNow
          ? !order.hasAdvisor && hasPendingReports
            ? 'El cliente no tiene asesor. Master debe confirmar el pago antes de cerrar la entrega.'
            : 'El metodo esperado es efectivo o punto. Primero registra el cobro recibido del motorizado.'
          : 'Hay pagos pendientes de revision antes de cerrar la entrega.';
  const [paymentOpen, setPaymentOpen] = useState(initialPaymentOpen);
  const [addItemsOpen, setAddItemsOpen] = useState(false);
  const [deliveryDispatchOpen, setDeliveryDispatchOpen] = useState(false);
  const [pickupConfirmationOpen, setPickupConfirmationOpen] = useState(false);
  const currentAction = getCounterCurrentAction(order);
  const canModifyPickup =
    order.fulfillment === 'pickup' &&
    (
      order.status === 'created' ||
      order.status === 'queued' ||
      order.status === 'confirmed' ||
      order.status === 'in_kitchen' ||
      order.status === 'ready'
    ) &&
    !pendingPickupChange;
  const canCorrectPickupSchedule =
    order.fulfillment === 'pickup' &&
    (
      order.status === 'created'
      || order.status === 'queued'
      || order.status === 'confirmed'
      || order.status === 'in_kitchen'
    );
  const isReadyDeliveryAction = order.fulfillment === 'delivery' && order.status === 'ready';
  const isReadyPickupAction = order.fulfillment === 'pickup' && order.status === 'ready';
  const reservedRefundUsd = order.refundAuthorizations.reduce(
    (sum, authorization) =>
      authorization.status === 'pending' || authorization.status === 'approved'
        ? sum + authorization.amountUsdEquivalent
        : sum,
    0
  );
  const showRefundPanel =
    !isClosedOrder
    && (
      order.overpaidUsd - order.pendingDigitalChangeUsd - reservedRefundUsd > 0.005
      || order.refundAuthorizations.some(
        (authorization) => authorization.status === 'pending' || authorization.status === 'approved'
      )
    );

  useEffect(() => {
    if (initialPaymentOpen) onInitialPaymentOpened();
  }, [initialPaymentOpen, onInitialPaymentOpened]);

  function handlePrimaryActionClick() {
    if (pickupCheckoutRequired) {
      setPaymentOpen(true);
      return;
    }

    if (isReadyDeliveryAction) {
      setDeliveryDispatchOpen(true);
      return;
    }

    if (isReadyPickupAction && !pickupConfirmationOpen) {
      setPickupConfirmationOpen(true);
      return;
    }

    setPickupConfirmationOpen(false);
    void onPrimaryDeliveryAction(order);
  }

  async function handleToggleAddItems() {
    if (addItemsOpen) {
      setAddItemsOpen(false);
      return;
    }
    if (await onRequestCatalog()) setAddItemsOpen(true);
  }

  return (
    <div>
      <div className="border-b border-[#242433] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">Orden #{order.displayNumber}</h2>
              <span className={['rounded-full border px-2.5 py-0.5 text-xs font-semibold', counterStatusClass(order)].join(' ')}>
                {getOperationalStatusLabel(order)}
              </span>
              <span className="rounded-full border border-[#303044] px-2.5 py-0.5 text-xs text-[#C7C8D1]">
                {fulfillmentLabel(order.fulfillment)}
              </span>
              {order.hasInvoice ? (
                <span className="rounded-full border border-sky-300/40 bg-sky-300/10 px-2.5 py-0.5 text-xs font-semibold text-sky-100">
                  Factura solicitada
                </span>
              ) : null}
            </div>
            <div className="mt-1 truncate text-sm text-[#9FA0AA]">
              {order.clientName}
              {order.clientPhone ? ` · ${order.clientPhone}` : ''}
            </div>
            <div className="mt-1 text-xs text-[#9FA0AA]">
              Asesor: <span className="font-semibold text-[#F5F5F7]">{order.advisorName || 'Sin asesor'}</span>
            </div>
            <div className="mt-1 text-xs text-[#9FA0AA]">Lista: {formatDateTime(order.readyAt)}</div>
          </div>
          <span className={['rounded-full border px-3 py-1 text-xs font-semibold', paymentClass(order)].join(' ')}>
            {paymentLabel(order)}
          </span>
        </div>
      </div>

      {isStale ? (
        <div className="border-b border-orange-400/25 bg-orange-950/20 px-4 py-3 text-sm text-orange-100">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              Esta orden cambio mientras estaba abierta. Revisa el detalle exacto antes de cobrar o entregar.
            </span>
            <button
              type="button"
              onClick={onRefreshExact}
              disabled={isRefreshing}
              className="rounded-full border border-orange-300/40 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {isRefreshing ? 'Revisando...' : 'Revisar ahora'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-3">
          {order.receiverName || order.receiverPhone ? <CounterReceiverCard order={order} /> : null}

          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Pedido</h3>
              <span className="text-sm font-semibold text-[#C7C8D1]">{order.items.length} item(s)</span>
            </div>
            <div className="mt-2 divide-y divide-[#242433]">
              {order.items.length === 0 ? (
                <div className="py-3 text-sm text-[#9FA0AA]">Sin items cargados.</div>
              ) : (
                order.items.map((item) => (
                  <div key={item.id} className="grid gap-2 py-2 sm:grid-cols-[56px_1fr_84px]">
                    <div className="rounded-[8px] border border-[#FEEF00]/35 bg-[#FEEF00]/10 px-2 py-1 text-center text-sm font-bold text-[#FEEF00]">
                      x{qtyLabel(item.qty)}
                    </div>
                    <div>
                      <div className="text-sm font-semibold">{item.name}</div>
                      {item.notes ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-[#9FA0AA]">
                          {getVisibleEditableDetailLines(item.notes.split('\n')).map((detail, detailIdx) => (
                            <li key={`${item.id}-note-${detailIdx}`}>• {detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <div className="text-left text-sm font-semibold sm:text-right">{moneyUsd(item.lineTotalUsd)}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {order.hasInvoice ? <CounterInvoiceCard order={order} /> : null}

          <details className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
            <summary className="min-h-11 cursor-pointer select-none py-2 font-semibold text-[#C7C8D1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]">
              Recorrido operativo
            </summary>
            <div className="mt-2 grid gap-2 text-xs text-[#C7C8D1] sm:grid-cols-2 xl:grid-cols-3">
              <div><span className="text-[#777988]">Creada: </span>{formatDateTime(order.createdAt)}</div>
              <div>
                <span className="text-[#777988]">Agenda: </span>
                {order.scheduledDate || 'Sin fecha'} {order.scheduledTime || ''}
              </div>
              <div><span className="text-[#777988]">Enviada a cocina: </span>{formatDateTime(order.sentToKitchenAt)}</div>
              <div><span className="text-[#777988]">Preparación: </span>{formatDateTime(order.kitchenStartedAt)}</div>
              <div><span className="text-[#777988]">Lista: </span>{formatDateTime(order.readyAt)}</div>
              <div><span className="text-[#777988]">Entregada: </span>{formatDateTime(order.deliveredAt)}</div>
            </div>
          </details>

          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Total" value={moneyUsd(order.totalUsd)} note={moneyBs(order.totalBs)} />
            <Metric label="Confirmado" value={moneyUsd(order.confirmedPaidUsd)} tone="good" />
            <Metric label="Pendiente" value={moneyUsd(order.balanceUsd)} tone={paid ? 'good' : 'warn'} />
          </div>

          {order.pendingReportsUsd > 0.005 ||
          order.pendingDigitalChangeUsd > 0.005 ||
          order.overpaidUsd > 0.005 ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {order.pendingReportsUsd > 0.005 ? (
                <Metric
                  label="Pago por revisar"
                  value={moneyUsd(order.pendingReportsUsd)}
                  note={order.hasAdvisor ? 'Seguimiento del asesor' : 'Master debe confirmar'}
                  tone="warn"
                />
              ) : null}
              {order.pendingDigitalChangeUsd > 0.005 ? (
                <Metric
                  label="Cambio digital pendiente"
                  value={moneyUsd(order.pendingDigitalChangeUsd)}
                  note={order.hasAdvisor ? 'Responsable: asesor' : 'Responsable: Master'}
                  tone="warn"
                />
              ) : null}
              {order.overpaidUsd > 0.005 ? (
                <Metric
                  label="Saldo a favor"
                  value={moneyUsd(order.overpaidUsd)}
                  note="Puede ir a fondo o devolucion autorizada"
                />
              ) : null}
            </div>
          ) : null}

          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Forma indicada en la orden</h3>
              <span className="text-sm font-semibold text-[#F5F5F7]">{getPaymentMethodLabel(order.paymentMethod)}</span>
            </div>
            <p className="mt-1 text-xs text-[#9FA0AA]">
              Es una referencia. Al cobrar, registra el método que el cliente realmente utilice.
            </p>
            <div className="mt-2 grid gap-2 text-xs text-[#9FA0AA] sm:grid-cols-2">
              <div>Moneda: {order.paymentCurrency || 'Sin definir'}</div>
              <div>Tasa orden: {order.fxRate > 0 ? moneyBs(order.fxRate) : 'Sin tasa'}</div>
              {order.paymentRequiresChange ? (
                <div className="sm:col-span-2">
                  El cliente pagará con: {order.paymentChangeFor || '-'} {order.paymentChangeCurrency || ''}
                </div>
              ) : null}
              {order.paymentNote ? <div className="sm:col-span-2">Nota: {order.paymentNote}</div> : null}
            </div>
          </div>

          {paymentOpen && !isCancelled ? (
            <CounterOperationDialog
              title="Cobrar pedido"
              subtitle={`Orden #${order.displayNumber} · ${order.clientName}`}
              onClose={() => setPaymentOpen(false)}
            >
              <CounterPaymentEngine
                key={`${order.id}-${order.confirmedPaidUsd}-${order.balanceUsd}-${order.paymentQuote.operationDate}-${order.paymentQuote.pendingBs}-${order.paymentQuote.collectionMode}-${order.reports.pending}`}
                order={order}
                paymentAccounts={paymentAccounts}
                isWorking={isWorking}
                onSubmit={(input) => onCreatePaymentReport(order, input)}
                onLoadPaymentQuote={onLoadPaymentQuote}
              />
            </CounterOperationDialog>
          ) : null}

          {order.fulfillment === 'delivery' || order.deliveryAddress ? (
            <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
              <h3 className="font-semibold">Entrega</h3>
              <div className="mt-2 grid gap-2 text-xs text-[#C7C8D1] sm:grid-cols-2">
                <div className="sm:col-span-2">{order.deliveryAddress || 'Sin direccion'}</div>
                {order.fulfillment === 'delivery' ? (
                  <>
                    <div>
                      Asignacion:{' '}
                      <span className={order.deliveryAssigneeName ? 'font-semibold text-[#F5F5F7]' : 'font-semibold text-red-200'}>
                        {deliveryAssigneeLabel(order)}
                      </span>
                    </div>
                    {order.externalReference ? <div>Ref. externa: {order.externalReference}</div> : null}
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {deliveryDispatchOpen && isReadyDeliveryAction && !primaryActionBlocked ? (
            <CounterOperationDialog
              title="Entregar al motorizado"
              subtitle={`Orden #${order.displayNumber} · ${order.deliveryAssigneeName || 'Sin asignar'}`}
              onClose={() => setDeliveryDispatchOpen(false)}
            >
              <CounterDeliveryDispatchPanel
                order={order}
                paymentAccounts={paymentAccounts}
                activeBsRate={activeBsRate}
                isWorking={isWorking}
                onCancel={() => setDeliveryDispatchOpen(false)}
                onSubmit={async (intent) => {
                  const result = await onPrimaryDeliveryAction(order, intent);
                  if (!result) throw new Error('No se pudo confirmar la salida.');
                  setDeliveryDispatchOpen(false);
                  return result;
                }}
              />
            </CounterOperationDialog>
          ) : null}

          {isDeliverySettlement ? (
            <CounterDeliverySettlementBox
              orderId={order.id}
              paymentAccounts={paymentAccounts}
              activeBsRate={activeBsRate}
              onChanged={onDeliverySettlementChanged}
            />
          ) : null}

          {pendingPickupChange ? (
            <CounterPendingPickupChange request={pendingPickupChange} />
          ) : null}

          {canCorrectPickupSchedule ? (
            <CounterPickupScheduleBox
              order={order}
              isWorking={isWorking}
              onSubmit={(input) => onUpdatePickupSchedule(order, input)}
            />
          ) : null}

          {order.notes ? (
            <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
              <h3 className="font-semibold">Notas</h3>
              <div className="mt-2 text-xs text-[#C7C8D1]">{order.notes}</div>
            </div>
          ) : null}
        </div>

        <aside className="space-y-2 xl:sticky xl:top-4 xl:self-start">
          <CurrentActionCard action={currentAction} />
          <CounterWorkflowChecklist items={getCounterWorkflowChecks(order)} />
          <button
            type="button"
            onClick={handlePrimaryActionClick}
            disabled={isWorking || (primaryActionBlocked && !pickupCheckoutRequired)}
            className="min-h-12 w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-3 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isWorking
              ? 'Guardando...'
              : pickupConfirmationOpen
                ? 'Confirmar retiro ahora'
                : primaryCounterActionLabel(order)}
          </button>
          {pickupConfirmationOpen && isReadyPickupAction && !primaryActionBlocked ? (
            <div className="rounded-[8px] border border-orange-300/40 bg-orange-950/25 p-3 text-xs leading-relaxed text-orange-100">
              <div className="font-semibold">Confirma la entrega física</div>
              <div className="mt-1">
                Verifica a {order.receiverName || order.clientName}, el pedido y cualquier cambio pendiente. La segunda pulsación marcará el pickup como retirado.
              </div>
              <button
                type="button"
                onClick={() => setPickupConfirmationOpen(false)}
                className="mt-3 min-h-11 rounded-full border border-orange-200/40 px-4 py-2 font-semibold hover:border-orange-100"
              >
                Volver sin entregar
              </button>
            </div>
          ) : null}
          {primaryActionBlocked ? (
            <div className="rounded-[8px] border border-orange-400/30 bg-orange-950/20 p-3 text-xs leading-relaxed text-orange-100">
              {primaryActionBlockedMessage}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPaymentOpen((current) => !current)}
              disabled={isCancelled || isWorking}
              className="min-h-11 rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-xs font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cobrar
            </button>
            <button
              type="button"
              onClick={() => void handleToggleAddItems()}
              disabled={!canModifyPickup || isWorking || catalogLoading}
              className="min-h-11 rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-xs font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {catalogLoading ? 'Cargando...' : addItemsOpen ? 'Ocultar edicion' : 'Modificar'}
            </button>
          </div>
          {canModifyPickup ? (
            <ActionHint
              title="Modificar pickup"
              text={
                order.status === 'ready'
                  ? 'Puedes editarlo directamente. Si agregas o aumentas productos, el pedido vuelve a cocina.'
                  : 'Puedes agregar, reducir o retirar productos. Toda reduccion exige motivo.'
              }
            />
          ) : null}
          <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3 text-xs leading-relaxed text-[#9FA0AA]">
            {isDeliverySettlement && !requiresDeliveryMoneyHandling
              ? order.hasAdvisor && order.balanceUsd > 0.005
                ? 'La cobranza sigue con el asesor. Counter solo registro la salida; Master controla la entrega final.'
                : 'Counter solo registro la salida. No hay liquidacion de caja; Master controla la entrega final.'
              : 'En delivery, Counter controla salida y custodia cuando hay dinero prescrito. Master controla la entrega final al cliente.'}
          </div>
        </aside>
      </div>

      {showRefundPanel ? (
        <div className="border-t border-[#242433] p-5">
          <CounterRefundPanel
            key={`${order.id}-${order.overpaidUsd}-${order.refundAuthorizations.map((item) => `${item.movementGroupId}:${item.status}`).join('|')}`}
            order={order}
            paymentAccounts={paymentAccounts}
            isWorking={isWorking}
            onRequest={(input) => onRequestRefund(order, input)}
            onExecute={(input) => onExecuteRefund(order, input)}
          />
        </div>
      ) : null}

      {addItemsOpen ? (
        <div className="border-t border-[#242433] p-5">
          <CounterPickupItemsEditor
            key={`${order.id}-${order.items.map((item) => `${item.id}:${item.qty}`).join('|')}`}
            order={order}
            products={quickSaleProducts}
            productComponents={quickSaleProductComponents}
            activeBsRate={activeBsRate}
            isWorking={isWorking}
            onSubmit={(input) => onChangePickupItems(order, input)}
          />
        </div>
      ) : null}
    </div>
  );
}

function CounterInvoiceCard({ order }: { order: CounterOrder }) {
  const invoiceFields = [
    { label: 'Razón social', value: order.invoiceSnapshot?.companyName },
    { label: 'RIF o documento', value: order.invoiceSnapshot?.taxId },
    { label: 'Dirección fiscal', value: order.invoiceSnapshot?.address },
    { label: 'Teléfono fiscal', value: order.invoiceSnapshot?.phone },
  ];
  const hasSnapshotData = invoiceFields.some((field) => Boolean(field.value));

  return (
    <section
      aria-label="Datos para emitir la factura"
      className="rounded-[8px] border border-sky-300/40 bg-sky-950/20 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sky-100">Factura solicitada</h3>
          <p className="mt-0.5 text-xs text-sky-100/70">
            Prepara la factura de esta orden con los datos fiscales guardados.
          </p>
        </div>
        {order.invoiceTaxPct > 0 ? (
          <span className="rounded-full border border-sky-300/35 px-2.5 py-1 text-xs font-semibold text-sky-100">
            IVA {order.invoiceTaxPct.toLocaleString('es-VE', { maximumFractionDigits: 2 })}%
          </span>
        ) : null}
      </div>

      {hasSnapshotData ? (
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {invoiceFields.map((field) => (
            <div key={field.label} className="rounded-[8px] border border-sky-300/20 bg-[#0B0B0D]/70 p-3">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-sky-100/60">
                {field.label}
              </dt>
              <dd className={['mt-1 break-words text-sm font-semibold', field.value ? 'text-[#F5F5F7]' : 'text-orange-200'].join(' ')}>
                {field.value || 'No indicado'}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="mt-3 rounded-[8px] border border-orange-300/35 bg-orange-950/20 p-3 text-sm text-orange-100">
          {order.invoiceDataNote || 'La factura fue solicitada, pero la orden no tiene datos fiscales guardados.'}
        </div>
      )}

      {order.invoiceTaxAmountUsd > 0.005 || order.invoiceTaxAmountBs > 0.5 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-sky-300/20 pt-3 text-sm">
          <span className="text-sky-100/70">IVA incluido en el total</span>
          <span className="font-semibold text-sky-100">
            {moneyUsd(order.invoiceTaxAmountUsd)} · {moneyBs(order.invoiceTaxAmountBs)}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function CounterReceiverCard({ order }: { order: CounterOrder }) {
  const actionLabel = order.fulfillment === 'pickup' ? 'Retira otra persona' : 'Recibe otra persona';

  return (
    <section
      aria-label="Persona autorizada para recibir el pedido"
      className="rounded-[8px] border border-amber-300/45 bg-amber-950/25 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-amber-200/70">
            {actionLabel}
          </div>
          <div className="mt-1 break-words text-lg font-bold text-amber-50">
            {order.receiverName || 'Nombre no indicado'}
          </div>
          {order.receiverPhone ? (
            <a
              href={`tel:${order.receiverPhone}`}
              className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-amber-100 underline decoration-amber-300/50 underline-offset-4 hover:text-white"
            >
              {order.receiverPhone}
            </a>
          ) : (
            <div className="mt-1 text-sm text-orange-200">Teléfono no indicado</div>
          )}
        </div>
        <span className="rounded-full border border-amber-300/35 bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-100">
          Verificar identidad
        </span>
      </div>
      <div className="mt-2 border-t border-amber-300/20 pt-2 text-xs text-amber-100/70">
        Cliente de la orden: <span className="font-semibold text-amber-50">{order.clientName}</span>
      </div>
    </section>
  );
}

function CounterPendingPickupChange({
  request,
}: {
  request: CounterPickupChangeRequest;
}) {
  const changedExisting = request.preview.existingItems.filter(
    (item) => item.previousQty != null && Math.abs(item.qty - item.previousQty) > 0.0001
  );

  return (
    <div className="rounded-[8px] border border-violet-400/35 bg-violet-950/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-violet-100">Cambio esperando autorizacion</h3>
          <p className="mt-1 text-sm text-violet-100/75">{request.reason}</p>
        </div>
        <span className="rounded-full border border-violet-300/40 bg-violet-300/10 px-3 py-1 text-xs font-semibold text-violet-100">
          Master
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {changedExisting.map((item) => (
          <div key={`existing-${item.itemId}`} className="rounded-[8px] border border-violet-300/20 bg-[#0B0B0D] px-3 py-2 text-xs">
            <span className="font-semibold text-[#F5F5F7]">{item.name}</span>
            <span className="ml-2 text-violet-100">
              x{qtyLabel(item.previousQty ?? 0)} → x{qtyLabel(item.qty)}
            </span>
          </div>
        ))}
        {request.preview.addedItems.map((item, index) => (
          <div key={`added-${item.productId}-${index}`} className="rounded-[8px] border border-violet-300/20 bg-[#0B0B0D] px-3 py-2 text-xs">
            <span className="font-semibold text-[#F5F5F7]">{item.name}</span>
            <span className="ml-2 text-emerald-200">+x{qtyLabel(item.qty)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-violet-100/75">
        <span>Solicitado por {request.requestedByName}</span>
        <span>
          Nuevo total: {moneyUsd(request.preview.totalUsd)} · {moneyBs(request.preview.totalBs)}
        </span>
      </div>
    </div>
  );
}

function getCaracasTimeInput() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

function scheduleTimeInput(value: string | null) {
  const normalized = String(value || '').trim();
  if (/^\d{2}:\d{2}$/.test(normalized)) return normalized;
  const match = normalized.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return getCaracasTimeInput();
  let hour = Number(match[1]);
  const minute = match[2];
  const period = match[3].toUpperCase();
  if (period === 'AM' && hour === 12) hour = 0;
  if (period === 'PM' && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

function CounterPickupScheduleBox({
  order,
  isWorking,
  onSubmit,
}: {
  order: CounterOrder;
  isWorking: boolean;
  onSubmit: (input: CounterPickupScheduleIntent) => Promise<CounterPickupScheduleResult>;
}) {
  const [scheduledDate, setScheduledDate] = useState(order.scheduledDate || getTodayKey());
  const [scheduledTime, setScheduledTime] = useState(scheduleTimeInput(order.scheduledTime));
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const commandKeyRef = useRef<StableCommandKey | null>(null);

  async function submit(sendToKitchen: boolean) {
    if (!scheduledDate || !scheduledTime) {
      setLocalError('Indica la fecha y la hora correctas.');
      return;
    }
    if (reason.trim().length < 4) {
      setLocalError('Indica el motivo de la correccion.');
      return;
    }

    setLocalError(null);
    try {
      const payload = {
        orderId: order.id,
        scheduledDate,
        scheduledTime,
        reason: reason.trim(),
        sendToKitchen,
      };
      commandKeyRef.current = stableCommandKey(commandKeyRef.current, payload);
      await onSubmit({
        idempotencyKey: commandKeyRef.current.key,
        ...payload,
      });
      commandKeyRef.current = null;
      setReason('');
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No se pudo corregir la fecha.');
    }
  }

  return (
    <div className="rounded-[8px] border border-sky-400/25 bg-sky-950/15 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sky-100">Fecha y entrada a cocina</h3>
          <p className="mt-1 text-xs leading-relaxed text-sky-100/70">
            Corrige una agenda equivocada. El sistema deja motivo y avisa a cocina y asesor.
          </p>
        </div>
        <span className="rounded-full border border-sky-300/30 bg-sky-300/10 px-3 py-1 text-xs font-semibold text-sky-100">
          {order.status === 'created' ? 'Agendado' : 'En cocina'}
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-sky-100/75">
          Fecha
          <input
            type="date"
            value={scheduledDate}
            onChange={(event) => setScheduledDate(event.target.value)}
            className="mt-1 w-full rounded-[8px] border border-sky-300/25 bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-sky-300"
          />
        </label>
        <label className="text-xs text-sky-100/75">
          Hora
          <input
            type="time"
            value={scheduledTime}
            onChange={(event) => setScheduledTime(event.target.value)}
            className="mt-1 w-full rounded-[8px] border border-sky-300/25 bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-sky-300"
          />
        </label>
      </div>
      <label className="mt-2 block text-xs text-sky-100/75">
        Motivo
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={1200}
          placeholder="Ej.: el cliente confirma que el pedido era para hoy."
          className="mt-1 min-h-16 w-full resize-y rounded-[8px] border border-sky-300/25 bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-sky-300"
        />
      </label>
      {localError ? <div className="mt-2 text-xs font-semibold text-red-200">{localError}</div> : null}
      <div className={['mt-3 grid gap-2', ['created', 'queued'].includes(order.status) ? 'sm:grid-cols-2' : ''].join(' ')}>
        <button
          type="button"
          onClick={() => void submit(false)}
          disabled={isWorking}
          className="rounded-[8px] border border-sky-300/35 bg-[#0B0B0D] px-3 py-2 text-xs font-semibold text-sky-100 disabled:cursor-wait disabled:opacity-60"
        >
          Guardar correccion
        </button>
        {order.status === 'created' || order.status === 'queued' ? (
          <button
            type="button"
            onClick={() => void submit(true)}
            disabled={isWorking}
            className="rounded-[8px] border border-sky-300/50 bg-sky-300/15 px-3 py-2 text-xs font-bold text-sky-100 disabled:cursor-wait disabled:opacity-60"
          >
            Corregir y enviar a cocina
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CounterPickupItemsEditor({
  order,
  products,
  productComponents,
  activeBsRate,
  isWorking,
  onSubmit,
}: {
  order: CounterOrder;
  products: CounterQuickSaleProductOption[];
  productComponents: CounterQuickSaleProductComponent[];
  activeBsRate: number;
  isWorking: boolean;
  onSubmit: (input: CounterPickupItemChangeIntent) => Promise<CounterPickupItemChangeResult>;
}) {
  const [productSearch, setProductSearch] = useState('');
  const [cartItems, setCartItems] = useState<CounterQuickSaleCartItem[]>([]);
  const [existingQty, setExistingQty] = useState<Record<number, string>>(
    () => Object.fromEntries(order.items.map((item) => [item.id, String(item.qty)]))
  );
  const [reason, setReason] = useState('');
  const [configProductId, setConfigProductId] = useState<number | null>(null);
  const [configAlias, setConfigAlias] = useState('');
  const [configSelections, setConfigSelections] = useState<Array<{
    localId: string;
    componentProductId: number;
    componentName: string;
    qty: number;
  }>>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const commandKeyRef = useRef<StableCommandKey | null>(null);
  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const componentsByParentId = useMemo(() => {
    const map = new Map<number, CounterQuickSaleProductComponent[]>();
    for (const component of productComponents) {
      const current = map.get(component.parentProductId) ?? [];
      current.push(component);
      map.set(component.parentProductId, current);
    }
    return map;
  }, [productComponents]);
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
    if (!term) return [];
    return products
      .filter((product) =>
        [product.name, product.sku, product.type]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase('es-VE').includes(term))
      )
      .slice(0, 12);
  }, [productSearch, products]);
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

      return { item, product, qty: itemQty, snapshot };
    });
  }, [activeBsRate, cartItems, productsById]);
  const addedUsd = lineRows.reduce((sum, row) => sum + row.snapshot.lineUsd, 0);
  const addedBs = lineRows.reduce((sum, row) => sum + row.snapshot.lineBs, 0);
  const existingRows = order.items.map((item) => {
    const rawQty = String(existingQty[item.id] ?? '').trim();
    const parsedQty = toDecimalInput(rawQty);
    const isValid =
      rawQty.length > 0 &&
      Number.isFinite(parsedQty) &&
      parsedQty >= 0 &&
      parsedQty <= 999;
    const nextQty = isValid ? parsedQty : item.qty;
    const unitUsd = item.qty > 0 ? item.lineTotalUsd / item.qty : 0;
    const unitBs = item.qty > 0 ? item.lineTotalBs / item.qty : 0;
    return {
      item,
      nextQty,
      isValid,
      lineUsd: unitUsd * nextQty,
      lineBs: unitBs * nextQty,
    };
  });
  const hasInvalidExistingQty = existingRows.some((row) => !row.isValid);
  const hasExistingChange = existingRows.some((row) => Math.abs(row.nextQty - row.item.qty) > 0.0001);
  const hasReduction = existingRows.some((row) => row.nextQty < row.item.qty);
  const hasChanges = hasExistingChange || cartItems.length > 0;
  const changedExistingCount = existingRows.filter(
    (row) => Math.abs(row.nextQty - row.item.qty) > 0.0001
  ).length;
  const currentSubtotalUsd = order.items.reduce((sum, item) => sum + item.lineTotalUsd, 0);
  const currentSubtotalBs = order.items.reduce((sum, item) => sum + item.lineTotalBs, 0);
  const estimatedSubtotalUsd = existingRows.reduce((sum, row) => sum + row.lineUsd, 0) + addedUsd;
  const estimatedSubtotalBs = existingRows.reduce((sum, row) => sum + row.lineBs, 0) + addedBs;
  const estimatedTotalUsd =
    currentSubtotalUsd > 0.005
      ? Math.round(estimatedSubtotalUsd * (order.totalUsd / currentSubtotalUsd) * 100) / 100
      : Math.round(estimatedSubtotalUsd * 100) / 100;
  const estimatedTotalBs =
    currentSubtotalBs > 0.005
      ? Math.round(estimatedSubtotalBs * (order.totalBs / currentSubtotalBs) * 100) / 100
      : Math.round(estimatedSubtotalBs * 100) / 100;
  const estimatedDifferenceUsd = Math.round((estimatedTotalUsd - order.totalUsd) * 100) / 100;

  function addProduct(product: CounterQuickSaleProductOption) {
    const productConfigComponents = componentsByParentId.get(product.id) ?? [];
    if (product.isDetailEditable) {
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

    setCartItems((current) => {
      const existingIndex =
        productConfigComponents.length === 0
          ? current.findIndex(
              (item) =>
                item.productId === product.id
                && item.notes.trim().length === 0
                && item.editableDetailLines.length === 0
            )
          : -1;

      if (existingIndex >= 0) {
        return current.map((item, index) =>
          index === existingIndex
            ? { ...item, qty: String(Math.max(1, toDecimalInput(item.qty)) + 1) }
            : item
        );
      }

      return [
        ...current,
        {
          id: `add-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          productId: product.id,
          qty: '1',
          notes: '',
          editableDetailLines: buildComponentDetailLines(productConfigComponents, {
            totalMultiplier: 1,
          }),
        },
      ];
    });
    setLocalError(null);
  }

  function updateExistingItemQty(itemId: number, nextQty: number) {
    setExistingQty((current) => ({
      ...current,
      [itemId]: String(Math.max(0, Math.min(999, nextQty))),
    }));
    setLocalError(null);
  }

  function updateAddedItemQty(itemId: string, nextQty: number) {
    const safeQty = Math.max(0, Math.min(999, nextQty));
    if (safeQty <= 0) {
      setCartItems((current) => current.filter((item) => item.id !== itemId));
      return;
    }

    setCartItems((current) =>
      current.map((item) => {
        if (item.id !== itemId) return item;
        const product = productsById.get(item.productId);
        if (product?.isDetailEditable) return item;
        const productConfigComponents = componentsByParentId.get(item.productId) ?? [];
        return {
          ...item,
          qty: String(safeQty),
          editableDetailLines: buildComponentDetailLines(productConfigComponents, {
            totalMultiplier: safeQty,
          }),
        };
      })
    );
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
        id: `add-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        productId: configProduct.id,
        qty: '1',
        notes: '',
        editableDetailLines: detailLines,
      },
    ]);
    closeProductConfig();
    setLocalError(null);
  }

  async function submitItems() {
    if (hasInvalidExistingQty) {
      setLocalError('Revisa las cantidades actuales. Deben estar entre 0 y 999.');
      return;
    }

    if (!hasChanges) {
      setLocalError('Modifica una cantidad o agrega al menos una linea.');
      return;
    }

    if (
      existingRows.every((row) => row.nextQty <= 0) &&
      cartItems.length === 0
    ) {
      setLocalError('El pedido debe conservar al menos un producto.');
      return;
    }

    if (hasReduction && reason.trim().length < 4) {
      setLocalError('Indica el motivo de la reduccion o retiro.');
      return;
    }

    setLocalError(null);
    try {
      const payload = {
        orderId: order.id,
        existingItems: existingRows.map((row) => ({
          itemId: row.item.id,
          qty: row.nextQty,
        })),
        addedItems: cartItems.map((item) => ({
          productId: item.productId,
          qty: toDecimalInput(item.qty),
          notes: item.notes.trim() || null,
          editableDetailLines: item.editableDetailLines,
        })),
        reason: reason.trim() || null,
      };
      commandKeyRef.current = stableCommandKey(commandKeyRef.current, payload);
      await onSubmit({
        idempotencyKey: commandKeyRef.current.key,
        ...payload,
      });
      commandKeyRef.current = null;
      setCartItems([]);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No se pudo modificar el pickup.');
    }
  }

  return (
    <div className="overflow-hidden rounded-[10px] border border-[#303044] bg-[#0B0B0D]">
      <div className="border-b border-[#242433] bg-[#111118] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">Editar pedido pickup</h3>
              <span className="rounded-full border border-emerald-300/35 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-bold text-emerald-200">
                Cambio directo
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[#9FA0AA]">
              Busca productos, ajusta cantidades y revisa el nuevo total antes de guardar.
              No necesitas autorizacion de Master.
            </p>
          </div>
          <span className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1 text-xs font-semibold text-[#C7C8D1]">
            Orden #{order.displayNumber}
          </span>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777887]">Total actual</div>
            <div className="mt-1 text-lg font-bold text-[#F5F5F7]">{moneyUsd(order.totalUsd)}</div>
            <div className="text-xs text-[#9FA0AA]">{moneyBs(order.totalBs)}</div>
          </div>
          <div className="rounded-[8px] border border-[#FEEF00]/45 bg-[#FEEF00]/10 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#D8CD2E]">Nuevo total</div>
            <div className="mt-1 text-lg font-bold text-[#FEEF00]">{moneyUsd(estimatedTotalUsd)}</div>
            <div className="text-xs text-[#D8CD2E]">{moneyBs(estimatedTotalBs)}</div>
          </div>
          <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777887]">Diferencia</div>
            <div
              className={[
                'mt-1 text-lg font-bold',
                estimatedDifferenceUsd > 0.005
                  ? 'text-emerald-300'
                  : estimatedDifferenceUsd < -0.005
                    ? 'text-orange-200'
                    : 'text-[#F5F5F7]',
              ].join(' ')}
            >
              {estimatedDifferenceUsd > 0.005 ? '+' : ''}
              {moneyUsd(estimatedDifferenceUsd)}
            </div>
            <div className="text-xs text-[#9FA0AA]">Se valida al guardar</div>
          </div>
        </div>
      </div>

      <div className="p-4">
        {order.status === 'ready' ? (
          <div className="mb-4 rounded-[8px] border border-sky-300/30 bg-sky-950/25 px-3 py-2 text-sm leading-relaxed text-sky-100">
            Este pedido ya estaba listo. Las reducciones se aplican de inmediato; si agregas o aumentas
            productos, volvera a cocina para preparar el cambio.
          </div>
        ) : null}

        {localError ? (
          <div className="mb-4 rounded-[8px] border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-200">
            {localError}
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(340px,0.95fr)]">
          <section className="rounded-[8px] border border-[#242433] bg-[#111118] p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-[#F5F5F7]">Pedido actual</h4>
                <p className="mt-0.5 text-xs text-[#9FA0AA]">Usa − y + o escribe la cantidad.</p>
              </div>
              <span className="text-xs font-semibold text-[#9FA0AA]">{order.items.length} linea(s)</span>
            </div>
            <div className="mt-3 divide-y divide-[#242433]">
              {existingRows.map((row) => {
                const changed = Math.abs(row.nextQty - row.item.qty) > 0.0001;
                const removed = row.nextQty <= 0;
                return (
                  <div key={row.item.id} className="grid gap-3 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className={['truncate text-sm font-semibold', removed ? 'text-[#777887] line-through' : 'text-[#F5F5F7]'].join(' ')}>
                        {row.item.name}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#9FA0AA]">
                        <span>{moneyUsd(row.lineUsd)}</span>
                        {row.item.notes ? <span className="truncate">· {row.item.notes}</span> : null}
                        {changed ? (
                          <span className={removed ? 'font-semibold text-red-200' : 'font-semibold text-[#FEEF00]'}>
                            {removed ? 'Retirado' : `Antes x${qtyLabel(row.item.qty)}`}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateExistingItemQty(row.item.id, row.nextQty - 1)}
                        aria-label={`Restar una unidad de ${row.item.name}`}
                        className="grid h-11 w-11 place-items-center rounded-[8px] border border-[#3A3A48] bg-[#0B0B0D] text-xl font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60"
                      >
                        −
                      </button>
                      <input
                        value={existingQty[row.item.id] ?? ''}
                        onChange={(event) =>
                          setExistingQty((current) => ({ ...current, [row.item.id]: event.target.value }))
                        }
                        inputMode="decimal"
                        aria-label={`Cantidad de ${row.item.name}`}
                        className="h-11 w-20 rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-2 text-center text-sm font-bold text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                      />
                      <button
                        type="button"
                        onClick={() => updateExistingItemQty(row.item.id, row.nextQty + 1)}
                        aria-label={`Sumar una unidad de ${row.item.name}`}
                        className="grid h-11 w-11 place-items-center rounded-[8px] border border-[#3A3A48] bg-[#0B0B0D] text-xl font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-[8px] border border-[#242433] bg-[#111118] p-3">
            <div>
              <h4 className="text-sm font-semibold text-[#F5F5F7]">Agregar productos</h4>
              <p className="mt-0.5 text-xs text-[#9FA0AA]">Escribe el nombre o codigo y toca el producto.</p>
            </div>
            <label className="mt-3 block">
              <span className="sr-only">Buscar producto</span>
              <input
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="Ej.: refresco, tequeno, EMP..."
                autoComplete="off"
                className="min-h-12 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
            </label>

            {productSearch.trim() ? (
              <div className="mt-2 max-h-[310px] overflow-y-auto rounded-[8px] border border-[#303044] bg-[#0B0B0D]">
                {filteredProducts.length === 0 ? (
                  <div className="px-4 py-5 text-center text-sm text-[#9FA0AA]">
                    No encontramos productos con ese nombre o codigo.
                  </div>
                ) : (
                  filteredProducts.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => addProduct(product)}
                      className="flex min-h-14 w-full items-center justify-between gap-3 border-b border-[#242433] px-3 py-2.5 text-left transition last:border-b-0 hover:bg-[#1A1A22] focus-visible:bg-[#1A1A22] focus-visible:outline-none"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[#F5F5F7]">{product.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-[#9FA0AA]">
                          {[product.sku, product.type].filter(Boolean).join(' · ') || 'Producto activo'}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-right text-xs font-semibold text-[#C7C8D1]">
                          <span className="block">{moneyUsd(product.basePriceUsd)}</span>
                          <span className="font-normal text-[#777887]">{moneyBs(product.basePriceBs)}</span>
                        </span>
                        <span className="grid h-9 w-9 place-items-center rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 text-lg font-bold text-[#FEEF00]">
                          +
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <div className="mt-2 rounded-[8px] border border-dashed border-[#303044] px-4 py-5 text-center text-sm text-[#777887]">
                El catalogo aparece solo cuando escribes una busqueda.
              </div>
            )}
          </section>
        </div>

      {configProduct ? (
        <div className="mt-4 space-y-3 rounded-[8px] border border-[#FEEF00]/40 bg-[#181807] p-3">
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

              return (
                <label
                  key={component.componentProductId}
                  className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-2 text-sm text-[#F5F5F7]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{component.componentName}</span>
                    <input
                      value={currentQty ? String(currentQty) : ''}
                      onChange={(event) =>
                        setConfigSelectionQty(
                          component.componentProductId,
                          component.componentName,
                          Number(event.target.value || 0)
                        )
                      }
                      inputMode="numeric"
                      className="h-9 w-20 rounded-[8px] border border-[#303044] bg-[#111118] px-2 text-right text-sm outline-none focus:border-[#FEEF00]/70"
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-[#9FA0AA]">
                    {component.componentMode === 'fixed' ? 'Fijo opcional' : 'Seleccionable'}
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

        {lineRows.length > 0 ? (
          <section className="mt-4 overflow-hidden rounded-[8px] border border-emerald-300/25 bg-emerald-950/10">
            <div className="flex items-center justify-between gap-2 border-b border-emerald-300/20 px-3 py-2">
              <div>
                <h4 className="text-sm font-semibold text-emerald-100">Productos nuevos</h4>
                <p className="mt-0.5 text-xs text-emerald-100/65">Ya forman parte del nuevo total.</p>
              </div>
              <span className="rounded-full bg-emerald-300/10 px-2.5 py-1 text-xs font-bold text-emerald-200">
                +{lineRows.length}
              </span>
            </div>
            <div className="divide-y divide-emerald-300/15">
              {lineRows.map((row) => (
                <div key={row.item.id} className="grid gap-3 p-3 lg:grid-cols-[1fr_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[#F5F5F7]">{row.product?.name || 'Producto'}</span>
                      <span className="text-sm font-bold text-emerald-200">{moneyUsd(row.snapshot.lineUsd)}</span>
                    </div>
                    {getVisibleEditableDetailLines(row.item.editableDetailLines).length > 0 ? (
                      <ul className="mt-1 space-y-0.5 text-xs text-[#C7C8D1]">
                        {getVisibleEditableDetailLines(row.item.editableDetailLines).map((detail, detailIdx) => (
                          <li key={`${row.item.id}-${detailIdx}`}>• {detail}</li>
                        ))}
                      </ul>
                    ) : null}
                    <input
                      value={row.item.notes}
                      onChange={(event) =>
                        setCartItems((current) =>
                          current.map((item) =>
                            item.id === row.item.id ? { ...item, notes: event.target.value } : item
                          )
                        )
                      }
                      placeholder="Nota para este producto (opcional)"
                      className="mt-2 min-h-10 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-xs text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {row.product?.isDetailEditable ? (
                      <span className="min-w-20 text-center text-sm font-bold text-[#F5F5F7]">x1 armado</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => updateAddedItemQty(row.item.id, row.qty - 1)}
                          aria-label={`Restar una unidad de ${row.product?.name || 'producto'}`}
                          className="grid h-11 w-11 place-items-center rounded-[8px] border border-[#3A3A48] bg-[#0B0B0D] text-xl font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60"
                        >
                          −
                        </button>
                        <input
                          value={row.item.qty}
                          onChange={(event) => {
                            if (!event.target.value.trim()) return;
                            const nextQty = toDecimalInput(event.target.value);
                            if (Number.isFinite(nextQty)) updateAddedItemQty(row.item.id, nextQty);
                          }}
                          inputMode="decimal"
                          aria-label={`Cantidad nueva de ${row.product?.name || 'producto'}`}
                          className="h-11 w-20 rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-2 text-center text-sm font-bold text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                        />
                        <button
                          type="button"
                          onClick={() => updateAddedItemQty(row.item.id, row.qty + 1)}
                          aria-label={`Sumar una unidad de ${row.product?.name || 'producto'}`}
                          className="grid h-11 w-11 place-items-center rounded-[8px] border border-[#3A3A48] bg-[#0B0B0D] text-xl font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60"
                        >
                          +
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setCartItems((current) => current.filter((item) => item.id !== row.item.id))}
                      aria-label={`Quitar ${row.product?.name || 'producto'}`}
                      className="min-h-11 rounded-[8px] border border-red-400/40 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-400/10"
                    >
                      Quitar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {hasReduction ? (
          <label className="mt-4 block rounded-[8px] border border-orange-300/30 bg-orange-950/20 p-3 text-sm text-orange-100">
            Motivo de la reduccion o retiro <span className="font-bold">(obligatorio)</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1200}
              placeholder="Ej.: el cliente retiro una unidad del pedido."
              className="mt-2 min-h-20 w-full resize-y rounded-[8px] border border-orange-300/30 bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#777887] focus:border-orange-200/70"
            />
          </label>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#242433] pt-4">
          <div>
            <div className="text-sm font-semibold text-[#F5F5F7]">
              {changedExistingCount + lineRows.length} cambio(s) en el pedido
            </div>
            <div className="mt-0.5 text-xs text-[#9FA0AA]">
              El servidor recalculara total y saldo financiero al confirmar.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void submitItems()}
            disabled={isWorking || !hasChanges || activeBsRate <= 0}
            className="min-h-12 rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-6 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
          >
            {isWorking ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CounterWorkflowChecklist({
  items,
}: {
  items: Array<{
    label: string;
    detail: string;
    state: 'done' | 'current' | 'blocked' | 'pending';
  }>;
}) {
  const stateClass = {
    done: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100',
    current: 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]',
    blocked: 'border-orange-400/35 bg-orange-950/20 text-orange-100',
    pending: 'border-[#303044] bg-[#0B0B0D] text-[#9FA0AA]',
  };
  const dotClass = {
    done: 'bg-emerald-300',
    current: 'bg-[#FEEF00]',
    blocked: 'bg-orange-300',
    pending: 'bg-[#666878]',
  };

  return (
    <div className="grid gap-1.5">
      {items.map((item) => (
        <div
          key={item.label}
          className={['rounded-[8px] border px-2.5 py-1.5', stateClass[item.state]].join(' ')}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className={['h-2 w-2 shrink-0 rounded-full', dotClass[item.state]].join(' ')} />
              <span className="truncate text-[10px] font-semibold uppercase tracking-[0.12em]">{item.label}</span>
            </span>
            <span className="truncate text-xs font-semibold text-[#F5F5F7]">{item.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const toneClass =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-orange-300' : 'text-[#F5F5F7]';

  return (
    <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
      <div className="text-xs text-[#9FA0AA]">{label}</div>
      <div className={['mt-1 text-base font-semibold', toneClass].join(' ')}>{value}</div>
      {note ? <div className="mt-1 text-xs text-[#9FA0AA]">{note}</div> : null}
    </div>
  );
}

function CurrentActionCard({
  action,
}: {
  action: ReturnType<typeof getCounterCurrentAction>;
}) {
  const toneClass =
    action.tone === 'good'
      ? 'border-emerald-400/30 bg-emerald-400/10'
      : action.tone === 'warn'
        ? 'border-orange-400/35 bg-orange-950/20'
        : 'border-sky-400/25 bg-sky-950/15';
  const badgeClass =
    action.tone === 'good'
      ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-100'
      : action.tone === 'warn'
        ? 'border-orange-300/40 bg-orange-300/10 text-orange-100'
        : 'border-sky-300/30 bg-sky-300/10 text-sky-100';

  return (
    <div className={['rounded-[8px] border px-3 py-2', toneClass].join(' ')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9FA0AA]">Accion actual</div>
          <h3 className="mt-1 text-sm font-semibold leading-tight text-[#F5F5F7]">{action.title}</h3>
          <p className="mt-1 text-xs leading-snug text-[#C7C8D1]">{action.description}</p>
        </div>
        <span className={['shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold', badgeClass].join(' ')}>
          {action.tone === 'good' ? 'Listo' : action.tone === 'warn' ? 'Atencion' : 'Seguimiento'}
        </span>
      </div>
    </div>
  );
}

function ActionHint({
  title,
  text,
  tone = 'neutral',
}: {
  title: string;
  text: string;
  tone?: 'neutral' | 'warn';
}) {
  const toneClass =
    tone === 'warn'
      ? 'border-orange-300/30 bg-orange-950/20 text-orange-100'
      : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1]';

  return (
    <div className={['rounded-[8px] border p-3 text-xs leading-relaxed', toneClass].join(' ')}>
      <div className="text-sm font-semibold text-[#F5F5F7]">{title}</div>
      <div className="mt-1">{text}</div>
    </div>
  );
}
