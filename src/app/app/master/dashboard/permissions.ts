export type MasterDashboardRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'driver';

export type MasterDashboardPermissionKey = keyof MasterDashboardPermissions;

export type MasterDashboardPermissions = {
  isAdmin: boolean;
  isMaster: boolean;
  canViewOperations: boolean;
  canViewSettings: boolean;
  canViewCatalog: boolean;
  canCreateCatalogItems: boolean;
  canManageCatalogItems: boolean;
  canManageCatalogPrices: boolean;
  canViewInventory: boolean;
  canCreateInventoryItems: boolean;
  canManageInventoryItems: boolean;
  canAdjustInventory: boolean;
  canManageExchangeRate: boolean;
  canViewAccounts: boolean;
  canCreateMoneyMovements: boolean;
  canRegisterAccountClosures: boolean;
  canCreateMoneyTransfers: boolean;
  canCreateMoneyAccounts: boolean;
  canManageMoneyAccounts: boolean;
  canManageMoneyAccountRules: boolean;
  canReviewPaymentReports: boolean;
  canReviewMoneyMovements: boolean;
  canViewClients: boolean;
  canManageClients: boolean;
  canManageUsers: boolean;
  canViewAdjustments: boolean;
  canManageAdjustments: boolean;
  canViewCalculations: boolean;
  canManageCalculations: boolean;
  canViewDeliveryCalculations: boolean;
  canManageDeliveryPartners: boolean;
  canEditClosedOrders: boolean;
  canAdjustOrderPrices: boolean;
  canCloseOrderRoundingBalance: boolean;
};

export function hasMasterDashboardRole(roles: readonly string[], role: MasterDashboardRole) {
  return roles.includes(role);
}

export function getMasterDashboardPermissions(roles: readonly string[] = []): MasterDashboardPermissions {
  const isAdmin = hasMasterDashboardRole(roles, 'admin');
  const isMaster = hasMasterDashboardRole(roles, 'master');
  const isMasterOrAdmin = isAdmin || isMaster;

  return {
    isAdmin,
    isMaster,
    canViewOperations: isMasterOrAdmin,
    canViewSettings: isMasterOrAdmin,
    canViewCatalog: isMasterOrAdmin,
    canCreateCatalogItems: isAdmin,
    canManageCatalogItems: isAdmin,
    canManageCatalogPrices: isAdmin,
    canViewInventory: isMasterOrAdmin,
    canCreateInventoryItems: isAdmin,
    canManageInventoryItems: isAdmin,
    canAdjustInventory: isMasterOrAdmin,
    canManageExchangeRate: isMasterOrAdmin,
    canViewAccounts: isMasterOrAdmin,
    canCreateMoneyMovements: isMasterOrAdmin,
    canRegisterAccountClosures: isMasterOrAdmin,
    canCreateMoneyTransfers: isAdmin,
    canCreateMoneyAccounts: isAdmin,
    canManageMoneyAccounts: isAdmin,
    canManageMoneyAccountRules: isAdmin,
    canReviewPaymentReports: isMasterOrAdmin,
    canReviewMoneyMovements: isAdmin,
    canViewClients: isMasterOrAdmin,
    canManageClients: isMasterOrAdmin,
    canManageUsers: isAdmin,
    canViewAdjustments: isMasterOrAdmin,
    canManageAdjustments: isAdmin,
    canViewCalculations: isMasterOrAdmin,
    canManageCalculations: isAdmin,
    canViewDeliveryCalculations: isMasterOrAdmin,
    canManageDeliveryPartners: isAdmin,
    canEditClosedOrders: isAdmin,
    canAdjustOrderPrices: isAdmin,
    canCloseOrderRoundingBalance: isAdmin,
  };
}

export function assertMasterDashboardPermission(
  roles: readonly string[],
  permission: MasterDashboardPermissionKey,
  message = 'Esta accion requiere permisos adicionales.'
) {
  const permissions = getMasterDashboardPermissions(roles);
  if (!permissions[permission]) {
    throw new Error(message);
  }
}
