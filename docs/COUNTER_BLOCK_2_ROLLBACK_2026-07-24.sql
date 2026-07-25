-- Counter Block 2 rollback.
--
-- Use only before any Block 2 command is exposed to operators. This removes
-- Block 2 operational history. It intentionally keeps the safer empty
-- search_path and restricted grants on find_active_payment_duplicate().

begin;

drop function if exists public.counter_close_money_account(
  uuid,
  bigint,
  timestamptz,
  numeric,
  numeric,
  text,
  text
);

drop function if exists public.counter_complete_delivery_digital_change(
  uuid,
  bigint,
  jsonb,
  text
);

drop function if exists public.counter_record_delivery_return(
  uuid,
  bigint,
  jsonb,
  jsonb,
  boolean,
  text
);

drop function if exists public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
);

drop function if exists public.counter_execute_refund(
  uuid,
  uuid,
  date,
  text
);

drop function if exists public.counter_decide_authorization(
  uuid,
  uuid,
  text,
  text
);

drop function if exists public.counter_request_refund(
  uuid,
  bigint,
  jsonb,
  text
);

drop function if exists public.counter_record_manual_movement(
  uuid,
  public.movement_direction,
  bigint,
  numeric,
  date,
  numeric,
  text,
  text,
  text,
  text
);

drop function if exists public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
);

drop function if exists public.counter_refresh_delivery_settlement_status(
  bigint,
  uuid
);

drop function if exists public.counter_amount_usd(
  public.currency_code,
  numeric,
  numeric
);

drop function if exists public.counter_complete_command(
  bigint,
  jsonb
);

drop function if exists public.counter_claim_command(
  uuid,
  text,
  bigint,
  bigint,
  jsonb
);

drop index if exists public.money_movements_account_confirmed_at_idx;

drop table if exists public.delivery_settlement_entries;
drop table if exists public.delivery_settlements;
drop table if exists public.counter_command_receipts;

commit;
