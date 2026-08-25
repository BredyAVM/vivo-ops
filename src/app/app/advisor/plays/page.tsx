import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import { EmptyBlock, StatusBadge } from '../advisor-ui';

type PlayRow = {
  id: number | string;
  name: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  gift_product_id: number | string;
  gift_quantity: number | string;
};

type ClientRow = {
  id: number | string;
  full_name: string | null;
};

type MemberRow = {
  id: number | string;
  play_id: number | string;
  client_id: number | string;
  workflow_status: string;
  purchase_count: number | string;
  days_since_last_purchase: number | string | null;
  contact_attempt_count: number | string;
  next_follow_up_at: string | null;
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

function workflowPresentation(status: string, due: boolean) {
  if (due) {
    return {
      label: 'Vencido',
      dot: 'bg-[#F06B78]',
      chip: 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]',
      row: 'border-l-[#D95360]',
    };
  }

  const presentations: Record<string, { label: string; dot: string; chip: string; row: string }> = {
    pending: {
      label: 'Pendiente',
      dot: 'bg-[#7E8799]',
      chip: 'border-[#343A48] bg-[#171B24] text-[#B7BECC]',
      row: 'border-l-[#5F6879]',
    },
    contacted: {
      label: 'Contactado',
      dot: 'bg-[#69B7FF]',
      chip: 'border-[#214C73] bg-[#102338] text-[#8CC9FF]',
      row: 'border-l-[#3C8FD9]',
    },
    follow_up_scheduled: {
      label: 'Seguimiento',
      dot: 'bg-[#F0D000]',
      chip: 'border-[#564511] bg-[#2A2209] text-[#F7DA66]',
      row: 'border-l-[#D6B900]',
    },
    responded: {
      label: 'Respondió',
      dot: 'bg-[#B694FF]',
      chip: 'border-[#4A3675] bg-[#241A3A] text-[#C9B1FF]',
      row: 'border-l-[#8D68E1]',
    },
    accepted: {
      label: 'Aceptó',
      dot: 'bg-[#7CE0A9]',
      chip: 'border-[#1C5036] bg-[#0F2119] text-[#7CE0A9]',
      row: 'border-l-[#41B879]',
    },
    converted: {
      label: 'Recompra',
      dot: 'bg-[#35E293]',
      chip: 'border-[#176344] bg-[#0A2B1D] text-[#68F0B1]',
      row: 'border-l-[#24C77A]',
    },
    not_interested: {
      label: 'No aceptó',
      dot: 'bg-[#F06B78]',
      chip: 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]',
      row: 'border-l-[#D95360]',
    },
    unreachable: {
      label: 'Sin respuesta',
      dot: 'bg-[#F5A65B]',
      chip: 'border-[#68401B] bg-[#2F1E0D] text-[#F6B97D]',
      row: 'border-l-[#D8893D]',
    },
    not_applicable: {
      label: 'No aplica',
      dot: 'bg-[#8B93A7]',
      chip: 'border-[#343A48] bg-[#171B24] text-[#B7BECC]',
      row: 'border-l-[#6D7587]',
    },
    closed: {
      label: 'Cerrado',
      dot: 'bg-[#8B93A7]',
      chip: 'border-[#343A48] bg-[#171B24] text-[#B7BECC]',
      row: 'border-l-[#6D7587]',
    },
    removed: {
      label: 'Retirado',
      dot: 'bg-[#F06B78]',
      chip: 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]',
      row: 'border-l-[#D95360]',
    },
  };

  return presentations[status] ?? presentations.pending;
}

function CompactPageHeader({ status }: { status?: 'active' | 'paused' }) {
  return (
    <header className="flex items-center justify-between gap-3 px-1 py-0.5">
      <div>
        <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#747E91]">CRM del asesor</p>
        <h1 className="mt-0.5 text-lg font-semibold tracking-[-0.03em] text-[#F5F7FB]">Mis jugadas</h1>
      </div>
      {status ? (
        <StatusBadge
          label={status === 'paused' ? 'Pausada' : 'Activa'}
          tone={status === 'paused' ? 'warning' : 'success'}
        />
      ) : null}
    </header>
  );
}

function CompactStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[12px] border border-[#232632] bg-[#12151D] px-2 py-2 text-center">
      <div className="text-base font-semibold leading-none tabular-nums text-[#F5F7FB]">{value}</div>
      <div className="mt-1 truncate text-[9px] uppercase tracking-[0.1em] text-[#747E91]">{label}</div>
    </div>
  );
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
    .select('id, name, status, starts_at, ends_at, gift_product_id, gift_quantity')
    // Draft and frozen plays remain private to the master dashboard.
    .in('status', ['active', 'paused'])
    .order('starts_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(50);

  if (playsResult.error) {
    console.error('Unable to load advisor CRM plays', playsResult.error.message);
    return (
      <div className="space-y-3">
        <CompactPageHeader />
        <EmptyBlock title="No pudimos cargar tus jugadas" detail="Intenta abrir nuevamente esta pantalla." />
      </div>
    );
  }

  const plays = (playsResult.data ?? []) as unknown as PlayRow[];
  const selectedPlay = plays.find((play) => Number(play.id) === requestedPlayId) ?? plays[0] ?? null;

  if (!selectedPlay) {
    return (
      <div className="space-y-3">
        <CompactPageHeader />
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
        id, play_id, client_id, workflow_status, purchase_count,
        days_since_last_purchase, contact_attempt_count, next_follow_up_at,
        client:clients(id, full_name)
      `)
      .eq('play_id', Number(selectedPlay.id))
      .eq('advisor_id_snapshot', ctx.user.id)
      .order('id', { ascending: true })
      .limit(500),
    ctx.supabase
      .from('products')
      .select('id, name')
      .eq('id', Number(selectedPlay.gift_product_id))
      .maybeSingle(),
  ]);

  if (membersResult.error) console.error('Unable to load advisor CRM play members', membersResult.error.message);
  const members = (membersResult.data ?? []) as unknown as MemberRow[];

  if (productResult.error) console.error('Unable to load CRM play gift product', productResult.error.message);
  const giftProduct = productResult.data as { id: number; name: string } | null;

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
    <div className="space-y-3">
      <CompactPageHeader status={selectedPlay.status === 'paused' ? 'paused' : 'active'} />

      {plays.length > 1 ? (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {plays.map((play) => {
            const active = Number(play.id) === Number(selectedPlay.id);
            return (
              <Link
                key={String(play.id)}
                href={playsHref(numberValue(play.id))}
                aria-current={active ? 'page' : undefined}
                className={[
                  'inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[11px] font-semibold',
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

      <section className="rounded-[15px] border border-[#232632] bg-[#12151D] px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-[#F5F7FB]">{selectedPlay.name}</h2>
            <p className="mt-0.5 truncate text-[10px] text-[#747E91]">
              {dateLabel(selectedPlay.starts_at)} — {dateLabel(selectedPlay.ends_at)}
            </p>
          </div>
          <div className="max-w-[52%] truncate rounded-full border border-[#564511] bg-[#2A2209] px-2.5 py-1 text-right text-[10px] font-medium text-[#F7DA66]">
            {numberValue(selectedPlay.gift_quantity).toLocaleString('es-VE')} × {giftProduct?.name || 'Beneficio'}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-4 gap-1.5">
        <CompactStat label="Total" value={members.length} />
        <CompactStat label="Pendientes" value={pendingCount} />
        <CompactStat label="Vencidos" value={dueCount} />
        <CompactStat label="Recompras" value={convertedCount} />
      </div>

      <nav aria-label="Filtrar clientes de la jugada" className="flex gap-1.5 overflow-x-auto pb-0.5">
        {filters.map((filter) => {
          const active = filter.value === view;
          return (
            <Link
              key={filter.value}
              href={playsHref(numberValue(selectedPlay.id), filter.value)}
              aria-current={active ? 'page' : undefined}
              className={[
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium',
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
      </nav>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 px-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Clientes</h2>
          <span className="text-[10px] tabular-nums text-[#747E91]">{visibleMembers.length}</span>
        </div>

        {membersResult.error ? (
          <EmptyBlock title="No pudimos cargar esta lista" detail="La jugada no fue modificada. Intenta nuevamente." />
        ) : visibleMembers.length === 0 ? (
          <EmptyBlock title="Sin clientes en este filtro" detail="Selecciona otro estado para revisar el resto de la lista." />
        ) : (
          visibleMembers.map((member) => {
            const client = one(member.client);
            const due = isDue(member, now);
            const presentation = workflowPresentation(member.workflow_status, due);
            const clientName = client?.full_name?.trim() || 'Cliente sin nombre';
            const purchaseCount = numberValue(member.purchase_count);
            const daysSincePurchase = member.days_since_last_purchase == null
              ? null
              : Math.max(0, Math.round(numberValue(member.days_since_last_purchase)));
            const detailHref = withAdvisorReturnTo(
              `/app/advisor/clients/${member.client_id}?playMember=${member.id}`,
              currentHref,
            );
            const timingTitle = due
              ? `Seguimiento vencido: ${dateTimeLabel(member.next_follow_up_at)}`
              : member.next_follow_up_at
                ? `Próximo seguimiento: ${dateTimeLabel(member.next_follow_up_at)}`
                : `${numberValue(member.contact_attempt_count)} intentos de contacto`;

            return (
              <Link
                key={String(member.id)}
                href={detailHref}
                aria-label={`${clientName}. ${presentation.label}. ${purchaseCount} cierres. ${daysSincePurchase == null ? 'Sin compra registrada' : `${daysSincePurchase} días desde la última compra`}.`}
                title={timingTitle}
                className={[
                  'flex h-12 min-w-0 items-center gap-2 rounded-[12px] border border-l-4 border-[#232632] bg-[#12151D] px-2.5 transition active:scale-[0.995]',
                  presentation.row,
                ].join(' ')}
                style={{ contentVisibility: 'auto', containIntrinsicSize: '48px' }}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${presentation.dot}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#F5F7FB]">
                  {clientName}
                </span>
                <span
                  className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-[#8B93A7]"
                  title="Cierres · días desde la última compra"
                >
                  {purchaseCount}c · {daysSincePurchase == null ? '—' : `${daysSincePurchase}d`}
                </span>
                <span className={`max-w-[82px] shrink-0 truncate rounded-full border px-2 py-1 text-[9px] font-semibold ${presentation.chip}`}>
                  {presentation.label}
                </span>
                <span className="shrink-0 text-base leading-none text-[#646D80]" aria-hidden="true">›</span>
              </Link>
            );
          })
        )}
      </section>
    </div>
  );
}
