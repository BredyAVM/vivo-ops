import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminTasks } from '@/lib/admin-finance/tasks-data';
import { filterAdminTaskGroups } from '@/lib/admin-finance/tasks-model';
import type { DeliveryRpcClient } from '@/lib/admin-finance/delivery-data';
import { AdminKpi, AdminPagination, adminInput, adminPanel } from '../_components/AdminReadUi';

export default async function AdminTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAdminContext();
  const params = await searchParams;
  const first = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]) ?? '';
  const domain = ['cuentas','pedidos','comisiones'].includes(first('dominio')) ? first('dominio') : 'all';
  const q = first('q').trim().slice(0, 80);
  const data = await loadAdminTasks(ctx.supabase as unknown as DeliveryRpcClient);
  const filtered = filterAdminTaskGroups(data.groups, domain, q);
  const rawPage = Number(first('page'));
  const page = Math.min(Math.max(1, Math.ceil(filtered.length / 30)), Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1);
  const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <div className="space-y-5"><header><h1 className="text-xl font-semibold">Pendientes</h1><p className="mt-1 text-xs text-[#9B9BA7]">Se resuelven en su operación de origen · Consulta {new Intl.DateTimeFormat('es-VE', { timeStyle: 'short', timeZone: 'America/Caracas' }).format(new Date(data.asOf))}</p></header>
    {data.errors.length ? <p role="alert" className="text-sm text-orange-200">Lectura parcial: no se pudieron consultar {data.errors.join(', ')}. Sus pendientes no se muestran como cero.</p> : null}
    <section aria-label="Grupos pendientes" className="grid grid-cols-2 gap-3 lg:grid-cols-3">{(['cuentas','pedidos','comisiones'] as const).map(key => <AdminKpi key={key} label={{ cuentas: 'Cuentas', pedidos: 'Pedidos', comisiones: 'Comisiones' }[key]} value={data.errors.includes({ cuentas: 'Cuentas', pedidos: 'Pedidos', comisiones: 'Comisiones' }[key]) ? '—' : data.groups.filter(row => row.domain === key).length} hint="Grupos para revisar; no suma de importes" />)}</section>
    <form className="flex flex-wrap gap-2"><label className="sr-only" htmlFor="task-domain">Dominio</label><select id="task-domain" name="dominio" defaultValue={domain} className={adminInput}><option value="all">Todos</option><option value="cuentas">Cuentas</option><option value="pedidos">Pedidos</option><option value="comisiones">Comisiones</option></select><label className="sr-only" htmlFor="task-search">Buscar pendiente</label><input id="task-search" name="q" placeholder="Cuenta, cliente o asesor" defaultValue={q} maxLength={80} className={`${adminInput} flex-1`} /><button className={adminInput}>Filtrar</button></form>
    <section className={adminPanel}><div className="divide-y divide-[#292937]">{filtered.slice((page - 1) * 30, page * 30).map(row => <article key={row.key} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><Link href={row.href} prefetch={false} className={`inline-flex min-h-11 items-center text-sm font-semibold underline ${row.attention ? 'text-orange-200' : 'text-white'}`}>{row.title} · {row.entity} →</Link><p className="text-xs text-[#9B9BA7]">{row.count > 1 ? `${row.count} registros · ` : ''}{row.note}</p></div>{row.amount !== null ? <p className="text-sm tabular-nums">{row.currency} {money.format(row.amount)}</p> : null}</article>)}</div>{!filtered.length ? <p className="py-5 text-sm text-[#9B9BA7]">Sin pendientes en las fuentes consultadas con estos filtros.</p> : null}<AdminPagination page={page} total={filtered.length} href={value => `/app/admin/tareas?${new URLSearchParams({ dominio: domain, q, page: String(value) })}`} /></section>
    <section className={adminPanel}><h2 className="text-sm font-semibold">Otras bandejas</h2><div className="mt-2 flex flex-wrap gap-4 text-sm">{[['Todos los reportes de pago','/app/master/ops/finance?status=pending'],['Retornos de delivery','/app/admin/finanzas/delivery#liquidaciones'],['Alertas de inventario','/app/inventory/alerts']].map(([label, href]) => <Link key={href} href={href} prefetch={false} className="inline-flex min-h-11 items-center underline">{label} →</Link>)}</div><p className="mt-2 text-xs text-[#9B9BA7]">Estas bandejas no están incluidas en los contadores superiores. No se asignan responsables ni se cierran pendientes desde esta pantalla.</p></section>
  </div>;
}
