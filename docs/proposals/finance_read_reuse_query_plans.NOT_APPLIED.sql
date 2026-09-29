-- NOT APPLIED. Retired from the migration queue on 2026-09-29.
-- The owner chose on-demand bounded-period collection reads instead.
-- Keep only as a future proposal; requires explicit approval before any use.
begin;
set transaction isolation level repeatable read;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- SQL functions with SET search_path cannot be inlined. In a multi-order read
-- they repeatedly prepare these complex statements. PL/pgSQL RETURN QUERY
-- retains the identical SELECT and can reuse its parameterized query plan.
-- No formulas, volatility, invoker rights, search path, signature or ACL change.
do $plans$
declare
  v_signature text;
  v_definition text;
  v_source text;
  v_language text;
  v_ids bigint[];
  v_before jsonb;
  v_after jsonb;
begin
  select array_agg(id) into v_ids from (
    (select id from public.orders order by id desc limit 30)
    union (select id from public.orders where id % 137=0 order by id limit 30)
    union (select order_id from public.client_fund_movements where order_id is not null order by id desc limit 10)
  ) sample;
  select jsonb_agg(to_jsonb(f) order by f.order_id) into v_before
  from unnest(v_ids) ids(id)
  cross join lateral public.get_order_financial_state(ids.id,current_date,null) f;

  foreach v_signature in array array[
    'public.get_order_financial_state_block3(bigint,date,numeric)',
    'public.get_order_financial_state(bigint,date,numeric)'
  ] loop
    select pg_get_functiondef(p.oid), p.prosrc, l.lanname
      into v_definition,v_source,v_language
    from pg_proc p join pg_language l on l.oid=p.prolang
    where p.oid=v_signature::regprocedure;
    if v_language='plpgsql' and strpos(v_source,'-- reused financial read plan')>0 then continue; end if;
    if v_language<>'sql' or strpos(v_source,'where r.order_id = p_order_id -- scoped payment evidence')=0
      or strpos(v_definition,'LANGUAGE sql')=0
      or strpos(v_definition,'SECURITY DEFINER')>0 then
      raise exception 'Unexpected financial definition: %',v_signature;
    end if;
    execute replace(replace(v_definition,'LANGUAGE sql','LANGUAGE plpgsql'),
      v_source,E'\n#variable_conflict use_column\n-- reused financial read plan\nbegin\nreturn query\n'||v_source||E'\nend;\n');
  end loop;

  select jsonb_agg(to_jsonb(f) order by f.order_id) into v_after
  from unnest(v_ids) ids(id)
  cross join lateral public.get_order_financial_state(ids.id,current_date,null) f;
  if v_before is distinct from v_after then
    raise exception 'Financial parity verification failed; rolling back query plan optimization';
  end if;
end;
$plans$;
commit;
