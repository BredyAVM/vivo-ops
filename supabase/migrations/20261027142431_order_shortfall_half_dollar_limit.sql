-- Administration may waive up to USD 0.50 without repricing the sale.
-- Only the authorization ceiling changes; no historical row is updated.
-- Filename matches the version assigned by the production migration registry.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $patch$
declare d text;
begin
  if (select md5(prosrc) from pg_proc where oid='app_private.close_order_balance_difference_v1(uuid,bigint,numeric,text)'::regprocedure)
    is distinct from 'f9a3f2659c66e58632085685867262c4' then
    raise exception 'Balance adjustment implementation changed; review before changing its limit.';
  end if;
  d:=pg_get_functiondef('app_private.close_order_balance_difference_v1(uuid,bigint,numeric,text)'::regprocedure);
  if strpos(d,'p_expected_usd>0.09')=0 or strpos(d,'v_state.pending_usd>0.09')=0
    or strpos(d,'El límite autorizado sigue siendo USD 0,09.')=0 then
    raise exception 'Expected shortfall ceiling not found.';
  end if;
  d:=replace(d,'p_expected_usd>0.09','p_expected_usd>0.50');
  d:=replace(d,'v_state.pending_usd>0.09','v_state.pending_usd>0.50');
  d:=replace(d,'El límite autorizado sigue siendo USD 0,09.','El límite autorizado es USD 0,50.');
  execute d;
end $patch$;
commit;
