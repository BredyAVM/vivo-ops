export type EventPaymentAllocation = { order_id: number; amount: number };
export type EventPaymentInput = {
  id: string; accountId: number; method: string; currency: 'USD' | 'VES';
  amount: number; rate: number | null; date: string; reference: string;
  bank: string; payer: string; notes: string; allocations: EventPaymentAllocation[];
};
export type EventPaymentData = {
  accounts: { id: number; name: string; currency: 'USD' | 'VES'; methods: string[] }[];
  payments: { id: string; state: string; created_at: string; request: EventPaymentInput;
    result: { reason?: string; allocations?: EventPaymentAllocation[] } }[];
};
export const eventPaymentState: Record<string, string> = {
  pending: 'Por confirmar', confirmed: 'Confirmado', rejected: 'Rechazado', voided: 'Anulado',
};
export const eventPaymentMethods: Record<string, string> = {
  payment_mobile: 'Pago móvil', transfer: 'Transferencia', zelle: 'Zelle', wallet_usd: 'Wallet USD',
  cash_usd: 'Efectivo USD', cash_ves: 'Efectivo Bs', pos: 'Punto de venta',
};
