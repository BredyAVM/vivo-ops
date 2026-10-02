'use client';

import { useCallback, useRef, useState } from 'react';
import { projectKitchenReceipt, type KitchenDispatchResult } from './kitchen-dispatch';

/** One client contract for Master, Admin and the legacy Dashboard. No optimistic status. */
export function useKitchenDispatch(input: {
  send: (input: { orderId: number }) => Promise<KitchenDispatchResult>;
  check: (input: { orderId: number }) => Promise<KitchenDispatchResult>;
  refresh: () => void;
  snapshotStartedAt: string;
}) {
  const [receipts, setReceipts] = useState<Record<number, KitchenDispatchResult>>({});
  const [pending, setPending] = useState<number | null>(null);
  const inFlight = useRef(false);
  const needsCheck = useRef(new Set<number>());
  const run = async (orderId: number) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(orderId);
    let result: KitchenDispatchResult;
    try {
      const action = needsCheck.current.has(orderId) ? input.check : input.send;
      try { result = await action({ orderId }); }
      catch {
        // A lost action response is not evidence of rollback. Never auto-resend.
        try { result = await input.check({ orderId }); }
        catch { result = { ok: false, needsCheck: true, message: 'Sin confirmación del servidor. Pulsa Comprobar envío antes de reintentar.' }; }
      }
      if (result.needsCheck) needsCheck.current.add(orderId);
      else needsCheck.current.delete(orderId);
      setReceipts((current) => ({ ...current, [orderId]: result }));
      input.refresh();
      return result;
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };
  const project = useCallback(<T extends { id: number }>(order: T): T =>
    projectKitchenReceipt(order, receipts[order.id], input.snapshotStartedAt), [receipts, input.snapshotStartedAt]);
  const label = (orderId: number) => pending === orderId ? 'Confirmando envío…'
    : receipts[orderId]?.needsCheck ? 'Comprobar envío' : 'Enviar a cocina';
  const forget = useCallback((orderId: number) => {
    needsCheck.current.delete(orderId);
    setReceipts((current) => {
      if (!current[orderId]) return current;
      const next = { ...current };
      delete next[orderId];
      return next;
    });
  }, []);
  return { run, project, label, pending, forget };
}
