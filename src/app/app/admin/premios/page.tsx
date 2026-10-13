import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { REWARD_CATEGORIES, REWARD_MODES, REWARD_DRAFT_SELECT, REWARD_GRANT_SELECT, rewardAmountLabel, rewardRestrictions, type RewardDraft, type RewardGrant } from '@/lib/rewards/wallet-model';
import RewardDraftForm, { CancelRewardDraft } from './RewardDraftForm';
import RewardIssueControls from './RewardIssueControls';
import RewardGrantCard from '@/components/rewards/RewardGrantCard';

export default async function AdminRewardsPage({ searchParams }: { searchParams?: Promise<{ month?: string; edit?: string }> }) {
  const ctx = await requireAdminContext();
  const params = await searchParams ?? {};
  const asOf = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).formatToParts(asOf);
  const today = parts.find(p => p.type === 'year')?.value + '-' + parts.find(p => p.type === 'month')?.value;
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month ?? '') ? params.month! : today;
  const [dr, pr, rr, cr, gr] = await Promise.all([
    ctx.supabase.from('advisor_reward_drafts').select(REWARD_DRAFT_SELECT).eq('period', period + '-01').order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(101),
    ctx.supabase.from('profiles').select('id,full_name').eq('is_active', true).order('full_name').limit(201),
    ctx.supabase.rpc('admin_list_user_roles'),
    ctx.supabase.from('products').select('id,name', { count: 'exact' }).eq('is_active', true).order('name').limit(1000),
    ctx.supabase.from('advisor_reward_grants').select(REWARD_GRANT_SELECT).eq('period', period + '-01').order('id', { ascending: false }).limit(101),
  ]);
  if (dr.error || pr.error || rr.error || cr.error || gr.error) {
    console.error('Reward configuration unavailable', dr.error?.code, pr.error?.code, rr.error?.code, cr.error?.code, gr.error?.code);
    return <section><h1>Premios y monederos</h1><p role="alert">No se pudo consultar la configuración. Actualiza o revisa la instalación. Esta consulta no emite ni revoca premios.</p></section>;
  }
  if (pr.data.length > 200 || !Array.isArray(rr.data) || rr.data.length > 200 || (cr.count ?? 0) > 1000) return <p role="alert">Es necesario paginar el catálogo antes de configurar premios.</p>;
  const roles = rr.data as { user_id: string; role: string }[];
  const ids = new Set(roles.filter(r=>r.role==='advisor').map(r => r.user_id));
  const advisors = pr.data.filter(p => ids.has(p.id)).map(p => ({ id: p.id, fullName: p.full_name }));
  const products = cr.data.map(p => ({ id: Number(p.id), name: p.name }));
  const drafts = dr.data as RewardDraft[];
  const grants = gr.data as RewardGrant[];
  const editId = Number(params.edit);
  let edit = drafts.find(d => d.id === editId && d.status === 'draft');
  if (!edit && Number.isSafeInteger(editId) && editId > 0) {
    const found = await ctx.supabase.from('advisor_reward_drafts').select(REWARD_DRAFT_SELECT).eq('id', editId).eq('status', 'draft').maybeSingle();
    if (found.error) throw new Error('No se pudo cargar el diseño.');
    edit = found.data ? found.data as RewardDraft : undefined;
  }
  return <div className="space-y-4">
    <header><h1 className="text-lg font-semibold">Premios y monederos</h1><p className="mt-1 text-xs text-[#AAB2C5]">Diseña, revisa y otorga crédito o productos a cada asesor.</p></header>
    <Link prefetch={false} href={'/app/admin/evaluacion?month=' + period} className="inline-flex min-h-10 items-center text-sm text-yellow-200">Ver evaluación de asesores: indicadores y ranking →</Link>
    <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">Puedes emitir premios manualmente en el monedero. Esto no publica ganadores calculados ni cambia deudas, órdenes o comisiones. El uso en pedidos sigue en preparación.</p>
    <form className="flex flex-wrap items-end gap-2"><label className="text-xs">Mes<input name="month" type="month" defaultValue={period} className="ml-2 min-h-10 rounded-lg border border-[#303040] bg-[#0B0B10] px-3" /></label><button className="min-h-10 rounded-lg border border-[#303040] px-3 text-xs">Consultar</button><Link href={'/app/admin/premios?month=' + period} className="inline-flex min-h-10 items-center px-3 text-xs text-yellow-200">Nuevo diseño</Link></form>
    {editId > 0 && !edit ? <p role="alert">El diseño solicitado ya no está disponible para editar.</p> : null}
    <RewardDraftForm key={edit ? edit.id + ':' + edit.version : 'new:' + period} advisors={advisors} products={products} draft={edit} period={period} />
    <section className="space-y-2"><h2 className="text-sm font-semibold">Diseños del mes</h2>
      {drafts.length === 0 ? <p className="text-xs text-[#AAB2C5]">Todavía no hay diseños.</p> : null}
      {drafts.slice(0,100).map(d => {
        const r = rewardRestrictions(d);
        const statusLabel = d.status === 'draft' ? 'Borrador' : d.status === 'issued' ? 'Emitido' : 'Cancelado';
        return <details key={d.id + ':' + d.version} className="rounded-lg border border-[#292937] bg-[#111117] p-3">
          <summary className="cursor-pointer text-sm">{advisors.find(a => a.id === d.advisor_id)?.fullName || grants.find(g => g.advisor_id === d.advisor_id)?.advisor_name_snapshot || 'Asesor'} · {d.title}<span className="ml-2 text-xs text-amber-200">{statusLabel} · {rewardAmountLabel(d)}</span></summary>
          <div className="mt-2 space-y-2 text-xs text-[#AAB2C5]"><p>{REWARD_CATEGORIES[d.category]} · {REWARD_MODES[d.mode]}</p><p>{r.uses}</p><p>{r.products}</p><p>{d.expires_on ? 'Último día: ' + d.expires_on : 'Sin vencimiento definido'} · Sin efectivo ni transferencias.</p>{d.note ? <p>Nota interna: {d.note}</p> : null}<p>Versión {d.version} · {statusLabel}.</p>
            {d.status === 'draft' ? <>
              <Link className="inline-flex min-h-10 items-center text-yellow-200" href={'/app/admin/premios?month=' + d.period.slice(0,7) + '&edit=' + d.id}>Editar diseño</Link>
              <RewardIssueControls id={d.id} version={d.version} mode="issue" />
              <CancelRewardDraft draft={d} />
            </> : null}
          </div>
        </details>;
      })}
      {drafts.length > 100 ? <p className="text-xs text-amber-200">Se muestran los 100 diseños más recientes del mes.</p> : null}
    </section>
    <section className="space-y-2"><h2 className="text-sm font-semibold">Premios emitidos · mes del reconocimiento</h2>
      {grants.length === 0 ? <p className="text-xs text-[#AAB2C5]">No hay premios emitidos para este mes. Los borradores no cuentan como saldo.</p> : null}
      {grants.slice(0,100).map(grant => <div key={grant.id}><p className="mb-1 text-xs text-[#AAB2C5]">{grant.advisor_name_snapshot}</p><RewardGrantCard grant={grant} asOf={asOf} action={grant.status === 'active' ? <RewardIssueControls id={grant.id} mode="revoke" /> : undefined} /></div>)}
      {grants.length > 100 ? <p className="text-xs text-amber-200">Se muestran los 100 premios más recientes del mes.</p> : null}
    </section>
  </div>;
}
