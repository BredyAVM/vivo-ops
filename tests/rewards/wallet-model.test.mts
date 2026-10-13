import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRewardDraft, allowedPurposes, rewardRestrictions, rewardAmountLabel, type RewardDraftInput } from '../../src/lib/rewards/wallet-model.ts';
const base: RewardDraftInput = {
  advisorId:'00000000-0000-0000-0000-000000000001',title:'Delivery prize',category:'alchemist',period:'2026-09',
  kind:'credit',mode:'commercial',purposes:['customer_gift'],amount:20,productId:null,productScope:'selected_products',
  allowedProductIds:[2],expiresOn:'2026-11-30',note:'',
};
test('restricted commercial credit does not permit debt or own consumption',()=>{
  assert.equal(validateRewardDraft(base),null);
  for(const purpose of ['advisor_debt','personal_purchase'] as const) assert.ok(validateRewardDraft({...base,purposes:[purpose]}));
  assert.deepEqual(allowedPurposes('commercial'),['customer_gift']);
  assert.ok(validateRewardDraft({...base,amount:20.001}));
  assert.ok(validateRewardDraft({...base,amount:NaN}));
  assert.ok(validateRewardDraft({...base,allowedProductIds:[2,2]}));
});
test('product units remain units, cannot pay debt and must match the sole product',()=>{
  const units:RewardDraftInput={...base,kind:'product_units',productId:3,amount:3,allowedProductIds:[3]};
  assert.equal(validateRewardDraft(units),null);
  assert.ok(validateRewardDraft({...units,amount:1.5}));
  assert.ok(validateRewardDraft({...units,allowedProductIds:[2]}));
  assert.ok(validateRewardDraft({...units,mode:'flexible',purposes:['advisor_debt']}));
  assert.equal(rewardAmountLabel({kind:'product_units',amount:3,product_name_snapshot:'Single Pack'}),'3 × Single Pack');
});
test('calendar dates, modes, and zero available privilege cannot be forged',()=>{
  assert.ok(validateRewardDraft({...base,expiresOn:'2026-02-31'}));
  assert.ok(validateRewardDraft({...base,period:'2026-13'}));
  assert.ok(validateRewardDraft({...base,purposes:[]}));
  assert.equal(validateRewardDraft({...base,mode:'flexible',purposes:['advisor_debt'],productScope:'all_products',allowedProductIds:[]}),null);
  const restrictions=rewardRestrictions({kind:'credit',purposes:['customer_gift'],product_scope:'selected_products',product_names_snapshot:['Delivery Zona 1']});
  assert.equal(restrictions.products,'Delivery Zona 1');
  assert.equal(restrictions.transferable,false);
  assert.equal(restrictions.redeemableForCash,false);
});
