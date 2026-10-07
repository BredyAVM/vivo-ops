import assert from "node:assert/strict";
import test from "node:test";

import { buildWhatsAppOrderSummaryText, sanitizeWhatsAppCustomerNote } from "../../src/lib/orders/whatsapp-summary.ts";

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

test('WhatsApp sorts the same groups and keeps combo details under their parent', () => {
  const text = buildWhatsAppOrderSummaryText({
    clientName: 'Cliente',
    fulfillment: 'delivery',
    deliveryText: 'Lo antes posible',
    price: { totalBs: 1000, totalUsd: 10 },
    lines: [
      { text: 'DELIVERY: Bs 100', priority: { isDelivery: true } },
      { text: 'BEBIDA: Bs 200', priority: { inventoryGroup: 'beverages' } },
      { text: 'SALSA: Bs 50', priority: { inventoryGroup: 'sauces' } },
      { text: 'COMBO: Bs 650', detailLines: ['6 tequenos', '1 salsa incluida'], priority: { productType: 'combo' } },
    ],
  });
  assert.ok(text.indexOf('COMBO: Bs 650') < text.indexOf('SALSA: Bs 50'));
  assert.ok(text.indexOf('SALSA: Bs 50') < text.indexOf('BEBIDA: Bs 200'));
  assert.ok(text.indexOf('BEBIDA: Bs 200') < text.indexOf('DELIVERY: Bs 100'));
  assert.ok(text.indexOf('1 salsa incluida') < text.indexOf('SALSA: Bs 50'));
  assert.match(text, /COMBO: Bs 650\n    - 6 tequenos\n    - 1 salsa incluida/);
});

test('legacy WhatsApp callers without metadata also keep delivery last', () => {
  const lines = [{ text: '1 Delivery Zona 2: Bs 100' }, { text: '1 Pepsi: Bs 200' }, { text: '1 Tequenos: Bs 700' }];
  const text = buildWhatsAppOrderSummaryText({
    clientName: 'Cliente', fulfillment: 'delivery', deliveryText: 'Hoy', lines,
    price: { totalBs: 1000, totalUsd: 10 },
  });
  assert.ok(text.indexOf('1 Tequenos') < text.indexOf('1 Pepsi'));
  assert.ok(text.indexOf('1 Pepsi') < text.indexOf('1 Delivery'));
  assert.equal(lines[0].text, '1 Delivery Zona 2: Bs 100');
});
