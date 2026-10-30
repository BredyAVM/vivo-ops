import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { inventoryUnitLabel } from '@/app/app/inventory/display';
import { inventoryCountTitle } from '@/app/app/inventory/count-presentation';

type RelationOne<T> = T | T[] | null;

type OpenCountRow = {
  id: number;
  count_kind: string;
  due_at: string | null;
  notes: string | null;
  created_at: string;
  shift_business_date: string | null;
  created_by: RelationOne<{ full_name: string | null }>;
  lines: Array<{ id: number }> | null;
};

type ExpectedReceiptRow = {
  id: number;
  quantity_units: number | string;
  effective_at: string;
  notes: string | null;
  created_at: string;
  item: RelationOne<{ name: string; unit_name: string }>;
  created_by: RelationOne<{ full_name: string | null }>;
};

type InventoryTask = {
  key: string;
  kind: 'count' | 'receipt';
  title: string;
  detail: string;
  openedByName: string;
  scheduledAt: string | null;
  createdAt: string;
  notes: string | null;
  href: string;
};

const operations = [
  {
    href: '/app/kitchen/inventory/receipts',
    eyebrow: 'Llegó mercancía',
    title: 'Registrar entrada',
    detail: 'Ingresa únicamente lo recibido físicamente y concilia cualquier expectativa de Máster.',
  },
  {
    href: '/app/kitchen/inventory/production',
    eyebrow: 'Se preparó un lote',
    title: 'Registrar producción',
    detail: 'Inicia o termina una preparación usando la receta, el tiempo y el rendimiento real.',
  },
  {
    href: '/app/kitchen/inventory/losses',
    eyebrow: 'Hubo una salida de calidad',
    title: 'Reportar calidad',
    detail: 'Registra averías, mermas o cantidades consumidas en pruebas de calidad.',
  },
];

