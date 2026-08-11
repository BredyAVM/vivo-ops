'use client';

import Link from 'next/link';
import { useDeferredValue, useMemo, useState } from 'react';
import type {
  InventoryReportItem,
  InventoryReportingWorkspace,
} from './reports/InventoryReportsClient';

type Focus = 'attention' | 'all' | 'low' | 'missing_minimum' | 'commitments' | 'incoming';

const GROUP_LABELS: Record<string, string> = {
  raw: 'Crudos',
  fried: 'Fritos',
  prefried: 'Prefritos',
  sauces: 'Salsas y aderezos',
  packaging: 'Empaques y consumibles',
  other: 'Bebidas y otros',
};

const FREQUENCY_LABELS: Record<string, string> = {
  per_shift: 'Por turno',
  daily: 'Diaria',
  weekly: 'Semanal',
  biweekly: 'Quincenal',
  monthly: 'Mensual',
};

function quantity(value: number | null) {
  if (value == null) return '—';
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(value);
}

function shortDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function isLowOrOut(item: InventoryReportItem) {
  return item.threshold_status === 'low' || item.threshold_status === 'out';
}

function requiresAttention(item: InventoryReportItem) {
  return isLowOrOut(item)
    || item.threshold_status === 'not_configured'
    || item.threshold_status === 'pending_opening'
    || item.action_alert_count > 0
    || (item.stock_units ?? 0) < 0;
}

