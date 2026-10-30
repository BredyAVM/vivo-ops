import WorkspaceForm from '@/components/navigation/WorkspaceForm';
import Link from '@/components/navigation/ContextLink';
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
    const first=(key:string)=>Array.isArray(values[key])?values[key][0]:values[key];
    const requested=first('consultar')==='1'||Boolean(first('from')&&first('to'))||Boolean(first('period'));
    if(!requested)return <div className="max-w-3xl space-y-3"><header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">Delivery · liquidación semanal</h1><Link href="/app/admin/configuracion/delivery" prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00]">Empresas / tarifas</Link></header><WorkspaceForm action="/app/admin/finanzas/delivery" method="get" className="grid gap-2 rounded-xl border border-[#292937] p-3 sm:grid-cols-3"><input type="hidden" name="consultar" value="1"/><label className="grid gap-1 text-xs">Desde<input type="date" name="from" required defaultValue={filters.from} className="min-h-11 min-w-0 rounded-lg border border-[#30303D] bg-[#14141C] px-2"/></label><label className="grid gap-1 text-xs">Hasta<input type="date" name="to" required defaultValue={filters.to} className="min-h-11 min-w-0 rounded-lg border border-[#30303D] bg-[#14141C] px-2"/></label><button className="min-h-11 self-end rounded-lg bg-[#FFFF00] px-3 text-xs font-semibold text-black">Consultar período</button></WorkspaceForm><p className="text-xs text-[#9B9BA7]">Entregas, servicios adicionales y deudas se consultan al seleccionar el período.</p></div>;
    loaded = await loadDeliveryServices(filters.from, filters.to);
    rows = parseDeliveryServices(loaded.report, filters.from, filters.to);
  } catch (error) {
    return <AdminReadError title="Delivery no disponible" message={error instanceof Error ? error.message : 'No se pudo consultar el período. No se registró ningún pago.'} />;
  }
  const { accounts, payments } = loaded;
  return <div className="max-w-5xl space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-base font-semibold">Delivery · liquidación semanal</h1>
        <div className="flex flex-wrap gap-3"><Link href="/app/admin/configuracion/delivery" prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00]">Empresas / tarifas</Link><Link id="liquidaciones" href="/app/admin/finanzas/delivery/custodia" prefetch={false} className="inline-flex min-h-9 items-center text-xs underline">Cobros y cambios en custodia →</Link></div></header>
      <DeliveryServicesClient key={`${filters.from}-${filters.to}-${filters.mode}-${typeof values.responsible === 'string' ? values.responsible : ''}-${filters.q}`} rows={rows} accounts={accounts} payments={payments} from={filters.from} to={filters.to}
        extras={loaded.extras.rows} payees={loaded.extras.payees} debts={loaded.debts} today={getCaracasDateKey(new Date())} initialMode={filters.mode} initialQuery={filters.q}
        initialResponsible={typeof values.responsible === 'string' ? values.responsible : ''} />
    </div>;
}
