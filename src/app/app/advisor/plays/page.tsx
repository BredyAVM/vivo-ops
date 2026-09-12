import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import { EmptyBlock, StatusBadge } from '../advisor-ui';

type PlayRow = {
  id: number | string;
  name: string;
  description: string | null;
  status: string;
  rules_snapshot: Record<string, unknown> | null;
  advisor_guidance: string | null;
  starts_at: string | null;
  ends_at: string | null;
  gift_product_id: number | string;
  gift_quantity: number | string;
  benefit_selection_mode: 'single' | 'multiple';
  purchase_requirement_mode: 'none' | 'minimum_order';
  minimum_order_amount_usd: number | string | null;
};

type ClientRow = {
  id: number | string;
  full_name: string | null;
};

type BenefitRow = {
  id: number | string;
  quantity: number | string;
  unit_benefit_value_usd: number | string;
  unit_advisor_cost_usd: number | string;
  product: { name: string } | Array<{ name: string }> | null;
};

type BenefitUpgradeRow = {
  id: number | string;
  play_benefit_id: number | string;
  target_quantity: number | string;
  customer_difference_usd_snapshot: number | string | null;
  product: { name: string } | Array<{ name: string }> | null;
};

type BenefitUpgrade = {
  id: number;
  quantity: number;
  customerDifferenceUsd: number;
  name: string;
};

type BenefitOption = {
  id: number;
  quantity: number;
  benefitValueUsd: number;
  advisorCostUsd: number;
  name: string;
  upgrades: BenefitUpgrade[];
};

type MemberRow = {
  id: number | string;
  play_id: number | string;
  client_id: number | string;
  workflow_status: string;
  benefit_status: string;
  purchase_count: number | string;
  days_since_last_purchase: number | string | null;
  contact_attempt_count: number | string;
  contacted_at: string | null;
  responded_at: string | null;
  play_launched_at: string | null;
  next_follow_up_at: string | null;
  client: ClientRow | ClientRow[] | null;
};

type ViewFilter = 'all' | 'pending' | 'follow_up' | 'contacted' | 'responded' | 'launched' | 'converted';
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

const monthYearFormatter = new Intl.DateTimeFormat('es-VE', {
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Caracas',
});

const monthFormatter = new Intl.DateTimeFormat('es-VE', {
  month: 'long',
  timeZone: 'America/Caracas',
});

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function monthYearLabel(value: unknown) {
  const clean = stringValue(value);
  const match = clean.match(/^(\d{4})-(\d{2})/);
  if (!match) return clean;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return clean;
  return monthYearFormatter.format(new Date(Date.UTC(year, month - 1, 15)));
}

function monthLabel(value: unknown) {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) return '';
  return monthFormatter.format(new Date(Date.UTC(2026, month - 1, 15)));
}

function rangeLabel(from: unknown, to: unknown) {
  const fromLabel = monthYearLabel(from);
  const toLabel = monthYearLabel(to);
  if (fromLabel && toLabel) return `${fromLabel}–${toLabel}`;
  if (fromLabel) return `desde ${fromLabel}`;
  if (toLabel) return `hasta ${toLabel}`;
  return '';
}

