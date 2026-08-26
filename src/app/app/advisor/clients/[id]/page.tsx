import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import { normalizePhoneDetailed } from '@/lib/phone/normalize-phone';
import { EmptyBlock, MetricCard, PageIntro, SectionCard, StatusBadge } from '../../advisor-ui';
import ClientBenefitSelector from './ClientBenefitSelector';
import ClientFollowUpPanel from './ClientFollowUpPanel';

type ClientProfile = {
  client_id: number | string;
  generated_at: string;
  purchase_window: number | string;
  client: {
    id: number | string;
    full_name: string | null;
    phone: string | null;
    client_type: string | null;
    birth_date: string | null;
    important_date: string | null;
    primary_advisor_id: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  };
  metrics: {
    first_purchase_on: string | null;
    last_purchase_on: string | null;
    purchase_count: number | string;
    net_revenue_usd: number | string;
    average_ticket_usd: number | string | null;
    cadence_days: number | string | null;
    last_advisor_name: string | null;
    last_gift_on: string | null;
    gift_event_count: number | string;
    days_since_last_purchase: number | string | null;
    used_pickup: boolean;
    used_delivery: boolean;
    historical_purchase_count: number | string;
    live_purchase_count: number | string;
    historical_revenue_usd: number | string;
    live_revenue_usd: number | string;
  };
  classification: {
    is_new_client: boolean;
    needs_contact: boolean;
    outside_rhythm: boolean;
  };
  recent_activity: Array<{
    fact_key: string;
    origin: 'historical' | 'live' | string;
    source_control: string | null;
    purchased_at: string;
    event_kind: string;
    net_total_usd: number | string;
    fulfillment: string | null;
    advisor_name: string | null;
    has_gift: boolean;
  }>;
  pending_order_count: number | string;
  pending_orders: Array<{
    id: number | string;
    order_number: string | null;
    status: string;
    created_at: string;
    scheduled_date: string | null;
    total_usd: number | string;
    fulfillment: string | null;
    advisor_name: string | null;
  }>;
};

type PlayRecord = {
  id: number | string;
  name: string;
  description: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  gift_product_id: number | string;
  gift_quantity: number | string;
};

type PlayMemberRow = {
  id: number | string;
  play_id: number | string;
  client_id: number | string;
  workflow_status: string;
  benefit_status: string;
  selected_play_benefit_id: number | string | null;
  first_purchase_on: string | null;
  last_purchase_on: string | null;
  purchase_count: number | string;
  net_revenue_usd: number | string;
  average_ticket_usd: number | string | null;
  last_gift_on: string | null;
  days_since_last_purchase: number | string | null;
  eligibility_reasons: string[] | null;
  contact_attempt_count: number | string;
  last_contact_at: string | null;
  next_follow_up_at: string | null;
  last_note: string | null;
  last_event_at: string | null;
  play: PlayRecord | PlayRecord[] | null;
};

type PlayEventRow = {
  id: number | string;
  event_type: string;
  from_status: string;
  to_status: string;
  channel: string | null;
  note: string | null;
  follow_up_at: string | null;
  created_at: string;
  actor: { full_name: string | null } | Array<{ full_name: string | null }> | null;
};

type PlayBenefitRow = {
  id: number | string;
  product_id: number | string;
  quantity: number | string;
  product: { name: string; sku: string | null } | Array<{ name: string; sku: string | null }> | null;
};

type PageParams = Promise<{ id: string }>;
type SearchParams = Promise<{ playMember?: string; returnTo?: string }>;

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Caracas',
});

const dateTimeFormatter = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Caracas',
});

