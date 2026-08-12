'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useDeferredValue, useState, useTransition } from 'react';
import { loadInventoryKardexPageAction } from '../actions';
import {
  inventoryCountFolio,
  inventoryCountKindLabels,
  inventoryCountTitle,
} from '../count-presentation';

type InventoryProductReference = {
  id: number;
  name: string;
};

type InventoryLastCount = {
  inventory_count_id: number;
  count_kind: string;
  count_status: string;
  line_status: string;
  expected_units: number | null;
  counted_units: number | null;
  difference_units: number | null;
  counted_at: string;
  counted_by_name: string | null;
};

export type InventoryReportItem = {
  id: number;
  name: string;
  inventory_group: string;
  unit_name: string;
  inventory_kind: string;
  tracking_mode: string;
  availability_mode: string;
  initialized: boolean;
  opening_status: 'ready' | 'pending';
  stock_units: number | null;
  commitment_units: number;
  commitment_count: number;
  next_commitment_at: string | null;
  incoming_units: number;
  incoming_count: number;
  next_incoming_at: string | null;
  outside_horizon_commitment_units: number;
  outside_horizon_commitment_count: number;
  available_without_incoming_units: number | null;
  projected_available_units: number | null;
  minimum_projected_at: string | null;
  effective_capacity_units: number | null;
  depends_on_incoming: boolean;
  low_stock_threshold: number | null;
  low_stock_inclusive: boolean;
  target_stock_units: number | null;
  threshold_status: 'pending_opening' | 'not_configured' | 'out' | 'low' | 'ok';
  primary_count_frequency: string | null;
  primary_count_role: string | null;
  last_count: InventoryLastCount | null;
  active_alert_count: number;
  critical_alert_count: number;
  action_alert_count: number;
  product_count: number;
  products: InventoryProductReference[];
};

type InventoryProjectionEvent = {
  id: number;
  inventory_item_id: number;
  inventory_item_name: string;
  unit_name: string;
  flow_type: 'order_commitment' | 'expected_receipt' | 'planned_production';
  quantity_units: number;
  effective_at: string;
  status: string;
  order_id: number | null;
  order_number: string | null;
  inventory_recipe_id: number | null;
  depends_on_flow_id: number | null;
  notes: string | null;
  capture_details: Record<string, unknown>;
};

type InventoryCountReport = {
  id: number;
  count_kind: string;
  status: string;
  responsible_role: string;
  due_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  shift_business_date?: string | null;
  created_by_name: string | null;
  reviewed_by_name: string | null;
  line_count: number;
  variance_count: number;
  total_absolute_difference: number;
};

export type InventoryKardexRow = {
  id: number;
  inventory_item_id: number;
  inventory_item_name: string;
  unit_name: string;
  movement_type: string;
  quantity_units: number;
  balance_before_units: number;
  balance_after_units: number;
  reason_code: string | null;
  notes: string | null;
  order_id: number | null;
  order_number: string | null;
  operation_id: string;
  reversal_of_movement_id: number | null;
  is_reversed: boolean;
  actor_name: string | null;
  created_at: string;
};

export type InventoryKardexPage = {
  items: InventoryKardexRow[];
  next_cursor: {
    before_created_at: string;
    before_id: number;
  } | null;
};

export type InventoryReportingWorkspace = {
  generated_at: string;
  horizon_days: number;
  horizon_ends_at: string;
  cutover_mode: 'legacy' | 'opening' | 'canonical' | string;
  summary: {
    tracked_items: number;
    initialized_items: number;
    pending_opening_items: number;
    active_commitment_flows: number;
    incoming_flows: number;
    active_alerts: number;
    canonical_movements: number;
    count_sessions: number;
  };
  items: InventoryReportItem[];
  projection_events: InventoryProjectionEvent[];
  recent_counts: InventoryCountReport[];
};

const GROUP_LABELS: Record<string, string> = {
  raw: 'Crudos',
  fried: 'Fritos',
  prefried: 'Prefritos',
  sauces: 'Salsas y aderezos',
  packaging: 'Empaques y consumibles',
  other: 'Otros',
};

