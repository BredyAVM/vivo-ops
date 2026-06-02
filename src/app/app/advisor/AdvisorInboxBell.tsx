'use client';

import { useEffect, useRef, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import AdvisorPendingLink from './AdvisorPendingLink';
import { countCoalescedNotificationsByKind } from './inbox/inbox-shared';

function ActionIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 8.25v4.25m0 3.25h.01M10.3 4.35 2.55 17.75A1.5 1.5 0 0 0 3.85 20h16.3a1.5 1.5 0 0 0 1.3-2.25L13.7 4.35a1.5 1.5 0 0 0-2.6 0Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function UpdatesIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M18 9a6 6 0 0 0-12 0c0 6-2.25 7.5-2.25 7.5h16.5S18 15 18 9Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M9.75 19.5a2.5 2.5 0 0 0 4.5 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function formatBadgeCount(value: number) {
  if (value > 99) return '99+';
  return String(value);
}

export default function AdvisorInboxBell({
  advisorName,
  userId,
  actionCount,
  updateCount,
}: {
  advisorName: string;
  userId: string;
  actionCount: number;
  updateCount: number;
}) {
  const supabaseRef = useRef(createSupabaseBrowser());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [counts, setCounts] = useState({ actions: actionCount, updates: updateCount });

  useEffect(() => {
    setCounts({ actions: actionCount, updates: updateCount });
  }, [actionCount, updateCount]);

  useEffect(() => {
    const supabase = supabaseRef.current;

    async function refreshUnreadCount() {
      const { data } = await supabase
        .from('order_timeline_event_recipients')
        .select('id, requires_action, read_at, event:order_timeline_events!inner(id, order_id, event_type, created_at)')
        .or(`target_user_id.eq.${userId},target_role.eq.advisor`)
        .order('id', { ascending: false })
        .limit(220);

      const reviewOrderIds = Array.from(
        new Set(
          (data ?? [])
            .map((recipient) => {
              const event = Array.isArray(recipient.event) ? recipient.event[0] ?? null : recipient.event;
              const eventType = String(event?.event_type || '');
              return eventType === 'order_returned_to_review' || eventType === 'order_changes_rejected'
                ? Number(event?.order_id || 0)
                : 0;
            })
            .filter((orderId) => Number.isFinite(orderId) && orderId > 0)
        )
      );
      const { data: closedOrdersData } = reviewOrderIds.length
        ? await supabase.from('orders').select('id').in('id', reviewOrderIds).in('status', ['delivered', 'cancelled'])
        : { data: [] };
      const closedOrderIds = new Set((closedOrdersData ?? []).map((order) => Number(order.id)));

      const nextCounts = countCoalescedNotificationsByKind(data ?? [], closedOrderIds);
      setCounts({ actions: nextCounts.actions, updates: nextCounts.updates });
    }

    function scheduleCountRefresh() {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }

      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void refreshUnreadCount();
      }, 1800);
    }

    window.addEventListener('advisor:timeline-recipient', scheduleCountRefresh);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      window.removeEventListener('advisor:timeline-recipient', scheduleCountRefresh);
    };
  }, [userId]);

  return (
    <div className="flex items-center gap-1.5">
      <AdvisorPendingLink
        href="/app/advisor/inbox/actions"
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-[#3B3220] bg-[#151208] text-[#F7DA66]"
        ariaLabel={`Acciones pendientes de ${advisorName}`}
        title="Acciones"
      >
        <ActionIcon />
        {counts.actions > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[24px] justify-center rounded-full bg-[#F0D000] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-[#17191E] shadow-[0_0_0_2px_#090B10]">
            {formatBadgeCount(counts.actions)}
          </span>
        ) : null}
      </AdvisorPendingLink>
      <AdvisorPendingLink
        href="/app/advisor/inbox/updates"
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-[#232632] bg-[#0F131B] text-[#D8E0F4]"
        ariaLabel={`Seguimiento de pedidos de ${advisorName}`}
        title="Seguimiento"
      >
        <UpdatesIcon />
        {counts.updates > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[24px] justify-center rounded-full bg-[#33405A] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-[#F5F7FB] shadow-[0_0_0_2px_#090B10]">
            {formatBadgeCount(counts.updates)}
          </span>
        ) : null}
      </AdvisorPendingLink>
    </div>
  );
}
