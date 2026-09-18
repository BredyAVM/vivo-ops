# Catalog gift association

## Scope

Dual-use Gambits (`catalog_access_scope=advisor_gift`) selected from the advisor's ordinary catalog resolve against the client's active membership and assigned advisor. Exact product IDs or explicitly configured campaign aliases determine a match; names do not.

- One available match opens the existing CRM composition/pricing flow for the same item.
- Multiple available matches require a choice.
- Reserved/redeemed-only matches cannot fall back to an extra discretionary gift.
- No match preserves discretionary use. `advisor_gift_only` and normal paid products are not auto-linked.
- Existing multi-benefit campaigns may add different benefits from the same membership. A duplicate benefit or another membership cannot silently replace an existing gift.

No gift is added until the advisor selects it and confirms any required composition. The existing lifecycle reserves on save, redeems on delivery, and releases on item removal or order cancellation.

## Server safety

The authenticated resolver scopes membership to `auth.uid()`. Alias rows are inaccessible to anonymous/authenticated table clients; only the private authorized resolver reads them. The public RPC is security-invoker, with a private security-definer implementation and fixed search path.

The insert trigger protects older clients. It uses existing selection, item validation, and redemption triggers. It only auto-links a unique, unconditional, zero-priced base gift. Conditional gifts, paid upgrades, ambiguity, quantity mismatch, or consumed benefits require the updated UI rather than silently changing a quote. Existing orders are not rewritten by this migration.

September's explicitly reviewed aliases cover Anniversary six-piece and Loyal six/eight/ten-piece catalog products. Future campaigns using a different gift SKU than the canonical benefit require an explicit alias; matching gift product IDs needs no alias. There is no alias editor in this release.

## Verification

Run `node --experimental-strip-types --test tests/crm/catalog-gift.test.mts tests/crm/play-order.test.mts tests/crm/gambit-application-contract.test.mts tests/crm/order-detail-persistence.test.mts`.

For isolated Postgres integration checks, install the pinned test runtime described at the top of `tests/crm/catalog-gift-db.mjs`, then run that file with Node. It loads the actual repository selection and lifecycle functions into an isolated PGlite database; it never connects to production.

Production migration: `20260918171721_crm_catalog_gift_auto_link.sql`. Post-migration checks confirmed four explicit aliases, enabled trigger, authenticated resolver access, no anonymous resolver access, and no authenticated alias-table writes. The security advisor's RLS-without-policy information for the internal alias table is intentional (deny all direct client access).
