import { getWhatsAppLineUnits } from '../orders/whatsapp-summary.ts';

const HIDDEN_DETAIL_PREFIX = '@sel|';

export type KitchenPresentationItem = {
  qty: number;
  name: string;
  notes: string | null;
  unitsPerService: number;
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
    .filter((line) => line && !line.startsWith(HIDDEN_DETAIL_PREFIX))
    .map((line) => {
      const match = line.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
      if (!match) return { label: line, qty: null };
      return {
        label: match[2].trim(),
        qty: floorKitchenPieces(toNumber(match[1].replace(',', '.'), 0)),
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
  const repeatsSameConfiguration =
    item.qty > 1
    && String(item.notes || '').split('\n').some((line) => line.trim().startsWith(HIDDEN_DETAIL_PREFIX));
  const detailMultiplier = repeatsSameConfiguration ? item.qty : 1;
  const detailLines = baseDetailLines.map((line) => ({
    label: line.label,
    qty: line.qty == null ? null : floorKitchenPieces(line.qty * detailMultiplier),
    qtyPerPresentation: repeatsSameConfiguration ? line.qty : null,
  }));
  const detailPreparedUnits = detailLines.reduce((sum, line) => {
    if (line.qty == null || !isKitchenPreparedLine(line.label)) return sum;
    return sum + line.qty;
  }, 0);

  return {
    detailLines,
    hasCountedDetails: detailLines.some((line) => line.qty != null),
    repeatsSameConfiguration,
    totalUnits: getKitchenItemUnits(item),
    preparedUnits: !isKitchenPreparedLine(item.name)
      ? 0
      : detailPreparedUnits > 0
        ? detailPreparedUnits
        : getKitchenItemUnits(item),
  };
}
