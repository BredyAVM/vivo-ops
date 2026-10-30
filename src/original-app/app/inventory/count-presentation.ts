export const inventoryCountKindLabels: Record<string, string> = {
  opening: 'Apertura física',
  shift_change: 'Conteo por turno',
  requested: 'Conteo solicitado',
  recount: 'Reconteo',
  periodic: 'Conteo periódico',
};

export function inventoryCountFolio(countId: number) {
  return `INV-${String(countId).padStart(4, '0')}`;
}

function formatBusinessDate(value: string) {
  const date = new Date(`${value}T12:00:00-04:00`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-VE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'America/Caracas',
  }).format(date);
}

function formatCreatedMoment(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'fecha no disponible';
  return new Intl.DateTimeFormat('es-VE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Caracas',
  }).format(date);
}

function formatCreatedTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'hora no disponible';
  return new Intl.DateTimeFormat('es-VE', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Caracas',
  }).format(date);
}

export function inventoryCountTitle(input: {
  countKind: string;
  createdAt: string;
  shiftBusinessDate?: string | null;
}) {
  const kind = inventoryCountKindLabels[input.countKind] ?? 'Conteo de inventario';
  if (input.countKind === 'shift_change' && input.shiftBusinessDate) {
    return `${kind} · ${formatBusinessDate(input.shiftBusinessDate)} · ${formatCreatedTime(input.createdAt)}`;
  }
  return `${kind} · ${formatCreatedMoment(input.createdAt)}`;
}
