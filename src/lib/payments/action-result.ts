export type PaymentActionFailure = {
  ok: false;
  code: 'rate_review_required' | 'validation' | 'unavailable';
  message: string;
};

export type PaymentActionResult<T> = { ok: true; value: T } | PaymentActionFailure;

export const PAYMENT_RATE_REVIEW_REQUIRED = 'Existe una diferencia entre la tasa del presupuesto o acuerdo del cliente y la tasa registrada para este pago. Administración debe comprobar y aprobar el acuerdo de tasa antes de confirmar el pago. Si eres máster, comunícate con un administrador. No vuelvas a cargar el pago ni cambies su referencia.';

/** Expected business errors must cross the Server Action boundary as data. */
export function paymentActionFailure(error: unknown, fallback: string): PaymentActionFailure {
  const message = error instanceof Error ? error.message :
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
  if (message.includes('Administración debe revisar la tasa antes de confirmarlo'))
    return { ok: false, code: 'rate_review_required', message: PAYMENT_RATE_REVIEW_REQUIRED };
  if (/No autenticado|No autorizado/.test(message))
    return { ok: false, code: 'validation', message: 'Tu sesión no tiene permiso para esta operación. Inicia sesión con el rol correspondiente.' };
  // Keep actionable Spanish validations; never expose SQL, stacks or framework errors.
  const businessMessage = /^(Debes |Selecciona |Indica |Solo |El (pago|pedido|reporte|saldo|presupuesto|cambio) |La (orden|decisión|cotización|cobertura|cuenta|referencia) |Este (pago|reporte) |Una cotización |No hay |No (tienes|puedes) |No se (pudo|puede|encontró) |Ya existe un pago |Se encontró otro pago |(Cuenta|Monto|Fecha|Tasa|Moneda) .*(inválid|obligatori)|Reporte inválido\.)/.test(message);
  const technicalMessage = /SQL|postgres|constraint|schema|stack|Minified React|Server Components|\bat\s+\w+\s*\(/i.test(message);
  return { ok: false, code: businessMessage && !technicalMessage ? 'validation' : 'unavailable',
    message: businessMessage && !technicalMessage ? message : fallback };
}
