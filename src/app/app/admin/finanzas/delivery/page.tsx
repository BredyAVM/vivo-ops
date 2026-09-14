import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { deliveryServiceFilters } from '@/lib/admin-finance/delivery-period';
import { getCaracasDateKey } from '@/lib/admin-finance/period';
import { parseDeliveryServices } from '@/lib/admin-finance/delivery-services';
import { loadDeliveryServices } from '@/lib/admin-finance/delivery-service-data';
import { AdminReadError } from '../../_components/AdminReadUi';
import DeliveryServicesClient from './DeliveryServicesClient';

export default async function AdminDeliveryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminContext();
  const values = await searchParams;
  let filters, loaded, rows;
  try {
    filters = deliveryServiceFilters(values);
    loaded = await loadDeliveryServices(filters.from, filters.to);
    rows = parseDeliveryServices(loaded.report, filters.from, filters.to);
  } catch (error) {
    return <AdminReadError title="Delivery no disponible" message={error instanceof Error ? error.message : 'No se pudo consultar el período. No se registró ningún pago.'} />;
  }
  const { accounts, payments } = loaded;
  return <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">Delivery · servicios y pagos</h1>
        <Link id="liquidaciones" href="/app/admin/finanzas/delivery/custodia" prefetch={false} className="inline-flex min-h-11 items-center text-xs underline">Cobros y cambios en custodia →</Link></header>
      <DeliveryServicesClient key={`${filters.from}-${filters.to}`} rows={rows} accounts={accounts} payments={payments} from={filters.from} to={filters.to}
        today={getCaracasDateKey(new Date())} initialMode={filters.mode} initialQuery={filters.q}
        initialResponsible={typeof values.responsible === 'string' ? values.responsible : ''} />
    </div>;
}
