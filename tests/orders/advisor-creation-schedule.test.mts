import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { refreshAdvisorAsapSchedule } from '../../src/lib/orders/advisor-creation-schedule.ts';

const saved = { date: '2026-10-01', time_12: '9:30 AM', time_24: '09:30', asap: true };

test('an ASAP draft uses confirmation time, not saved time or next half hour', () => {
  assert.deepEqual(refreshAdvisorAsapSchedule(saved, new Date('2026-10-12T19:47:59Z')), {
    date: '2026-10-12', time_12: '3:47 PM', time_24: '15:47', asap: true,
  });
  assert.equal(saved.date, '2026-10-01');
});

test('scheduled drafts preserve their exact delivery date and time', () => {
  const scheduled = { ...saved, asap: false };
  assert.equal(refreshAdvisorAsapSchedule(scheduled, new Date('2026-10-12T19:47:59Z')), scheduled);
});

test('Caracas day, midnight and noon are independent of device/server timezone', () => {
  assert.deepEqual(refreshAdvisorAsapSchedule(saved, new Date('2026-10-13T02:05:00Z')), {
    date: '2026-10-12', time_12: '10:05 PM', time_24: '22:05', asap: true,
  });
  assert.deepEqual(refreshAdvisorAsapSchedule(saved, new Date('2026-10-13T04:00:00Z')), {
    date: '2026-10-13', time_12: '12:00 AM', time_24: '00:00', asap: true,
  });
  assert.equal(refreshAdvisorAsapSchedule(saved, new Date('2026-10-13T16:00:00Z')).time_12, '12:00 PM');
});

test('creation retries keep the same schedule and unrelated schedule fields', () => {
  const attemptTime = new Date('2026-10-12T19:47:59Z');
  const schedule = { ...saved, note: 'Conservar' };
  const first = refreshAdvisorAsapSchedule(schedule, attemptTime);
  assert.deepEqual(refreshAdvisorAsapSchedule(schedule, attemptTime), first);
  assert.equal(first.note, 'Conservar');
});

test('composer refreshes only on creation, keeps retry time and rechecks ASAP availability now', () => {
  const composer = readFileSync(new URL('../../src/app/app/advisor/new/AdvisorOrderComposer.tsx', import.meta.url), 'utf8');
  assert.match(composer, /if \(!isEditingOrder && !orderCreationTimeRef\.current\)/);
  assert.match(composer, /buildExtraFields\(isEditingOrder \? undefined : orderCreationTimeRef\.current/);
  assert.match(composer, /schedule: creationTime \? refreshAdvisorAsapSchedule\(/);
  assert.match(composer, /p_target_at: isAsap \? new Date\(\)\.toISOString\(\) : availabilityTargetAt/);
  assert.match(composer, /targetOrderId = createResult\.orderId;\s*orderCreationRequestRef\.current = null;\s*orderCreationTimeRef\.current = null/);
});
