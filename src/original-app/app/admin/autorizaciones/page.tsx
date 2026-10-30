import Link from '@/components/navigation/ContextLink';
import { requireAdminContext } from '@/lib/auth';
import { loadAuthorizations } from '@/lib/admin-finance/authorizations-data';
import { AUTHORIZATION_KINDS, authorizationLabels, authorizationHref, type AuthorizationKind } from '@/lib/admin-finance/authorizations-model';
import { formatOrderDisplayLabel } from '@/lib/orders/order-labels';
import { AdminPagination, AdminReadError, adminPanel } from '../_components/AdminReadUi';
import AdminFollowUp from '../_components/AdminFollowUp';

export const dynamic = 'force-dynamic';
export default async function AuthorizationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminContext();
  const params = await searchParams;
  const first = (key: string) => Array.isArray(params[key]) ? params[key][0] : params[key];
  const followUp = first('bandeja') === 'seguimiento';
  const header = <header className="space-y-2"><h1 className="text-lg font-semibold">Aprobaciones y seguimiento</h1>
    <nav aria-label="Bandeja administrativa" className="flex flex-wrap gap-2">
      {[[false, 'Por aprobar'], [true, 'Seguimiento']] .map(([follow, label]) => <Link key={String(label)} href={follow ? '/app/admin/autorizaciones?bandeja=seguimiento' : '/app/admin/autorizaciones'} prefetch={false} aria-current={followUp === follow ? 'page' : undefined} className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-xs ${followUp === follow ? 'border-[#FFFF00]/50 text-[#FFFF00]' : 'border-[#30303D] text-[#C4C4CE]'}`}>{label}</Link>)}
    </nav></header>;
  if (followUp) return <div className="space-y-3">{header}<AdminFollowUp params={params} /></div>;
  const kind = AUTHORIZATION_KINDS.includes(first('tipo') as AuthorizationKind) ? first('tipo') as AuthorizationKind : 'all';
  const requestedPage = Number(first('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 10000 ? requestedPage : 1;
  let data;
  try { data = await loadAuthorizations(kind, page); } catch {
    return <div className="space-y-3">{header}<AdminReadError title="Aprobaciones" message="No se pudieron consultar las operaciones. No se ha realizado ninguna aprobación." /></div>;
  }
  const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });
  return <div className="space-y-3">{header}
    <nav aria-label="Tipo de autorización" className="flex flex-wrap gap-2">{AUTHORIZATION_KINDS.map(k => <Link key={k} href={`/app/admin/autorizaciones?tipo=${k}`} prefetch={false} aria-current={kind === k ? 'page' : undefined} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs ${kind === k ? 'border-[#FFFF00]/50 text-[#FFFF00]' : 'border-[#30303D] text-[#C4C4CE]'}`}>
      {authorizationLabels[k]} <span className="tabular-nums">{k === 'all' ? Object.values(data.counts).reduce((a, b) => a + b, 0) : data.counts[k]}</span>
    </Link>)}</nav>
    <section className={adminPanel}><div className="divide-y divide-[#292937]">{data.rows.map(row => <article key={`${row.kind}:${row.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0 flex-1"><p className="text-xs text-[#9B9BA7]">{authorizationLabels[row.kind]}{row.orderId ? ` · ${formatOrderDisplayLabel(row.orderId)}` : ''}</p>
        <h2 className="mt-1 break-words text-xs font-medium">{row.entity} · {row.title}</h2>
        <p className="mt-1 text-[11px] text-[#9B9BA7]">{row.actorName} · {date.format(new Date(row.createdAt))}</p></div>
      <div className="text-right text-xs tabular-nums"><p>{row.currency && row.amount !== null ? `${row.currency} ${money.format(row.amount)}` : 'Ver importes por moneda'}</p>
        {row.kind === 'reapproval' || row.kind === 'order' ? <p className="text-[11px] text-[#9B9BA7]">Total de la orden</p> : null}</div>
      <Link href={authorizationHref(row)} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/40 px-3 text-xs font-semibold text-[#FFFF00]">Revisar →</Link>
    </article>)}</div>
      {!data.rows.length ? <p className="py-3 text-xs text-[#9B9BA7]">No hay operaciones por aprobar con este filtro.</p> : null}
      <AdminPagination page={page} total={data.total} href={p => `/app/admin/autorizaciones?tipo=${kind}&page=${p}`} />
    </section>
    <p className="text-xs text-[#9B9BA7]">Revisar abre la operación actual. Las incidencias de cuentas, entregas y comisiones están en Seguimiento.</p>
  </div>;
}
