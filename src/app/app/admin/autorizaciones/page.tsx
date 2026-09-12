import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { loadAuthorizations } from '@/lib/admin-finance/authorizations-data';
import { AUTHORIZATION_KINDS, authorizationLabels, authorizationHref, type AuthorizationKind } from '@/lib/admin-finance/authorizations-model';
import { AdminPagination, AdminReadError, adminPanel } from '../_components/AdminReadUi';

export const dynamic = 'force-dynamic';
export default async function AuthorizationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminContext();
  const params = await searchParams;
  const kind = AUTHORIZATION_KINDS.includes(params.tipo as AuthorizationKind) ? params.tipo as AuthorizationKind : 'all';
  const requestedPage = Number(params.page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 10000 ? requestedPage : 1;
  let data;
  try { data = await loadAuthorizations(kind, page); } catch {
    return <AdminReadError title="Autorizaciones" message="No se pudieron consultar los pendientes. Actualiza la página; no se ha realizado ninguna aprobación." />;
  }
  const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });
  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">Autorizaciones</h1><Link href="/app/admin/tareas" prefetch={false} className="inline-flex min-h-11 items-center text-sm underline">Otros pendientes →</Link></header>
    <nav aria-label="Tipo de autorización" className="flex flex-wrap gap-2">{AUTHORIZATION_KINDS.map(k => <Link key={k} href={`/app/admin/autorizaciones?tipo=${k}`} prefetch={false} aria-current={kind === k ? 'page' : undefined}
      className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm ${kind === k ? 'border-[#FEEF00] text-[#FEEF00]' : 'border-[#30303D] text-[#C4C4CE]'}`}>
      {authorizationLabels[k]} <span className="tabular-nums">{k === 'all' ? Object.values(data.counts).reduce((a, b) => a + b, 0) : data.counts[k]}</span>
    </Link>)}</nav>
    <section className={adminPanel}><div className="divide-y divide-[#292937]">{data.rows.map(row => <article key={`${row.kind}:${row.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1"><p className="text-xs text-[#9B9BA7]">{authorizationLabels[row.kind]} · #{row.id}</p>
        <h2 className="mt-1 break-words text-sm font-semibold">{row.entity} · {row.title}</h2>
        <p className="mt-1 text-xs text-[#9B9BA7]">{row.actorName} · {date.format(new Date(row.createdAt))}</p></div>
      <div className="text-right text-sm tabular-nums"><p>{row.currency && row.amount !== null ? `${row.currency} ${money.format(row.amount)}` : 'Ver importes por moneda'}</p>
        {row.kind === 'reapproval' || row.kind === 'order' ? <p className="text-xs text-[#9B9BA7]">Total de la orden, no importe del ajuste</p> : null}</div>
      <Link href={authorizationHref(row)} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FEEF00]/50 px-4 text-sm font-semibold text-[#FEEF00]">Revisar →</Link>
    </article>)}</div>
      {!data.rows.length ? <p className="py-5 text-sm text-[#9B9BA7]">No hay registros en esta página con este filtro.</p> : null}
      <AdminPagination page={page} total={data.total} href={p => `/app/admin/autorizaciones?tipo=${kind}&page=${p}`} />
    </section>
    <p className="text-xs text-[#9B9BA7]">Los pagos abren su operación de origen. Los cierres, conciliaciones e inventarios conservan sus bandejas en Otros pendientes.</p>
  </div>;
}
