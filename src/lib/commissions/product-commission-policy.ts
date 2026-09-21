import {
  normalizeOrderCommissionTerms,
  type OrderCommissionTerms,
} from './order-commission-terms.ts';

export const PRODUCT_COMMISSION_SCHEDULE_KEY = 'commission_schedule_v1';

export type ProductCommissionScheduleEntry = OrderCommissionTerms & {
  effectiveFrom: string;
};

function normalizeDate(value: unknown) {
  const date = String(value ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

export function getProductCommissionSchedule(
  extraFieldsInput: unknown
): ProductCommissionScheduleEntry[] {
  if (
    !extraFieldsInput ||
    typeof extraFieldsInput !== 'object' ||
    Array.isArray(extraFieldsInput)
  ) {
    return [];
  }

  const rawSchedule = (extraFieldsInput as Record<string, unknown>)[
    PRODUCT_COMMISSION_SCHEDULE_KEY
  ];
  if (!Array.isArray(rawSchedule)) return [];

  return rawSchedule
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      const effectiveFrom = normalizeDate(row.effective_from ?? row.effectiveFrom);
      if (!effectiveFrom) return null;

      return {
        effectiveFrom,
        ...normalizeOrderCommissionTerms(row.mode, row.value),
      };
    })
    .filter((entry): entry is ProductCommissionScheduleEntry => entry != null)
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
}

export function resolveProductCommissionTerms(input: {
  currentMode: unknown;
  currentValue: unknown;
  extraFields: unknown;
  referenceDate?: unknown;
}) {
  const currentTerms = normalizeOrderCommissionTerms(
    input.currentMode,
    input.currentValue
  );
  const referenceDate = normalizeDate(input.referenceDate);
  if (!referenceDate) return currentTerms;

  const effectiveEntry = getProductCommissionSchedule(input.extraFields)
    .filter((entry) => entry.effectiveFrom <= referenceDate)
    .at(-1);

  return effectiveEntry
    ? { mode: effectiveEntry.mode, value: effectiveEntry.value }
    : currentTerms;
}
