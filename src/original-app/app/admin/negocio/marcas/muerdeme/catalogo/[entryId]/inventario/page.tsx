import{notFound}from'next/navigation';
import Link from'@/components/navigation/ContextLink';
import WorkspaceForm from'@/components/navigation/WorkspaceForm';
import MuerdemeInventoryEditor from'@/components/admin/MuerdemeInventoryEditor';
import{loadMuerdemeStockEditor}from'@/lib/brands/inventory-menu-actions';
import{menuRoot}from'@/lib/brands/menu-model';
import{safeAppReturnHref}from'@/lib/navigation/return-navigation';
export default async function MuerdemeInventoryPage({params,searchParams}:{params:Promise<{entryId:string}>;searchParams:Promise<Record<string,string|undefined>>}){
 const{id}= {id:(await params).entryId};const query=await searchParams;let data;
 try{data=await loadMuerdemeStockEditor(id,query.presentacion||null,query.q??'');}catch{return<p role="alert"className="text-xs text-orange-200">No se pudo consultar la preparación. Vuelve a abrir el producto.</p>;}
 if(!data)notFound();const root=`${menuRoot}/${id}/inventario`;
 return<div className="min-w-0 space-y-3"><header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-base font-semibold text-[#DEDEE6]">{data.menu.name} · Preparación e inventario</h1>
  {!safeAppReturnHref(query.returnTo)?<Link href={`${menuRoot}/${id}`}prefetch={false}className="min-h-11 content-center text-xs text-[#FFFF00]">Volver al producto</Link>:null}</header>
  <WorkspaceForm method="get"action={root}className="flex min-w-0 flex-wrap items-end gap-2 text-xs"><input type="hidden"name="returnTo"value={`${menuRoot}/${id}`}/>
   <label className="grid min-w-0 gap-1 text-[#BDBDC7]">Presentación<select name="presentacion"defaultValue={data.variantKey}className="min-h-11 min-w-0 rounded-lg border border-[#343442] bg-[#14141C] px-2 md:min-h-8">
    {data.menu.variants.map(v=><option key={v.key}value={v.key}>{v.label}</option>)}</select></label>
   <label className="grid min-w-0 flex-1 gap-1 text-[#BDBDC7]">Buscar insumo<input name="q"defaultValue={query.q??''}maxLength={100}className="min-h-11 min-w-0 rounded-lg border border-[#343442] bg-[#14141C] px-2 md:min-h-8"/></label>
   <button className="min-h-11 rounded-lg border border-[#FFFF00]/40 px-3 text-[#FFFF00] md:min-h-8">Consultar</button></WorkspaceForm>
  {data.hasMore?<p className="text-xs text-amber-200">Se muestran hasta 200 insumos. Guarda antes de filtrar la búsqueda.</p>:null}
  {query.guardado==='1'?<p role="status"className="text-xs text-emerald-200">Consumo guardado para pedidos nuevos. No se movió inventario.</p>:null}
  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#BDBDC7]"><span>{data.recipe?`Versión de consumo ${data.recipe.revision}`:'Consumo pendiente de configurar'}</span>
   <Link href="/app/admin/inventario/configure"prefetch={false}className="min-h-11 content-center text-xs text-[#FFFF00]">Administrar inventario</Link></div>
  <MuerdemeInventoryEditor key={`${id}:${data.variantKey}:${data.menuRevision}:${data.recipe?.revision??0}`}data={data}/>
 </div>;
}