export default function InventoryGeneralOverviewClient({
  workspace,
  canConfigure,
}: {
  workspace: InventoryReportingWorkspace;
  canConfigure: boolean;
}) {
  const [focus, setFocus] = useState<Focus>('attention');
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase('es'));

  const attentionCount = workspace.items.filter(requiresAttention).length;
  const lowCount = workspace.items.filter(isLowOrOut).length;
  const missingMinimumCount = workspace.items.filter((item) => item.threshold_status === 'not_configured').length;
  const commitmentCount = workspace.items.filter((item) => item.commitment_count > 0).length;
  const incomingCount = workspace.items.filter((item) => item.incoming_count > 0).length;

  const groups = useMemo(
    () => Array.from(new Set(workspace.items.map((item) => item.inventory_group))).sort(),
    [workspace.items],
  );
  const visibleItems = useMemo(() => workspace.items.filter((item) => {
    const matchesSearch = !deferredSearch
      || `${item.name} ${item.inventory_group} ${item.products.map((product) => product.name).join(' ')}`
        .toLocaleLowerCase('es')
        .includes(deferredSearch);
    const matchesGroup = group === 'all' || item.inventory_group === group;
    const matchesFocus = focus === 'all'
      || (focus === 'attention' && requiresAttention(item))
      || (focus === 'low' && isLowOrOut(item))
      || (focus === 'missing_minimum' && item.threshold_status === 'not_configured')
      || (focus === 'commitments' && item.commitment_count > 0)
      || (focus === 'incoming' && item.incoming_count > 0);
    return matchesSearch && matchesGroup && matchesFocus;
  }), [deferredSearch, focus, group, workspace.items]);

  return (
    <div className="space-y-6">
      <section>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#FEEF00]">Resumen operativo</div>
            <h2 className="mt-1 text-2xl font-semibold">¿Qué necesita atención hoy?</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#9696A3]">
              Existencia física, pedidos comprometidos y entradas esperadas durante los próximos {workspace.horizon_days} días. Los números informan; no bloquean órdenes.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/app/inventory/operations" prefetch={false} className="rounded-xl border border-[#353544] px-3 py-2 text-sm text-[#D2D2DA] hover:border-[#FEEF00]/40">
              Registrar entrada
            </Link>
            {canConfigure ? (
              <Link href="/app/inventory/adjustments" prefetch={false} className="rounded-xl border border-[#353544] px-3 py-2 text-sm text-[#D2D2DA] hover:border-[#FEEF00]/40">
                Ajustar existencia
              </Link>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <SummaryButton label="Requieren atención" value={attentionCount} active={focus === 'attention'} tone="warn" onClick={() => setFocus('attention')} />
          <SummaryButton label="Bajo o agotado" value={lowCount} active={focus === 'low'} tone="danger" onClick={() => setFocus('low')} />
          <SummaryButton label="Sin mínimo" value={missingMinimumCount} active={focus === 'missing_minimum'} tone="info" onClick={() => setFocus('missing_minimum')} />
          <SummaryButton label="Con compromisos" value={commitmentCount} active={focus === 'commitments'} tone="violet" onClick={() => setFocus('commitments')} />
          <SummaryButton label="Con reposición" value={incomingCount} active={focus === 'incoming'} tone="good" onClick={() => setFocus('incoming')} />
          <SummaryButton label="Todos activos" value={workspace.items.length} active={focus === 'all'} tone="default" onClick={() => setFocus('all')} />
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-[#242433] bg-[#111117]">
        <div className="flex flex-col gap-3 border-b border-[#242433] p-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h3 className="font-semibold">Productos e ítems activos</h3>
            <p className="mt-1 text-sm text-[#8C8C98]">{visibleItems.length} resultados · horizonte hasta {shortDate(workspace.horizon_ends_at)}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar producto o ítem"
              className="min-w-[260px] rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2.5 text-sm outline-none placeholder:text-[#696975] focus:border-[#FEEF00]/60"
            />
            <select value={group} onChange={(event) => setGroup(event.target.value)} className="rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2.5 text-sm outline-none focus:border-[#FEEF00]/60">
              <option value="all">Todas las familias</option>
              {groups.map((value) => <option key={value} value={value}>{GROUP_LABELS[value] ?? value}</option>)}
            </select>
          </div>
        </div>

        {visibleItems.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead className="bg-[#16161F] text-xs uppercase tracking-wide text-[#8F8F9C]">
                <tr>
                  <th className="px-4 py-3">Ítem</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Existencia</th>
                  <th className="px-4 py-3">Comprometido</th>
                  <th className="px-4 py-3">Libre hoy</th>
                  <th className="px-4 py-3">Reposición</th>
                  <th className="px-4 py-3">Mínimo / objetivo</th>
                  <th className="px-4 py-3">Último conteo</th>
                  {canConfigure ? <th className="px-4 py-3">Acción</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#242433]">
                {visibleItems.map((item) => (
                  <tr key={item.id} className="align-top hover:bg-white/[0.025]">
                    <td className="px-4 py-4">
                      <div className="font-semibold text-white">{item.name}</div>
                      <div className="mt-1 text-xs text-[#777784]">{GROUP_LABELS[item.inventory_group] ?? item.inventory_group} · {item.unit_name}</div>
                    </td>
                    <td className="px-4 py-4"><InventoryStatus item={item} /></td>
                    <td className="px-4 py-4 font-semibold text-white">{quantity(item.stock_units)} {item.unit_name}</td>
                    <td className="px-4 py-4">
                      <div className="font-semibold text-violet-100">{quantity(item.commitment_units)} {item.unit_name}</div>
                      <div className="mt-1 text-xs text-[#777784]">{item.commitment_count} compromiso(s)</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-semibold text-white">{quantity(item.available_without_incoming_units)} {item.unit_name}</div>
                      {item.depends_on_incoming ? <div className="mt-1 text-xs text-amber-200">La proyección usa reposición</div> : null}
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-semibold text-emerald-100">{quantity(item.incoming_units)} {item.unit_name}</div>
                      <div className="mt-1 text-xs text-[#777784]">{item.incoming_count ? shortDate(item.next_incoming_at) : 'Sin entrada prevista'}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div>Mínimo: {quantity(item.low_stock_threshold)}</div>
                      <div className="mt-1 text-xs text-[#777784]">Objetivo: {quantity(item.target_stock_units)}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div>{item.last_count ? shortDate(item.last_count.counted_at) : 'Sin conteo'}</div>
                      <div className="mt-1 text-xs text-[#777784]">{item.primary_count_frequency ? FREQUENCY_LABELS[item.primary_count_frequency] ?? item.primary_count_frequency : 'Solo por solicitud'}</div>
                    </td>
                    {canConfigure ? (
                      <td className="px-4 py-4">
                        <Link href={`/app/inventory/configure?view=edit&itemId=${item.id}`} prefetch={false} className="font-semibold text-[#FEEF00] hover:underline">
                          Configurar
                        </Link>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-4 py-12 text-center text-sm text-[#8F8F9C]">
            No hay ítems que coincidan con este filtro.
          </div>
        )}
      </section>
    </div>
  );
}

function InventoryStatus({ item }: { item: InventoryReportItem }) {
  if (!item.initialized) return <Status tone="neutral">Apertura pendiente</Status>;
  if ((item.stock_units ?? 0) < 0) return <Status tone="danger">Saldo negativo</Status>;
  if (item.threshold_status === 'out') return <Status tone="danger">Sin existencia</Status>;
  if (item.threshold_status === 'low') return <Status tone="warn">Bajo mínimo</Status>;
  if (item.threshold_status === 'not_configured') return <Status tone="info">Falta mínimo</Status>;
  if (item.action_alert_count > 0) return <Status tone="warn">Revisar alerta</Status>;
  return <Status tone="good">Disponible</Status>;
}

function Status({ tone, children }: { tone: 'good' | 'warn' | 'danger' | 'info' | 'neutral'; children: string }) {
  const style = {
    good: 'border-emerald-400/25 bg-emerald-400/5 text-emerald-200',
    warn: 'border-amber-400/25 bg-amber-400/5 text-amber-200',
    danger: 'border-red-400/25 bg-red-400/5 text-red-200',
    info: 'border-sky-400/25 bg-sky-400/5 text-sky-200',
    neutral: 'border-[#3A3A48] text-[#B0B0BA]',
  }[tone];
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}>{children}</span>;
}

function SummaryButton({
  label,
  value,
  active,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  active: boolean;
  tone: 'default' | 'good' | 'info' | 'warn' | 'danger' | 'violet';
  onClick: () => void;
}) {
  const valueStyle = {
    default: 'text-white',
    good: 'text-emerald-300',
    info: 'text-sky-300',
    warn: 'text-amber-300',
    danger: 'text-red-300',
    violet: 'text-violet-200',
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-2xl border p-4 text-left transition ${active ? 'border-[#FEEF00]/55 bg-[#FEEF00]/5' : 'border-[#242433] bg-[#111117] hover:border-[#3B3B49]'}`}
    >
      <div className="text-[11px] uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueStyle}`}>{value}</div>
    </button>
  );
}
