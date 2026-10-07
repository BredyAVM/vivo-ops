export type OrderItemDisplayGroup =
  | 'services'
  | 'combos'
  | 'gifts'
  | 'products'
  | 'sauces'
  | 'beverages'
  | 'delivery';

export type OrderItemPriorityInput = {
  productType?: string | null;
  productName?: string | null;
  inventoryGroup?: string | null;
  isDelivery?: boolean;
  internalRiderPayUsd?: number | null;
};

const GROUPS: Array<{ key: OrderItemDisplayGroup; label: string }> = [
  { key: 'services', label: 'Servicios' },
  { key: 'combos', label: 'Combos' },
  { key: 'gifts', label: 'Obsequios' },
  { key: 'products', label: 'Productos' },
  { key: 'sauces', label: 'Salsas' },
  { key: 'beverages', label: 'Bebidas' },
  { key: 'delivery', label: 'Delivery' },
];

const GROUP_PRIORITY = new Map(GROUPS.map(({ key }, index) => [key, index]));

function isDeliveryItem({ productName, internalRiderPayUsd, isDelivery }: OrderItemPriorityInput) {
  return (
    isDelivery === true ||
    Number(internalRiderPayUsd || 0) > 0 ||
    String(productName || '').trim().toLocaleLowerCase('es-VE').includes('delivery')
  );
}

export function getOrderItemDisplayGroup(input: OrderItemPriorityInput): OrderItemDisplayGroup {
  // Delivery siempre se muestra al final, incluso si su producto está registrado como "product".
  if (isDeliveryItem(input)) return 'delivery';

  // Compositions keep their own accessories nested under the parent item.
  if (!['service', 'combo', 'gambit'].includes(input.productType || '')) {
    if (input.inventoryGroup === 'sauces') return 'sauces';
    if (input.inventoryGroup === 'beverages') return 'beverages';
    if (!input.inventoryGroup || input.inventoryGroup === 'other') {
      const name = String(input.productName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (/\b(salsa|salsas|aderezo|aderezos|mostaza|ketchup|tartara)\b/.test(name)) return 'sauces';
      if (/\b(refresco|refrescos|bebida|bebidas|agua|jugo|jugos|malta|coca|pepsi|chinotto|papelon|tequechicha|yukery|yukipack|lipton|frescolita|fanta)\b/.test(name)) return 'beverages';
    }
  }

  switch (input.productType) {
    case 'service':
      return 'services';
    case 'combo':
      return 'combos';
    case 'gambit':
      return 'gifts';
    default:
      // Other standalone products retain their original order within this group.
      return 'products';
  }
}

export function sortOrderItemsByPriority<T>(
  items: readonly T[],
  getInput: (item: T) => OrderItemPriorityInput
) {
  return items
    .map((item, index) => ({
      item,
      index,
      priority: GROUP_PRIORITY.get(getOrderItemDisplayGroup(getInput(item))) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ item }) => item);
}

export function groupOrderItemsByPriority<T>(
  items: readonly T[],
  getInput: (item: T) => OrderItemPriorityInput
) {
  const sortedItems = sortOrderItemsByPriority(items, getInput);

  return GROUPS.flatMap(({ key, label }) => {
    const groupItems = sortedItems.filter(
      (item) => getOrderItemDisplayGroup(getInput(item)) === key
    );

    return groupItems.length > 0 ? [{ key, label, items: groupItems }] : [];
  });
}
