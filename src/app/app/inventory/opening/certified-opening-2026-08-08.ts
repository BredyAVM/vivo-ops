export type CertifiedOpeningLine = {
  inventoryItemId: number;
  inventoryItemName: string;
  countedQuantityUnits: number;
};

export const CERTIFIED_OPENING_LABEL = 'Conteo físico de cierre del 8 de agosto de 2026';

export const CERTIFIED_OPENING_LINES: readonly CertifiedOpeningLine[] = [
  { inventoryItemId: 1, inventoryItemName: 'Mini tequeño crudo', countedQuantityUnits: 1600 },
  { inventoryItemId: 2, inventoryItemName: 'Mini tequeño prefrito', countedQuantityUnits: 7 },
  { inventoryItemId: 3, inventoryItemName: 'Mayonesa', countedQuantityUnits: 4.125 },
  { inventoryItemId: 4, inventoryItemName: 'Menjurje', countedQuantityUnits: 7 },
  { inventoryItemId: 5, inventoryItemName: 'Mandocas Crudas', countedQuantityUnits: 425 },
  { inventoryItemId: 6, inventoryItemName: 'Empanadas Crudas', countedQuantityUnits: 750 },
  { inventoryItemId: 7, inventoryItemName: 'Salsa Tártara a granel', countedQuantityUnits: 0 },
  { inventoryItemId: 8, inventoryItemName: 'Salsa Tártara 5oz', countedQuantityUnits: 10 },
  { inventoryItemId: 9, inventoryItemName: 'Salsa Tártara 1oz', countedQuantityUnits: 10 },
  { inventoryItemId: 13, inventoryItemName: 'Cachitas Crudas', countedQuantityUnits: 450 },
  { inventoryItemId: 14, inventoryItemName: 'Empanadas Pre-Fritas', countedQuantityUnits: 8 },
  { inventoryItemId: 15, inventoryItemName: 'Cachitas Pre-Fritas', countedQuantityUnits: 10 },
  { inventoryItemId: 16, inventoryItemName: 'Mandocas Pre-Fritas', countedQuantityUnits: 3 },
  { inventoryItemId: 17, inventoryItemName: 'Bombys Pre-Fritos', countedQuantityUnits: 2 },
  { inventoryItemId: 18, inventoryItemName: 'Tequeños Regulares Pre-Fritos', countedQuantityUnits: 0 },
  { inventoryItemId: 19, inventoryItemName: 'Bombys Crudos', countedQuantityUnits: 525 },
  { inventoryItemId: 20, inventoryItemName: 'Tequeños Regulares Crudos', countedQuantityUnits: 18 },
  { inventoryItemId: 21, inventoryItemName: 'Salsa Tártara 2oz', countedQuantityUnits: 10 },
  { inventoryItemId: 22, inventoryItemName: 'Aderezo Mostaza Miel 2oz', countedQuantityUnits: 3 },
  { inventoryItemId: 23, inventoryItemName: 'Aderezo Mostaza Miel 5oz', countedQuantityUnits: 5 },
  { inventoryItemId: 26, inventoryItemName: 'Pepsi 1,5 Lts', countedQuantityUnits: 8 },
  { inventoryItemId: 27, inventoryItemName: 'Pepsi Lata', countedQuantityUnits: 29 },
  { inventoryItemId: 28, inventoryItemName: 'Pepsi 2 Lts', countedQuantityUnits: 4 },
  { inventoryItemId: 29, inventoryItemName: 'Pepsi 1 Lt', countedQuantityUnits: 9 },
  { inventoryItemId: 30, inventoryItemName: 'Malta Lata', countedQuantityUnits: 15 },
  { inventoryItemId: 31, inventoryItemName: 'Yukery Manzana 1,5 Lts', countedQuantityUnits: 9 },
  { inventoryItemId: 32, inventoryItemName: 'Yukery Naranja 1,5 Lts', countedQuantityUnits: 5 },
  { inventoryItemId: 33, inventoryItemName: 'Yukery Pera 1,5 Lts', countedQuantityUnits: 7 },
  { inventoryItemId: 34, inventoryItemName: 'Lipton Durazno 1,5 Lts', countedQuantityUnits: 5 },
  { inventoryItemId: 35, inventoryItemName: 'Lipton Limón 1,5 Lts', countedQuantityUnits: 4 },
  { inventoryItemId: 36, inventoryItemName: 'Coca-Cola 1,5 Lts', countedQuantityUnits: 20 },
  { inventoryItemId: 37, inventoryItemName: 'Coca-Cola 1 Lt', countedQuantityUnits: 0 },
  { inventoryItemId: 38, inventoryItemName: 'Coca-Cola 2 Lts', countedQuantityUnits: 16 },
  { inventoryItemId: 39, inventoryItemName: 'Coca-Cola Lata', countedQuantityUnits: 13 },
  { inventoryItemId: 40, inventoryItemName: 'Chinotto 1,5 Lts', countedQuantityUnits: 2 },
  { inventoryItemId: 41, inventoryItemName: 'Chinotto 2 Lts', countedQuantityUnits: 0 },
  { inventoryItemId: 42, inventoryItemName: 'Frescolita 1,5 Lts', countedQuantityUnits: 1 },
  { inventoryItemId: 43, inventoryItemName: 'Frescolita 2 Lts', countedQuantityUnits: 0 },
  { inventoryItemId: 44, inventoryItemName: 'Coca-Cola Sin Azúcar 1 Lt', countedQuantityUnits: 0 },
  { inventoryItemId: 45, inventoryItemName: 'Coca-Cola Sin Azúcar 2 Lts', countedQuantityUnits: 0 },
  { inventoryItemId: 46, inventoryItemName: 'Jugo del Valle 1,5 Lts', countedQuantityUnits: 0 },
  { inventoryItemId: 47, inventoryItemName: 'Dondys', countedQuantityUnits: 125 },
  { inventoryItemId: 68, inventoryItemName: 'Salsa Tártara Galón', countedQuantityUnits: 0 },
  { inventoryItemId: 76, inventoryItemName: 'Fanta Naranja 1,5 Lts', countedQuantityUnits: 6 },
  { inventoryItemId: 78, inventoryItemName: 'Aderezo Mostaza Miel a granel (envase 1 kg)', countedQuantityUnits: 0.25 },
  { inventoryItemId: 109, inventoryItemName: 'Yukipack Manzana', countedQuantityUnits: 14 },
  { inventoryItemId: 110, inventoryItemName: 'Yukipack Pera', countedQuantityUnits: 14 },
  { inventoryItemId: 111, inventoryItemName: 'Yukipack Durazno', countedQuantityUnits: 22 },
];

const certifiedLineByItemId = new Map(
  CERTIFIED_OPENING_LINES.map((line) => [line.inventoryItemId, line]),
);

export function certifiedOpeningQuantity(
  inventoryItemId: number,
  inventoryItemName: string,
) {
  const line = certifiedLineByItemId.get(inventoryItemId);
  if (!line || line.inventoryItemName !== inventoryItemName) return null;
  return line.countedQuantityUnits;
}

