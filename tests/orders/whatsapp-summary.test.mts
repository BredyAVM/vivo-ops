import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeWhatsAppCustomerNote } from "../../src/lib/orders/whatsapp-summary.ts";

test("removes the internal master reapproval marker from a customer note", () => {
  assert.equal(
    sanitizeWhatsAppCustomerNote(
      "LLEVA FACTURA 128 | master_reapprove=Re-aprobado desde modulo operativo.",
    ),
    "LLEVA FACTURA 128",
  );
});

test("omits a note made only of the internal master reapproval marker", () => {
  assert.equal(
    sanitizeWhatsAppCustomerNote("master_reapprove=Re-aprobado desde modulo operativo."),
    "",
  );
});

test("preserves customer-facing order notes", () => {
  assert.equal(
    sanitizeWhatsAppCustomerNote("LLEVA FACTURA 128 | Tocar el timbre"),
    "LLEVA FACTURA 128 | Tocar el timbre",
  );
});
