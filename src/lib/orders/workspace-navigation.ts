export type OrdersWorkspaceSurface = "master" | "admin";

// Surface selects presentation and navigation, never grants business permissions.
export function canOpenOrdersWorkspace(surface: OrdersWorkspaceSurface, roles: readonly string[]) {
  return roles.includes("admin") || (surface === "master" && roles.includes("master"));
}

export function ordersWorkspaceNavigation(surface: OrdersWorkspaceSurface) {
  const admin = surface === "admin";
  return {
    orders: admin ? "/app/admin/ordenes" : "/app/master/ops",
    inventory: admin ? "/app/inventory" : "/app/master/ops/inventory",
    payments: admin ? "/app/admin/autorizaciones?tipo=payment" : "/app/master/ops/finance",
    movement: admin ? "/app/admin/finanzas/cuentas/movimiento" : "/app/master/ops/finance?movement=new",
  };
}
