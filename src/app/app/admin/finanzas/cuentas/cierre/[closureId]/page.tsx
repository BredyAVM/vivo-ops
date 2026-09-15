import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import VoidClosure from '../VoidClosure';
import { readAccountName, readClosureReview } from '@/lib/admin-finance/account-operation-reads';
export default async function ClosureDetailPage({params}:{params:Promise<{closureId:string}>}) {
  const {supabase}=await requireAdminContext();const id=Number((await params).closureId);if(!Number.isSafeInteger(id)||id<=0)notFound();
  const [{data:c,error},{data:items,error:itemsError},{data:reversal,error:reversalError}]=await readClosureReview(supabase,id);
  if(error||itemsError||reversalError)return <p role="alert">No se pudo verificar el cierre y su historial. Actualiza antes de continuar.</p>;
  if(!c)notFound();
  const {data:account}=await readAccountName(supabase,c.money_account_id);
  const money=(n:number)=>new Intl.NumberFormat('es-VE',{style:'currency',currency:c.currency_code}).format(n);
  const at=(v:string)=>new Date(v).toLocaleString('es-VE',{timeZone:'America/Caracas'});
  return <div className="mx-auto max-w-4xl space-y-4"><header><Link prefetch={false} href={`/app/admin/finanzas/cuentas/${c.money_account_id}?vista=closures`} className="inline-flex min-h-11 items-center text-sm text-[#aaa]">← Cierres de la cuenta</Link><h1 className="text-xl font-semibold">{account?.name??'Cuenta'} · Cierre #{id}</h1><p className="mt-1 text-sm text-[#aaa]">{at(c.closure_at??c.created_at)} · {c.status==='rejected'?'Anulado / rechazado':c.status==='approved'?'Aprobado':'Registrado'}</p></header>
    <section className="grid grid-cols-3 gap-3 rounded-xl border border-[#292937] p-4">{[['Sistema',c.expected_amount],['Observado',c.counted_amount],['Diferencia',c.difference_amount]].map(([label,amount])=><div key={label}><p className="text-xs text-[#aaa]">{label}</p><p className="mt-1 text-base font-semibold tabular-nums break-words">{money(Number(amount))}</p></div>)}</section>
    <p className="text-sm whitespace-pre-wrap">{c.reason}{c.notes?` · ${c.notes}`:''}</p><p className="text-xs text-[#aaa]">Esta es la fotografía guardada. Resolver una diferencia no reescribe estos importes.</p>
    <section className="space-y-2"><h2 className="text-sm font-semibold">Diferencias relacionadas</h2>{items?.length?items.slice(0,500).map(item=><Link key={item.id} href={`/app/admin/finanzas/cuentas/conciliacion/${item.id}`} prefetch={false} className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-[#292937] px-3 text-sm"><span className="min-w-0 truncate">{item.description}</span><span className="shrink-0">{money(item.amount)} · {item.status==='open'?'Resolver':item.status==='resolved'?'Resuelta':'Anulada'}</span></Link>):<p className="text-sm text-[#aaa]">Sin diferencias vinculadas.</p>}{items&&items.length>500?<p role="alert">Hay más partidas. Consulta la conciliación de la cuenta para revisar el resto.</p>:null}</section>
    {reversal?<p className="text-sm">Motivo de anulación: {reversal.reason}</p>:null}
    {['recorded','approved'].includes(c.status)?<VoidClosure closureId={id}/>:null}
  </div>;
}
