-- Migration-history marker for a production-only data correction already applied.
-- No reusable schema changes. Customer/order details and amounts are intentionally
-- retained only in the local audit copy; new environments have no rows to repair.
select 1;
