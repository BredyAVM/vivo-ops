import type { EventPreparationMode } from './event-budget';

export type EventOrderComponent = {
  product_id: number; product_name: string; qty: number; preparation_mode: EventPreparationMode;
};
export type EventPriceBreakdown = {
  combos: number; pieces_per_combo: number; price_per_combo: number; stand: number; discount_pct: number;
};
export type EventOrderEditData = {
  order_id: number; version: string | null; status: string; title: string;
  currency: 'USD' | 'VES'; amount: number; total_usd: number; fx_rate: number;
  components_editable: boolean; components: EventOrderComponent[];
  breakdown: EventPriceBreakdown | null;
  commission_mode: string; commission_value: number | null;
  products: { id: number; name: string }[];
};
export type EventOrderEditInput = {
  mode: 'total' | 'breakdown'; amount: number; breakdown: EventPriceBreakdown | null;
  components: EventOrderComponent[]; reason: string;
};

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const hasCentPrecision = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001;
export function calculateEventBreakdown(value: EventPriceBreakdown) {
  if (!Number.isSafeInteger(value.combos) || value.combos < 1 || value.combos > 100000
    || !Number.isSafeInteger(value.pieces_per_combo) || value.pieces_per_combo < 1 || value.pieces_per_combo > 1000
    || !Number.isFinite(value.price_per_combo) || value.price_per_combo < 0
    || !Number.isFinite(value.stand) || value.stand < 0
    || !Number.isFinite(value.discount_pct) || value.discount_pct < 0 || value.discount_pct > 100
    || ![value.price_per_combo, value.stand, value.discount_pct].every(hasCentPrecision)) {
    throw new Error('Revisa cantidades, precios y descuento del evento.');
  }
  const productsCents = value.combos * Math.round(value.price_per_combo * 100);
  const subtotalCents = productsCents + Math.round(value.stand * 100);
  if (subtotalCents > 1000000000) throw new Error('El total del evento supera el límite permitido.');
  const discountCents = Math.floor((subtotalCents * Math.round(value.discount_pct * 100) + 5000) / 10000);
  const products = productsCents / 100, subtotal = subtotalCents / 100;
  const discount = discountCents / 100, total = (subtotalCents - discountCents) / 100;
  return { products, subtotal, discount, total, pieces: value.combos * value.pieces_per_combo };
}

export function validateEventOrderEdit(input: EventOrderEditInput) {
  if (!input.reason.trim() || input.reason.length > 1000) throw new Error('Indica el motivo del cambio (hasta 1000 caracteres).');
  if (!['total', 'breakdown'].includes(input.mode)) throw new Error('Selecciona cómo calcular el precio.');
  if (!Array.isArray(input.components) || input.components.length < 1 || input.components.length > 50) throw new Error('El evento debe tener entre 1 y 50 productos.');
  const seen = new Set<number>();
  for (const c of input.components) {
    if (!Number.isSafeInteger(c.product_id) || c.product_id < 1 || seen.has(c.product_id)
      || !Number.isSafeInteger(c.qty) || c.qty < 1 || c.qty > 1000000
      || !['kitchen', 'on_site', 'not_applicable'].includes(c.preparation_mode)) throw new Error('Revisa los productos, las unidades y su preparación.');
    seen.add(c.product_id);
  }
  if (input.mode === 'breakdown' && !input.breakdown) throw new Error('Completa el desglose del evento.');
  if (input.mode === 'breakdown' && input.components.length === 1
    && input.components[0].qty !== calculateEventBreakdown(input.breakdown!).pieces) {
    throw new Error('Las piezas del producto deben coincidir con los combitos y las piezas por combito.');
  }
  const amount = input.mode === 'breakdown' ? calculateEventBreakdown(input.breakdown!).total : input.amount;
  if (!Number.isFinite(amount) || amount < 0 || amount > 10000000 || !hasCentPrecision(amount)) throw new Error('Indica un total válido con hasta dos decimales.');
  return cents(amount);
}
