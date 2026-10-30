import type { ReactNode } from 'react';

// Small text on desktop; comfortable touch targets without inflating typography.
export const queryControl = 'min-h-11 w-full min-w-0 rounded-lg border border-[#343442] bg-[#14141C] px-3 text-xs text-[#E4E4EA] placeholder:text-[#9B9BA7] focus-visible:outline-2 focus-visible:outline-[#FFFF00] md:min-h-8';
export const queryAction = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-[#343442] px-3 text-xs font-medium text-[#D5D5DF] hover:border-[#FFFF00]/60 focus-visible:outline-2 focus-visible:outline-[#FFFF00] disabled:opacity-50 md:min-h-8';
export const queryPrimary = 'inline-flex min-h-11 items-center justify-center rounded-lg bg-[#FFFF00] px-3 text-xs font-semibold text-[#0B0B0D] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFFF00] disabled:opacity-50 md:min-h-8';
export const queryPanel = 'space-y-2 rounded-xl border border-[#292937] bg-[#111117] p-3';

export function QueryField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[#B7B7C2]">{label}{children}</label>;
}

export function MoreFilters({ active = false, children }: { active?: boolean; children: ReactNode }) {
  return <details open={active || undefined} className="text-xs text-[#B7B7C2]">
    <summary className="min-h-11 cursor-pointer content-center font-medium focus-visible:outline-2 focus-visible:outline-[#FFFF00] md:min-h-8">Más filtros</summary>
    <div className="grid grid-cols-2 gap-2 pt-2 lg:grid-cols-4">{children}</div>
  </details>;
}
