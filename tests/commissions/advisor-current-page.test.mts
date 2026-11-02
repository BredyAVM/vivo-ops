import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { renderAdvisorPage } = createRequire(import.meta.url)('./helpers/advisor-page-fixture.cjs');

test('real advisor page renders the same released pending balance in summary, tile and detail', async () => {
  const { html, reads } = await renderAdvisorPage();
  assert.equal((html.match(/\$18\.88/g) ?? []).length >= 5, true);
  assert.match(html, /Pendiente por pagar<\/div><div[^>]*>\$18\.88/);
  assert.match(html, /Ver acuerdo original.*?\$0\.00/s);
  assert.match(html, /Monto acordado originalmente/);
  assert.equal(reads.filter((read: { name?: string }) => read.name).length, 1);
});

test('real advisor page subtracts registered advisor payments, including paid agreements', async () => {
  const { html } = await renderAdvisorPage('payable', 'partial');
  assert.match(html, /Pendiente por pagar<\/div><div[^>]*>\$8\.88/);
  assert.match(html, /Pagado al asesor<\/div><div[^>]*>\$10\.00/);
  assert.match(html, /Ver acuerdo original.*?\$0\.00/s);
});

test('real advisor page renders unverified on read failure, never the old zero as current', async () => {
  const { html } = await renderAdvisorPage('payable', 'error');
  assert.match(html, /Pendiente por pagar<\/div><div[^>]*>Sin verificar/);
  assert.match(html, /No se pudo verificar la cobranza actual/);
});

test('real advisor page preserves transferred ownership and refreshed order cash without altering net sales', async () => {
  const { html: transferred } = await renderAdvisorPage('payable', 'transferred');
  assert.match(transferred, /Saldo trasladado/);
  assert.match(transferred, /No se paga de nuevo en este origen/);
  const { html: orders } = await renderAdvisorPage('orders');
  assert.match(orders, /Orden #?2478/);
  assert.match(orders, /Sin IVA · Comisión \$5\.00/);
  assert.match(orders, /Pagada · fecha sin verificar/);
  assert.doesNotMatch(orders, /Pendiente \$10\.00|Pago puntual/);
});