function playCriteria(rules: Record<string, unknown> | null | undefined) {
  if (!rules) return [];
  const criteria: string[] = [];
  const minPurchases = optionalNumber(rules.min_purchase_count);
  const maxPurchases = optionalNumber(rules.max_purchase_count);
  if (minPurchases != null && minPurchases > 0 && maxPurchases != null) {
    criteria.push(`${Math.trunc(minPurchases)}–${Math.trunc(maxPurchases)} cierres`);
  } else if (minPurchases != null && minPurchases > 0) {
    criteria.push(`${Math.trunc(minPurchases)}+ cierres`);
  } else if (maxPurchases != null) {
    criteria.push(`Hasta ${Math.trunc(maxPurchases)} cierres`);
  }

  const minRevenue = optionalNumber(rules.min_net_revenue_usd);
  if (minRevenue != null && minRevenue > 0) criteria.push(`Facturación desde $${minRevenue.toFixed(2)}`);

  const minDays = optionalNumber(rules.min_days_since_purchase);
  const maxDays = optionalNumber(rules.max_days_since_purchase);
  if (minDays != null && maxDays != null) {
    criteria.push(`${Math.trunc(minDays)}–${Math.trunc(maxDays)} días sin comprar`);
  } else if (minDays != null) {
    criteria.push(`${Math.trunc(minDays)}+ días sin comprar`);
  } else if (maxDays != null) {
    criteria.push(`Compra en los últimos ${Math.trunc(maxDays)} días`);
  }

  const firstPurchaseRange = rangeLabel(rules.first_purchase_from, rules.first_purchase_to);
  if (firstPurchaseRange) criteria.push(`Primera compra ${firstPurchaseRange}`);
  const lastPurchaseRange = rangeLabel(rules.last_purchase_from, rules.last_purchase_to);
  if (lastPurchaseRange) criteria.push(`Última compra ${lastPurchaseRange}`);

  const lastGiftRange = rangeLabel(rules.last_gift_from, rules.last_gift_to);
  const includeNeverGifted = rules.include_never_gifted !== false;
  if (lastGiftRange) {
    criteria.push(`Último obsequio ${lastGiftRange}${includeNeverGifted ? ' o nunca' : ''}`);
  } else if (!includeNeverGifted) {
    criteria.push('Con obsequio previo');
  }

  const anniversaryMode = stringValue(rules.anniversary_mode);
  const anniversaryMonth = monthLabel(rules.anniversary_month);
  if (anniversaryMode === 'include' && anniversaryMonth) criteria.push(`Aniversario en ${anniversaryMonth}`);
  if (anniversaryMode === 'exclude' && anniversaryMonth) criteria.push(`Sin aniversario en ${anniversaryMonth}`);

  const fulfillment = stringValue(rules.fulfillment);
  if (fulfillment === 'pickup') criteria.push('Ha usado pickup');
  if (fulfillment === 'delivery') criteria.push('Ha usado delivery');
  return criteria;
}

