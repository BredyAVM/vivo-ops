export type CrmCoupon = {
  label: string;
  maximum_discount_usd: number;
  economics: { review_status: 'pending' | 'approved'; advisor_contribution_usd: number | null; company_contribution_usd: number | null };
};

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100);

export function readCrmCoupon(rules: Record<string, unknown> | null | undefined): CrmCoupon | null {
  const raw = rules?.coupon_draft;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const cap = Number(row.maximum_discount_usd);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('El límite del cupón no es válido.');
  const economics = (row.economics ?? {}) as Record<string, unknown>;
  const advisor = economics.advisor_contribution_usd == null ? null : Number(economics.advisor_contribution_usd);
  const company = economics.company_contribution_usd == null ? null : Number(economics.company_contribution_usd);
  const approved = economics.review_status === 'approved';
  if (approved && (advisor == null || company == null || !Number.isFinite(advisor) || !Number.isFinite(company)
    || advisor < 0 || company < 0 || cents(advisor + company) !== cents(cap))) {
    throw new Error('Revisa los aportes de empresa y asesor del cupón.');
  }
  return { label: String(row.label || 'Cupón VIVO'), maximum_discount_usd: cents(cap) / 100,
    economics: { review_status: approved ? 'approved' : 'pending', advisor_contribution_usd: advisor, company_contribution_usd: company } };
}

export function isCouponCatalogProduct(product: { name?: string | null; inventory_group?: string | null; type?: string | null; is_active?: boolean }) {
  return product.is_active !== false && product.type === 'product'
    && (product.inventory_group === 'beverages' || /^Delivery Zona [1-7]$/i.test(String(product.name || '').trim()));
}

/** Integer cents, stable benefit order: removing/reordering a cart cannot create a second allowance. */
export function allocateCoupon(capUsd: number, lines: Array<{ benefitId: number; grossUsd: number }>) {
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('El límite del cupón no es válido.');
  const seen = new Set<number>();
  let remaining = cents(capUsd);
  return [...lines].sort((a, b) => a.benefitId - b.benefitId).map(line => {
    if (!Number.isSafeInteger(line.benefitId) || line.benefitId <= 0 || seen.has(line.benefitId)
      || !Number.isFinite(line.grossUsd) || line.grossUsd < 0) throw new Error('La selección del cupón no es válida.');
    seen.add(line.benefitId);
    const gross = cents(line.grossUsd);
    const discount = Math.min(gross, remaining);
    remaining -= discount;
    return { benefitId: line.benefitId, grossUsd: gross / 100, discountUsd: discount / 100, netUsd: (gross - discount) / 100 };
  });
}
