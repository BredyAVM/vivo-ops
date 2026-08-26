'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { ModulePreference } from '../../ModulePreference';
import {
  activatePlayAction,
  confirmPlayListAction,
  excludePlayClientAction,
  generatePlayListAction,
  testPlayDefinitionAction,
  type PlayActionResult,
  type PlayAnniversaryMode,
  type PlayFulfillmentFilter,
  type PlayKind,
  type SavePlayDraftInput,
} from './actions';

export type PlayBenefit = {
  id: number;
  name: string;
  sku: string | null;
  type: string;
  referenceBudgetCostUsd: number;
};

export type MasterPlay = {
  id: number;
  seriesKey: string;
  version: number;
  name: string;
  description: string | null;
  status: 'draft' | 'frozen' | 'active' | 'paused' | 'closed' | 'cancelled';
  rules: Record<string, unknown>;
  summary: Record<string, unknown>;
  metricWindow: number;
  giftProductId: number;
  giftQuantity: number;
  plannedBudgetUsd: number | null;
  startsAt: string | null;
  endsAt: string | null;
  snapshotAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  benefits: Array<{
    id: number;
    productId: number;
    quantity: number;
    unitBudgetCostUsd: number;
    sortOrder: number;
    name: string;
    sku: string | null;
  }>;
};

export type MasterPlayMember = {
  id: number;
  playId: number;
  clientId: number;
  advisorId: string | null;
  clientName: string;
  clientPhone: string | null;
  advisorName: string;
  firstPurchaseOn: string | null;
  lastPurchaseOn: string | null;
  purchaseCount: number;
  netRevenueUsd: number;
  averageTicketUsd: number | null;
  lastGiftOn: string | null;
  daysSinceLastPurchase: number | null;
  workflowStatus: string;
};

type Props = {
  roles: string[];
  plays: MasterPlay[];
  selectedPlay: MasterPlay | null;
  benefits: PlayBenefit[];
  members: MasterPlayMember[];
  memberCount: number;
  memberPage: number;
  memberPageSize: number;
  memberSearch: string;
};

type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;

const KIND_LABELS: Record<PlayKind, string> = {
  anniversary: 'Aniversario',
  loyalty: 'Fidelidad',
  new_client: 'Cliente nuevo',
  reconnect: 'Reconexión',
  seasonal: 'Temporada',
  custom: 'Personalizada',
};

const STATUS_PRESENTATION: Record<MasterPlay['status'], { label: string; badge: string; dot: string }> = {
  draft: { label: 'Diseño', badge: 'border-slate-500/30 bg-slate-500/10 text-slate-300', dot: 'bg-slate-400' },
  frozen: { label: 'Lista confirmada', badge: 'border-amber-400/35 bg-amber-400/10 text-amber-200', dot: 'bg-amber-300' },
  active: { label: 'Compartida', badge: 'border-emerald-400/35 bg-emerald-400/10 text-emerald-200', dot: 'bg-emerald-300' },
  paused: { label: 'Pausada', badge: 'border-orange-400/35 bg-orange-400/10 text-orange-200', dot: 'bg-orange-300' },
  closed: { label: 'Cerrada', badge: 'border-blue-400/35 bg-blue-400/10 text-blue-200', dot: 'bg-blue-300' },
  cancelled: { label: 'Cancelada', badge: 'border-red-400/35 bg-red-400/10 text-red-200', dot: 'bg-red-300' },
};

const moneyFormatter = new Intl.NumberFormat('es-VE', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Caracas',
});

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown) {
  return value == null ? '' : String(value);
}

