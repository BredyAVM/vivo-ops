export type CounterPickupChangePreviewItem = {
  itemId: number | null;
  productId: number;
  name: string;
  previousQty: number | null;
  qty: number;
  lineUsd: number;
  lineBs: number;
  notes: string | null;
};

export type CounterPickupChangeRequest = {
  id: number;
  status: 'pending' | 'approved' | 'rejected' | 'stale';
  reason: string;
  requestedAt: string;
  requestedByName: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNotes: string | null;
  appliedAt: string | null;
  preview: {
    totalUsd: number;
    totalBs: number;
    hadReduction: boolean;
    hadExistingIncrease: boolean;
    hasAdditions: boolean;
    needsKitchen: boolean;
    existingItems: CounterPickupChangePreviewItem[];
    addedItems: CounterPickupChangePreviewItem[];
  };
};

export type CounterPickupItemChangeIntent = {
  idempotencyKey: string;
  orderId: number;
  existingItems: Array<{
    itemId: number;
    qty: number;
  }>;
  addedItems: Array<{
    productId: number;
    qty: number;
    notes?: string | null;
    editableDetailLines?: string[] | null;
  }>;
  reason?: string | null;
};

export type CounterPickupItemChangeResult = {
  status: 'applied' | 'pending_approval';
  orderId: number;
  requestId: number | null;
  returnedToKitchen: boolean;
  totalUsd: number;
  totalBs: number;
};

export type CounterPickupScheduleIntent = {
  idempotencyKey: string;
  orderId: number;
  scheduledDate: string;
  scheduledTime: string;
  reason: string;
  sendToKitchen: boolean;
};

export type CounterPickupScheduleResult = {
  status: 'schedule_updated' | 'sent_to_kitchen';
  orderId: number;
  scheduleDate: string;
  scheduleTime: string;
  sentToKitchen: boolean;
};

export type CounterPickupCompletionResult = {
  status: 'delivered';
  orderId: number;
  deliveredAt: string;
  paymentStatus: string;
  pendingUsd: number;
  pendingReportsCount: number;
  advisorResponsibleForCollection: boolean;
};

export type CounterPickupChangeDecisionResult = {
  status: 'approved' | 'rejected' | 'stale';
  requestId: number;
  orderId: number;
  returnedToKitchen: boolean;
  totalUsd?: number;
  totalBs?: number;
};
