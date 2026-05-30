'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { countCoalescedUnreadNotificationsByKind } from './inbox/inbox-shared';

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

export default function AdvisorInboxBell({
  advisorName,
  userId,
  unreadActionCount,
  unreadUpdateCount,
}: {
  advisorName: string;
  userId: string;
  unreadActionCount: number;
  unreadUpdateCount: number;
}) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [counts, setCounts] = useState({ actions: unreadActionCount, updates: unreadUpdateCount });

  useEffect(() => {
    async function refreshUnreadCount() {
      const { data } = await supabase
        .from('order_timeline_event_recipients')
        .select('id, requires_action, read_at, event:order_timeline_events!inner(id, order_id, event_type, created_at)')
        .or(`target_user_id.eq.${userId},target_role.eq.advisor`)
        .limit(200);

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

      const nextCounts = countCoalescedUnreadNotificationsByKind(data ?? [], closedOrderIds);
      setCounts({ actions: nextCounts.actions, updates: nextCounts.updates });
    }

    void refreshUnreadCount();

    const ownChannel = supabase
      .channel(`advisor-bell-user-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: `target_user_id=eq.${userId}`,
        },
        () => {
          void refreshUnreadCount();
        },
      )
      .subscribe();

    const roleChannel = supabase
      .channel(`advisor-bell-role-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: 'target_role=eq.advisor',
        },
        () => {
          void refreshUnreadCount();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(ownChannel);
      void supabase.removeChannel(roleChannel);
    };
  }, [supabase, userId]);

  return (
    <div className="flex items-center gap-1.5">
      <Link
        href="/app/advisor/inbox?filter=pending"
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-[#3B3220] bg-[#151208] text-[#F7DA66]"
        aria-label={`Acciones pendientes de ${advisorName}`}
        title="Acciones"
      >
        <ActionIcon />
        {counts.actions > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex min-w-[20px] justify-center rounded-full bg-[#F0D000] px-1.5 py-0.5 text-[11px] font-semibold text-[#17191E]">
            {counts.actions}
          </span>
        ) : null}
      </Link>
      <Link
        href="/app/advisor/inbox?filter=updates"
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-[#232632] bg-[#0F131B] text-[#D8E0F4]"
        aria-label={`Seguimiento de pedidos de ${advisorName}`}
        title="Seguimiento"
      >
        <UpdatesIcon />
        {counts.updates > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex min-w-[20px] justify-center rounded-full bg-[#33405A] px-1.5 py-0.5 text-[11px] font-semibold text-[#F5F7FB]">
            {counts.updates}
          </span>
        ) : null}
      </Link>
    </div>
  );
}
