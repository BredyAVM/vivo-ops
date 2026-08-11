import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { ReactNode } from 'react';
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
  commission_mode: ConfiguratorProduct['commissionMode'];
  commission_value: number | string | null;
  commission_notes: string | null;
  extra_fields: Record<string, unknown> | null;
  internal_rider_pay_usd: number | string | null;
  units_per_service: number;
  allows_half_service: boolean;
  is_temporary: boolean;
  detail_units_limit: number;
  inventory_policy: ConfiguratorProduct['inventoryPolicy'];
  inventory_configuration_status: string;
};

type RawProductComponent = {
  parent_product_id: number;
  component_product_id: number;
  component_mode: 'fixed' | 'selectable';
  quantity: number | string;
  counts_toward_detail_limit: boolean;
  is_required: boolean;
};

type RawProductLink = {
  product_id: number;
  inventory_item_id: number;
  quantity_units: number | string;
  deduction_mode: string;
  deduction_stage: string | null;
};

type ConfigureView = 'edit' | 'activate' | 'create';
type ConfigureSearchParams = Promise<{ view?: string }>;

export default async function InventoryConfigurePage({
  searchParams,
}: {
  searchParams?: ConfigureSearchParams;
}) {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }
  if (!ctx.roles.includes('admin')) {
    redirect('/app/inventory');
  }

  const requestedView = (await searchParams)?.view;
  const view: ConfigureView = requestedView === 'activate' || requestedView === 'create'
    ? requestedView
    : 'edit';

  const [itemsResult, productsResult, linksResult, componentsResult, activationQueueResult, administrationResult] = await Promise.all([
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
        commission_mode,
        commission_value,
        commission_notes,
        extra_fields,
        internal_rider_pay_usd,
        units_per_service,
        allows_half_service,
        is_temporary,
        detail_units_limit,
        inventory_policy,
        inventory_configuration_status
      `)
      .order('name', { ascending: true }),
    ctx.supabase
      .from('product_inventory_links')
      .select('product_id, inventory_item_id, quantity_units, deduction_mode, deduction_stage')
      .eq('configuration_version', 1)
      .order('sort_order', { ascending: true }),
    ctx.supabase
      .from('product_components')
      .select('parent_product_id, component_product_id, component_mode, quantity, counts_toward_detail_limit, is_required')
      .order('sort_order', { ascending: true }),
    ctx.supabase.rpc('inventory_activation_queue_v1'),
    ctx.supabase.rpc('inventory_admin_configuration_workspace_v1'),
  ]);

  const firstError = itemsResult.error
    ?? productsResult.error
    ?? linksResult.error
    ?? componentsResult.error
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
    (product) => {
      const rawGiftCost = product.extra_fields?.advisor_gift_cost_usd;
      const giftCost = rawGiftCost == null ? null : Number(rawGiftCost);
      return {
        id: Number(product.id),
        sku: product.sku ? inventoryDisplayText(product.sku) : null,
        name: inventoryDisplayText(product.name),
        type: product.type,
        isActive: product.is_active,
        sourcePriceAmount: Number(product.source_price_amount),
        sourcePriceCurrency: product.source_price_currency,
        commissionMode: product.commission_mode,
        commissionValue: product.commission_value == null ? null : Number(product.commission_value),
        commissionNotes: product.commission_notes,
        advisorGiftCostUsd: giftCost != null && Number.isFinite(giftCost) ? giftCost : null,
        internalRiderPayUsd:
          product.internal_rider_pay_usd == null ? null : Number(product.internal_rider_pay_usd),
        unitsPerService: Number(product.units_per_service),
        allowsHalfService: product.allows_half_service,
        isTemporary: product.is_temporary,
        detailUnitsLimit: Number(product.detail_units_limit),
        inventoryPolicy: product.inventory_policy,
      };
    },
  );

  const commercialByProductId = new Map(products.map((product) => [product.id, product]));
  const rawProductById = new Map(
    ((productsResult.data ?? []) as RawProduct[]).map((product) => [Number(product.id), product]),
  );
  const productNameById = new Map(products.map((product) => [product.id, product.name]));
  const itemNameById = new Map(items.map((item) => [item.id, item.name]));
  const linksByProductId = new Map<number, InventoryAdminWorkspace['products'][number]['links']>();
  for (const link of (linksResult.data ?? []) as RawProductLink[]) {
    const productId = Number(link.product_id);
    const current = linksByProductId.get(productId) ?? [];
    current.push({
      inventory_item_id: Number(link.inventory_item_id),
      item_name: itemNameById.get(Number(link.inventory_item_id)) ?? `Ítem #${link.inventory_item_id}`,
      quantity_units: Number(link.quantity_units),
      deduction_mode: link.deduction_mode,
      deduction_stage: link.deduction_stage,
    });
    linksByProductId.set(productId, current);
  }
  const componentsByParentId = new Map<number, AdminProductComponent[]>();
  for (const component of (componentsResult.data ?? []) as RawProductComponent[]) {
    const parentId = Number(component.parent_product_id);
    const current = componentsByParentId.get(parentId) ?? [];
    current.push({
      component_product_id: Number(component.component_product_id),
      component_name: productNameById.get(Number(component.component_product_id)) ?? `Producto #${component.component_product_id}`,
      component_mode: component.component_mode,
      quantity: Number(component.quantity),
      counts_toward_detail_limit: component.counts_toward_detail_limit,
      is_required: component.is_required,
    });
    componentsByParentId.set(parentId, current);
  }
  const rawAdministrationWorkspace = repairInventoryDisplayData(
    administrationResult.data as InventoryAdminWorkspace,
  );
  const mappedWorkspaceProducts: InventoryAdminWorkspace['products'] = rawAdministrationWorkspace.products.map((product) => {
    const commercial = commercialByProductId.get(product.id);
    const rawProduct = rawProductById.get(product.id);
    const revision = Number(rawProduct?.extra_fields?.inventory_physical_revision ?? 1);
    const history = rawProduct?.extra_fields?.inventory_physical_history;
    return {
      ...product,
      source_price_amount: commercial?.sourcePriceAmount ?? 0,
      source_price_currency: commercial?.sourcePriceCurrency ?? 'USD',
      commission_mode: commercial?.commissionMode ?? 'default',
      commission_value: commercial?.commissionValue ?? null,
      commission_notes: commercial?.commissionNotes ?? null,
      advisor_gift_cost_usd: commercial?.advisorGiftCostUsd ?? null,
      internal_rider_pay_usd: commercial?.internalRiderPayUsd ?? null,
      links: linksByProductId.get(product.id) ?? [],
      components: componentsByParentId.get(product.id) ?? [],
      physical_revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1,
      physical_history_count: Array.isArray(history) ? history.length : 0,
    };
  });
  const mappedProductIds = new Set(mappedWorkspaceProducts.map((product) => product.id));
  const inactiveReadyProducts: InventoryAdminWorkspace['products'] = products
    .filter((product) => {
      const rawProduct = rawProductById.get(product.id);
      return !mappedProductIds.has(product.id)
        && rawProduct?.inventory_configuration_status === 'ready';
    })
    .map((product) => {
      const rawProduct = rawProductById.get(product.id)!;
      const revision = Number(rawProduct.extra_fields?.inventory_physical_revision ?? 1);
      const history = rawProduct.extra_fields?.inventory_physical_history;
      return {
        id: product.id,
        sku: product.sku,
        name: product.name,
        type: product.type,
        is_active: product.isActive,
        units_per_service: product.unitsPerService,
        allows_half_service: product.allowsHalfService,
        is_temporary: product.isTemporary,
        detail_units_limit: product.detailUnitsLimit,
        source_price_amount: product.sourcePriceAmount,
        source_price_currency: product.sourcePriceCurrency,
        commission_mode: product.commissionMode,
        commission_value: product.commissionValue,
        commission_notes: product.commissionNotes,
        advisor_gift_cost_usd: product.advisorGiftCostUsd,
        internal_rider_pay_usd: product.internalRiderPayUsd,
        inventory_policy: product.inventoryPolicy,
        inventory_configuration_status: rawProduct.inventory_configuration_status,
        order_reference_count: 0,
        open_order_reference_count: 0,
        parent_product_count: 0,
        links: linksByProductId.get(product.id) ?? [],
        components: componentsByParentId.get(product.id) ?? [],
        physical_revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1,
        physical_history_count: Array.isArray(history) ? history.length : 0,
      };
    });
  const administrationWorkspace: InventoryAdminWorkspace = {
    ...rawAdministrationWorkspace,
    products: [...mappedWorkspaceProducts, ...inactiveReadyProducts]
      .sort((left, right) => left.name.localeCompare(right.name, 'es')),
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[#2C2C3A] bg-[#101016] p-5">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#FEEF00]">Productos e inventario</div>
        <h2 className="mt-1 text-xl font-semibold">¿Qué necesitas hacer?</h2>
        <p className="mt-2 text-sm text-[#9898A5]">Cada opción abre una sola tarea. Nada de esta pantalla modifica el saldo físico por sí solo.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <ConfigureLink active={view === 'edit'} href="/app/inventory/configure?view=edit" title="Ver o modificar un perfil">
            Frecuencia, responsable, mínimos, precio, comisión, receta o descuento físico.
          </ConfigureLink>
          <ConfigureLink active={view === 'activate'} href="/app/inventory/configure?view=activate" title="Revisar y activar">
            Borradores listos, bloqueos y activación controlada.
          </ConfigureLink>
          <ConfigureLink active={view === 'create'} href="/app/inventory/configure?view=create" title="Crear producto o ítem">
            Alta universal para productos actuales y futuros consumibles.
          </ConfigureLink>
        </div>
      </section>

      {view === 'edit' ? <InventoryAdministrationClient workspace={administrationWorkspace} /> : null}
      {view === 'activate' ? (
        <InventoryActivationQueueClient
          queue={repairInventoryDisplayData(activationQueueResult.data as InventoryActivationQueue)}
        />
      ) : null}
      {view === 'create' ? <InventoryConfiguratorClient inventoryItems={items} products={products} /> : null}
    </div>
  );
}

type AdminProductComponent = InventoryAdminWorkspace['products'][number]['components'][number];

function ConfigureLink({
  active,
  href,
  title,
  children,
}: {
  active: boolean;
  href: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={`rounded-xl border p-4 transition ${active ? 'border-[#FEEF00]/60 bg-[#FEEF00]/5' : 'border-[#30303E] bg-[#14141C] hover:border-[#FEEF00]/30'}`}
    >
      <div className={active ? 'font-semibold text-[#FEEF00]' : 'font-semibold text-white'}>{title}</div>
      <p className="mt-2 text-xs leading-5 text-[#9898A5]">{children}</p>
    </Link>
  );
}
