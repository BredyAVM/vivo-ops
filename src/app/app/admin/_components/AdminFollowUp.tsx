import Link from '@/components/navigation/ContextLink';
import { ReturnContextField } from '@/components/navigation/BackLink';
import { queryControl, queryPanel, queryPrimary } from '@/components/ui/QueryControls';
import { currencyLabel } from '@/lib/ui/currency-label';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminTasks } from '@/lib/admin-finance/tasks-data';
import { filterAdminTaskGroups } from '@/lib/admin-finance/tasks-model';
import type { DeliveryRpcClient } from '@/lib/admin-finance/delivery-data';
import { AdminPagination, adminPanel } from './AdminReadUi';

export default async function AdminFollowUp({ params }: { params: Record<string, string | string[] | undefined> }) {
  const first = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]) ?? '';
  const domain = ['cuentas', 'pedidos', 'comisiones'].includes(first('dominio')) ? first('dominio') as 'cuentas' | 'pedidos' | 'comisiones' : 'cuentas';
  const q = first('q').trim().slice(0, 80);
  const ctx = await requireAdminContext();
  const data = first('consultar') === '1' ? await loadAdminTasks(ctx.supabase as unknown as DeliveryRpcClient, domain) : null;
  const filtered = data ? filterAdminTaskGroups(data.groups, domain, q) : [];
  const rawPage = Number(first('page'));
  const page = Math.min(Math.max(1, Math.ceil(filtered.length / 30)), Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1);
  const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const field = queryControl;
  return <div className="space-y-3">
    <form action="/app/admin/autorizaciones" method="get" className={`${queryPanel} grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]`}>
      <ReturnContextField /><input type="hidden" name="bandeja" value="seguimiento" /><input type="hidden" name="consultar" value="1" />
      <label className="grid gap-1 text-xs text-[#BDBDC7]">Área<select name="dominio" defaultValue={domain} className={field}><option value="cuentas">Cuentas</option><option value="pedidos">Órdenes y entregas</option><option value="comisiones">Comisiones</option></select></label>
      <label className="grid min-w-0 flex-1 gap-1 text-xs text-[#BDBDC7]">Buscar<input name="q" defaultValue={q} maxLength={80} placeholder="Cuenta, cliente o asesor" className={field} /></label>
      <button className={queryPrimary}>Consultar</button>
    </form>
    {!data ? <p className="text-xs text-[#9B9BA7]">Selecciona el área y consulta. No se carga el historial al entrar.</p> : <section className={adminPanel}>
      <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-[#9B9BA7]"><span>{filtered.length} grupos de seguimiento</span><span>Consulta {new Intl.DateTimeFormat('es-VE', { timeStyle: 'short', timeZone: 'America/Caracas' }).format(new Date(data.asOf))}</span></div>
      {data.errors.length ? <p role="alert" className="text-xs text-orange-200">No se pudo consultar {data.errors.join(', ')}. No equivale a cero pendientes.</p> : null}
      <div className="divide-y divide-[#292937]">{filtered.slice((page - 1) * 30, page * 30).map(row => <article key={row.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0 flex-1"><Link href={row.href} prefetch={false} className={`inline-flex min-h-11 items-center text-xs font-medium underline ${row.attention ? 'text-orange-200' : 'text-[#DEDEE6]'}`}>{row.title} · {row.entity} →</Link><p className="text-xs text-[#9B9BA7]">{row.count > 1 ? `${row.count} registros · ` : ''}{row.note}</p></div>
        {row.amount !== null ? <p className="text-xs tabular-nums">{currencyLabel(row.currency)} {money.format(row.amount)}</p> : null}
      </article>)}</div>
      {!filtered.length && !data.errors.length ? <p className="py-3 text-xs text-[#9B9BA7]">Sin incidencias en el área consultada con estos filtros.</p> : null}
      <AdminPagination page={page} total={filtered.length} href={value => `/app/admin/autorizaciones?${new URLSearchParams({ bandeja: 'seguimiento', consultar: '1', dominio: domain, q, page: String(value) })}`} />
    </section>}
  </div>;
}
