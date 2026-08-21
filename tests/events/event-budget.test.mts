import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eventCommissionLabel,
  eventPreparationLabel,
  readEventBudgetPayload,
} from '../../src/lib/events/event-budget.ts';

test('reads the canonical administrative event payload without losing commercial origin', () => {
  const budget = readEventBudgetPayload({
    event_budget: {
      kind: 'admin_event_budget',
      schema_version: 1,
      title: 'Evento Colegio Vivo',
      event_date: '2026-09-15',
      event_time: '18:30',
      fulfillment: 'delivery',
      delivery_address: 'Maracaibo',
      negotiated_currency: 'VES',
      negotiated_amount: 25000,
      total_usd: 50,
      commission_mode: 'fixed_item',
      commission_value: 7,
      components: [
        {
          product_id: 5,
          product_name: 'Mini Tequeños Fritos',
          qty: 200,
          preparation_mode: 'on_site',
        },
      ],
    },
  });

  assert.ok(budget);
  assert.equal(budget.negotiatedCurrency, 'VES');
  assert.equal(budget.negotiatedAmount, 25000);
  assert.equal(budget.totalUsd, 50);
  assert.equal(budget.components[0]?.preparationMode, 'on_site');
  assert.equal(eventPreparationLabel('on_site'), 'Freír en el sitio');
  assert.equal(eventCommissionLabel('fixed_item', 7), '7.00% específico');
});

test('rejects ordinary advisor drafts as event budgets', () => {
  assert.equal(readEventBudgetPayload({ items: [] }), null);
});
