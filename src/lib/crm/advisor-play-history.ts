import { playDateInput } from './play-dates.ts';

export type AdvisorHistoryPlay = { id: number | string; status: string; starts_at: string | null; ends_at: string | null };
export const ADVISOR_PUBLISHED_PLAY_STATUSES = ['active', 'paused', 'closed'];

export function advisorPlayMonth(play: AdvisorHistoryPlay) {
  return (playDateInput(play.starts_at) || playDateInput(play.ends_at)).slice(0, 7) || 'undated';
}

export function advisorMonthLabel(month: string) {
  return month === 'undated' ? 'Sin período' : new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas', month: 'long', year: 'numeric',
  }).format(new Date(`${month}-15T12:00:00-04:00`));
}

export function advisorPlayPeriod(plays: readonly AdvisorHistoryPlay[], query: { month?: string; play?: string }, now: Date) {
  const currentMonth = playDateInput(now.toISOString()).slice(0, 7);
  const months = [...new Set([currentMonth, ...plays.map(advisorPlayMonth)])]
    .sort((a, b) => a === 'undated' ? 1 : b === 'undated' ? -1 : b.localeCompare(a));
  const deepLinkedPlay = !query.month ? plays.find(play => String(play.id) === query.play) : null;
  const selectedMonth = query.month && months.includes(query.month)
    ? query.month : deepLinkedPlay ? advisorPlayMonth(deepLinkedPlay) : currentMonth;
  return { currentMonth, selectedMonth, months, plays: plays.filter(play => advisorPlayMonth(play) === selectedMonth) };
}

export function advisorPlayIsReadOnly(play: AdvisorHistoryPlay, month: string, now: Date) {
  const currentMonth = playDateInput(now.toISOString()).slice(0, 7);
  return play.status === 'closed' || (month !== 'undated' && month < currentMonth)
    || Boolean(play.ends_at && new Date(play.ends_at).getTime() <= now.getTime());
}

export function advisorPlaysHref(playId?: number | string, month?: string, view = 'all') {
  const params = new URLSearchParams();
  if (month) params.set('month', month);
  if (playId) params.set('play', String(playId));
  if (view !== 'all') params.set('view', view);
  return `/app/advisor/plays${params.size ? `?${params.toString()}` : ''}`;
}

/** Read-only paging: don't silently hide older campaigns or truncate a snapshot. */
export async function readAdvisorPlayPages<T>(fetchPage: (from: number, to: number) => PromiseLike<{
  data: unknown[] | null; error: { message: string } | null;
}>, size = 200): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += size) {
    const result = await fetchPage(from, from + size - 1);
    if (result.error) return { data: [], error: result.error };
    rows.push(...(result.data ?? []) as T[]);
    if ((result.data?.length ?? 0) < size) return { data: rows, error: null };
  }
}
