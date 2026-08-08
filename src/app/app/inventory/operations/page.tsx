import { getAuthContext } from '@/lib/auth';
import InventoryReceiptWorkspaceClient, {
  type InventoryReceiptWorkspace,
} from './InventoryReceiptWorkspaceClient';

type InventoryItemRow = {
  id: number;
  name: string;
};

type CanonicalMovementRow = {
  id: number;
  inventory_item_id: number;
  movement_type: string;
  quantity_units: number | string;
  reason_code: string | null;
  operation_id: string;
  created_at: string;
};

const movementLabels: Record<string, string> = {
  inbound: 'Entrada',
  return_in: 'Devolución',
  damage: 'Avería',
  waste: 'Merma',
  quality_taste: 'Prueba de calidad',
  manual_adjustment: 'Ajuste administrativo',
  stock_count: 'Conteo físico',
  production_out: 'Consumo de preparación',
  production_in: 'Producción terminada',
  reversal: 'Reverso',
};

function formatQuantity(value: number | string) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(number)
    : String(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

export default async function InventoryOperationsPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    return null;
  }

  const [
    itemsResult,
    movementsResult,
    recipesResult,
    countsResult,
    openingStatusResult,
    receiptWorkspaceResult,
  ] = await Promise.all([
    ctx.supabase.from('inventory_items').select('id,name').order('name'),
    ctx.supabase
      .from('inventory_movements')
      .select(
        'id,inventory_item_id,movement_type,quantity_units,reason_code,operation_id,created_at',
        { count: 'exact' },
      )
      .not('operation_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(100),
    ctx.supabase
      .from('inventory_recipes')
      .select('id', { count: 'exact', head: true })
      .like('notes', 'Bloque 3:%')
      .eq('is_active', false),
    ctx.supabase
      .from('inventory_counts')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'submitted', 'recount_requested']),
    ctx.supabase.rpc('inventory_opening_status_v1'),
    ctx.supabase.rpc('inventory_receipt_workspace_v1'),
  ]);

  const firstError = [
    itemsResult.error,
    movementsResult.error,
    recipesResult.error,
    countsResult.error,
    openingStatusResult.error,
    receiptWorkspaceResult.error,
  ].find(Boolean);

  if (firstError) {
    throw new Error(`No se pudo cargar el estado del motor de inventario: ${firstError.message}`);
  }

  const items = (itemsResult.data ?? []) as InventoryItemRow[];
  const movements = (movementsResult.data ?? []) as CanonicalMovementRow[];
  const itemNameById = new Map(items.map((item) => [item.id, item.name]));
  const openingStatus = (openingStatusResult.data ?? {}) as {
    eligible_count?: unknown;
    accepted_count?: unknown;
    ready?: unknown;
  };
  const eligibleOpeningCount = Number(openingStatus.eligible_count ?? 0);
  const acceptedOpeningCount = Number(openingStatus.accepted_count ?? 0);
  const isCanonicalReady = openingStatus.ready === true;
  const receiptWorkspace = (receiptWorkspaceResult.data ?? {
    permissions: { can_plan: false, can_receive: false },
    items: [],
    presentations: [],
    active_expectations: [],
    recent_receipts: [],
    summary: {
      active_expectations: 0,
      overdue_expectations: 0,
      receipt_mismatches: 0,
    },
  }) as InventoryReceiptWorkspace;

  return (
    <section>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Motor atómico de inventario</h2>
          <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
            Estado técnico del centro de verdad. Esta página consulta Supabase solo cuando se abre y no
            ejecuta movimientos ni activa recetas.
          </p>
        </div>
        <div className="rounded-full border border-[#2B2B38] px-3 py-1 text-xs text-[#9D9DA9]">
          Bloque 11 · Recepciones
        </div>
      </div>

      <InventoryReceiptWorkspaceClient workspace={receiptWorkspace} />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <SummaryCard label="Ítems del catálogo" value={items.length} />
        <SummaryCard label="Aperturas aceptadas" value={acceptedOpeningCount} tone="good" />
        <SummaryCard label="Pendientes de apertura" value={Math.max(0, eligibleOpeningCount - acceptedOpeningCount)} tone="warn" />
        <SummaryCard label="Asientos canónicos" value={movementsResult.count ?? 0} tone="info" />
        <SummaryCard label="Conteos por revisar" value={countsResult.count ?? 0} tone="danger" />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
          <h3 className="font-semibold">Estado de activación</h3>
          <div className="mt-4 space-y-3 text-sm">
            <StatusRow label="Motor transaccional" value="Instalado y protegido" tone="good" />
            <StatusRow
              label="Recetas canónicas preparadas"
              value={`${recipesResult.count ?? 0} en espera`}
              tone="warn"
            />
            <StatusRow
              label="Descuento automático por ventas"
              value={isCanonicalReady ? 'Activo al entregar' : 'Espera apertura completa'}
              tone={isCanonicalReady ? 'good' : 'neutral'}
            />
            <StatusRow
              label="Apertura de existencias"
              value={`${acceptedOpeningCount} de ${eligibleOpeningCount} aceptadas`}
              tone={isCanonicalReady ? 'good' : 'neutral'}
            />
          </div>
          <p className="mt-4 text-xs leading-5 text-[#858591]">
            Un ítem empieza a usar el motor únicamente después de su conteo de apertura. Hasta entonces,
            sus registros históricos permanecen sin cambios y no se mezclan con los asientos canónicos.
          </p>
        </div>

        <div className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
          <h3 className="font-semibold">Autoridad operativa</h3>
          <div className="mt-4 space-y-3 text-sm text-[#C4C4CE]">
            <RoleRow role="Administración" detail="Apertura, ajustes y reversos." />
            <RoleRow role="Cocina" detail="Entradas, pérdidas, producción y conteos." />
            <RoleRow role="Master" detail="Revisión, aceptación y reconteos selectivos." />
          </div>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-2xl border border-[#242433] bg-[#111117]">
        <div className="flex items-center justify-between border-b border-[#242433] px-5 py-4">
          <div>
            <h3 className="font-semibold">Movimientos canónicos recientes</h3>
            <p className="mt-1 text-xs text-[#858591]">Máximo 100 asientos; el histórico anterior no se mezcla.</p>
          </div>
        </div>

        {movements.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-[#16161F] text-xs uppercase tracking-wide text-[#8F8F9C]">
                <tr>
                  <th className="px-4 py-3">Fecha</th>
                  <th className="px-4 py-3">Ítem</th>
                  <th className="px-4 py-3">Movimiento</th>
                  <th className="px-4 py-3">Cantidad</th>
                  <th className="px-4 py-3">Motivo</th>
                  <th className="px-4 py-3">Operación</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#242433]">
                {movements.map((movement) => (
                  <tr key={movement.id} className="hover:bg-[#15151D]">
                    <td className="px-4 py-3 text-[#A6A6B2]">{formatDate(movement.created_at)}</td>
                    <td className="px-4 py-3 font-medium">
                      {itemNameById.get(movement.inventory_item_id) ?? `Ítem #${movement.inventory_item_id}`}
                    </td>
                    <td className="px-4 py-3">
                      {movementLabels[movement.movement_type] ?? movement.movement_type}
                    </td>
                    <td className="px-4 py-3 font-semibold">{formatQuantity(movement.quantity_units)}</td>
                    <td className="px-4 py-3 text-[#A6A6B2]">{movement.reason_code ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[#8F8F9C]">
                      {movement.operation_id.slice(0, 8)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-12 text-center">
            <div className="font-semibold">Todavía no hay movimientos canónicos</div>
            <p className="mx-auto mt-2 max-w-xl text-sm text-[#8F8F9C]">
              Es el estado esperado: primero se realizará el conteo físico de apertura y luego se
              habilitarán los flujos operativos por etapas.
            </p>
          </div>
        )}
      </div>
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
  tone?: 'default' | 'good' | 'info' | 'warn' | 'danger';
}) {
  const valueClass = {
    default: 'text-white',
    good: 'text-[#86EFAC]',
    info: 'text-[#7DD3FC]',
    warn: 'text-[#FBBF24]',
    danger: 'text-[#FB7185]',
  }[tone];

  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'neutral';
}) {
  const valueClass = {
    good: 'text-[#86EFAC]',
    warn: 'text-[#FBBF24]',
    neutral: 'text-[#A6A6B2]',
  }[tone];

  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#242433] pb-3 last:border-0 last:pb-0">
      <span className="text-[#A6A6B2]">{label}</span>
      <span className={`text-right font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}

function RoleRow({ role, detail }: { role: string; detail: string }) {
  return (
    <div className="rounded-xl border border-[#242433] bg-[#15151D] p-3">
      <div className="font-semibold text-white">{role}</div>
      <div className="mt-1 text-xs text-[#9696A3]">{detail}</div>
    </div>
  );
}
