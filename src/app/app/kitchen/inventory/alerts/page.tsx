import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import { repairInventoryDisplayData } from '../../../inventory/display';
import InventoryAlertsClient, {
  type InventoryAlertWorkspace,
} from '../../../inventory/alerts/InventoryAlertsClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function KitchenInventoryAlertsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.roles.includes('admin') && !ctx.roles.includes('kitchen')) {
    redirect(resolveHomePath(ctx.roles));
  }

  const { data, error } = await ctx.supabase.rpc('inventory_alert_workspace_v1', {
    p_surface: 'kitchen_inventory',
    p_include_resolved: false,
  });

  if (error) {
    throw new Error(`No se pudieron cargar las alertas de Cocina: ${error.message}`);
  }

  const workspace = repairInventoryDisplayData(data) as InventoryAlertWorkspace;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sky-400/25 bg-sky-400/5 p-4 text-sm leading-6 text-sky-100">
        Aquí aparecen únicamente señales de producción, conteos y control que la política dirige a Cocina.
        No se mezclan con los pedidos y nunca bloquean su operación.
      </div>
      <InventoryAlertsClient workspace={workspace} canManage={false} />
    </div>
  );
}
