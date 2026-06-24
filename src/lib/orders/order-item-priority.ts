export type OrderItemDisplayGroup =
  | 'services'
  | 'combos'
  | 'gifts'
  | 'products'
  | 'delivery';

type OrderItemPriorityInput = {
  productType?: string | null;
  productName?: string | null;
  internalRiderPayUsd?: number | null;
};

const GROUPS: Array<{ key: OrderItemDisplayGroup; label: string }> = [
  { key: 'services', label: 'Servicios' },
  { key: 'combos', label: 'Combos' },
  { key: 'gifts', label: 'Obsequios' },
  { key: 'products', label: 'Productos' },
  { key: 'delivery', label: 'Delivery' },
];

const GROUP_PRIORITY = new Map(GROUPS.map(({ key }, index) => [key, index]));

function isDeliveryItem({ productName, internalRiderPayUsd }: OrderItemPriorityInput) {
  return (
    Number(internalRiderPayUsd || 0) > 0 ||
    String(productName || '').trim().toLocaleLowerCase('es-VE').includes('delivery')
  );
}

export function getOrderItemDisplayGroup(input: OrderItemPriorityInput): OrderItemDisplayGroup {
  // Delivery siempre se muestra al final, incluso si su producto está registrado como "product".
  if (isDeliveryItem(input)) return 'delivery';

  switch (input.productType) {
    case 'service':
      return 'services';
    case 'combo':
      return 'combos';
    case 'gambit':
      return 'gifts';
    default:
      // Refrescos, salsas, promociones y cualquier artículo sin tipo conocido.
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
