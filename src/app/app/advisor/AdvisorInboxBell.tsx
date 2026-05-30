'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { countCoalescedUnreadNotifications } from './inbox/inbox-shared';

export default function AdvisorInboxBell({
  advisorName,
  userId,
  unreadCount,
  href = '/app/advisor/inbox?filter=pending',
}: {
  advisorName: string;
  userId: string;
  unreadCount: number;
  href?: string;
}) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [count, setCount] = useState(unreadCount);
  const inboxHref = href.includes('/app/advisor/inbox?filter=all') ? '/app/advisor/inbox?filter=pending' : href;

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

      setCount(countCoalescedUnreadNotifications(data ?? [], closedOrderIds));
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
    <Link
      href={inboxHref}
      className="relative inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-[#232632] bg-[#0F131B] text-[#F5F7FB]"
      aria-label={`Notificaciones de ${advisorName}`}
    >
      <span className="text-lg">!</span>
      {count > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex min-w-[20px] justify-center rounded-full bg-[#F0D000] px-1.5 py-0.5 text-[11px] font-semibold text-[#17191E]">
          {count}
        </span>
      ) : null}
    </Link>
  );
}
