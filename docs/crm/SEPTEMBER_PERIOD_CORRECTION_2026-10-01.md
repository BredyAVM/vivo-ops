# September campaign period correction

User requested every September campaign end on September 30, 2026, with none active in October.

## Production result

All dates below use America/Caracas; closing time is 23:59:59.999.

| Campaign | Previous end | Corrected end | Final status |
| --- | --- | --- | --- |
| Aniversario | October 1 | September 30 | closed |
| Loyal | October 4 | September 30 | closed |
| NC | September 30 | unchanged | closed (unchanged) |
| LC | October 1 | September 30 | closed |

Migration `20261001152150_crm_september_period_correction.sql` was applied in production. Three corrections were recorded in private audit storage. Final active campaign count: zero. No orders, redemption records, costs or individual exceptions were changed. Unused benefits of the three closed campaigns were expired normally; redeemed benefits were preserved.

The repair locked campaign writes, matched the exact audited business identities and previous dates, temporarily relaxed only the immutable end-date check inside its transaction, and restored the original guard before completing. Original guard and redemption fingerprints were identical before and after:

- Guard: `edc49ea6d318defb6958835ad60f4eb9`
- Redemptions: `08c524bf6998e894c2060187bb0c7ddc`

## Prevention and verification

The draft editor previously extracted the date directly from UTC timestamps. September 30 at the end of the Venezuela day is October 1 in UTC, so reopening and saving a draft could advance the end date. The local editor now formats dates explicitly in America/Caracas. Repeated save/reopen tests preserve the same business date.

Four date unit tests and the TypeScript check passed. An isolated database test verifies the three audited repairs, unchanged NC and delivered benefits, restored immutable guard, stale-audit rejection, and restricted audit access.

The security advisor reports RLS without policies on the new private audit table. This is intentional: no application role should directly read or write this maintenance evidence; privileges are revoked as well.

The production data correction is complete. The frontend date prevention fix and previously developed exception screens are local and await authorized publication; they must not be described as deployed.
