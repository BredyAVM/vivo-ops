'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { advisorInboxStorageKey } from './inbox/inbox-shared';

function readStoredIds(userId: string) {
  if (typeof window === 'undefined') return new Set<string>();

  try {
    const raw = window.localStorage.getItem(advisorInboxStorageKey(userId));
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set<string>();
  }
}

export default function AdvisorInboxBell({
  userId,
  advisorName,
  eventIds,
  href = '/app/advisor/inbox?filter=pending',
}: {
  userId: string;
  advisorName: string;
  eventIds: string[];
  href?: string;
}) {
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setReadIds(readStoredIds(userId));
  }, [userId]);

  const unreadCount = useMemo(
    () => eventIds.filter((eventId) => !readIds.has(eventId)).length,
    [eventIds, readIds]
  );

  return (
    <Link
      href={href}
      className="relative inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-[#232632] bg-[#0F131B] text-[#F5F7FB]"
      aria-label={`Notificaciones de ${advisorName}`}
    >
      <span className="text-lg">!</span>
      {unreadCount > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex min-w-[20px] justify-center rounded-full bg-[#F0D000] px-1.5 py-0.5 text-[11px] font-semibold text-[#17191E]">
          {unreadCount}
        </span>
      ) : null}
    </Link>
  );
}
