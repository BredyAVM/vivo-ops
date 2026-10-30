import { calculateOrderLineSnapshot, type OrderLineSnapshot } from '../pricing/order-snapshots.ts';
import { rewardGrantState, type RewardGrant, type RewardPurpose } from './wallet-model.ts';

export type RewardLineFunding = {
  grantId: number; title: string; purpose: Exclude<RewardPurpose,'advisor_debt'>; amountUsd: number;
  kind: RewardGrant['kind']; retainedSnapshot?: OrderLineSnapshot;
};

/** A different payer is a commercial change, even for the same product/quantity. */
export function rewardFundingChanged(
  next: { rewardGrantId?: number | null; rewardPurpose?: string | null; rewardAmountUsd?: number | null },
  previous?: { reward_grant_id?: number | string | null; reward_purpose?: string | null; reward_amount_usd?: number | string | null },
) {
  const numeric = (value: number | string | null | undefined) => value == null ? null : Number(value);
  return numeric(next.rewardGrantId) !== numeric(previous?.reward_grant_id)
    || (next.rewardPurpose ?? null) !== (previous?.reward_purpose ?? null)
    || numeric(next.rewardAmountUsd) !== numeric(previous?.reward_amount_usd);
}
const round=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
export function fundedOrderSnapshot(base: OrderLineSnapshot, funding: RewardLineFunding | undefined, quantity: number, fxRate: number): OrderLineSnapshot {
  if (!funding) return base;
  if (funding.retainedSnapshot) return funding.retainedSnapshot;
  const coverage=funding.kind==='product_units' ? base.lineUsd : Math.min(base.lineUsd,Math.max(0,funding.amountUsd));
  const lineUsd=round(base.lineUsd-coverage);
  const lineBs=coverage===base.lineUsd ? 0 : Math.max(0,round(base.lineBs-coverage*fxRate));
  return {...base,lineUsd,lineBs,unitUsd:quantity>0?round(lineUsd/quantity):0,unitBs:quantity>0?round(lineBs/quantity):0};
}
export function rewardFitsProduct(grant: RewardGrant, productId: number, purpose: RewardLineFunding['purpose']) {
  return grant.terms_snapshot.purposes.includes(purpose) && (grant.terms_snapshot.product_scope==='all_products'
    || grant.terms_snapshot.allowed_product_ids.includes(productId));
}
export function rewardDraftAvailable(grant: RewardGrant, items: {product_id:number;qty:number;reward?:RewardLineFunding}[], editingOrderReserved=0) {
  return Math.max(0,round(rewardGrantState(grant).validAmount+editingOrderReserved-items.reduce((sum,item)=>
    sum+(item.reward?.grantId===grant.id ? grant.kind==='product_units'?item.qty:item.reward.amountUsd : 0),0)));
}
export function rewardCatalogSnapshot(currency:'USD'|'VES', amount:number, qty:number, fxRate:number) {
  return calculateOrderLineSnapshot({sourceCurrency:currency,sourceAmount:amount,quantity:qty,fxRate});
}
