import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { REWARD_CATEGORIES, REWARD_MODES, REWARD_DRAFT_SELECT, rewardAmountLabel, rewardRestrictions, type RewardDraft } from '@/lib/rewards/wallet-model';
import RewardDraftForm, { CancelRewardDraft } from './RewardDraftForm';
export default async function AdminRewardsPage({searchParams}:{searchParams?:Promise<{month?:string;edit?:string}>}) {
  const ctx=await requireAdminContext();const params=await searchParams??{};
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit'}).formatToParts(new Date());
  const today=parts.find(p=>p.type==='year')?.value+'-'+parts.find(p=>p.type==='month')?.value;
  const period=/^\d{4}-(0[1-9]|1[0-2])$/.test(params.month??'')?params.month!:today;
  const [dr,pr,rr,cr]=await Promise.all([
    ctx.supabase.from('advisor_reward_drafts').select(REWARD_DRAFT_SELECT).eq('period',period+'-01').order('updated_at',{ascending:false}).order('id',{ascending:false}).limit(101),
    ctx.supabase.from('profiles').select('id,full_name').eq('is_active',true).order('full_name').limit(201),
    ctx.supabase.rpc('admin_list_user_roles'),
    ctx.supabase.from('products').select('id,name',{count:'exact'}).eq('is_active',true).order('name').limit(1000),
  ]);
  if(dr.error||pr.error||rr.error||cr.error){console.error('Reward configuration unavailable',dr.error?.code,pr.error?.code,rr.error?.code,cr.error?.code);return <section><h1>Premios y monederos</h1><p>La configuración no está disponible. Revisa la instalación de este bloque. No se emitió ningún premio.</p></section>;}
  if(pr.data.length>200||rr.data.length>200||(cr.count??0)>1000)return <p role="alert">Es necesario paginar el catálogo antes de configurar premios.</p>;
  const roles=rr.data as {user_id:string;role:string}[];
  const ids=new Set(roles.filter(r=>r.role==='advisor').map(r=>r.user_id));const advisors=pr.data.filter(p=>ids.has(p.id)).map(p=>({id:p.id,fullName:p.full_name}));
  const products=cr.data.map(p=>({id:Number(p.id),name:p.name}));const drafts=dr.data as RewardDraft[];
  const editId=Number(params.edit);let edit=drafts.find(d=>d.id===editId&&d.status==='draft');
  if(!edit&&Number.isSafeInteger(editId)&&editId>0){const found=await ctx.supabase.from('advisor_reward_drafts').select(REWARD_DRAFT_SELECT).eq('id',editId).eq('status','draft').maybeSingle();if(found.error)throw new Error('No se pudo cargar el diseño.');edit=found.data?found.data as RewardDraft:undefined;}
  return <div className="space-y-4"><header><h1 className="text-lg font-semibold">Premios y monederos</h1><p className="mt-1 text-xs text-[#AAB2C5]">Crédito o unidades por asesor, con usos y vigencia.</p></header>
    <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">Primer bloque · solo diseños. No publica ganadores, no abona saldos y no modifica órdenes, deudas ni comisiones. La emisión y el uso en pedidos se habilitarán al completar el circuito financiero.</p>
    <form className="flex flex-wrap items-end gap-2"><label className="text-xs">Mes<input name="month" type="month" defaultValue={period} className="ml-2 min-h-10 rounded-lg border border-[#303040] bg-[#0B0B10] px-3"/></label><button className="min-h-10 rounded-lg border border-[#303040] px-3 text-xs">Consultar</button><Link href={'/app/admin/premios?month='+period} className="inline-flex min-h-10 items-center px-3 text-xs text-yellow-200">Nuevo diseño</Link></form>
    {editId>0&&!edit?<p role="alert">El diseño solicitado no está disponible para editar.</p>:null}
    <RewardDraftForm key={edit?edit.id+':'+edit.version:'new:'+period} advisors={advisors} products={products} draft={edit} period={period}/>
    <section className="space-y-2"><h2 className="text-sm font-semibold">Diseños del mes</h2>{drafts.length===0?<p className="text-xs text-[#AAB2C5]">Todavía no hay diseños. No se otorgaron premios automáticamente.</p>:null}
    {drafts.slice(0,100).map(d=>{const r=rewardRestrictions(d);return <details key={d.id+':'+d.version} className="rounded-lg border border-[#292937] bg-[#111117] p-3"><summary className="cursor-pointer text-sm">{advisors.find(a=>a.id===d.advisor_id)?.fullName||'Asesor'} · {d.title}<span className="ml-2 text-xs text-amber-200">{d.status==='draft'?'Borrador':'Cancelado'} · {rewardAmountLabel(d)}</span></summary><div className="mt-2 space-y-1 text-xs text-[#AAB2C5]"><p>{REWARD_CATEGORIES[d.category]} · {REWARD_MODES[d.mode]}</p><p>{r.uses}</p><p>{r.products}</p><p>{d.expires_on?'Último día: '+d.expires_on:'Sin vencimiento definido'} · Sin efectivo ni transferencias.</p>{d.note?<p>{d.note}</p>:null}<p>Versión {d.version} · No emitido.</p>{d.status==='draft'?<><Link className="inline-flex min-h-10 items-center text-yellow-200" href={'/app/admin/premios?month='+d.period.slice(0,7)+'&edit='+d.id}>Editar diseño</Link><CancelRewardDraft draft={d}/></>:null}</div></details>;})}
    {drafts.length>100?<p className="text-xs text-amber-200">Se muestran los 100 diseños más recientes del mes.</p>:null}</section></div>;
}
