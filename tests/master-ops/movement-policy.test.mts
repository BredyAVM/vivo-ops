import assert from "node:assert/strict";
import test from "node:test";
import {
  MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD,
  requiresMasterOpsAdminApproval,
} from "../../src/lib/finance/master-ops-movement-policy.ts";

test("el master confirma egresos de hasta USD 100 inclusive", () => {
  assert.equal(MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD, 100);
  assert.equal(
    requiresMasterOpsAdminApproval({ roles: ["master"], direction: "outflow", totalUsd: 100 }),
    false,
  );
});

test("un egreso del master superior a USD 100 requiere aprobacion", () => {
  assert.equal(
    requiresMasterOpsAdminApproval({ roles: ["master"], direction: "outflow", totalUsd: 100.01 }),
    true,
  );
});

test("ingresos y egresos de admin no quedan pendientes por este limite", () => {
  assert.equal(
    requiresMasterOpsAdminApproval({ roles: ["master"], direction: "inflow", totalUsd: 500 }),
    false,
  );
  assert.equal(
    requiresMasterOpsAdminApproval({ roles: ["admin"], direction: "outflow", totalUsd: 500 }),
    false,
  );
});
