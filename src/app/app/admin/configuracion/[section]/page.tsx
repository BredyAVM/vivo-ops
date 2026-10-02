import { notFound } from 'next/navigation';
import Link from '@/components/navigation/ContextLink';
import WorkspaceForm from '@/components/navigation/WorkspaceForm';
import { requireAdminContext } from '@/lib/auth';
import { loadConfiguration, CONFIG_SECTIONS, type ConfigSection } from '@/lib/admin-config/data';
import { AccountForm, AccountRulesForm, BaselineForm, RateForm, PartnerForm, TariffForm, ClientForm, UserForm, NewUserForm } from '@/components/admin/ConfigurationFields';
import { ConfigurationAvailability } from '@/components/admin/ConfigurationForm';
import { adminPanel, AdminReadError } from '../../_components/AdminReadUi';
export const dynamic='force-dynamic';
const titles={cuentas:'Configurar cuentas',tasa:'Tasa general',delivery:'Empresas y tarifas de delivery',usuarios:'Usuarios y permisos',clientes:'Clientes'};
const detail='rounded-lg border border-[#30303D] bg-[#111117] px-3';
const money=new Intl.NumberFormat('es-VE',{maximumFractionDigits:6});
export default async function ConfigurationPage({params,searchParams}:{params:Promise<{section:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  await requireAdminContext();
  const section=(await params).section as ConfigSection;
  if(!CONFIG_SECTIONS.includes(section))notFound();
  const raw=await searchParams;
  const query=Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,Array.isArray(value)?value[0]:value]));
  let data;
  try {data=await loadConfiguration(section,query);} catch {return <AdminReadError title={titles[section]} message="No se pudo consultar esta configuración. No se ha cambiado ningún registro."/>;}
  const root='/app/admin/configuracion/'+section;
  const href=(page:number)=>root+'?'+new URLSearchParams({consultar:'1',page:String(page),...(query.q?{q:query.q}:{}),...(query.id?{id:query.id}:{})});
  const selected=Number(query.id)||0;
  const row=selected?data.rows.find(r=>Number(r.id)===selected):undefined;
  return <ConfigurationAvailability available={data.atomicReady}><div className="space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold text-[#DEDEE6]">{titles[section]}</h1><Link href={section==='cuentas'?'/app/admin/finanzas/cuentas':section==='delivery'?'/app/admin/finanzas/delivery':'/app/admin/negocio'} prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00]">Ver {section==='cuentas'?'cuentas':section==='delivery'?'liquidaciones':'negocio'} →</Link></header>
    {(section==='cuentas'||section==='usuarios')&&!data.atomicReady?<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-orange-300/25 px-3 text-xs text-orange-200"><p>Consulta disponible. La edición segura está pendiente de activación.</p><Link href={'/app/master/dashboard?adminSection='+(section==='cuentas'?'accounts':'users')} prefetch={false} className="inline-flex min-h-11 items-center underline">Modificar en Administrador anterior →</Link></div>:null}
    <WorkspaceForm action={root} method="get" className="flex flex-wrap gap-2"><input type="hidden" name="consultar" value="1"/>
      {section==='clientes'?<label className="grid min-w-0 flex-1 gap-1 text-xs text-[#BDBDC7]">Nombre o teléfono<input name="q" defaultValue={query.q??''} minLength={2} maxLength={80} required className="min-h-11 rounded-lg border border-[#30303D] bg-[#14141C] px-3"/></label>:null}
      <button className="min-h-11 rounded-lg border border-[#FFFF00]/40 px-3 text-xs text-[#FFFF00]">{section==='tasa'?'Consultar historial':'Consultar registros'}</button>
      {selected?<Link href={root+'?consultar=1'} prefetch={false} className="inline-flex min-h-11 items-center px-3 text-xs underline">Volver al listado</Link>:null}
      {section==='clientes'?<Link href={root+'?nuevo=1'} prefetch={false} className="inline-flex min-h-11 items-center px-3 text-xs underline">Nuevo cliente</Link>:null}
    </WorkspaceForm>
    {section==='tasa'?<section className={adminPanel}><p className="mb-3 text-xs text-[#9B9BA7]">Actual: <span className="text-base tabular-nums text-[#FFFF00]">{data.current?money.format(Number(data.current.rate_bs_per_usd))+' Bs/USD':'Sin tasa activa'}</span></p><RateForm current={data.current}/></section>:null}
    {section==='cuentas'&&!selected?<Link href={root+'?nuevo=1'} prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00]">Nueva cuenta →</Link>:null}
    {section==='cuentas'&&query.nuevo==='1'?<section className={adminPanel}><AccountForm banks={data.auxiliary}/></section>:null}
    {section==='usuarios'?<details className={detail}><summary className="min-h-11 cursor-pointer content-center text-xs text-[#FFFF00]">Nuevo usuario</summary><div className="pb-3"><NewUserForm/></div></details>:null}
    {section==='delivery'&&!selected?<details className={detail}><summary className="min-h-11 cursor-pointer content-center text-xs text-[#FFFF00]">Nueva empresa / motorizado externo</summary><div className="pb-3"><PartnerForm/></div></details>:null}
    {section==='clientes'&&query.nuevo==='1'?<section className={adminPanel}><h2 className="mb-3 text-sm font-medium">Nuevo cliente</h2><ClientForm advisors={data.auxiliary}/></section>:null}
    {row&&section==='cuentas'?<div className="space-y-3"><section className={adminPanel}><h2 className="mb-3 text-sm font-medium">{String(row.name)}</h2><AccountForm row={row} banks={data.auxiliary} target={data.profile?.default_target_money_account_id}/></section>
      <details className={detail}><summary className="min-h-11 cursor-pointer content-center text-xs">Permisos por rol y método de pago</summary><div className="pb-3"><AccountRulesForm row={row} rules={data.rules}/></div></details>
      <details className={detail}><summary className="min-h-11 cursor-pointer content-center text-xs">Saldo inicial / línea base</summary><div className="pb-3">{data.baseline?<p className="text-xs text-[#9B9BA7]">Línea base activa del {String(data.baseline.baseline_date)} · {String(row.currency_code)} {money.format(Number(data.baseline.counted_amount))}. Para saldos actuales utiliza cierre o conciliación.</p>:<BaselineForm row={row}/>}</div></details>
    </div>:null}
    {row&&section==='delivery'?<div className="space-y-3"><section className={adminPanel}><PartnerForm row={row}/></section><details className={detail}><summary className="min-h-11 cursor-pointer content-center text-xs text-[#FFFF00]">Nueva tarifa por distancia</summary><div className="pb-3"><TariffForm partner={Number(row.id)}/></div></details>{data.rules.map(rate=><details key={String(rate.id)} className={detail}><summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-xs"><span>{String(rate.km_from)} — {rate.km_to==null?'sin límite':String(rate.km_to)} km</span><span>USD {money.format(Number(rate.price_usd))} · {rate.is_active?'Activa':'Inactiva'}</span></summary><div className="pb-3"><TariffForm partner={Number(row.id)} row={rate}/></div></details>)}</div>:null}
    {row&&section==='clientes'?<nav className="flex flex-wrap gap-3 text-xs"><Link href={'/app/admin/clientes/'+String(row.id)} prefetch={false} className="inline-flex min-h-11 items-center text-[#FFFF00]">Ficha comercial / órdenes →</Link></nav>:null}
    {row&&section==='clientes'?<section className={adminPanel}><ClientForm row={row} advisors={data.auxiliary}/></section>:null}
    {selected&&section==='delivery'&&(data.hasNext||data.page>1)?<nav className="flex items-center justify-between gap-2 text-xs">{data.page>1?<Link href={href(data.page-1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Tarifas anteriores</Link>:<span/>}<span>Página {data.page}</span>{data.hasNext?<Link href={href(data.page+1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Más tarifas</Link>:<span/>}</nav>:null}
    {data.queried&&!selected?<section className={adminPanel}>
      {!data.rows.length?<p className="text-xs text-[#9B9BA7]">No hay registros con esta consulta.</p>:null}
      <div className="divide-y divide-[#292937]">{data.rows.map(r=>{
        if(section==='tasa')return <article key={String(r.id)} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"><div><p>{new Intl.DateTimeFormat('es-VE',{dateStyle:'short',timeStyle:'short',timeZone:'America/Caracas'}).format(new Date(String(r.effective_at)))}</p><p className="text-[11px] text-[#9B9BA7]">{String(r.change_reason??'Registro histórico')} · {String(data.auxiliary.find(a=>a.id===r.created_by)?.full_name??'Usuario no registrado')}</p></div><p className="tabular-nums">{r.previous_rate_bs_per_usd==null?'—':money.format(Number(r.previous_rate_bs_per_usd))} → <span className="text-[#FFFF00]">{money.format(Number(r.rate_bs_per_usd))}</span></p></article>;
        if(section==='usuarios')return <details key={String(r.id)} className="py-1"><summary className="min-h-11 cursor-pointer content-center text-xs">{String(r.full_name??'Sin nombre')} · {r.is_active===false?'Inactivo':'Activo'}</summary><div className="pb-3"><UserForm row={r} roles={data.auxiliary.filter(a=>a.user_id===r.id).map(a=>String(a.role))}/></div></details>;
        return <Link key={String(r.id)} href={root+'?id='+String(r.id)} prefetch={false} className="flex min-h-11 items-center justify-between gap-2 py-2 text-xs"><span className="min-w-0"><span className="block truncate font-medium">{String(r.name??r.full_name??'Sin nombre')}</span><span className="text-[11px] text-[#9B9BA7]">{String(r.currency_code??r.phone??r.whatsapp_phone??'')}{r.is_active===false?' · Inactivo':''}</span></span><span className="shrink-0 text-[#FFFF00]">Editar →</span></Link>;
      })}</div>
      {data.hasNext||data.page>1?<nav className="mt-3 flex items-center justify-between gap-2 text-xs">{data.page>1?<Link href={href(data.page-1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Anterior</Link>:<span/>}<span>Página {data.page}</span>{data.hasNext?<Link href={href(data.page+1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Siguiente</Link>:<span/>}</nav>:null}
      {section==='clientes'&&data.rows.length===20?<p className="mt-2 text-xs text-[#9B9BA7]">Primeros 20 resultados. Refina nombre o teléfono para encontrar al cliente.</p>:null}
    </section>:null}
    {selected&&!row?<p role="alert" className="text-xs text-orange-200">No se encontró el registro solicitado.</p>:null}
    {!data.queried&&section!=='tasa'&&query.nuevo!=='1'?<p className="text-xs text-[#9B9BA7]">Consulta cuando necesites ver o editar. No se cargan historiales al entrar.</p>:null}
  </div></ConfigurationAvailability>;
}
