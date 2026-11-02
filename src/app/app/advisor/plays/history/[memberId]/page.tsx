import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { sanitizeAdvisorReturnTo } from '@/lib/advisor-navigation';
import { EmptyBlock, SectionCard, StatusBadge } from '../../../advisor-ui';
import { ADVISOR_PUBLISHED_PLAY_STATUSES, advisorPlayMonth, advisorPlaysHref, readAdvisorPlayPages } from '@/lib/crm/advisor-play-history';
import { workflowPresentation } from '@/lib/crm/play-member-presentation';
import { playValidityLabel } from '@/lib/crm/play-conditions';
import PlayConditionsCard from '../../PlayConditionsCard';

type Play = {
  id: number; name: string; status: string; starts_at: string | null; ends_at: string | null;
  description: string | null; advisor_guidance: string | null; message_template: string | null;
  benefit_selection_mode: 'single' | 'multiple'; purchase_requirement_mode: 'none' | 'minimum_order';
  minimum_order_amount_usd: number | null; benefit_recurrence_mode: 'once' | 'daily'; benefit_fulfillment: 'any' | 'pickup' | 'delivery_zone_1';
};
type Member = {
  id: number; client_id: number; play_id: number; workflow_status: string; benefit_status: string;
  purchase_count: number; net_revenue_usd: number; first_purchase_on: string | null; last_purchase_on: string | null;
  last_gift_on: string | null; contacted_at: string | null; responded_at: string | null; play_launched_at: string | null;
  contact_attempt_count: number; next_follow_up_at: string | null; last_note: string | null; eligibility_reasons: string[] | null;
  client: { full_name: string } | { full_name: string }[] | null; play: Play | Play[] | null;
};
type Event = { id: number; event_type: string; note: string | null; created_at: string; channel: string | null };
type Redemption = { id: number; order_id: number; status: string; quantity: number; advisor_charge_usd: number; created_at: string; redeemed_at: string | null; product: { name: string } | { name: string }[] | null };
const one = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] ?? null : value;
const money = (value: unknown) => `$${Number(value || 0).toFixed(2)}`;
const stamp = (value: string | null) => value ? new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Sin registro';
const day = (value: string | null) => value ? new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium' }).format(new Date(value.length === 10 ? `${value}T12:00:00-04:00` : value)) : 'Sin registro';
const eventLabel: Record<string, string> = { contact: 'Contacto', responded: 'Respondió', launched: 'Propuesta lanzada', follow_up: 'Seguimiento', accepted: 'Aceptó', converted: 'Conversión', not_interested: 'No interesado', unreachable: 'Sin respuesta', closed: 'Seguimiento cerrado', note: 'Nota', benefit_selected: 'Beneficio seleccionado', benefit_redeemed: 'Obsequio entregado' };

/** A read-only snapshot route: no mutation controls, no automatic contact events,
 * no service client and no live-portfolio authorization substituted for ownership. */
