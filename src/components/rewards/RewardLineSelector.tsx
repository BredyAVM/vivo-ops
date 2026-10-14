'use client';
import { useState } from 'react';
import { REWARD_PURPOSES, rewardGrantState, type RewardGrant } from '@/lib/rewards/wallet-model';
import { rewardFitsProduct, type RewardLineFunding } from '@/lib/rewards/order-funding';

export default function RewardLineSelector({grants,productId,quantity,grossUsd,funding,available,personalClient,disabled,onChange}: {
  grants:RewardGrant[]; productId:number; quantity:number; grossUsd:number; funding?:RewardLineFunding;
  available:(grant:RewardGrant)=>number; personalClient:boolean; disabled?:boolean; onChange:(value?:RewardLineFunding)=>void;
}) {
  const [amount,setAmount]=useState('');
  const choices=grants.flatMap(grant=>(['customer_gift','personal_purchase'] as const)
    .filter(purpose=>grant.status==='active'&&!rewardGrantState(grant).expired&&(purpose!=='personal_purchase'||personalClient)&&rewardFitsProduct(grant,productId,purpose)
      && available(grant)>0 && (grant.kind!=='product_units'||(Number.isInteger(quantity)&&quantity<=available(grant))))
    .map(purpose=>({grant,purpose,key:grant.id+':'+purpose})));
  if(funding) return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-emerald-200">
    <span>Premio: {funding.title} · {REWARD_PURPOSES[funding.purpose]} · ${funding.amountUsd.toFixed(2)}</span>
    <button type="button" disabled={disabled} onClick={()=>onChange()} className="min-h-10 rounded-lg border border-emerald-300/25 px-2 disabled:opacity-40">Quitar premio</button>
  </div>;
  if(!choices.length||disabled) return null;
  return <details className="mt-2 text-xs"><summary className="cursor-pointer py-2 text-emerald-200">Usar mi premio en este producto</summary>
    <div className="space-y-2 rounded-lg border border-emerald-300/20 p-2">
      <label>Crédito a aplicar ($)<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="Máximo disponible" className="ml-2 w-28 rounded border border-[#303040] bg-[#0B0B10] p-2" /></label>
      {choices.map(({grant,purpose,key})=>{
        const max=Math.min(available(grant),grossUsd), entered=amount.trim()?Number(amount):max;
        const valid=grant.kind==='product_units'||(Number.isFinite(entered)&&entered>0&&entered<=max&&Math.abs(entered*100-Math.round(entered*100))<0.00001);
        return <button key={key} type="button" disabled={!valid} className="block min-h-10 w-full rounded border border-[#303040] px-2 text-left disabled:opacity-40"
          onClick={()=>onChange({grantId:grant.id,title:grant.terms_snapshot.title,purpose,kind:grant.kind,amountUsd:grant.kind==='product_units'?grossUsd:entered})}>
          {grant.terms_snapshot.title} · {REWARD_PURPOSES[purpose]} · {grant.kind==='product_units'?quantity+' unidad(es)':'$'+(valid?entered:0).toFixed(2)}{grant.expires_on?' · Hasta '+grant.expires_on:''}
        </button>;
      })}
      <p className="text-[#AAB2C5]">Se reserva al guardar y se consume al entregar. No es dinero en caja ni fondo del cliente.</p>
    </div>
  </details>;
}
