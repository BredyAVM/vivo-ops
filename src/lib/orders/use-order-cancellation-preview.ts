'use client';

import { useEffect, useRef, useState } from 'react';
import { previewOrderCancellationAction } from '@/app/app/master/dashboard/actions';
import type { OrderCancellationPreview } from '@/lib/domain/order-cancellation-command';

// Loaded only when the cancellation form is open. A stale order/refresh result
// must never enable confirmation for another order or a different balance.
export function useOrderCancellationPreview(orderId: number | null) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{
    orderId: number; version: number; data?: OrderCancellationPreview; error?: string;
  } | null>(null);
  const request = useRef<{ orderId: number; id: string } | null>(null);
  useEffect(() => {
    if (orderId == null) return;
    let cancelled = false;
    previewOrderCancellationAction(orderId).then(
      (data) => { if (!cancelled) setResult({ orderId, version, data }); },
      (error: unknown) => { if (!cancelled) setResult({ orderId, version, error: error instanceof Error ? error.message : 'No se pudo calcular la cancelación.' }); },
    );
    return () => { cancelled = true; };
  }, [orderId, version]);
  const current = result?.orderId === orderId && result?.version === version ? result : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: orderId != null && current == null,
    reload: () => setVersion((previous) => previous + 1),
    getRequestId: () => {
      if (orderId == null) throw new Error('No hay una orden seleccionada.');
      if (request.current?.orderId !== orderId) request.current = { orderId, id: crypto.randomUUID() };
      return request.current.id;
    },
  };
}