export default async function AdvisorPlayHistoryMemberPage({ params, searchParams }: { params: Promise<{ memberId: string }>; searchParams?: Promise<{ returnTo?: string }> }) {
  const ctx = await getAuthContext();
  if (!ctx) return null;
  const memberId = Number((await params).memberId);
  if (!Number.isSafeInteger(memberId) || memberId <= 0) return <EmptyBlock title="Participación no válida" detail="Vuelve a tus jugadas y selecciona al cliente." href="/app/advisor/plays" cta="Mis jugadas" />;
  const result = await ctx.supabase.from('crm_play_members').select(`
    id, play_id, client_id, workflow_status, benefit_status, purchase_count, net_revenue_usd,
    first_purchase_on, last_purchase_on, last_gift_on, contacted_at, responded_at, play_launched_at,
    contact_attempt_count, next_follow_up_at, last_note, eligibility_reasons,
    client:clients(full_name),
    play:crm_plays(id, name, status, starts_at, ends_at, description, advisor_guidance, message_template,
      benefit_selection_mode, purchase_requirement_mode, minimum_order_amount_usd, benefit_recurrence_mode, benefit_fulfillment)
  `).eq('id', memberId).eq('advisor_id_snapshot', ctx.user.id).maybeSingle();
  const member = result.data as unknown as Member | null;
  const play = member ? one(member.play) : null;
  if (result.error || !member || !play || !ADVISOR_PUBLISHED_PLAY_STATUSES.includes(play.status)) {
    return <EmptyBlock title="No pudimos abrir esta participación" detail="Solo puedes consultar clientes de jugadas publicadas que fueron asignados a ti." href="/app/advisor/plays" cta="Mis jugadas" />;
  }
  const [events, benefits, redemptions] = await Promise.all([
    readAdvisorPlayPages<Event>((from, to) => ctx.supabase.from('crm_play_member_events')
      .select('id,event_type,note,created_at,channel').eq('play_member_id', memberId)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)),
    ctx.supabase.from('crm_play_benefits').select(`id,quantity,unit_benefit_value_usd,unit_advisor_cost_usd,
      product:products!crm_play_benefits_product_id_fkey(name),
      upgrades:crm_play_benefit_upgrades!crm_play_benefit_upgrades_benefit_fkey(
        id,target_quantity,customer_difference_usd_snapshot,product:products!crm_play_benefit_upgrades_target_product_id_fkey(name))`)
      .eq('play_id', member.play_id).order('sort_order').order('id'),
    readAdvisorPlayPages<Redemption>((from, to) => ctx.supabase.from('crm_play_redemptions')
      .select('id,order_id,status,quantity,advisor_charge_usd,created_at,redeemed_at,product:products(name)')
      .eq('play_member_id', memberId).order('id', { ascending: false }).range(from, to)),
  ]);
  const benefitOptions = (benefits.data ?? []).map(option => ({
    id: Number(option.id), name: one(option.product)?.name ?? 'Beneficio', quantity: Number(option.quantity),
    benefitValueUsd: Number(option.unit_benefit_value_usd) * Number(option.quantity),
    advisorCostUsd: Number(option.unit_advisor_cost_usd) * Number(option.quantity),
    upgrades: (option.upgrades ?? []).map(upgrade => ({ id: Number(upgrade.id), name: one(upgrade.product)?.name ?? 'Ampliación',
      quantity: Number(upgrade.target_quantity), customerDifferenceUsd: Number(upgrade.customer_difference_usd_snapshot || 0) })),
  }));
  const presentation = workflowPresentation(member.workflow_status, false, member.benefit_status, member.contacted_at, member.responded_at, member.play_launched_at);
  const requestedReturn = sanitizeAdvisorReturnTo((await searchParams)?.returnTo);
  const returnHref = requestedReturn?.startsWith('/app/advisor/plays?') ? requestedReturn : advisorPlaysHref(play.id, advisorPlayMonth(play));
  return <div className="space-y-3">
    <Link href={returnHref} className="inline-flex min-h-10 items-center text-xs text-[#F7DA66]">← Volver a la lista del mes</Link>
    <header className="space-y-1">
      <StatusBadge label="Histórica · solo consulta" tone="neutral" />
      <h1 className="text-lg font-semibold text-[#F5F7FB]">{one(member.client)?.full_name || 'Cliente'}</h1>
      <p className="text-xs text-[#AAB2C5]">{play.name} · {playValidityLabel(play)}</p>
      <p className="text-[11px] text-[#8B93A7]">Esta vista conserva los datos de la jugada. No registra contactos ni reactiva obsequios.</p>
    </header>
    <SectionCard title="Resultado guardado" action={<StatusBadge label={presentation.label} tone="neutral" />}>
      <dl className="grid grid-cols-2 gap-3 text-xs text-[#AAB2C5]">
        {[
          ['Contacto', stamp(member.contacted_at)], ['Respondió', stamp(member.responded_at)],
          ['Propuesta lanzada', stamp(member.play_launched_at)], ['Intentos', String(member.contact_attempt_count || 0)],
          ['Próximo seguimiento registrado', stamp(member.next_follow_up_at)], ['Beneficio', member.benefit_status === 'redeemed' ? 'Entregado' : member.benefit_status === 'reserved' ? 'Reservado en pedido' : 'Sin entrega registrada'],
        ].map(([label, value]) => <div key={label}><dt className="text-[#747E91]">{label}</dt><dd className="mt-1">{value}</dd></div>)}
      </dl>
    </SectionCard>
    <SectionCard title="Foto de entrada" subtitle="Datos guardados al preparar la lista; no se recalculan.">
      <dl className="grid grid-cols-2 gap-3 text-xs text-[#AAB2C5]">
        {[
          ['Primera compra', day(member.first_purchase_on)], ['Última compra', day(member.last_purchase_on)],
          ['Cierres', String(member.purchase_count || 0)], ['Facturación sin IVA', money(member.net_revenue_usd)], ['Último obsequio', day(member.last_gift_on)],
        ].map(([label, value]) => <div key={label}><dt className="text-[#747E91]">{label}</dt><dd className="mt-1">{value}</dd></div>)}
      </dl>
      {member.eligibility_reasons?.length ? <p className="mt-3 text-xs text-[#8B93A7]">{member.eligibility_reasons.join(' · ')}</p> : null}
    </SectionCard>
    <PlayConditionsCard play={play} benefits={benefitOptions} defaultOpen={false} />
    {benefits.error ? <p role="alert" className="text-xs text-amber-200">No se pudieron cargar las condiciones completas. Intenta de nuevo.</p> : null}
    <details className="rounded-xl border border-[#232632] p-3 text-xs text-[#AAB2C5]">
      <summary className="cursor-pointer">Descripción y mensaje de la jugada</summary>
      <p className="mt-3 whitespace-pre-line">{play.description}</p>
      <p className="mt-3 whitespace-pre-line">{play.advisor_guidance}</p>
      <p className="mt-3 whitespace-pre-line">{play.message_template || 'Sin mensaje guardado.'}</p>
    </details>
    <SectionCard title="Beneficios y pedidos vinculados">
      {redemptions.error ? <p>No se pudo cargar este historial.</p> : redemptions.data.length === 0 ? <p className="text-xs text-[#8B93A7]">Sin aplicaciones registradas.</p> : redemptions.data.map(row => <div key={row.id} className="border-b border-[#232632] py-2 text-xs text-[#AAB2C5]">
        <Link href={`/app/advisor/orders/${row.order_id}`} className="text-[#F7DA66]">Pedido #{row.order_id}</Link> · {row.quantity} × {one(row.product)?.name || 'Beneficio'}
        <p className="mt-1">{row.status === 'redeemed' ? 'Entregado' : row.status === 'reserved' ? 'Reservado' : 'Anulado'} · {stamp(row.redeemed_at || row.created_at)}{row.status === 'redeemed' ? ` · Cargo asesor ${money(row.advisor_charge_usd)}` : ''}</p>
      </div>)}
    </SectionCard>
    <SectionCard title="Historial de seguimiento">
      {events.error ? <p>No se pudo cargar el seguimiento.</p> : events.data.length === 0 ? <p className="text-xs text-[#8B93A7]">Sin movimientos registrados.</p> : events.data.map(event => <article key={event.id} className="border-b border-[#232632] py-2 text-xs text-[#AAB2C5]">
        <p>{eventLabel[event.event_type] || event.event_type} · {stamp(event.created_at)}</p>
        {event.note ? <p className="mt-1 whitespace-pre-line text-[#8B93A7]">{event.note}</p> : null}
      </article>)}
      {member.last_note ? <p className="mt-3 whitespace-pre-line text-xs text-[#8B93A7]">Última nota: {member.last_note}</p> : null}
    </SectionCard>
    <Link href={`/app/advisor/clients/${member.client_id}`} className="inline-flex min-h-10 items-center text-xs text-[#F7DA66]">Ver ficha actual del cliente →</Link>
    <p className="text-[10px] text-[#747E91]">La ficha actual se abre según los permisos de tu cartera vigente; no modifica esta jugada.</p>
  </div>;
}
