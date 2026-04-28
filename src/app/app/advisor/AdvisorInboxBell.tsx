'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { INCLUDED_EVENT_TYPES, safeText } from './inbox/inbox-shared';

export default function AdvisorInboxBell({
  advisorName,
  userId,
  unreadCount,
  href = '/app/advisor/inbox?filter=all',
}: {
  advisorName: string;
  userId: string;
  unreadCount: number;
  href?: string;
}) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [count, setCount] = useState(unreadCount);

  useEffect(() => {
    async function refreshUnreadCount() {
      const { data } = await supabase
        .from('order_timeline_event_recipients')
        .select('id, read_at, event:order_timeline_events!inner(event_type)')
        .or(`target_user_id.eq.${userId},target_role.eq.advisor`)
        .is('read_at', null)
        .limit(200);

      const nextCount = (data ?? []).filter((recipient) => {
        const event = Array.isArray(recipient.event) ? recipient.event[0] ?? null : recipient.event;
        return INCLUDED_EVENT_TYPES.has(safeText(event?.event_type, ''));
      }).length;

      setCount(nextCount);
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
      href={href}
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
