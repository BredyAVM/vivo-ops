import { readMenuStockSnapshot } from '../brands/inventory-menu.ts';
import { hasMenuOrderDetails, readMenuOrderQuote } from '../brands/order-menu.ts';
import type { KitchenItemPresentation, KitchenPresentationItem, KitchenPresentationDetailLine } from './order-presentation';

export function muerdemeKitchenPresentation(item: KitchenPresentationItem): KitchenItemPresentation | null {
  if (!hasMenuOrderDetails(item.notes)) return null;
  try {
    const quote = readMenuOrderQuote(item.notes);
    const snapshot = readMenuStockSnapshot(item.notes);
    if (!quote || !snapshot || snapshot.status !== 'ready' || snapshot.productId !== quote.productId
      || snapshot.entryId !== quote.selection.entryId || item.qty !== 1) throw new Error('Preparación no certificada.');
    const counts = { burger:0, fries:0, drink:0 };
    const detailLines: KitchenPresentationDetailLine[] = [];
    for (const unit of snapshot.kitchen) {
      counts[unit.kind] += unit.quantity;
      detailLines.push({ label: `${unit.slot ? unit.slot+': ' : ''}${unit.label}`, qty:unit.quantity, qtyPerPresentation:null });
      for (const removed of unit.removed) detailLines.push({ label:`Sin ${removed}`,qty:null,qtyPerPresentation:null });
      for (const extra of unit.extras) detailLines.push({ label:`Extra: ${extra}`,qty:null,qtyPerPresentation:null });
    }
    const preparationSummary = [counts.burger ? `${counts.burger} hamburguesa${counts.burger===1?'':'s'}` : '',
      counts.fries ? `${counts.fries} ${counts.fries===1?'porción':'porciones'} de papas` : '',counts.drink ? `${counts.drink} bebida${counts.drink===1?'':'s'}` : ''].filter(Boolean).join(' · ');
    return { brand:'muerdeme',preparationSummary,detailLines,hasCountedDetails:true,repeatsSameConfiguration:false,
      totalUnits:counts.burger+counts.fries+counts.drink,preparedUnits:counts.burger+counts.fries,quantityWarning:null,
      assemblyNote:'Cada hamburguesa conserva sus propios cambios. Los extras ya están incluidos en este desglose.' };
  } catch {
    // A missing receipt must never turn a two-burger combo into "one piece".
    return { brand:'muerdeme',preparationSummary:'Preparación por revisar',detailLines:[],hasCountedDetails:false,
      repeatsSameConfiguration:false,totalUnits:item.qty,preparedUnits:0,
      quantityWarning:'No se pudo verificar la preparación de Muérdeme. Solicita revisión a Máster.',assemblyNote:null };
  }
}
