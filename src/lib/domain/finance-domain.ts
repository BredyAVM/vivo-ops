export type PaymentReportStatus = 'pending' | 'confirmed' | 'rejected';

export type PaymentStatusKey =
  | 'unpaid'
  | 'partial'
  | 'pending_review'
  | 'paid'
  | 'overpaid'
  | 'cancelled';

export type OfficialPaymentDateKey =
  | 'payment_operation_date'
  | 'payment_reported_at'
  | 'order_delivery_reference_date'
  | 'payment_confirmed_at';

export type MoneyAccountClosureKind =
  | 'bank'
  | 'cash'
  | 'fund'
  | 'other'
  | 'pos'
  | 'wallet_usd'
  | 'retention';

export type MoneyAccountKind = 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';

export type FinanceAccountWorkstream =
  | 'bank'
  | 'pos'
  | 'cash'
  | 'wallet'
  | 'retention'
  | 'fund'
  | 'other';

export type FinanceClosureVocabulary = {
  workstream: FinanceAccountWorkstream;
  sectionLabel: string;
  sectionHint: string;
  operationName: string;
  operationTitle: string;
  primaryActionLabel: string;
  historyTitle: string;
  expectedLabel: string;
  countedLabel: string;
  differenceLabel: string;
  zeroDifferenceMessage: string;
  transferMessage: string | null;
};

export const PAYMENT_REPORT_STATUS_LABELS: Record<PaymentReportStatus, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmado',
  rejected: 'Rechazado',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatusKey, string> = {
  unpaid: 'Sin pago',
  partial: 'Parcial',
  pending_review: 'En revision',
  paid: 'Pagado',
  overpaid: 'Sobrepagado',
  cancelled: 'Cancelado',
};

export const OFFICIAL_PAYMENT_DATES: Array<{
  key: OfficialPaymentDateKey;
  label: string;
  meaning: string;
}> = [
  {
    key: 'payment_operation_date',
    label: 'Fecha de operacion bancaria',
    meaning: 'Fecha en que el pago aparece en banco, punto, caja o wallet.',
  },
  {
    key: 'payment_reported_at',
    label: 'Fecha de reporte',
    meaning: 'Fecha en que asesor, counter o master cargo el pago.',
  },
  {
    key: 'order_delivery_reference_date',
    label: 'Fecha del pedido',
    meaning: 'Fecha que define cobranza snapshot y condiciones de tasa.',
  },
  {
    key: 'payment_confirmed_at',
    label: 'Fecha de confirmacion',
    meaning: 'Fecha de auditoria de quien confirmo; no debe reemplazar la fecha bancaria.',
  },
];

export const MONEY_ACCOUNT_CLOSURE_LABELS: Record<MoneyAccountClosureKind, string> = {
  bank: 'Banco',
  cash: 'Caja',
  fund: 'Fondo',
  other: 'Otro',
  pos: 'Punto',
  wallet_usd: 'Wallet USD',
  retention: 'Retenciones',
};

export const MONEY_ACCOUNT_KIND_LABELS: Record<MoneyAccountKind, string> = {
  bank: 'Banco',
  cash: 'Caja',
  fund: 'Fondo',
  other: 'Otro',
  pos: 'Punto',
  wallet: 'Wallet',
};

export const FINANCE_WORKSTREAM_ORDER: FinanceAccountWorkstream[] = [
  'bank',
  'pos',
  'cash',
  'wallet',
  'retention',
  'fund',
  'other',
];

export const FINANCE_WORKSTREAM_LABELS: Record<FinanceAccountWorkstream, string> = {
  bank: 'Bancos',
  pos: 'Puntos',
  cash: 'Cajas chicas',
  wallet: 'Wallets',
  retention: 'Retenciones',
  fund: 'Fondos',
  other: 'Otras cuentas',
};

export const FINANCE_WORKSTREAM_HINTS: Record<FinanceAccountWorkstream, string> = {
  bank: 'Conciliación contra saldo real del banco.',
  pos: 'Cierre operativo del punto y traspaso posterior al banco.',
  cash: 'Arqueo físico de efectivo.',
  wallet: 'Conciliación de wallet con comisiones o diferencias.',
  retention: 'Control de retenciones recibidas, aplicadas y pendientes.',
  fund: 'Control de saldos internos.',
  other: 'Cuentas administrativas con regla pendiente o especial.',
};

export function getFinanceAccountWorkstream(input: {
  accountKind: MoneyAccountKind;
  closureKind?: MoneyAccountClosureKind | null;
}): FinanceAccountWorkstream {
  if (input.closureKind === 'retention') return 'retention';
  if (input.closureKind === 'wallet_usd') return 'wallet';
  if (input.closureKind === 'bank') return 'bank';
  if (input.closureKind === 'cash') return 'cash';
  if (input.closureKind === 'pos') return 'pos';
  if (input.closureKind === 'fund') return 'fund';

  if (input.accountKind === 'wallet') return 'wallet';
  if (input.accountKind === 'bank') return 'bank';
  if (input.accountKind === 'cash') return 'cash';
  if (input.accountKind === 'pos') return 'pos';
  if (input.accountKind === 'fund') return 'fund';
  return 'other';
}

