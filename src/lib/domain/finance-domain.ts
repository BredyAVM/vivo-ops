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
  | 'pos'
  | 'wallet_usd'
  | 'retention';

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
  pos: 'Punto',
  wallet_usd: 'Wallet USD',
  retention: 'Retenciones',
};
