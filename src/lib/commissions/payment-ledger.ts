export const ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX =
  'Liquidación de comisión · Cierre ';

function cleanLabel(value: string, fallback: string) {
  const clean = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || fallback;
}

export function buildAdvisorCommissionPaymentDescription(input: {
  closureId: number;
  periodName: string;
  advisorName: string;
}) {
  if (!Number.isInteger(input.closureId) || input.closureId <= 0) {
    throw new Error('closureId debe ser un entero positivo.');
  }

  return `${ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX}${input.closureId} · ${cleanLabel(
    input.periodName,
    'Periodo'
  )} · ${cleanLabel(input.advisorName, 'Asesor')}`;
}

export function getAdvisorCommissionClosureIdFromPaymentDescription(
  description: unknown
) {
  if (typeof description !== 'string') return null;
  if (!description.startsWith(ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX)) return null;
  const remainder = description.slice(
    ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX.length
  );
  const id = Number(remainder.split(' · ', 1)[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}
