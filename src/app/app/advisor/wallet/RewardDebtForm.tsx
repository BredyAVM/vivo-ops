'use client';
import {useRef,useState,useTransition} from 'react';
import {applyRewardDebtAction} from './actions';
export default function RewardDebtForm({grantId,available,closureId,debtUsd}:{grantId:number;available:number;closureId?:number;debtUsd?:number}) {
  const [amount,setAmount]=useState(''),[message,setMessage]=useState(''),[pending,start]=useTransition();
  const token=useRef<string|null>(null);
  if(!closureId||!debtUsd||debtUsd<=0)return <p className="mt-2 text-xs text-[#AAB2C5]">Sin deuda amortizable en el cierre preliminar actual. No se alteran cierres cerrados.</p>;
  const maximum=Math.min(available,debtUsd),value=Number(amount),valid=value>0&&value<=maximum&&Number.isFinite(value)&&Math.abs(value*100-Math.round(value*100))<0.00001;
  return <details className="mt-2 text-xs"><summary className="cursor-pointer py-2">Amortizar mi deuda · pendiente ${debtUsd.toFixed(2)}</summary>
    <form className="flex flex-wrap items-center gap-2" onSubmit={e=>{e.preventDefault();if(!valid||pending)return;token.current??=crypto.randomUUID();start(async()=>{
      const result=await applyRewardDebtAction(grantId,closureId,value,token.current!);setMessage(result.message);
      if(result.ok){token.current=null;setAmount('');}
    });}}>
      <label>Monto ($)<input aria-label="Crédito para amortizar deuda" type="number" min="0.01" max={maximum} step="0.01" value={amount} disabled={pending} onChange={e=>{setAmount(e.target.value);token.current=null;}} className="ml-2 w-24 rounded border border-[#303040] bg-[#0B0B10] p-2" /></label>
      <button disabled={!valid||pending} className="min-h-10 rounded border border-[#303040] px-3 disabled:opacity-40">{pending?'Aplicando…':'Confirmar amortización'}</button>
      <p className="w-full text-[#AAB2C5]">Se consume del premio y reduce tu deuda en el cierre #{closureId}. No es retiro de efectivo.</p>
      {message?<p role="status" className="w-full">{message}</p>:null}
    </form>
  </details>;
}
