export type PlayBudgetProgress = {
  plannedBudgetUsd: number | null;
  companyCostUsd: number;
  remainingBudgetUsd: number | null;
  usagePct: number | null;
  status: 'not_defined' | 'within' | 'exceeded';
};

function nonNegativeMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Number(value.toFixed(2)));
}

export function getPlayBudgetProgress(input: {
  plannedBudgetUsd: number | null;
  companyCostUsd: number;
}): PlayBudgetProgress {
  const plannedBudgetUsd = nonNegativeMoney(input.plannedBudgetUsd);
  const companyCostUsd = nonNegativeMoney(input.companyCostUsd) ?? 0;

  if (plannedBudgetUsd == null) {
    return {
      plannedBudgetUsd: null,
      companyCostUsd,
      remainingBudgetUsd: null,
      usagePct: null,
      status: 'not_defined',
    };
  }

  const remainingBudgetUsd = Number((plannedBudgetUsd - companyCostUsd).toFixed(2));
  const usagePct = plannedBudgetUsd > 0
    ? Number(((companyCostUsd / plannedBudgetUsd) * 100).toFixed(1))
    : companyCostUsd > 0 ? 100 : 0;

  return {
    plannedBudgetUsd,
    companyCostUsd,
    remainingBudgetUsd,
    usagePct,
    status: remainingBudgetUsd < -0.005 ? 'exceeded' : 'within',
  };
}
