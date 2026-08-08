import InventoryProductsClient, {
  type InventoryProductRow,
} from './InventoryProductsClient';
import { getAuthContext } from '@/lib/auth';
import { inventoryDisplayText } from '../display';

type RawProduct = {
  id: number;
  sku: string | null;
  name: string;
  type: string;
  is_active: boolean;
  inventory_policy: InventoryProductRow['inventoryPolicy'];
  inventory_configuration_status: InventoryProductRow['configurationStatus'];
  allows_half_service: boolean;
};

type RawProductLink = {
  product_id: number;
  inventory_item_id: number;
  quantity_units: number | string;
  deduction_stage: InventoryProductRow['links'][number]['deductionStage'];
};

type RawInventoryItem = {
  id: number;
  name: string;
  unit_name: string | null;
};

type RawComponent = {
  parent_product_id: number;
};

export default async function InventoryProductsPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    return null;
  }

  const [productsResult, linksResult, itemsResult, componentsResult] = await Promise.all([
    ctx.supabase
      .from('products')
      .select(`
        id,
        sku,
        name,
        type,
        is_active,
        inventory_policy,
        inventory_configuration_status,
        allows_half_service
      `)
      .order('name', { ascending: true }),
    ctx.supabase
      .from('product_inventory_links')
      .select('product_id, inventory_item_id, quantity_units, deduction_stage')
      .eq('configuration_version', 1)
      .order('sort_order', { ascending: true }),
    ctx.supabase.from('inventory_items').select('id, name, unit_name'),
    ctx.supabase.from('product_components').select('parent_product_id'),
  ]);

  const firstError =
    productsResult.error ?? linksResult.error ?? itemsResult.error ?? componentsResult.error;

  if (firstError) {
    throw new Error(`No se pudo cargar la configuración de productos: ${firstError.message}`);
  }

  const rawProducts = (productsResult.data ?? []) as RawProduct[];
  const rawLinks = (linksResult.data ?? []) as RawProductLink[];
  const rawItems = (itemsResult.data ?? []) as RawInventoryItem[];
  const rawComponents = (componentsResult.data ?? []) as RawComponent[];
  const itemById = new Map(
    rawItems.map((item) => [
      Number(item.id),
      {
        ...item,
        name: inventoryDisplayText(item.name),
        unit_name: inventoryDisplayText(item.unit_name, 'unidad'),
      },
    ]),
  );
  const componentCountByProduct = new Map<number, number>();
  const linksByProduct = new Map<number, InventoryProductRow['links']>();

  for (const component of rawComponents) {
    const productId = Number(component.parent_product_id);
    componentCountByProduct.set(productId, (componentCountByProduct.get(productId) ?? 0) + 1);
  }

  for (const link of rawLinks) {
    const productId = Number(link.product_id);
    const item = itemById.get(Number(link.inventory_item_id));
    const productLinks = linksByProduct.get(productId) ?? [];

    productLinks.push({
      inventoryItemId: Number(link.inventory_item_id),
      inventoryItemName: item?.name ?? `Ítem #${link.inventory_item_id}`,
      unitName: item?.unit_name ?? 'unidad',
      quantityUnits: Number(link.quantity_units),
      deductionStage: link.deduction_stage,
    });
    linksByProduct.set(productId, productLinks);
  }

  const products: InventoryProductRow[] = rawProducts.map((product) => ({
    id: Number(product.id),
    sku: product.sku ? inventoryDisplayText(product.sku) : null,
    name: inventoryDisplayText(product.name),
    productType: product.type,
    isActive: product.is_active,
    inventoryPolicy: product.inventory_policy,
    configurationStatus: product.inventory_configuration_status,
    allowsHalfService: product.allows_half_service,
    componentCount: componentCountByProduct.get(Number(product.id)) ?? 0,
    links: linksByProduct.get(Number(product.id)) ?? [],
  }));

  const policyCounts = {
    self: products.filter((product) => product.inventoryPolicy === 'self').length,
    direct: products.filter((product) => product.inventoryPolicy === 'direct').length,
    components: products.filter((product) => product.inventoryPolicy === 'components').length,
    none: products.filter((product) => product.inventoryPolicy === 'none').length,
  };
  const pendingCount = products.filter(
    (product) => product.configurationStatus !== 'ready',
  ).length;
  const halfServiceCount = products.filter((product) => product.allowsHalfService).length;

  return (
    <>
      <section>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Configuración canónica de productos</h2>
            <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
              Define qué consume cada producto. Los enlaces de esta versión están preparados pero
              todavía no ejecutan descuentos automáticos.
            </p>
          </div>
          <div className="rounded-full border border-[#2B2B38] px-3 py-1 text-xs text-[#9D9DA9]">
            Solo lectura · Versión 1 inactiva
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
          <SummaryCard label="Productos" value={products.length} />
          <SummaryCard label="Inventario propio" value={policyCounts.self} tone="good" />
          <SummaryCard label="Descuento directo" value={policyCounts.direct} tone="info" />
          <SummaryCard label="Por componentes" value={policyCounts.components} tone="info" />
          <SummaryCard label="No inventariables" value={policyCounts.none} />
          <SummaryCard
            label="Pendientes"
            value={pendingCount}
            detail={`${halfServiceCount} admiten medio servicio`}
            tone={pendingCount ? 'warn' : 'good'}
          />
        </div>
      </section>

      <InventoryProductsClient products={products} />
    </>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: 'default' | 'good' | 'info' | 'warn';
}) {
  const valueClass = {
    default: 'text-white',
    good: 'text-[#86EFAC]',
    info: 'text-[#7DD3FC]',
    warn: 'text-[#FBBF24]',
  }[tone];

  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
      {detail ? <div className="mt-1 text-xs text-[#7F7F8C]">{detail}</div> : null}
    </div>
  );
}
