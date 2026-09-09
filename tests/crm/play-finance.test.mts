import assert from 'node:assert/strict';
import test from 'node:test';
import { getPlayBudgetProgress } from '../../src/lib/crm/play-finance.ts';

test('reports actual company investment against the frozen play budget', () => {
  assert.deepEqual(
    getPlayBudgetProgress({ plannedBudgetUsd: 250, companyCostUsd: 62.5 }),
    {
      plannedBudgetUsd: 250,
      companyCostUsd: 62.5,
      remainingBudgetUsd: 187.5,
      usagePct: 25,
      status: 'within',
    },
  );
});

test('flags actual investment above budget without hiding the negative balance', () => {
  assert.deepEqual(
    getPlayBudgetProgress({ plannedBudgetUsd: 100, companyCostUsd: 112.25 }),
    {
      plannedBudgetUsd: 100,
      companyCostUsd: 112.25,
      remainingBudgetUsd: -12.25,
      usagePct: 112.3,
      status: 'exceeded',
    },
  );
});

test('keeps actual investment visible when no budget was defined', () => {
  assert.deepEqual(
    getPlayBudgetProgress({ plannedBudgetUsd: null, companyCostUsd: 18 }),
    {
      plannedBudgetUsd: null,
      companyCostUsd: 18,
      remainingBudgetUsd: null,
      usagePct: null,
      status: 'not_defined',
    },
  );
});
