export type PaymentReportMethodCode =
  | 'payment_mobile'
  | 'transfer'
  | 'zelle'
  | 'cash_usd'
  | 'cash_ves'
  | 'pos'
  | 'mixed'
  | 'pending';

export type PaymentReportRequirements = {
  requiresOperationDate: boolean;
  requiresReference: boolean;
  requiresBank: boolean;
  requiresHolderName: boolean;
};

export type PaymentReportDetailsInput = {
  method?: string | null;
  operationDate?: string | null;
  referenceCode?: string | null;
  bankName?: string | null;
  holderName?: string | null;
};

export const EMPTY_PAYMENT_REPORT_REQUIREMENTS: PaymentReportRequirements = {
  requiresOperationDate: false,
  requiresReference: false,
  requiresBank: false,
  requiresHolderName: false,
};

export function getPaymentReportRequirements(method: string | null | undefined): PaymentReportRequirements {
  if (method === 'payment_mobile' || method === 'transfer') {
    return {
      requiresOperationDate: true,
      requiresReference: true,
      requiresBank: true,
      requiresHolderName: false,
    };
  }

  if (method === 'zelle') {
    return {
      requiresOperationDate: true,
      requiresReference: true,
      requiresBank: false,
      requiresHolderName: true,
    };
  }

  return EMPTY_PAYMENT_REPORT_REQUIREMENTS;
}

export function validatePaymentReportDetails(input: PaymentReportDetailsInput) {
  const requirements = getPaymentReportRequirements(input.method);

  if (requirements.requiresOperationDate && !String(input.operationDate || '').trim()) {
    return 'Debes indicar la fecha de la operación.';
  }

  if (requirements.requiresReference && !String(input.referenceCode || '').trim()) {
    return 'Debes indicar la referencia de la operación.';
  }

  if (requirements.requiresBank && !String(input.bankName || '').trim()) {
    return 'Debes indicar el banco de la operación.';
  }

  if (requirements.requiresHolderName && !String(input.holderName || '').trim()) {
    return 'Debes indicar el nombre del titular de Zelle.';
  }

  return null;
}
