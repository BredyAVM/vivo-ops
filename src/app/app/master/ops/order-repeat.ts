import type { MasterOpsEditClient, MasterOpsEditData, MasterOpsEditOrderItem } from './actions';
import { buildComponentDetailLines } from '@/lib/orders/order-composer';
import { persistableOrderDetailLines } from '@/lib/orders/order-detail-persistence';
import { calculateOrderLineSnapshot } from '@/lib/pricing/order-snapshots';

export type RepeatOrderSource = {
  id: number;
  source: string;
  attributedAdvisorUserId: string | null;
  client: MasterOpsEditClient | null;
  fulfillment: string;
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  items: { productId: number; productName: string; qty: number; notes: string | null }[];
};

/** A template is not a clone: only purchase choices cross into the new order. */
export function buildRepeatedMasterOpsOrder(defaults: MasterOpsEditData, source: RepeatOrderSource): MasterOpsEditData {
  const catalogById = new Map(defaults.catalogItems.map(product => [product.id, product]));
  const skippedItems: string[] = [];
  const items: MasterOpsEditOrderItem[] = [];
  for (const [index, previous] of source.items.entries()) {
    const product = catalogById.get(previous.productId);
    if (!product?.isActive || product.discretionaryAllowed === false || !Number.isFinite(previous.qty) || previous.qty <= 0) {
      skippedItems.push(previous.productName);
      continue;
    }
    const snapshot = calculateOrderLineSnapshot({
      sourceCurrency: product.sourcePriceCurrency, sourceAmount: product.sourcePriceAmount,
      quantity: previous.qty, fxRate: defaults.activeRate ?? 0, fallbackUnitUsd: product.basePriceUsd,
    });
    const previousDetails = persistableOrderDetailLines((previous.notes ?? '').split('\n'));
    items.push({
      orderItemId: null, localId: `repeat-${source.id}-${index}`, productId: product.id,
      productNameSnapshot: product.name, skuSnapshot: product.sku, qty: previous.qty,
      sourcePriceCurrency: product.sourcePriceCurrency, sourcePriceAmount: product.sourcePriceAmount,
      unitPriceUsdSnapshot: snapshot.unitUsd, lineTotalUsd: snapshot.lineUsd,
      unitPriceBsSnapshot: snapshot.unitBs, lineTotalBsSnapshot: snapshot.lineBs,
      pricingFxRateSnapshot: defaults.activeRate,
      // Custom choices must pass the normal current-composition validation before saving.
      editableDetailLines: product.isDetailEditable
        ? previousDetails
        : [
            ...previousDetails.filter(line => !line.startsWith('@sel|') && !/^\d+(?:\.\d+)?\s+/.test(line)),
            ...buildComponentDetailLines(defaults.productComponents
              .filter(component => component.parentProductId === product.id)
              .map(component => ({ ...component, quantity: component.quantity * previous.qty })),
              { includeMetadata: true }),
          ],
      adminPriceOverrideUsd: null, adminPriceOverrideCurrency: null, adminPriceOverrideReason: null,
      adminPriceOverrideByUserId: null, adminPriceOverrideAt: null,
    });
  }
  const advisor = defaults.advisors.find(row => row.id === source.attributedAdvisorUserId);
  return {
    ...defaults,
    repeatSummary: { sourceOrderId: source.id, skippedItems },
    order: {
      ...defaults.order,
      selectedClientId: source.client?.id ?? null, client: source.client,
      source: source.source === 'advisor' && advisor ? 'advisor' : source.source === 'walk_in' ? 'walk_in' : 'master',
      attributedAdvisorUserId: source.source === 'advisor' ? advisor?.id ?? null : null,
      fulfillment: source.fulfillment === 'delivery' ? 'delivery' : 'pickup',
      receiverName: source.receiverName, receiverPhone: source.receiverPhone,
      deliveryAddress: source.deliveryAddress, deliveryGpsUrl: source.deliveryGpsUrl,
      items,
    },
  };
}
