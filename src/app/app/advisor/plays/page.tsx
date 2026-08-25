import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import { EmptyBlock, MetricCard, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type PlayRow = {
  id: number | string;
  name: string;
  description: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  snapshot_at: string | null;
  gift_product_id: number | string;
  gift_quantity: number | string;
  selection_summary: Record<string, unknown> | null;
};

type ClientRow = {
  id: number | string;
  full_name: string | null;
  phone: string | null;
};

type MemberRow = {
  id: number | string;
  play_id: number | string;
  client_id: number | string;
  workflow_status: string;
  benefit_status: string;
  first_purchase_on: string | null;
  last_purchase_on: string | null;
  purchase_count: number | string;
  net_revenue_usd: number | string;
  cadence_days: number | string | null;
  last_gift_on: string | null;
  days_since_last_purchase: number | string | null;
  contact_attempt_count: number | string;
  last_contact_at: string | null;
  next_follow_up_at: string | null;
  last_note: string | null;
  last_event_at: string | null;
  client: ClientRow | ClientRow[] | null;
};

type ViewFilter = 'all' | 'pending' | 'follow_up' | 'contacted' | 'converted';
type SearchParams = Promise<{ play?: string; view?: string }>;

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Caracas',
});

const dateTimeFormatter = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
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

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Sin fecha';
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00-04:00` : value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function dateTimeLabel(value: string | null | undefined) {
  if (!value) return 'Sin seguimiento';
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

function viewValue(value: string | undefined): ViewFilter {
  return value === 'pending' || value === 'follow_up' || value === 'contacted' || value === 'converted'
    ? value
    : 'all';
}

function playsHref(playId: number, view: ViewFilter = 'all') {
  const params = new URLSearchParams({ play: String(playId) });
  if (view !== 'all') params.set('view', view);
  return `/app/advisor/plays?${params.toString()}`;
}

function isDue(member: MemberRow, now: number) {
  if (!member.next_follow_up_at) return false;
  const timestamp = new Date(member.next_follow_up_at).getTime();
  return Number.isFinite(timestamp) && timestamp <= now;
}

function memberMatchesView(member: MemberRow, view: ViewFilter, now: number) {
  if (view === 'pending') return member.workflow_status === 'pending';
  if (view === 'follow_up') return isDue(member, now) || member.workflow_status === 'follow_up_scheduled';
  if (view === 'contacted') return member.workflow_status !== 'pending';
  if (view === 'converted') return member.workflow_status === 'converted';
  return true;
}

function sortMembers(left: MemberRow, right: MemberRow, now: number) {
  const leftDue = isDue(left, now) ? 0 : 1;
  const rightDue = isDue(right, now) ? 0 : 1;
  if (leftDue !== rightDue) return leftDue - rightDue;

  const leftPending = left.workflow_status === 'pending' ? 0 : 1;
  const rightPending = right.workflow_status === 'pending' ? 0 : 1;
  if (leftPending !== rightPending) return leftPending - rightPending;

  const leftFollowUp = left.next_follow_up_at ? new Date(left.next_follow_up_at).getTime() : Number.MAX_SAFE_INTEGER;
  const rightFollowUp = right.next_follow_up_at ? new Date(right.next_follow_up_at).getTime() : Number.MAX_SAFE_INTEGER;
  if (leftFollowUp !== rightFollowUp) return leftFollowUp - rightFollowUp;

  return numberValue(right.id) - numberValue(left.id);
}

export default async function AdvisorPlaysPage({ searchParams }: { searchParams?: SearchParams }) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const query = (await searchParams) ?? {};
  const requestedPlayId = Math.trunc(Number(query.play));
  const view = viewValue(query.view);
  const playsResult = await ctx.supabase
    .from('crm_plays')
    .select('id, name, description, status, starts_at, ends_at, snapshot_at, gift_product_id, gift_quantity, selection_summary')
    .in('status', ['active', 'paused'])
    .order('starts_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(50);

  if (playsResult.error) {
    console.error('Unable to load advisor CRM plays', playsResult.error.message);
    return (
      <div className="space-y-4">
        <PageIntro eyebrow="CRM del asesor" title="Mis jugadas" description="Listas activas y seguimiento comercial." />
        <EmptyBlock title="No pudimos cargar tus jugadas" detail="Intenta abrir nuevamente esta pantalla." />
      </div>
    );
  }

  const plays = (playsResult.data ?? []) as unknown as PlayRow[];
  const selectedPlay = plays.find((play) => Number(play.id) === requestedPlayId) ?? plays[0] ?? null;

  if (!selectedPlay) {
    return (
      <div className="space-y-4">
        <PageIntro
          eyebrow="CRM del asesor"
          title="Mis jugadas"
          description="Aquí aparecerán las listas que hayan sido activadas y asignadas a ti."
        />
        <EmptyBlock
          title="Todavía no tienes jugadas activas"
          detail="Tu cartera continúa disponible y actualizada. Cuando se publique una jugada, verás aquí sus clientes, beneficio y seguimiento."
          href="/app/advisor/clients"
          cta="Ver mi cartera"
        />
      </div>
    );
  }

  const [membersResult, productResult] = await Promise.all([
    ctx.supabase
      .from('crm_play_members')
      .select(`
        id, play_id, client_id, workflow_status, benefit_status,
        first_purchase_on, last_purchase_on, purchase_count, net_revenue_usd,
        cadence_days, last_gift_on, days_since_last_purchase,
        contact_attempt_count, last_contact_at, next_follow_up_at,
        last_note, last_event_at,
        client:clients(id, full_name, phone)
      `)
      .eq('play_id', Number(selectedPlay.id))
      .eq('advisor_id_snapshot', ctx.user.id)
      .order('id', { ascending: true })
      .limit(500),
    ctx.supabase
      .from('products')
      .select('id, name, sku')
      .eq('id', Number(selectedPlay.gift_product_id))
      .maybeSingle(),
  ]);

  if (membersResult.error) console.error('Unable to load advisor CRM play members', membersResult.error.message);
  const members = (membersResult.data ?? []) as unknown as MemberRow[];

  if (productResult.error) console.error('Unable to load CRM play gift product', productResult.error.message);
  const giftProduct = productResult.data as { id: number; name: string; sku: string | null } | null;

  // This is a server-only request snapshot used to classify due follow-ups consistently.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const dueCount = members.filter((member) => isDue(member, now)).length;
  const pendingCount = members.filter((member) => member.workflow_status === 'pending').length;
  const touchedCount = members.filter((member) => member.workflow_status !== 'pending').length;
  const convertedCount = members.filter((member) => member.workflow_status === 'converted').length;
  const visibleMembers = members
    .filter((member) => memberMatchesView(member, view, now))
    .sort((left, right) => sortMembers(left, right, now));
  const currentHref = playsHref(numberValue(selectedPlay.id), view);
  const filters: Array<{ value: ViewFilter; label: string; count: number }> = [
    { value: 'all', label: 'Todos', count: members.length },
    { value: 'pending', label: 'Sin tocar', count: pendingCount },
    { value: 'follow_up', label: 'Seguimientos', count: members.filter((member) => member.workflow_status === 'follow_up_scheduled' || isDue(member, now)).length },
    { value: 'contacted', label: 'Trabajados', count: touchedCount },
    { value: 'converted', label: 'Recompras', count: convertedCount },
  ];

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="CRM del asesor"
        title="Mis jugadas"
        description="La lista conserva su foto original; contactos y resultados se actualizan aquí."
        action={<StatusBadge label={selectedPlay.status === 'paused' ? 'Pausada' : 'Activa'} tone={selectedPlay.status === 'paused' ? 'warning' : 'success'} />}
      />

      {plays.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {plays.map((play) => {
            const active = Number(play.id) === Number(selectedPlay.id);
            return (
              <Link
                key={String(play.id)}
                href={playsHref(numberValue(play.id))}
                aria-current={active ? 'page' : undefined}
                className={[
                  'inline-flex h-10 shrink-0 items-center rounded-full border px-3.5 text-xs font-semibold',
                  active
                    ? 'border-[#F0D000] bg-[#2B2708] text-[#F7DA66]'
                    : 'border-[#2A3040] bg-[#0D1017] text-[#AAB2C5]',
                ].join(' ')}
              >
                {play.name}
              </Link>
            );
          })}
        </div>
      ) : null}

      <SectionCard title={selectedPlay.name} subtitle={`${dateLabel(selectedPlay.starts_at)} — ${dateLabel(selectedPlay.ends_at)}`}>
        {selectedPlay.description?.trim() ? (
          <p className="text-sm leading-5 text-[#D4D9E4]">{selectedPlay.description.trim()}</p>
        ) : null}
        <div className="mt-3 rounded-[15px] border border-[#564511] bg-[#2A2209] px-3.5 py-3 text-xs leading-5 text-[#F7DA66]">
          Beneficio: {numberValue(selectedPlay.gift_quantity).toLocaleString('es-VE')} × {giftProduct?.name || 'producto definido en la jugada'}.
        </div>
      </SectionCard>

      <div className="grid grid-cols-2 gap-2">
        <MetricCard label="Asignados" value={String(members.length)} detail="Clientes de tu lista" />
        <MetricCard label="Sin tocar" value={String(pendingCount)} detail="Aún sin seguimiento" />
        <MetricCard label="Vencidos hoy" value={String(dueCount)} detail="Seguimientos por atender" />
        <MetricCard label="Recompras" value={String(convertedCount)} detail="Resultados registrados" />
      </div>

      <section className="rounded-[22px] border border-[#232632] bg-[#12151D] px-4 py-3.5">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {filters.map((filter) => {
            const active = filter.value === view;
            return (
              <Link
                key={filter.value}
                href={playsHref(numberValue(selectedPlay.id), filter.value)}
                aria-current={active ? 'page' : undefined}
                className={[
                  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
                  active
                    ? 'border-[#F0D000] bg-[#2B2708] text-[#F7DA66]'
                    : 'border-[#2A3040] bg-[#0D1017] text-[#AAB2C5]',
                ].join(' ')}
              >
                <span>{filter.label}</span>
                <span className="text-[10px] opacity-75">{filter.count}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="space-y-2.5">
        <div className="flex items-end justify-between gap-3 px-1">
          <div>
            <h2 className="text-base font-semibold text-[#F5F7FB]">Clientes de la jugada</h2>
            <p className="mt-0.5 text-xs text-[#8B93A7]">{visibleMembers.length} visibles en este filtro</p>
          </div>
        </div>

        {membersResult.error ? (
          <EmptyBlock title="No pudimos cargar esta lista" detail="La jugada no fue modificada. Intenta nuevamente." />
        ) : visibleMembers.length === 0 ? (
          <EmptyBlock title="Sin clientes en este filtro" detail="Selecciona otro estado para revisar el resto de la lista." />
        ) : (
          visibleMembers.map((member) => {
            const client = one(member.client);
            const due = isDue(member, now);
            const detailHref = withAdvisorReturnTo(
              `/app/advisor/clients/${member.client_id}?playMember=${member.id}`,
              currentHref,
            );

            return (
              <article key={String(member.id)} className="rounded-[20px] border border-[#232632] bg-[#12151D] px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={detailHref} className="block truncate text-[15px] font-semibold text-[#F5F7FB] underline decoration-[#4C5260] underline-offset-4">
                      {client?.full_name?.trim() || 'Cliente sin nombre'}
                    </Link>
                    <p className="mt-1 truncate text-xs text-[#8B93A7]">{client?.phone?.trim() || 'Sin teléfono registrado'}</p>
                  </div>
                  <StatusBadge label={workflowLabel(member.workflow_status)} tone={workflowTone(member.workflow_status)} />
                </div>

                {due ? (
                  <div className="mt-3 rounded-[13px] border border-[#5E2229] bg-[#261114] px-3 py-2 text-xs text-[#F0A6AE]">
                    Seguimiento vencido: {dateTimeLabel(member.next_follow_up_at)}
                  </div>
                ) : member.next_follow_up_at ? (
                  <div className="mt-3 rounded-[13px] border border-[#564511] bg-[#2A2209] px-3 py-2 text-xs text-[#F7DA66]">
                    Próximo seguimiento: {dateTimeLabel(member.next_follow_up_at)}
                  </div>
                ) : null}

                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 border-y border-[#232632] py-3 text-xs">
                  <div><div className="text-[#747E91]">Última compra al corte</div><div className="mt-1 text-[#E2E6EF]">{dateLabel(member.last_purchase_on)}</div></div>
                  <div><div className="text-[#747E91]">Cierres al corte</div><div className="mt-1 text-[#E2E6EF]">{numberValue(member.purchase_count)}</div></div>
                  <div><div className="text-[#747E91]">Facturación al corte</div><div className="mt-1 text-[#E2E6EF]">{moneyFormatter.format(numberValue(member.net_revenue_usd))}</div></div>
                  <div><div className="text-[#747E91]">Último contacto</div><div className="mt-1 text-[#E2E6EF]">{dateTimeLabel(member.last_contact_at)}</div></div>
                </div>

                {member.last_note?.trim() ? (
                  <p className="mt-3 line-clamp-2 text-xs leading-5 text-[#AAB2C5]">{member.last_note.trim()}</p>
                ) : null}

                <Link
                  href={detailHref}
                  className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-[13px] border border-[#F0D000] px-4 text-sm font-semibold text-[#F7DA66]"
                >
                  Abrir ficha y seguimiento
                </Link>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
