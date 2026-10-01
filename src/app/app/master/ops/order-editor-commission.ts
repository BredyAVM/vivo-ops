import { resolveDeliveredCommissionItem } from '../../../../lib/commissions/delivered-order-commission.ts';
import { resolveProductCommissionTerms } from '../../../../lib/commissions/product-commission-policy.ts';
import {
  commissionTermsEqual, EVENT_COMMISSION_TERMS_KIND, parseOrderCommissionAdjustmentPayload,
  validateOrderCommissionTerms, type OrderCommissionMode,
} from '../../../../lib/commissions/order-commission-terms.ts';

export type EditorCommissionFields = {
  commissionInheritedMode?: OrderCommissionMode;
  commissionInheritedValue?: number | null;
  commissionInheritedSource?: 'catalog' | 'event';
  adminCommissionOverrideMode?: OrderCommissionMode | null;
  adminCommissionOverrideValue?: number | null;
  adminCommissionOverrideReason?: string | null;
  adminCommissionOverrideChanged?: boolean;
};
export type EditorCommissionProduct = {
  commission_mode?: unknown; commission_value?: unknown; extra_fields?: unknown;
};
export type EditorCommissionAudit = { order_item_id: number | string | null; payload: unknown; reason?: string | null };

// Shares the same precedence and dated catalogue policy as the commission closure.
export function readEditorCommissionFields(
  product: EditorCommissionProduct | null | undefined, referenceDate: string,
  adjustments: EditorCommissionAudit[] = [], itemId?: number | null,
): EditorCommissionFields {
  const rows = itemId ? adjustments.filter((row) => Number(row.order_item_id) === itemId) : [];
  const catalog = resolveProductCommissionTerms({ currentMode: product?.commission_mode,
    currentValue: product?.commission_value, extraFields: product?.extra_fields, referenceDate });
  const resolved = resolveDeliveredCommissionItem(catalog, rows.map((row) => row.payload));
  const adminRow = rows.find((row) => parseOrderCommissionAdjustmentPayload(row.payload)?.kind === 'order_commission_terms');
  return {
    commissionInheritedMode: resolved.inherited.mode,
    commissionInheritedValue: resolved.inherited.value,
    commissionInheritedSource: rows.some((row) => parseOrderCommissionAdjustmentPayload(row.payload)?.kind === EVENT_COMMISSION_TERMS_KIND) ? 'event' : 'catalog',
    adminCommissionOverrideMode: resolved.override?.mode ?? null,
    adminCommissionOverrideValue: resolved.override?.value ?? null,
    adminCommissionOverrideReason: resolved.override ? adminRow?.reason ?? null : null,
    adminCommissionOverrideChanged: false,
  };
}

export function prepareEditorCommissionFields(
  submitted: EditorCommissionFields, stored: EditorCommissionFields, isAdmin: boolean,
): EditorCommissionFields {
  if (!isAdmin) {
    if (submitted.adminCommissionOverrideMode != null || submitted.adminCommissionOverrideChanged) {
      throw new Error('Solo admin puede ajustar comisiones manualmente.');
    }
    // Omission preserves existing audited terms in the shared save action.
    return {};
  }
  if (!Object.hasOwn(submitted, 'adminCommissionOverrideMode')) return {};
  const next = submitted.adminCommissionOverrideMode == null ? null : validateOrderCommissionTerms(
    submitted.adminCommissionOverrideMode, submitted.adminCommissionOverrideValue,
  );
  const previous = stored.adminCommissionOverrideMode == null ? null : {
    mode: stored.adminCommissionOverrideMode, value: stored.adminCommissionOverrideValue ?? null,
  };
  const changed = !commissionTermsEqual(previous, next);
  const reason = changed ? String(submitted.adminCommissionOverrideReason || '').trim()
    : String(stored.adminCommissionOverrideReason || '').trim();
  if (changed && (!reason || reason.length > 500)) throw new Error('Indica un motivo de hasta 500 caracteres para el ajuste de comisión.');
  return {
    ...stored,
    adminCommissionOverrideMode: next?.mode ?? null,
    adminCommissionOverrideValue: next?.value ?? null,
    adminCommissionOverrideChanged: changed,
    adminCommissionOverrideReason: next || changed ? reason : null,
  };
}
