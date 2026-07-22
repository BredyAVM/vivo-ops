import {
  canManageOrderDeliveryAssignment,
  canReturnOrderToAdvisor,
  canStartOrderDelivery,
  type FulfillmentType,
} from "@/lib/domain/order-domain";

type MasterOpsOperationalOrder = {
  fulfillment: FulfillmentType | null | undefined;
  status: string | null | undefined;
  returnedToAdvisor?: boolean | null;
  riderName?: string | null;
  externalPartner?: string | null;
  internalDriverUserId?: string | null;
  externalPartnerId?: number | string | null;
};

const DELIVERY_ASSIGNMENT_STATUSES = ["confirmed", "in_kitchen", "ready"];

export function hasMasterOpsDeliveryAssignment(order: MasterOpsOperationalOrder) {
  return Boolean(
    order.riderName?.trim() ||
    order.externalPartner?.trim() ||
    order.internalDriverUserId?.trim() ||
    Number(order.externalPartnerId || 0) > 0
  );
}

export function canAssignMasterOpsDelivery(order: MasterOpsOperationalOrder) {
  return (
    canManageOrderDeliveryAssignment(order) &&
    DELIVERY_ASSIGNMENT_STATUSES.includes(String(order.status || "")) &&
    !hasMasterOpsDeliveryAssignment(order)
  );
}

export function canClearMasterOpsDeliveryAssignment(order: MasterOpsOperationalOrder) {
  return (
    canManageOrderDeliveryAssignment(order) &&
    DELIVERY_ASSIGNMENT_STATUSES.includes(String(order.status || "")) &&
    hasMasterOpsDeliveryAssignment(order)
  );
}

export function canStartMasterOpsDelivery(order: MasterOpsOperationalOrder) {
  return canStartOrderDelivery(order) && hasMasterOpsDeliveryAssignment(order);
}

export function canReturnMasterOpsOrderToAdvisor(order: MasterOpsOperationalOrder) {
  return canReturnOrderToAdvisor(order) && !(order.status === "created" && order.returnedToAdvisor);
}
