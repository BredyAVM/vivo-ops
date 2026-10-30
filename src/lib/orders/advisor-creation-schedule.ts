export type AdvisorDeliverySchedule = {
  date: string;
  time_12: string;
  time_24: string;
  asap: boolean;
};

// Only for creation/conversion: editing an existing order keeps its reference time.
export function refreshAdvisorAsapSchedule<T extends AdvisorDeliverySchedule>(
  schedule: T,
  submittedAt = new Date(),
): T {
  if (!schedule.asap) return schedule;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(submittedAt);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  const hour = Number(value('hour'));
  const minute = value('minute');

  return {
    ...schedule,
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time_12: `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`,
    time_24: `${value('hour')}:${minute}`,
  };
}
