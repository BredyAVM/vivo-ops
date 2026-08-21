'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import AdvisorPendingLink from '../AdvisorPendingLink';
import { EmptyBlock, SectionCard, StatusBadge } from '../advisor-ui';
import { markAdvisorInboxItemsReadAction } from './actions';
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

function actionHref(event: InboxEvent, activeFilter: InboxFilter) {
  const returnTo = `/app/advisor/inbox?filter=${activeFilter}`;
  if (event.href?.startsWith('/app/advisor/commissions')) {
    return withAdvisorReturnTo(event.href, returnTo);
  }
  if (event.eventType === 'payment_rejected') {
    return withAdvisorReturnTo(`/app/advisor/orders/${event.orderId}?reportPayment=1`, returnTo);
  }

  if (event.eventType === 'order_returned_to_review' || event.eventType === 'order_changes_rejected') {
    return withAdvisorReturnTo(`/app/advisor/new?fromOrder=${event.orderId}`, returnTo);
  }

  return withAdvisorReturnTo(`/app/advisor/orders/${event.orderId}`, returnTo);
}

function actionLabel(event: InboxEvent) {
  if (
    event.eventType === 'advisor_commission_review_ready' ||
    event.eventType === 'advisor_commission_reconfirmation_required'
  ) {
    return 'Revisar liquidación';
  }
  if (event.eventType.startsWith('advisor_commission_')) return 'Ver comisiones';
  if (event.eventType === 'payment_rejected') return 'Corregir pago';
  if (event.eventType === 'order_returned_to_review' || event.eventType === 'order_changes_rejected') {
    return 'Corregir pedido';
  }
  return 'Abrir pedido';
}

