export type InventoryReadinessStatus =
  | 'ready_for_canonical_operation'
  | 'structural_blockers'
  | 'opening_in_progress'
  | 'structure_ready_opening_pending';

export type InventoryReadinessCheck = {
  code: string;
  phase: 'structure' | 'operation';
  status: 'pass' | 'pending' | 'blocked' | 'info';
  blocks_cutover: boolean;
  title: string;
  detail: string;
  current?: number;
  required?: number;
};

export type InventoryRecipeActivationRow = {
  id: number;
  output_inventory_item_id: number;
  output_name: string;
  output_unit_name: string;
  recipe_kind: string;
  version: number;
  lead_time_minutes: number;
  status: 'invalid' | 'active' | 'blocked_by_opening' | 'ready_to_activate';
  opening_blockers: Array<{ id: number; name: string }>;
};

export type InventoryCutoverReadiness = {
  generated_at: string;
  read_only: true;
  inventory_blocks_orders: false;
  cutover_mode: 'legacy' | 'opening' | 'canonical';
  status: InventoryReadinessStatus;
  structural_ready: boolean;
  operational_ready: boolean;
  summary: {
    catalog_products: number;
    active_products: number;
    ready_catalog_products: number;
    canonical_links: number;
    canonical_recipes: number;
    active_canonical_recipes: number;
    eligible_opening_items: number;
    accepted_openings: number;
    open_orders: number;
    canonical_movements: number;
  };
  checks: InventoryReadinessCheck[];
  opening: {
    eligible_count: number;
    accepted_count: number;
    under_review_count: number;
    pending_count: number;
    pending_items: Array<{
      id: number;
      name: string;
      inventory_group: string;
      unit_name: string;
      status: 'pending' | 'under_review';
    }>;
  };
  recipes: {
    required_output_count: number;
    canonical_count: number;
    active_count: number;
    activation_queue: InventoryRecipeActivationRow[];
  };
  orders: {
    open_count: number;
    resolver_error_count: number;
    commitment_mismatch_count: number;
    orphan_commitment_count: number;
    issues: unknown[];
  };
  roles: Record<string, number>;
  safety: {
    performs_writes: false;
    activates_cutover: false;
    blocks_order_submission: false;
    advisor_can_submit: true;
    master_keeps_final_decision: true;
  };
};

export function parseInventoryCutoverReadiness(value: unknown): InventoryCutoverReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Supabase devolvió una auditoría de preparación inválida.');
  }

  const payload = value as Partial<InventoryCutoverReadiness>;
  if (
    !Array.isArray(payload.checks)
    || !payload.summary
    || !payload.opening
    || !payload.recipes
    || !payload.orders
    || !payload.safety
  ) {
    throw new Error('La auditoría de preparación está incompleta.');
  }

  return payload as InventoryCutoverReadiness;
}
