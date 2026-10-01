# Closed-campaign authorized delivery: follow-up projection fix

## Incident and cause

Order 2988 was ready, paid, and had a valid administrator date exception. Production Postgres logs showed `CRM play members cannot change while the play is closed` at delivery attempts. The exception and minimum checks both passed.

The delivery trigger redeemed the reserved benefit under the benefit lifecycle context, restored that context, and inserted a `benefit_redeemed` event. That event's separate trigger updated six contact-funnel fields. The frozen-member guard rejected this second update for a closed campaign, rolling back the entire delivery. The previous isolated fixture missed both this event trigger and the member guard.

## Correction

Migration `20261001154928_crm_closed_play_delivery_funnel_fix.sql` is applied in production. It allows only the deterministic six-field follow-up projection under a narrowly scoped event context. It verifies nested trigger execution, a matching delivery event, a redeemed benefit, and a delivered order. Every other field remains immutable. The context is restored afterward. No campaign is reopened and no exception is granted by this migration.

The 2988 order, exception and reserved redemption were unchanged immediately after installation. It remains ready for the operator to deliver. No real delivery was executed during verification.

## Verification

The expanded PGlite test reproduces the exact production error before the patch and succeeds after it, with both real triggers installed. All 24 checks pass, including closed campaign delivery, preserved frozen values/costs, unchanged manual contact history, active campaign delivery, forged context rejection, absent exception rejection, and no double redemption.

Production read-only checks confirm both patched functions are installed, the exception remains valid, and application roles cannot directly execute the private funnel helper. The security advisor reported no finding naming either modified function.

## Previous publication status

The earlier exception screens and calendar-date correction were published successfully at commit `551706e` before this incident. Earlier documents describing them as pending reflect the state at their original writing, not their current status.
