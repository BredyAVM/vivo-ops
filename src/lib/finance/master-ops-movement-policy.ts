export const MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD = 100;

export function requiresMasterOpsAdminApproval(input: {
  roles: readonly string[];
  direction: "inflow" | "outflow";
  totalUsd: number;
}) {
  if (input.direction !== "outflow") return false;
  if (input.roles.includes("admin")) return false;
  return input.totalUsd > MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD;
}
