# Refresh CPU optimization

Kitchen, Master Ops and the advisor commission panel now coalesce background
refresh signals. A burst uses one fixed 280 ms window. Reads do not overlap;
events or completed mutations received during a read retain one follow-up read.
Timer checks skip a read already in flight instead of queueing another one.

Hidden or offline views retain their pending signals without requesting a server
render. Returning to the view flushes once. A network interruption always marks
the view dirty, so reconnecting reconciles even if no event arrived offline.
Realtime subscriptions and device notifications remain active.

## Freshness and payment behavior

- Kitchen keeps the existing event subscriptions, push/manual/action refreshes,
  60-second live repair interval, 20-second fallback and 5-second timer tick.
  These intervals are not extended to achieve savings.
- Master Ops keeps its 120-second safety check and its existing restrictions
  while a detail, editor or inbox is open. Push refreshes coalesce; post-action
  refreshes start immediately when idle or queue a follow-up behind an older read.
- Counter, payment commands, payment validation, idempotency, balances and server
  authorization are unchanged. No shared cache of financial data is introduced.
- The advisor's provisional commission display polls every five minutes instead
  of two, with manual refresh and refresh on return after two minutes. Its label
  shows the last update time. This display interval does not control payments.

## Validation and expected impact

`npm run test:refresh` exercises production hooks with simulated time, transport
events and browser lifecycle events, plus the coordinator's concurrency contract.
It covers bursts, events during a read, hidden/offline views, reconnects, cleanup,
Kitchen safety intervals and preservation of post-mutation refreshes. Existing
Kitchen and financial tests cover the operation and payment boundaries.

Release validation: all 120 targeted tests passed against production base
`5b97d0457fcc6c25aaf8d5211b87d81fe8a3d665`, including dispatch confirmation,
payment rate review and inline payment confirmation/void protections. The
production TypeScript configuration passed without errors. Production's Next.js
16.3.8 dependencies and build configuration are preserved.
An additional 18 isolated PostgreSQL test cases passed for rate protection,
atomic Admin confirmations, retry safety and Counter POS behavior. These tests
use an in-memory database and do not register live payments.

The Master Ops refresh integration is applied to
`src/components/orders/OrdersWorkspaceClient.tsx`, the current shared Master/Admin
workspace. The compatibility entry in `MasterOpsClient.tsx` is preserved, as are
the dispatch read-back logic and current agreed-rate payment review.

With a continuously visible, idle commission panel, automatic reads fall from
30 to 12 per hour (60% fewer). Kitchen and Master savings depend on event volume,
hidden tabs and previously overlapping reads; no total CPU reduction is assumed.

After deployment, compare Active CPU and invocation counts per route over similar
operating hours, device counts and order volume. Check new/changed orders on a
Kitchen device, a network interruption and recovery, and a normal payment through
the existing operational workflow. The current billing period's accumulated CPU
will not decrease when deploying this change.
