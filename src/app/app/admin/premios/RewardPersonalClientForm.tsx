'use client';
import {useState,useTransition} from 'react';
import {setRewardPersonalClientAction,lookupRewardPersonalClientAction} from './actions';
export default function RewardPersonalClientForm({advisors}:{advisors:{id:string;fullName:string}[]}){
  const [advisor,setAdvisor]=useState(''),[client,setClient]=useState(''),[preview,setPreview]=useState<{id:number;name:string;phone:string|null}|null>(null),[message,setMessage]=useState(''),[pending,start]=useTransition();
  return <details className="rounded-lg border border-[#292937] p-3 text-xs"><summary className="cursor-pointer">Vincular ficha del asesor para consumo propio</summary>
    <div className="mt-2 flex flex-wrap gap-2">
      <label>Asesor<select value={advisor} disabled={pending} onChange={e=>{setAdvisor(e.target.value);setPreview(null);}} className="ml-2 min-h-10 rounded border border-[#303040] bg-[#0B0B10] px-2"><option value="">Seleccionar</option>{advisors.map(a=><option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label>
      <label>Número de cliente<input type="number" min="1" value={client} disabled={pending} onChange={e=>{setClient(e.target.value);setPreview(null);}} className="ml-2 w-24 rounded border border-[#303040] bg-[#0B0B10] p-2" /></label>
      <button type="button" disabled={pending||!advisor||!client} className="min-h-10 rounded border border-[#303040] px-2 disabled:opacity-40" onClick={()=>start(async()=>{const result=await lookupRewardPersonalClientAction(Number(client));setPreview(result.client??null);setMessage(result.message);})}>Revisar cliente</button>
      {preview?<p className="w-full">{preview.id} · {preview.name} · {preview.phone} <button disabled={pending} type="button" className="ml-2 min-h-10 rounded border border-[#303040] px-2" onClick={()=>start(async()=>{const result=await setRewardPersonalClientAction(advisor,preview.id);setMessage(result.message);if(result.ok)setPreview(null);})}>Confirmar vínculo personal</button></p>:null}
      <p className="w-full text-[#AAB2C5]">Solo esta ficha puede utilizar premios para consumo propio. Vincularla no autoriza un premio comercial para uso personal.</p>
      {message?<p role="status" className="w-full">{message}</p>:null}
    </div>
  </details>;
}
