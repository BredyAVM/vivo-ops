import { getAuthContext } from '@/lib/auth';
import { repairInventoryDisplayData } from '@/app/app/inventory/display';
import InventoryReceiptWorkspaceClient, {
  type InventoryReceiptWorkspace,
} from '@/app/app/inventory/operations/InventoryReceiptWorkspaceClient';

const EMPTY_WORKSPACE: InventoryReceiptWorkspace = {
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
};

export default async function KitchenInventoryReceiptsPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data, error } = await ctx.supabase.rpc('inventory_receipt_workspace_v1');
  if (error) throw new Error(`No se pudieron cargar las entradas de inventario: ${error.message}`);

  const workspace = repairInventoryDisplayData(
    (data ?? EMPTY_WORKSPACE) as InventoryReceiptWorkspace,
  );

  // La expectativa pertenece a Máster. Este adaptador solo captura lo que Cocina recibió físicamente.
  workspace.permissions.can_plan = false;

  return (
    <section>
      <div className="mb-5">
        <h2 className="text-xl font-bold">Entradas reales de mercancía</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A6A6B2]">
          Registra bolsas, cajas, paquetes y unidades sueltas tal como llegaron. La cantidad real es la que aumenta el inventario, aunque sea distinta de lo esperado.
        </p>
      </div>
      <InventoryReceiptWorkspaceClient workspace={workspace} />
    </section>
  );
}
