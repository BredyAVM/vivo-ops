export type AdvisorCommissionSettlementInput = {
  carriedCommissionUsd?: number;
  priorAdvisorDebtUsd?: number;
  grossCommissionUsd: number;
  positiveAdjustmentsUsd?: number;
  giftDeductionsUsd?: number;
  directDeductionsUsd?: number;
  negativeAdjustmentsUsd?: number;
  outstandingCustomerDebtUsd?: number;
};

export type AdvisorCommissionSettlementCalculation = {
  carriedCommissionUsd: number;
  priorAdvisorDebtUsd: number;
  grossCommissionUsd: number;
  positiveAdjustmentsUsd: number;
  giftDeductionsUsd: number;
  directDeductionsUsd: number;
  negativeAdjustmentsUsd: number;
  outstandingCustomerDebtUsd: number;
  creditBeforeDeductionsUsd: number;
  requestedDeductionsUsd: number;
  deductionsAppliedUsd: number;
  creditAfterDeductionsUsd: number;
  payableUsd: number;
  retainedCommissionUsd: number;
  advisorDebtOutUsd: number;
  uncoveredCustomerDebtUsd: number;
};

type MonetaryInputName = keyof AdvisorCommissionSettlementInput;

function toNonNegativeCents(value: number | undefined, name: MonetaryInputName) {
  const normalized = value ?? 0;

  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${name} debe ser un monto finito mayor o igual a cero.`);
  }

  return Math.round((normalized + Number.EPSILON) * 100);
}

function fromCents(value: number) {
  return value / 100;
}

export function calculateAdvisorCommissionSettlement(
  input: AdvisorCommissionSettlementInput
): AdvisorCommissionSettlementCalculation {
  const carriedCommission = toNonNegativeCents(
    input.carriedCommissionUsd,
    'carriedCommissionUsd'
  );
  const priorAdvisorDebt = toNonNegativeCents(
    input.priorAdvisorDebtUsd,
    'priorAdvisorDebtUsd'
  );
  const grossCommission = toNonNegativeCents(
    input.grossCommissionUsd,
    'grossCommissionUsd'
  );
  const positiveAdjustments = toNonNegativeCents(
    input.positiveAdjustmentsUsd,
    'positiveAdjustmentsUsd'
  );
  const giftDeductions = toNonNegativeCents(
    input.giftDeductionsUsd,
    'giftDeductionsUsd'
  );
  const directDeductions = toNonNegativeCents(
    input.directDeductionsUsd,
    'directDeductionsUsd'
  );
  const negativeAdjustments = toNonNegativeCents(
    input.negativeAdjustmentsUsd,
    'negativeAdjustmentsUsd'
  );
  const outstandingCustomerDebt = toNonNegativeCents(
    input.outstandingCustomerDebtUsd,
    'outstandingCustomerDebtUsd'
  );

  const creditBeforeDeductions =
    carriedCommission + grossCommission + positiveAdjustments;
  const requestedDeductions =
    priorAdvisorDebt + giftDeductions + directDeductions + negativeAdjustments;
  const deductionsApplied = Math.min(
    creditBeforeDeductions,
    requestedDeductions
  );
  const creditAfterDeductions = creditBeforeDeductions - deductionsApplied;
  const advisorDebtOut = requestedDeductions - deductionsApplied;
  const retainedCommission = Math.min(
    creditAfterDeductions,
    outstandingCustomerDebt
  );
  const payable = creditAfterDeductions - retainedCommission;
  const uncoveredCustomerDebt = outstandingCustomerDebt - retainedCommission;

  return {
    carriedCommissionUsd: fromCents(carriedCommission),
    priorAdvisorDebtUsd: fromCents(priorAdvisorDebt),
    grossCommissionUsd: fromCents(grossCommission),
    positiveAdjustmentsUsd: fromCents(positiveAdjustments),
    giftDeductionsUsd: fromCents(giftDeductions),
    directDeductionsUsd: fromCents(directDeductions),
    negativeAdjustmentsUsd: fromCents(negativeAdjustments),
    outstandingCustomerDebtUsd: fromCents(outstandingCustomerDebt),
    creditBeforeDeductionsUsd: fromCents(creditBeforeDeductions),
    requestedDeductionsUsd: fromCents(requestedDeductions),
    deductionsAppliedUsd: fromCents(deductionsApplied),
    creditAfterDeductionsUsd: fromCents(creditAfterDeductions),
    payableUsd: fromCents(payable),
    retainedCommissionUsd: fromCents(retainedCommission),
    advisorDebtOutUsd: fromCents(advisorDebtOut),
    uncoveredCustomerDebtUsd: fromCents(uncoveredCustomerDebt),
  };
}
