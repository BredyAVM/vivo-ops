import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { calculateAdvisorGoalScore, type AdvisorGoalMetricKey } from '@/lib/commissions/goal-engine';
import {
  readAdvisorGoalPeriodConfig,
  readAdvisorGoalPublicationSnapshot,
  resolveAdvisorGoalScoringConfiguration,
  type AdvisorGoalMetricPublication,
} from '@/lib/commissions/goal-snapshot';
import {
  loadAdvisorGoalCollectionForClosure,
  loadAdvisorGoalCurrentCollection,
  loadAdvisorGoalCurrentCommercialMetric,
} from '@/lib/commissions/goal-data';
import { AdvisorGoalCollectionBreakdown } from '@/app/app/commissions/AdvisorGoalCollectionBreakdown';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';
import { AdvisorGoalLiveRefresh } from './AdvisorGoalLiveRefresh';

type CommissionDetail =
  | 'sales'
  | 'orders'
  | 'commissions'
  | 'commission-normal'
  | 'commission-special-items'
  | 'commission-special-orders'
  | 'closures'
  | 'paid'
  | 'late'
  | 'pending'
  | 'clients'
  | 'clients-own'
  | 'clients-assigned'
  | 'gifts'
  | 'deductions'
  | 'deductions-direct'
  | 'deductions-gifts'
  | 'payable';

type SearchParams = Promise<{ period?: string; detail?: string }>;

type PeriodRow = {
  id: number | string;
  name: string;
  date_from: string;
  date_to: string;
  status: string;
  goal_config?: unknown;
};

type SnapshotOrder = {
  orderId?: number | string | null;
  orderNumber?: string | null;
  clientName?: string | null;
  deliveryDate?: string | null;
  totalUsd?: number | string | null;
  confirmedPaidUsd?: number | string | null;
  pendingUsd?: number | string | null;
  regularBaseUsd?: number | string | null;
  specialItemBaseUsd?: number | string | null;
  specialOrderBaseUsd?: number | string | null;
  commissionUsd?: number | string | null;
  commissionMode?: string | null;
  paymentCompletedDate?: string | null;
  paymentTiming?: 'punctual' | 'late' | 'pending' | null;
};

type SnapshotProduct = {
  orderId?: number | string | null;
  orderNumber?: string | null;
  clientName?: string | null;
  productName?: string | null;
  productType?: string | null;
  qty?: number | string | null;
  lineBaseUsd?: number | string | null;
  commissionMode?: string | null;
  commissionValue?: number | string | null;
};

type SnapshotGift = SnapshotProduct & {
  clientName?: string | null;
  deductionUsd?: number | string | null;
  crmPlayName?: string | null;
  companyCostUsd?: number | string | null;
};

type SnapshotClient = {
  clientId?: number | string | null;
  clientName?: string | null;
  clientType?: string | null;
  orderId?: number | string | null;
  orderNumber?: string | null;
  billedUsd?: number | string | null;
  totalUsd?: number | string | null;
  createdAt?: string | null;
};

type DeductionRow = {
  id: number | string;
  deduction_type: string | null;
  description: string | null;
  amount_usd: number | string | null;
  order_id: number | string | null;
  notes: string | null;
};

type ClosureRow = {
  id: number | string;
  status: string;
  base_commission_pct: number | string;
  delivered_orders_count: number | string;
  billed_usd: number | string;
  regular_base_usd: number | string;
  special_item_base_usd: number | string;
  special_order_base_usd: number | string;
  gross_commission_usd: number | string;
  pending_collection_usd: number | string;
  punctual_paid_count: number | string;
  late_paid_count: number | string;
  pending_payment_count: number | string;
  new_own_clients_count: number | string;
  new_assigned_clients_count: number | string;
  gift_deductions_usd: number | string;
  manual_deductions_usd: number | string;
  payable_usd: number | string;
  generated_at: string | null;
  closed_at: string | null;
  paid_at: string | null;
  snapshot: {
    orders?: SnapshotOrder[];
    paid_orders?: SnapshotOrder[];
    punctual_orders?: SnapshotOrder[];
    late_orders?: SnapshotOrder[];
    pending_orders?: SnapshotOrder[];
    new_clients?: SnapshotClient[];
    products?: SnapshotProduct[];
    gifts?: SnapshotGift[];
    advisorGoal?: unknown;
  } | null;
  deductions: DeductionRow[] | null;
};

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
  return `$${numberValue(value).toFixed(2)}`;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function concisePercent(value: number) {
  return `${new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(value)}%`;
}

function caracasDayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Caracas',
  }).format(new Date());
}

