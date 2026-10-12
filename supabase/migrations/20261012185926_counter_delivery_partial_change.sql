begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Preserve the existing dispatch chain, permissions, idempotency and cash ledger.
-- Expected collection is custody, not a payment. Change need not settle the order.
do $migration$
declare
  v_target regprocedure := 'public.counter_dispatch_delivery_block6_v1(uuid,bigint,integer,jsonb,jsonb,jsonb,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  if abs(v_allocated_change_usd - v_required_change_usd) > 0.02 then
    raise exception
      'Delivery change allocation must equal the expected collection minus the current order balance';
  end if;$old$;
  v_new text := $new$  if v_allocated_change_usd > v_expected_usd + 0.009 then
    raise exception
      'El cambio no puede superar todo el efectivo que recibira el motorizado';
  end if;$new$;
begin
  v_definition := pg_get_functiondef(v_target);
  if (length(v_definition) - length(replace(v_definition, v_old, ''))) <> length(v_old) then
    raise exception 'Unexpected delivery dispatch definition: partial-change migration stopped';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$migration$;
commit;
