'use client';
import Link from 'next/link';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {clearFinancialAttempt,readFinancialAttempt} from '@/lib/finance/financial-attempt-storage';
import type {AccountClosureInput,AccountClosureResult} from '@/lib/finance/account-closure-model';
import type {MoneyTransferInput,MoneyTransferResult} from '@/lib/finance/money-transfer-model';
import {createAdminAccountClosure} from '../cierre/actions';
import {createAdminTransferAction} from '../transferencia/actions';
export default function AttemptRecovery({userId,scope,children}:{userId:string;scope:'closure'|'transfer';children:ReactNode}) {
  const [ready,setReady]=useState(false),[saved,setSaved]=useState<AccountClosureInput|MoneyTransferInput|null>(null),[result,setResult]=useState<AccountClosureResult|MoneyTransferResult|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);const guard=useRef(false);
  useEffect(()=>{try{setSaved(readFinancialAttempt<AccountClosureInput|MoneyTransferInput>(userId,scope));}catch(e){setError(e instanceof Error?e.message:'No se pudo recuperar el envío.');}setReady(true);},[userId,scope]);
  if(!ready)return <p className="text-sm">Comprobando envíos pendientes…</p>;
  if(error)return <p role="alert" className="text-sm text-orange-200">{error}</p>;
  if(!saved)return <>{result&&result.status==='rejected'?<p role="alert">{result.message}</p>:null}{children}</>;
  if(result?.status==='confirmed') {
    const closureId='closureId' in result.receipt?result.receipt.closureId:null;
    const accountId='moneyAccountId' in saved?saved.moneyAccountId:saved.sourceMoneyAccountId;
    return <section role="status" className="space-y-3 rounded-xl border border-emerald-700 p-4"><p>Se comprobó el envío anterior sin crear otra operación.</p><Link prefetch={false} className="inline-flex min-h-11 items-center underline" href={closureId?`/app/admin/finanzas/cuentas/cierre/${closureId}`:`/app/admin/finanzas/cuentas/${accountId}`}>Ver registro e historial</Link><a href={`/app/admin/finanzas/cuentas/${scope==='closure'?'cierre':'transferencia'}?cuenta=${accountId}`} className="ml-4 underline">Nueva operación</a></section>;
  }
  return <section className="space-y-3 rounded-xl border border-orange-500/30 p-4"><h2 className="font-semibold">Hay {scope==='closure'?'un cierre':'un traspaso'} pendiente de comprobar</h2><p className="text-sm">Se recuperaron los mismos datos del envío anterior. Comprueba su resultado antes de registrar otro.</p><button className="min-h-11 rounded-lg bg-[#feef00] px-4 text-sm font-semibold text-black" disabled={busy} onClick={async()=>{if(guard.current)return;guard.current=true;setBusy(true);try{const next=scope==='closure'?await createAdminAccountClosure(saved as AccountClosureInput):await createAdminTransferAction(saved as MoneyTransferInput);setResult(next);if(next.status!=='uncertain'){clearFinancialAttempt(userId,scope);if(next.status==='rejected')setSaved(null);}}catch{setResult({status:'uncertain',message:'No se pudo comprobar el resultado. Reintenta el mismo envío.'});}finally{guard.current=false;setBusy(false);}}}>{busy?'Comprobando…':'Comprobar envío anterior'}</button>{result?<p role="alert" className="text-sm">{result.message}</p>:null}</section>;
}
