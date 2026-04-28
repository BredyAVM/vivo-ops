'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { EmptyBlock, SectionCard, StatusBadge } from '../advisor-ui';
import {
  type InboxEvent,
  FILTERS,
  type InboxFilter,
  advisorInboxStorageKey,
  formatEventTime,
} from './inbox-shared';

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

function saveStoredIds(userId: string, ids: Set<string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(advisorInboxStorageKey(userId), JSON.stringify(Array.from(ids)));
}

export default function AdvisorInboxClient({
  userId,
  activeFilter,
  events,
}: {
  userId: string;
  activeFilter: InboxFilter;
  events: InboxEvent[];
}) {
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setReadIds(readStoredIds(userId));
  }, [userId]);

  const unreadCount = useMemo(
    () => events.filter((event) => !readIds.has(event.id)).length,
    [events, readIds]
  );
  const unreadActionCount = useMemo(
    () => events.filter((event) => event.requiresAction && !readIds.has(event.id)).length,
    [events, readIds]
  );

  function updateReadIds(next: Set<string>) {
    setReadIds(new Set(next));
    saveStoredIds(userId, next);
  }

  function markRead(eventId: string) {
    const next = new Set(readIds);
    next.add(eventId);
    updateReadIds(next);
  }

  function markUnread(eventId: string) {
    const next = new Set(readIds);
    next.delete(eventId);
    updateReadIds(next);
  }

  function markAllVisibleAsRead() {
    const next = new Set(readIds);
    for (const event of events) next.add(event.id);
    updateReadIds(next);
  }

  return (
    <>
      <section className="overflow-x-auto pb-1">
        <div className="flex min-w-max gap-2">
          {FILTERS.map((filter) => (
            <Link
              key={filter.key}
              href={`/app/advisor/inbox?filter=${filter.key}`}
              className={[
                'rounded-[16px] border px-3 py-2 text-sm font-medium',
                activeFilter === filter.key
                  ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
                  : 'border-[#232632] bg-[#12151d] text-[#CCD3E2]',
              ].join(' ')}
            >
              {filter.label}
            </Link>
          ))}
        </div>
      </section>

      <SectionCard
        title="Bandeja"
        subtitle={
          activeFilter === 'pending'
            ? 'Eventos que requieren accion del asesor.'
            : 'Eventos recientes para seguimiento operativo.'
        }
        action={
          <div className="flex items-center gap-2">
            {unreadActionCount > 0 ? (
              <StatusBadge label={`${unreadActionCount} por atender`} tone="warning" />
            ) : null}
            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={markAllVisibleAsRead}
                className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
              >
                Marcar visibles
              </button>
            ) : null}
          </div>
        }
      >
        {events.length === 0 ? (
          <EmptyBlock
            title="Sin eventos para este filtro"
            detail="Cuando entren eventos de orden, apareceran aqui con prioridad y contexto."
          />
        ) : (
          <div className="space-y-2.5">
            {events.map((event) => {
              const isRead = readIds.has(event.id);

              return (
                <article
                  key={event.id}
                  className={[
                    'rounded-[20px] border px-3.5 py-3 transition',
                    isRead
                      ? 'border-[#232632] bg-[#0F131B]'
                      : 'border-[#33405A] bg-[#101722] shadow-[0_0_0_1px_rgba(240,208,0,0.05)]',
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {!isRead ? <span className="h-2.5 w-2.5 rounded-full bg-[#F0D000]" /> : null}
                        <div className="truncate text-sm font-medium text-[#F5F7FB]">{event.clientName}</div>
                      </div>
                      <div className="mt-1 text-xs text-[#8B93A7]">{event.orderNumber}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge label={event.title} tone={event.tone} />
                      {event.requiresAction ? <StatusBadge label="Requiere accion" tone="warning" /> : null}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-1.5 text-xs leading-5 text-[#AAB2C5]">
                    <div>Entrega: {event.deliveryLabel}</div>
                    <div>{event.message}</div>
                    {event.detailLines.map((line) => (
                      <div key={`${event.id}-${line}`}>{line}</div>
                    ))}
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[#8B93A7]">
                    <span>{formatEventTime(event.createdAt)}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => (isRead ? markUnread(event.id) : markRead(event.id))}
                        className="inline-flex h-8 items-center rounded-[10px] border border-[#232632] px-2.5 text-xs font-medium text-[#CCD3E2]"
                      >
                        {isRead ? 'No leida' : 'Marcar leida'}
                      </button>
                      <Link
                        href={`/app/advisor/orders/${event.orderId}`}
                        onClick={() => markRead(event.id)}
                        className="inline-flex h-8 items-center rounded-[10px] border border-[#232632] px-2.5 text-xs font-medium text-[#F0D000]"
                      >
                        Abrir pedido
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>
    </>
  );
}
