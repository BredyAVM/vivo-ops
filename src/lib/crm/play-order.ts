export function isPlayOrderAvailableAt({
  status,
  startsAt,
  endsAt,
  now,
}: {
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  now: Date;
}) {
  if (status !== 'active') return false;

  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return false;

  if (startsAt) {
    const startTime = new Date(startsAt).getTime();
    if (!Number.isFinite(startTime) || nowTime < startTime) return false;
  }

  if (endsAt) {
    const endTime = new Date(endsAt).getTime();
    if (!Number.isFinite(endTime) || nowTime >= endTime) return false;
  }

  return true;
}

export function isInternalOrderDetailLine(value: string) {
  const line = String(value || '').trim().toLowerCase();
  return line.startsWith('@sel|') || line.startsWith('@crm|');
}

// Kept to read and safely normalize legacy orders. New CRM orders use structural
// order-item columns and must not write this marker into customer-visible notes.
export function crmPlayDetailLine(kind: 'play' | 'benefit', value: string) {
  return `@crm|${kind}:${String(value || '').replace(/[\r\n|]+/g, ' ').trim()}`;
}

export type GambitApplicationScope = 'advisor_gift' | 'advisor_gift_only' | 'crm_only' | 'gambit_disabled';

// Reuse catalog_access_scope. Legacy advisor_gift already allowed both paths.
export function gambitApplicationModes(scope: unknown) {
  return {
    discretionary: scope === 'advisor_gift' || scope === 'advisor_gift_only',
    crm: scope !== 'advisor_gift_only' && scope !== 'gambit_disabled' && scope !== 'admin_internal',
  };
}

export function gambitApplicationScope(discretionary: boolean, crm: boolean): GambitApplicationScope {
  return discretionary ? (crm ? 'advisor_gift' : 'advisor_gift_only') : (crm ? 'crm_only' : 'gambit_disabled');
}

export function allowsCrmCatalogProduct(product: {
  type?: string | null;
  extra_fields?: Record<string, unknown> | null;
}) {
  const scope = product.extra_fields?.catalog_access_scope;
  return scope !== 'admin_internal' && scope !== 'advisor_gift_only' && scope !== 'gambit_disabled';
}

export function isCrmOnlyCatalogProduct(product: {
  type?: string | null;
  extra_fields?: Record<string, unknown> | null;
}) {
  const scope = product.extra_fields?.catalog_access_scope;
  return scope === 'crm_only' || scope === 'gambit_disabled'
    || (product.type === 'gambit' && !gambitApplicationModes(scope).discretionary);
}
