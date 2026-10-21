import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RATE_REVIEW_MARKER, withRateReviewRequest } from '../../src/lib/payments/rate-review.ts';

test('review requests do not duplicate the marker or discard operator notes', () => {
  assert.equal(withRateReviewRequest('Banco verificado', true), `${RATE_REVIEW_MARKER}\nBanco verificado`);
  assert.equal(withRateReviewRequest(withRateReviewRequest('Nota', true), true), `${RATE_REVIEW_MARKER}\nNota`);
  assert.equal(withRateReviewRequest(`${RATE_REVIEW_MARKER}\nNota`, false), 'Nota');
});

test('review is lazy, session-authorized and cannot write the financial ledger from the client', () => {
  const component = readFileSync('src/components/orders/PaymentRateReview.tsx', 'utf8');
  assert.doesNotMatch(component, /useEffect|setInterval|\.from\(|service_role/);
  assert.match(component, /if \(busy.current\) return/);
  assert.match(component, /readPaymentRateReviewAction\(reportId\)/);
  assert.match(component, /aria-expanded/);
  assert.match(component, /min-h-11/);
  const actions=readFileSync('src/lib/payments/rate-review-actions.ts','utf8');
  assert.match(actions,/requireAdminContext\(\)/);
  assert.match(actions,/requireMasterOrAdminContext\(\)/);
  assert.doesNotMatch(actions,/\.insert\(|\.update\(|money_movements|service_role/);
});

test('all reporting screens can request review without giving operators the authority to approve it', () => {
  for(const file of ['src/app/app/counter/CounterPaymentEngine.tsx','src/components/orders/OrdersWorkspaceClient.tsx','src/app/app/advisor/orders/[id]/OrderDetailActions.tsx']) {
    const source=readFileSync(file,'utf8');assert.match(source,/withRateReviewRequest/);
    assert.doesNotMatch(source,/approve_payment_rate_review_v1/);
  }
  const ui=readFileSync('src/app/app/counter/CounterPaymentEngine.tsx','utf8');
  assert.match(ui,/no lo cargues de nuevo/);
  assert.match(ui,/suspectedBudgetPayment/);
});
