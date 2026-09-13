# Administrative USD override persistence

## Cause

The transactional order editor rebuilds ordinary `order_items` and then derives
the order header from the persisted lines. The final BEFORE pricing trigger,
`trg_order_items_set_pricing`, replaced each inserted USD unit snapshot with the
catalog price, while leaving the editor's Bs snapshot intact. Its legacy
`override_unit_price_usd` path did not recognize the editor's newer
`admin_price_override_usd` field. This produced inconsistent USD/Bs totals.

This interaction is separate from account reconciliation. The old trigger was
already present before the reconciliation change; the atomic editor made its
persisted USD result authoritative for the order total.

## Bounded correction

Migration `20260913144132_admin_usd_order_override_snapshot_fix.sql` makes the
final trigger honor an explicit administrative USD override after the legacy
catalog assignment, on both INSERT and UPDATE. It checks the current actor's
Admin role, requires a finite nonnegative amount and an adjustment reason,
stamps the actor, and rounds the effective line total to cents. Zero is valid.

The editor's Bs snapshots are retained: during an atomic edit the parent header
can still hold the previous FX. Deriving Bs from that old rate would introduce
a second inconsistency. CRM, counter sales, native VES pricing and legacy
override precedence keep their existing paths. No new roles, grants or definer
functions were added. The trigger retains its empty search path.

The migration does not recalculate historical orders or alter catalog prices,
payments, stock, rates or customer balances. An affected active order must be
opened and saved again by Admin through the normal editor using the intended
prices. Delivered/protected orders retain their existing restrictions; do not
apply a blanket historical backfill.

## Verification

- The synthetic SQL test failed against the old trigger on its first USD-total
  assertion, reproducing the regression without changing a real order.
- The migration and the self-cleaning SQL test were applied in one transaction;
  test assertions had to pass before the new function could commit. All fixture
  writes were rolled back by a dedicated subtransaction, including successful
  cases. The fixture is `tests/admin/order-usd-override.rollback.sql`.
- Verified atomic save and resave, changed FX, discount, tax, zero and upward
  overrides, invalid-adjustment rollback, advisor denial, ordinary catalog
  pricing, legacy overrides and counter VES line rounding.
- The existing CRM rollback integration test passed for Master/Admin, all three
  order origins, gift/upgrade pricing and advisor ownership boundaries.
- No fixture orders, stock movements or customer-fund movements persisted.
- Node tests: 9 pricing, 4 atomic advisor creation, 26 order-details, 119 Admin
  and 6 security tests passed (164 total).
- Supabase security advisor findings were unchanged before/after; this is not
  a claim that all pre-existing security findings have been resolved.

Run the local regression suite with `npm run test:order-pricing`. The SQL fixture
is self-cleaning and can additionally be enclosed in `BEGIN ... ROLLBACK`.

## Separate follow-up

Consolidating all legacy/native-VES pricing paths and improving the original-price
delta recorded by administrative audit payloads remain separate work. This
incident fix is specifically the loss of an authorized USD override on save.
