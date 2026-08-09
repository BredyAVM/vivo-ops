import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';
import InventoryConfiguratorClient, {
  type ConfiguratorInventoryItem,
  type ConfiguratorProduct,
} from './InventoryConfiguratorClient';
import InventoryActivationQueueClient, {
  type InventoryActivationQueue,
} from './InventoryActivationQueueClient';
import InventoryAdministrationClient, {
  type InventoryAdminWorkspace,
} from './InventoryAdministrationClient';
import { inventoryDisplayText, repairInventoryDisplayData } from '../display';

type RawInventoryItem = {
  id: number;
  name: string;
  unit_name: string;
  tracking_mode: ConfiguratorInventoryItem['trackingMode'];
  is_active: boolean;
};

type RawProduct = {
  id: number;
  sku: string | null;
  name: string;
  type: ConfiguratorProduct['type'];
  is_active: boolean;
  source_price_amount: number | string;
  source_price_currency: ConfiguratorProduct['sourcePriceCurrency'];
  units_per_service: number;
  allows_half_service: boolean;
  is_temporary: boolean;
  detail_units_limit: number;
  inventory_policy: ConfiguratorProduct['inventoryPolicy'];
};

export default async function InventoryConfigurePage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }
  if (!ctx.roles.includes('admin')) {
    redirect('/app/inventory');
  }

  const [itemsResult, productsResult, activationQueueResult, administrationResult] = await Promise.all([
    ctx.supabase
      .from('inventory_items')
      .select('id, name, unit_name, tracking_mode, is_active')
      .is('merged_into_item_id', null)
      .order('name', { ascending: true }),
    ctx.supabase
      .from('products')
      .select(`
        id,
        sku,
        name,
        type,
        is_active,
        source_price_amount,
        source_price_currency,
        units_per_service,
        allows_half_service,
        is_temporary,
        detail_units_limit,
        inventory_policy
      `)
      .order('name', { ascending: true }),
    ctx.supabase.rpc('inventory_activation_queue_v1'),
    ctx.supabase.rpc('inventory_admin_configuration_workspace_v1'),
  ]);

  const firstError = itemsResult.error
    ?? productsResult.error
    ?? activationQueueResult.error
    ?? administrationResult.error;
  if (firstError) {
    throw new Error(`No se pudo cargar el configurador: ${firstError.message}`);
  }

  const items: ConfiguratorInventoryItem[] = ((itemsResult.data ?? []) as RawInventoryItem[]).map(
    (item) => ({
      id: Number(item.id),
      name: inventoryDisplayText(item.name),
      unitName: inventoryDisplayText(item.unit_name, 'unidad'),
      trackingMode: item.tracking_mode,
      isActive: item.is_active,
    }),
  );

  const products: ConfiguratorProduct[] = ((productsResult.data ?? []) as RawProduct[]).map(
    (product) => ({
      id: Number(product.id),
      sku: product.sku ? inventoryDisplayText(product.sku) : null,
      name: inventoryDisplayText(product.name),
      type: product.type,
      isActive: product.is_active,
      sourcePriceAmount: Number(product.source_price_amount),
      sourcePriceCurrency: product.source_price_currency,
      unitsPerService: Number(product.units_per_service),
      allowsHalfService: product.allows_half_service,
      isTemporary: product.is_temporary,
      detailUnitsLimit: Number(product.detail_units_limit),
      inventoryPolicy: product.inventory_policy,
    }),
  );

  return (
    <div className="space-y-8">
      <InventoryAdministrationClient
        workspace={repairInventoryDisplayData(
          administrationResult.data as InventoryAdminWorkspace,
        )}
      />
      <InventoryActivationQueueClient
        queue={repairInventoryDisplayData(
          activationQueueResult.data as InventoryActivationQueue,
        )}
      />
      <InventoryConfiguratorClient
        inventoryItems={items}
        products={products}
      />
    </div>
  );
}
