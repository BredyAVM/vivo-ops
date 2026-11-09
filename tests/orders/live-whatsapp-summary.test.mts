import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildLiveOrderWhatsAppSummary } from '../../src/lib/orders/live-whatsapp-summary.ts';

function snapshot() {
  return {
    order: {id: 1, status: 'delivered', fulfillment: 'delivery', total_usd: 45, total_bs_snapshot: 40031.10,
      receiver_name: 'Recibe', receiver_phone: '04140000000', delivery_address: 'Direccion actual', notes: 'Nota actual',
      extra_fields: {schedule: {date: '2026-11-06', time_24: '17:30'}, delivery: {gps_url: 'https://maps.example/current'},
        pricing: {fx_rate: 889.58, total_usd: 45, total_bs: 40031.10},
        payment: {method: 'pending', requires_change: true, change_for: 100, change_currency: 'USD', notes: 'Cambio exacto'},
        documents: {has_invoice: true, invoice_snapshot: {company_name: 'Empresa actual', tax_id: 'J-123'}}}},
    client: {full_name: 'Cliente actual', phone: '04240000000'}, advisor_name: 'Asesor actual',
    items: [{id: 3, qty: 1, product_name_snapshot: 'Delivery Zona 2', line_total_usd: 3, product_type: 'product', notes: ''},
      {id: 2, qty: 3, product_name_snapshot: 'Mini Tequeños Fritos', line_total_usd: 42,
        product_type: 'service', units_per_service: 25, notes: 'Sin sal\n@sel|5|75\n@prep|5|kitchen\n@event|draft|1\n@crm|internal'}],
    finance: {order_id: 1, total_usd: 45, total_bs: 40031.10, pending_usd: 45, confirmed_paid_usd: 0,
      pending_reports_count: 0, client_fund_used_usd: 0},
    calculated_at: '2026-11-06T18:30:00Z',
  };
}

test('a new copy follows unpaid, reported, confirmed, reversed and partial payment states', () => {
  const data = snapshot();
  assert.match(buildLiveOrderWhatsAppSummary(data), /\*Estatus de pago:\* Pendiente/);
  data.finance.pending_reports_count = 1;
  assert.match(buildLiveOrderWhatsAppSummary(data), /\*Estatus de pago:\* Por validar/);
  data.finance.pending_reports_count = 0;
  data.finance.confirmed_paid_usd = 45; data.finance.pending_usd = 0;
  assert.match(buildLiveOrderWhatsAppSummary(data), /\*Estatus de pago:\* Pagado/);
  assert.match(buildLiveOrderWhatsAppSummary(data), /\*Forma de pago:\* Pago registrado/);
  data.finance.confirmed_paid_usd = 0; data.finance.pending_usd = 45;
  assert.match(buildLiveOrderWhatsAppSummary(data), /\*Estatus de pago:\* Pendiente/);
  data.finance.confirmed_paid_usd = 10; data.finance.pending_usd = 35;
  assert.match(buildLiveOrderWhatsAppSummary(data), /Pago parcial · Saldo pendiente/);
});

test('fund application and canonical closed balance are not reconstructed from reports', () => {
  const data = snapshot();
  data.finance.confirmed_paid_usd = 45; data.finance.pending_usd = 0; data.finance.client_fund_used_usd = 45;
  const text = buildLiveOrderWhatsAppSummary(data);
  assert.match(text, /\*Forma de pago:\* Fondo del cliente/);
  assert.match(text, /\*Estatus de pago:\* Pagado/);
});

test('fresh data includes products, contact, advisor, delivery, tax documents, change and notes', () => {
  const data = snapshot();
  const before = JSON.stringify(data);
  const text = buildLiveOrderWhatsAppSummary(data);
  for (const label of ['Cliente actual', 'Asesor actual', '04240000000', 'Recibe', '04140000000',
    'Direccion actual', 'https://maps.example/current', 'Empresa actual', 'J-123',
    '100 USD', 'Cambio exacto', 'Nota actual', '5:30 PM', '3 Serv. Mini Tequeños Fritos (75 und): $42.00']) {
    assert.ok(text.includes(label), label);
  }
  assert.ok(text.indexOf('Mini Tequeños') < text.indexOf('Delivery Zona 2'));
  assert.doesNotMatch(text, /@sel\||@prep\||@event\||@crm\|/);
  assert.equal(JSON.stringify(data), before);
  data.order.notes = 'Nota modificada';
  data.items[1].qty = 4; data.items[1].line_total_usd = 56;
  data.finance.total_usd = 59; data.finance.total_bs = 52484.57;
  const next = buildLiveOrderWhatsAppSummary(data);
  assert.match(next, /Nota modificada/);
  assert.match(next, /4 Serv\. Mini Tequeños Fritos \(100 und\): \$56.00/);
  assert.match(next, /\*TOTAL USD:\* \$59.00/);
});

test('missing financial evidence or a mismatched order fails closed instead of copying old data', () => {
  assert.throws(() => buildLiveOrderWhatsAppSummary({...snapshot(), finance: null}));
  const data = snapshot(); data.finance.order_id = 2;
  assert.throws(() => buildLiveOrderWhatsAppSummary(data));
  assert.throws(() => buildLiveOrderWhatsAppSummary({...snapshot(), items: []}));
});

test('all persisted order copy handlers read on demand, without a cached-summary fallback', () => {
  const read = (file: string) => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const paths = [
    ['src/app/app/advisor/orders/[id]/OrderDetailActions.tsx', 'async function handleCopySummary()', 'orderId'],
    ['src/components/orders/OrdersWorkspaceClient.tsx', 'async function handleCopyWhatsApp()', 'order.id'],
    ['src/app/app/master/dashboard/MasterDashboardClient.tsx', 'const handleCopyOrderWhatsApp = async', 'order.id'],
  ];
  for (const [path, handler, id] of paths) {
    const source = read(path); const start = source.indexOf(handler);
    assert.notEqual(start, -1, path);
    const copy = source.slice(start, start + 750);
    assert.ok(copy.includes('await copyLiveOrderWhatsApp(' + id + ')'), path);
    assert.doesNotMatch(copy, /clipboard.writeText|effectiveWhatsappSummary/);
  }
  const action = read('src/lib/orders/live-whatsapp-action.ts');
  assert.match(action, /requireAuthContext/);
  assert.match(action, /read_order_whatsapp_snapshot_v1/);
  assert.doesNotMatch(action, /service_role|unstable_cache|revalidatePath|\.insert\(|\.update\(/);
  const copy = read('src/lib/orders/copy-live-whatsapp.ts');
  assert.match(copy, /new ClipboardItem/);
  assert.match(copy, /freshText.then/);
  const sql = read('supabase/migrations/20261106143339_order_whatsapp_live_snapshot.sql');
  assert.match(sql, /o.attributed_advisor_id=auth.uid\(\)/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /revoke all.*from public,anon/);
  assert.doesNotMatch(sql, /insert into|update public|delete from|grant select/i);
});
