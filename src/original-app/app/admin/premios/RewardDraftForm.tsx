'use client';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveRewardDraftAction, cancelRewardDraftAction } from './actions';
import { REWARD_CATEGORIES, REWARD_MODES, REWARD_PURPOSES, allowedPurposes, validateRewardDraft, type RewardDraft, type RewardDraftInput, type RewardMode, type RewardProduct } from '@/lib/rewards/wallet-model';
const field='mt-1 min-h-10 w-full rounded-lg border border-[#303040] bg-[#0B0B10] px-3 py-2 text-sm text-white';
export default function RewardDraftForm({advisors,products,draft,period}:{advisors:{id:string;fullName:string}[];products:RewardProduct[];draft?:RewardDraft;period:string}) {
  const router=useRouter();
  const [pending,startTransition]=useTransition(); const [message,setMessage]=useState(''); const [search,setSearch]=useState('');
  const token=useRef<string|null>(null);
  const [input,setInput]=useState<RewardDraftInput>(()=>draft?{
    advisorId:draft.advisor_id,title:draft.title,category:draft.category,period:draft.period.slice(0,7),kind:draft.kind,mode:draft.mode,purposes:draft.purposes,amount:Number(draft.amount),productId:draft.product_id,productScope:draft.product_scope,allowedProductIds:draft.allowed_product_ids,expiresOn:draft.expires_on,note:draft.note,
  }:{advisorId:'',title:'',category:'alchemist',period,kind:'credit',mode:'commercial',purposes:['customer_gift'],amount:0,productId:null,productScope:'selected_products',allowedProductIds:[],expiresOn:null,note:''});
  function set<K extends keyof RewardDraftInput>(key:K,value:RewardDraftInput[K]){setInput(c=>({...c,[key]:value}));}
  const selectedNames=input.allowedProductIds.map(id=>products.find(p=>p.id===id)?.name??'Producto '+id);
  return <form className="space-y-3 rounded-xl border border-[#292937] bg-[#111117] p-4" onSubmit={e=>{
    e.preventDefault();const error=validateRewardDraft(input);if(error){setMessage(error);return;}
    token.current??=crypto.randomUUID();const key=token.current;
    startTransition(async()=>{const result=await saveRewardDraftAction(input,key,draft?.id,draft?.version);setMessage(result.message);if(result.ok&&result.draftId)router.replace('/app/admin/premios?month='+input.period+'&edit='+result.draftId);});
  }}>
    <h2 className="font-semibold">{draft?'Editar diseño':'Diseñar un premio'}</h2>
    <fieldset disabled={pending} className="space-y-3 disabled:opacity-60"><div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs">Asesor<select required disabled={Boolean(draft)} className={field} value={input.advisorId} onChange={e=>set('advisorId',e.target.value)}><option value="">Seleccionar</option>{advisors.map(a=><option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label>
      <label className="text-xs">Reconocimiento<select className={field} value={input.category} onChange={e=>set('category',e.target.value as RewardDraftInput['category'])}>{Object.entries(REWARD_CATEGORIES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label className="text-xs">Nombre<input required maxLength={100} className={field} value={input.title} onChange={e=>set('title',e.target.value)} placeholder="Ej.: Crédito para deliveries"/></label>
      <label className="text-xs">Mes<input required type="month" className={field} value={input.period} onChange={e=>set('period',e.target.value)}/></label>
      <label className="text-xs">Qué recibe<select className={field} value={input.kind} onChange={e=>{const kind=e.target.value as RewardDraftInput['kind'];setInput(c=>({...c,kind,amount:0,productId:null,productScope:'selected_products',allowedProductIds:[],purposes:c.purposes.filter(p=>kind==='credit'||p!=='advisor_debt')}));}}><option value="credit">Crédito USD</option><option value="product_units">Unidades de producto</option></select></label>
      <label className="text-xs">Modalidad<select className={field} value={input.mode} onChange={e=>{const mode=e.target.value as RewardMode;setInput(c=>({...c,mode,purposes:allowedPurposes(mode).filter(p=>c.kind==='credit'||p!=='advisor_debt')}));}}>{Object.entries(REWARD_MODES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label className="text-xs">{input.kind==='credit'?'Monto USD':'Unidades'}<input required type="number" min={input.kind==='credit'?'0.01':'1'} max="100000" step={input.kind==='credit'?'0.01':'1'} className={field} value={input.amount||''} onChange={e=>set('amount',Number(e.target.value))}/></label>
      <label className="text-xs">Último día · opcional<input type="date" min={input.period+'-01'} className={field} value={input.expiresOn||''} onChange={e=>set('expiresOn',e.target.value||null)}/></label>
    </div>
    <fieldset className="rounded-lg border border-[#292937] p-3"><legend className="text-xs">Usos permitidos</legend><div className="flex flex-wrap gap-3">{allowedPurposes(input.mode).filter(p=>input.kind==='credit'||p!=='advisor_debt').map(p=><label key={p} className="flex min-h-9 items-center gap-2 text-xs"><input type="checkbox" checked={input.purposes.includes(p)} onChange={e=>set('purposes',e.target.checked?[...input.purposes,p]:input.purposes.filter(v=>v!==p))}/>{REWARD_PURPOSES[p]}</label>)}</div></fieldset>
    {input.kind==='product_units'?<label className="block text-xs">Producto<select required className={field} value={input.productId??''} onChange={e=>{const id=Number(e.target.value);setInput(c=>({...c,productId:id||null,productScope:'selected_products',allowedProductIds:id?[id]:[]}));}}><option value="">Seleccionar producto</option>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>:<div className="space-y-2">
      <label className="block text-xs">Productos permitidos<select className={field} value={input.productScope} onChange={e=>setInput(c=>({...c,productScope:e.target.value as RewardDraftInput['productScope'],allowedProductIds:[]}))}><option value="selected_products">Solo productos seleccionados</option><option value="all_products">Todo el catálogo</option></select></label>
      {input.productScope==='selected_products'?<details className="rounded-lg border border-[#292937] p-3"><summary className="cursor-pointer text-xs">Seleccionar productos · {input.allowedProductIds.length}/50</summary><label className="mt-2 block text-xs">Buscar<input className={field} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Delivery o Single Pack"/></label><div className="mt-2 max-h-48 overflow-y-auto">{products.filter(p=>p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(p=><label key={p.id} className="flex min-h-9 items-center gap-2 text-xs"><input type="checkbox" checked={input.allowedProductIds.includes(p.id)} disabled={!input.allowedProductIds.includes(p.id)&&input.allowedProductIds.length>=50} onChange={e=>set('allowedProductIds',e.target.checked?[...input.allowedProductIds,p.id]:input.allowedProductIds.filter(id=>id!==p.id))}/>{p.name}</label>)}</div></details>:null}
    </div>}
    <label className="block text-xs">Nota interna<textarea rows={2} maxLength={500} className={field} value={input.note} onChange={e=>set('note',e.target.value)}/></label>
    <div className="rounded-lg border border-emerald-400/20 p-3 text-xs leading-5"><strong>Vista previa: {input.kind==='credit'?'USD '+input.amount:input.amount+' unidades'}</strong><p>{input.purposes.map(p=>REWARD_PURPOSES[p]).join(' · ')}</p><p>{input.productScope==='all_products'?'Todo el catálogo':selectedNames.join(', ')||'Selecciona productos'}</p><p>{input.expiresOn?'Hasta '+input.expiresOn:'Sin vencimiento definido'} · Sin efectivo ni transferencias.</p><p className="text-amber-200">Borrador: no es saldo disponible y todavía no se comparte.</p></div>
    <button className="min-h-10 rounded-lg bg-[#FFFF00] px-4 text-sm font-semibold text-black">{pending?'Guardando…':'Guardar diseño'}</button></fieldset>
    {message?<p role="status" aria-live="polite" className="text-sm text-amber-200">{message}</p>:null}
  </form>;
}
export function CancelRewardDraft({draft}:{draft:RewardDraft}) {
  const [pending,startTransition]=useTransition();const [reason,setReason]=useState('');const [message,setMessage]=useState('');
  return <details className="mt-2 text-xs"><summary className="cursor-pointer">Cancelar diseño</summary><form className="mt-2 space-y-2" onSubmit={e=>{e.preventDefault();startTransition(async()=>{const result=await cancelRewardDraftAction(draft.id,draft.version,reason);setMessage(result.message);});}}><label>Motivo<input required minLength={10} maxLength={500} disabled={pending} className={field} value={reason} onChange={e=>setReason(e.target.value)}/></label><button disabled={pending} className="min-h-10 rounded-lg border border-red-400/30 px-3 text-red-200">{pending?'Cancelando…':'Confirmar cancelación'}</button>{message?<p role="status">{message}</p>:null}</form></details>;
}
