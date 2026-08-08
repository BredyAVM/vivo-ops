import InventoryOpeningClient, { type InventoryOpeningItem } from './InventoryOpeningClient';
import { getAuthContext } from '@/lib/auth';
import { inventoryDisplayText } from '../display';

type OpeningStatusPayload = {
  eligible_count?: unknown;
  accepted_count?: unknown;
  under_review_count?: unknown;
  pending_count?: unknown;
  ready?: unknown;
  items?: unknown;
};

function toCount(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseOpeningItems(value: unknown): InventoryOpeningItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((rawItem) => {
    const item = rawItem as Record<string, unknown>;
    const id = Number(item.id);
    const rawStatus = String(item.opening_status ?? 'pending');
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    if (!['pending', 'under_review', 'accepted'].includes(rawStatus)) return [];

    const rawCountId = item.inventory_count_id;
    const inventoryCountId = rawCountId == null ? null : Number(rawCountId);
    return [{
      id,
      name: inventoryDisplayText(String(item.name ?? `Ítem #${id}`)),
      inventoryGroup: String(item.inventory_group ?? 'other'),
      unitName: inventoryDisplayText(String(item.unit_name ?? 'unidad')),
      trackingMode: String(item.tracking_mode ?? 'transactional'),
      openingStatus: rawStatus as InventoryOpeningItem['openingStatus'],
      inventoryCountId:
        inventoryCountId != null && Number.isSafeInteger(inventoryCountId) && inventoryCountId > 0
          ? inventoryCountId
          : null,
    }];
  });
}

export default async function InventoryOpeningPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data, error } = await ctx.supabase.rpc('inventory_opening_status_v1');
  if (error) {
    throw new Error(`No se pudo cargar la apertura física: ${error.message}`);
  }

  const payload = (data ?? {}) as OpeningStatusPayload;
  const items = parseOpeningItems(payload.items);
  const eligibleCount = toCount(payload.eligible_count);
  const acceptedCount = toCount(payload.accepted_count);
  const underReviewCount = toCount(payload.under_review_count);
  const pendingCount = toCount(payload.pending_count);
  const ready = payload.ready === true;
  const isAdmin = ctx.roles.includes('admin');

  return (
    <section>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Apertura física de inventario</h2>
          <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
            Conteo ciego por lotes. Los saldos previos no se muestran y el corte de ventas se activa solo
            cuando todos los ítems hayan sido revisados y aceptados.
          </p>
        </div>
        <div className={`rounded-full border px-3 py-1 text-xs font-semibold ${ready ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>
          {ready ? 'Centro canónico activo' : 'Corte de ventas aún inactivo'}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="Inventariables" value={eligibleCount} />
        <SummaryCard label="Aceptados" value={acceptedCount} tone="good" />
        <SummaryCard label="En revisión" value={underReviewCount} tone="warn" />
        <SummaryCard label="Pendientes" value={pendingCount} tone="danger" />
      </div>

      {!isAdmin ? (
        <div className="mt-5 rounded-2xl border border-sky-400/20 bg-sky-400/5 p-4 text-sm text-sky-100">
          Master puede revisar el avance y abrir cada conteo. La captura física inicial corresponde a
          administración.
        </div>
      ) : null}

      <InventoryOpeningClient items={items} isAdmin={isAdmin} />
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
  tone?: 'default' | 'good' | 'warn' | 'danger';
}) {
  const valueClass = {
    default: 'text-white',
    good: 'text-[#86EFAC]',
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