export function getFinanceClosureVocabulary(input: {
  accountKind: MoneyAccountKind;
  closureKind?: MoneyAccountClosureKind | null;
}): FinanceClosureVocabulary {
  const workstream = getFinanceAccountWorkstream(input);

  switch (workstream) {
    case 'bank':
      return {
        workstream,
        sectionLabel: FINANCE_WORKSTREAM_LABELS.bank,
        sectionHint: FINANCE_WORKSTREAM_HINTS.bank,
        operationName: 'conciliación',
        operationTitle: 'Conciliación bancaria',
        primaryActionLabel: 'Conciliar',
        historyTitle: 'Conciliaciones',
        expectedLabel: 'Saldo sistema',
        countedLabel: 'Saldo banco',
        differenceLabel: 'Diferencia',
        zeroDifferenceMessage: 'El saldo banco coincide con el saldo sistema.',
        transferMessage: null,
      };
    case 'pos':
      return {
        workstream,
        sectionLabel: FINANCE_WORKSTREAM_LABELS.pos,
        sectionHint: FINANCE_WORKSTREAM_HINTS.pos,
        operationName: 'cierre de punto',
        operationTitle: 'Cierre de punto',
        primaryActionLabel: 'Cerrar punto',
        historyTitle: 'Cierres de punto',
        expectedLabel: 'Esperado sistema',
        countedLabel: 'Monto del cierre',
        differenceLabel: 'Diferencia',
        zeroDifferenceMessage: 'El punto cierra sin diferencia.',
        transferMessage: 'Luego registra el traspaso cuando el dinero llegue al banco.',
      };
    case 'cash':
      return {
        workstream,
        sectionLabel: FINANCE_WORKSTREAM_LABELS.cash,
        sectionHint: FINANCE_WORKSTREAM_HINTS.cash,
        operationName: 'arqueo',
        operationTitle: 'Arqueo de caja',
        primaryActionLabel: 'Arqueo',
        historyTitle: 'Arqueos',
        expectedLabel: 'Esperado sistema',
        countedLabel: 'Efectivo contado',
        differenceLabel: 'Diferencia',
        zeroDifferenceMessage: 'La caja cuadra con el sistema.',
        transferMessage: null,
      };
    case 'wallet':
      return {
        workstream,
        sectionLabel: FINANCE_WORKSTREAM_LABELS.wallet,
        sectionHint: FINANCE_WORKSTREAM_HINTS.wallet,
        operationName: 'conciliación',
        operationTitle: 'Conciliación de wallet',
        primaryActionLabel: 'Conciliar',
        historyTitle: 'Conciliaciones',
        expectedLabel: 'Saldo sistema',
        countedLabel: 'Saldo wallet',
        differenceLabel: 'Diferencia',
        zeroDifferenceMessage: 'La wallet coincide con el sistema.',
        transferMessage: null,
      };
    case 'retention':
      return {
        workstream,
        sectionLabel: FINANCE_WORKSTREAM_LABELS.retention,
        sectionHint: FINANCE_WORKSTREAM_HINTS.retention,
        operationName: 'revisión',
        operationTitle: 'Revisión de retenciones',
        primaryActionLabel: 'Revisar',
        historyTitle: 'Revisiones',
        expectedLabel: 'Saldo sistema',
        countedLabel: 'Saldo revisado',
        differenceLabel: 'Diferencia',
        zeroDifferenceMessage: 'Las retenciones cuadran con el sistema.',
        transferMessage: null,
      };
    case 'fund':
      return {
        workstream,
        sectionLabel: FINANCE_WORKSTREAM_LABELS.fund,
        sectionHint: FINANCE_WORKSTREAM_HINTS.fund,
        operationName: 'cierre',
        operationTitle: 'Cierre de fondo',
        primaryActionLabel: 'Cerrar',
        historyTitle: 'Cierres',
        expectedLabel: 'Saldo sistema',
        countedLabel: 'Saldo revisado',
        differenceLabel: 'Diferencia',
        zeroDifferenceMessage: 'El fondo coincide con el sistema.',
        transferMessage: null,
      };
    default:
      return {
        workstream,
        sectionLabel: FINANCE_WORKSTREAM_LABELS.other,
        sectionHint: FINANCE_WORKSTREAM_HINTS.other,
        operationName: 'cierre',
        operationTitle: 'Cierre de cuenta',
        primaryActionLabel: 'Cerrar',
        historyTitle: 'Cierres',
        expectedLabel: 'Saldo sistema',
        countedLabel: 'Saldo revisado',
        differenceLabel: 'Diferencia',
        zeroDifferenceMessage: 'La cuenta coincide con el sistema.',
        transferMessage: null,
      };
  }
}
