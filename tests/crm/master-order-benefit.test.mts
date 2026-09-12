import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCrmOrderBenefit, validateMasterCrmBenefitSelection } from '../../src/lib/crm/master-order-benefit.ts';
import type { MasterCrmOrderContext } from '../../src/lib/crm/advisor-order-context-types.ts';

const context: MasterCrmOrderContext = {
  playMemberId: 10, playName: 'Loyal', advisorUserId: 'advisor-a',
  benefitSelectionMode: 'single', selectedPlayBenefitIds: [], purchaseRequirementMode: 'none', minimumOrderAmountUsd: null,
  client: { id: 20, full_name: 'Cliente de prueba', phone: null, client_type: 'legacy' },
  benefits: [{ playBenefitId: 30, productId: 60, quantity: 1, creditUsd: 4, name: 'Pack 6', sku: null,
    upgrades: [{ id: 40, productId: 80, quantity: 1, customerDifferenceUsd: 2, name: 'Pack 8', sku: null }] }],
};
const gift = () => resolveCrmOrderBenefit(context, 30);
const input = () => ({ context, clientId: 20, advisorUserId: 'advisor-a', commercialSubtotalUsd: 0, items: [gift()] });

test('normal catalog product receives the play price and stable links only when selected', () => {
  assert.deepEqual(gift(), {
    crmPlayMemberId: 10, crmPlayBenefitId: 30, crmPlayBenefitUpgradeId: null,
    productId: 60, qty: 1, sourcePriceCurrency: 'USD', sourcePriceAmount: 0,
    unitPriceUsdSnapshot: 0, lineTotalUsd: 0, crmPlayName: 'Loyal',
  });
  assert.doesNotThrow(() => validateMasterCrmBenefitSelection(input()));
});
test('upgrade charges precisely the configured difference without changing the gift credit', () => {
  const choice = resolveCrmOrderBenefit(context, 30, 40);
  assert.equal(choice.productId, 80);
  assert.equal(choice.lineTotalUsd, 2);
  assert.equal(choice.crmPlayBenefitUpgradeId, 40);
  assert.equal(context.benefits[0].creditUsd, 4);
  assert.doesNotThrow(() => validateMasterCrmBenefitSelection({ ...input(), items: [choice] }));
});
test('privileged operator still needs the same client and responsible advisor', () => {
  assert.throws(() => validateMasterCrmBenefitSelection({ ...input(), clientId: 99 }), /mismo cliente/);
  assert.throws(() => validateMasterCrmBenefitSelection({ ...input(), advisorUserId: 'other' }), /mismo cliente/);
  assert.throws(() => validateMasterCrmBenefitSelection({ ...input(), advisorUserId: null }), /mismo cliente/);
});
test('minimum purchase is checked against commercial products, not the upgrade difference', () => {
  const minimum = { ...context, purchaseRequirementMode: 'minimum_order' as const, minimumOrderAmountUsd: 10 };
  assert.throws(() => validateMasterCrmBenefitSelection({ ...input(), context: minimum, commercialSubtotalUsd: 8, items: [resolveCrmOrderBenefit(context, 30, 40)] }), /compra mínima/);
  assert.doesNotThrow(() => validateMasterCrmBenefitSelection({ ...input(), context: minimum, commercialSubtotalUsd: 10 }));
});
test('single-benefit play cannot apply the gift and upgrade together', () => {
  assert.throws(() => validateMasterCrmBenefitSelection({ ...input(), items: [gift(), resolveCrmOrderBenefit(context, 30, 40)] }), /solo beneficio/);
});
test('multiple selection accepts distinct benefits and rejects repeated benefits', () => {
  const multiple = { ...context, benefitSelectionMode: 'multiple' as const,
    benefits: [...context.benefits, { ...context.benefits[0], playBenefitId: 31, productId: 61, upgrades: [] }] };
  assert.doesNotThrow(() => validateMasterCrmBenefitSelection({ ...input(), context: multiple, items: [gift(), resolveCrmOrderBenefit(multiple, 31)] }));
  assert.throws(() => validateMasterCrmBenefitSelection({ ...input(), context: multiple, items: [gift(), gift()] }), /duplicado/);
});
test('forged benefit, upgrade, quantity, product or membership is rejected', () => {
  assert.throws(() => resolveCrmOrderBenefit(context, 99), /no pertenece/);
  assert.throws(() => resolveCrmOrderBenefit(context, 30, 99), /no pertenece/);
  for (const patch of [{ qty: 2 }, { qty: NaN }, { productId: 99 }, { crmPlayMemberId: 99 }]) {
    assert.throws(() => validateMasterCrmBenefitSelection({ ...input(), items: [{ ...gift(), ...patch }] }));
  }
});
