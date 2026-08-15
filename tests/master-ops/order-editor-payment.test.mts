import assert from "node:assert/strict";
import test from "node:test";

import {
  isMasterOpsOrderPaymentMethod,
  normalizeMasterOpsOrderPaymentMethod,
} from "../../src/app/app/master/ops/order-editor-payment.ts";

test("normalizes the advisor legacy pending method as undefined", () => {
  assert.equal(normalizeMasterOpsOrderPaymentMethod("pending"), "");
  assert.equal(isMasterOpsOrderPaymentMethod("pending"), true);
});

test("keeps supported operational payment methods", () => {
  assert.equal(normalizeMasterOpsOrderPaymentMethod("payment_mobile"), "payment_mobile");
  assert.equal(isMasterOpsOrderPaymentMethod("cash_usd"), true);
});

test("rejects unknown payment methods", () => {
  assert.equal(normalizeMasterOpsOrderPaymentMethod("crypto"), "crypto");
  assert.equal(isMasterOpsOrderPaymentMethod("crypto"), false);
});
