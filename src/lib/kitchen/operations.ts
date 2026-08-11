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
