import type { OrderStatus } from './order-labels';

export type KitchenDispatchState = {
  id: number;
  status: OrderStatus;
  queuedNeedsReapproval: boolean;
  sentToKitchenAtISO: string | null;
  kitchenStartedAtISO: string | null;
  readyAtISO: string | null;
};
export type KitchenDispatchResult = {
  ok: boolean;
  needsCheck: boolean;
  message: string;
  order?: KitchenDispatchState;
  observedAt?: string;
};

export function isKitchenDispatchConfirmed(order: KitchenDispatchState) {
  return Boolean(order.sentToKitchenAtISO) &&
    ['confirmed', 'in_kitchen', 'ready', 'out_for_delivery', 'delivered'].includes(order.status);
}

/** Read-back is authoritative; an RPC error can be a concurrent successful send. */
export async function executeKitchenDispatch(ports: {
  send?: () => Promise<{ error: string | null }>;
  read: () => Promise<KitchenDispatchState>;
  onCommitted?: () => Promise<void>;
}): Promise<KitchenDispatchResult> {
  let committed = false;
  let uncertain = false;
  let sendError: string | null = null;
  if (ports.send) {
    try {
      const result = await ports.send();
      sendError = result.error;
      committed = !sendError;
    } catch {
      uncertain = true;
    }
  }
  // Only the request whose RPC committed may emit the notification.
  if (committed && ports.onCommitted) {
    try { await ports.onCommitted(); } catch { /* Never reinterpret a commit as a failed send. */ }
  }
  const observedAt = new Date().toISOString();
  try {
    const order = await ports.read();
    if (isKitchenDispatchConfirmed(order)) {
      return { ok: true, needsCheck: false, order, observedAt, message: 'Envío a cocina confirmado.' };
    }
    return {
      ok: false, needsCheck: uncertain, order, observedAt,
      message: uncertain
        ? 'No se pudo confirmar el envío. Comprueba el estado antes de volver a enviar.'
        : committed
          ? 'El envío se guardó, pero la orden cambió de estado después. Revisa el estado actualizado.'
          : sendError || 'La orden no está enviada a cocina. Revisa su estado antes de enviarla.',
    };
  } catch {
    return {
      ok: false, needsCheck: true,
      message: committed
        ? 'El envío se guardó; falta actualizar el estado. Pulsa Comprobar envío, no vuelvas a enviarlo.'
        : 'No se pudo comprobar el estado de la orden. Actualiza o pulsa Comprobar envío.',
    };
  }
}

/** Receipts beat responses started before read-back, not later legitimate returns/cancellations. */
export function projectKitchenReceipt<T extends { id: number }>(
  order: T, receipt: KitchenDispatchResult | undefined, snapshotStartedAt: string,
): T {
  if (!receipt?.order || receipt.order.id !== order.id || !receipt.observedAt ||
      Date.parse(snapshotStartedAt) > Date.parse(receipt.observedAt)) return order;
  const current = order as T & Partial<KitchenDispatchState>;
  const progression = ['confirmed', 'in_kitchen', 'ready', 'out_for_delivery', 'delivered'];
  if (current.sentToKitchenAtISO === receipt.order.sentToKitchenAtISO &&
      progression.includes(receipt.order.status) && current.status &&
      progression.indexOf(current.status) >= progression.indexOf(receipt.order.status)) return order;
  return { ...order, ...receipt.order };
}
