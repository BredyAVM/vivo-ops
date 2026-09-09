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

export function crmPlayDetailLine(kind: 'play' | 'benefit', value: string) {
  return `@crm|${kind}:${String(value || '').replace(/[\r\n|]+/g, ' ').trim()}`;
}
