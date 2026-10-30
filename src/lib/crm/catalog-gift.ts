// Only dual-use Gambits participate. Ordinary purchases are never auto-gifted.
export function shouldResolveCatalogGift(product: {
  type?: string | null;
  extra_fields?: Record<string, unknown> | null;
}) {
  return product.type === 'gambit' && product.extra_fields?.catalog_access_scope === 'advisor_gift';
}

export type CatalogGiftCandidate = {
  play_member_id: number;
  play_benefit_id: number;
  play_benefit_upgrade_id: number | null;
  benefit_status: string;
  quantity: number;
};

export function decideCatalogGift(candidates: CatalogGiftCandidate[], quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) return { kind: 'invalid_quantity' as const };
  const available = candidates.filter((candidate) => candidate.benefit_status === 'available');
  if (!candidates.length) return { kind: 'discretionary' as const };
  if (!available.length) return { kind: 'unavailable' as const };
  // Do not hide ambiguity by arbitrarily picking the first campaign/quantity.
  if (available.length > 1) return { kind: 'choose' as const, candidates: available };
  if (Math.abs(available[0].quantity - quantity) > 0.001) return { kind: 'invalid_quantity' as const };
  return { kind: 'match' as const, candidate: available[0] };
}
