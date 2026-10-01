import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireMasterOrAdminContext } from '@/lib/auth';
import OrderExceptionCard from './OrderExceptionCard';

export const dynamic = 'force-dynamic';
type Params = Promise<{ client?: string; member?: string; page?: string }>;
const positiveId = (value: string | undefined) => {
  const number = Number(value);
  return value && /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0 ? number : null;
};

export default async function ClientPlayExceptionsPage({ searchParams }: { searchParams: Params }) {
  const ctx = await requireMasterOrAdminContext().catch(() => null);
  if (!ctx) redirect('/app');
  const params = await searchParams;
  const clientId = positiveId(params.client);
  const memberId = positiveId(params.member);
  const page = positiveId(params.page) ?? 1;
  if (!clientId || (params.member && !memberId) || page > 10000) notFound();
  const { data: client, error: clientError } = await ctx.supabase.from('clients')
    .select('id,full_name').eq('id',clientId).maybeSingle();
  if (clientError) throw new Error('No se pudo consultar el cliente.');
  if (!client) notFound();
  let playId: number | null = null;
  if (memberId) {
    const { data: member, error } = await ctx.supabase.from('crm_play_members')
      .select('id,play_id').eq('id',memberId).eq('client_id',clientId).maybeSingle();
    if (error) throw new Error('No se pudo consultar la pertenencia a la jugada.');
    if (!member) notFound();
    playId = Number(member.play_id);
  }
  const pageSize = 10;
  let query = ctx.supabase.from('orders')
    .select('id,order_number,status,order_items!inner(crm_play_member_id)', { count: 'exact' })
    .eq('client_id',clientId).not('order_items.crm_play_member_id','is',null)
    .order('created_at',{ ascending: false }).order('id',{ ascending: false });
  if (memberId) query = query.eq('order_items.crm_play_member_id',memberId);
  const { data: orders, count, error } = await query.range((page-1)*pageSize,page*pageSize-1);
  if (error) throw new Error('No se pudieron consultar las órdenes vinculadas a las jugadas.');
  const base = `/app/master/plays/exceptions?client=${clientId}${memberId ? `&member=${memberId}` : ''}`;
  const isAdmin = ctx.roles.includes('admin');
  return <main className="mx-auto max-w-3xl space-y-4 p-4 text-[#F5F5F7]">
    <Link href={playId ? `/app/master/plays?play=${playId}` : '/app/master/dashboard'} className="text-sm underline">Volver</Link>
    <header>
      <h1 className="text-lg font-semibold">Excepciones de jugadas · {client.full_name}</h1>
      <p className="mt-1 text-xs text-[#B7B7C2]">Cliente #{clientId}{memberId ? ' · Solo esta jugada' : ' · Todas sus jugadas'}. {isAdmin ? 'Autorización exclusiva del administrador.' : 'Consulta de autorizaciones. Master no puede crearlas.'}</p>
      <p className="mt-2 text-xs text-[#B7B7C2]">Es el mismo registro que se ve en la orden. Cada excepción cubre únicamente ese pedido y sus obsequios; no se extiende a todas las compras del cliente.</p>
    </header>
    {orders?.length ? orders.map((order) => <OrderExceptionCard key={order.id} orderId={Number(order.id)} orderNumber={order.order_number}
      closed={['delivered','cancelled'].includes(order.status)} isAdmin={isAdmin} />
    ) : <p className="rounded-xl border border-[#343440] p-4 text-sm">No hay órdenes con obsequios CRM vinculados {memberId ? 'a esta jugada' : 'a este cliente'}. Esta herramienta requiere una orden guardada con su obsequio asociado.</p>}
    <nav aria-label="Páginas de órdenes" className="flex gap-4 text-xs">
      {page > 1 ? <Link href={`${base}&page=${page-1}`} className="underline">Anteriores</Link> : null}
      <span>Página {page} · {count ?? 0} órdenes</span>
      {(count ?? 0) > page*pageSize ? <Link href={`${base}&page=${page+1}`} className="underline">Siguientes</Link> : null}
    </nav>
  </main>;
}
