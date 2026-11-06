import { getOrderMoneySnapshot } from './order-money.ts';
import { getPaymentMethodLabel } from './order-labels.ts';
import {
  buildWhatsAppOrderSummaryText, cleanWhatsAppUnitsFromName, formatWhatsAppDateVE,
  formatWhatsAppItemPrice, formatWhatsAppQuantity, formatWhatsAppTimeAmPm, getWhatsAppLineUnits,
  type WhatsAppSummaryDocument, type WhatsAppSummaryDeliveryNote,
} from './whatsapp-summary.ts';

type Data = Record<string, unknown>;
const record = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown) => value == null ? '' : String(value).trim();
function number(value: unknown, label: string) {
  if (value == null || text(value) === '' || !Number.isFinite(Number(value))) throw new Error(`Falta verificar ${label}.`);
  return Number(value);
}

export function buildLiveOrderWhatsAppSummary(value: unknown) {
  const snapshot = record(value);
  const order = record(snapshot.order);
  const client = record(snapshot.client);
  const extra = record(order.extra_fields);
  const payment = record(extra.payment);
  const schedule = record(extra.schedule);
  const delivery = record(extra.delivery);
  const receiver = record(extra.receiver);
  const documents = record(extra.documents);
  const finance = record(snapshot.finance);
  if (!order.id || !snapshot.calculated_at || number(finance.order_id, 'la orden') !== Number(order.id)) {
    throw new Error('No se pudo verificar el pedido actual.');
  }
  const pricing = getOrderMoneySnapshot(order);
  const balance = number(finance.pending_usd, 'el saldo');
  const paid = number(finance.confirmed_paid_usd, 'el pago confirmado');
  const reports = number(finance.pending_reports_count, 'los pagos por validar');
  const fundPaid = number(finance.client_fund_used_usd, 'el fondo aplicado');
  const method = text(payment.method);
  const paymentMethodLabel = paid > 0.005 && (!method || method === 'pending')
    ? fundPaid >= paid - 0.005 ? 'Fondo del cliente' : 'Pago registrado'
    : getPaymentMethodLabel(method);
  const status = order.status === 'cancelled' ? 'Cancelado'
    : balance <= 0.005 ? 'Pagado'
    : reports > 0 ? 'Por validar'
    : paid > 0.005 ? 'Pago parcial · Saldo pendiente' : 'Pendiente';
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) throw new Error('No se pudieron verificar los productos.');
  return buildWhatsAppOrderSummaryText({
    title: 'Resumen de Pedido', orderLabel: text(order.id), advisorName: text(snapshot.advisor_name),
    clientName: text(client.full_name), clientPhone: text(client.phone),
    receiverName: text(receiver.name) || text(order.receiver_name), receiverPhone: text(receiver.phone) || text(order.receiver_phone),
    lines: snapshot.items.map((raw) => {
      const item = record(raw);
      const name = text(item.product_name_snapshot);
      const qty = number(item.qty, 'la cantidad');
      const units = getWhatsAppLineUnits({qty, name, unitsPerService: Number(item.units_per_service)});
      const prefix = item.product_type === 'service' ? 'Serv. ' : '';
      const label = units ? `${prefix}${cleanWhatsAppUnitsFromName(name)} (${formatWhatsAppQuantity(units)} und)` : name;
      return {
        text: `- ${formatWhatsAppQuantity(qty)} ${label}: ${formatWhatsAppItemPrice(qty, item.line_total_usd as number)}`,
        detailLines: text(item.notes).split(/\r?\n/).map(line => line.trim()).filter(Boolean),
        priority: {productType: text(item.product_type), productName: name, inventoryGroup: text(item.inventory_group),
          internalRiderPayUsd: Number(item.internal_rider_pay_usd || 0)},
      };
    }),
    price: {...pricing, totalUsd: number(finance.total_usd, 'el total USD'), totalBs: number(finance.total_bs, 'el total Bs')},
    exchangeRate: pricing.fxRate, calculatedAt: text(snapshot.calculated_at),
    fulfillment: order.fulfillment === 'delivery' ? 'delivery' : 'pickup',
    deliveryText: '', deliveryDateText: formatWhatsAppDateVE(text(schedule.date)),
    deliveryTimeText: schedule.asap ? 'Lo antes posible' : formatWhatsAppTimeAmPm(text(schedule.time_12) || text(schedule.time_24)),
    address: text(order.delivery_address) || text(delivery.address), gpsUrl: text(delivery.gps_url),
    paymentMethodLabel,
    paymentChangeText: payment.requires_change
      ? `Llevar cambio para ${text(payment.change_for)} ${text(payment.change_currency)}` : '',
    paymentNote: text(payment.notes), paymentStatus: status,
    invoice: {enabled: documents.has_invoice === true,
      companyName: text(record(documents.invoice_snapshot).company_name),
      taxId: text(record(documents.invoice_snapshot).tax_id),
      address: text(record(documents.invoice_snapshot).address), phone: text(record(documents.invoice_snapshot).phone)} satisfies WhatsAppSummaryDocument,
    deliveryNote: {enabled: documents.has_delivery_note === true, ...record(documents.delivery_note_snapshot),
      documentId: text(record(documents.delivery_note_snapshot).document_id)} satisfies WhatsAppSummaryDeliveryNote,
    notes: text(order.notes),
  });
}
