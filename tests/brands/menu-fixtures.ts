import { newMenuDocument, type MenuDocument, type MenuKind } from '../../src/lib/brands/menu-model.ts';
export function menuDocument(kind: MenuKind, name: string, price: number | null = 5): MenuDocument {
  const doc = newMenuDocument(kind); doc.name = name; doc.variants[0].priceUsd = price;
  if (doc.variants[0].burger) doc.variants[0].burger.ingredients = [
    { key: 'sauce', label: 'Salsa', removable: true }, { key: 'pickle', label: 'Pepinillos', removable: true },
  ];
  return doc;
}