const COUNT_KIND_LABELS = inventoryCountKindLabels;

const MOVEMENT_LABELS: Record<string, string> = {
  inbound: 'Entrada',
  return_in: 'Devolución',
  sale_out: 'Venta',
  damage: 'Avería',
  waste: 'Merma',
  quality_taste: 'Prueba de calidad',
  manual_adjustment: 'Ajuste',
  stock_count: 'Conteo físico',
  production_out: 'Consumo de preparación',
  production_in: 'Producción terminada',
  reversal: 'Reverso',
};

const INPUT_CLASS = 'w-full rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-sm text-white outline-none focus:border-[#FEEF00]/70';
const SECONDARY_BUTTON_CLASS = 'rounded-xl border border-[#343442] bg-[#17171F] px-4 py-2 text-sm font-semibold text-[#D5D5DE] transition hover:border-[#FEEF00]/50 disabled:cursor-not-allowed disabled:opacity-50';

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Caracas',
});

const quantityFormatter = new Intl.NumberFormat('es-VE', {
  maximumFractionDigits: 3,
});

function quantity(value: number | null | undefined) {
  return value == null ? '—' : quantityFormatter.format(Number(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function thresholdLabel(status: InventoryReportItem['threshold_status']) {
  if (status === 'pending_opening') return 'Pendiente de apertura';
  if (status === 'not_configured') return 'Sin umbral';
  if (status === 'out') return 'Agotado';
  if (status === 'low') return 'Nivel bajo';
  return 'Normal';
}

function thresholdClass(status: InventoryReportItem['threshold_status']) {
  if (status === 'out') return 'border-red-400/35 bg-red-400/10 text-red-200';
  if (status === 'low') return 'border-amber-300/35 bg-amber-300/10 text-amber-100';
  if (status === 'ok') return 'border-emerald-300/35 bg-emerald-300/10 text-emerald-100';
  return 'border-[#393946] bg-[#17171F] text-[#B6B6C2]';
}

function flowLabel(flowType: InventoryProjectionEvent['flow_type']) {
  if (flowType === 'expected_receipt') return 'Entrada esperada';
  if (flowType === 'planned_production') return 'Producción esperada';
  return 'Compromiso confirmado';
}

export default function InventoryReportsClient({
  workspace,
  initialKardex,
}: {
  workspace: InventoryReportingWorkspace;
  initialKardex: InventoryKardexPage;
}) {
  const [tab, setTab] = useState<'stock' | 'projection' | 'counts' | 'kardex'>('stock');

  return (
    <section>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Reportes y proyección de stock</h2>
          <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
            Lectura canónica de existencias, compromisos, reposiciones, conteos y kardex.
            Se carga únicamente al abrir esta ruta.
          </p>
        </div>
        <div className="rounded-full border border-[#2B2B38] px-3 py-1 text-xs text-[#9D9DA9]">
          Horizonte: {workspace.horizon_days} días
        </div>
      </div>

      {workspace.cutover_mode !== 'canonical' ? (
        <div className="mt-5 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">
          <strong>Lectura previa a la apertura:</strong> los compromisos fechados sí aparecen,
          pero las existencias y disponibilidades permanecen ocultas hasta que cada ítem tenga
          un conteo físico de apertura. Los saldos heredados negativos no se presentan como stock real.
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <SummaryCard label="Ítems rastreados" value={workspace.summary.tracked_items} />
        <SummaryCard label="Con apertura" value={workspace.summary.initialized_items} tone="good" />
        <SummaryCard label="Apertura pendiente" value={workspace.summary.pending_opening_items} tone="warning" />
        <SummaryCard label="Compromisos · 10 días" value={workspace.summary.active_commitment_flows} tone="info" />
        <SummaryCard label="Entradas previstas" value={workspace.summary.incoming_flows} tone="info" />
        <SummaryCard label="Alertas activas" value={workspace.summary.active_alerts} tone="critical" />
      </div>

      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Reportes de inventario">
        <TabButton active={tab === 'stock'} onClick={() => setTab('stock')}>Existencias</TabButton>
        <TabButton active={tab === 'projection'} onClick={() => setTab('projection')}>Proyección</TabButton>
        <TabButton active={tab === 'counts'} onClick={() => setTab('counts')}>Conteos</TabButton>
        <TabButton active={tab === 'kardex'} onClick={() => setTab('kardex')}>Kardex</TabButton>
      </div>

      {tab === 'stock' ? <StockReport items={workspace.items} /> : null}
      {tab === 'projection' ? <ProjectionReport events={workspace.projection_events} horizonEndsAt={workspace.horizon_ends_at} /> : null}
      {tab === 'counts' ? <CountsReport counts={workspace.recent_counts} /> : null}
      {tab === 'kardex' ? <KardexReport inventoryItems={workspace.items} initialPage={initialKardex} /> : null}
    </section>
  );
}

function StockReport({ items }: { items: InventoryReportItem[] }) {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [opening, setOpening] = useState<'all' | 'ready' | 'pending'>('all');
  const [expandedItemId, setExpandedItemId] = useState<number | null>(null);
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase('es'));
  const groups = Array.from(new Set(items.map((item) => item.inventory_group))).sort();
  const filteredItems = items.filter((item) => {
    const searchable = `${item.name} ${item.products.map((product) => product.name).join(' ')}`.toLocaleLowerCase('es');
    return (group === 'all' || item.inventory_group === group)
      && (opening === 'all' || item.opening_status === opening)
      && (!deferredSearch || searchable.includes(deferredSearch));
  });

  return (
    <div className="mt-5">
      <div className="grid gap-3 rounded-2xl border border-[#242433] bg-[#111117] p-4 md:grid-cols-3">
        <label className="text-xs text-[#A6A6B2]">Buscar ítem o producto<input className={`${INPUT_CLASS} mt-1`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tequeño, Coca-Cola…" /></label>
        <label className="text-xs text-[#A6A6B2]">Familia<select className={`${INPUT_CLASS} mt-1`} value={group} onChange={(event) => setGroup(event.target.value)}><option value="all">Todas</option>{groups.map((value) => <option key={value} value={value}>{GROUP_LABELS[value] ?? value}</option>)}</select></label>
        <label className="text-xs text-[#A6A6B2]">Apertura<select className={`${INPUT_CLASS} mt-1`} value={opening} onChange={(event) => setOpening(event.target.value as typeof opening)}><option value="all">Todas</option><option value="ready">Con apertura</option><option value="pending">Pendientes</option></select></label>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-[#242433] bg-[#111117]">
        <table className="min-w-[1180px] w-full text-left text-sm">
          <thead className="border-b border-[#2A2A38] text-xs uppercase tracking-wide text-[#858591]">
            <tr><th className="px-4 py-3">Ítem</th><th className="px-4 py-3">Existencia</th><th className="px-4 py-3">Comprometido</th><th className="px-4 py-3">Disponible protegido</th><th className="px-4 py-3">Entradas previstas</th><th className="px-4 py-3">Último conteo</th><th className="px-4 py-3">Estado</th></tr>
          </thead>
          <tbody className="divide-y divide-[#22222D]">
            {filteredItems.map((item) => (
              <tr key={item.id} className="[content-visibility:auto] align-top">
                <td className="px-4 py-4">
                  <div className="font-semibold text-white">{item.name}</div>
                  <div className="mt-1 text-xs text-[#858591]">{GROUP_LABELS[item.inventory_group] ?? item.inventory_group} · {item.unit_name}</div>
                  {item.product_count > 0 ? <button type="button" className="mt-2 text-left text-xs font-semibold text-[#FEEF00] hover:underline" onClick={() => setExpandedItemId((current) => current === item.id ? null : item.id)}>{item.product_count} producto{item.product_count === 1 ? '' : 's'} dependiente{item.product_count === 1 ? '' : 's'}</button> : null}
                  {expandedItemId === item.id ? <div className="mt-2 max-w-sm text-xs leading-5 text-[#A6A6B2]">{item.products.map((product) => product.name).join(', ')}</div> : null}
                </td>
                <td className="px-4 py-4"><MetricValue value={item.stock_units} unit={item.unit_name} pending={!item.initialized} /></td>
                <td className="px-4 py-4"><div className="font-semibold text-white">{quantity(item.commitment_units)} {item.unit_name}</div><div className="mt-1 text-xs text-[#858591]">{item.commitment_count} compromiso{item.commitment_count === 1 ? '' : 's'}</div></td>
                <td className="px-4 py-4">
                  <MetricValue value={item.available_without_incoming_units} unit={item.unit_name} pending={!item.initialized} />
                  {item.depends_on_incoming ? <div className="mt-1 text-xs text-amber-200">Con reposición: {quantity(item.projected_available_units)} {item.unit_name}</div> : null}
                </td>
                <td className="px-4 py-4"><div className="font-semibold text-white">{quantity(item.incoming_units)} {item.unit_name}</div><div className="mt-1 text-xs text-[#858591]">{item.next_incoming_at ? formatDate(item.next_incoming_at) : 'Sin entrada activa'}</div></td>
                <td className="px-4 py-4">{item.last_count ? <><Link href={`/app/inventory/counts/${item.last_count.inventory_count_id}`} prefetch={false} className="font-semibold text-[#FEEF00] hover:underline">{formatDate(item.last_count.counted_at)}</Link><div className="mt-1 text-xs text-[#858591]">{item.last_count.counted_by_name ?? 'Sin responsable'}</div></> : <span className="text-[#858591]">Sin conteo</span>}</td>
                <td className="px-4 py-4"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs ${thresholdClass(item.threshold_status)}`}>{thresholdLabel(item.threshold_status)}</span>{item.active_alert_count > 0 ? <div className="mt-2 text-xs text-red-200">{item.active_alert_count} alerta{item.active_alert_count === 1 ? '' : 's'}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredItems.length === 0 ? <div className="p-8 text-center text-sm text-[#9696A3]">No hay ítems que coincidan con estos filtros.</div> : null}
      </div>
    </div>
  );
}

function ProjectionReport({ events, horizonEndsAt }: { events: InventoryProjectionEvent[]; horizonEndsAt: string }) {
  const [search, setSearch] = useState('');
  const [flowType, setFlowType] = useState<'all' | InventoryProjectionEvent['flow_type']>('all');
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase('es'));
  const filteredEvents = events.filter((event) => {
    const searchable = `${event.inventory_item_name} ${event.order_number ?? ''}`.toLocaleLowerCase('es');
    return (flowType === 'all' || event.flow_type === flowType)
      && (!deferredSearch || searchable.includes(deferredSearch));
  });

  return (
    <div className="mt-5">
      <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-xs text-[#A6A6B2]">Buscar<input className={`${INPUT_CLASS} mt-1`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Ítem u orden" /></label>
          <label className="text-xs text-[#A6A6B2]">Tipo<select className={`${INPUT_CLASS} mt-1`} value={flowType} onChange={(event) => setFlowType(event.target.value as typeof flowType)}><option value="all">Todos</option><option value="order_commitment">Compromisos</option><option value="expected_receipt">Entradas</option><option value="planned_production">Producción</option></select></label>
        </div>
        <p className="mt-3 text-xs text-[#858591]">Hasta {formatDate(horizonEndsAt)}. Los pedidos posteriores permanecen fuera de esta lectura operativa.</p>
      </div>
      {filteredEvents.length === 0 ? <EmptyState text="No hay eventos activos dentro del horizonte seleccionado." /> : <div className="mt-4 space-y-3">{filteredEvents.map((event) => <article key={event.id} className="[content-visibility:auto] rounded-2xl border border-[#242433] bg-[#111117] p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div><div className="flex flex-wrap gap-2"><span className={`rounded-full border px-2.5 py-1 text-xs ${event.flow_type === 'order_commitment' ? 'border-violet-300/35 bg-violet-300/10 text-violet-100' : 'border-emerald-300/35 bg-emerald-300/10 text-emerald-100'}`}>{flowLabel(event.flow_type)}</span>{event.depends_on_flow_id ? <span className="rounded-full border border-amber-300/35 px-2.5 py-1 text-xs text-amber-100">Dependencia</span> : null}</div><h3 className="mt-3 font-semibold text-white">{event.inventory_item_name}</h3><p className="mt-1 text-sm text-[#B6B6C2]">{quantity(event.quantity_units)} {event.unit_name}</p></div><div className="text-sm lg:text-right"><div className="font-semibold text-white">{formatDate(event.effective_at)}</div>{event.order_id ? <Link href={`/app/master/ops?openOrder=${event.order_id}`} prefetch={false} className="mt-2 inline-block text-xs font-semibold text-[#FEEF00] hover:underline">Ver orden {event.order_number ?? `#${event.order_id}`}</Link> : null}</div></div></article>)}</div>}
    </div>
  );
}

function CountsReport({ counts }: { counts: InventoryCountReport[] }) {
  if (counts.length === 0) return <EmptyState text="Todavía no existen sesiones de conteo canónicas. La apertura física será el primer reporte." />;
  return <div className="mt-5 space-y-3">{counts.map((count) => <article key={count.id} className="rounded-2xl border border-[#242433] bg-[#111117] p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div><div className="text-xs uppercase tracking-wide text-[#858591]">{COUNT_KIND_LABELS[count.count_kind] ?? count.count_kind}</div><h3 className="mt-2 font-semibold text-white">{inventoryCountTitle({ countKind: count.count_kind, createdAt: count.created_at, shiftBusinessDate: count.shift_business_date })}</h3><p className="mt-1 text-sm text-[#B6B6C2]">{inventoryCountFolio(count.id)} · {count.line_count} líneas · {count.variance_count} diferencias</p><p className="mt-1 text-xs text-[#858591]">Responsable: {count.created_by_name ?? count.responsible_role}</p></div><div className="lg:text-right"><div className="text-sm text-white">{formatDate(count.created_at)}</div><div className="mt-1 text-xs text-[#858591]">Estado: {count.status}</div><Link href={`/app/inventory/counts/${count.id}`} prefetch={false} className="mt-2 inline-block text-sm font-semibold text-[#FEEF00] hover:underline">Abrir reporte</Link></div></div></article>)}</div>;
}

function KardexReport({ inventoryItems, initialPage }: { inventoryItems: InventoryReportItem[]; initialPage: InventoryKardexPage }) {
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [page, setPage] = useState(initialPage);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function loadPage(itemId: number | null, append: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await loadInventoryKardexPageAction({
          inventoryItemId: itemId,
          cursor: append && page.next_cursor ? {
            beforeCreatedAt: page.next_cursor.before_created_at,
            beforeId: page.next_cursor.before_id,
          } : null,
          limit: 100,
        });
        const nextPage = (result ?? { items: [], next_cursor: null }) as InventoryKardexPage;
        setPage((current) => ({
          items: append ? [...current.items, ...(nextPage.items ?? [])] : (nextPage.items ?? []),
          next_cursor: nextPage.next_cursor ?? null,
        }));
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : 'No se pudo cargar el kardex.');
      }
    });
  }

  function changeItem(value: string) {
    const itemId = value ? Number(value) : null;
    setSelectedItemId(itemId);
    loadPage(itemId, false);
  }

  return (
    <div className="mt-5">
      <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
        <label className="block max-w-xl text-xs text-[#A6A6B2]">Filtrar por ítem<select className={`${INPUT_CLASS} mt-1`} value={selectedItemId ?? ''} disabled={isPending} onChange={(event) => changeItem(event.target.value)}><option value="">Todos los ítems</option>{inventoryItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <p className="mt-3 text-xs text-[#858591]">Solo incluye movimientos canónicos con operación identificable. Los descuentos heredados no se mezclan con este libro.</p>
      </div>
      {error ? <div className="mt-4 rounded-xl border border-red-400/35 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</div> : null}
      {page.items.length === 0 ? <EmptyState text={isPending ? 'Cargando kardex…' : 'Todavía no existen movimientos canónicos. El primer asiento será la apertura física.'} /> : <div className="mt-4 overflow-x-auto rounded-2xl border border-[#242433] bg-[#111117]"><table className="min-w-[1050px] w-full text-left text-sm"><thead className="border-b border-[#2A2A38] text-xs uppercase tracking-wide text-[#858591]"><tr><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Ítem</th><th className="px-4 py-3">Movimiento</th><th className="px-4 py-3">Saldo anterior</th><th className="px-4 py-3">Saldo resultante</th><th className="px-4 py-3">Referencia</th><th className="px-4 py-3">Actor</th></tr></thead><tbody className="divide-y divide-[#22222D]">{page.items.map((movement) => <tr key={movement.id} className="[content-visibility:auto]"><td className="px-4 py-4 text-[#B6B6C2]">{formatDate(movement.created_at)}</td><td className="px-4 py-4"><div className="font-semibold text-white">{movement.inventory_item_name}</div><div className="text-xs text-[#858591]">{movement.unit_name}</div></td><td className="px-4 py-4"><div className={movement.quantity_units < 0 ? 'font-semibold text-red-200' : 'font-semibold text-emerald-200'}>{movement.quantity_units > 0 ? '+' : ''}{quantity(movement.quantity_units)} {movement.unit_name}</div><div className="mt-1 text-xs text-[#858591]">{MOVEMENT_LABELS[movement.movement_type] ?? movement.movement_type}{movement.is_reversed ? ' · reversado' : ''}</div></td><td className="px-4 py-4 text-white">{quantity(movement.balance_before_units)} {movement.unit_name}</td><td className="px-4 py-4 font-semibold text-white">{quantity(movement.balance_after_units)} {movement.unit_name}</td><td className="px-4 py-4">{movement.order_id ? <Link href={`/app/master/ops?openOrder=${movement.order_id}`} prefetch={false} className="font-semibold text-[#FEEF00] hover:underline">Orden {movement.order_number ?? `#${movement.order_id}`}</Link> : <span className="text-xs text-[#858591]">{movement.reason_code ?? movement.operation_id}</span>}</td><td className="px-4 py-4 text-[#B6B6C2]">{movement.actor_name ?? 'Sistema'}</td></tr>)}</tbody></table></div>}
      {page.next_cursor ? <button type="button" className={`${SECONDARY_BUTTON_CLASS} mt-4`} disabled={isPending} onClick={() => loadPage(selectedItemId, true)}>{isPending ? 'Cargando…' : 'Cargar movimientos anteriores'}</button> : null}
    </div>
  );
}

function MetricValue({ value, unit, pending }: { value: number | null; unit: string; pending: boolean }) {
  return pending ? <><div className="font-semibold text-[#B6B6C2]">Pendiente</div><div className="mt-1 text-xs text-[#858591]">Requiere apertura</div></> : <div className="font-semibold text-white">{quantity(value)} {unit}</div>;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} className={active ? 'rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-black' : SECONDARY_BUTTON_CLASS} onClick={onClick}>{children}</button>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="mt-4 rounded-2xl border border-[#242433] bg-[#111117] p-8 text-center text-sm text-[#9696A3]">{text}</div>;
}

function SummaryCard({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'good' | 'warning' | 'info' | 'critical' }) {
  const valueClass = tone === 'good' ? 'text-emerald-300' : tone === 'warning' ? 'text-amber-200' : tone === 'info' ? 'text-sky-200' : tone === 'critical' ? 'text-red-300' : 'text-white';
  return <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4"><div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div><div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div></div>;
}
