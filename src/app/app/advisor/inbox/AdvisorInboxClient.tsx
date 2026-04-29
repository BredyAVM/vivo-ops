'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { EmptyBlock, SectionCard, StatusBadge } from '../advisor-ui';
import {
  type InboxEvent,
  FILTERS,
  type InboxFilter,
  formatEventTime,
} from './inbox-shared';

function getDayKey(value: string) {
  return new Date(value).toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function isTodayEvent(value: string) {
  return getDayKey(value) === getDayKey(new Date().toISOString());
}

function actionHref(event: InboxEvent) {
  if (event.eventType === 'payment_rejected') {
    return `/app/advisor/orders/${event.orderId}?reportPayment=1`;
  }

  if (event.eventType === 'order_returned_to_review' || event.eventType === 'order_changes_rejected') {
    return `/app/advisor/new?fromOrder=${event.orderId}`;
  }

  return `/app/advisor/orders/${event.orderId}`;
}

function actionLabel(event: InboxEvent) {
  if (event.eventType === 'payment_rejected') return 'Corregir pago';
  if (event.eventType === 'order_returned_to_review' || event.eventType === 'order_changes_rejected') {
    return 'Corregir pedido';
  }
  return 'Abrir pedido';
}

export default function AdvisorInboxClient({
  activeFilter,
  initialEvents,
  userId,
}: {
  activeFilter: InboxFilter;
  initialEvents: InboxEvent[];
  userId: string;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [events, setEvents] = useState(initialEvents);
  const [savingIds, setSavingIds] = useState<number[]>([]);
  const [markingAll, setMarkingAll] = useState(false);

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useEffect(() => {
    const refreshInbox = () => {
      router.refresh();
    };

    const ownChannel = supabase
      .channel(`advisor-inbox-user-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: `target_user_id=eq.${userId}`,
        },
        refreshInbox,
      )
      .subscribe();

    const roleChannel = supabase
      .channel(`advisor-inbox-role-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: 'target_role=eq.advisor',
        },
        refreshInbox,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(ownChannel);
      void supabase.removeChannel(roleChannel);
    };
  }, [router, supabase, userId]);

  const unreadCount = useMemo(
    () => events.filter((event) => !event.readAt).length,
    [events]
  );
  const unreadActionCount = useMemo(
    () => events.filter((event) => event.requiresAction && !event.readAt).length,
    [events]
  );
  const pendingEvents = useMemo(
    () => events.filter((event) => event.requiresAction),
    [events],
  );
  const todayEvents = useMemo(() => events.filter((event) => isTodayEvent(event.createdAt)), [events]);
  const earlierEvents = useMemo(() => events.filter((event) => !isTodayEvent(event.createdAt)), [events]);

  function isSaving(recipientId: number) {
    return savingIds.includes(recipientId);
  }

  async function setRecipientReadState(recipientId: number, read: boolean) {
    setSavingIds((current) => [...current, recipientId]);

    const nextReadAt = read ? new Date().toISOString() : null;
    const previousEvents = events;
    setEvents((current) =>
      current.map((event) =>
        event.recipientId === recipientId ? { ...event, readAt: nextReadAt } : event
      )
    );

    const { error } = await supabase
      .from('order_timeline_event_recipients')
      .update({ read_at: nextReadAt })
      .eq('id', recipientId);

    if (error) {
      setEvents(previousEvents);
    }

    setSavingIds((current) => current.filter((id) => id !== recipientId));
  }

  async function markAllVisibleAsRead() {
    const recipientIds = events.filter((event) => !event.readAt).map((event) => event.recipientId);
    if (recipientIds.length === 0) return;

    setMarkingAll(true);
    setSavingIds((current) => [...current, ...recipientIds]);

    const nextReadAt = new Date().toISOString();
    const previousEvents = events;
    setEvents((current) =>
      current.map((event) =>
        recipientIds.includes(event.recipientId) ? { ...event, readAt: nextReadAt } : event
      )
    );

    const { error } = await supabase
      .from('order_timeline_event_recipients')
      .update({ read_at: nextReadAt })
      .in('id', recipientIds);

    if (error) {
      setEvents(previousEvents);
    }

    setSavingIds((current) => current.filter((id) => !recipientIds.includes(id)));
    setMarkingAll(false);
  }

  const groupedSections: Array<{ key: string; title: string; rows: InboxEvent[] }> = activeFilter === 'pending'
    ? [{ key: 'pending', title: 'Requieren accion', rows: pendingEvents }]
    : activeFilter === 'all'
      ? [
          { key: 'pending', title: 'Requieren accion', rows: pendingEvents },
          { key: 'today', title: 'Hoy', rows: todayEvents.filter((event) => !event.requiresAction) },
          { key: 'earlier', title: 'Antes', rows: earlierEvents.filter((event) => !event.requiresAction) },
        ]
      : [
          { key: 'today', title: 'Hoy', rows: todayEvents },
          { key: 'earlier', title: 'Antes', rows: earlierEvents },
        ];

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
                onClick={() => void markAllVisibleAsRead()}
                disabled={markingAll}
                className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB] disabled:text-[#6F7890]"
              >
                {markingAll ? 'Marcando...' : 'Marcar todo leido'}
              </button>
            ) : null}
          </div>
        }
      >
        {events.length === 0 ? (
          <EmptyBlock
            title="Sin eventos para este filtro"
            detail="Cuando entren eventos de orden, apareceran aqui con prioridad y contexto."
            href="/app/advisor/orders"
            cta="Ver pedidos"
          />
        ) : (
          <div className="space-y-4">
            {groupedSections
              .filter((section) => section.rows.length > 0)
              .map((section) => (
                <div key={section.key} className="space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8B93A7]">
                      {section.title}
                    </div>
                    <StatusBadge label={String(section.rows.length)} tone={section.key === 'pending' ? 'warning' : 'neutral'} />
                  </div>

                  {section.rows.map((event) => {
                    const isRead = Boolean(event.readAt);

                    return (
                      <article
                        key={event.id}
                        className={[
                          'advisor-fade-in rounded-[20px] border px-3.5 py-3 transition',
                          event.requiresAction
                            ? 'border-[#564511] bg-[#151208]'
                            : isRead
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

                        <div className="mt-3 rounded-[14px] bg-[#0B1017] px-3 py-2 text-xs leading-5 text-[#AAB2C5]">
                          <div>Entrega: {event.deliveryLabel}</div>
                          <div className="mt-1">{event.message}</div>
                          {event.detailLines.map((line) => (
                            <div key={`${event.id}-${line}`}>{line}</div>
                          ))}
                        </div>

                        <div className="mt-3 grid grid-cols-[minmax(64px,1fr)_auto_auto] items-center gap-2 text-xs text-[#8B93A7]">
                          <span className="min-w-0 leading-5">{formatEventTime(event.createdAt)}</span>
                          <div className="justify-self-end">
                            <button
                              type="button"
                              onClick={() => void setRecipientReadState(event.recipientId, isRead ? false : true)}
                              disabled={isSaving(event.recipientId)}
                              className="inline-flex h-8 items-center rounded-[10px] border border-[#232632] px-2 text-[10px] font-medium text-[#CCD3E2] disabled:text-[#6F7890]"
                            >
                              {isSaving(event.recipientId)
                                ? 'Guardando...'
                                : isRead
                                  ? 'No leida'
                                  : 'Leida'}
                            </button>
                          </div>
                          <Link
                            href={actionHref(event)}
                            onClick={() => {
                              if (!isRead && !isSaving(event.recipientId)) {
                                void setRecipientReadState(event.recipientId, true);
                              }
                            }}
                            className={[
                              'inline-flex h-8 items-center rounded-[10px] px-2 text-[10px] font-medium justify-self-end',
                              event.requiresAction
                                ? 'bg-[#F0D000] text-[#17191E]'
                                : 'border border-[#232632] text-[#F0D000]',
                            ].join(' ')}
                          >
                            {actionLabel(event)}
                          </Link>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ))}
          </div>
        )}
      </SectionCard>
    </>
  );
}
