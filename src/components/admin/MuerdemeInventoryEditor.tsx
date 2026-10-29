'use client';
import {useActionState,useRef,useState}from'react';
import {parseDecimalInput}from'@/lib/number-input';
import {parseMenuStockRecipe,type MenuStockRecipe}from'@/lib/brands/inventory-menu';
import {saveMuerdemeStockRecipe,type MenuStockEditorData}from'@/lib/brands/inventory-menu-actions';
const field='min-h-11 min-w-0 w-full rounded-lg border border-[#343442] bg-[#14141C] px-2 text-xs text-[#E4E4EA] md:min-h-8';
const button='min-h-11 rounded-lg border border-[#343442] px-3 text-xs text-[#DEDEE6] md:min-h-8';
export default function MuerdemeInventoryEditor({data}:{data:MenuStockEditorData}){
 const [document,setDocument]=useState<MenuStockRecipe>(()=>data.recipe?.document??{schemaVersion:1,mode:data.menu.kind==='combo'?'components':'tracked',note:'',lines:[]});
 const [amounts,setAmounts]=useState<Record<number,string>>({});
 const attempt=useRef<{signature:string;id:string}|null>(null);
 const variant=data.menu.variants.find(v=>v.key===data.variantKey)!;
 const [state,action,pending]=useActionState(async(previous:{error:string},form:FormData)=>{
  try{
   const next={...document,lines:document.mode==='tracked'?document.lines.map((line,i)=>({...line,quantity:parseDecimalInput(amounts[i]??line.quantity,Number.NaN)})):[]};
   parseMenuStockRecipe(next,data.menu.kind,variant);const raw=JSON.stringify(next);const signature=JSON.stringify([data.entryId,data.variantKey,data.menuRevision,data.recipe?.revision??0,raw]);
   if(attempt.current?.signature!==signature)attempt.current={signature,id:crypto.randomUUID()};
   form.set('entryId',data.entryId);form.set('variantKey',data.variantKey);form.set('menuRevision',String(data.menuRevision));form.set('revision',String(data.recipe?.revision??0));
   form.set('document',raw);form.set('operationId',attempt.current.id);return saveMuerdemeStockRecipe(previous,form);
  }catch(error){return{error:error instanceof Error?error.message:'Revisa la receta.'};}
 },{error:''});
 return<form action={action}noValidate className="min-w-0 space-y-3 text-xs"aria-busy={pending}><fieldset disabled={pending}className="min-w-0 space-y-3">
  {data.recipe&&!data.recipe.signatureMatches?<p role="alert"className="text-amber-200">Cambió la presentación o sus ingredientes. Revisa este consumo antes de confirmarlo para pedidos nuevos.</p>:null}
  <label className="grid gap-1 text-[#BDBDC7]">Consumo de esta presentación<select className={field}value={document.mode}onChange={e=>setDocument(d=>({...d,mode:e.target.value as MenuStockRecipe['mode']}))}>
   <option value="tracked">Descontar insumos del inventario</option>{data.menu.kind==='combo'?<option value="components">Consumir desde hamburguesas y acompañamientos</option>:null}
   <option value="untracked">Sin movimiento de inventario</option></select></label>
  {document.mode==='components'?<p className="text-[#BDBDC7]">Cada hamburguesa, papa y bebida aporta su consumo. Configura aquí solo un empaque adicional si lo necesita.</p>:null}
  {document.mode==='tracked'?<section className="min-w-0 space-y-2"aria-label="Insumos por presentación">
   <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium text-[#DEDEE6]">Consumo por una presentación</h2>
    <button type="button"className={button}disabled={document.lines.length>=80}onClick={()=>setDocument(d=>({...d,lines:[...d.lines,{inventoryItemId:0,quantity:1,ingredientKey:null}]}))}>+ Insumo</button></div>
   {document.lines.map((line,index)=>{const stock=data.items.find(i=>i.id===line.inventoryItemId);return<div key={index}className="grid min-w-0 gap-2 rounded-lg border border-[#30303D] p-2 sm:grid-cols-[minmax(0,1.5fr)_100px_minmax(0,1fr)_auto]">
    <label className="grid min-w-0 gap-1 text-[#BDBDC7]">Insumo<select className={field}value={line.inventoryItemId||''}onChange={e=>setDocument(d=>({...d,lines:d.lines.map((l,i)=>i===index?{...l,inventoryItemId:Number(e.target.value)}:l)}))}>
      <option value="">Seleccionar…</option>{data.items.map(i=><option key={i.id}value={i.id}disabled={!i.eligible}>{i.name} · {i.unitName}{!i.eligible?' · no habilitado':''}</option>)}</select></label>
    <label className="grid gap-1 text-[#BDBDC7]">Cantidad · {stock?.unitName??'unidad del insumo'}<input className={field}inputMode="decimal"value={amounts[index]??String(line.quantity).replace('.',',')}onFocus={e=>e.currentTarget.select()}onChange={e=>setAmounts(a=>({...a,[index]:e.target.value}))}/></label>
    <label className="grid min-w-0 gap-1 text-[#BDBDC7]">Cuándo se consume<select className={field}value={line.ingredientKey??''}onChange={e=>setDocument(d=>({...d,lines:d.lines.map((l,i)=>i===index?{...l,ingredientKey:e.target.value||null}:l)}))}>
      <option value="">Siempre incluido</option>{variant.burger?.ingredients.map(i=><option key={i.key}value={i.key}>Si lleva {i.label}</option>)}
      {line.ingredientKey&&!variant.burger?.ingredients.some(i=>i.key===line.ingredientKey)?<option value={line.ingredientKey}>Ingrediente retirado del menú · revisar</option>:null}</select></label>
    <button type="button"className={`${button} self-end`}onClick={()=>{setDocument(d=>({...d,lines:d.lines.filter((_,i)=>i!==index)}));setAmounts(a=>Object.fromEntries(Object.entries(a).filter(([k])=>Number(k)!==index).map(([k,v])=>[Number(k)>index?Number(k)-1:Number(k),v])));}}>Quitar</button>
   </div>;})}
   {!document.lines.length?<p className="text-[#BDBDC7]">Añade las cantidades reales. No se inferirán desde el precio ni desde el nombre.</p>:null}
   {!data.items.length?<p className="text-amber-200">No hay insumos habilitados para consumo por venta. Créelos o configúrelos en Inventario antes de vincularlos.</p>:null}
  </section>:null}
  <label className="grid gap-1 text-[#BDBDC7]">{document.mode==='untracked'?'Motivo para no mover inventario':'Nota de configuración (opcional)'}<input className={field}maxLength={300}value={document.note}onChange={e=>setDocument(d=>({...d,note:e.target.value}))}/></label>
  <p className="text-[11px] text-[#BDBDC7]">Solo guarda cantidades. Los precios, saldos y recetas de VIVO mantienen sus reglas. Los pedidos anteriores conservan su consumo certificado.</p>
  {state.error?<p role="alert"className="text-red-300">{state.error}</p>:null}
  <button className={`${button} border-[#FFFF00] bg-[#FFFF00] font-medium !text-black`}>{pending?'Guardando…':'Guardar consumo'}</button>
 </fieldset></form>;
}
