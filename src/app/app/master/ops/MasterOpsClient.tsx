"use client";

// Compatibility entry for existing consumers. Both routes use the shared workspace.
export { default, buildOperationStats } from "@/components/orders/OrdersWorkspaceClient";
export type {
  PaymentVerify,
  MasterOpsOrder,
  DriverOption,
  DeliveryPartnerOption,
  MasterOpsPaymentAccountOption,
  OperationStatsSummary,
  MasterOpsStats,
} from "@/components/orders/OrdersWorkspaceClient";
