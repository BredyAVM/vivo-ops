import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { displayLabel, inventoryRoleLabels } from '../display';

type InventoryCountRow = {
  id: number;
  count_kind: string;
  status: string;
  responsible_role: string;
  due_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string;
};

const kindLabels: Record<string, string> = {
  opening: 'Apertura física',
  shift_change: 'Cambio de turno',
  requested: 'Solicitado',
  recount: 'Reconteo',
  periodic: 'Periódico',
};

const statusLabels: Record<string, string> = {
  open: 'Abierto',
  submitted: 'Enviado',
  accepted: 'Aceptado',
  recount_requested: 'Reconteo solicitado',
  expired: 'Vencido',
  cancelled: 'Cancelado',
};

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

export default async function InventoryCountsPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    return null;
  }

  const { data, error } = await ctx.supabase
    .from('inventory_counts')
    .select('id,count_kind,status,responsible_role,due_at,submitted_at,reviewed_at,created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`No se pudieron cargar los conteos históricos: ${error.message}`);
  }

  const counts = (data ?? []) as InventoryCountRow[];
  const pendingReviewCount = counts.filter((count) => count.status === 'submitted').length;
  const activeRecountCount = counts.filter(
    (count) => count.count_kind === 'recount' && ['open', 'submitted'].includes(count.status),
  ).length;
  const orderedCounts = [...counts].sort((left, right) => {
    const leftPriority = left.status === 'submitted' ? 0 : left.status === 'recount_requested' ? 1 : 2;
    const rightPriority = right.status === 'submitted' ? 0 : right.status === 'recount_requested' ? 1 : 2;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  });

  return (
    <section>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Conteos y revisiones</h2>
          <p className="mt-1 text-sm text-[#9696A3]">
            Los pendientes de decisión aparecen primero. Esta consulta se ejecuta solamente al abrir esta sección.
          </p>
        </div>
        <div className="text-sm text-[#8F8F9C]">Últimos {Math.min(counts.length, 100)} registros</div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Por revisar" value={pendingReviewCount} tone={pendingReviewCount > 0 ? 'warning' : 'default'} />
        <SummaryCard label="Reconteos activos" value={activeRecountCount} tone={activeRecountCount > 0 ? 'warning' : 'default'} />
        <SummaryCard label="Registros visibles" value={counts.length} tone="default" />
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl border border-[#242433] bg-[#111117]">
        {counts.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[850px] w-full text-left text-sm">
              <thead className="bg-[#16161F] text-xs uppercase tracking-wide text-[#8F8F9C]">
                <tr>
                  <th className="px-4 py-3">Conteo</th>
                  <th className="px-4 py-3">Tipo</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Responsable</th>
                  <th className="px-4 py-3">Creado</th>
                  <th className="px-4 py-3">Vence</th>
                  <th className="px-4 py-3">Enviado</th>
                  <th className="px-4 py-3">Revisado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#242433]">
                {orderedCounts.map((count) => (
                  <tr key={count.id} className="hover:bg-[#15151D]">
                    <td className="px-4 py-3 font-semibold">
                      <Link
                        href={`/app/inventory/counts/${count.id}`}
                        prefetch={false}
                        className="text-[#FEEF00] hover:underline"
                      >
                        #{count.id}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{kindLabels[count.count_kind] ?? count.count_kind}</td>
                    <td className="px-4 py-3">{statusLabels[count.status] ?? count.status}</td>
                    <td className="px-4 py-3 text-[#A6A6B2]">
                      {displayLabel(inventoryRoleLabels, count.responsible_role)}
                    </td>
                    <td className="px-4 py-3 text-[#A6A6B2]">{formatDate(count.created_at)}</td>
                    <td className="px-4 py-3 text-[#A6A6B2]">{formatDate(count.due_at)}</td>
                    <td className="px-4 py-3 text-[#A6A6B2]">{formatDate(count.submitted_at)}</td>
                    <td className="px-4 py-3 text-[#A6A6B2]">{formatDate(count.reviewed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-14 text-center">
            <div className="text-lg font-semibold">Todavía no hay conteos registrados</div>
            <p className="mx-auto mt-2 max-w-xl text-sm text-[#8F8F9C]">
              Cuando Administración presente la apertura, el reporte aparecerá aquí para que Máster
              pueda aceptarlo o solicitar reconteos específicos.
            </p>
            <Link
              href="/app/inventory"
              prefetch={false}
              className="mt-5 inline-flex rounded-xl border border-[#FEEF00]/50 px-3 py-2 text-sm font-semibold text-[#FEEF00]"
            >
              Volver al catálogo
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'default' | 'warning';
}) {
  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${tone === 'warning' ? 'text-amber-300' : 'text-white'}`}>
        {value}
      </div>
    </div>
  );
}
