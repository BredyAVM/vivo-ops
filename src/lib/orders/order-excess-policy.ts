/** Keep the shared workspace aligned with store_operational_order_excess_v1. */
export function canResolveOperationalOrderExcess(status: string, isAdmin: boolean): boolean {
  return ["created", "queued", "confirmed", "in_kitchen", "ready"].includes(status)
    || (status === "delivered" && isAdmin);
}
