export function readOwnTransport(extraFields: unknown): { name: string; phone: string | null } | null {
  if (!extraFields || typeof extraFields !== 'object') return null;
  const delivery = (extraFields as { delivery?: Record<string, unknown> }).delivery;
  if (!delivery || delivery.cost_source !== 'own_transport_v1' || delivery.cost_usd !== 0) return null;
  const own = delivery.own_transport as { version?: unknown; name?: unknown; phone?: unknown } | undefined;
  if (own?.version !== 1 || typeof own.name !== 'string' || !own.name.trim()) return null;
  return { name: own.name.trim(), phone: typeof own.phone === 'string' && own.phone.trim() ? own.phone.trim() : null };
}
