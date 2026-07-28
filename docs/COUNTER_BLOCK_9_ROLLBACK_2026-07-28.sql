-- Counter Block 9 application rollback support.
--
-- The hardened existing RPCs are backward-compatible with the pre-Block 9
-- Counter client and intentionally remain in place: reverting their authority
-- checks would reopen defects fixed by this block. The legacy authorization
-- group repair changes no financial fact and also remains.

begin;

drop function if exists public.counter_read_cash_movements(
  bigint,
  timestamptz,
  bigint,
  integer
);

drop index if exists public.money_movements_counter_manual_expense_window_idx;

commit;