function relationOne<T>(value: RelationOne<T>) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function formatQuantity(value: number | string, unitName: string | null | undefined) {
  const amount = Number(value);
  const quantity = Number.isFinite(amount)
    ? new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(amount)
    : String(value);
  return `${quantity} ${inventoryUnitLabel(unitName)}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'fecha no disponible';
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(date);
}

function taskTime(task: InventoryTask) {
  return new Date(task.scheduledAt || task.createdAt).getTime();
}

export default async function KitchenInventoryPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const [openCountsResult, expectedReceiptsResult] = await Promise.all([
    ctx.supabase
      .from('inventory_counts')
      .select([
        'id',
        'count_kind',
        'due_at',
        'notes',
        'created_at',
        'shift_business_date',
        'created_by:profiles!inventory_counts_created_by_user_id_fkey(full_name)',
        'lines:inventory_count_lines(id)',
      ].join(', '))
      .eq('status', 'open')
      .eq('responsible_role', 'kitchen')
      .order('created_at', { ascending: true }),
    ctx.supabase
      .from('inventory_planned_flows')
      .select([
        'id',
        'quantity_units',
        'effective_at',
        'notes',
        'created_at',
        'item:inventory_items!inventory_planned_flows_inventory_item_id_fkey(name,unit_name)',
        'created_by:profiles!inventory_planned_flows_created_by_user_id_fkey(full_name)',
      ].join(', '))
      .eq('flow_type', 'expected_receipt')
      .eq('status', 'active')
      .order('effective_at', { ascending: true }),
  ]);

  const taskLoadError = openCountsResult.error ?? expectedReceiptsResult.error;
  const openCounts = taskLoadError
    ? []
    : (openCountsResult.data ?? []) as unknown as OpenCountRow[];
  const expectedReceipts = taskLoadError
    ? []
    : (expectedReceiptsResult.data ?? []) as unknown as ExpectedReceiptRow[];

  const tasks: InventoryTask[] = [
    ...openCounts.map((count) => ({
      key: `count-${count.id}`,
      kind: 'count' as const,
      title: inventoryCountTitle({
        countKind: count.count_kind,
        createdAt: count.created_at,
        shiftBusinessDate: count.shift_business_date,
      }),
      detail: `${count.lines?.length ?? 0} productos por contar`,
      openedByName: relationOne(count.created_by)?.full_name?.trim() || 'Máster',
      scheduledAt: count.due_at,
      createdAt: count.created_at,
      notes: count.notes,
      href: '/app/kitchen/inventory/counts',
    })),
    ...expectedReceipts.map((receipt) => {
      const item = relationOne(receipt.item);
      return {
        key: `receipt-${receipt.id}`,
        kind: 'receipt' as const,
        title: `Recibir ${item?.name || 'mercancía'}`,
        detail: `${formatQuantity(receipt.quantity_units, item?.unit_name)} esperadas`,
        openedByName: relationOne(receipt.created_by)?.full_name?.trim() || 'Máster',
        scheduledAt: receipt.effective_at,
        createdAt: receipt.created_at,
        notes: receipt.notes,
        href: '/app/kitchen/inventory/receipts',
      };
    }),
  ].sort((left, right) => taskTime(left) - taskTime(right));

  return (
    <section>
      <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm leading-6 text-emerald-100">
        Este apartado no bloquea pedidos. Cada operación deja trazabilidad en el mismo Centro de Inventario.
      </div>

      <section
        aria-labelledby="kitchen-inventory-tasks-title"
        className="mt-5 rounded-2xl border border-[#FEEF00]/40 bg-[#111117] p-4 sm:p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.14em] text-[#FEEF00]">
              Pendientes de Cocina
            </div>
            <h2 id="kitchen-inventory-tasks-title" className="mt-1 text-xl font-black">
              {tasks.length} {tasks.length === 1 ? 'tarea por resolver' : 'tareas por resolver'}
            </h2>
            <p className="mt-1 text-sm leading-6 text-[#B7B7C2]">
              Este es el desglose del número que aparece junto a Inventario en la pantalla de pedidos.
            </p>
          </div>
          <span className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-[#FEEF00] px-3 text-lg font-black text-black">
            {tasks.length}
          </span>
        </div>

        {taskLoadError ? (
          <div role="alert" className="mt-4 rounded-xl border border-red-400/35 bg-red-400/10 px-3 py-3 text-sm text-red-100">
            No se pudo cargar el desglose de pendientes. Actualiza la pantalla para volver a intentarlo.
          </div>
        ) : tasks.length ? (
          <div className="mt-4 grid gap-3">
            {tasks.map((task) => {
              const scheduleLabel = task.kind === 'count' ? 'Vence' : 'Esperada';

              return (
                <Link
                  key={task.key}
                  href={task.href}
                  prefetch={false}
                  className="block rounded-xl border border-[#303041] bg-[#0B0B10] p-4 transition active:scale-[0.99] hover:border-[#FEEF00]/55"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-[#FEEF00]/30 bg-[#FEEF00]/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-[#FEEF00]">
                          {task.kind === 'count' ? 'Conteo' : 'Entrada'}
                        </span>
                        <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10px] font-bold text-sky-100">
                          Pendiente
                        </span>
                      </div>
                      <h3 className="mt-2 font-black leading-snug text-white">{task.title}</h3>
                      <p className="mt-1 text-sm font-semibold text-[#D1D1DA]">{task.detail}</p>
                      <p className="mt-1 text-xs leading-5 text-[#92929F]">
                        {scheduleLabel} {formatDateTime(task.scheduledAt || task.createdAt)} · solicitada por {task.openedByName}
                      </p>
                      {task.notes?.trim() ? (
                        <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-2 text-xs leading-5 text-amber-100">
                          {task.notes.trim()}
                        </p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-sm font-black text-[#FEEF00]" aria-hidden="true">
                      Abrir →
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/5 px-4 py-4 text-sm font-semibold text-emerald-100">
            No hay solicitudes pendientes. Cocina está al día.
          </div>
        )}
      </section>

      <Link
        href="/app/kitchen/inventory/counts"
        prefetch={false}
        className="mt-5 block rounded-2xl border border-[#FEEF00]/45 bg-[#FEEF00]/8 p-5 transition hover:border-[#FEEF00]"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#FEEF00]">Tarea principal</div>
            <h2 className="mt-1 text-xl font-black">Hacer inventario</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#C4C4CE]">
              Elige por turno, diario, semanal, quincenal o mensual. Verás únicamente los productos configurados para ese inventario y nunca el saldo esperado.
            </p>
          </div>
          <span className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl bg-[#FEEF00] px-5 font-black text-black">
            Seleccionar tipo →
          </span>
        </div>
      </Link>

      <div className="mt-7">
        <h2 className="text-lg font-bold">Otras operaciones</h2>
        <p className="mt-1 text-sm text-[#858591]">Abre solo la tarea que necesitas registrar.</p>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        {operations.map((operation) => (
          <Link
            key={operation.href}
            href={operation.href}
            prefetch={false}
            className="rounded-2xl border border-[#292938] bg-[#111117] p-5 hover:border-[#FEEF00]/55"
          >
            <div className="text-xs font-bold uppercase tracking-[0.12em] text-[#858591]">{operation.eyebrow}</div>
            <div>
              <h3 className="mt-2 text-lg font-bold">{operation.title}</h3>
              <p className="mt-2 text-sm leading-6 text-[#A6A6B2]">{operation.detail}</p>
              <div className="mt-4 text-sm font-semibold text-[#FEEF00]">Abrir →</div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
