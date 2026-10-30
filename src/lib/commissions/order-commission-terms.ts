export const ORDER_COMMISSION_TERMS_KIND = 'order_commission_terms';
export const EVENT_COMMISSION_TERMS_KIND = 'event_commercial_terms';

export type OrderCommissionMode = 'default' | 'fixed_item' | 'fixed_order' | 'none';
export type OrderCommissionAdjustmentAction = 'set' | 'clear';

export type OrderCommissionTerms = {
  mode: OrderCommissionMode;
  value: number | null;
};

export type ParsedOrderCommissionAdjustment = {
  kind: typeof ORDER_COMMISSION_TERMS_KIND | typeof EVENT_COMMISSION_TERMS_KIND;
  action: OrderCommissionAdjustmentAction;
  terms: OrderCommissionTerms | null;
};

export function normalizeOrderCommissionMode(value: unknown): OrderCommissionMode {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'fixed_item' || mode === 'fixed_order' || mode === 'none') return mode;
  return 'default';
}

export function normalizeOrderCommissionTerms(
  modeInput: unknown,
  valueInput: unknown
): OrderCommissionTerms {
  const mode = normalizeOrderCommissionMode(modeInput);
  if (mode !== 'fixed_item' && mode !== 'fixed_order') {
    return { mode, value: null };
  }

  if (valueInput == null || String(valueInput).trim() === '') {
    return { mode, value: null };
  }
  const value = Number(valueInput);
  return {
    mode,
    value: Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null,
  };
}

export function validateOrderCommissionTerms(
  modeInput: unknown,
  valueInput: unknown
): OrderCommissionTerms {
  const rawMode = String(modeInput || '').trim().toLowerCase();
  if (!['default', 'fixed_item', 'fixed_order', 'none'].includes(rawMode)) {
    throw new Error('El tipo de comisión especial no es válido.');
  }

  const mode = rawMode as OrderCommissionMode;
  if (mode !== 'fixed_item' && mode !== 'fixed_order') {
    return { mode, value: null };
  }

  if (valueInput == null || String(valueInput).trim() === '') {
    throw new Error('El porcentaje de comisión es obligatorio.');
  }
  const value = Number(valueInput);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error('El porcentaje de comisión debe estar entre 0 y 100.');
  }

  return { mode, value };
}

export function parseOrderCommissionAdjustmentPayload(
  payloadInput: unknown
): ParsedOrderCommissionAdjustment | null {
  if (!payloadInput || typeof payloadInput !== 'object' || Array.isArray(payloadInput)) {
    return null;
  }

  const payload = payloadInput as Record<string, unknown>;
  const kind = String(payload.kind || '');
  if (kind !== ORDER_COMMISSION_TERMS_KIND && kind !== EVENT_COMMISSION_TERMS_KIND) {
    return null;
  }

  const action: OrderCommissionAdjustmentAction =
    kind === ORDER_COMMISSION_TERMS_KIND && payload.action === 'clear' ? 'clear' : 'set';
  if (action === 'clear') {
    return {
      kind: ORDER_COMMISSION_TERMS_KIND,
      action,
      terms: null,
    };
  }

  return {
    kind,
    action,
    terms: normalizeOrderCommissionTerms(payload.commission_mode, payload.commission_value),
  };
}

export function commissionTermsEqual(
  left: OrderCommissionTerms | null | undefined,
  right: OrderCommissionTerms | null | undefined
) {
  if (!left || !right) return left == null && right == null;
  if (left.mode !== right.mode) return false;
  if (left.value == null || right.value == null) return left.value == null && right.value == null;
  return Math.abs(left.value - right.value) < 0.000001;
}

export function formatOrderCommissionTerms(terms: OrderCommissionTerms) {
  if (terms.mode === 'default') return 'Comisión general del asesor';
  if (terms.mode === 'none') return 'Sin comisión';
  if (terms.value == null) return 'Comisión fija sin porcentaje configurado';

  const value = Number.isInteger(terms.value)
    ? String(terms.value)
    : String(Number((terms.value ?? 0).toFixed(4)));
  return terms.mode === 'fixed_order'
    ? `${value}% sobre toda la orden`
    : `${value}% sobre este producto`;
}
