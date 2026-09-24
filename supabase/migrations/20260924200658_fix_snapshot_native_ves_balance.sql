-- Before/on delivery day, quote the native snapshot balance even when an
-- earlier payment used a different FX rate. Preserve certified USD coverage.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $patch$
declare
  v_definition text;
  v_old text := $old$    when canonical.total_precise_usd is not null
      and p_active_bs_rate=canonical.snapshot_rate_bs_per_usd
      then greatest(0,round(canonical.total_bs-canonical.precise_paid_usd*canonical.snapshot_rate_bs_per_usd,2))$old$;
  v_new text := $new$    -- Snapshot-day VES quotes use the native confirmed balance below.
    -- Only post-delivery collection may reuse certified USD coverage here.
    when canonical.total_precise_usd is not null
      and canonical.delivery_reference_date is not null
      and canonical.effective_operation_date > canonical.delivery_reference_date
      and p_active_bs_rate=canonical.snapshot_rate_bs_per_usd
      then greatest(0,round(canonical.total_bs-canonical.precise_paid_usd*canonical.snapshot_rate_bs_per_usd,2))$new$;
begin
  if (select md5(replace(prosrc,chr(13),'')) from pg_proc
      where oid='public.get_order_financial_state(bigint,date,numeric)'::regprocedure)
      <> 'a5b33452eb79e1c83e2cdcbf329c00b7' then
    raise exception 'Canonical financial function changed; review native VES patch before applying';
  end if;
  v_definition := replace(pg_get_functiondef(
    'public.get_order_financial_state(bigint,date,numeric)'::regprocedure),chr(13),'');
  if position(v_old in v_definition)=0 then
    raise exception 'Canonical native VES quote anchor missing';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$patch$;

-- No historical amounts, allocations, rates, grants or RLS policies are changed.
commit;
