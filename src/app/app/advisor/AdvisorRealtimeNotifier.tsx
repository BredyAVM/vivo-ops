'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import {
  ACTION_EVENT_TYPES,
  INCLUDED_EVENT_TYPES,
  buildDetailLines,
  eventTitle,
  eventTone,
  safeText,
  shouldRequireAdvisorAction,
  shortMessage,
} from './inbox/inbox-shared';

type ToastState = {
  recipientId: number;
  orderId: number;
  orderNumber: string;
  title: string;
  message: string;
  requiresAction: boolean;
  tone: 'neutral' | 'warning' | 'success' | 'danger';
};

type RecipientRealtimeRow = {
  id: number;
  requires_action: boolean | null;
  read_at: string | null;
  event:
    | {
        order_id: number | string | null;
        order_number: string | null;
        event_type: string | null;
        title: string | null;
        message: string | null;
        payload: Record<string, unknown> | null;
      }[]
    | {
        order_id: number | string | null;
        order_number: string | null;
        event_type: string | null;
        title: string | null;
        message: string | null;
        payload: Record<string, unknown> | null;
      }
    | null;
};

export default function AdvisorRealtimeNotifier({ userId }: { userId: string }) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!userId) return;

    let dismissed = false;

    async function showRecipientToast(recipientId: number) {
      if (dismissed || typeof document === 'undefined' || document.visibilityState !== 'visible') {
        return;
      }

      const { data, error } = await supabase
        .from('order_timeline_event_recipients')
        .select(
          'id, requires_action, read_at, event:order_timeline_events!inner(order_id, order_number, event_type, title, message, payload)',
        )
        .eq('id', recipientId)
        .maybeSingle();

      if (dismissed || error || !data || data.read_at) return;

      const row = data as RecipientRealtimeRow;
      const event = Array.isArray(row.event) ? row.event[0] ?? null : row.event;
      const eventType = safeText(event?.event_type, '');
      if (!INCLUDED_EVENT_TYPES.has(eventType)) return;

      const orderId = Number(event?.order_id || 0);
      if (!Number.isFinite(orderId) || orderId <= 0) return;
      const { data: orderStatusData } = await supabase
        .from('orders')
        .select('status')
        .eq('id', orderId)
        .maybeSingle();

      const payload =
        event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? event.payload
          : {};
      const detailLines = buildDetailLines(eventType, payload);
      const requiresAction = shouldRequireAdvisorAction(eventType, row.requires_action, orderStatusData?.status ?? null);
      if (!requiresAction && ACTION_EVENT_TYPES.has(eventType)) return;

      setToast({
        recipientId,
        orderId,
        orderNumber: safeText(event?.order_number, `Orden ${orderId}`),
        title: eventTitle(eventType, safeText(event?.title, 'Nueva alerta')),
        message: shortMessage(eventType, event?.message ?? null, detailLines),
        requiresAction,
        tone: eventTone(eventType),
      });
    }

    const handleInsert = (payload: { new?: { id?: number | string | null } }) => {
      const recipientId = Number(payload.new?.id || 0);
      if (!Number.isFinite(recipientId) || recipientId <= 0) return;
      void showRecipientToast(recipientId);
    };

    const ownChannel = supabase
      .channel(`advisor-toast-user-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: `target_user_id=eq.${userId}`,
        },
        handleInsert,
      )
      .subscribe();

    const roleChannel = supabase
      .channel(`advisor-toast-role-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: 'target_role=eq.advisor',
        },
        handleInsert,
      )
      .subscribe();

    return () => {
      dismissed = true;
      void supabase.removeChannel(ownChannel);
      void supabase.removeChannel(roleChannel);
    };
  }, [supabase, userId]);

  useEffect(() => {
    if (!toast) return;

    const timeout = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  if (!toast) return null;

  const toastClass =
    toast.tone === 'danger'
      ? 'border-[#5E2229] bg-[#261114]'
      : toast.requiresAction || toast.tone === 'warning'
        ? 'border-[#3B3220] bg-[#18140C]'
        : 'border-[#232632] bg-[#101722]';
  const eyebrowClass =
    toast.tone === 'danger'
      ? 'text-[#F0A6AE]'
      : toast.requiresAction || toast.tone === 'warning'
        ? 'text-[#F7DA66]'
        : 'text-[#9DB6FF]';
  const messageClass =
    toast.tone === 'danger'
      ? 'text-[#F0C1C7]'
      : toast.requiresAction || toast.tone === 'warning'
        ? 'text-[#E8E2D0]'
        : 'text-[#D8E0F4]';

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-center">
      <div className={`pointer-events-auto w-full max-w-sm rounded-[20px] border px-4 py-3 shadow-[0_18px_40px_rgba(0,0,0,0.35)] ${toastClass}`}>
        <div className={`text-[11px] font-semibold uppercase tracking-[0.22em] ${eyebrowClass}`}>
          {toast.requiresAction ? 'Accion requerida' : 'Actualizacion'}
        </div>
        <div className="mt-1 text-sm font-semibold text-[#F5F7FB]">{toast.title}</div>
        <div className="mt-1 text-xs text-[#D9C178]">{toast.orderNumber}</div>
        <div className={`mt-2 text-sm leading-5 ${messageClass}`}>{toast.message}</div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setToast(null)}
            className="inline-flex h-9 items-center rounded-[12px] border border-[#4B4130] px-3 text-xs font-medium text-[#F5F7FB]"
          >
            Cerrar
          </button>
          <Link
            href={`/app/advisor/orders/${toast.orderId}`}
            onClick={() => setToast(null)}
            className="inline-flex h-9 items-center rounded-[12px] bg-[#F0D000] px-3 text-xs font-semibold text-[#17191E]"
          >
            {toast.requiresAction ? 'Atender' : 'Abrir pedido'}
          </Link>
        </div>
      </div>
    </div>
  );
}
