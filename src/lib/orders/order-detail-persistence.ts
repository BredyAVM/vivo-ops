/** Display filtering must never be used for persistence. CRM authority lives in columns. */
export function persistableOrderDetailLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(line => String(line ?? '').split(/\r?\n/))
    .map(line => line.trim()).filter(line => line && !/^@crm\|/i.test(line));
}

export type DetailProduct = {
  id: number; name: string; inventory_policy: string | null;
  is_detail_editable: boolean | null; detail_units_limit: number | null;
};
export type DetailComponent = {
  component_product_id: number; component_mode: 'fixed' | 'selectable';
  quantity: number; is_required: boolean; counts_toward_detail_limit: boolean; name: string;
};

/** Normalize only the submitted item. Never infer missing choices from a pack's default size. */
export function normalizeOrderDetailForSave(
  product: DetailProduct, qty: number, value: unknown, components: DetailComponent[],
): string[] {
  const fail = (message: string): never => { throw new Error(`${product.name}: ${message} Abre el detalle para revisarlo.`); };
  if (!Number.isFinite(qty) || qty <= 0) fail('la cantidad del producto no es válida.');
  const lines = persistableOrderDetailLines(value);
  const selections = new Map<number, number>();
  const markers = lines.filter(line => /^@sel\|/i.test(line));
  for (const marker of markers) {
    const match = marker.match(/^@sel\|([1-9]\d*)\|(\d+(?:\.\d+)?)$/i);
    if (!match) fail('la selección de piezas no es válida.');
    const id = Number(match![1]), units = Number(match![2]);
    if (!Number.isSafeInteger(id) || !Number.isFinite(units) || units <= 0 || selections.has(id)) {
      fail('hay cantidades inválidas o piezas duplicadas.');
    }
    selections.set(id, units);
  }
  if (product.inventory_policy !== 'components') return lines;
  if (!components.length) fail('falta configurar la composición del producto.');

  // Legacy text is recovered only on an exact, unique catalog match. No fuzzy guessing.
  if (!markers.length) {
    for (const line of lines) {
      const match = line.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
      if (!match) continue;
      const matches = components.filter(component => component.name === match[2].trim());
      if (matches.length !== 1) fail(`no se puede identificar con seguridad «${match[2]}».`);
      const id = matches[0].component_product_id, units = Number(match[1]);
      if (!Number.isFinite(units) || units <= 0 || selections.has(id)) fail('hay cantidades inválidas o piezas duplicadas.');
      selections.set(id, units);
    }
  }
  for (const id of selections.keys()) {
    if (!components.some(component => component.component_product_id === id)) fail('hay una pieza que no pertenece a este pack.');
  }
  for (const component of components) {
    if (component.component_mode !== 'fixed') continue;
    const expected = qty * component.quantity;
    const selected = selections.get(component.component_product_id);
    if (component.is_required) {
      if (selected != null && Math.abs(selected - expected) > 0.000001) fail(`la cantidad de ${component.name} debe ser ${expected}.`);
      selections.set(component.component_product_id, expected);
    } else if (selected != null && selected > expected + 0.000001) {
      fail(`la cantidad de ${component.name} supera ${expected}.`);
    }
  }
  const counted = components.reduce((sum, component) => sum + (component.counts_toward_detail_limit ? selections.get(component.component_product_id) ?? 0 : 0), 0);
  const expected = qty * Number(product.detail_units_limit || 0);
  if (product.is_detail_editable && expected > 0 && Math.abs(counted - expected) > 0.000001) {
    fail(`faltan o sobran piezas: tiene ${counted} de ${expected}.`);
  }
  if (!selections.size || (product.is_detail_editable && expected === 0 && counted <= 0 && components.some(c => c.component_mode === 'selectable'))) {
    fail('falta seleccionar las piezas.');
  }
  // The visible quantities are rebuilt from the same IDs used by inventory.
  const notes = lines.filter(line => {
    if (/^@sel\|/i.test(line)) return false;
    const detail = line.match(/^\d+(?:\.\d+)?\s+(.+)$/);
    return !detail || !components.some(component => component.name === detail[1].trim());
  });
  for (const component of components) {
    const units = selections.get(component.component_product_id);
    if (units != null && units > 0) notes.push(`${units} ${component.name}`, `@sel|${component.component_product_id}|${units}`);
  }
  return notes;
}
