'use client';

import Link from 'next/link';
import { useDeferredValue, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  deleteInventoryAlertPolicyOverrideAction,
  refreshInventoryAlertsAction,
  saveInventoryAlertPolicyAction,
  updateInventoryAlertStatusAction,
  updateInventoryItemAlertSettingsAction,
  type InventoryAlertCategory,
  type InventoryAlertRouteInput,
} from '../actions';

type InventoryAlert = {
  id: number;
  alert_key: string;
  category: InventoryAlertCategory;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  requires_action: boolean;
  status: 'open' | 'managed' | 'resolved';
  inventory_item_id: number | null;
  inventory_item_name: string | null;
  unit_name: string | null;
  order_id: number | null;
  order_number: string | null;
  planned_flow_id: number | null;
  inventory_count_id: number | null;
  title: string;
  message: string | null;
  details: Record<string, unknown>;
  first_detected_at: string;
  last_detected_at: string;
  managed_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

type InventoryAlertPolicy = {
  id: number;
  category: InventoryAlertCategory;
  inventory_item_id: number | null;
  is_enabled: boolean;
  routes: Array<{
    target_role: InventoryAlertRouteInput['targetRole'];
    surface: InventoryAlertRouteInput['surface'];
  }>;
  updated_at: string;
};

type InventoryAlertItem = {
  id: number;
  name: string;
  unit_name: string;
  inventory_group: string;
  tracking_mode: string;
  is_active: boolean;
  low_stock_threshold: number | null;
  low_stock_inclusive: boolean;
  target_stock_units: number | null;
};

export type InventoryAlertWorkspace = {
  surface: string;
  generated_at: string;
  refresh: {
    detected_or_updated: number;
    automatically_resolved: number;
    refreshed_at: string;
  };
  summary: {
    open: number;
    managed: number;
    resolved: number;
    critical: number;
    requires_action: number;
  };
  alerts: InventoryAlert[];
  configuration: {
    can_configure: boolean;
    policies: InventoryAlertPolicy[];
    items: InventoryAlertItem[];
  };
};

const CATEGORY_ORDER: InventoryAlertCategory[] = [
  'availability',
  'commitment',
  'production',
  'control',
  'procurement',
  'system',
];

const CATEGORY_LABELS: Record<InventoryAlertCategory, string> = {
  availability: 'Disponibilidad comercial',
  commitment: 'Compromisos futuros',
  production: 'Producción y reposición',
  control: 'Conteos y diferencias',
  procurement: 'Procura',
  system: 'Integridad del sistema',
};

const ROUTE_OPTIONS: Array<InventoryAlertRouteInput & { key: string; label: string }> = [
  { key: 'admin-center', targetRole: 'admin', surface: 'inventory_center', label: 'Administración · centro' },
  { key: 'admin-module', targetRole: 'admin', surface: 'admin_inventory', label: 'Administración · módulo futuro' },
  { key: 'master-center', targetRole: 'master', surface: 'inventory_center', label: 'Master · centro' },
  { key: 'master-module', targetRole: 'master', surface: 'master_inventory', label: 'Master · lectura futura' },
  { key: 'advisor', targetRole: 'advisor', surface: 'advisor_availability', label: 'Asesor · disponibilidad futura' },
  { key: 'kitchen', targetRole: 'kitchen', surface: 'kitchen_inventory', label: 'Cocina · operación futura' },
  { key: 'counter', targetRole: 'counter', surface: 'counter_inventory', label: 'Counter · operación futura' },
];

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  timeZone: 'America/Caracas',
  dateStyle: 'medium',
  timeStyle: 'short',
});

