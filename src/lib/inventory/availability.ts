export const INVENTORY_AVAILABILITY_HORIZON_DAYS = 10;

export type InventoryAvailabilitySurface =
  | 'inventory_center'
  | 'advisor_availability'
  | 'master_inventory'
  | 'counter_inventory'
  | 'admin_inventory';

export type InventoryAvailabilityState =
  | 'not_tracked'
  | 'outside_horizon'
  | 'inventory_not_active'
  | 'configuration_pending'
  | 'selection_required'
  | 'requires_opening'
  | 'availability_unknown'
  | 'unavailable'
  | 'relies_on_incoming'
  | 'low'
  | 'available';

export type InventoryAvailabilityItemDetail = {
  inventory_item_id: number;
  inventory_item_name: string;
  unit_name: string;
  required_units_per_product: number;
  status: string;
  recipe_inputs_ready: boolean;
  effective_capacity_units: number | null;
  effective_capacity_without_incoming_units: number | null;
  low_stock_threshold: number | null;
  next_known_supply_at: string | null;
};

export type InventoryProductAvailability = {
  product_id: number;
  sku: string;
  product_name: string;
  product_type: string;
  inventory_policy: 'none' | 'self' | 'direct' | 'components';
  availability_state: InventoryAvailabilityState;
  severity: 'info' | 'warning';
  message: string;
  target_at: string;
  unit_label: 'unidad' | 'servicio';
  units_per_service: number;
  allows_half_service: boolean;
  available_without_affecting_confirmed?: number;
  available_without_planned_incoming?: number;
  depends_on_incoming: boolean;
  next_available_at?: string;
  next_known_supply_at?: string;
  selection_required: boolean;
  has_optional_components: boolean;
  requires_master_review: boolean;
  review_reason_codes: InventoryAvailabilityState[];
  inventory_blocks_submission: false;
  internal_details?: {
    inventory_item_count: number;
    configuration_status: string;
    has_cycle: boolean;
    has_missing_link: boolean;
    has_capacity_error: boolean | null;
    inventory_items: InventoryAvailabilityItemDetail[];
  };
};

export type InventoryCatalogAvailability = {
  generated_at: string;
  requested_target_at: string;
  target_at: string;
  horizon_days: number;
  horizon_ends_at: string;
  surface: InventoryAvailabilitySurface;
  inventory_mode: 'legacy' | 'opening' | 'canonical';
  inventory_blocks_submission: false;
  unknown_product_ids: number[];
  summary: {
    product_count: number;
    requires_master_review_count: number;
    selection_required_count: number;
    available_count: number;
  };
  products: InventoryProductAvailability[];
};

export function buildInventoryAvailabilityRpcArgs(input: {
  targetAt: Date | string;
  productIds?: number[] | null;
  surface: InventoryAvailabilitySurface;
}) {
  const targetAt = input.targetAt instanceof Date
    ? input.targetAt
    : new Date(input.targetAt);
  if (Number.isNaN(targetAt.getTime())) {
    throw new Error('La fecha objetivo de inventario no es válida.');
  }

  const productIds = input.productIds == null
    ? null
    : Array.from(new Set(input.productIds));
  if (productIds && productIds.length > 200) {
    throw new Error('La evaluación de inventario admite hasta 200 productos.');
  }
  if (productIds?.some((productId) => (
    !Number.isSafeInteger(productId) || productId <= 0
  ))) {
    throw new Error('La evaluación contiene un producto inválido.');
  }

  return {
    p_target_at: targetAt.toISOString(),
    p_product_ids: productIds,
    p_surface: input.surface,
  };
}