export default function AdvisorInboxClient({
  activeFilter,
  initialEvents,
}: {
  activeFilter: InboxFilter;
  initialEvents: InboxEvent[];
}) {
  const router = useRouter();
  const [events, setEvents] = useState(initialEvents);
  const [savingIds, setSavingIds] = useState<string[]>([]);
  const [markingAll, setMarkingAll] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useEffect(() => {
    const refreshInbox = () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }

      refreshTimerRef.current = setTimeout(() => {
        router.refresh();
        refreshTimerRef.current = null;
      }, 220);
    };

    window.addEventListener('advisor:notification', refreshInbox);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      window.removeEventListener('advisor:notification', refreshInbox);
    };
  }, [router]);

  const unreadCount = useMemo(
    () => events.filter((event) => !event.readAt).length,
    [events]
  );
  const pendingEvents = useMemo(
    () => events.filter((event) => event.requiresAction),
    [events],
  );
  const todayEvents = useMemo(() => events.filter((event) => isTodayEvent(event.createdAt)), [events]);
  const earlierEvents = useMemo(() => events.filter((event) => !isTodayEvent(event.createdAt)), [events]);

  function readKey(event: InboxEvent) {
    return `${event.source}:${event.recipientId}`;
  }

  function isSaving(event: InboxEvent) {
    return savingIds.includes(readKey(event));
  }

  async function markNotificationRead(event: InboxEvent) {
    const currentEvent = events.find((candidate) => candidate.id === event.id);
    if (!currentEvent || currentEvent.readAt) return;
    const key = readKey(currentEvent);

    setSavingIds((current) => [...current, key]);

    const nextReadAt = new Date().toISOString();
    const previousEvents = events;
    setEvents((current) =>
      current.map((event) =>
        event.id === currentEvent.id ? { ...event, readAt: nextReadAt } : event
      )
    );

    try {
      await markAdvisorInboxItemsReadAction([
        { source: currentEvent.source, id: currentEvent.recipientId },
      ]);
    } catch {
      setEvents(previousEvents);
    }

    setSavingIds((current) => current.filter((id) => id !== key));
  }

  async function markAllVisibleAsRead() {
    const unreadEvents = events.filter((event) => !event.readAt);
    if (unreadEvents.length === 0) return;
    const readKeys = unreadEvents.map(readKey);

    setMarkingAll(true);
    setSavingIds((current) => [...current, ...readKeys]);

    const nextReadAt = new Date().toISOString();
    const previousEvents = events;
    setEvents((current) =>
      current.map((event) =>
        readKeys.includes(readKey(event)) ? { ...event, readAt: nextReadAt } : event
      )
    );

    try {
      await markAdvisorInboxItemsReadAction(
        unreadEvents.map((event) => ({ source: event.source, id: event.recipientId })),
      );
    } catch {
      setEvents(previousEvents);
    }

    setSavingIds((current) => current.filter((id) => !readKeys.includes(id)));
    setMarkingAll(false);
  }

  const groupedSections: Array<{ key: string; title: string; rows: InboxEvent[] }> = activeFilter === 'pending'
    ? [{ key: 'pending', title: 'Accion requerida', rows: pendingEvents }]
    : activeFilter === 'updates'
      ? [
          { key: 'today', title: 'Seguimiento de hoy', rows: todayEvents.filter((event) => !event.requiresAction) },
          { key: 'earlier', title: 'Antes', rows: earlierEvents.filter((event) => !event.requiresAction) },
        ]
    : activeFilter === 'all'
      ? [
          { key: 'pending', title: 'Accion requerida', rows: pendingEvents },
          { key: 'today', title: 'Seguimiento de hoy', rows: todayEvents.filter((event) => !event.requiresAction) },
          { key: 'earlier', title: 'Antes', rows: earlierEvents.filter((event) => !event.requiresAction) },
        ]
      : [
          { key: 'today', title: 'Seguimiento de hoy', rows: todayEvents },
          { key: 'earlier', title: 'Antes', rows: earlierEvents },
        ];
  const visibleEventCount = groupedSections.reduce((sum, section) => sum + section.rows.length, 0);
  const visibleFilters = activeFilter === 'pending'
    ? []
    : activeFilter === 'updates' || activeFilter === 'kitchen' || activeFilter === 'delivery' || activeFilter === 'payments' || activeFilter === 'commissions'
      ? []
      : FILTERS;
  const sectionTitle = activeFilter === 'pending'
    ? 'Acciones por atender'
    : activeFilter === 'commissions'
      ? 'Comisiones'
    : activeFilter === 'updates'
      ? 'Seguimiento operativo'
      : 'Bandeja';
  const emptyTitle = activeFilter === 'pending' ? 'Sin acciones pendientes' : 'Sin eventos para este filtro';
  const emptyDetail = activeFilter === 'pending'
    ? 'Cuando una orden o liquidación requiera tu revisión, aparecerá aquí.'
    : activeFilter === 'commissions'
      ? 'Cuando una liquidación esté lista o reciba un abono, aparecerá aquí.'
    : 'Cuando haya movimiento operativo, aparecera aqui sin mezclarlo con acciones.';

  return (
    <>
      {visibleFilters.length > 0 ? (
        <section className="overflow-x-auto pb-1">
          <div className="flex min-w-max gap-2">
            {visibleFilters.map((filter) => (
              <AdvisorPendingLink
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
              </AdvisorPendingLink>
            ))}
          </div>
        </section>
      ) : null}

      <SectionCard
        title={sectionTitle}
        subtitle={
          activeFilter === 'pending'
            ? 'Solo llamadas de accion para resolver cuanto antes.'
            : activeFilter === 'commissions'
              ? 'Revisiones y pagos de tus liquidaciones, sin mezclarlos con pedidos.'
            : activeFilter === 'updates'
              ? 'Seguimiento operativo sin acciones pendientes.'
              : 'Ultimo estado por orden, sin ruido duplicado.'
        }
        action={
          <div className="flex items-center gap-2">
            {pendingEvents.length > 0 ? (
              <StatusBadge label={`${pendingEvents.length} por atender`} tone="warning" />
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
        {visibleEventCount === 0 ? (
          <EmptyBlock
            title={emptyTitle}
            detail={emptyDetail}
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
                    const isCompactUpdate = !event.requiresAction;

                    if (isCompactUpdate) {
                      return (
                        <AdvisorPendingLink
                          key={event.id}
                          href={actionHref(event, activeFilter)}
                          onClick={() => {
                            if (!isRead && !isSaving(event)) {
                              void markNotificationRead(event);
                            }
                          }}
                          className={[
                            'advisor-fade-in block rounded-[16px] border px-3.5 py-3 transition',
                            isRead ? 'border-[#232632] bg-[#0F131B]' : 'border-[#33405A] bg-[#101722]',
                          ].join(' ')}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                {!isRead ? <span className="h-2 w-2 rounded-full bg-[#F0D000]" /> : null}
                                <div className="truncate text-sm font-semibold text-[#F5F7FB]">
                                  {event.orderNumber} · {event.clientName}
                                </div>
                              </div>
                              <div className="mt-1 line-clamp-2 text-xs leading-5 text-[#AAB2C5]">
                                {event.title}: {event.message}
                              </div>
                              <div className="mt-1 text-[11px] text-[#6F7890]">{formatEventTime(event.createdAt)}</div>
                            </div>
                            <StatusBadge label={event.title} tone={event.tone} />
                          </div>
                        </AdvisorPendingLink>
                      );
                    }

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
                              <div className="truncate text-sm font-semibold text-[#F5F7FB]">
                                {event.orderNumber} · {event.clientName}
                              </div>
                            </div>
                            <div className="mt-1 text-xs text-[#8B93A7]">{event.deliveryLabel}</div>
                          </div>
                          <div className="flex flex-col items-end gap-1.5">
                            <StatusBadge label={event.title} tone={event.tone} />
                          </div>
                        </div>

                        <div className="mt-3 rounded-[14px] bg-[#0B1017] px-3 py-2 text-xs leading-5 text-[#AAB2C5]">
                          <div className="font-medium text-[#F5F7FB]">{event.message}</div>
                          {event.detailLines.map((line) => (
                            <div key={`${event.id}-${line}`}>{line}</div>
                          ))}
                        </div>

                        <div className="mt-3 grid grid-cols-[minmax(64px,1fr)_auto_auto] items-center gap-2 text-xs text-[#8B93A7]">
                          <span className="min-w-0 leading-5">{formatEventTime(event.createdAt)}</span>
                          <div className="justify-self-end">
                            {!isRead ? (
                              <button
                                type="button"
                                onClick={() => void markNotificationRead(event)}
                                disabled={isSaving(event)}
                                className="inline-flex h-8 items-center rounded-[10px] border border-[#232632] px-2 text-[10px] font-medium text-[#CCD3E2] disabled:text-[#6F7890]"
                              >
                                {isSaving(event) ? 'Guardando...' : 'Visto'}
                              </button>
                            ) : (
                              <span className="inline-flex h-8 items-center px-2 text-[10px] text-[#6F7890]">Leída</span>
                            )}
                          </div>
                          <AdvisorPendingLink
                            href={actionHref(event, activeFilter)}
                            onClick={() => {
                              if (!isRead && !isSaving(event)) {
                                void markNotificationRead(event);
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
                          </AdvisorPendingLink>
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
