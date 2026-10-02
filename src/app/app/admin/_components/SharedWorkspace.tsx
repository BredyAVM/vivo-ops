import type { ReactNode } from 'react';
import Link from '@/components/navigation/ContextLink';
export default function SharedWorkspace({ title, children }: { title: string; children: ReactNode }) {
  return <section className="admin-shared-workspace min-w-0 space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold text-[#DEDEE6]">{title}</h1><Link href="/app/admin" prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00]">Inicio</Link></header>
    {children}
  </section>;
}
