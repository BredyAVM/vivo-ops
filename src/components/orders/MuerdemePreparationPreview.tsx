'use client';
import{useState}from'react';
import{previewMuerdemePreparation}from'@/lib/brands/inventory-menu-actions';
import type{MenuOrderQuote}from'@/lib/brands/order-menu';
export default function MuerdemePreparationPreview({quote}:{quote:MenuOrderQuote}){
 const[result,setResult]=useState<{signature:string;value:Awaited<ReturnType<typeof previewMuerdemePreparation>>}|null>(null);
 const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 const signature=JSON.stringify([quote.selection,quote.revisions]);const value=result?.signature===signature?result.value:null;
 return<div className="min-w-0 space-y-2 text-xs"><button type="button"disabled={busy}className="min-h-11 rounded-lg border border-[#393944] px-3 text-[#FFFF00] disabled:opacity-50 md:min-h-8"onClick={async()=>{
  setBusy(true);setError('');try{const value=await previewMuerdemePreparation(quote.selection,quote.revisions);setResult({signature,value});}
  catch(err){setError(err instanceof Error?err.message:'No se pudo consultar la preparación.');}finally{setBusy(false);}
 }}>{busy?'Consultando…':'Ver preparación e inventario'}</button>
 {result&&!value?<p className="text-amber-200">Cambió la configuración. Vuelve a consultar la preparación.</p>:null}
 {error?<p role="alert"className="text-red-300">{error}</p>:null}
 {value?<section className="min-w-0 space-y-2 rounded-lg border border-[#393944] p-2"aria-label="Preparación e inventario de Muérdeme">
   <details open><summary className="min-h-9 cursor-pointer content-center font-medium text-[#DEDEE6]">Para cocina</summary>
   <div className="space-y-2">{value.snapshot.kitchen.map((unit,index)=><div key={index}className="min-w-0 rounded border border-[#30303D] p-2">
    <p className="break-words text-[#DEDEE6]">{unit.quantity} × {unit.slot?unit.slot+': ':''}{unit.label}</p>
    {unit.removed.map((item,i)=><p key={i}className="text-amber-200">Sin {item}</p>)}{unit.extras.map((item,i)=><p key={i}className="text-[#DEDEE6]">Extra: {item}</p>)}
   </div>)}</div></details>
   <details><summary className="min-h-9 cursor-pointer content-center font-medium text-[#DEDEE6]">Consumo de inventario</summary>
    {value.snapshot.status==='pending'?<ul className="space-y-1 text-amber-200">{value.snapshot.issues.map(issue=><li key={issue}>{issue}</li>)}</ul>:
     !value.snapshot.lines.length?<p className="text-[#BDBDC7]">Esta configuración no genera movimientos de inventario según las reglas guardadas.</p>:
      <div className="divide-y divide-[#30303D]">{value.snapshot.lines.map(line=><div key={line.inventoryItemId}className="flex min-w-0 flex-wrap justify-between gap-1 py-2">
       <span className="break-words text-[#DEDEE6]">{line.name}</span><span className="text-[#BDBDC7]">Consume {line.quantity} {line.unitName} · Existencia {value.onHand.find(i=>i.inventoryItemId===line.inventoryItemId)?.currentStock??'—'}</span>
      </div>)}</div>}
    <p className="mt-2 text-[11px] text-[#BDBDC7]">Existencia física actual. Esta consulta no reserva ni descuenta; las reservas se calculan al aprobar la orden.</p>
   </details>
 </section>:null}
 </div>;
}
