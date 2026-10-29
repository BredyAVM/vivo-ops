# Master workspace read efficiency

Master's inventory navigation now streams inside the existing page/RSC response.
It reuses the authorized request context instead of requesting a separate Server
Action after each snapshot. Its Suspense boundary keeps optional inventory work
off the critical order-rendering path; upstream reads have a two-second deadline.
The navigation retains its last successful counters if a later read fails.
Admin keeps its existing inventory destination without the Master counter read.

Master derives daily order rows from weekly results only when exact counts prove
the response is complete. Each weekly result falls back independently to its
original daily query when truncated, missing a count or outside the selected
week. This also handles a PostgREST row cap lower than the requested limit.
The original 500-row daily and 900-row weekly limits, raw scheduled-date matching,
timestamp boundaries, canonical financial-state RPC and financial validation
remain in place. Admin retains its original four period reads.

The 120-second safety timer, hidden/offline behavior, push/manual refreshes,
post-operation reconciliation, kitchen dispatch confirmation and payment commands
are unchanged. No shared cache of financial data or schema migration is added.

## Validation and expected impact

`npm run test:master-read-efficiency` covers response completeness, lower API caps,
period boundaries, partial fallbacks, errors, role authorization, counter mapping,
nonblocking inventory rendering and retention of the last successful counter.
It compares the daily and weekly datasets with the original queries across
representative and capped inputs. Existing refresh, kitchen and payment tests
cover the operational boundaries.

An offline replay of the production SDK and loader with anonymized read shapes
preserved all previously displayed order/payment/KPI props across four dates.
In that replay one combined response made 14 external reads, including one auth
context, versus 18 reads across the old refresh and inventory action. When weekly
data is truncated, the original daily fallbacks intentionally reduce this saving.
The replay used synthetic financial states and did not execute live payments.

For one idle, visible, online Master view without an open detail/editor/inbox,
the normal timer model changes from 60 to 30 Vercel requests per hour and from
540 to 420 external reads. These are request-count reductions, not measured
reductions of billed CPU. Compare Active CPU and invocations in production under
equivalent activity after release; do not attribute changes in traffic or other
deployments to this code.
