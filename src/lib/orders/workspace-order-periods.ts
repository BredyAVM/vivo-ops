import type { AuthContext } from '@/lib/auth';

type PeriodRow = { created_at: string; extra_fields: { schedule?: { date?: unknown } } | null };
type RowsResult<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };
type Range = { startISO: string; endISO: string };

// Exact counts also detect PostgREST truncation below our requested 900 rows.
function isComplete<T>(result: RowsResult<T>) {
  return !result.error && Array.isArray(result.data) &&
    Number.isSafeInteger(result.count) && result.count === result.data.length;
}

export async function readWorkspaceOrderPeriods<T extends PeriodRow>(input: {
  supabase: AuthContext['supabase']; orderSelect: string; focusDate: string;
  dayRange: Range; weekRange: Range & { startKey: string; endExclusiveKey: string };
  reuseWeekRows: boolean;
}) {
  const { supabase, orderSelect, focusDate, dayRange, weekRange, reuseWeekRows } = input;
  const readScheduledDay = async () => await supabase.from('orders').select(orderSelect)
    .eq('extra_fields->schedule->>date', focusDate)
    .order('created_at', { ascending: false }).limit(500) as unknown as RowsResult<T>;
  const readCreatedDay = async () => await supabase.from('orders').select(orderSelect)
    .gte('created_at', dayRange.startISO).lt('created_at', dayRange.endISO)
    .order('created_at', { ascending: false }).limit(500) as unknown as RowsResult<T>;
  const count = reuseWeekRows ? { count: 'exact' as const } : undefined;
  const scheduledWeek = supabase.from('orders').select(orderSelect, count)
    .gte('extra_fields->schedule->>date', weekRange.startKey)
    .lt('extra_fields->schedule->>date', weekRange.endExclusiveKey)
    .order('created_at', { ascending: false }).limit(900);
  const createdWeek = supabase.from('orders').select(orderSelect, count)
    .gte('created_at', weekRange.startISO).lt('created_at', weekRange.endISO)
    .order('created_at', { ascending: false }).limit(900);

  if (!reuseWeekRows) {
    const [scheduledDayResult, createdDayResult, scheduledWeekResult, createdWeekResult] =
      await Promise.all([readScheduledDay(), readCreatedDay(), scheduledWeek, createdWeek]);
    return { scheduledDayResult, createdDayResult,
      scheduledWeekResult: scheduledWeekResult as unknown as RowsResult<T>,
      createdWeekResult: createdWeekResult as unknown as RowsResult<T> };
  }

  const weekly = await Promise.all([scheduledWeek, createdWeek]);
  const scheduledWeekResult = weekly[0] as unknown as RowsResult<T>;
  const createdWeekResult = weekly[1] as unknown as RowsResult<T>;
  const start = Date.parse(dayRange.startISO), end = Date.parse(dayRange.endISO);
  const dayIsInsideWeek = focusDate >= weekRange.startKey && focusDate < weekRange.endExclusiveKey &&
    start >= Date.parse(weekRange.startISO) && end <= Date.parse(weekRange.endISO);
  const [scheduledDayResult, createdDayResult] = await Promise.all([
    dayIsInsideWeek && isComplete(scheduledWeekResult)
      ? { data: scheduledWeekResult.data!.filter(row =>
          String(row.extra_fields?.schedule?.date ?? '') === focusDate).slice(0, 500), error: null }
      : readScheduledDay(),
    dayIsInsideWeek && isComplete(createdWeekResult)
      ? { data: createdWeekResult.data!.filter(row => {
          const time = Date.parse(row.created_at);
          return time >= start && time < end;
        }).slice(0, 500), error: null }
      : readCreatedDay(),
  ]);
  return { scheduledDayResult, createdDayResult, scheduledWeekResult, createdWeekResult };
}
