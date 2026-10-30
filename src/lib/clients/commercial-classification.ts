export type ClientCommercialType = 'own' | 'assigned' | 'direct' | 'legacy';
export type SalesChannel = 'in_person' | 'whatsapp' | 'advisor';

export const CLIENT_TYPE_LABELS: Record<ClientCommercialType, string> = {
  own: 'Propio del asesor',
  assigned: 'Asignado por el negocio',
  direct: 'Directo del negocio',
  legacy: 'Antiguo',
};
export const SALES_CHANNEL_LABELS: Record<SalesChannel, string> = {
  in_person: 'Presencial',
  whatsapp: 'WhatsApp',
  advisor: 'Asesor',
};
export function isClientCommercialType(value: unknown): value is ClientCommercialType {
  return value === 'own' || value === 'assigned' || value === 'direct' || value === 'legacy';
}
export function clientCommercialTypeLabel(value: unknown): string {
  return isClientCommercialType(value) ? CLIENT_TYPE_LABELS[value] : 'Sin clasificar';
}
export function isSalesChannel(value: unknown): value is SalesChannel {
  return value === 'in_person' || value === 'whatsapp' || value === 'advisor';
}
// Historical orders have no observed channel. Never infer WhatsApp from a role,
// a brand, fulfillment or the client's current advisor.
export function salesChannelLabel(value: unknown): string {
  return isSalesChannel(value) ? SALES_CHANNEL_LABELS[value] : 'Sin registrar';
}
