import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';
import { repairInventoryDisplayData } from '../../inventory/display';
import InventoryAlertsClient, {
  type InventoryAlertWorkspace,
} from '../../inventory/alerts/InventoryAlertsClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AdvisorInventoryAvailabilityPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!isMasterOrAdminRole(ctx.roles) && !ctx.roles.includes('advisor')) {
    redirect(resolveHomePath(ctx.roles));
  }

  const { data, error } = await ctx.supabase.rpc('inventory_alert_workspace_v1', {
    p_surface: 'advisor_availability',
    p_include_resolved: false,
  });

  if (error) {
    throw new Error(`No se pudo cargar la disponibilidad comercial: ${error.message}`);
  }

  const workspace = repairInventoryDisplayData(data) as InventoryAlertWorkspace;

  return (
    <div className="space-y-4">
      <section className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#F0D000]">
              Inventario · lectura comercial
            </div>
            <h1 className="mt-1 text-xl font-semibold text-[#F5F7FB]">Disponibilidad de productos</h1>
            <p className="mt-1 text-sm leading-6 text-[#AAB2C5]">
              Estas señales orientan al asesor. Puedes enviar la solicitud aunque exista una advertencia;
              Máster conserva la decisión final.
            </p>
          </div>
          <Link href="/app/advisor" className="shrink-0 text-sm font-semibold text-[#F0D000]">
            Volver
          </Link>
        </div>
      </section>

      <InventoryAlertsClient workspace={workspace} canManage={false} />
    </div>
  );
}
