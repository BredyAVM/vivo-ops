"use server";

import { getAuthContext } from '@/lib/auth';
import { readWorkspaceInventorySummary } from '@/lib/orders/workspace-inventory-summary';
export type { MasterOpsInventoryAlertSummary } from '@/lib/orders/workspace-inventory-summary';

// Compatibility for existing callers; the workspace now streams this read.
export async function loadMasterOpsInventoryAlertSummaryAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }
