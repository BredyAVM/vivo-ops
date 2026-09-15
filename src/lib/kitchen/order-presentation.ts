import { getWhatsAppLineUnits } from '../orders/whatsapp-summary.ts';

const HIDDEN_DETAIL_PREFIX = '@sel|';

export type KitchenComponent = {
  productId: number;
  name: string;
  mode: 'fixed' | 'selectable';
  quantity: number;
  required: boolean;
  countsTowardLimit: boolean;
  isNested: boolean;
};

export type KitchenComponentSnapshot = { productId: number; name: string; qty: number };
export type KitchenComposition = {
  editable: boolean;
  detailLimit: number;
  components: KitchenComponent[];
  snapshots: KitchenComponentSnapshot[];
};

export type KitchenPresentationItem = {
  qty: number;
  name: string;
  notes: string | null;
  unitsPerService: number;
  // Only the Kitchen server loader supplies this contract. No inventory writes.
  composition?: KitchenComposition | null;
};

export type KitchenPresentationDetailLine = {
  label: string;
  qty: number | null;
  qtyPerPresentation: number | null;
};

export type KitchenItemPresentation = {
  detailLines: KitchenPresentationDetailLine[];
  hasCountedDetails: boolean;
  repeatsSameConfiguration: boolean;
  totalUnits: number;
  preparedUnits: number;
  quantityWarning: string | null;
  assemblyNote: string | null;
};

function toNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function floorKitchenPieces(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function extractUnitsPerService(name: string) {
  const match = name.match(/(\d+(?:[.,]\d+)?)\s*(?:und|uds|unidad(?:es)?|pzs?|piezas?)/i);
  if (!match) return 0;
  return toNumber(match[1].replace(',', '.'), 0);
}

function isNonKitchenLine(name: string) {
  return /\b(delivery|entrega|envio|envío)\b/i.test(name);
}

function isKitchenAccessoryLine(name: string) {
  return /\b(salsa|salsas|refresco|refrescos|bebida|bebidas|agua|jugo|jugos|malta|coca|pepsi|chinotto|papelón|tequechicha)\b/i.test(name);
}

function isKitchenPreparedLine(name: string) {
  return !isNonKitchenLine(name) && !isKitchenAccessoryLine(name);
}

function parseBaseDetailLines(notes: string | null) {
  return String(notes || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^@(sel|prep|event|crm)\|/i.test(line))
    .map((line) => {
      const match = line.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
      if (!match) return { label: line, qty: null };
      return {
        label: match[2].trim(),
        qty: toNumber(match[1].replace(',', '.'), 0),
      };
    });
}

export function getKitchenItemUnits(item: KitchenPresentationItem) {
  if (isNonKitchenLine(item.name)) return 0;

  const lineUnits = getWhatsAppLineUnits({
    qty: item.qty,
    name: item.name,
    unitsPerService: item.unitsPerService,
  });
  if (lineUnits != null) return lineUnits;

  const unitsPerService = extractUnitsPerService(item.name);
  if (unitsPerService > 0) return floorKitchenPieces(item.qty * unitsPerService);
  return item.qty;
}

export function getKitchenItemPresentation(
  item: KitchenPresentationItem,
): KitchenItemPresentation {
  const baseDetailLines = parseBaseDetailLines(item.notes);
  const composition = item.composition;
  if (!composition) {
    // Unstructured detail is never evidence that an item repeats a configuration.
    const detailLines = baseDetailLines.map(line => composition === null
      ? { label: line.qty == null ? line.label : `${line.qty} ${line.label}`, qty: null, qtyPerPresentation: null }
      : { ...line, qtyPerPresentation: null });
    const hasCountedDetails = detailLines.some(line => line.qty != null);
    const totalUnits = getKitchenItemUnits(item);
    return {
      detailLines, hasCountedDetails, repeatsSameConfiguration: false, totalUnits,
      preparedUnits: isKitchenPreparedLine(item.name) ? totalUnits : 0,
      quantityWarning: hasCountedDetails || /@sel\|/.test(item.notes || '')
        ? 'Este detalle no tiene una composición verificable. Confirma las cantidades con Máster; no se han multiplicado.'
        : null,
      assemblyNote: null,
    };
  }

  const warnings = new Set<string>();
  const warn = (message: string) => { warnings.add(message); };
  const same = (a: number, b: number) => Math.abs(a - b) < 0.000001;
  if (!Number.isFinite(item.qty) || item.qty <= 0) warn('La cantidad de presentaciones no es válida.');
  if (!composition.components.length) warn('No se pudo verificar la composición del producto.');

  const markers = new Map<number, number>();
  let invalidMarkers = false;
  for (const line of String(item.notes || '').split(/\r?\n/).map(line => line.trim())) {
    if (!line.startsWith(HIDDEN_DETAIL_PREFIX)) continue;
    const match = line.match(/^@sel\|([1-9]\d*)\|(\d+(?:\.\d+)?)$/);
    const id = Number(match?.[1]);
    const qty = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(id) || !Number.isFinite(qty) || qty <= 0) {
      invalidMarkers = true;
      continue;
    }
    markers.set(id, (markers.get(id) ?? 0) + qty);
  }

  // Same precedence as inventory_order_sale_diagnostics_v1:
  // stored component totals > @sel totals > required fixed recipe × item qty.
  // @sel is a selection ID, NOT a "per presentation" flag.
  const snapshots = new Map<number, number>();
  const snapshotNames = new Map<number, string>();
  for (const snapshot of composition.snapshots) {
    if (!Number.isSafeInteger(snapshot.productId) || snapshot.productId <= 0
      || !Number.isFinite(snapshot.qty) || snapshot.qty <= 0) {
      warn('La composición guardada contiene una cantidad inválida.');
      continue;
    }
    snapshots.set(snapshot.productId, (snapshots.get(snapshot.productId) ?? 0) + snapshot.qty);
    if (snapshot.name.trim()) snapshotNames.set(snapshot.productId, snapshot.name.trim());
  }
  const hasSnapshot = composition.snapshots.length > 0;
  const selections = hasSnapshot ? snapshots : markers;
  if (invalidMarkers) warn('Hay un detalle de selección inválido en el pedido.');

  // Historical per-pack notes are recognized ONLY when actual stored totals
  // confirm the entire selection. This never calculates or changes those totals.
  const confirmedLegacyPerPack = hasSnapshot && !invalidMarkers && item.qty > 1
    && markers.size > 0 && markers.size === snapshots.size
    && [...markers].every(([id, qty]) => same(snapshots.get(id) ?? -1, qty * item.qty));
  if (hasSnapshot && markers.size > 0 && !confirmedLegacyPerPack
    && (markers.size !== snapshots.size
      || [...markers].some(([id, qty]) => !same(snapshots.get(id) ?? -1, qty)))) {
    warn('El detalle escrito y la composición guardada no coinciden. Se muestra la composición guardada.');
  }

  const componentsById = new Map(composition.components.map(component => [component.productId, component]));
  const resolved = new Map<number, number>();
  for (const component of composition.components) {
    const qty = selections.get(component.productId)
      ?? (component.mode === 'fixed' && component.required ? item.qty * component.quantity : null);
    if (qty == null) continue;
    if (!Number.isFinite(qty) || qty <= 0) {
      warn(`La cantidad de ${component.name} no es válida.`);
      continue;
    }
    resolved.set(component.productId, qty);
    if (component.isNested) warn('Este producto tiene una composición anidada que requiere revisión.');
    if (component.mode === 'fixed') {
      const expected = item.qty * component.quantity;
      if (component.required && !same(qty, expected)) {
        warn(`${component.name}: el pedido registra ${qty}, pero la composición fija indica ${expected}.`);
      } else if (!component.required && qty > expected + 0.000001) {
        warn(`${component.name}: la cantidad supera lo permitido para estas presentaciones.`);
      }
    }
  }
  for (const [id, qty] of selections) {
    if (!componentsById.has(id)) {
      resolved.set(id, qty);
      warn('Hay un componente que ya no coincide con el catálogo.');
    }
  }

  const countedUnits = [...resolved].reduce((sum, [id, qty]) =>
    sum + (componentsById.get(id)?.countsTowardLimit ? qty : 0), 0);
  if (composition.editable && composition.detailLimit > 0
    && !same(countedUnits, item.qty * composition.detailLimit)) {
    warn(`El desglose registra ${countedUnits} piezas; estas presentaciones requieren ${item.qty * composition.detailLimit}.`);
  }
  if (composition.editable && composition.detailLimit === 0 && countedUnits <= 0
    && composition.components.some(component => component.mode === 'selectable')) {
    warn('Falta la selección de piezas de este producto.');
  }
  if (!resolved.size) warn('No hay un desglose de cantidades confirmado.');

  // Keep instructions and aliases. Numeric instructions ("2 bolsas separadas")
  // are text, not additional pieces. Compare known product labels exactly.
  const noteLines: KitchenPresentationDetailLine[] = [];
  for (const line of baseDetailLines) {
    const matches = composition.components.filter(component =>
      component.name === line.label || snapshotNames.get(component.productId) === line.label);
    if (line.qty != null && matches.length === 1) {
      const id = matches[0].productId;
      const expectedTextQty = confirmedLegacyPerPack ? markers.get(id) : resolved.get(id);
      if (expectedTextQty == null || !same(line.qty, expectedTextQty)) {
        warn('El detalle escrito difiere de las cantidades confirmadas. Revisa el pedido con Máster.');
      }
    } else {
      noteLines.push({ label: line.qty == null ? line.label : `${line.qty} ${line.label}`, qty: null, qtyPerPresentation: null });
    }
  }

  const fixedIdentical = composition.components.length > 0
    && composition.components.every(component => component.mode === 'fixed')
    && [...resolved].every(([id, qty]) => same(qty, item.qty * (componentsById.get(id)?.quantity ?? -1)));
  const repeatsSameConfiguration = item.qty > 1 && Number.isInteger(item.qty)
    && warnings.size === 0 && (confirmedLegacyPerPack || fixedIdentical);
  const detailLines: KitchenPresentationDetailLine[] = [...resolved].map(([id, qty]) => ({
    label: snapshotNames.get(id) || componentsById.get(id)?.name || `Componente #${id}`,
    qty,
    qtyPerPresentation: repeatsSameConfiguration ? qty / item.qty : null,
  }));
  detailLines.push(...noteLines);
  const preparedUnits = [...resolved].reduce((sum, [id, qty]) => {
    const component = componentsById.get(id);
    // countsTowardLimit validates editable choices; fixed combos may set it
    // false for every component. It is not a prepared-pieces classification.
    return sum + (component && isKitchenPreparedLine(component.name) ? qty : 0);
  }, 0);

  return {
    detailLines,
    hasCountedDetails: detailLines.some((line) => line.qty != null),
    repeatsSameConfiguration,
    totalUnits: preparedUnits,
    preparedUnits,
    quantityWarning: warnings.size ? [...warnings].join(' ') : null,
    assemblyNote: item.qty > 1 && !repeatsSameConfiguration && warnings.size === 0
      ? 'Este es el total conjunto. El reparto por presentación no está registrado; confírmalo con Máster antes de armar.'
      : null,
  };
}
