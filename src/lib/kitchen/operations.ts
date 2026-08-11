export type KitchenIncidentStatus = 'reported' | 'reviewed' | 'resolved' | 'reopened';
export type KitchenShiftCode = 'shift_1' | 'shift_2';

export function kitchenIncidentStatusFromLifecycle(eventType: string | null | undefined): KitchenIncidentStatus {
  if (eventType === 'kitchen_incident_resolved') return 'resolved';
  if (eventType === 'kitchen_incident_reviewed') return 'reviewed';
  if (eventType === 'kitchen_incident_reopened') return 'reopened';
  return 'reported';
}

export function kitchenOrderPriority(input: {
  hasPendingChanges: boolean;
  hasPendingIncident: boolean;
  remainingPrepMinutes: number | null;
}) {
  if (input.hasPendingChanges) return 0;
  if (input.hasPendingIncident) return 1;
  if (input.remainingPrepMinutes != null && input.remainingPrepMinutes < 0) return 2;
  return 3;
}

export function isKitchenShiftCode(value: unknown): value is KitchenShiftCode {
  return value === 'shift_1' || value === 'shift_2';
}

export function kitchenShiftLabel(shiftCode: KitchenShiftCode | null) {
  if (shiftCode === 'shift_1') return 'Turno 1';
  if (shiftCode === 'shift_2') return 'Turno 2';
  return 'Turno sin identidad historica';
}

function caracasDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Caracas',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export function getKitchenShiftDateBounds(now: Date) {
  return {
    min: caracasDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    max: caracasDateKey(now),
  };
}

export function getKitchenDayRange(dayKey: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw new Error('Fecha operativa invalida.');
  }
  const start = new Date(`${dayKey}T00:00:00-04:00`);
  if (!Number.isFinite(start.getTime()) || caracasDateKey(start) !== dayKey) {
    throw new Error('Fecha operativa invalida.');
  }
  return {
    startISO: start.toISOString(),
    endISO: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export type KitchenPrepMetric = {
  actualMinutes: number;
  committedMinutes: number | null;
  varianceMinutes: number | null;
  onTime: boolean | null;
};

export function kitchenPrepMetric(input: {
  startedAt: string | null;
  readyAt: string | null;
  etaMinutes: number | null;
}): KitchenPrepMetric | null {
  const startedAt = new Date(String(input.startedAt || '')).getTime();
  const readyAt = new Date(String(input.readyAt || '')).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(readyAt) || readyAt < startedAt) return null;

  const actualMinutes = Math.round(((readyAt - startedAt) / 60000) * 10) / 10;
  const committedMinutes =
    input.etaMinutes != null && Number.isFinite(input.etaMinutes) && input.etaMinutes > 0
      ? input.etaMinutes
      : null;
  const varianceMinutes = committedMinutes == null
    ? null
    : Math.round((actualMinutes - committedMinutes) * 10) / 10;

  return {
    actualMinutes,
    committedMinutes,
    varianceMinutes,
    onTime: varianceMinutes == null ? null : varianceMinutes <= 0,
  };
}

export function summarizeKitchenPrepMetrics(metrics: KitchenPrepMetric[]) {
  const measured = metrics.filter((metric) => Number.isFinite(metric.actualMinutes));
  const committed = measured.filter((metric) => metric.varianceMinutes != null);
  const averageActualMinutes = measured.length
    ? Math.round((measured.reduce((sum, metric) => sum + metric.actualMinutes, 0) / measured.length) * 10) / 10
    : null;
  const averageVarianceMinutes = committed.length
    ? Math.round((committed.reduce((sum, metric) => sum + Number(metric.varianceMinutes), 0) / committed.length) * 10) / 10
    : null;
  const onTimePct = committed.length
    ? Math.round((committed.filter((metric) => metric.onTime).length / committed.length) * 100)
    : null;

  return {
    measuredCount: measured.length,
    committedCount: committed.length,
    averageActualMinutes,
    averageVarianceMinutes,
    onTimePct,
  };
}
