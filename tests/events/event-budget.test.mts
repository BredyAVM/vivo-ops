import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  NEW_EVENT_BUDGET_COMMISSION,
  eventCommissionLabel,
  eventPreparationLabel,
  readEventBudgetPayload,
} from '../../src/lib/events/event-budget.ts';
import { resolveDeliveredCommissionItem } from '../../src/lib/commissions/delivered-order-commission.ts';

test('new events start with a fixed 5% on the negotiated event item', () => {
  assert.deepEqual(NEW_EVENT_BUDGET_COMMISSION, { mode: 'fixed_item', value: 5 });
  assert.ok(Object.isFrozen(NEW_EVENT_BUDGET_COMMISSION));
  const terms = resolveDeliveredCommissionItem({ mode: 'fixed_item', value: null }, [{
    kind: 'event_commercial_terms',
    commission_mode: NEW_EVENT_BUDGET_COMMISSION.mode,
    commission_value: NEW_EVENT_BUDGET_COMMISSION.value,
  }]).effective;
  assert.deepEqual(terms, NEW_EVENT_BUDGET_COMMISSION);
  assert.equal(Number((189 * (terms.value! / 100)).toFixed(2)), 9.45);
});

test('new and cleared editors use the creation default; editing uses saved terms', () => {
  const source = readFileSync(new URL('../../src/app/app/events/EventBudgetsClient.tsx', import.meta.url), 'utf8');
  assert.match(source, /useState<EventCommissionMode>\(NEW_EVENT_BUDGET_COMMISSION\.mode\)/);
  assert.match(source, /useState\(String\(NEW_EVENT_BUDGET_COMMISSION\.value\)\)/);
  const clear = source.slice(source.indexOf('function clearEditor()'), source.indexOf('function editDraft('));
  assert.match(clear, /setCommissionMode\(NEW_EVENT_BUDGET_COMMISSION\.mode\)/);
  assert.match(clear, /setCommissionValue\(String\(NEW_EVENT_BUDGET_COMMISSION\.value\)\)/);
  const edit = source.slice(source.indexOf('function editDraft('), source.indexOf('function searchClients('));
  assert.match(edit, /setCommissionMode\(draft\.budget\.commissionMode\)/);
  assert.match(edit, /setCommissionValue\(draft\.budget\.commissionValue == null \? '' : String\(draft\.budget\.commissionValue\)\)/);
  assert.doesNotMatch(edit, /NEW_EVENT_BUDGET_COMMISSION/);
});

test('historical event terms are read unchanged, without applying the new default', () => {
  for (const [mode, value] of [
    ['default', null], ['fixed_item', 7], ['fixed_item', 0], ['fixed_order', 5], ['none', null],
  ] as const) {
    const payload = { event_budget: { kind: 'admin_event_budget', commission_mode: mode, commission_value: value } };
    const before = JSON.stringify(payload);
    const budget = readEventBudgetPayload(payload);
    assert.equal(budget?.commissionMode, mode);
    assert.equal(budget?.commissionValue, value);
    assert.equal(JSON.stringify(payload), before);
  }
  const legacy = readEventBudgetPayload({ event_budget: { kind: 'admin_event_budget' } });
  assert.equal(legacy?.commissionMode, 'default');
  assert.equal(legacy?.commissionValue, null);
});

test('conversion preserves saved terms and reuses already converted orders', () => {
  const actions = readFileSync(new URL('../../src/app/app/events/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /if \(draft\.converted_order_id\) return/);
  assert.match(actions, /commission_mode: budget\.commissionMode/);
  assert.match(actions, /commission_value: budget\.commissionValue/);
  assert.match(actions, /existing\.status === 'converted' \|\| existing\.status === 'archived'/);
  assert.doesNotMatch(actions, /NEW_EVENT_BUDGET_COMMISSION|advisor_commission_closures/);
});

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
