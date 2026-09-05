const ZERO_USD_TOLERANCE = 0.005;

export type AdvisorCountedNewClientType = 'own' | 'assigned';

function numericValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isAdvisorCommercialOrder(totalUsd: unknown) {
  return numericValue(totalUsd) > ZERO_USD_TOLERANCE;
}

export function countedAdvisorNewClientType(
  value: unknown
): AdvisorCountedNewClientType | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'own' || normalized === 'assigned' ? normalized : null;
}

export function summarizeAdvisorNewClients<T extends { clientType?: unknown }>(
  clients: T[]
) {
  const own: T[] = [];
  const assigned: T[] = [];
  const other: T[] = [];

  for (const client of clients) {
    const type = countedAdvisorNewClientType(client.clientType);
    if (type === 'own') own.push(client);
    else if (type === 'assigned') assigned.push(client);
    else other.push(client);
  }

  return {
    own,
    assigned,
    other,
    countedTotal: own.length + assigned.length,
  };
}
