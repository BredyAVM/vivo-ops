const businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Database instants are UTC; date inputs represent calendar days in Venezuela.
// Never truncate an instant: the end of Sep 30 in Caracas falls on Oct 1 UTC.
export function playDateInput(value: string | null | undefined): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  // Reject timezone-less timestamps rather than depending on the host timezone.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const parts = Object.fromEntries(businessDateFormatter.formatToParts(parsed).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

type MonthlyPlay = { id: number; name: string; startsAt: string | null; endsAt: string | null; status: string };
export type PlayListFilter = 'all' | 'active' | 'draft' | 'frozen' | 'paused' | 'closed' | 'cancelled';
const monthFormatter = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', month: 'long', year: 'numeric' });

export function isPlayCurrentlyActive(play: MonthlyPlay, today: string): boolean {
  const start = playDateInput(play.startsAt);
  const end = playDateInput(play.endsAt);
  return play.status === 'active' && (!start || start <= today) && (!end || end >= today);
}

export function groupPlaysByMonth<T extends MonthlyPlay>(plays: readonly T[], today: string, search = '', filter: PlayListFilter = 'all') {
  const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const query = normalize(search.trim());
  const groups = new Map<string, { key: string; label: string; plays: T[]; defaultOpen: boolean }>();
  for (const play of plays) {
    if (filter === 'active' ? !isPlayCurrentlyActive(play, today) : filter !== 'all' && play.status !== filter) continue;
    const key = playDateInput(play.startsAt).slice(0, 7) || 'undated';
    const label = key === 'undated' ? 'Sin período' : monthFormatter.format(new Date(`${key}-01T12:00:00-04:00`));
    if (query && !normalize(`${play.name} ${label}`).includes(query)) continue;
    const group = groups.get(key) ?? { key, label, plays: [], defaultOpen: key === today.slice(0, 7) || key === 'undated' };
    group.plays.push(play);
    group.defaultOpen ||= isPlayCurrentlyActive(play, today);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key === 'undated' ? -1 : b.key === 'undated' ? 1 : b.key.localeCompare(a.key));
}
