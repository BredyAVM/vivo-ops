import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPlaysByMonth, isPlayCurrentlyActive } from '../../src/lib/crm/play-dates.ts';

const play = (id: number, startsAt: string | null, status = 'closed', endsAt: string | null = null) => ({ id, name: `Jugada ${id}`, startsAt, endsAt, status });
const today = '2026-10-02';

test('groups by start month and year, newest first, without mutating inputs', () => {
  const plays = Object.freeze([play(1, '2025-09-01'), play(2, '2026-09-01'), play(3, '2026-10-01', 'draft'), play(4, '2026-09-15')]);
  const groups = groupPlaysByMonth(plays, today);
  assert.deepEqual(groups.map(g => g.key), ['2026-10', '2026-09', '2025-09']);
  assert.deepEqual(groups.map(g => g.plays.map(p => p.id)), [[3], [2, 4], [1]]);
  assert.deepEqual(groups.map(g => g.defaultOpen), [true, false, false]);
  assert.deepEqual(plays.map(p => p.id), [1, 2, 3, 4]);
});

test('Caracas boundary determines month, never UTC or creation date', () => {
  const result = groupPlaysByMonth([{ ...play(1, '2026-10-01T02:00:00Z'), createdAt: '2026-10-02' }], today);
  assert.equal(result[0].key, '2026-09');
  assert.equal(result[0].label, 'septiembre de 2026');
});

test('an active spanning campaign opens its original month; expired/future campaigns do not', () => {
  const groups = groupPlaysByMonth([play(1, '2026-08-01', 'active', '2026-08-31'), play(2, '2026-09-01', 'active', '2026-10-15'), play(3, '2026-11-01', 'active')], today);
  assert.deepEqual(groups.map(g => [g.key, g.defaultOpen]), [['2026-11', false], ['2026-09', true], ['2026-08', false]]);
  assert.deepEqual(groupPlaysByMonth(groups.flatMap(g => g.plays), today, '', 'active').flatMap(g => g.plays.map(p => p.id)), [2]);
});

test('closed campaign stays closed regardless of an individual exception', () => {
  const campaign = { ...play(1, '2026-09-01', 'closed', '2026-09-30'), exceptionUntil: '2026-10-15' };
  assert.equal(isPlayCurrentlyActive(campaign, today), false);
  assert.equal(groupPlaysByMonth([campaign], today)[0].defaultOpen, false);
});

test('missing or invalid dates are discoverable under Sin período', () => {
  const groups = groupPlaysByMonth([play(1, null, 'draft'), play(2, 'invalid', 'draft')], today);
  assert.equal(groups[0].label, 'Sin período');
  assert.equal(groups[0].defaultOpen, true);
  assert.equal(groups[0].plays.length, 2);
});

test('search matches name or month without accents and combines with status', () => {
  const plays = [{ ...play(1, '2026-09-01'), name: 'Reconexión LC' }, play(2, '2026-10-01', 'draft')];
  assert.equal(groupPlaysByMonth(plays, today, ' RECONEXION ')[0].plays[0].id, 1);
  assert.equal(groupPlaysByMonth(plays, today, 'septiembre  ')[0].plays[0].id, 1);
  assert.equal(groupPlaysByMonth(plays, today, '', 'draft')[0].plays[0].id, 2);
  assert.equal(groupPlaysByMonth(plays, today, 'septiembre', 'draft').length, 0);
  assert.deepEqual(groupPlaysByMonth([], today), []);
});

test('active includes both first and final business day', () => {
  const campaign = play(1, '2026-09-01T04:00:00Z', 'active', '2026-10-01T03:59:59.999Z');
  assert.equal(isPlayCurrentlyActive(campaign, '2026-09-01'), true);
  assert.equal(isPlayCurrentlyActive(campaign, '2026-09-30'), true);
  assert.equal(isPlayCurrentlyActive(campaign, '2026-10-01'), false);
});
