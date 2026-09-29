-- Explicitly authorized by the owner on 2026-09-29.
-- Read-only financial parity check before committing the definition change.
begin;
set transaction isolation level repeatable read;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The shared CTE is materialized when used several times. Without this predicate
-- it scans every payment report for each order in a multi-order collections read.
-- Every consumer already restricts order_id to this exact argument; move that
-- same predicate to the input. Do not change any financial formulas or grants.
do $scope$
declare
  v_signature text;
  v_definition text;
  v_anchor text := E'    and r.status=''confirmed'' and m.status=''confirmed''\n),';
  v_ids bigint[];
  v_before jsonb;
  v_after jsonb;
begin
  select array_agg(id) into v_ids from (
    (select id from public.orders order by id desc limit 30)
    union
    (select id from public.orders where id % 137 = 0 order by id limit 30)
  ) samples;
  select jsonb_agg(to_jsonb(f) order by f.order_id) into v_before
  from unnest(v_ids) ids(id)
  cross join lateral public.get_order_financial_state(ids.id,current_date,null) f;
  foreach v_signature in array array[
    'public.get_order_financial_state_block3(bigint,date,numeric)',
    'public.get_order_financial_state(bigint,date,numeric)'
  ] loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    if strpos(v_definition, E'where r.order_id = p_order_id -- scoped payment evidence') > 0 then continue; end if;
    if (length(v_definition)-length(replace(v_definition,v_anchor,''))) <> length(v_anchor) then
      raise exception 'Financial function changed; inspect before narrowing evidence: %',v_signature;
    end if;
    execute replace(v_definition,v_anchor,
      E'    and r.status=''confirmed'' and m.status=''confirmed''\n  where r.order_id = p_order_id -- scoped payment evidence\n),');
  end loop;
  select jsonb_agg(to_jsonb(f) order by f.order_id) into v_after
  from unnest(v_ids) ids(id)
  cross join lateral public.get_order_financial_state(ids.id,current_date,null) f;
  if v_before is distinct from v_after then
    raise exception 'Financial parity verification failed; rolling back optimization';
  end if;
end;
$scope$;
commit;