function dateOnlyDistance(from: string, to: string) {
  const fromTime = Date.parse(`${from.slice(0, 10)}T12:00:00Z`);
  const toTime = Date.parse(`${to.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 0;
  return Math.round((toTime - fromTime) / 86_400_000);
}

function periodProgress(dateFrom: string, dateTo: string, isFinal: boolean) {
  if (isFinal) {
    return { phase: 'final' as const, label: 'Resultado cerrado' };
  }

  const today = caracasDayKey();
  if (today < dateFrom) {
    const days = Math.max(1, dateOnlyDistance(today, dateFrom));
    return { phase: 'upcoming' as const, label: days === 1 ? 'Comienza mañana' : `Comienza en ${days} días` };
  }
  if (today > dateTo) {
    return { phase: 'ended' as const, label: 'Período finalizado · en revisión' };
  }

  const days = Math.max(0, dateOnlyDistance(today, dateTo));
  return { phase: 'active' as const, label: days === 0 ? 'Último día del período' : `Quedan ${days} días` };
}

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Sin fecha';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00-04:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: 'short', year: 'numeric' }).format(parsed);
}

function closureStatus(status: string) {
  if (status === 'paid') return { label: 'Pagada', tone: 'success' as const };
  if (status === 'closed') return { label: 'Cerrada', tone: 'warning' as const };
  return { label: 'Preliminar', tone: 'neutral' as const };
}

function orderLabel(order: SnapshotOrder) {
  const id = numberValue(order.orderId);
  return id > 0 ? formatOrderDisplayNumber(id) : 'Sin número';
}

function commissionModeLabel(value: string | null | undefined) {
  if (value === 'fixed_order') return 'Orden especial';
  if (value === 'mixed_items') return 'Ítems especiales';
  if (value === 'fixed_item') return 'Ítem especial';
  return 'Normal';
}

function groupCommissionProducts(rows: SnapshotProduct[], fallbackPct: number) {
  const grouped = new Map<
    string,
    {
      name: string;
      pct: number;
      qty: number;
      baseUsd: number;
      commissionUsd: number;
      orders: Set<number>;
    }
  >();

  for (const row of rows) {
    const name = String(row.productName || 'Producto').trim();
    const pct = numberValue(row.commissionValue) > 0 ? numberValue(row.commissionValue) : fallbackPct;
    const key = `${name.toLocaleLowerCase('es')}::${pct}`;
    const current = grouped.get(key) ?? {
      name,
      pct,
      qty: 0,
      baseUsd: 0,
      commissionUsd: 0,
      orders: new Set<number>(),
    };
    const lineBaseUsd = numberValue(row.lineBaseUsd);
    current.qty += numberValue(row.qty);
    current.baseUsd += lineBaseUsd;
    current.commissionUsd += lineBaseUsd * (pct / 100);
    const orderId = numberValue(row.orderId);
    if (orderId > 0) current.orders.add(orderId);
    grouped.set(key, current);
  }

  return Array.from(grouped.values()).sort(
    (a, b) => b.commissionUsd - a.commissionUsd || a.name.localeCompare(b.name, 'es')
  );
}

function getCommissionDetail(value: string | null | undefined): CommissionDetail | null {
  const details: CommissionDetail[] = [
    'sales',
    'orders',
    'commissions',
    'commission-normal',
    'commission-special-items',
    'commission-special-orders',
    'closures',
    'paid',
    'late',
    'pending',
    'clients',
    'clients-own',
    'clients-assigned',
    'gifts',
    'deductions',
    'deductions-direct',
    'deductions-gifts',
    'payable',
  ];
  return details.includes(value as CommissionDetail) ? (value as CommissionDetail) : null;
}

function commissionHref(periodId: number | string, detail?: CommissionDetail) {
  return `/app/advisor/commissions?period=${periodId}${detail ? `&detail=${detail}#commission-detail` : ''}`;
}

function CommissionSummaryLink({
  label,
  value,
  detail,
  href,
  active,
}: {
  label: string;
  value: string;
  detail: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex min-h-[132px] flex-col rounded-[20px] border bg-[#12151D] px-3.5 py-3 transition active:scale-[0.99]',
        active ? 'border-[#F0D000] ring-1 ring-[#F0D000]' : 'border-[#232632]',
      ].join(' ')}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8B93A7]">{label}</div>
      <div className="mt-2 text-[24px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">{value}</div>
      <div className="mt-1 text-[11px] leading-4 text-[#AAB2C5]">{detail}</div>
      <div className="mt-auto flex items-center justify-between pt-2 text-[11px] font-semibold text-[#F7DA66]">
        <span>Ver detalle</span>
        <span aria-hidden="true">→</span>
      </div>
    </Link>
  );
}

function goalValue(key: AdvisorGoalMetricKey, value: number) {
  if (key === 'billing') return money(value);
  if (key === 'collection') return `${(value * 100).toFixed(1)}%`;
  return numberValue(value).toFixed(0);
}

function goalMetricGapLabel(key: AdvisorGoalMetricKey, actual: number, target: number) {
  const gap = target - actual;
  if (gap > 0.0005) {
    if (key === 'billing') return `Faltan ${money(gap)}`;
    if (key === 'collection') return `Faltan ${(gap * 100).toFixed(1)} puntos porcentuales`;
    const units = Math.max(1, Math.ceil(gap));
    if (key === 'closures') return `Faltan ${units} cierre${units === 1 ? '' : 's'}`;
    return `Faltan ${units} cliente${units === 1 ? '' : 's'}`;
  }
  if (target > 0 && actual > target + 0.0005) {
    return `Sobrecumplimiento +${Math.round((actual / target - 1) * 100)}%`;
  }
  return 'Meta alcanzada';
}

function GoalMetricProgress({
  metricKey,
  label,
  metric,
  points,
  basePoints,
}: {
  metricKey: AdvisorGoalMetricKey;
  label: string;
  metric: AdvisorGoalMetricPublication;
  points: number;
  basePoints: number;
}) {
  const progress = metric.target > 0 ? Math.max(0, Math.min(100, metric.actual / metric.target * 100)) : 0;
  const reached = metric.target > 0 && metric.actual >= metric.target;
  return (
    <details className="rounded-[16px] border border-[#252A37] bg-[#0D1017] px-3 py-3">
      <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">{label}</div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-[#F5F7FB]">{goalValue(metricKey, metric.actual)}</span>
              <span className="text-[11px] text-[#8B93A7]">de {goalValue(metricKey, metric.target)}</span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xs font-semibold text-[#F7DA66]">{points.toFixed(1)} pts</div>
            <div className="mt-0.5 text-[10px] text-[#8B93A7]">base {basePoints}</div>
          </div>
        </div>
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-[#252A37]">
          <div
            aria-label={`Avance de ${label}: ${progress.toFixed(0)}%`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(progress)}
            className={`h-full rounded-full ${reached ? 'bg-emerald-400' : 'bg-[#F0D000]'}`}
            role="progressbar"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className={`mt-1.5 text-[10px] font-semibold ${reached ? 'text-emerald-300' : 'text-[#C9BE76]'}`}>
          {goalMetricGapLabel(metricKey, metric.actual, metric.target)}
        </div>
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#252A37] pt-3 text-xs">
        <div className="rounded-[12px] bg-[#12151D] p-2.5">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#7F879A]">1 · Referencia personal</div>
          <div className="mt-1 font-semibold text-[#E8EBF2]">{goalValue(metricKey, metric.personalReference)}</div>
        </div>
        {metricKey === 'billing' || metricKey === 'closures' ? (
          <>
            <div className="rounded-[12px] bg-[#12151D] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#7F879A]">2 · Ajuste de temporada</div>
              <div className="mt-1 font-semibold text-[#E8EBF2]">{metric.appliedContextPct >= 0 ? '+' : ''}{concisePercent(metric.appliedContextPct)}</div>
              <div className="mt-0.5 text-[10px] text-[#7F879A]">capacidad {goalValue(metricKey, metric.expectedCapacity)}</div>
            </div>
            <div className="rounded-[12px] bg-[#12151D] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#7F879A]">3 · Campaña</div>
              <div className="mt-1 font-semibold text-[#E8EBF2]">+{concisePercent(metric.campaignBoostPct ?? 0)}</div>
              <div className="mt-0.5 text-[10px] text-[#7F879A]">proyección {goalValue(metricKey, metric.campaignCapacity ?? metric.expectedCapacity)}</div>
            </div>
            <div className="rounded-[12px] bg-[#12151D] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#7F879A]">4 · Desafío</div>
              <div className="mt-1 font-semibold text-[#E8EBF2]">+{concisePercent(metric.growthChallengePct)}</div>
            </div>
            <div className="col-span-2 rounded-[12px] border border-[#F0D000]/20 bg-[#17160E] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#A99C49]">5 · Tu meta</div>
              <div className="mt-1 font-semibold text-[#F7DA66]">{goalValue(metricKey, metric.target)}</div>
            </div>
          </>
        ) : metricKey === 'new_own_clients' || metricKey === 'new_assigned_clients' ? (
          <>
            <div className="rounded-[12px] bg-[#12151D] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#7F879A]">2 · Impulso</div>
              <div className="mt-1 font-semibold text-[#E8EBF2]">+1 cliente</div>
            </div>
            <div className="col-span-2 rounded-[12px] border border-[#F0D000]/20 bg-[#17160E] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#A99C49]">3 · Tu meta</div>
              <div className="mt-1 font-semibold text-[#F7DA66]">{goalValue(metricKey, metric.target)}</div>
            </div>
          </>
        ) : (
          <div className="rounded-[12px] border border-[#F0D000]/20 bg-[#17160E] p-2.5">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[#A99C49]">Meta ideal</div>
            <div className="mt-1 font-semibold text-[#F7DA66]">{goalValue(metricKey, metric.target)}</div>
          </div>
        )}
        <div className="col-span-2 text-[11px] leading-5 text-[#9FA7B9]">
          {metric.validPeriods.length > 0
            ? `Referencia calculada con ${metric.validPeriods.join(', ')}.${metric.recentContext ? ' La quincena inmediatamente anterior no altera la meta.' : ''}`
            : 'Cobranza: pago registrado hasta la entrega vale 100%, crédito de hasta cinco días vale 80% y atraso posterior vale 0%.'}
        </div>
        {metric.recentContext ? (
          <div className="col-span-2 flex items-center justify-between gap-3 rounded-[12px] border border-sky-400/20 bg-sky-400/5 px-2.5 py-2 text-[11px] text-sky-100">
            <span>{metric.recentContext.periodKey} · resultado reciente informativo</span>
            <span className="font-semibold">{goalValue(metricKey, metric.recentContext.value)}</span>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export default async function AdvisorCommissionsPage({ searchParams }: { searchParams?: SearchParams }) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('receives_commissions')
    .eq('id', ctx.user.id)
    .maybeSingle();
  if (profile?.receives_commissions !== true) redirect('/app/advisor');

  const params = (await searchParams) ?? {};
  const { data: periodData, error: periodError } = await ctx.supabase
    .from('advisor_commission_periods')
    .select('id, name, date_from, date_to, status, goal_config')
    .order('date_from', { ascending: false })
    .limit(40);

  const periods = (periodData ?? []) as PeriodRow[];
  const requestedPeriodId = Number(params.period || 0);
  const selectedPeriod = periods.find((period) => Number(period.id) === requestedPeriodId) ?? periods[0] ?? null;
  const goalScoring = resolveAdvisorGoalScoringConfiguration(
    readAdvisorGoalPeriodConfig(selectedPeriod?.goal_config)
  );
  const orderedGoalBands = [...goalScoring.bands].sort((left, right) => left.minPoints - right.minPoints);
  const topGoalBandPoints = orderedGoalBands.at(-1)?.minPoints ?? 1;
  const activeDetail = getCommissionDetail(params.detail);
  const returnTo = selectedPeriod
    ? commissionHref(selectedPeriod.id, activeDetail || undefined)
    : '/app/advisor/commissions';

  let closure: ClosureRow | null = null;
  let closureError: string | null = null;
  if (selectedPeriod) {
    const result = await ctx.supabase
      .from('advisor_commission_closures')
      .select(`
        id, status, base_commission_pct, delivered_orders_count, billed_usd,
        regular_base_usd, special_item_base_usd, special_order_base_usd,
        gross_commission_usd, pending_collection_usd, punctual_paid_count,
        late_paid_count, pending_payment_count, new_own_clients_count,
        new_assigned_clients_count, gift_deductions_usd, manual_deductions_usd,
        payable_usd, generated_at, closed_at, paid_at, snapshot,
        deductions:advisor_commission_deductions (
          id, deduction_type, description, amount_usd, order_id, notes
        )
      `)
      .eq('period_id', Number(selectedPeriod.id))
      .eq('advisor_user_id', ctx.user.id)
      .maybeSingle();

    closure = (result.data as ClosureRow | null) ?? null;
    closureError = result.error?.message ?? null;
  }

  const snapshot = closure?.snapshot ?? {};
  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  const pendingOrders = Array.isArray(snapshot.pending_orders) ? snapshot.pending_orders : [];
  const paidOrders = Array.isArray(snapshot.paid_orders) ? snapshot.paid_orders : [];
  const punctualOrders = Array.isArray(snapshot.punctual_orders)
    ? snapshot.punctual_orders
    : paidOrders.filter((order) => order.paymentTiming !== 'late');
  const lateOrders = Array.isArray(snapshot.late_orders)
    ? snapshot.late_orders
    : paidOrders.filter((order) => order.paymentTiming === 'late');
  const newClients = Array.isArray(snapshot.new_clients) ? snapshot.new_clients : [];
  const products = Array.isArray(snapshot.products) ? snapshot.products : [];
  const gifts = Array.isArray(snapshot.gifts) ? snapshot.gifts : [];
  const deductions = Array.isArray(closure?.deductions) ? closure.deductions : [];
  const ownClients = newClients.filter((client) => String(client.clientType || '').toLowerCase() === 'own');
  const assignedClients = newClients.filter((client) => String(client.clientType || '').toLowerCase() === 'assigned');
  const status = closure ? closureStatus(closure.status) : null;
  const storedGoal = readAdvisorGoalPublicationSnapshot(closure?.snapshot);
  const visibleGoal = storedGoal && storedGoal.status !== 'draft' ? storedGoal : null;
  let currentGoalCollection = null;
  let currentGoalCommercialMetric: Awaited<ReturnType<typeof loadAdvisorGoalCurrentCommercialMetric>> = null;
  let currentGoalObservedAt: string | null = null;
  if (visibleGoal && closure && selectedPeriod) {
    if (visibleGoal.status === 'final') {
      try {
        currentGoalCollection = await loadAdvisorGoalCollectionForClosure({
          supabase: ctx.supabase,
          advisorUserId: ctx.user.id,
          snapshot: closure.snapshot,
          periodTo: selectedPeriod.date_to,
        });
      } catch (error) {
        console.warn(
          'advisor final goal collection detail skipped',
          error instanceof Error ? error.message : 'unknown collection detail error'
        );
      }
    } else {
      const [commercialResult, collectionResult] = await Promise.allSettled([
        loadAdvisorGoalCurrentCommercialMetric({
          supabase: ctx.supabase,
          periodFrom: selectedPeriod.date_from,
          periodTo: selectedPeriod.date_to,
        }),
        loadAdvisorGoalCurrentCollection({
          supabase: ctx.supabase,
          advisorUserId: ctx.user.id,
          periodFrom: selectedPeriod.date_from,
          periodTo: selectedPeriod.date_to,
        }),
      ]);
      if (commercialResult.status === 'fulfilled') {
        currentGoalCommercialMetric = commercialResult.value;
        currentGoalObservedAt = commercialResult.value?.observedAt ?? null;
      } else {
        console.warn('advisor live commercial metric skipped', commercialResult.reason);
      }
      if (collectionResult.status === 'fulfilled') {
        currentGoalCollection = collectionResult.value;
        currentGoalObservedAt ??= new Date().toISOString();
      } else {
        console.warn('advisor live collection detail skipped', collectionResult.reason);
      }
    }
  }
  const currentGoalBilling = currentGoalCommercialMetric?.billingUsd ?? numberValue(closure?.billed_usd);
  const currentGoalClosures = currentGoalCommercialMetric?.closuresCount ?? numberValue(closure?.delivered_orders_count);
  const currentGoalOwnClients = currentGoalCommercialMetric?.newOwnClientsCount ?? numberValue(closure?.new_own_clients_count);
  const currentGoalAssignedClients = currentGoalCommercialMetric?.newAssignedClientsCount ?? numberValue(closure?.new_assigned_clients_count);
  const liveGoalScore = visibleGoal
    ? visibleGoal.status === 'final'
      ? visibleGoal.score
      : calculateAdvisorGoalScore([
          {
            key: 'billing',
            actual: currentGoalBilling,
            reference: visibleGoal.metrics.billing.personalReference,
            target: visibleGoal.metrics.billing.target,
            basePoints: goalScoring.metricBasePoints.billing,
          },
          {
            key: 'closures',
            actual: currentGoalClosures,
            reference: visibleGoal.metrics.closures.personalReference,
            target: visibleGoal.metrics.closures.target,
            basePoints: goalScoring.metricBasePoints.closures,
          },
          {
            key: 'collection',
            actual: currentGoalCollection?.ratio ?? visibleGoal.metrics.collection.actual,
            reference: visibleGoal.metrics.collection.personalReference,
            target: visibleGoal.metrics.collection.target,
            basePoints: goalScoring.metricBasePoints.collection,
          },
          {
            key: 'new_own_clients',
            actual: currentGoalOwnClients,
            reference: visibleGoal.metrics.new_own_clients.personalReference,
            target: visibleGoal.metrics.new_own_clients.target,
            basePoints: goalScoring.metricBasePoints.new_own_clients,
          },
          {
            key: 'new_assigned_clients',
            actual: currentGoalAssignedClients,
            reference: visibleGoal.metrics.new_assigned_clients.personalReference,
            target: visibleGoal.metrics.new_assigned_clients.target,
            basePoints: goalScoring.metricBasePoints.new_assigned_clients,
          },
        ], goalScoring.bands)
    : null;
  const liveGoalMetrics = visibleGoal && liveGoalScore
    ? visibleGoal.status === 'final'
      ? visibleGoal.metrics
      : {
        billing: { ...visibleGoal.metrics.billing, actual: currentGoalBilling },
        closures: { ...visibleGoal.metrics.closures, actual: currentGoalClosures },
        collection: {
          ...visibleGoal.metrics.collection,
          actual: currentGoalCollection?.ratio ?? visibleGoal.metrics.collection.actual,
        },
        new_own_clients: { ...visibleGoal.metrics.new_own_clients, actual: currentGoalOwnClients },
        new_assigned_clients: { ...visibleGoal.metrics.new_assigned_clients, actual: currentGoalAssignedClients },
        }
    : null;
  const goalPeriodProgress = selectedPeriod
    ? periodProgress(selectedPeriod.date_from, selectedPeriod.date_to, visibleGoal?.status === 'final')
    : null;
  const goalMetricRows = visibleGoal && liveGoalScore && liveGoalMetrics
    ? ([
        ['billing', 'Facturación', liveGoalMetrics.billing],
        ['closures', 'Cierres', liveGoalMetrics.closures],
        ['collection', 'Cobranza', liveGoalMetrics.collection],
        ['new_own_clients', 'Clientes propios', liveGoalMetrics.new_own_clients],
        ['new_assigned_clients', 'Clientes asignados', liveGoalMetrics.new_assigned_clients],
      ] as const).map(([key, label, metric]) => {
        const scoreMetric = liveGoalScore.metrics.find((item) => item.key === key);
        return {
          key,
          label,
          metric,
          basePoints: scoreMetric?.basePoints ?? 0,
          points: scoreMetric?.points ?? 0,
        };
      })
    : [];
  const achievedGoalMetrics = goalMetricRows.filter(({ metric }) => metric.target > 0 && metric.actual >= metric.target).length;
  const nextGoalBand = liveGoalScore && visibleGoal?.status !== 'final'
    ? orderedGoalBands.find((band) => band.minPoints > liveGoalScore.points) ?? null
    : null;
  const pointsToNextGoalBand = nextGoalBand && liveGoalScore
    ? Math.max(0, nextGoalBand.minPoints - liveGoalScore.points)
    : 0;
  const incompleteGoalMetrics = goalMetricRows.filter(({ metric }) => metric.target > 0 && metric.actual < metric.target);
  const focusGoalMetric = goalPeriodProgress?.phase === 'ended'
    ? incompleteGoalMetrics.find(({ key }) => key === 'collection') ?? null
    : [...incompleteGoalMetrics].sort(
        (left, right) =>
          Math.max(0, right.basePoints - right.points) - Math.max(0, left.basePoints - left.points)
      )[0] ?? null;
  const goalGuidance = visibleGoal?.status === 'final'
    ? `Cerraste con ${achievedGoalMetrics} de 5 metas alcanzadas. Este resultado ya no cambia con la actividad actual.`
    : goalPeriodProgress?.phase === 'ended'
      ? focusGoalMetric
        ? `El período comercial ya cerró. Revisa cobranza: ${goalMetricGapLabel(focusGoalMetric.key, focusGoalMetric.metric.actual, focusGoalMetric.metric.target).toLocaleLowerCase('es')}.`
        : 'El período comercial ya cerró y sus cinco metas están alcanzadas. Administración está consolidando el resultado.'
      : focusGoalMetric
        ? `${goalPeriodProgress?.phase === 'upcoming' ? 'Tu mayor palanca al comenzar' : 'Tu mayor oportunidad ahora'} es ${focusGoalMetric.label.toLocaleLowerCase('es')}: ${goalMetricGapLabel(focusGoalMetric.key, focusGoalMetric.metric.actual, focusGoalMetric.metric.target).toLocaleLowerCase('es')}. Puede sumar hasta ${Math.max(0, focusGoalMetric.basePoints - focusGoalMetric.points).toFixed(1)} puntos base adicionales.`
        : 'Ya alcanzaste las cinco metas. El sobrecumplimiento puede seguir sumando, con el límite configurado de 200% por indicador.';

  const giftsByName = new Map<string, { qty: number; deductionUsd: number; rows: SnapshotGift[] }>();
  for (const gift of gifts) {
    const name = String(gift.productName || 'Obsequio').trim();
    const playName = String(gift.crmPlayName || '').trim();
    const groupName = playName ? `${name} · ${playName}` : name;
    const current = giftsByName.get(groupName) ?? { qty: 0, deductionUsd: 0, rows: [] };
    current.qty += numberValue(gift.qty);
    current.deductionUsd += numberValue(gift.deductionUsd);
    current.rows.push(gift);
    giftsByName.set(groupName, current);
  }
  const giftQty = gifts.reduce((sum, gift) => sum + numberValue(gift.qty), 0);
  const baseCommissionPct = numberValue(closure?.base_commission_pct);
  const normalCommissionProducts = products.filter(
    (product) => String(product.commissionMode || 'default') === 'default' && numberValue(product.lineBaseUsd) > 0.005
  );
  const specialCommissionProducts = products.filter(
    (product) => String(product.commissionMode || '') === 'fixed_item' && numberValue(product.lineBaseUsd) > 0.005
  );
  const fixedCommissionOrders = orders.filter((order) => String(order.commissionMode || '') === 'fixed_order');
  const normalCommissionGroups = groupCommissionProducts(normalCommissionProducts, baseCommissionPct);
  const specialCommissionGroups = groupCommissionProducts(specialCommissionProducts, 0);
  const detailCommissionGroups =
    activeDetail === 'commission-special-items' ? specialCommissionGroups : normalCommissionGroups;
  const specialItemsCommissionUsd = roundMoney(
    specialCommissionProducts.reduce(
      (sum, product) =>
        sum + numberValue(product.lineBaseUsd) * (numberValue(product.commissionValue) / 100),
      0
    )
  );
  const specialOrdersCommissionUsd = roundMoney(
    fixedCommissionOrders.reduce((sum, order) => sum + numberValue(order.commissionUsd), 0)
  );
  const normalCommissionUsd = Math.max(
    0,
    roundMoney(numberValue(closure?.gross_commission_usd) - specialItemsCommissionUsd - specialOrdersCommissionUsd)
  );
  const totalDeductionsUsd = roundMoney(
    numberValue(closure?.gift_deductions_usd) + numberValue(closure?.manual_deductions_usd)
  );
  const punctualTotalUsd = punctualOrders.reduce((sum, order) => sum + numberValue(order.totalUsd), 0);
  const lateTotalUsd = lateOrders.reduce((sum, order) => sum + numberValue(order.totalUsd), 0);
  const orderById = new Map(orders.map((order) => [numberValue(order.orderId), order]));
  const getClientFirstOrderTotal = (client: SnapshotClient) =>
    numberValue(orderById.get(numberValue(client.orderId))?.totalUsd ?? client.totalUsd ?? client.billedUsd);
  const ownClientsTotalUsd = ownClients.reduce((sum, client) => sum + getClientFirstOrderTotal(client), 0);
  const assignedClientsTotalUsd = assignedClients.reduce((sum, client) => sum + getClientFirstOrderTotal(client), 0);
  const detailOrders =
    activeDetail === 'paid'
      ? punctualOrders
      : activeDetail === 'late'
        ? lateOrders
        : activeDetail === 'pending'
          ? pendingOrders
          : orders;
  const detailClients = activeDetail === 'clients-own' ? ownClients : assignedClients;
  const parentDetail: CommissionDetail | null =
    activeDetail === 'commission-normal' ||
    activeDetail === 'commission-special-items' ||
    activeDetail === 'commission-special-orders'
      ? 'commissions'
      : activeDetail === 'paid' || activeDetail === 'late' || activeDetail === 'pending'
        ? 'closures'
        : activeDetail === 'orders' || activeDetail === 'closures' || activeDetail === 'clients' || activeDetail === 'gifts'
          ? 'sales'
        : activeDetail === 'clients-own' || activeDetail === 'clients-assigned'
          ? 'clients'
          : activeDetail === 'deductions-direct' || activeDetail === 'deductions-gifts'
            ? 'deductions'
            : null;
  const detailTitle =
    activeDetail === 'sales'
      ? 'Detalle de ventas'
      : activeDetail === 'orders'
      ? 'Órdenes facturadas'
      : activeDetail === 'commissions'
        ? 'Comisión bruta'
        : activeDetail === 'commission-normal'
          ? 'Comisión normal'
          : activeDetail === 'commission-special-items'
            ? 'Ítems con comisión especial'
            : activeDetail === 'commission-special-orders'
              ? 'Órdenes con porcentaje fijo'
              : activeDetail === 'closures'
                ? 'Cierres de clientes'
                : activeDetail === 'paid'
                  ? 'Pagos puntuales'
                  : activeDetail === 'late'
                    ? 'Pagos impuntuales'
                  : activeDetail === 'pending'
                    ? 'Pendientes por cobrar'
                    : activeDetail === 'clients'
                      ? 'Clientes nuevos'
                      : activeDetail === 'clients-own'
                        ? 'Clientes nuevos propios'
                        : activeDetail === 'clients-assigned'
                          ? 'Clientes nuevos asignados'
                          : activeDetail === 'gifts' || activeDetail === 'deductions-gifts'
                              ? 'Obsequios entregados'
                              : activeDetail === 'deductions'
                                ? 'Deducibles aplicados'
                                : activeDetail === 'deductions-direct'
                                  ? 'Deducibles directos'
                                  : activeDetail === 'payable'
                                    ? 'Monto a pagar'
                                    : '';

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Resultados"
        title="Mis comisiones"
        description="Consulta el cierre generado por administración. Esta vista no modifica porcentajes, órdenes ni deducciones."
      />

      <SectionCard title="Período" subtitle="Selecciona el cierre que quieres revisar.">
        {periodError ? (
          <EmptyBlock title="No se pudieron cargar los períodos" detail={periodError.message} />
        ) : periods.length === 0 ? (
          <EmptyBlock title="Sin períodos" detail="Administración todavía no ha creado períodos de comisión." />
        ) : (
          <form className="grid grid-cols-[1fr_auto] gap-2" action="/app/advisor/commissions" method="get">
            <select
              name="period"
              defaultValue={String(selectedPeriod?.id || '')}
              className="h-11 min-w-0 rounded-[14px] border border-[#2A3040] bg-[#0D1017] px-3 text-sm text-[#F5F7FB]"
            >
              {periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.name} · {dateLabel(period.date_from)} al {dateLabel(period.date_to)}
                </option>
              ))}
            </select>
            <button className="h-11 rounded-[14px] bg-[#F0D000] px-4 text-sm font-semibold text-[#17191E]" type="submit">
              Ver
            </button>
          </form>
        )}
      </SectionCard>

      {closureError ? (
        <EmptyBlock title="No se pudo cargar el cierre" detail={closureError} />
      ) : selectedPeriod && !closure ? (
        <EmptyBlock
          title="Cierre todavía no generado"
          detail={`El período ${selectedPeriod.name} existe, pero administración aún no ha generado tu resultado.`}
        />
      ) : closure && selectedPeriod ? (
        <>
          <div className="flex items-center justify-between gap-3 rounded-[18px] border border-[#232632] bg-[#0D1017] px-3.5 py-3">
            <div>
              <div className="text-sm font-semibold text-[#F5F7FB]">{selectedPeriod.name}</div>
              <div className="mt-1 text-xs text-[#8B93A7]">{dateLabel(selectedPeriod.date_from)} al {dateLabel(selectedPeriod.date_to)}</div>
            </div>
            {status ? <StatusBadge label={status.label} tone={status.tone} /> : null}
          </div>

          {visibleGoal && liveGoalScore && liveGoalMetrics ? (
            <SectionCard
              title="Mi meta"
              subtitle={visibleGoal.publicationMessage || 'Tu avance se compara con tu propia capacidad, la temporada, la campaña y el desafío de este período.'}
              action={<StatusBadge label={visibleGoal.status === 'final' ? 'Resultado final' : 'Publicada'} tone={visibleGoal.status === 'final' ? 'success' : 'neutral'} />}
            >
              <div className="rounded-[18px] border border-[#4C4315] bg-[#1A180B] p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#A59A62]">Puntaje actual</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-[30px] font-semibold tracking-[-0.05em] text-[#F7DA66]">{liveGoalScore.points.toFixed(1)}</span>
                      <span className="text-xs text-[#AFA679]">puntos</span>
                    </div>
                    <div className="mt-1 text-xs font-medium text-[#E9E3C1]">Nivel {liveGoalScore.band.label}</div>
                  </div>
                  <div className="rounded-[14px] border border-[#F0D000]/35 bg-[#F0D000]/10 px-3 py-2 text-right">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-[#AFA679]">{visibleGoal.status === 'final' ? 'Comisión final' : 'Si cerrara hoy'}</div>
                    <div className="mt-0.5 text-xl font-bold text-[#F7DA66]">{(visibleGoal.status === 'final' ? visibleGoal.appliedCommissionPct : liveGoalScore.calculatedCommissionPct).toFixed(2)}%</div>
                  </div>
                </div>
                <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#302C16]">
                  <div className="h-full rounded-full bg-[#F0D000]" style={{ width: `${Math.max(0, Math.min(100, liveGoalScore.points / topGoalBandPoints * 100))}%` }} />
                </div>
                <div className="mt-2 grid grid-cols-5 gap-1 text-center text-[9px] leading-3 text-[#9F966A]">
                  {orderedGoalBands.map((band) => (
                    <span key={band.key}>
                      <span className="block">{band.label}</span>
                      <span className="block">{band.minPoints}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-[14px] border border-[#2A3040] bg-[#0D1017] px-3 py-2.5">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#7F879A]">
                    {visibleGoal.status === 'final' ? 'Metas logradas' : 'Próximo nivel'}
                  </div>
                  <div className="mt-1 text-sm font-semibold text-[#F5F7FB]">
                    {visibleGoal.status === 'final'
                      ? `${achievedGoalMetrics} de 5`
                      : nextGoalBand
                        ? nextGoalBand.label
                        : 'Nivel máximo'}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-4 text-[#9FA7B9]">
                    {visibleGoal.status === 'final'
                      ? `Nivel ${liveGoalScore.band.label} confirmado`
                      : nextGoalBand
                        ? `Faltan ${pointsToNextGoalBand.toFixed(1)} pts · ${nextGoalBand.commissionPct.toFixed(2)}%`
                        : `${liveGoalScore.band.label} · ${liveGoalScore.calculatedCommissionPct.toFixed(2)}%`}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#2A3040] bg-[#0D1017] px-3 py-2.5">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#7F879A]">Tiempo del período</div>
                  <div className="mt-1 text-sm font-semibold text-[#F5F7FB]">{goalPeriodProgress?.label}</div>
                  <div className="mt-0.5 text-[10px] leading-4 text-[#9FA7B9]">
                    Hasta {dateLabel(selectedPeriod.date_to)}
                  </div>
                </div>
              </div>

              <div className="mt-2 rounded-[14px] border border-sky-400/20 bg-sky-400/5 px-3 py-2.5">
                <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-sky-300">
                  {visibleGoal.status === 'final'
                    ? 'Lectura del resultado'
                    : goalPeriodProgress?.phase === 'ended'
                      ? 'En revisión'
                      : 'Tu siguiente movimiento'}
                </div>
                <p className="mt-1 text-[11px] leading-5 text-sky-100">{goalGuidance}</p>
              </div>

              {visibleGoal.status !== 'final' && currentGoalObservedAt ? (
                <AdvisorGoalLiveRefresh observedAt={currentGoalObservedAt} />
              ) : null}

              <div className="mt-3 space-y-2.5">
                {goalMetricRows.map(({ key, label, metric, basePoints, points }) => (
                  <GoalMetricProgress
                    basePoints={basePoints}
                    key={key}
                    label={label}
                    metric={metric}
                    metricKey={key}
                    points={points}
                  />
                ))}
              </div>

              {currentGoalCollection ? (
                <div className="mt-3">
                  <AdvisorGoalCollectionBreakdown
                    basePoints={liveGoalScore.metrics.find((metric) => metric.key === 'collection')?.basePoints}
                    points={liveGoalScore.metrics.find((metric) => metric.key === 'collection')?.points}
                    summary={currentGoalCollection}
                  />
                </div>
              ) : null}

              <details className="mt-3 rounded-[16px] border border-[#252A37] bg-[#0D1017] px-3 py-3">
                <summary className="cursor-pointer text-xs font-semibold text-[#D9DDE7]">¿Cómo se calculó?</summary>
                <p className="mt-2 border-t border-[#252A37] pt-2 text-[11px] leading-5 text-[#9FA7B9]">{visibleGoal.explanation}</p>
              </details>
            </SectionCard>
          ) : null}

          <section className="grid grid-cols-2 gap-3">
            <CommissionSummaryLink
              label="Ventas"
              value={money(closure.billed_usd)}
              detail={`${closure.delivered_orders_count} órdenes entregadas`}
              href={commissionHref(selectedPeriod.id, 'sales')}
              active={
                activeDetail === 'sales' ||
                activeDetail === 'orders' ||
                activeDetail === 'closures' ||
                activeDetail === 'paid' ||
                activeDetail === 'late' ||
                activeDetail === 'pending' ||
                activeDetail === 'clients' ||
                activeDetail === 'clients-own' ||
                activeDetail === 'clients-assigned' ||
                activeDetail === 'gifts'
              }
            />
            <CommissionSummaryLink
              label="Comisión bruta"
              value={money(closure.gross_commission_usd)}
              detail={`Normal y especiales · Base ${baseCommissionPct.toFixed(2)}%`}
              href={commissionHref(selectedPeriod.id, 'commissions')}
              active={
                activeDetail === 'commissions' ||
                activeDetail === 'commission-normal' ||
                activeDetail === 'commission-special-items' ||
                activeDetail === 'commission-special-orders'
              }
            />
            <CommissionSummaryLink
              label="Deducibles"
              value={money(totalDeductionsUsd)}
              detail={`${money(closure.gift_deductions_usd)} obsequios + ${money(closure.manual_deductions_usd)} directos`}
              href={commissionHref(selectedPeriod.id, 'deductions')}
              active={
                activeDetail === 'deductions' ||
                activeDetail === 'deductions-direct' ||
                activeDetail === 'deductions-gifts'
              }
            />
            <CommissionSummaryLink
              label="A pagar"
              value={money(closure.payable_usd)}
              detail={closure.status === 'paid' ? 'Pago registrado' : 'Comisión menos deducibles'}
              href={commissionHref(selectedPeriod.id, 'payable')}
              active={activeDetail === 'payable'}
            />
          </section>

          {activeDetail ? (
            <div id="commission-detail" className="scroll-mt-20">
              <SectionCard
                title={detailTitle}
                subtitle="Detalle de solo lectura del cierre seleccionado."
                action={
                  <Link
                    href={commissionHref(selectedPeriod.id, parentDetail || undefined)}
                    className="inline-flex h-9 items-center rounded-[12px] border border-[#2A3040] px-3 text-xs font-medium text-[#F5F7FB]"
                  >
                    {parentDetail ? 'Volver' : 'Cerrar'}
                  </Link>
                }
              >
              {activeDetail === 'sales' ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <Link
                    href={commissionHref(selectedPeriod.id, 'orders')}
                    className="rounded-[16px] border border-[#314A74] bg-[#101827] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Facturación</div>
                    <div className="mt-1.5 text-xl font-semibold text-[#F5F7FB]">{money(closure.billed_usd)}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{closure.delivered_orders_count} órdenes</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver órdenes</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'closures')}
                    className="rounded-[16px] border border-emerald-500/40 bg-[#102219] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Cierres</div>
                    <div className="mt-1.5 text-xl font-semibold text-[#F5F7FB]">{orders.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">Puntuales, tarde y pendientes</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver cobros</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'clients')}
                    className="rounded-[16px] border border-[#314A74] bg-[#101827] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Clientes nuevos</div>
                    <div className="mt-1.5 text-xl font-semibold text-[#F5F7FB]">{newClients.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{ownClients.length} propios · {assignedClients.length} asignados</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver clientes</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'gifts')}
                    className="rounded-[16px] border border-orange-500/40 bg-[#21150D] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Obsequios</div>
                    <div className="mt-1.5 text-xl font-semibold text-orange-300">{giftQty}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">-{money(closure.gift_deductions_usd)}</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver obsequios</span><span>→</span></div>
                  </Link>
                </div>
              ) : null}

              {activeDetail === 'commissions' ? (
                <div className="space-y-2.5">
                  <Link
                    href={commissionHref(selectedPeriod.id, 'commission-normal')}
                    className="block rounded-[16px] border border-[#314A74] bg-[#101827] px-3 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[#F5F7FB]">Comisión normal</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">{normalCommissionProducts.reduce((sum, row) => sum + numberValue(row.qty), 0)} ítems · {baseCommissionPct.toFixed(2)}%</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-[#F7DA66]">{money(normalCommissionUsd)}</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">Base {money(closure.regular_base_usd)}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver ítems</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'commission-special-items')}
                    className="block rounded-[16px] border border-[#564511] bg-[#201B08] px-3 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[#F5F7FB]">Ítems especiales</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">{specialCommissionProducts.reduce((sum, row) => sum + numberValue(row.qty), 0)} ítems · Porcentaje propio</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-[#F7DA66]">{money(specialItemsCommissionUsd)}</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">Base {money(closure.special_item_base_usd)}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver ítems</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'commission-special-orders')}
                    className="block rounded-[16px] border border-[#463258] bg-[#181220] px-3 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[#F5F7FB]">Órdenes con porcentaje fijo</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">{fixedCommissionOrders.length} orden{fixedCommissionOrders.length === 1 ? '' : 'es'}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-[#F7DA66]">{money(specialOrdersCommissionUsd)}</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">Base {money(closure.special_order_base_usd)}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver órdenes</span><span>→</span></div>
                  </Link>
                </div>
              ) : null}

              {activeDetail === 'deductions' ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <Link
                    href={commissionHref(selectedPeriod.id, 'deductions-gifts')}
                    className="rounded-[16px] border border-orange-500/40 bg-[#21150D] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Obsequios</div>
                    <div className="mt-1.5 text-2xl font-semibold text-orange-300">{money(closure.gift_deductions_usd)}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{giftQty} ítems</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver obsequios</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'deductions-direct')}
                    className="rounded-[16px] border border-[#5A341F] bg-[#17110D] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Directos</div>
                    <div className="mt-1.5 text-2xl font-semibold text-orange-300">{money(closure.manual_deductions_usd)}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{deductions.length} registro{deductions.length === 1 ? '' : 's'}</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver deducibles</span><span>→</span></div>
                  </Link>
                </div>
              ) : null}

              {activeDetail === 'payable' ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-3 rounded-[14px] bg-[#0D1017] px-3 py-2.5 text-sm">
                    <span className="text-[#AAB2C5]">Comisión bruta</span>
                    <span className="font-semibold text-emerald-300">{money(closure.gross_commission_usd)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-[14px] bg-[#17110D] px-3 py-2.5 text-sm">
                    <span className="text-[#AAB2C5]">Menos obsequios</span>
                    <span className="font-semibold text-orange-300">-{money(closure.gift_deductions_usd)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-[14px] bg-[#17110D] px-3 py-2.5 text-sm">
                    <span className="text-[#AAB2C5]">Menos deducibles directos</span>
                    <span className="font-semibold text-orange-300">-{money(closure.manual_deductions_usd)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-[16px] border border-[#F0D000] bg-[#201B08] px-3 py-3">
                    <span className="text-sm font-semibold text-[#F5F7FB]">Monto a pagar</span>
                    <span className="text-xl font-semibold text-[#F7DA66]">{money(closure.payable_usd)}</span>
                  </div>
                </div>
              ) : null}

              {activeDetail === 'closures' ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <Link
                    href={commissionHref(selectedPeriod.id, 'paid')}
                    className="rounded-[16px] border border-emerald-500/40 bg-[#102219] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Puntuales</div>
                    <div className="mt-1.5 text-2xl font-semibold text-emerald-300">{punctualOrders.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(punctualTotalUsd)}</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver órdenes</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'late')}
                    className="rounded-[16px] border border-orange-500/40 bg-[#21150D] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Impuntuales</div>
                    <div className="mt-1.5 text-2xl font-semibold text-orange-300">{lateOrders.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(lateTotalUsd)}</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver órdenes</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'pending')}
                    className="col-span-2 rounded-[16px] border border-[#564511] bg-[#201B08] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Pendientes</div>
                    <div className="mt-1.5 text-2xl font-semibold text-[#F7DA66]">{pendingOrders.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(closure.pending_collection_usd)}</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver órdenes</span><span>→</span></div>
                  </Link>
                </div>
              ) : null}

              {activeDetail === 'clients' ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <Link
                    href={commissionHref(selectedPeriod.id, 'clients-own')}
                    className="rounded-[16px] border border-[#314A74] bg-[#101827] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Propios</div>
                    <div className="mt-1.5 text-2xl font-semibold text-[#F5F7FB]">{ownClients.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(ownClientsTotalUsd)}</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver clientes</span><span>→</span></div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'clients-assigned')}
                    className="rounded-[16px] border border-[#314A74] bg-[#101827] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Asignados</div>
                    <div className="mt-1.5 text-2xl font-semibold text-[#F5F7FB]">{assignedClients.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(assignedClientsTotalUsd)}</div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold text-[#F7DA66]"><span>Ver clientes</span><span>→</span></div>
                  </Link>
                </div>
              ) : null}

              {activeDetail === 'commission-normal' || activeDetail === 'commission-special-items' ? (
                detailCommissionGroups.length === 0 ? (
                  <EmptyBlock title="Sin ítems" detail="No hay productos en esta categoría de comisión." />
                ) : (
                  <div className="space-y-2">
                    {detailCommissionGroups.map((group) => (
                      <article key={`${group.name}-${group.pct}`} className="rounded-[16px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-[#F5F7FB]">{group.name}</div>
                            <div className="mt-1 text-xs text-[#8B93A7]">{group.qty} ítems · {group.orders.size} orden{group.orders.size === 1 ? '' : 'es'} · {group.pct.toFixed(2)}%</div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-sm font-semibold text-[#F7DA66]">{money(roundMoney(group.commissionUsd))}</div>
                            <div className="mt-1 text-xs text-[#8B93A7]">Base {money(roundMoney(group.baseUsd))}</div>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )
              ) : null}

              {activeDetail === 'commission-special-orders' ? (
                fixedCommissionOrders.length === 0 ? (
                  <EmptyBlock title="Sin órdenes especiales" detail="No hubo órdenes con porcentaje fijo en este período." />
                ) : (
                  <div className="space-y-2">
                    {fixedCommissionOrders.map((order, index) => {
                      const orderId = numberValue(order.orderId);
                      const baseUsd = numberValue(order.specialOrderBaseUsd);
                      const commissionUsd = numberValue(order.commissionUsd);
                      const pct = baseUsd > 0 ? (commissionUsd / baseUsd) * 100 : 0;
                      return (
                        <article key={`${orderId}-${index}`} className="rounded-[16px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-[#F5F7FB]">{order.clientName || 'Cliente'}</div>
                              <div className="mt-1 text-xs text-[#8B93A7]">Orden {orderLabel(order)} · {pct.toFixed(2)}%</div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-sm font-semibold text-[#F7DA66]">{money(commissionUsd)}</div>
                              <div className="mt-1 text-xs text-[#8B93A7]">Base {money(baseUsd)}</div>
                            </div>
                          </div>
                          {orderId > 0 ? (
                            <Link
                              href={withAdvisorReturnTo(`/app/advisor/orders/${orderId}`, returnTo)}
                              className="mt-2 inline-flex h-8 items-center rounded-[11px] border border-[#2A3040] px-3 text-xs font-medium text-[#F5F7FB]"
                            >
                              Abrir orden
                            </Link>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )
              ) : null}

              {activeDetail === 'orders' || activeDetail === 'paid' || activeDetail === 'late' || activeDetail === 'pending' ? (
                detailOrders.length === 0 ? (
                  <EmptyBlock title="Sin órdenes" detail="No hay órdenes en esta categoría para el período." />
                ) : (
                  <div className="space-y-2">
                    {detailOrders.map((order, index) => {
                      const orderId = numberValue(order.orderId);
                      return (
                        <article key={`${orderId}-${index}`} className="rounded-[16px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-[#F5F7FB]">{order.clientName || 'Cliente'}</div>
                              <div className="mt-1 text-xs text-[#8B93A7]">Orden {orderLabel(order)} · {dateLabel(order.deliveryDate)}</div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-sm font-semibold text-[#F5F7FB]">{money(order.totalUsd)}</div>
                              <div className="mt-0.5 text-[10px] text-[#8B93A7]">Comisión {money(order.commissionUsd)}</div>
                            </div>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[#AAB2C5]">
                            <span>{commissionModeLabel(order.commissionMode)}</span>
                            <span
                              className={
                                numberValue(order.pendingUsd) > 0
                                  ? 'text-[#F7DA66]'
                                  : order.paymentTiming === 'late'
                                    ? 'text-orange-300'
                                    : 'text-emerald-300'
                              }
                            >
                              {numberValue(order.pendingUsd) > 0
                                ? `Pendiente ${money(order.pendingUsd)}`
                                : order.paymentTiming === 'late'
                                  ? `Pagada ${dateLabel(order.paymentCompletedDate)}`
                                  : 'Pago puntual'}
                            </span>
                          </div>
                          {orderId > 0 ? (
                            <Link
                              href={withAdvisorReturnTo(`/app/advisor/orders/${orderId}`, returnTo)}
                              className="mt-2 inline-flex h-8 items-center rounded-[11px] border border-[#2A3040] px-3 text-xs font-medium text-[#F5F7FB]"
                            >
                              Abrir orden
                            </Link>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )
              ) : null}

              {activeDetail === 'clients-own' || activeDetail === 'clients-assigned' ? (
                detailClients.length === 0 ? (
                  <EmptyBlock title="Sin clientes" detail="No hay clientes nuevos de este tipo en el período." />
                ) : (
                  <div className="space-y-2">
                    {detailClients.map((client, index) => {
                      const orderId = numberValue(client.orderId);
                      const firstOrderTotal = getClientFirstOrderTotal(client);
                      return (
                        <article key={`${client.clientId}-${index}`} className="rounded-[16px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-[#F5F7FB]">{client.clientName || 'Cliente'}</div>
                              <div className="mt-1 text-xs text-[#8B93A7]">
                                {activeDetail === 'clients-own' ? 'Cliente propio' : 'Cliente asignado'} · Alta {dateLabel(client.createdAt)}
                              </div>
                            </div>
                            <div className="shrink-0 text-sm font-semibold text-[#F5F7FB]">{money(firstOrderTotal)}</div>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[#AAB2C5]">
                            <span>Primera orden {orderId > 0 ? formatOrderDisplayNumber(orderId) : 'sin número'}</span>
                            {orderId > 0 ? (
                              <Link
                                href={withAdvisorReturnTo(`/app/advisor/orders/${orderId}`, returnTo)}
                                className="font-semibold text-[#F7DA66]"
                              >
                                Abrir
                              </Link>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )
              ) : null}

              {activeDetail === 'gifts' || activeDetail === 'deductions-gifts' ? (
                giftsByName.size === 0 ? (
                  <EmptyBlock title="Sin obsequios" detail="No se registraron obsequios en este período." />
                ) : (
                  <div className="space-y-2">
                    {Array.from(giftsByName.entries()).map(([name, gift]) => (
                      <details key={name} className="rounded-[14px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm">
                          <span className="font-medium text-[#F5F7FB]">{name} · {gift.qty} ítems</span>
                          <span className="text-orange-300">-{money(gift.deductionUsd)}</span>
                        </summary>
                        <div className="mt-2 space-y-2 border-t border-[#232632] pt-2">
                          {gift.rows.map((row, index) => {
                            const orderId = numberValue(row.orderId);
                            return (
                              <div key={`${row.orderId}-${index}`} className="flex items-center justify-between gap-3 text-xs text-[#AAB2C5]">
                                <span className="min-w-0 truncate">{row.clientName || 'Cliente'} · Orden {formatOrderDisplayNumber(orderId)}</span>
                                <span className="shrink-0">{row.qty}</span>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    ))}
                  </div>
                )
              ) : null}

              {activeDetail === 'deductions-direct' ? (
                deductions.length === 0 ? (
                  <EmptyBlock title="Sin deducibles" detail="No se aplicaron deducibles manuales en este cierre." />
                ) : (
                  <div className="space-y-2">
                    {deductions.map((deduction) => (
                      <div key={deduction.id} className="rounded-[14px] border border-[#5A341F] bg-[#17110D] px-3 py-2.5">
                        <div className="flex justify-between gap-3 text-sm">
                          <span className="font-medium text-[#F5F7FB]">{deduction.description || 'Deducible'}</span>
                          <span className="font-semibold text-orange-300">-{money(deduction.amount_usd)}</span>
                        </div>
                        {deduction.notes ? <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">{deduction.notes}</div> : null}
                      </div>
                    ))}
                  </div>
                )
              ) : null}
              </SectionCard>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