const moneyFormatter = new Intl.NumberFormat('es-VE', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Sin dato';
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00-04:00` : value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function dateTimeLabel(value: string | null | undefined) {
  if (!value) return 'Sin registro';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

function workflowLabel(status: string) {
  const labels: Record<string, string> = {
    pending: 'Pendiente',
    contacted: 'Contactado',
    follow_up_scheduled: 'Seguimiento programado',
    responded: 'Respondió',
    accepted: 'Aceptó',
    converted: 'Recompra lograda',
    not_interested: 'No interesado',
    unreachable: 'Sin respuesta',
    not_applicable: 'No aplica',
    closed: 'Cerrado',
    removed: 'Retirado',
  };
  return labels[status] ?? status;
}

function workflowTone(status: string): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'converted' || status === 'accepted') return 'success';
  if (status === 'pending' || status === 'follow_up_scheduled') return 'warning';
  if (status === 'not_interested' || status === 'not_applicable' || status === 'removed') return 'danger';
  return 'neutral';
}

function eventLabel(eventType: string) {
  const labels: Record<string, string> = {
    contact: 'Contacto registrado',
    follow_up: 'Seguimiento programado',
    responded: 'El cliente respondió',
    accepted: 'El cliente mostró interés',
    converted: 'Recompra lograda',
    not_interested: 'No está interesado',
    unreachable: 'No respondió',
    not_applicable: 'No aplica',
    closed: 'Seguimiento cerrado',
    note: 'Nota agregada',
    benefit_selected: 'Beneficio seleccionado',
  };
  return labels[eventType] ?? eventType;
}

function channelLabel(channel: string | null) {
  const labels: Record<string, string> = {
    whatsapp: 'WhatsApp',
    call: 'Llamada',
    in_person: 'En persona',
    other: 'Otro',
  };
  return channel ? labels[channel] ?? channel : null;
}

function clientChannelLabel(profile: ClientProfile) {
  if (profile.metrics.used_pickup && profile.metrics.used_delivery) return 'Pickup y delivery';
  if (profile.metrics.used_pickup) return 'Pickup';
  if (profile.metrics.used_delivery) return 'Delivery';
  return 'Sin canal registrado';
}

export default async function AdvisorClientProfilePage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams?: SearchParams;
}) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const routeParams = await params;
  const query = (await searchParams) ?? {};
  const clientId = Math.trunc(Number(routeParams.id));
  const requestedMemberId = Math.trunc(Number(query.playMember));

  if (!Number.isFinite(clientId) || clientId <= 0) {
    return (
      <EmptyBlock title="Cliente no válido" detail="Vuelve a tu cartera y selecciona nuevamente al cliente." href="/app/advisor/clients" cta="Volver a la cartera" />
    );
  }

  const [profileResult, membershipsResult] = await Promise.all([
    ctx.supabase.rpc('crm_advisor_client_profile_v1', {
      p_client_id: clientId,
      p_purchase_window: 6,
      p_recent_limit: 8,
    }),
    ctx.supabase
      .from('crm_play_members')
      .select(`
        id, play_id, client_id, workflow_status, benefit_status,
        selected_play_benefit_id,
        first_purchase_on, last_purchase_on, purchase_count, net_revenue_usd,
        average_ticket_usd, last_gift_on,
        days_since_last_purchase, eligibility_reasons, contact_attempt_count,
        last_contact_at, next_follow_up_at, last_note, last_event_at,
        play:crm_plays(
          id, name, description, status, starts_at, ends_at,
          gift_product_id, gift_quantity
        )
      `)
      .eq('client_id', clientId)
      .eq('advisor_id_snapshot', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const profile = profileResult.data as ClientProfile | null;
  if (profileResult.error || !profile?.client) {
    console.error('Unable to load advisor client profile', profileResult.error?.message);
    return (
      <div className="space-y-4">
        <PageIntro eyebrow="CRM del asesor" title="Ficha del cliente" description="Información comercial actualizada al momento." />
        <EmptyBlock
          title="No pudimos abrir esta ficha"
          detail="El cliente debe pertenecer a tu cartera actual o a una jugada activa asignada a ti."
          href="/app/advisor/clients"
          cta="Volver a la cartera"
        />
      </div>
    );
  }

  if (membershipsResult.error) {
    console.error('Unable to load client play memberships', membershipsResult.error.message);
  }

  const memberships = (membershipsResult.data ?? []) as unknown as PlayMemberRow[];
  const selectedMember = memberships.find((member) => Number(member.id) === requestedMemberId)
    ?? memberships.find((member) => ['active', 'paused'].includes(one(member.play)?.status ?? ''))
    ?? null;
  const selectedPlay = selectedMember ? one(selectedMember.play) : null;

  const [eventsResult, benefitOptionsResult] = await Promise.all([
    selectedMember
      ? ctx.supabase
          .from('crm_play_member_events')
          .select('id, event_type, from_status, to_status, channel, note, follow_up_at, created_at, actor:profiles(full_name)')
          .eq('play_member_id', Number(selectedMember.id))
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [], error: null }),
    selectedPlay
      ? ctx.supabase
          .from('crm_play_benefits')
          .select('id, product_id, quantity, product:products!crm_play_benefits_product_id_fkey(name, sku)')
          .eq('play_id', Number(selectedPlay.id))
          .order('sort_order', { ascending: true })
          .order('id', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (eventsResult.error) console.error('Unable to load CRM follow-up events', eventsResult.error.message);
  if (benefitOptionsResult.error) console.error('Unable to load CRM play benefits', benefitOptionsResult.error.message);

  const events = (eventsResult.data ?? []) as unknown as PlayEventRow[];
  const benefitOptions = ((benefitOptionsResult.data ?? []) as unknown as PlayBenefitRow[]).map((option) => {
    const product = one(option.product);
    return {
      id: numberValue(option.id),
      productId: numberValue(option.product_id),
      name: product?.name?.trim() || 'Beneficio',
      sku: product?.sku ?? null,
      quantity: numberValue(option.quantity),
    };
  });
  const phone = normalizePhoneDetailed(profile.client.phone);
  const whatsappHref = phone.e164 ? `https://wa.me/${phone.e164.slice(1)}` : null;
  const cadence = optionalNumber(profile.metrics.cadence_days);
  const daysSince = optionalNumber(profile.metrics.days_since_last_purchase);
  const returnPath = query.returnTo || `/app/advisor/clients/${clientId}`;
  const generatedAt = new Date(profile.generated_at).getTime();
  const isPlayActive = selectedPlay?.status === 'active'
    && (!selectedPlay.starts_at || new Date(selectedPlay.starts_at).getTime() <= generatedAt)
    && (!selectedPlay.ends_at || new Date(selectedPlay.ends_at).getTime() > generatedAt);

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Ficha comercial"
        title={profile.client.full_name?.trim() || 'Cliente sin nombre'}
        description={`${profile.client.phone?.trim() || 'Sin teléfono'} · Datos vivos y seguimiento de CRM.`}
        action={profile.classification.is_new_client ? <StatusBadge label="Cliente nuevo" tone="success" /> : undefined}
      />

      <div className="flex gap-2">
        {whatsappHref ? (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 flex-1 items-center justify-center rounded-[13px] bg-[#1D6B42] px-4 text-sm font-semibold text-white"
          >
            Abrir WhatsApp
          </a>
        ) : (
          <div className="flex h-11 flex-1 items-center justify-center rounded-[13px] border border-[#2A3040] text-xs text-[#747E91]">
            Sin WhatsApp disponible
          </div>
        )}
        <Link
          href="/app/advisor/new"
          className="inline-flex h-11 flex-1 items-center justify-center rounded-[13px] border border-[#F0D000] px-4 text-sm font-semibold text-[#F7DA66]"
        >
          Crear pedido
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MetricCard label="Cierres" value={String(numberValue(profile.metrics.purchase_count))} detail="Compras registradas" />
        <MetricCard label="Facturación" value={moneyFormatter.format(numberValue(profile.metrics.net_revenue_usd))} detail="Total sin IVA" />
        <MetricCard
          label="Última compra"
          value={daysSince === null ? '—' : daysSince <= 0 ? 'Hoy' : `${Math.round(daysSince)} d`}
          detail={dateLabel(profile.metrics.last_purchase_on)}
        />
        <MetricCard
          label="Frecuencia promedio"
          value={cadence === null ? '—' : `${Math.round(cadence)} d`}
          detail={cadence === null ? 'Aún sin patrón' : 'Tiempo aproximado entre compras'}
        />
      </div>

      <SectionCard title="Resumen vivo" subtitle={`Actualizado ${dateTimeLabel(profile.generated_at)}`}>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div><dt className="text-[#747E91]">Primera compra</dt><dd className="mt-1 text-[#E2E6EF]">{dateLabel(profile.metrics.first_purchase_on)}</dd></div>
          <div><dt className="text-[#747E91]">Ticket promedio</dt><dd className="mt-1 text-[#E2E6EF]">{profile.metrics.average_ticket_usd == null ? 'Sin dato' : moneyFormatter.format(numberValue(profile.metrics.average_ticket_usd))}</dd></div>
          <div><dt className="text-[#747E91]">Último obsequio</dt><dd className="mt-1 text-[#E2E6EF]">{dateLabel(profile.metrics.last_gift_on)}</dd></div>
          <div><dt className="text-[#747E91]">Modalidad usada</dt><dd className="mt-1 text-[#E2E6EF]">{clientChannelLabel(profile)}</dd></div>
          <div><dt className="text-[#747E91]">Último asesor en compra</dt><dd className="mt-1 text-[#E2E6EF]">{profile.metrics.last_advisor_name?.trim() || 'Sin dato'}</dd></div>
          <div><dt className="text-[#747E91]">Fecha de cumpleaños</dt><dd className="mt-1 text-[#E2E6EF]">{dateLabel(profile.client.birth_date)}</dd></div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profile.classification.needs_contact ? <StatusBadge label="Requiere contacto" tone="warning" /> : null}
          {numberValue(profile.pending_order_count) > 0 ? <StatusBadge label={`${numberValue(profile.pending_order_count)} pedido en curso`} tone="neutral" /> : null}
        </div>
      </SectionCard>

      {selectedMember && selectedPlay ? (
        <>
          <SectionCard
            title={selectedPlay.name}
            subtitle="Seguimiento de esta jugada"
            action={<StatusBadge label={workflowLabel(selectedMember.workflow_status)} tone={workflowTone(selectedMember.workflow_status)} />}
          >
            <div className="rounded-[16px] border border-[#2A3040] bg-[#0D1017] px-3.5 py-3 text-xs leading-5 text-[#AAB2C5]">
              <div className="mb-2 font-medium text-[#F5F7FB]">Beneficio para este cliente</div>
              <ClientBenefitSelector
                key={`${selectedMember.id}-${selectedMember.selected_play_benefit_id ?? 'none'}`}
                playMemberId={numberValue(selectedMember.id)}
                options={benefitOptions}
                selectedBenefitId={selectedMember.selected_play_benefit_id == null ? null : numberValue(selectedMember.selected_play_benefit_id)}
                isActive={isPlayActive}
              />
              {selectedMember.next_follow_up_at ? (
                <div className="mt-1 text-[#F7DA66]">Próximo seguimiento: {dateTimeLabel(selectedMember.next_follow_up_at)}</div>
              ) : null}
            </div>
            <div className="mt-3">
              <ClientFollowUpPanel
                playMemberId={numberValue(selectedMember.id)}
                isActive={isPlayActive}
                workflowStatus={workflowLabel(selectedMember.workflow_status)}
                contactAttemptCount={numberValue(selectedMember.contact_attempt_count)}
                nextFollowUpAt={selectedMember.next_follow_up_at}
              />
            </div>
          </SectionCard>

          <SectionCard title="Foto de entrada" subtitle="Estos datos no cambian durante la jugada.">
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div><dt className="text-[#747E91]">Primera compra</dt><dd className="mt-1 text-[#E2E6EF]">{dateLabel(selectedMember.first_purchase_on)}</dd></div>
              <div><dt className="text-[#747E91]">Última compra</dt><dd className="mt-1 text-[#E2E6EF]">{dateLabel(selectedMember.last_purchase_on)}</dd></div>
              <div><dt className="text-[#747E91]">Cierres</dt><dd className="mt-1 text-[#E2E6EF]">{numberValue(selectedMember.purchase_count)}</dd></div>
              <div><dt className="text-[#747E91]">Facturación</dt><dd className="mt-1 text-[#E2E6EF]">{moneyFormatter.format(numberValue(selectedMember.net_revenue_usd))}</dd></div>
              <div><dt className="text-[#747E91]">Último obsequio</dt><dd className="mt-1 text-[#E2E6EF]">{dateLabel(selectedMember.last_gift_on)}</dd></div>
            </dl>
            {selectedMember.eligibility_reasons?.length ? (
              <div className="mt-3 rounded-[14px] bg-[#0D1017] px-3 py-2.5 text-xs leading-5 text-[#AAB2C5]">
                {selectedMember.eligibility_reasons.join(' · ')}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="Historial de seguimiento" subtitle="Registro cronológico e inalterable.">
            {events.length === 0 ? (
              <EmptyBlock title="Aún sin movimientos" detail="El primer contacto que registres aparecerá aquí." />
            ) : (
              <div className="space-y-2.5">
                {events.map((event) => {
                  const actor = one(event.actor);
                  return (
                    <article key={String(event.id)} className="rounded-[16px] border border-[#232632] bg-[#0D1017] px-3.5 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm font-medium text-[#F5F7FB]">{eventLabel(event.event_type)}</div>
                        <div className="shrink-0 text-[10px] text-[#747E91]">{dateTimeLabel(event.created_at)}</div>
                      </div>
                      <div className="mt-1 text-xs text-[#8B93A7]">
                        {actor?.full_name?.trim() || 'Usuario'}
                        {channelLabel(event.channel) ? ` · ${channelLabel(event.channel)}` : ''}
                      </div>
                      {event.note ? <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#D4D9E4]">{event.note}</div> : null}
                      {event.follow_up_at ? <div className="mt-2 text-xs text-[#F7DA66]">Próximo: {dateTimeLabel(event.follow_up_at)}</div> : null}
                    </article>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </>
      ) : (
        <SectionCard title="Seguimiento de jugadas" subtitle="La ficha comercial funciona aunque el cliente no esté en una jugada activa.">
          <EmptyBlock title="Sin jugada activa" detail="Cuando este cliente entre en una lista asignada a ti, aquí podrás registrar contactos y resultados." href="/app/advisor/plays" cta="Ver mis jugadas" />
        </SectionCard>
      )}

      {profile.pending_orders.length > 0 ? (
        <SectionCard title="Pedidos en curso" subtitle="Operación viva del cliente.">
          <div className="space-y-2">
            {profile.pending_orders.map((order) => (
              <Link
                key={String(order.id)}
                href={withAdvisorReturnTo(`/app/advisor/orders/${order.id}`, returnPath)}
                className="flex items-center justify-between gap-3 rounded-[15px] border border-[#232632] bg-[#0D1017] px-3.5 py-3"
              >
                <div>
                  <div className="text-sm font-medium text-[#F5F7FB]">Pedido {order.order_number || `#${order.id}`}</div>
                  <div className="mt-1 text-xs text-[#8B93A7]">{dateTimeLabel(order.created_at)} · {order.status}</div>
                </div>
                <div className="text-sm font-semibold text-[#F7DA66]">{moneyFormatter.format(numberValue(order.total_usd))}</div>
              </Link>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Actividad comercial reciente" subtitle="Compras y obsequios históricos o vivos.">
        {profile.recent_activity.length === 0 ? (
          <EmptyBlock title="Sin actividad registrada" detail="Todavía no hay compras u obsequios visibles para este cliente." />
        ) : (
          <div className="space-y-2">
            {profile.recent_activity.map((activity) => (
              <article key={activity.fact_key} className="rounded-[15px] border border-[#232632] bg-[#0D1017] px-3.5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[#F5F7FB]">
                      {activity.event_kind === 'gift_only' ? 'Obsequio sin compra' : 'Compra'}
                    </div>
                    <div className="mt-1 text-xs text-[#8B93A7]">{dateTimeLabel(activity.purchased_at)} · {activity.origin === 'historical' ? 'Histórico' : 'Vivo'}</div>
                  </div>
                  <div className="text-sm font-semibold text-[#F7DA66]">{moneyFormatter.format(numberValue(activity.net_total_usd))}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {activity.has_gift ? <StatusBadge label="Llevó obsequio" tone="success" /> : null}
                  {activity.fulfillment ? <StatusBadge label={activity.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'} tone="neutral" /> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
