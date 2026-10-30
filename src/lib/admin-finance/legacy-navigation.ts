export const LEGACY_ADMIN_SECTIONS = ['catalog','inventory','exchange_rate','accounts','clients','notifications','users','adjustments','deliveries'] as const;
export type LegacyAdminSection = typeof LEGACY_ADMIN_SECTIONS[number];
export function resolveLegacyAdminSection(value: string | null, roles: readonly string[]) {
  const section = roles.includes('admin') && LEGACY_ADMIN_SECTIONS.includes(value as LegacyAdminSection) ? value as LegacyAdminSection : null;
  return { view: section === 'deliveries' ? 'calculations' as const : section ? 'settings' as const : 'operations' as const, settings: section && section !== 'deliveries' ? section : 'catalog' as const, calculations: section === 'deliveries' ? 'deliveries' as const : 'general' as const };
}
export function legacyAdminHref(section: LegacyAdminSection) { return `/app/master/dashboard?adminSection=${section}`; }