function optionalNumberString(value: unknown) {
  if (value == null || value === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function caracasToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Caracas',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function endOfMonth(dateKey: string) {
  const [year, month] = dateKey.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function previousMonthRange(dateKey: string) {
  const [year, month] = dateKey.split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const previousYear = previous.getUTCFullYear();
  const previousMonth = previous.getUTCMonth() + 1;
  const from = `${previousYear}-${String(previousMonth).padStart(2, '0')}-01`;
  return { from, to: endOfMonth(from) };
}

function dateInput(value: string | null) {
  if (!value) return '';
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? '';
}

function dateLabel(value: string | null) {
  if (!value) return '—';
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00-04:00` : value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function pageHref(playId: number, page: number, search: string) {
  const params = new URLSearchParams({ play: String(playId) });
  if (page > 1) params.set('page', String(page));
  if (search.trim()) params.set('q', search.trim());
  return `/app/master/plays?${params.toString()}`;
}

function summaryNumber(play: MasterPlay | null, key: string) {
  return Math.max(0, Math.trunc(numberValue(play?.summary?.[key], 0)));
}

function summaryAmount(play: MasterPlay | null, key: string) {
  const raw = play?.summary?.[key];
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function advisorBreakdown(play: MasterPlay | null) {
  const raw = play?.summary?.by_advisor;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return [{
      id: stringValue(row.advisor_id),
      name: stringValue(row.advisor_name) || 'Asesor',
      count: Math.max(0, Math.trunc(numberValue(row.count, 0))),
    }];
  });
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-[#B7B7C2]">
        <span>{label}</span>
        {hint ? <span className="font-normal text-[#666675]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const inputClass = 'h-9 w-full rounded-xl border border-[#2A2A35] bg-[#0B0B0D] px-3 text-xs text-[#F5F5F7] outline-none transition placeholder:text-[#5F5F6D] focus:border-[#FEEF00]/70';
const buttonSecondary = 'inline-flex h-9 items-center justify-center rounded-xl border border-[#343440] bg-[#121218] px-3 text-xs font-semibold text-[#D1D1DA] transition hover:border-[#FEEF00]/50 disabled:cursor-not-allowed disabled:opacity-45';
const buttonPrimary = 'inline-flex h-9 items-center justify-center rounded-xl bg-[#FEEF00] px-4 text-xs font-bold text-[#0B0B0D] transition hover:bg-[#FFF45A] disabled:cursor-not-allowed disabled:opacity-45';

function PlayProgress({ status, hasPreview }: { status: MasterPlay['status']; hasPreview: boolean }) {
  const stage = status === 'draft' ? (hasPreview ? 2 : 1) : status === 'frozen' ? 3 : 4;
  const steps = [
    { number: 1, label: 'Definir', detail: 'Condiciones' },
    { number: 2, label: 'Probar', detail: 'Candidatos' },
    { number: 3, label: 'Confirmar', detail: 'Snapshot' },
    { number: 4, label: 'Compartir', detail: 'Asesores' },
  ];

  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-[#242433] bg-[#101014] sm:grid-cols-4">
      {steps.map((step) => {
        const complete = step.number < stage;
        const active = step.number === stage;
        return (
          <div key={step.number} className={`flex items-center gap-2 border-r border-[#242433] px-3 py-2 last:border-r-0 ${active ? 'bg-[#FEEF00]/[0.07]' : ''}`}>
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${complete ? 'bg-emerald-400 text-black' : active ? 'bg-[#FEEF00] text-black' : 'bg-[#242433] text-[#777785]'}`}>
              {complete ? '✓' : step.number}
            </span>
            <div className="min-w-0">
              <div className={`truncate text-[11px] font-semibold ${active || complete ? 'text-[#F5F5F7]' : 'text-[#777785]'}`}>{step.label}</div>
              <div className="truncate text-[9px] text-[#666675]">{step.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlayDefinitionForm({
  play,
  benefits,
  busy,
  onSubmit,
}: {
  play: MasterPlay | null;
  benefits: PlayBenefit[];
  busy: boolean;
  onSubmit: (input: SavePlayDraftInput) => void;
}) {
  const today = useMemo(() => caracasToday(), []);
  const rules = play?.rules ?? {};
  const [name, setName] = useState(play?.name ?? '');
  const [description, setDescription] = useState(play?.description ?? '');
  const [kind, setKind] = useState<PlayKind>(() => (play ? (stringValue(rules.play_type) || play.seriesKey) as PlayKind : 'custom'));
  const [startsOn, setStartsOn] = useState(play ? dateInput(play.startsAt) : today);
  const [endsOn, setEndsOn] = useState(play ? dateInput(play.endsAt) : endOfMonth(today));
  const [benefitOptions, setBenefitOptions] = useState(() => play?.benefits.length
    ? play.benefits.map((option) => ({
        productId: String(option.productId),
        quantity: String(option.quantity),
        unitBudgetCostUsd: String(option.unitBudgetCostUsd),
      }))
    : [{
        productId: benefits[0] ? String(benefits[0].id) : '',
        quantity: '1',
        unitBudgetCostUsd: benefits[0] ? String(benefits[0].referenceBudgetCostUsd) : '0',
      }]);
  const [plannedBudget, setPlannedBudget] = useState(play?.plannedBudgetUsd == null ? '' : String(play.plannedBudgetUsd));
  const [minPurchases, setMinPurchases] = useState(play ? optionalNumberString(rules.min_purchase_count) || '1' : '1');
  const [maxPurchases, setMaxPurchases] = useState(play ? optionalNumberString(rules.max_purchase_count) : '');
  const [minRevenue, setMinRevenue] = useState(play ? optionalNumberString(rules.min_net_revenue_usd) || '0' : '0');
  const [minDays, setMinDays] = useState(play ? optionalNumberString(rules.min_days_since_purchase) : '');
  const [maxDays, setMaxDays] = useState(play ? optionalNumberString(rules.max_days_since_purchase) : '');
  const [firstFrom, setFirstFrom] = useState(play ? stringValue(rules.first_purchase_from) : '');
  const [firstTo, setFirstTo] = useState(play ? stringValue(rules.first_purchase_to) : '');
  const [lastFrom, setLastFrom] = useState(play ? stringValue(rules.last_purchase_from) : '');
  const [lastTo, setLastTo] = useState(play ? stringValue(rules.last_purchase_to) : '');
  const [lastGiftFrom, setLastGiftFrom] = useState(play ? stringValue(rules.last_gift_from) : '');
  const [lastGiftTo, setLastGiftTo] = useState(play ? stringValue(rules.last_gift_to) : '');
  const [includeNeverGifted, setIncludeNeverGifted] = useState(play ? rules.include_never_gifted !== false : true);
  const [anniversaryMode, setAnniversaryMode] = useState<PlayAnniversaryMode>(() => {
    const storedMode = stringValue(rules.anniversary_mode);
    if (storedMode === 'include' || storedMode === 'exclude') return storedMode;
    return play && rules.anniversary_month ? 'include' : 'any';
  });
  const [anniversaryMonth, setAnniversaryMonth] = useState(play ? optionalNumberString(rules.anniversary_month) : '');
  const [fulfillment, setFulfillment] = useState<PlayFulfillmentFilter>(() => play ? (stringValue(rules.fulfillment) || 'any') as PlayFulfillmentFilter : 'any');
  const projectedCostPerClient = useMemo(() => {
    const costs = benefitOptions.flatMap((option) => {
      const quantity = Number(option.quantity);
      const unitCost = Number(option.unitBudgetCostUsd);
      return Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitCost) && unitCost >= 0
        ? [quantity * unitCost]
        : [];
    });
    if (costs.length === 0) return null;
    return { minimum: Math.min(...costs), maximum: Math.max(...costs) };
  }, [benefitOptions]);

  function applyPreset(nextKind: PlayKind) {
    setKind(nextKind);
    const month = Number(startsOn.slice(5, 7));
    const monthYear = new Intl.DateTimeFormat('es-VE', { month: 'long', year: 'numeric', timeZone: 'America/Caracas' })
      .format(new Date(`${startsOn}T12:00:00-04:00`));
    setFirstFrom('');
    setFirstTo('');
    setLastFrom('');
    setLastTo('');
    setLastGiftFrom('');
    setLastGiftTo('');
    setIncludeNeverGifted(true);
    setAnniversaryMode('any');
    setAnniversaryMonth('');
    setMinDays('');
    setMaxDays('');
    setMaxPurchases('');
    setFulfillment('any');

    if (nextKind === 'anniversary') {
      setName(`Aniversario · ${monthYear}`);
      setMinPurchases('2');
      setMinRevenue('0');
      setAnniversaryMode('include');
      setAnniversaryMonth(String(month));
    } else if (nextKind === 'loyalty') {
      setName(`Fidelidad · ${monthYear}`);
      setMinPurchases('8');
      setMinRevenue('0');
      setMaxDays('60');
      setAnniversaryMode('exclude');
      setAnniversaryMonth(String(month));
    } else if (nextKind === 'new_client') {
      const previous = previousMonthRange(startsOn);
      setName(`Clientes nuevos · ${monthYear}`);
      setMinPurchases('1');
      setMinRevenue('0');
      setFirstFrom(previous.from);
      setFirstTo(previous.to);
    } else if (nextKind === 'reconnect') {
      setName(`Reconexión · ${monthYear}`);
      setMinPurchases('2');
      setMinRevenue('0');
      setMinDays('60');
    } else if (nextKind === 'seasonal') {
      setName(`Temporada · ${monthYear}`);
      setMinPurchases('1');
      setMinRevenue('0');
    } else {
      setName('');
      setMinPurchases('1');
      setMinRevenue('0');
    }
  }

  function updateBenefitProduct(index: number, productId: string) {
    const selectedBenefit = benefits.find((benefit) => String(benefit.id) === productId);
    setBenefitOptions((current) => current.map((candidate, candidateIndex) => candidateIndex === index
      ? {
          ...candidate,
          productId,
          unitBudgetCostUsd: selectedBenefit ? String(selectedBenefit.referenceBudgetCostUsd) : '0',
        }
      : candidate));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      playId: play?.id ?? null,
      name,
      description,
      kind,
      startsOn,
      endsOn,
      benefits: benefitOptions.map((option) => ({
        productId: Number(option.productId),
        quantity: Number(option.quantity),
        unitBudgetCostUsd: Number(option.unitBudgetCostUsd),
      })),
      plannedBudgetUsd: plannedBudget === '' ? null : Number(plannedBudget),
      metricWindow: play?.metricWindow ?? 6,
      minPurchaseCount: Number(minPurchases),
      maxPurchaseCount: maxPurchases === '' ? null : Number(maxPurchases),
      minNetRevenueUsd: Number(minRevenue),
      minDaysSincePurchase: minDays === '' ? null : Number(minDays),
      maxDaysSincePurchase: maxDays === '' ? null : Number(maxDays),
      firstPurchaseFrom: firstFrom,
      firstPurchaseTo: firstTo,
      lastPurchaseFrom: lastFrom,
      lastPurchaseTo: lastTo,
      lastGiftFrom,
      lastGiftTo,
      includeNeverGifted,
      anniversaryMode,
      anniversaryMonth: anniversaryMonth === '' ? null : Number(anniversaryMonth),
      fulfillment,
    });
  }

  const editable = !play || play.status === 'draft';

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#F5F5F7]">1. Definición de la jugada</h2>
            <p className="mt-0.5 text-[11px] text-[#777785]">Prueba las condiciones cuantas veces necesites. Nada se comparte todavía.</p>
          </div>
          {play ? <span className="text-[10px] text-[#666675]">Versión {play.version}</span> : null}
        </div>

        <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-[#0B0B0D] p-1.5 sm:grid-cols-6">
          {(Object.keys(KIND_LABELS) as PlayKind[]).map((option) => (
            <button
              key={option}
              type="button"
              disabled={!editable}
              onClick={() => applyPreset(option)}
              className={`h-8 rounded-lg px-2 text-[10px] font-semibold transition ${kind === option ? 'bg-[#FEEF00] text-black' : 'text-[#8F8F9D] hover:bg-[#18181F] hover:text-white'} disabled:opacity-50`}
            >
              {KIND_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      <fieldset disabled={!editable || busy} className="space-y-4 disabled:opacity-70">
        <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_1fr]">
          <Field label="Nombre">
            <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ej. Reconexión septiembre" required />
          </Field>
          <Field label="Desde">
            <input className={inputClass} type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} required />
          </Field>
          <Field label="Hasta">
            <input className={inputClass} type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} required />
          </Field>
        </div>

        <Field label="Objetivo interno" hint="No lo verá el cliente">
          <textarea className={`${inputClass} min-h-16 resize-y py-2`} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Qué queremos lograr y cómo debe abordarse esta lista." />
        </Field>

        <div className="rounded-2xl border border-[#3C3410] bg-[#171506] p-3">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-xs font-semibold text-[#FFF18B]">Beneficios disponibles</h3>
              <p className="mt-0.5 text-[10px] text-[#A89F68]">Puedes agregar hasta ocho alternativas. Para cada cliente el asesor escogerá una sola; no se acumulan.</p>
            </div>
            <button
              type="button"
              disabled={benefitOptions.length >= 8}
              onClick={() => setBenefitOptions((current) => [...current, { productId: '', quantity: '1', unitBudgetCostUsd: '0' }])}
              className={buttonSecondary}
            >
              + Agregar alternativa
            </button>
          </div>
          <div className="space-y-2">
            {benefitOptions.map((option, index) => {
              const usedByAnother = new Set(benefitOptions
                .filter((_, candidateIndex) => candidateIndex !== index)
                .map((candidate) => candidate.productId)
                .filter(Boolean));
              return (
                <div key={index} className="grid gap-2 rounded-xl border border-[#302B10] bg-[#0D0D0A] p-2 sm:grid-cols-[minmax(0,1fr)_110px_150px_36px]">
                  <Field label={`Alternativa ${index + 1}`}>
                    <select
                      className={inputClass}
                      value={option.productId}
                      onChange={(event) => updateBenefitProduct(index, event.target.value)}
                      required
                    >
                      <option value="">Seleccionar beneficio</option>
                      {benefits.map((benefit) => (
                        <option key={benefit.id} value={benefit.id} disabled={usedByAnother.has(String(benefit.id))}>
                          {benefit.name}{benefit.sku ? ` · ${benefit.sku}` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Cantidad">
                    <input
                      className={inputClass}
                      type="number"
                      min="0.001"
                      step="0.001"
                      value={option.quantity}
                      onChange={(event) => setBenefitOptions((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, quantity: event.target.value } : candidate))}
                      required
                    />
                  </Field>
                  <Field label="Costo unitario USD">
                    <input
                      className={inputClass}
                      type="number"
                      min="0"
                      step="0.01"
                      value={option.unitBudgetCostUsd}
                      onChange={(event) => setBenefitOptions((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, unitBudgetCostUsd: event.target.value } : candidate))}
                      required
                    />
                  </Field>
                  <button
                    type="button"
                    disabled={benefitOptions.length === 1}
                    onClick={() => setBenefitOptions((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}
                    className="mt-5 flex h-9 w-9 items-center justify-center rounded-xl border border-red-500/20 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-25"
                    title="Quitar esta alternativa"
                    aria-label={`Quitar alternativa ${index + 1}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-blue-400/20 bg-blue-400/[0.04] p-3">
          <div className="grid gap-3 md:grid-cols-[1fr_220px] md:items-end">
            <div>
              <h3 className="text-xs font-semibold text-blue-100">Presupuesto de esta jugada</h3>
              <p className="mt-1 text-[10px] text-blue-100/55">
                La prueba multiplicará los candidatos por el costo de cada alternativa. Como el asesor elige una sola, verás un rango mínimo y máximo.
              </p>
              {projectedCostPerClient ? (
                <div className="mt-2 text-[10px] font-semibold text-blue-100/80">
                  Costo posible por cliente: {moneyFormatter.format(projectedCostPerClient.minimum)} — {moneyFormatter.format(projectedCostPerClient.maximum)}
                </div>
              ) : null}
            </div>
            <Field label="Presupuesto disponible USD" hint="Opcional">
              <input
                className={inputClass}
                type="number"
                min="0"
                step="0.01"
                value={plannedBudget}
                onChange={(event) => setPlannedBudget(event.target.value)}
                placeholder="Ej. 300"
              />
            </Field>
          </div>
        </div>

        <div className="rounded-2xl border border-[#242433] bg-[#0F0F14] p-3">
          <div className="mb-3">
            <h3 className="text-xs font-semibold text-[#E7E7ED]">Condiciones comerciales</h3>
            <p className="mt-0.5 text-[10px] text-[#666675]">Deja un campo vacío cuando no quieras usar ese límite.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Cierres mínimos">
              <input className={inputClass} type="number" min="0" value={minPurchases} onChange={(event) => setMinPurchases(event.target.value)} />
            </Field>
            <Field label="Cierres máximos">
              <input className={inputClass} type="number" min="0" value={maxPurchases} onChange={(event) => setMaxPurchases(event.target.value)} placeholder="Sin límite" />
            </Field>
            <Field label="Facturación mínima USD">
              <input className={inputClass} type="number" min="0" step="0.01" value={minRevenue} onChange={(event) => setMinRevenue(event.target.value)} />
            </Field>
            <Field label="Canal utilizado">
              <select className={inputClass} value={fulfillment} onChange={(event) => setFulfillment(event.target.value as PlayFulfillmentFilter)}>
                <option value="any">Pickup o delivery</option>
                <option value="pickup">Ha usado pickup</option>
                <option value="delivery">Ha usado delivery</option>
              </select>
            </Field>
            <Field label="Días sin comprar: mínimo">
              <input className={inputClass} type="number" min="0" value={minDays} onChange={(event) => setMinDays(event.target.value)} placeholder="Sin mínimo" />
            </Field>
            <Field label="Días sin comprar: máximo">
              <input className={inputClass} type="number" min="0" value={maxDays} onChange={(event) => setMaxDays(event.target.value)} placeholder="Sin máximo" />
            </Field>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
              <div className="mb-2">
                <h4 className="text-[11px] font-semibold text-[#D8D8E0]">Aniversario de la primera compra</h4>
                <p className="mt-0.5 text-[9px] text-[#666675]">Permite incluirlos o evitar que reciban dos reconocimientos el mismo mes.</p>
              </div>
              <div className="space-y-2">
                <Field label="Cómo usarlo">
                  <select className={inputClass} value={anniversaryMode} onChange={(event) => setAnniversaryMode(event.target.value as PlayAnniversaryMode)}>
                    <option value="any">No filtrar por aniversario</option>
                    <option value="include">Solo quienes cumplen aniversario</option>
                    <option value="exclude">Excluir quienes cumplen aniversario</option>
                  </select>
                </Field>
                <Field label="Mes">
                  <select className={inputClass} disabled={anniversaryMode === 'any'} value={anniversaryMonth} onChange={(event) => setAnniversaryMonth(event.target.value)} required={anniversaryMode !== 'any'}>
                    <option value="">Seleccionar mes</option>
                    {Array.from({ length: 12 }, (_, index) => (
                      <option key={index + 1} value={index + 1}>{new Intl.DateTimeFormat('es-VE', { month: 'long' }).format(new Date(2026, index, 1))}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>

            <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
              <div className="mb-2">
                <h4 className="text-[11px] font-semibold text-[#D8D8E0]">Fecha de la primera compra</h4>
                <p className="mt-0.5 text-[9px] text-[#666675]">Filtra cuándo el cliente compró por primera vez. Es la base de clientes nuevos.</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Desde esta fecha">
                  <input className={inputClass} type="date" value={firstFrom} onChange={(event) => setFirstFrom(event.target.value)} />
                </Field>
                <Field label="Hasta esta fecha">
                  <input className={inputClass} type="date" value={firstTo} onChange={(event) => setFirstTo(event.target.value)} />
                </Field>
              </div>
            </div>

            <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
              <div className="mb-2">
                <h4 className="text-[11px] font-semibold text-[#D8D8E0]">Fecha de la última compra</h4>
                <p className="mt-0.5 text-[9px] text-[#666675]">Filtra cuándo ocurrió su compra más reciente; no modifica la primera compra.</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Desde esta fecha">
                  <input className={inputClass} type="date" value={lastFrom} onChange={(event) => setLastFrom(event.target.value)} />
                </Field>
                <Field label="Hasta esta fecha">
                  <input className={inputClass} type="date" value={lastTo} onChange={(event) => setLastTo(event.target.value)} />
                </Field>
              </div>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3">
            <div className="mb-2">
              <h4 className="text-[11px] font-semibold text-emerald-200">Último obsequio recibido</h4>
              <p className="mt-0.5 text-[9px] text-emerald-200/55">Para no repetir reconocimientos. Ejemplo: usa “hasta” con el último día anterior al período que deseas bloquear.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1.2fr]">
              <Field label="Desde esta fecha">
                <input className={inputClass} type="date" value={lastGiftFrom} onChange={(event) => setLastGiftFrom(event.target.value)} />
              </Field>
              <Field label="Hasta esta fecha">
                <input className={inputClass} type="date" value={lastGiftTo} onChange={(event) => setLastGiftTo(event.target.value)} />
              </Field>
              <label className="mt-5 flex h-9 items-center gap-2 rounded-xl border border-[#2A2A35] bg-[#0B0B0D] px-3 text-[10px] text-[#B7B7C2]">
                <input type="checkbox" checked={includeNeverGifted} onChange={(event) => setIncludeNeverGifted(event.target.checked)} className="accent-[#FEEF00]" />
                Incluir clientes que nunca recibieron obsequio
              </label>
            </div>
          </div>
        </div>
      </fieldset>

      {editable ? (
        <div className="flex flex-col gap-2 border-t border-[#242433] pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[10px] text-[#777785]">La prueba guardará el borrador y calculará inmediatamente los candidatos.</p>
          <button type="submit" disabled={busy || benefits.length === 0} className={buttonPrimary}>
            {play ? 'Actualizar y probar de nuevo' : 'Probar definición'}
          </button>
        </div>
      ) : null}
    </form>
  );
}

function MemberList({
  play,
  members,
  memberCount,
  page,
  pageSize,
  search,
  busy,
  onExclude,
}: {
  play: MasterPlay;
  members: MasterPlayMember[];
  memberCount: number;
  page: number;
  pageSize: number;
  search: string;
  busy: boolean;
  onExclude: (clientId: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(memberCount / pageSize));
  return (
    <section className="overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
      <div className="flex flex-col gap-2 border-b border-[#242433] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">2. Revisar lista</h2>
          <p className="mt-0.5 text-[10px] text-[#777785]">{memberCount.toLocaleString('es-VE')} clientes · ordenados por facturación</p>
        </div>
        <form action="/app/master/plays" method="get" className="flex items-center gap-2">
          <input type="hidden" name="play" value={play.id} />
          <input name="q" defaultValue={search} className={`${inputClass} w-56`} placeholder="Buscar cliente" />
          <button className={buttonSecondary} type="submit">Buscar</button>
        </form>
      </div>

      {members.length === 0 ? (
        <div className="px-4 py-12 text-center">
          <div className="text-sm font-semibold text-[#D5D5DD]">{search ? 'No hay coincidencias' : 'La lista aún no ha sido generada'}</div>
          <p className="mt-1 text-xs text-[#777785]">{search ? 'Prueba con otro nombre.' : 'Completa las condiciones y usa Probar definición.'}</p>
        </div>
      ) : (
        <div className="divide-y divide-[#242433]">
          <div className="hidden grid-cols-[minmax(180px,1.5fr)_minmax(130px,1fr)_74px_92px_86px_92px_34px] gap-3 bg-[#0D0D11] px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#666675] lg:grid">
            <span>Cliente</span><span>Asesor</span><span className="text-right">Cierres</span><span className="text-right">Facturación</span><span className="text-right">Sin comprar</span><span className="text-right">Últ. obsequio</span><span />
          </div>
          {members.map((member) => (
            <div key={member.id} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 lg:grid-cols-[minmax(180px,1.5fr)_minmax(130px,1fr)_74px_92px_86px_92px_34px]">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-[#F5F5F7]">{member.clientName}</div>
                <div className="mt-0.5 truncate text-[9px] text-[#666675]">#{member.clientId} · última {dateLabel(member.lastPurchaseOn)}</div>
              </div>
              <div className="hidden min-w-0 truncate text-[11px] text-[#B7B7C2] lg:block">{member.advisorName}</div>
              <div className="hidden text-right text-[11px] tabular-nums text-[#D5D5DD] lg:block">{member.purchaseCount}</div>
              <div className="hidden text-right text-[11px] tabular-nums text-[#D5D5DD] lg:block">{moneyFormatter.format(member.netRevenueUsd)}</div>
              <div className="hidden text-right text-[11px] tabular-nums text-[#D5D5DD] lg:block">{member.daysSinceLastPurchase == null ? '—' : `${member.daysSinceLastPurchase} d`}</div>
              <div className="hidden text-right text-[10px] tabular-nums text-[#D5D5DD] lg:block">{dateLabel(member.lastGiftOn)}</div>
              {play.status === 'draft' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onExclude(member.clientId)}
                  title="Retirar de esta jugada"
                  aria-label={`Retirar a ${member.clientName} de esta jugada`}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-500/20 text-sm text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                >
                  ×
                </button>
              ) : <span />}
              <div className="col-span-2 flex flex-wrap gap-1 text-[9px] text-[#8F8F9D] lg:hidden">
                <span>{member.advisorName}</span><span>·</span><span>{member.purchaseCount} cierres</span><span>·</span><span>{moneyFormatter.format(member.netRevenueUsd)}</span><span>·</span><span>{member.daysSinceLastPurchase ?? '—'} d</span><span>·</span><span>obsequio {dateLabel(member.lastGiftOn)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {memberCount > pageSize ? (
        <div className="flex items-center justify-between gap-3 border-t border-[#242433] px-3 py-2">
          <span className="text-[10px] text-[#777785]">Página {page} de {totalPages}</span>
          <div className="flex gap-1.5">
            <Link aria-disabled={page <= 1} href={pageHref(play.id, Math.max(1, page - 1), search)} className={`${buttonSecondary} ${page <= 1 ? 'pointer-events-none opacity-35' : ''}`}>Anterior</Link>
            <Link aria-disabled={page >= totalPages} href={pageHref(play.id, Math.min(totalPages, page + 1), search)} className={`${buttonSecondary} ${page >= totalPages ? 'pointer-events-none opacity-35' : ''}`}>Siguiente</Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function MasterPlaysClient({
  roles,
  plays,
  selectedPlay,
  benefits,
  members,
  memberCount,
  memberPage,
  memberPageSize,
  memberSearch,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const activeModuleKey = roles.includes('admin') ? 'admin' : 'master';
  const playCounts = useMemo(() => ({
    design: plays.filter((play) => play.status === 'draft').length,
    review: plays.filter((play) => play.status === 'frozen').length,
    shared: plays.filter((play) => play.status === 'active' || play.status === 'paused').length,
  }), [plays]);
  const selectedSummaryTotal = summaryNumber(selectedPlay, 'total');
  const selectedAdvisorCount = summaryNumber(selectedPlay, 'advisor_count');
  const selectedExcludedCount = summaryNumber(selectedPlay, 'excluded_count');
  const selectedTotalClosures = summaryNumber(selectedPlay, 'total_purchase_count');
  const selectedRevenue = summaryAmount(selectedPlay, 'total_net_revenue_usd') ?? 0;
  const selectedProjectedCostMin = summaryAmount(selectedPlay, 'projected_cost_min_usd');
  const selectedProjectedCostMax = summaryAmount(selectedPlay, 'projected_cost_max_usd');
  const selectedBudgetBalance = summaryAmount(selectedPlay, 'budget_balance_worst_case_usd');
  const selectedBudgetCapacity = summaryAmount(selectedPlay, 'budget_capacity_worst_case');
  const selectedBudgetStatus = stringValue(selectedPlay?.summary?.budget_status) || 'not_defined';
  const selectedHasPreview = Boolean(selectedPlay?.summary?.generated_at);
  const advisors = advisorBreakdown(selectedPlay);

  function handleResult(result: PlayActionResult, navigateToPlay = false) {
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.error || 'No se pudo completar la acción.' });
      return;
    }
    setNotice({ tone: 'success', text: result.message || 'Acción completada.' });
    if (navigateToPlay && result.playId) {
      router.push(`/app/master/plays?play=${result.playId}`);
    } else {
      router.refresh();
    }
  }

  function run(action: () => Promise<PlayActionResult>, navigateToPlay = false) {
    setNotice(null);
    startTransition(async () => handleResult(await action(), navigateToPlay));
  }

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <ModulePreference moduleKey={activeModuleKey} />
      <header className="sticky top-0 z-40 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/app/master/dashboard" className="flex h-9 items-center rounded-xl border border-[#2A2A35] px-3 text-xs text-[#B7B7C2] hover:border-[#FEEF00]/50 hover:text-white">← Dashboard</Link>
            <div className="min-w-0">
              <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-[#777785]">CRM · B. Master 3.0</div>
              <h1 className="truncate text-base font-semibold">Diseño de jugadas</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 text-[10px] text-[#8F8F9D] md:flex">
              <span className="rounded-full border border-[#2A2A35] px-2 py-1">{playCounts.design} diseño</span>
              <span className="rounded-full border border-amber-400/20 px-2 py-1 text-amber-200">{playCounts.review} revisión</span>
              <span className="rounded-full border border-emerald-400/20 px-2 py-1 text-emerald-200">{playCounts.shared} compartidas</span>
            </div>
            <Link href="/app/master/plays?create=1" className={buttonPrimary}>+ Nueva jugada</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1440px] gap-4 px-5 py-4 lg:grid-cols-[290px_minmax(0,1fr)]">
        <aside className="h-fit overflow-hidden rounded-2xl border border-[#242433] bg-[#121218] lg:sticky lg:top-[78px]">
          <div className="border-b border-[#242433] px-3 py-3">
            <div className="text-xs font-semibold">Jugadas</div>
            <div className="mt-0.5 text-[10px] text-[#666675]">Historial y trabajos en curso</div>
          </div>
          <div className="max-h-[calc(100vh-150px)] overflow-y-auto p-1.5">
            {plays.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-[#777785]">Aún no hay jugadas creadas.</div>
            ) : plays.map((play) => {
              const status = STATUS_PRESENTATION[play.status];
              const active = selectedPlay?.id === play.id;
              return (
                <Link
                  key={play.id}
                  href={`/app/master/plays?play=${play.id}`}
                  className={`mb-1 block rounded-xl border px-3 py-2.5 transition ${active ? 'border-[#FEEF00]/70 bg-[#FEEF00]/[0.06]' : 'border-transparent hover:border-[#2A2A35] hover:bg-[#16161D]'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold">{play.name}</div>
                      <div className="mt-1 truncate text-[9px] text-[#666675]">{dateLabel(play.startsAt)} — {dateLabel(play.endsAt)}</div>
                    </div>
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${status.dot}`} />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[9px] ${status.badge}`}>{status.label}</span>
                    <span className="text-[9px] tabular-nums text-[#777785]">{summaryNumber(play, 'total')} clientes</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          {notice ? (
            <div role="status" className={`rounded-xl border px-3 py-2.5 text-xs ${notice.tone === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-200' : notice.tone === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-blue-500/30 bg-blue-500/10 text-blue-200'}`}>
              {notice.text}
            </div>
          ) : null}

          {selectedPlay ? (
            <>
              <section className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-lg font-semibold">{selectedPlay.name}</h2>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${STATUS_PRESENTATION[selectedPlay.status].badge}`}>{STATUS_PRESENTATION[selectedPlay.status].label}</span>
                    </div>
                    <p className="mt-1 text-xs text-[#777785]">{selectedPlay.description || 'Sin objetivo interno descrito.'}</p>
                  </div>
                  <div className="shrink-0 rounded-xl border border-[#3C3410] bg-[#211E0A] px-3 py-2 text-right">
                    <div className="text-[9px] uppercase tracking-[0.12em] text-[#A99D4D]">Beneficios · se entrega 1</div>
                    <div className="mt-1 flex max-w-96 flex-wrap justify-end gap-1">
                      {selectedPlay.benefits.map((option) => (
                        <span key={option.id} className="rounded-full border border-[#554912] bg-[#151304] px-2 py-0.5 text-[9px] font-semibold text-[#FFF18B]">
                          {option.quantity} × {option.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <PlayProgress status={selectedPlay.status} hasPreview={selectedHasPreview} />

                <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <div className="rounded-xl border border-[#242433] bg-[#0D0D11] px-2 py-2 text-center"><div className="text-lg font-semibold tabular-nums">{selectedSummaryTotal}</div><div className="text-[9px] uppercase tracking-[0.1em] text-[#666675]">Clientes</div></div>
                  <div className="rounded-xl border border-[#242433] bg-[#0D0D11] px-2 py-2 text-center"><div className="text-lg font-semibold tabular-nums">{selectedAdvisorCount}</div><div className="text-[9px] uppercase tracking-[0.1em] text-[#666675]">Asesores</div></div>
                  <div className="rounded-xl border border-[#242433] bg-[#0D0D11] px-2 py-2 text-center"><div className="text-lg font-semibold tabular-nums">{selectedTotalClosures.toLocaleString('es-VE')}</div><div className="text-[9px] uppercase tracking-[0.1em] text-[#666675]">Cierres acumulados</div></div>
                  <div className="rounded-xl border border-[#242433] bg-[#0D0D11] px-2 py-2 text-center"><div className="text-lg font-semibold tabular-nums">{moneyFormatter.format(selectedRevenue)}</div><div className="text-[9px] uppercase tracking-[0.1em] text-[#666675]">Facturación acumulada</div></div>
                </div>

                {selectedHasPreview ? (
                  <div className="mt-3 rounded-2xl border border-blue-400/20 bg-blue-400/[0.04] p-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-xs font-semibold text-blue-100">Simulación de presupuesto</h3>
                          <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold ${selectedBudgetStatus === 'within' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : selectedBudgetStatus === 'exceeds' ? 'border-red-400/30 bg-red-400/10 text-red-200' : 'border-slate-400/25 bg-slate-400/10 text-slate-300'}`}>
                            {selectedBudgetStatus === 'within' ? 'Dentro del presupuesto' : selectedBudgetStatus === 'exceeds' ? 'Supera el presupuesto' : 'Presupuesto por definir'}
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-blue-100/55">El rango cambia según cuál alternativa elija el asesor para cada cliente.</p>
                      </div>
                      <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-right sm:grid-cols-4">
                        <div><div className="text-[9px] uppercase tracking-[0.1em] text-blue-100/45">Disponible</div><div className="mt-0.5 text-xs font-semibold tabular-nums text-blue-50">{selectedPlay.plannedBudgetUsd == null ? '—' : moneyFormatter.format(selectedPlay.plannedBudgetUsd)}</div></div>
                        <div><div className="text-[9px] uppercase tracking-[0.1em] text-blue-100/45">Inversión estimada</div><div className="mt-0.5 text-xs font-semibold tabular-nums text-blue-50">{selectedProjectedCostMin == null || selectedProjectedCostMax == null ? '—' : selectedProjectedCostMin === selectedProjectedCostMax ? moneyFormatter.format(selectedProjectedCostMax) : `${moneyFormatter.format(selectedProjectedCostMin)} — ${moneyFormatter.format(selectedProjectedCostMax)}`}</div></div>
                        <div><div className="text-[9px] uppercase tracking-[0.1em] text-blue-100/45">Saldo conservador</div><div className={`mt-0.5 text-xs font-semibold tabular-nums ${selectedBudgetBalance != null && selectedBudgetBalance < 0 ? 'text-red-200' : 'text-blue-50'}`}>{selectedBudgetBalance == null ? '—' : moneyFormatter.format(selectedBudgetBalance)}</div></div>
                        <div><div className="text-[9px] uppercase tracking-[0.1em] text-blue-100/45">Capacidad máxima</div><div className="mt-0.5 text-xs font-semibold tabular-nums text-blue-50">{selectedBudgetCapacity == null ? '—' : `${Math.trunc(selectedBudgetCapacity).toLocaleString('es-VE')} clientes`}</div></div>
                      </div>
                    </div>
                    <div className="mt-2 text-[9px] text-blue-100/40">{selectedExcludedCount.toLocaleString('es-VE')} retirados manualmente · {selectedPlay.benefits.length} alternativas disponibles.</div>
                  </div>
                ) : null}
              </section>

              <section className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <PlayDefinitionForm
                  key={selectedPlay.id}
                  play={selectedPlay}
                  benefits={benefits}
                  busy={pending}
                  onSubmit={(input) => run(() => testPlayDefinitionAction(input), true)}
                />
              </section>

              {selectedPlay.status === 'draft' ? (
                <section className="flex flex-col gap-3 rounded-2xl border border-[#3A3210] bg-[#1A180B] p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-[#FFF18B]">{selectedHasPreview ? 'Prueba lista para revisar' : 'Todavía no has probado esta definición'}</div>
                    <p className="mt-1 text-[11px] text-[#A89F68]">{selectedHasPreview ? 'Ajusta condiciones, retira casos o confirma el snapshot cuando la cantidad y el presupuesto estén correctos.' : 'Ejecuta la prueba para conocer candidatos, facturación y presupuesto antes de confirmar.'}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button type="button" disabled={pending} onClick={() => run(() => generatePlayListAction(selectedPlay.id))} className={buttonSecondary}>Probar condiciones guardadas</button>
                    <button type="button" disabled={pending || !selectedHasPreview || selectedSummaryTotal <= 0} onClick={() => run(() => confirmPlayListAction(selectedPlay.id))} className={buttonPrimary}>Confirmar snapshot</button>
                  </div>
                </section>
              ) : selectedPlay.status === 'frozen' ? (
                <section className="flex flex-col gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-emerald-200">La lista está confirmada y todavía es privada</div>
                    <p className="mt-1 text-[11px] text-emerald-200/60">Revísala por última vez. Compartir la hará visible para cada asesor según su asignación.</p>
                  </div>
                  <button type="button" disabled={pending} onClick={() => run(() => activatePlayAction(selectedPlay.id))} className={buttonPrimary}>Compartir con asesores</button>
                </section>
              ) : selectedPlay.status === 'active' ? (
                <section className="rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.06] px-4 py-3 text-xs text-emerald-200">
                  Esta jugada ya está compartida. Cada asesor ve únicamente los clientes que aparecen bajo su adjudicación en este snapshot.
                </section>
              ) : null}

              {advisors.length > 0 ? (
                <section className="rounded-2xl border border-[#242433] bg-[#121218] px-4 py-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#777785]">Distribución por asesor</div>
                  <div className="flex flex-wrap gap-1.5">
                    {advisors.map((advisor) => <span key={`${advisor.id}-${advisor.name}`} className="rounded-full border border-[#2A2A35] bg-[#0D0D11] px-2.5 py-1 text-[10px] text-[#B7B7C2]">{advisor.name} <strong className="ml-1 text-white">{advisor.count}</strong></span>)}
                  </div>
                </section>
              ) : null}

              <MemberList
                play={selectedPlay}
                members={members}
                memberCount={memberCount}
                page={memberPage}
                pageSize={memberPageSize}
                search={memberSearch}
                busy={pending}
                onExclude={(clientId) => run(() => excludePlayClientAction(selectedPlay.id, clientId))}
              />
            </>
          ) : (
            <section className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="mb-4 rounded-xl border border-[#2A2A35] bg-[#0D0D11] px-3 py-2.5 text-xs text-[#B7B7C2]">
                Define y prueba la jugada cuantas veces necesites. Los asesores no verán nada hasta que confirmes el snapshot y lo compartas.
              </div>
              <PlayDefinitionForm
                key="new-play"
                play={null}
                benefits={benefits}
                busy={pending}
                onSubmit={(input) => run(() => testPlayDefinitionAction(input), true)}
              />
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
