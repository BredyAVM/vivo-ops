import Link from 'next/link';
import { requireAuthContext, resolveHomePath } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export default async function OngoingEventsPage() {
  const ctx = await requireAuthContext();
  const { data, error } = await ctx.supabase.rpc('event_workspace_read_v1', {});
  const rows = (data ?? []) as { id: number; title: string; event_date: string; pending: number; payment_pending?: number; converted_order_id: number | null; event_state: { closed?: boolean } | null }[];
  return <main className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold">Eventos y ampliaciones</h1><div className="flex gap-3">
      {ctx.roles.includes('admin') ? <Link className="text-yellow-300" href="/app/events">Nuevo presupuesto</Link> : null}
      <Link href={resolveHomePath(ctx.roles)}>Volver a mi módulo</Link></div></header>
    <p className="text-sm text-zinc-400">Un evento, todas sus órdenes y un resumen de cobro.</p>
    {error ? <p role="alert" className="text-red-300">No se pudo cargar: {error.message}</p> : rows.length === 0 ? <p>No hay eventos asignados.</p> : rows.map(row =>
      <Link key={row.id} href={`/app/events/${row.id}`} prefetch={false} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div><strong>{row.title}</strong><p className="text-xs text-zinc-400">{row.event_date} · {row.event_state?.closed ? 'Cerrado' : row.converted_order_id ? 'En seguimiento' : 'Presupuesto'}</p></div>
        {Number(row.pending) + Number(row.payment_pending ?? 0) > 0 ? <span className="rounded-full bg-yellow-400/10 px-3 py-1 text-sm text-yellow-300">{Number(row.pending) + Number(row.payment_pending ?? 0)} pendientes</span> : <span aria-hidden>→</span>}
      </Link>)}
  </main>;
}
