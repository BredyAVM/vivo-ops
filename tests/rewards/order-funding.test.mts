import test from 'node:test';
import assert from 'node:assert/strict';
import {fundedOrderSnapshot,rewardCatalogSnapshot,rewardDraftAvailable,rewardFundingChanged} from '../../src/lib/rewards/order-funding.ts';
import type {RewardGrant} from '../../src/lib/rewards/wallet-model.ts';
test('order funding matches USD/VES SQL snapshots, zero gift, partial payment and frozen composition edits',()=>{
  const reward={grantId:1,title:'Prize',purpose:'customer_gift' as const,amountUsd:0.5,kind:'credit' as const};
  const base=rewardCatalogSnapshot('VES',850,1,850);
  assert.deepEqual(fundedOrderSnapshot(base,reward,1,850),{unitUsd:0.5,lineUsd:0.5,unitBs:425,lineBs:425});
  assert.deepEqual(fundedOrderSnapshot(rewardCatalogSnapshot('USD',4,2,850),{...reward,kind:'product_units'},2,850),{unitUsd:0,lineUsd:0,unitBs:0,lineBs:0});
  const frozen={unitUsd:1,lineUsd:2,unitBs:850,lineBs:1700};
  assert.deepEqual(fundedOrderSnapshot(base,{...reward,retainedSnapshot:frozen},2,900),frozen);
});
test('draft cannot spend the same credit twice and existing reservation is counted once',()=>{
  const grant={id:1,status:'active',expires_on:null,amount:20,reserved_amount:4,used_amount:6,kind:'credit'} as RewardGrant;
  const items=[{product_id:1,qty:1,reward:{grantId:1,title:'Prize',purpose:'customer_gift' as const,amountUsd:4,kind:'credit' as const}}];
  assert.equal(rewardDraftAvailable(grant,items),6);
  assert.equal(rewardDraftAvailable(grant,items,4),10);
});
test('adding, changing or removing a payer invalidates the former price-preservation path',()=>{
  const next={rewardGrantId:1,rewardPurpose:'customer_gift',rewardAmountUsd:1.5};
  const stored={reward_grant_id:'1',reward_purpose:'customer_gift',reward_amount_usd:'1.50'};
  assert.equal(rewardFundingChanged(next,{}),true);
  assert.equal(rewardFundingChanged(next,stored),false);
  assert.equal(rewardFundingChanged({},stored),true);
  assert.equal(rewardFundingChanged({...next,rewardGrantId:2},stored),true);
  assert.equal(rewardFundingChanged({...next,rewardPurpose:'personal_purchase'},stored),true);
  assert.equal(rewardFundingChanged({...next,rewardAmountUsd:0.75},stored),true);
  assert.equal(rewardFundingChanged({},{}),false);
});