function benefitCreditLabel(options: BenefitOption[], selectionMode: PlayRow['benefit_selection_mode']) {
  const values = options.map((option) => option.benefitValueUsd).filter((value) => value > 0);
  if (values.length === 0) return 'Sin crédito aplicable';
  if (values.length === 1) return `Crédito $${values[0]?.toFixed(2)}`;
  if (selectionMode === 'multiple') return `Crédito hasta $${values.reduce((sum, value) => sum + value, 0).toFixed(2)}`;
  return `Crédito $${Math.min(...values).toFixed(2)}–$${Math.max(...values).toFixed(2)}`;
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

function workflowPresentation(
  status: string,
  due: boolean,
  benefitStatus: string,
  contactedAt: string | null,
  respondedAt: string | null,
  playLaunchedAt: string | null,
) {
  if (benefitStatus === 'redeemed') {
    return {
      label: 'Obsequio entregado',
      dot: 'bg-[#35E293]',
      chip: 'border-[#176344] bg-[#0A2B1D] text-[#68F0B1]',
      row: 'border-l-[#24C77A]',
    };
  }

  if (benefitStatus === 'reserved') {
    return {
      label: 'Obsequio reservado',
      dot: 'bg-[#F0D000]',
      chip: 'border-[#66551A] bg-[#231E0C] text-[#F7DA66]',
      row: 'border-l-[#D6B900]',
    };
  }

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
      label: 'Contacto iniciado',
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
      label: 'Respondió saludo',
      dot: 'bg-[#B694FF]',
      chip: 'border-[#4A3675] bg-[#241A3A] text-[#C9B1FF]',
      row: 'border-l-[#8D68E1]',
    },
    launched: {
      label: 'Jugada lanzada',
      dot: 'bg-[#69B7FF]',
      chip: 'border-[#214C73] bg-[#102338] text-[#8CC9FF]',
      row: 'border-l-[#3C8FD9]',
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

  if (['follow_up_scheduled', 'accepted', 'converted', 'not_interested', 'unreachable', 'not_applicable', 'closed', 'removed'].includes(status)) {
    return presentations[status] ?? presentations.pending;
  }
  if (playLaunchedAt) return presentations.launched;
  if (respondedAt) return presentations.responded;
  if (contactedAt) return presentations.contacted;
  return presentations.pending;
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
  return value === 'pending' || value === 'follow_up' || value === 'contacted' || value === 'responded' || value === 'launched' || value === 'converted'
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
  const completed = member.benefit_status === 'redeemed';
  if (view === 'pending') return !completed && !member.contacted_at;
  if (view === 'follow_up') return !completed && (isDue(member, now) || member.workflow_status === 'follow_up_scheduled');
  if (view === 'contacted') return Boolean(member.contacted_at);
  if (view === 'responded') return Boolean(member.responded_at);
  if (view === 'launched') return Boolean(member.play_launched_at);
  if (view === 'converted') return completed || member.workflow_status === 'converted';
  return true;
}

function sortMembers(left: MemberRow, right: MemberRow, now: number) {
  const leftDue = isDue(left, now) ? 0 : 1;
  const rightDue = isDue(right, now) ? 0 : 1;
  if (leftDue !== rightDue) return leftDue - rightDue;

  const leftPending = left.contacted_at ? 1 : 0;
  const rightPending = right.contacted_at ? 1 : 0;
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
    .select(`
      id, name, description, status, rules_snapshot, advisor_guidance,
      starts_at, ends_at, gift_product_id, gift_quantity,
      benefit_selection_mode, purchase_requirement_mode, minimum_order_amount_usd
    `)
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

  const [membersResult, benefitOptionsResult, benefitUpgradesResult] = await Promise.all([
    ctx.supabase
      .from('crm_play_members')
      .select(`
        id, play_id, client_id, workflow_status, benefit_status, purchase_count,
        days_since_last_purchase, contact_attempt_count,
        contacted_at, responded_at, play_launched_at, next_follow_up_at,
        client:clients(id, full_name)
      `)
      .eq('play_id', Number(selectedPlay.id))
      .eq('advisor_id_snapshot', ctx.user.id)
      .order('id', { ascending: true })
      .limit(500),
    ctx.supabase
      .from('crm_play_benefits')
      .select('id, quantity, unit_benefit_value_usd, unit_advisor_cost_usd, product:products!crm_play_benefits_product_id_fkey(name)')
      .eq('play_id', Number(selectedPlay.id))
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    ctx.supabase
      .from('crm_play_benefit_upgrades')
      .select(`
        id, play_benefit_id, target_quantity, customer_difference_usd_snapshot,
        product:products!crm_play_benefit_upgrades_target_product_id_fkey(name)
      `)
      .eq('play_id', Number(selectedPlay.id))
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
  ]);

  if (membersResult.error) console.error('Unable to load advisor CRM play members', membersResult.error.message);
  const members = (membersResult.data ?? []) as unknown as MemberRow[];

  if (benefitOptionsResult.error) console.error('Unable to load CRM play benefits', benefitOptionsResult.error.message);
  if (benefitUpgradesResult.error) console.error('Unable to load CRM play benefit upgrades', benefitUpgradesResult.error.message);
  const upgradesByBenefit = new Map<number, BenefitUpgrade[]>();
  for (const row of (benefitUpgradesResult.data ?? []) as unknown as BenefitUpgradeRow[]) {
    const benefitId = numberValue(row.play_benefit_id);
    const upgrades = upgradesByBenefit.get(benefitId) ?? [];
    upgrades.push({
      id: numberValue(row.id),
      quantity: numberValue(row.target_quantity),
      customerDifferenceUsd: numberValue(row.customer_difference_usd_snapshot),
      name: one(row.product)?.name?.trim() || 'Ampliación',
    });
    upgradesByBenefit.set(benefitId, upgrades);
  }
  const benefitOptions: BenefitOption[] = ((benefitOptionsResult.data ?? []) as unknown as BenefitRow[]).map((option) => ({
    id: numberValue(option.id),
    quantity: numberValue(option.quantity),
    benefitValueUsd: numberValue(option.unit_benefit_value_usd) * numberValue(option.quantity),
    advisorCostUsd: numberValue(option.unit_advisor_cost_usd) * numberValue(option.quantity),
    name: one(option.product)?.name?.trim() || 'Beneficio',
    upgrades: upgradesByBenefit.get(numberValue(option.id)) ?? [],
  }));
  const selectionCriteria = playCriteria(selectedPlay.rules_snapshot);
  const availableUpgrades = benefitOptions.flatMap((option) => option.upgrades);

  // This is a server-only request snapshot used to classify due follow-ups consistently.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const pendingCount = members.filter((member) => member.benefit_status !== 'redeemed' && !member.contacted_at).length;
  const contactedCount = members.filter((member) => Boolean(member.contacted_at)).length;
  const respondedCount = members.filter((member) => Boolean(member.responded_at)).length;
  const launchedCount = members.filter((member) => Boolean(member.play_launched_at)).length;
  const convertedCount = members.filter((member) => member.benefit_status === 'redeemed' || member.workflow_status === 'converted').length;
  const visibleMembers = members
    .filter((member) => memberMatchesView(member, view, now))
    .sort((left, right) => sortMembers(left, right, now));
  const currentHref = playsHref(numberValue(selectedPlay.id), view);
  const filters: Array<{ value: ViewFilter; label: string; count: number }> = [
    { value: 'all', label: 'Todos', count: members.length },
    { value: 'pending', label: 'Sin tocar', count: pendingCount },
    { value: 'follow_up', label: 'Seguimientos', count: members.filter((member) => member.benefit_status !== 'redeemed' && (member.workflow_status === 'follow_up_scheduled' || isDue(member, now))).length },
    { value: 'contacted', label: 'Contactados', count: contactedCount },
    { value: 'responded', label: 'Respondieron', count: respondedCount },
    { value: 'launched', label: 'Lanzadas', count: launchedCount },
    { value: 'converted', label: 'Aplicados', count: convertedCount },
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
            {benefitOptions.length === 1
              ? `${benefitOptions[0]?.quantity.toLocaleString('es-VE')} × ${benefitOptions[0]?.name}`
              : selectedPlay.benefit_selection_mode === 'multiple'
                ? `${benefitOptions.length} opciones · uno o varios`
                : `${benefitOptions.length} alternativas · se entrega 1`}
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-[#AAB2C5]">
          {selectedPlay.description?.trim() || 'Reconocimiento preparado para este grupo de clientes.'}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] text-[#AAB2C5]">
          <span className="rounded-full border border-[#2A3040] px-2 py-0.5">
            {selectedPlay.purchase_requirement_mode === 'minimum_order'
              ? `Compra mínima $${numberValue(selectedPlay.minimum_order_amount_usd).toFixed(2)}`
              : 'Sin compra mínima'}
          </span>
          <span className="rounded-full border border-[#31513F] bg-[#10251A] px-2 py-0.5 font-semibold text-[#7CE0A9]">
            {benefitCreditLabel(benefitOptions, selectedPlay.benefit_selection_mode)}
          </span>
          <span className="rounded-full border border-[#2A3040] px-2 py-0.5">
            Cargo según selección: {benefitOptions.length === 0
              ? '$0.00'
              : selectedPlay.benefit_selection_mode === 'multiple'
                ? `hasta $${benefitOptions.reduce((sum, option) => sum + option.advisorCostUsd, 0).toFixed(2)}`
                : `$${Math.min(...benefitOptions.map((option) => option.advisorCostUsd)).toFixed(2)}–$${Math.max(...benefitOptions.map((option) => option.advisorCostUsd)).toFixed(2)}`}
          </span>
        </div>

        {availableUpgrades.length > 0 ? (
          <div className="mt-2 flex min-w-0 items-start gap-1.5 rounded-[9px] border border-[#2A3040] bg-[#0D1017] px-2 py-1.5 text-[9px] leading-4">
            <span className="shrink-0 font-semibold uppercase tracking-[0.08em] text-[#F7DA66]">Ampliable</span>
            <span className="min-w-0 text-[#B7BECC]">
              {availableUpgrades.map((upgrade) => (
                `${upgrade.name} +$${upgrade.customerDifferenceUsd.toFixed(2)}`
              )).join(' · ')} · paga el cliente
            </span>
          </div>
        ) : null}

        <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
          <details className="group rounded-[10px] border border-[#2A3040] bg-[#0D1017] open:border-[#3B4355] sm:open:col-span-3">
            <summary className="flex h-8 cursor-pointer list-none items-center justify-between gap-2 px-2.5 text-[10px] font-semibold text-[#D6DAE4] [&::-webkit-details-marker]:hidden">
              <span>Quiénes aplican</span>
              <span className="text-[#747E91] transition group-open:rotate-180" aria-hidden="true">⌄</span>
            </summary>
            <div className="border-t border-[#232632] px-2.5 py-2">
              <p className="mb-1.5 text-[9px] text-[#747E91]">Estos clientes quedaron seleccionados por:</p>
              <div className="flex flex-wrap gap-1.5">
                {(selectionCriteria.length > 0 ? selectionCriteria : ['Criterios definidos por la administración']).map((criterion) => (
                  <span key={criterion} className="rounded-full border border-[#343A48] bg-[#151923] px-2 py-1 text-[9px] text-[#C5CBD8]">
                    {criterion}
                  </span>
                ))}
              </div>
            </div>
          </details>

          <details className="group rounded-[10px] border border-[#2A3040] bg-[#0D1017] open:border-[#3B4355] sm:open:col-span-3">
            <summary className="flex h-8 cursor-pointer list-none items-center justify-between gap-2 px-2.5 text-[10px] font-semibold text-[#D6DAE4] [&::-webkit-details-marker]:hidden">
              <span>Beneficio y uso</span>
              <span className="text-[#747E91] transition group-open:rotate-180" aria-hidden="true">⌄</span>
            </summary>
            <div className="space-y-1.5 border-t border-[#232632] px-2.5 py-2">
              {benefitOptions.length === 0 ? (
                <p className="text-[9px] text-[#8B93A7]">La jugada no tiene beneficios configurados.</p>
              ) : benefitOptions.map((option) => (
                <div key={option.id} className="rounded-[8px] border border-[#292E3B] bg-[#121620] px-2 py-1.5 text-[9px] text-[#C5CBD8]">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="font-semibold text-[#F5F7FB]">{option.quantity.toLocaleString('es-VE')} × {option.name}</span>
                    <span>Crédito ${option.benefitValueUsd.toFixed(2)} · cargo ${option.advisorCostUsd.toFixed(2)}</span>
                  </div>
                  {option.upgrades.length > 0 ? (
                    <p className="mt-1 text-[#9FA8BA]">
                      Puede entregar el base o aplicar el crédito a {option.upgrades.map((upgrade) => (
                        `${upgrade.name} (+$${upgrade.customerDifferenceUsd.toFixed(2)})`
                      )).join(' · ')}. La diferencia la paga el cliente.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </details>

          <details className="group rounded-[10px] border border-[#2A3040] bg-[#0D1017] open:border-[#3B4355] sm:open:col-span-3">
            <summary className="flex h-8 cursor-pointer list-none items-center justify-between gap-2 px-2.5 text-[10px] font-semibold text-[#D6DAE4] [&::-webkit-details-marker]:hidden">
              <span>Cómo abordarla</span>
              <span className="text-[#747E91] transition group-open:rotate-180" aria-hidden="true">⌄</span>
            </summary>
            <p className="whitespace-pre-line border-t border-[#232632] px-2.5 py-2 text-[9px] leading-4 text-[#B7BECC]">
              {selectedPlay.advisor_guidance?.trim() || 'Realiza un contacto cercano y presenta el beneficio según la indicación de la jugada.'}
            </p>
          </details>
        </div>
      </section>

      <div className="grid grid-cols-4 gap-1.5">
        <CompactStat label="Total" value={members.length} />
        <CompactStat label="Pendientes" value={pendingCount} />
        <CompactStat label="Lanzadas" value={launchedCount} />
        <CompactStat label="Aplicados" value={convertedCount} />
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
            const presentation = workflowPresentation(
              member.workflow_status,
              due,
              member.benefit_status,
              member.contacted_at,
              member.responded_at,
              member.play_launched_at,
            );
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
