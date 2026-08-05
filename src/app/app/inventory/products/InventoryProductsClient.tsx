'use client';

import { useMemo, useState } from 'react';

export type InventoryProductLink = {
  inventoryItemId: number;
  inventoryItemName: string;
  unitName: string;
  quantityUnits: number;
  deductionStage: 'kitchen' | 'production' | 'packing' | 'fulfillment' | null;
};

export type InventoryProductRow = {
  id: number;
  sku: string | null;
  name: string;
  productType: string;
  isActive: boolean;
  inventoryPolicy: 'self' | 'direct' | 'components' | 'none';
  configurationStatus:
    | 'ready'
    | 'needs_recipe'
    | 'needs_reconfiguration'
    | 'needs_catalog_correction'
    | 'draft'
    | 'needs_review';
  allowsHalfService: boolean;
  componentCount: number;
  links: InventoryProductLink[];
};

type PolicyFilter = InventoryProductRow['inventoryPolicy'] | 'all';
type StatusFilter = 'all' | 'ready' | 'pending';

const policyLabels: Record<InventoryProductRow['inventoryPolicy'], string> = {
  self: 'Inventario propio',
  direct: 'Descuento directo',
  components: 'Por componentes',
  none: 'No inventariable',
};

const policyDescriptions: Record<InventoryProductRow['inventoryPolicy'], string> = {
  self: 'Se controla contra su ítem físico equivalente.',
  direct: 'Consume directamente uno o más ítems físicos.',
  components: 'Se resuelve desde la composición guardada del pedido.',
  none: 'No genera consumo físico de inventario.',
};

const statusLabels: Record<InventoryProductRow['configurationStatus'], string> = {
  ready: 'Listo',
  needs_recipe: 'Falta receta',
  needs_reconfiguration: 'Requiere reconfiguración',
  needs_catalog_correction: 'Corregir catálogo',
  draft: 'Borrador',
  needs_review: 'Requiere revisión',
};

const stageLabels: Record<NonNullable<InventoryProductLink['deductionStage']>, string> = {
  kitchen: 'Cocina',
  production: 'Producción',
  packing: 'Empaque',
  fulfillment: 'Entrega',
};

function formatQuantity(value: number) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(value);
}

function sourceText(product: InventoryProductRow) {
  if (product.inventoryPolicy === 'none') {
    return 'Sin consumo de inventario';
  }

  if (product.inventoryPolicy === 'components') {
    return `${product.componentCount} componente${product.componentCount === 1 ? '' : 's'} declarado${product.componentCount === 1 ? '' : 's'}`;
  }

  if (!product.links.length) {
    return 'Sin enlace canónico';
  }

  return product.links
    .map(
      (link) =>
        `${formatQuantity(link.quantityUnits)} ${link.unitName} · ${link.inventoryItemName}${
          link.deductionStage ? ` · ${stageLabels[link.deductionStage]}` : ''
        }`,
    )
    .join(' / ');
}

export default function InventoryProductsClient({ products }: { products: InventoryProductRow[] }) {
  const [search, setSearch] = useState('');
  const [policyFilter, setPolicyFilter] = useState<PolicyFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const filteredProducts = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('es');

    return products.filter((product) => {
      const matchesSearch =
        !normalizedSearch ||
        product.name.toLocaleLowerCase('es').includes(normalizedSearch) ||
        product.sku?.toLocaleLowerCase('es').includes(normalizedSearch) ||
        product.links.some((link) =>
          link.inventoryItemName.toLocaleLowerCase('es').includes(normalizedSearch),
        );
      const matchesPolicy = policyFilter === 'all' || product.inventoryPolicy === policyFilter;
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'ready'
          ? product.configurationStatus === 'ready'
          : product.configurationStatus !== 'ready');

      return Boolean(matchesSearch) && matchesPolicy && matchesStatus;
    });
  }, [policyFilter, products, search, statusFilter]);

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-[#242433] bg-[#111117]">
      <div className="flex flex-col gap-3 border-b border-[#242433] p-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Política por producto</h2>
          <p className="mt-1 text-sm text-[#9696A3]">
            {filteredProducts.length} de {products.length} productos visibles
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar productos"
            placeholder="Buscar producto, SKU o ítem"
            className="min-w-[250px] rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-sm outline-none placeholder:text-[#696975] focus:border-[#FEEF00]/60"
          />
          <select
            value={policyFilter}
            onChange={(event) => setPolicyFilter(event.target.value as PolicyFilter)}
            aria-label="Filtrar por política de inventario"
            className="rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-sm outline-none focus:border-[#FEEF00]/60"
          >
            <option value="all">Todas las políticas</option>
            <option value="self">Inventario propio</option>
            <option value="direct">Descuento directo</option>
            <option value="components">Por componentes</option>
            <option value="none">No inventariable</option>
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            aria-label="Filtrar por estado de configuración"
            className="rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-sm outline-none focus:border-[#FEEF00]/60"
          >
            <option value="all">Todos los estados</option>
            <option value="ready">Listos</option>
            <option value="pending">Pendientes</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] text-left text-sm">
          <thead className="bg-[#16161F] text-xs uppercase tracking-wide text-[#8F8F9C]">
            <tr>
              <th className="px-4 py-3">Producto</th>
              <th className="px-4 py-3">Política</th>
              <th className="px-4 py-3">Fuente física</th>
              <th className="px-4 py-3">Configuración</th>
              <th className="px-4 py-3">Medio servicio</th>
              <th className="px-4 py-3">Estado catálogo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#242433]">
            {filteredProducts.map((product) => (
              <tr key={product.id} className="align-top hover:bg-[#15151D]">
                <td className="px-4 py-3">
                  <div className="font-semibold text-[#F2F2F5]">{product.name}</div>
                  <div className="mt-1 text-xs text-[#7F7F8C]">
                    #{product.id} · {product.sku ?? 'sin SKU'} · {product.productType}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-semibold text-[#FEEF00]">
                    {policyLabels[product.inventoryPolicy]}
                  </div>
                  <div className="mt-1 max-w-[250px] text-xs text-[#8F8F9C]">
                    {policyDescriptions[product.inventoryPolicy]}
                  </div>
                </td>
                <td className="max-w-[420px] px-4 py-3 text-[#C9C9D2]">
                  {sourceText(product)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      product.configurationStatus === 'ready'
                        ? 'text-[#86EFAC]'
                        : 'text-[#FBBF24]'
                    }
                  >
                    {statusLabels[product.configurationStatus]}
                  </span>
                </td>
                <td className="px-4 py-3 text-[#C9C9D2]">
                  {product.allowsHalfService ? 'Permitido' : 'No permitido'}
                </td>
                <td className="px-4 py-3 text-[#C9C9D2]">
                  {product.isActive ? 'Activo' : 'Histórico'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filteredProducts.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-[#8F8F9C]">
          No hay productos que coincidan con los filtros.
        </div>
      ) : null}
    </section>
  );
}
