import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coalesceInboxEvents,
  countCommissionNotificationsByKind,
  getFilterForEvent,
  type InboxEvent,
} from '../../src/app/app/advisor/inbox/inbox-shared.ts';

test('separa revisiones de comisiones de sus actualizaciones informativas', () => {
  const counts = countCommissionNotificationsByKind([
    {
      id: 1,
      status: 'unread',
      title: 'Revisar',
      body: null,
      created_at: '2026-08-21T10:00:00.000Z',
      read_at: null,
      meta: {
        domain: 'advisor_commissions',
        kind: 'advisor_commission_review_ready',
        requires_action: true,
      },
    },
    {
      id: 2,
      status: 'read',
      title: 'Abono',
      body: null,
      created_at: '2026-08-21T11:00:00.000Z',
      read_at: '2026-08-21T11:05:00.000Z',
      meta: {
        domain: 'advisor_commissions',
        kind: 'advisor_commission_payment_recorded',
        requires_action: false,
      },
    },
    {
      id: 3,
      status: 'unread',
      title: 'Pedido',
      body: null,
      created_at: '2026-08-21T12:00:00.000Z',
      read_at: null,
      meta: { domain: 'orders' },
    },
  ]);

  assert.deepEqual(counts, {
    actions: 1,
    updates: 1,
    total: 2,
    unreadActions: 1,
    unreadUpdates: 0,
    unreadTotal: 1,
  });
});

test('mantiene cada abono de comisión como evento auditable', () => {
  const base: Omit<InboxEvent, 'id' | 'recipientId' | 'createdAt'> = {
    source: 'notification',
    orderId: 0,
    orderNumber: 'Comisiones',
    clientName: 'Agosto 01',
    deliveryLabel: 'Liquidación de Agosto 01',
    title: 'Abono registrado',
    message: 'Abono',
    eventType: 'advisor_commission_payment_recorded',
    detailLines: [],
    requiresAction: false,
    readAt: null,
    tone: 'success',
    href: '/app/advisor/commissions?period=5',
  };
  const events = coalesceInboxEvents([
    { ...base, id: 'notification-1', recipientId: 1, createdAt: '2026-08-21T10:00:00.000Z' },
    { ...base, id: 'notification-2', recipientId: 2, createdAt: '2026-08-21T11:00:00.000Z' },
  ]);

  assert.equal(events.length, 2);
  assert.equal(events[0]?.id, 'notification-2');
  assert.equal(getFilterForEvent('advisor_commission_payment_recorded'), 'commissions');
});

test('clasifica las metas dentro de comisiones y permite cerrar su revisión', () => {
  const counts = countCommissionNotificationsByKind([
    {
      id: 10,
      status: 'unread',
      title: 'Nueva meta',
      body: null,
      created_at: '2026-08-26T10:00:00.000Z',
      read_at: null,
      meta: {
        domain: 'advisor_commissions',
        kind: 'advisor_goal_published',
        requires_action: true,
      },
    },
    {
      id: 11,
      status: 'read',
      title: 'Resultado',
      body: null,
      created_at: '2026-08-26T11:00:00.000Z',
      read_at: '2026-08-26T11:05:00.000Z',
      meta: {
        domain: 'advisor_commissions',
        kind: 'advisor_goal_finalized',
        requires_action: false,
      },
    },
  ]);

  assert.equal(getFilterForEvent('advisor_goal_published'), 'commissions');
  assert.equal(getFilterForEvent('advisor_goal_finalized'), 'commissions');
  assert.deepEqual(counts, {
    actions: 1,
    updates: 1,
    total: 2,
    unreadActions: 1,
    unreadUpdates: 0,
    unreadTotal: 1,
  });
});
