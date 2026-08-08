import Link from 'next/link';
import { unstable_noStore as noStore } from 'next/cache';
import { getAuthContext } from '@/lib/auth';
import { inventoryDisplayText } from '../display';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type InventoryIncidentRow = {
  id: number | string;
  order_id: number | string;
  order_number: string | null;
  event_type: string;
  title: string;
  message: string | null;
  severity: 'info' | 'warning' | 'critical' | string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

type InboxStateRow = {
  item_id: string;
  status: string;
};

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  timeZone: 'America/Caracas',
  dateStyle: 'medium',
  timeStyle: 'short',
});

const stageLabels: Record<string, string> = {
  order_item_snapshot: 'Composición',
  order_item_change: 'Cambio de partida',
  order_lifecycle: 'Proyección',
  order_delivery: 'Entrega',
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown) {
  return inventoryDisplayText(String(value ?? '')).trim();
}

function formatIncidentDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function getShortageNames(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.shortages)) return [];
  return payload.shortages
    .map((shortage) => cleanText(objectValue(shortage).inventory_item_name))
    .filter(Boolean);
}

function severityClasses(severity: string) {
  if (severity === 'critical') return 'border-red-400/35 bg-red-400/5 text-red-200';
  if (severity === 'warning') return 'border-amber-300/35 bg-amber-300/5 text-amber-100';
  return 'border-sky-300/35 bg-sky-300/5 text-sky-100';
}

export default async function InventoryIncidentsPage() {
  noStore();
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data: incidentData, error: incidentError } = await ctx.supabase
    .from('order_timeline_events')
    .select('id, order_id, order_number, event_type, title, message, severity, payload, created_at')
    .eq('event_group', 'inventory')
    .order('created_at', { ascending: false })
    .limit(100);

  if (incidentError) {
    throw new Error(`No se pudieron cargar las incidencias de inventario: ${incidentError.message}`);
  }

  const incidents = (incidentData ?? []) as InventoryIncidentRow[];
  const stateIds = incidents.map((incident) => `timeline-${incident.id}`);
  const { data: stateData, error: stateError } = stateIds.length > 0
    ? await ctx.supabase
        .from('master_inbox_item_states')
        .select('item_id, status')
        .in('item_id', stateIds)
    : { data: [] as InboxStateRow[], error: null };

  if (stateError) {
    console.warn('inventory incident states unavailable', stateError.message);
  }

  const stateByItemId = new Map(
    ((stateData ?? []) as InboxStateRow[]).map((state) => [state.item_id, state.status]),
  );
  const criticalCount = incidents.filter((incident) => incident.severity === 'critical').length;
  const pendingCount = incidents.filter(
    (incident) => !stateByItemId.has(`timeline-${incident.id}`),
  ).length;

  return (
    <section>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Incidencias de inventario en órdenes</h2>
          <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
            Inventario informa y conserva la trazabilidad sin detener la creación, aprobación,
            preparación ni entrega de una orden.
          </p>
        </div>
        <div className="rounded-full border border-[#2B2B38] px-3 py-1 text-xs text-[#9D9DA9]">
          Lectura independiente · últimas 100
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Registradas" value={incidents.length} />
        <SummaryCard label="Pendientes" value={pendingCount} tone="warning" />
        <SummaryCard label="Críticas" value={criticalCount} tone="critical" />
      </div>

      {incidents.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-[#242433] bg-[#111117] p-8 text-center text-sm text-[#9696A3]">
          No hay incidencias de inventario registradas en órdenes.
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {incidents.map((incident) => {
            const payload = objectValue(incident.payload);
            const stage = cleanText(payload.stage);
            const shortageNames = getShortageNames(payload);
            const error = cleanText(payload.error);
            const status = stateByItemId.get(`timeline-${incident.id}`) ?? 'pending';
            const orderId = Number(incident.order_id);

            return (
              <article
                key={incident.id}
                className="rounded-2xl border border-[#242433] bg-[#111117] p-4"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-xs ${severityClasses(incident.severity)}`}>
                        {incident.severity === 'critical' ? 'Crítica' : 'Revisión'}
                      </span>
                      <span className="rounded-full border border-[#30303D] px-2.5 py-1 text-xs text-[#B6B6C2]">
                        {stageLabels[stage] ?? 'Inventario'}
                      </span>
                      <span className="rounded-full border border-[#30303D] px-2.5 py-1 text-xs text-[#B6B6C2]">
                        {status === 'resolved' ? 'Resuelta' : status === 'reviewed' ? 'Revisada' : 'Pendiente'}
                      </span>
                    </div>
                    <h3 className="mt-3 font-semibold text-white">
                      {inventoryDisplayText(incident.title)}
                    </h3>
                    {incident.message ? (
                      <p className="mt-1 text-sm text-[#B6B6C2]">
                        {inventoryDisplayText(incident.message)}
                      </p>
                    ) : null}
                    {shortageNames.length > 0 ? (
                      <p className="mt-2 text-sm text-red-200">
                        Faltante detectado: {shortageNames.join(', ')}
                      </p>
                    ) : null}
                    {error ? (
                      <p className="mt-2 break-words text-xs text-[#8F8F9C]">Detalle técnico: {error}</p>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-left text-xs text-[#858591] lg:text-right">
                    <div>{formatIncidentDate(incident.created_at)}</div>
                    <Link
                      href={`/app/master/ops?openOrder=${orderId}&tab=eventos`}
                      prefetch={false}
                      className="mt-2 inline-block font-semibold text-[#FEEF00] hover:underline"
                    >
                      Ver orden {incident.order_number || `#${orderId}`}
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
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
  const valueClass = tone === 'critical'
    ? 'text-red-300'
    : tone === 'warning'
      ? 'text-amber-200'
      : 'text-white';

  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}
