import Link from 'next/link';
import type { ReactNode } from 'react';

export const adminInput = 'min-h-11 min-w-0 rounded-xl border border-[#30303D] bg-[#14141C] px-3 text-sm text-white';
export const adminPanel = 'min-w-0 rounded-2xl border border-[#292937] bg-[#111117] p-4';
export function AdminReadError({ title, message }: { title: string; message: string }) {
  return <section className={adminPanel}><h1 className="text-xl font-semibold">{title}</h1><p role="alert" className="mt-3 text-sm text-orange-200">{message}</p><Link href="/app/admin" prefetch={false} className="mt-4 inline-flex min-h-11 items-center text-sm underline">Volver a Administración</Link></section>;
}
export function AdminKpi({ label, value, hint }: { label: string; value: ReactNode; hint: string }) {
  return <article className={adminPanel}><h2 className="text-xs text-[#B9B9C4]">{label}</h2><p className="mt-2 break-words text-xl font-semibold text-white tabular-nums">{value}</p><p className="mt-2 text-xs text-[#9B9BA7]">{hint}</p></article>;
}
export function AdminPagination({ page, total, href }: { page: number; total: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / 30));
  return <nav aria-label="Paginación" className="flex flex-wrap items-center justify-between gap-3 text-xs text-[#C4C4CE]">
    <span>Página {page} de {pages} · {total} registros</span>
    <div className="flex gap-3">{page > 1 ? <Link href={href(page - 1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Anterior</Link> : null}{page < pages && page < 1001 ? <Link href={href(page + 1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Siguiente</Link> : null}</div>
  </nav>;
}
