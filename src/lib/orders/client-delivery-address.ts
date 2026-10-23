export type ClientDeliveryAddress = { addressText: string; gpsUrl: string };

/** Accept both stored and legacy client-profile shapes; ignore empty or duplicate entries. */
export function clientDeliveryAddresses(value: unknown): ClientDeliveryAddress[] {
  if (!Array.isArray(value)) return [];
  const result: ClientDeliveryAddress[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const text = row.address_text ?? row.addressText;
    const gps = row.gps_url ?? row.gpsUrl;
    const addressText = typeof text === 'string' ? text.trim() : '';
    const gpsUrl = typeof gps === 'string' ? gps.trim() : '';
    if (!addressText && !gpsUrl) continue;
    const key = JSON.stringify([addressText.replace(/\s+/g, ' ').toLocaleLowerCase('es-VE'), gpsUrl]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ addressText, gpsUrl });
    if (result.length === 2) break;
  }
  return result;
}

type DeliveryAddressForm = {
  fulfillment: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  client: { recentAddresses: unknown } | null;
};

/** Address and GPS are a pair: never combine a manual location with a saved address. */
export function suggestSavedClientDeliveryAddress<T extends DeliveryAddressForm>(form: T, manuallyEdited: boolean): T {
  if (form.fulfillment !== 'delivery' || manuallyEdited || form.deliveryAddress.trim() || form.deliveryGpsUrl.trim()) return form;
  const address = clientDeliveryAddresses(form.client?.recentAddresses)[0];
  return address ? { ...form, deliveryAddress: address.addressText, deliveryGpsUrl: address.gpsUrl } : form;
}
