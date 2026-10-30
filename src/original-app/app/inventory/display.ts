const mojibakeReplacements: ReadonlyArray<readonly [string, string]> = [
  ['\u00C3\u0192', '\u00C3'],
  ['\u00C3\u00A1', 'á'],
  ['\u00C3\u00A9', 'é'],
  ['\u00C3\u00AD', 'í'],
  ['\u00C3\u00B3', 'ó'],
  ['\u00C3\u00BA', 'ú'],
  ['\u00C3\u00B1', 'ñ'],
  ['\u00C3\u00BC', 'ü'],
  ['\u00C3\u0081', 'Á'],
  ['\u00C3\u0089', 'É'],
  ['\u00C3\u008D', 'Í'],
  ['\u00C3\u0093', 'Ó'],
  ['\u00C3\u009A', 'Ú'],
  ['\u00C3\u0091', 'Ñ'],
  ['\u00C3\u009C', 'Ü'],
  ['\u00C2\u00B7', '·'],
  ['\u00C2\u00A9', '©'],
  ['\u00C2\u00AD', '\u00AD'],
  ['\u00C2\u00B3', '³'],
  ['\u00C2\u00BA', 'º'],
  ['\u00C2\u00B1', '±'],
  ['\u00C2\u00BC', '¼'],
  ['\u00C2\u00BF', '¿'],
  ['\u00C2\u00A1', '¡'],
  ['\u00C2\u00B0', '°'],
  ['\u00C3\u0097', '×'],
  ['\u00E2\u20AC\u201D', '—'],
  ['\u00E2\u20AC\u00A6', '…'],
  ['\u00E2\u2030\u00A4', '≤'],
  ['\u00E2\u2020\u2019', '→'],
];

export function inventoryDisplayText(value: string | null | undefined, fallback = '') {
  let repaired = value ?? fallback;

  // Two passes recover chained substitutions, including common double encodings.
  for (let pass = 0; pass < 2; pass += 1) {
    const before = repaired;
    for (const [broken, correct] of mojibakeReplacements) {
      repaired = repaired.replaceAll(broken, correct);
    }
    if (repaired === before) break;
  }

  return repaired
    .replace(/\bpiezas\b/gi, (match) => match[0] === 'P' ? 'Unidades' : 'unidades')
    .replace(/\bpieza\b/gi, (match) => match[0] === 'P' ? 'Unidad' : 'unidad');
}

const unitAliases = new Set([
  'pieza',
  'piezas',
  'unidad',
  'unidades',
  'und',
  'unds',
  'ud',
  'uds',
]);

export function inventoryUnitLabel(value: string | null | undefined, fallback = 'UND') {
  const repaired = inventoryDisplayText(value, fallback).trim() || fallback;
  return unitAliases.has(repaired.toLocaleLowerCase('es')) ? 'UND' : repaired;
}

export function repairInventoryDisplayData<T>(value: T): T {
  if (typeof value === 'string') {
    return inventoryDisplayText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => repairInventoryDisplayData(entry)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        typeof entry === 'string' && (key === 'unit_name' || key.endsWith('_unit_name'))
          ? inventoryUnitLabel(entry)
          : repairInventoryDisplayData(entry),
      ]),
    ) as T;
  }
  return value;
}

export const inventoryKindLabels: Record<string, string> = {
  raw_material: 'Materia prima',
  prepared_base: 'Base preparada',
  finished_stock: 'Existencia terminada',
  packaging: 'Empaque o consumible',
};

export const inventoryGroupLabels: Record<string, string> = {
  raw: 'Crudos',
  fried: 'Fritos',
  prefried: 'Prefritos',
  sauces: 'Salsas y aderezos',
  packaging: 'Empaques y consumibles',
  other: 'Otros',
};

export const inventoryRoleLabels: Record<string, string> = {
  admin: 'Administración',
  master: 'Master',
  kitchen: 'Cocina',
  counter: 'Counter',
  advisor: 'Asesor',
  driver: 'Delivery',
};

export const productTypeLabels: Record<string, string> = {
  product: 'Producto',
  combo: 'Combo',
  service: 'Porción o servicio',
  promo: 'Promoción',
  gambit: 'Jugada',
};

export function displayLabel(labels: Record<string, string>, value: string | null | undefined) {
  if (!value) return 'No definido';
  return labels[value] ?? inventoryDisplayText(value);
}
