'use client';
import Link from 'next/link';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {parseDecimalInput} from '@/lib/number-input';
import {clearFinancialAttempt,readFinancialAttempt,saveFinancialAttempt} from '@/lib/finance/financial-attempt-storage';
import {validCashOperation,type CashOperationInput,type CashOperationResult} from '@/lib/admin-finance/cash-operation';
import {createAdminMoneyMovementAction} from './actions';
type Props={accounts:Array<{id:number;name:string;currencyCode:'USD'|'VES'}>;userId:string;initialAccountId:number|null;initialDirection:'inflow'|'outflow';activeRate:number|null;defaultDate:string};
const field='mt-1 min-h-11 w-full rounded-lg border border-[#343442] bg-[#14141c] px-3 py-2 text-sm';
export default function AdminMovementForm({accounts,userId,initialAccountId,initialDirection,activeRate,defaultDate}:Props){
  const [form,setForm]=useState({accountId:initialAccountId??0,direction:initialDirection,amount:'',fee:'',date:defaultDate,rate:activeRate?.toString()??'',reference:'',counterparty:'',description:'',notes:''});
  const [ready,setReady]=useState(false),[saved,setSaved]=useState<CashOperationInput|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<CashOperationResult|null>(null);
  const guard=useRef(false),attempt=useRef<CashOperationInput|null>(null);
  useEffect(()=>{try{setSaved(readFinancialAttempt<CashOperationInput>(userId,'movement'));setReady(true);}catch(e){setError(e instanceof Error?e.message:'No se pudo recuperar el envío.');}},[userId]);
  const account=accounts.find(a=>a.id===form.accountId);
  async function submit(e?:FormEvent){e?.preventDefault();if(guard.current||result?.status==='confirmed')return;
    const input=saved??attempt.current??{requestId:crypto.randomUUID(),direction:form.direction,moneyAccountId:form.accountId,amount:parseDecimalInput(form.amount),feeAmount:form.direction==='outflow'?parseDecimalInput(form.fee,0):0,movementDate:form.date,exchangeRateVesPerUsd:account?.currencyCode==='VES'?parseDecimalInput(form.rate):null,referenceCode:form.reference,counterpartyName:form.counterparty,description:form.description,notes:form.notes};
    if(!validCashOperation(input)){setError('Revisa cuenta, motivo e importes con máximo dos decimales.');return;}
    try{saveFinancialAttempt(userId,'movement',input);}catch{setError('Habilita el almacenamiento de sesión para proteger el envío antes de continuar.');return;}
    guard.current=true;attempt.current=input;setBusy(true);setError('');
    try{const next=await createAdminMoneyMovementAction(input);setResult(next);if(next.status!=='uncertain'){clearFinancialAttempt(userId,'movement');setSaved(null);if(next.status==='rejected')attempt.current=null;}}
    catch{setResult({status:'uncertain',message:'Conexión interrumpida. Comprueba el mismo envío; queda protegido al recargar.'});}finally{guard.current=false;setBusy(false);}
  }
  if(!ready)return <p className="text-sm" role={error?'alert':'status'}>{error||'Comprobando envíos pendientes…'}</p>;
  if(result?.status==='confirmed'){const r=result.receipt;return <section role="status" className="space-y-3"><h2 className="font-semibold">{r.currentStatus==='confirmed'?'Movimiento registrado':`Movimiento anterior: ${r.currentStatus}`}</h2><p className="text-sm">{new Intl.NumberFormat('es-VE',{style:'currency',currency:r.currency}).format(r.amount+r.feeAmount)} · {r.replayed?'Se recuperó el mismo envío.':'Incluye la comisión si corresponde.'}</p><Link className="inline-flex min-h-11 items-center underline" href={`/app/admin/finanzas/cuentas/movimiento/${r.requestId}`} prefetch={false}>Ver comprobante e historial</Link><a className="ml-4 inline-flex min-h-11 items-center underline" href={`/app/admin/finanzas/cuentas/movimiento?cuenta=${r.accountId}&tipo=${form.direction}`}>Nuevo movimiento</a></section>;}
  if(saved)return <section className="space-y-3"><h2 className="font-semibold">Hay un movimiento pendiente de comprobar</h2><p className="text-sm">{saved.description} · {saved.movementDate} · importe {saved.amount} + comisión {saved.feeAmount}</p><button className="min-h-11 rounded-lg bg-[#feef00] px-4 text-black" disabled={busy} onClick={()=>void submit()}>Comprobar envío anterior</button>{result?<p role="alert">{result.message}</p>:null}</section>;
  return <form onSubmit={submit} className="space-y-3"><fieldset disabled={busy||result?.status==='uncertain'} className="grid gap-3 sm:grid-cols-2">
    <label className="text-sm">Cuenta<select required className={field} value={form.accountId||''} onChange={e=>setForm({...form,accountId:Number(e.target.value)})}><option value="">Selecciona una cuenta</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name} · {a.currencyCode}</option>)}</select></label>
    <label className="text-sm">Tipo<select className={field} value={form.direction} onChange={e=>setForm({...form,direction:e.target.value as 'inflow'|'outflow'})}><option value="inflow">Ingreso</option><option value="outflow">Egreso</option></select></label>
    {([['amount',`Importe · ${account?.currencyCode??''}`],...(form.direction==='outflow'?[['fee','Comisión (opcional)']]:[]),...(account?.currencyCode==='VES'?[['rate','Tasa Bs/USD']]:[])] as Array<['amount'|'fee'|'rate',string]>).map(([key,label])=><label key={key} className="text-sm">{label}<input required={key!=='fee'} inputMode="decimal" className={field} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}
    <label className="text-sm">Fecha real del movimiento<input required type="date" className={field} value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></label>
    {([['description','Motivo',240],['reference','Referencia (opcional)',120],['counterparty','Beneficiario / origen (opcional)',160],['notes','Notas (opcional)',800]] as const).map(([key,label,max])=><label key={key} className="text-sm">{label}<input required={key==='description'} maxLength={max} className={field} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}
  </fieldset><p className="text-xs text-[#aaa]">Los pagos de clientes se registran en sus órdenes. No repitas aquí un pago de delivery, comisión o traspaso ya registrado.</p><button disabled={busy} className="min-h-11 rounded-lg bg-[#feef00] px-4 text-sm font-semibold text-black">{busy?'Comprobando…':result?.status==='uncertain'?'Comprobar el mismo envío':`Registrar ${form.direction==='inflow'?'ingreso':'egreso'}`}</button>{error||result?<p role="alert" className="text-sm text-orange-200">{error||(result?result.message:'')}</p>:null}</form>;
}
