import Link from 'next/link';
import { requireAuthContext } from '@/lib/auth';
import RewardGrantCard from '@/components/rewards/RewardGrantCard';
import { REWARD_GRANT_SELECT, type RewardGrant } from '@/lib/rewards/wallet-model';
import WalletRefresh from './WalletRefresh';

export default async function AdvisorWalletPage({ searchParams }: { searchParams?: Promise<{ page?: string }> }) {
  const ctx = await requireAuthContext();
  const requestedPage = Number((await searchParams)?.page ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 10000 ? requestedPage : 1;
  const asOf = new Date();
  const { data, error } = await ctx.supabase.from('advisor_reward_grants').select(REWARD_GRANT_SELECT)
    .eq('advisor_id', ctx.user.id).order('id', { ascending: false }).range((page - 1) * 20, page * 20);
  if (error) {
    console.error('Wallet unavailable', error.code);
    return <section><h1 className="text-xl font-semibold">Mi monedero</h1><p className="mt-2 text-sm" role="alert">No se pudo consultar tu monedero. No se muestra un saldo cero como sustituto. Vuelve a intentar.</p></section>;
  }
  const grants = data as RewardGrant[];
  return <div className="space-y-3">
    <header><h1 className="text-xl font-semibold">Mi monedero</h1><p className="mt-1 text-xs text-[#AAB2C5]">Crédito y productos otorgados, con sus usos y vencimiento.</p></header>
    <WalletRefresh />
    <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">Ya puedes consultar los premios emitidos. El uso en pedidos y la amortización de deudas siguen en preparación. No se aplicará nada automáticamente.</p>
    {grants.length === 0 ? <section className="rounded-xl border border-[#232632] bg-[#12151d] p-4"><h2 className="text-sm font-semibold">{page === 1 ? 'Todavía no tienes premios emitidos' : 'No hay más premios en esta página'}</h2><p className="mt-2 text-xs text-[#AAB2C5]">Los borradores del administrador no aparecen como premios otorgados.</p></section> : null}
    {grants.slice(0,20).map(grant => <RewardGrantCard key={grant.id} grant={grant} asOf={asOf} />)}
    <nav aria-label="Páginas del monedero" className="flex gap-3 text-xs">{page > 1 ? <Link prefetch={false} className="inline-flex min-h-10 items-center" href={'/app/advisor/wallet?page=' + (page-1)}>Más recientes</Link> : null}{grants.length > 20 ? <Link prefetch={false} className="inline-flex min-h-10 items-center" href={'/app/advisor/wallet?page=' + (page+1)}>Anteriores</Link> : null}</nav>
    <Link href="/app/advisor/new" prefetch={false} className="inline-flex min-h-10 items-center rounded-lg border border-[#303040] px-3 text-sm">Ir a nuevo pedido</Link>
  </div>;
}
