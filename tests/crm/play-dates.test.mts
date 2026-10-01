import assert from 'node:assert/strict';
import test from 'node:test';
import { playDateInput } from '../../src/lib/crm/play-dates.ts';

test('UTC end of September remains September 30 in Venezuela', () => {
  assert.equal(playDateInput('2026-10-01T03:59:59.999Z'),'2026-09-30');
  assert.equal(playDateInput('2026-10-01T03:59:59.999+00:00'),'2026-09-30');
  assert.equal(playDateInput('2026-09-30T23:59:59.999-04:00'),'2026-09-30');
});
test('opening and saving the same period repeatedly never adds days', () => {
  let end = '2026-10-01T03:59:59.999Z';
  for(let i=0;i<10;i++) {
    const date = playDateInput(end);
    assert.equal(date,'2026-09-30');
    end = new Date(`${date}T23:59:59.999-04:00`).toISOString();
  }
});
test('calendar dates, starts, year boundary and leap day retain business days', () => {
  assert.equal(playDateInput('2026-09-30'),'2026-09-30');
  assert.equal(playDateInput('2026-09-01T04:00:00Z'),'2026-09-01');
  assert.equal(playDateInput('2027-01-01T03:59:59.999Z'),'2026-12-31');
  assert.equal(playDateInput('2028-03-01T03:59:59.999Z'),'2028-02-29');
});
test('invalid, missing and timezone-less values are not guessed', () => {
  for(const value of [null,undefined,'','bad','2026-09-30T23:59:59']) assert.equal(playDateInput(value),'');
});
