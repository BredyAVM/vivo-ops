import Link from 'next/link';
import { requireAuthContext } from '@/lib/auth';
import RewardGrantCard from '@/components/rewards/RewardGrantCard';
import { REWARD_GRANT_SELECT, rewardGrantState, type RewardGrant } from '@/lib/rewards/wallet-model';
import RewardUseHistory,{REWARD_USE_SELECT,type RewardUse} from '@/components/rewards/RewardUseHistory';
import RewardDebtForm from './RewardDebtForm';
import WalletRefresh from './WalletRefresh';

export default async function AdvisorWalletPage({ searchParams }: { searchParams?: Promise<{ page?: string }> }) {
  const ctx = await requireAuthContext();
  const requestedPage = Number((await searchParams)?.page ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 10000 ? requestedPage : 1;
  const asOf = new Date();
  const [{data,error},history,debt]=await Promise.all([
    ctx.supabase.from('advisor_reward_grants').select(REWARD_GRANT_SELECT).eq('advisor_id',ctx.user.id).order('id',{ascending:false}).range((page-1)*20,page*20),
    ctx.supabase.from('advisor_reward_uses').select(REWARD_USE_SELECT).eq('advisor_id',ctx.user.id).order('id',{ascending:false}).limit(31),
    ctx.supabase.rpc('reward_debt_options_v1',{p_advisor:ctx.user.id}),
  ]);
  if (error) {
    console.error('Wallet unavailable', error.code);
    return <section><h1 className="text-xl font-semibold">Mi monedero</h1><p className="mt-2 text-sm" role="alert">No se pudo consultar tu monedero. No se muestra un saldo cero como sustituto. Vuelve a intentar.</p></section>;
  }
  const grants = data as RewardGrant[];
  return <div className="space-y-3">
    <header><h1 className="text-xl font-semibold">Mi monedero</h1><p className="mt-1 text-xs text-[#AAB2C5]">Crédito y productos otorgados, con sus usos y vencimiento.</p></header>
    <WalletRefresh />
    <p className="rounded-lg border border-emerald-400/20 p-3 text-xs leading-5 text-[#AAB2C5]">Agrega y configura el producto normal en un pedido y elige «Usar mi premio». Se reserva al guardar, se consume al entregar y se libera al retirar el producto o cancelar el pedido. No se aplica automáticamente. La fecha planificada debe estar dentro de su vigencia; una entrega retrasada no invalida una reserva válida.</p>
    {grants.length === 0 ? <section className="rounded-xl border border-[#232632] bg-[#12151d] p-4"><h2 className="text-sm font-semibold">{page === 1 ? 'Todavía no tienes premios emitidos' : 'No hay más premios en esta página'}</h2><p className="mt-2 text-xs text-[#AAB2C5]">Los borradores del administrador no aparecen como premios otorgados.</p></section> : null}
    {grants.slice(0,20).map(grant => <RewardGrantCard key={grant.id} grant={grant} asOf={asOf} action={grant.kind==='credit'&&grant.terms_snapshot.purposes.includes('advisor_debt')&&rewardGrantState(grant,asOf).validAmount>0
      ? debt.error?<p role="alert" className="text-xs">No se pudo verificar la deuda. No se habilita amortización.</p>:<RewardDebtForm grantId={grant.id} available={rewardGrantState(grant,asOf).validAmount} closureId={debt.data?.[0]?.closureId} debtUsd={debt.data?.[0]?.debtUsd} />:undefined} />)}
    {history.error?<p role="alert" className="text-xs">No se pudo consultar el historial de usos.</p>:<RewardUseHistory uses={(history.data??[]) as RewardUse[]} />}
    <nav aria-label="Páginas del monedero" className="flex gap-3 text-xs">{page > 1 ? <Link prefetch={false} className="inline-flex min-h-10 items-center" href={'/app/advisor/wallet?page=' + (page-1)}>Más recientes</Link> : null}{grants.length > 20 ? <Link prefetch={false} className="inline-flex min-h-10 items-center" href={'/app/advisor/wallet?page=' + (page+1)}>Anteriores</Link> : null}</nav>
    <Link href="/app/advisor/new" prefetch={false} className="inline-flex min-h-10 items-center rounded-lg border border-[#303040] px-3 text-sm">Ir a nuevo pedido</Link>
  </div>;
}