const INPUT_CLASS = 'w-full rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-sm text-white outline-none focus:border-[#FEEF00]/70';
const PRIMARY_BUTTON_CLASS = 'rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#FFF34D] disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON_CLASS = 'rounded-xl border border-[#343442] bg-[#17171F] px-4 py-2 text-sm font-semibold text-[#D5D5DE] transition hover:border-[#FEEF00]/50 disabled:cursor-not-allowed disabled:opacity-50';

function formatDate(value: string | null) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function routeKey(route: {
  target_role?: InventoryAlertRouteInput['targetRole'];
  targetRole?: InventoryAlertRouteInput['targetRole'];
  surface: InventoryAlertRouteInput['surface'];
}) {
  return `${route.target_role ?? route.targetRole}:${route.surface}`;
}

function severityClass(severity: InventoryAlert['severity']) {
  if (severity === 'critical') return 'border-red-400/40 bg-red-400/10 text-red-200';
  if (severity === 'warning') return 'border-amber-300/40 bg-amber-300/10 text-amber-100';
  return 'border-sky-300/40 bg-sky-300/10 text-sky-100';
}

function statusLabel(status: InventoryAlert['status']) {
  if (status === 'managed') return 'En gestión';
  if (status === 'resolved') return 'Resuelta';
  return 'Abierta';
}

export default function InventoryAlertsClient({
  workspace,
}: {
  workspace: InventoryAlertWorkspace;
}) {
  const router = useRouter();
  const [section, setSection] = useState<'alerts' | 'configuration'>('alerts');
  const [statusFilter, setStatusFilter] = useState<'active' | 'all' | InventoryAlert['status']>('active');
  const [categoryFilter, setCategoryFilter] = useState<'all' | InventoryAlertCategory>('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase('es'));
  const [isPending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredAlerts = workspace.alerts.filter((alert) => {
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'active' && alert.status !== 'resolved')
      || alert.status === statusFilter;
    const matchesCategory = categoryFilter === 'all' || alert.category === categoryFilter;
    const searchable = `${alert.title} ${alert.message ?? ''} ${alert.inventory_item_name ?? ''}`
      .toLocaleLowerCase('es');
    return matchesStatus && matchesCategory && (!deferredSearch || searchable.includes(deferredSearch));
  });

  function runAction(key: string, successMessage: string, action: () => Promise<unknown>) {
    setPendingKey(key);
    setNotice(null);
    setError(null);
    startTransition(async () => {
      try {
        await action();
        setNotice(successMessage);
        router.refresh();
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : 'No se pudo completar la operación.');
      } finally {
        setPendingKey(null);
      }
    });
  }

  return (
    <section>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Alertas de inventario</h2>
          <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
            Señales operativas separadas de las acciones y del seguimiento de órdenes.
            La configuración define quién puede ver cada categoría y en qué ubicación.
          </p>
        </div>
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          disabled={isPending}
          onClick={() => runAction('refresh', 'Las alertas fueron recalculadas.', refreshInventoryAlertsAction)}
        >
          {pendingKey === 'refresh' ? 'Actualizando…' : 'Actualizar señales'}
        </button>
      </div>

      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Secciones de alertas">
        <button
          type="button"
          role="tab"
          aria-selected={section === 'alerts'}
          className={section === 'alerts' ? PRIMARY_BUTTON_CLASS : SECONDARY_BUTTON_CLASS}
          onClick={() => setSection('alerts')}
        >
          Centro de alertas
        </button>
        {workspace.configuration.can_configure ? (
          <button
            type="button"
            role="tab"
            aria-selected={section === 'configuration'}
            className={section === 'configuration' ? PRIMARY_BUTTON_CLASS : SECONDARY_BUTTON_CLASS}
            onClick={() => setSection('configuration')}
          >
            Configuración
          </button>
        ) : null}
      </div>

      {notice ? <div className="mt-4 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">{notice}</div> : null}
      {error ? <div className="mt-4 rounded-xl border border-red-400/35 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</div> : null}

      {section === 'alerts' ? (
        <AlertsPanel
          workspace={workspace}
          alerts={filteredAlerts}
          search={search}
          statusFilter={statusFilter}
          categoryFilter={categoryFilter}
          isPending={isPending}
          pendingKey={pendingKey}
          onSearch={setSearch}
          onStatusFilter={setStatusFilter}
          onCategoryFilter={setCategoryFilter}
          onRunAction={runAction}
        />
      ) : (
        <ConfigurationPanel workspace={workspace} isPending={isPending} onRunAction={runAction} />
      )}
    </section>
  );
}

function AlertsPanel({
  workspace,
  alerts,
  search,
  statusFilter,
  categoryFilter,
  isPending,
  pendingKey,
  onSearch,
  onStatusFilter,
  onCategoryFilter,
  onRunAction,
}: {
  workspace: InventoryAlertWorkspace;
  alerts: InventoryAlert[];
  search: string;
  statusFilter: 'active' | 'all' | InventoryAlert['status'];
  categoryFilter: 'all' | InventoryAlertCategory;
  isPending: boolean;
  pendingKey: string | null;
  onSearch: (value: string) => void;
  onStatusFilter: (value: 'active' | 'all' | InventoryAlert['status']) => void;
  onCategoryFilter: (value: 'all' | InventoryAlertCategory) => void;
  onRunAction: (key: string, message: string, action: () => Promise<unknown>) => void;
}) {
  return (
    <div className="mt-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <SummaryCard label="Abiertas" value={workspace.summary.open} />
        <SummaryCard label="En gestión" value={workspace.summary.managed} />
        <SummaryCard label="Críticas" value={workspace.summary.critical} tone="critical" />
        <SummaryCard label="Requieren acción" value={workspace.summary.requires_action} tone="warning" />
        <SummaryCard label="Resueltas" value={workspace.summary.resolved} />
      </div>

      <div className="mt-5 grid gap-3 rounded-2xl border border-[#242433] bg-[#111117] p-4 md:grid-cols-3">
        <label className="text-xs text-[#A6A6B2]">
          Buscar
          <input className={`${INPUT_CLASS} mt-1`} value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Ítem o alerta" />
        </label>
        <label className="text-xs text-[#A6A6B2]">
          Estado
          <select className={`${INPUT_CLASS} mt-1`} value={statusFilter} onChange={(event) => onStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="active">Activas</option>
            <option value="open">Abiertas</option>
            <option value="managed">En gestión</option>
            <option value="resolved">Resueltas</option>
            <option value="all">Todas</option>
          </select>
        </label>
        <label className="text-xs text-[#A6A6B2]">
          Categoría
          <select className={`${INPUT_CLASS} mt-1`} value={categoryFilter} onChange={(event) => onCategoryFilter(event.target.value as typeof categoryFilter)}>
            <option value="all">Todas</option>
            {CATEGORY_ORDER.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
          </select>
        </label>
      </div>

      {alerts.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-[#242433] bg-[#111117] p-8 text-center text-sm text-[#9696A3]">
          No hay alertas que coincidan con estos filtros.
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {alerts.map((alert) => (
            <article key={alert.id} className="[content-visibility:auto] rounded-2xl border border-[#242433] bg-[#111117] p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-xs ${severityClass(alert.severity)}`}>{alert.severity === 'critical' ? 'Crítica' : alert.severity === 'warning' ? 'Atención' : 'Informativa'}</span>
                    <span className="rounded-full border border-[#30303D] px-2.5 py-1 text-xs text-[#C5C5CF]">{CATEGORY_LABELS[alert.category]}</span>
                    <span className="rounded-full border border-[#30303D] px-2.5 py-1 text-xs text-[#C5C5CF]">{statusLabel(alert.status)}</span>
                    {alert.requires_action ? <span className="rounded-full border border-violet-300/35 px-2.5 py-1 text-xs text-violet-200">Requiere acción</span> : null}
                  </div>
                  <h3 className="mt-3 font-semibold text-white">{alert.title}</h3>
                  {alert.message ? <p className="mt-1 text-sm text-[#B6B6C2]">{alert.message}</p> : null}
                  {alert.inventory_item_name ? <p className="mt-2 text-xs text-[#9696A3]">Ítem: {alert.inventory_item_name}</p> : null}
                  <p className="mt-2 text-xs text-[#777784]">Detectada: {formatDate(alert.first_detected_at)} · Última señal: {formatDate(alert.last_detected_at)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {alert.order_id ? <Link href={`/app/master/ops?openOrder=${alert.order_id}&tab=eventos`} prefetch={false} className={SECONDARY_BUTTON_CLASS}>Ver orden {alert.order_number ?? `#${alert.order_id}`}</Link> : null}
                  {alert.status === 'open' ? <button type="button" className={SECONDARY_BUTTON_CLASS} disabled={isPending} onClick={() => onRunAction(`manage-${alert.id}`, 'La alerta quedó en gestión.', () => updateInventoryAlertStatusAction({ alertId: alert.id, action: 'manage' }))}>{pendingKey === `manage-${alert.id}` ? 'Guardando…' : 'Tomar gestión'}</button> : null}
                  {workspace.configuration.can_configure && alert.status !== 'resolved' ? <button type="button" className={SECONDARY_BUTTON_CLASS} disabled={isPending} onClick={() => onRunAction(`resolve-${alert.id}`, 'La alerta fue resuelta manualmente.', () => updateInventoryAlertStatusAction({ alertId: alert.id, action: 'resolve' }))}>{pendingKey === `resolve-${alert.id}` ? 'Guardando…' : 'Resolver'}</button> : null}
                  {workspace.configuration.can_configure && alert.status === 'resolved' ? <button type="button" className={SECONDARY_BUTTON_CLASS} disabled={isPending} onClick={() => onRunAction(`reopen-${alert.id}`, 'La alerta fue reabierta.', () => updateInventoryAlertStatusAction({ alertId: alert.id, action: 'reopen' }))}>{pendingKey === `reopen-${alert.id}` ? 'Guardando…' : 'Reabrir'}</button> : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigurationPanel({
  workspace,
  isPending,
  onRunAction,
}: {
  workspace: InventoryAlertWorkspace;
  isPending: boolean;
  onRunAction: (key: string, message: string, action: () => Promise<unknown>) => void;
}) {
  const globalPolicies = workspace.configuration.policies.filter((policy) => policy.inventory_item_id == null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(workspace.configuration.items[0]?.id ?? null);
  const selectedItem = workspace.configuration.items.find((item) => item.id === selectedItemId) ?? null;

  return (
    <div className="mt-5 space-y-6">
      <div className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
        <h3 className="font-semibold text-white">Reglas generales por categoría</h3>
        <p className="mt-1 text-sm text-[#9696A3]">Estas rutas son la base. Un ítem solo necesita una excepción cuando debe comportarse distinto.</p>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {CATEGORY_ORDER.map((category) => {
            const policy = globalPolicies.find((candidate) => candidate.category === category);
            return policy ? <PolicyEditor key={policy.id} policy={policy} inventoryItemId={null} isPending={isPending} onRunAction={onRunAction} /> : null;
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
        <h3 className="font-semibold text-white">Configuración específica por ítem</h3>
        <p className="mt-1 text-sm text-[#9696A3]">Reutiliza el umbral y el objetivo del catálogo; también permite excepciones de audiencia sin crear campos duplicados.</p>
        <label className="mt-4 block max-w-xl text-xs text-[#A6A6B2]">
          Ítem de inventario
          <select className={`${INPUT_CLASS} mt-1`} value={selectedItemId ?? ''} onChange={(event) => setSelectedItemId(event.target.value ? Number(event.target.value) : null)}>
            {workspace.configuration.items.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_active ? '' : ' · inactivo'}</option>)}
          </select>
        </label>

        {selectedItem ? (
          <div key={selectedItem.id} className="mt-5 space-y-5">
            <ItemThresholdEditor item={selectedItem} isPending={isPending} onRunAction={onRunAction} />
            <div>
              <h4 className="text-sm font-semibold text-white">Excepciones de audiencia</h4>
              <div className="mt-3 grid gap-4 xl:grid-cols-2">
                {CATEGORY_ORDER.map((category) => {
                  const override = workspace.configuration.policies.find((policy) => policy.inventory_item_id === selectedItem.id && policy.category === category);
                  const inherited = globalPolicies.find((policy) => policy.category === category);
                  return inherited ? (
                    <PolicyEditor
                      key={`${selectedItem.id}-${category}-${override?.id ?? 'inherited'}`}
                      policy={override ?? inherited}
                      inventoryItemId={selectedItem.id}
                      hasOverride={Boolean(override)}
                      isPending={isPending}
                      onRunAction={onRunAction}
                    />
                  ) : null;
                })}
              </div>
            </div>
          </div>
        ) : <p className="mt-4 text-sm text-[#9696A3]">No hay ítems disponibles para configurar.</p>}
      </div>
    </div>
  );
}

function PolicyEditor({
  policy,
  inventoryItemId,
  hasOverride = true,
  isPending,
  onRunAction,
}: {
  policy: InventoryAlertPolicy;
  inventoryItemId: number | null;
  hasOverride?: boolean;
  isPending: boolean;
  onRunAction: (key: string, message: string, action: () => Promise<unknown>) => void;
}) {
  const initialRouteKeys = new Set(policy.routes.map(routeKey));
  const [enabled, setEnabled] = useState(policy.is_enabled);
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(initialRouteKeys);
  const editorKey = `${inventoryItemId ?? 'global'}-${policy.category}`;

  function toggleRoute(key: string) {
    setSelectedRoutes((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function save() {
    const routes = enabled
      ? ROUTE_OPTIONS.filter((route) => selectedRoutes.has(`${route.targetRole}:${route.surface}`)).map(({ targetRole, surface }) => ({ targetRole, surface }))
      : [];
    onRunAction(`policy-${editorKey}`, 'La política de alertas fue guardada.', () => saveInventoryAlertPolicyAction({
      category: policy.category,
      inventoryItemId,
      isEnabled: enabled,
      routes,
    }));
  }

  return (
    <div className="rounded-xl border border-[#2C2C39] bg-[#0D0D12] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-white">{CATEGORY_LABELS[policy.category]}</h4>
          <p className="mt-1 text-xs text-[#858591]">{inventoryItemId != null && !hasOverride ? 'Hereda la regla general' : inventoryItemId != null ? 'Excepción activa' : 'Regla general'}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-[#C5C5CF]">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Activa
        </label>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {ROUTE_OPTIONS.map((route) => {
          const key = `${route.targetRole}:${route.surface}`;
          return (
            <label key={route.key} className="flex items-start gap-2 text-xs text-[#B6B6C2]">
              <input type="checkbox" checked={enabled && selectedRoutes.has(key)} disabled={!enabled} onChange={() => toggleRoute(key)} />
              <span>{route.label}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={PRIMARY_BUTTON_CLASS} disabled={isPending || (enabled && selectedRoutes.size === 0)} onClick={save}>Guardar</button>
        {inventoryItemId != null && hasOverride ? (
          <button type="button" className={SECONDARY_BUTTON_CLASS} disabled={isPending} onClick={() => onRunAction(`inherit-${editorKey}`, 'El ítem volvió a heredar la regla general.', () => deleteInventoryAlertPolicyOverrideAction({ category: policy.category, inventoryItemId }))}>Restaurar herencia</button>
        ) : null}
      </div>
    </div>
  );
}

function ItemThresholdEditor({
  item,
  isPending,
  onRunAction,
}: {
  item: InventoryAlertItem;
  isPending: boolean;
  onRunAction: (key: string, message: string, action: () => Promise<unknown>) => void;
}) {
  const [threshold, setThreshold] = useState(item.low_stock_threshold == null ? '' : String(item.low_stock_threshold));
  const [target, setTarget] = useState(item.target_stock_units == null ? '' : String(item.target_stock_units));
  const [inclusive, setInclusive] = useState(item.low_stock_inclusive);

  return (
    <div className="rounded-xl border border-[#2C2C39] bg-[#0D0D12] p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <label className="text-xs text-[#A6A6B2]">Umbral de alerta ({item.unit_name})<input className={`${INPUT_CLASS} mt-1`} inputMode="decimal" value={threshold} onChange={(event) => setThreshold(event.target.value)} placeholder="Sin umbral" /></label>
        <label className="text-xs text-[#A6A6B2]">Objetivo de reposición ({item.unit_name})<input className={`${INPUT_CLASS} mt-1`} inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Sin objetivo" /></label>
        <label className="flex items-center gap-2 rounded-xl border border-[#30303E] px-3 py-2 text-xs text-[#C5C5CF]"><input type="checkbox" checked={inclusive} onChange={(event) => setInclusive(event.target.checked)} />Alertar al llegar al umbral</label>
      </div>
      <button type="button" className={`${PRIMARY_BUTTON_CLASS} mt-4`} disabled={isPending} onClick={() => onRunAction(`item-${item.id}`, 'Los parámetros del ítem fueron guardados.', () => updateInventoryItemAlertSettingsAction({ inventoryItemId: item.id, lowStockThreshold: threshold, lowStockInclusive: inclusive, targetStockUnits: target }))}>Guardar parámetros</button>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'warning' | 'critical';
}) {
  const valueClass = tone === 'critical' ? 'text-red-300' : tone === 'warning' ? 'text-amber-200' : 'text-white';
  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}
