import assert from "node:assert/strict";
import test from "node:test";

import { buildWhatsAppOrderSummaryText, sanitizeWhatsAppCustomerNote, formatWhatsAppItemPrice,
  formatWhatsAppBs, formatWhatsAppExchangeRate } from "../../src/lib/orders/whatsapp-summary.ts";

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

test('USD item unit price and line subtotal are explicit, including half services and gifts', () => {
  assert.equal(formatWhatsAppItemPrice(1, 14), '$14.00');
  assert.equal(formatWhatsAppItemPrice(2, 28), '$14.00 c/u · $28.00');
  assert.equal(formatWhatsAppItemPrice(.5, 7), '$14.00 c/u · $7.00');
  assert.equal(formatWhatsAppItemPrice(1, 0), '$0.00');
  assert.throws(() => formatWhatsAppItemPrice(0, 14));
  assert.throws(() => formatWhatsAppItemPrice(1, Number.NaN));
  assert.throws(() => formatWhatsAppItemPrice(1, null));
  assert.throws(() => formatWhatsAppItemPrice(1, ''));
  assert.throws(() => formatWhatsAppItemPrice(null, 14));
});

test('WhatsApp shows certified total Bs, USD, real FX and Caracas calculation timestamp', () => {
  const input = {
    clientName: 'Cliente', fulfillment: 'pickup' as const, deliveryText: 'Hoy',
    lines: [{ text: `1 Mini: ${formatWhatsAppItemPrice(1, 14)}` }],
    price: { totalUsd: 14, totalBs: 11500.73 }, exchangeRate: 817.7, calculatedAt: '2026-10-10T02:00:00Z',
  };
  const before = JSON.stringify(input);
  const text = buildWhatsAppOrderSummaryText(input);
  assert.match(text, /1 Mini: \$14\.00/);
  assert.match(text, /\*TOTAL USD:\* \$14\.00/);
  assert.match(text, /11\.500,73/);
  assert.match(text, /817,70 Bs\/USD/);
  assert.match(text, /09\/10\/2026/);
  assert.equal(JSON.stringify(input), before);
  assert.equal(formatWhatsAppBs(11500.73), 'Bs 11.500,73');
  assert.equal(formatWhatsAppExchangeRate(860.2345), '860,2345 Bs/USD');
});
