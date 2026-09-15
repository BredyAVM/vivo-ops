import Link from 'next/link';
import {notFound} from 'next/navigation';
import {requireAdminContext} from '@/lib/auth';
import {parseCashReceipt,type CashOperationInput} from '@/lib/admin-finance/cash-operation';
import {readCashOperation,readCashOperationMovements} from '@/lib/admin-finance/account-operation-reads';
export default async function CashReceiptPage({params}:{params:Promise<{requestId:string}>}){
  const {supabase}=await requireAdminContext();const {requestId}=await params;if(!/^[\da-f-]{36}$/i.test(requestId))notFound();
  const {data:op,error}=await readCashOperation(supabase,requestId);
  if(error)return <p role="alert">No se pudo consultar el comprobante.</p>;if(!op)notFound();
  const input={...op.input,requestId} as CashOperationInput;const receipt=parseCashReceipt(op.result,input);
  const {data:movements,error:movementError}=await readCashOperationMovements(supabase,requestId);
  if(movementError)return <p role="alert">No se pudo verificar el estado actual de los movimientos.</p>;
  const money=(n:number)=>new Intl.NumberFormat('es-VE',{style:'currency',currency:receipt.currency}).format(n);
  return <div className="mx-auto max-w-3xl space-y-4"><Link prefetch={false} className="inline-flex min-h-11 items-center text-sm underline" href={`/app/admin/finanzas/cuentas/${receipt.accountId}?desde=${input.movementDate}&hasta=${input.movementDate}`}>← Movimientos de la cuenta</Link><h1 className="text-xl font-semibold">{input.direction==='inflow'?'Ingreso':'Egreso'} · Comprobante</h1><section className="space-y-2 rounded-xl border border-[#292937] p-4"><p className="text-xl font-semibold">{money(receipt.amount+receipt.feeAmount)}</p><p>{input.description}</p><p className="text-sm text-[#aaa]">{input.movementDate} · {input.referenceCode||'Sin referencia'} · {input.counterpartyName}</p>{receipt.feeAmount>0?<p className="text-sm">Principal {money(receipt.amount)} + comisión {money(receipt.feeAmount)}</p>:null}{movements?.map(m=><p key={m.id} className="text-sm">Movimiento {m.id} · {m.status==='confirmed'?'Confirmado':m.status==='voided'?'Anulado':m.status} {m.void_reason?`· ${m.void_reason}`:''}</p>)}<p className="break-all text-xs text-[#777]">Comprobante: {requestId}</p></section></div>;
}
