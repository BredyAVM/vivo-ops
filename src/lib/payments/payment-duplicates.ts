type PaymentDuplicateRow = {
  source?: string | null;
  report_id?: number | string | null;
  movement_id?: number | string | null;
  order_id?: number | string | null;
  order_number?: string | null;
  client_name?: string | null;
  status?: string | null;
  amount?: number | string | null;
  currency_code?: string | null;
  operation_date?: string | null;
  reference_code?: string | null;
};

type SupabaseRpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => any;
};

export async function assertNoActivePaymentDuplicate(
  supabase: SupabaseRpcClient,
  input: {
    moneyAccountId: number;
    operationDate: string | null;
    currencyCode: string;
    amount: number;
    referenceCode: string | null;
    excludeReportId?: number | null;
  }
) {
  const moneyAccountId = Number(input.moneyAccountId || 0);
  const operationDate = String(input.operationDate || '').trim();
  const currencyCode = String(input.currencyCode || '').trim().toUpperCase();
  const amount = Number(input.amount || 0);
  const referenceCode = String(input.referenceCode || '').trim();

  if (
    !Number.isFinite(moneyAccountId) ||
    moneyAccountId <= 0 ||
    !operationDate ||
    !currencyCode ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !referenceCode
  ) {
    return;
  }

  const { data, error } = await supabase.rpc('find_active_payment_duplicate', {
    p_money_account_id: moneyAccountId,
    p_operation_date: operationDate,
    p_currency: currencyCode,
    p_amount: Number(amount.toFixed(2)),
    p_reference_code: referenceCode,
    p_exclude_report_id: input.excludeReportId ?? null,
  });

  if (error) throw new Error(error.message || 'No se pudo validar duplicados de pago.');

  const rows = Array.isArray(data) ? (data as PaymentDuplicateRow[]) : [];
  const duplicate = rows[0];
  if (!duplicate) return;

  const orderLabel =
    duplicate.order_number ||
    (duplicate.order_id ? `#${duplicate.order_id}` : 'otra orden');
  const clientLabel = duplicate.client_name ? ` · ${duplicate.client_name}` : '';
  const referenceLabel = referenceCode ? ` · Ref. ${referenceCode}` : '';

  throw new Error(
    `Posible pago duplicado: ya existe un pago activo con la misma cuenta, fecha, monto y referencia en la orden ${orderLabel}${clientLabel}${referenceLabel}.`
  );
}
