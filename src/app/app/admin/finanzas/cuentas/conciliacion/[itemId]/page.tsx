import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import { parseReconciliationDetail } from '@/lib/admin-finance/reconciliation';
import ReconciliationForm from '../ReconciliationForm';
import { readAccountName, readReconciliationReview } from '@/lib/admin-finance/account-operation-reads';
export default async function ReconciliationPage({params,searchParams}:{params:Promise<{itemId:string}>;searchParams:Promise<{q?:string}>}) {
  const {supabase,user}=await requireAdminContext();
  const id=Number((await params).itemId); if(!Number.isSafeInteger(id)||id<=0) notFound();
  const q=(await searchParams).q??'';
  const {data,error}=await readReconciliationReview(supabase,id,q);
  if(error) return <p role="alert">No se pudo consultar esta diferencia. Intenta actualizar.</p>;
  const detail=parseReconciliationDetail(data); if(!detail) notFound();
  const {data:account}=await readAccountName(supabase,detail.item.money_account_id);
  return <div className="mx-auto max-w-4xl space-y-4"><header><Link prefetch={false} href={`/app/admin/finanzas/cuentas/${detail.item.money_account_id}?vista=reconciliation`} className="inline-flex min-h-11 items-center text-sm text-[#aaa]">← Conciliación de cuenta</Link><h1 className="text-xl font-semibold">{account?.name??'Cuenta'} · Diferencia #{id}</h1></header>
    <ReconciliationForm key={detail.item.id} detail={detail} userId={user.id} query={q}/>
  </div>;
}
