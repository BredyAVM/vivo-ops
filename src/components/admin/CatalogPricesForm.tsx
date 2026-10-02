'use client';
import { currencyLabel } from '@/lib/ui/currency-label';
import { queryControl } from '@/components/ui/QueryControls';
import {useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {updateInventoryProductPricesBulkAction} from '@/app/app/inventory/actions';
type PriceRow={id:number;name:string;sku:string|null;isActive:boolean;amount:number;currency:'USD'|'VES'};
const input=queryControl;
export default function CatalogPricesForm({rows}:{rows:PriceRow[]}){
 const router=useRouter(),busy=useRef(false);
 const [draft,setDraft]=useState(rows.map(r=>({...r,value:String(r.amount)}))),[confirmed,setConfirmed]=useState(false),[message,setMessage]=useState(''),[pending,start]=useTransition();
 const changes=draft.filter(r=>Number(r.value)!==r.amount||r.currency!==rows.find(o=>o.id===r.id)?.currency);
 function save(){
  if(busy.current||!confirmed||!changes.length)return;
  if(changes.some(r=>!r.value.trim()||!Number.isFinite(Number(r.value))||Number(r.value)<0)){setMessage('Revisa los precios; no se guardaron cambios.');return;}
  busy.current=true;setMessage('');
  start(async()=>{
   try{const result=await updateInventoryProductPricesBulkAction({items:changes.map(r=>({productId:r.id,sourcePriceAmount:Number(r.value),sourcePriceCurrency:r.currency}))});setMessage(result.updatedCount+' precios guardados.');setDraft(draft.map(r=>({...r,amount:Number(r.value)})));setConfirmed(false);router.refresh();}
   catch{setMessage('No se completó el bloque. Consulta de nuevo la lista antes de repetir: algunos precios pudieron guardarse.');}
   finally{busy.current=false;}
  });
 }
 return <div className="space-y-3"><fieldset disabled={pending} className="min-w-0 divide-y divide-[#292937]">{draft.map(r=><div key={r.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_75px_100px] items-center gap-2 py-2"><div className="min-w-0"><p className="truncate text-xs">{r.name}</p><p className="truncate text-[11px] text-[#9B9BA7]">{r.sku||'Sin SKU'}{!r.isActive?' · Inactivo':''}</p></div><select aria-label={'Moneda de '+r.name} value={r.currency} onChange={e=>{setConfirmed(false);setDraft(draft.map(x=>x.id===r.id?{...x,currency:e.target.value as 'USD'|'VES'}:x))}} className={input}><option value="USD">USD</option><option value="VES">Bs</option></select><label className="grid min-w-0 gap-1 text-[11px] text-[#B7B7C2]">Precio · {currencyLabel(r.currency)}<input aria-label={'Precio en '+currencyLabel(r.currency)+' de '+r.name} type="number" min="0" step="any" value={r.value} onChange={e=>{setConfirmed(false);setDraft(draft.map(x=>x.id===r.id?{...x,value:e.target.value}:x))}} className={input}/></label></div>)}</fieldset>
 <label className="flex min-h-11 items-center gap-2 text-xs text-[#BDBDC7]"><input type="checkbox" checked={confirmed} disabled={pending||!changes.length} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo {changes.length} cambios para precios futuros y la revisión de presupuestos afectados.</label><button type="button" onClick={save} disabled={pending||!confirmed||!changes.length} className="min-h-11 rounded-lg bg-[#FFFF00] px-3 text-xs font-semibold text-black disabled:opacity-50">{pending?'Guardando…':'Guardar precios seleccionados'}</button>{message?<p role="status" className="text-xs text-[#BDBDC7]">{message}</p>:null}
 </div>;
}
