-- Applied version matches the Supabase migration history.
-- The payment's Caracas operation date, not reporting/confirmation time, owns FX.
-- No historical DML. Existing pending reports are resolved only on confirmation.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function app_private.payment_operation_day_rates_v1(p_date date)
returns table(rate numeric) language sql stable security invoker set search_path='' as $$
  with opening as (
    select e.rate_bs_per_usd from public.exchange_rates e
    where e.effective_at <= (p_date::timestamp at time zone 'America/Caracas')
    order by e.effective_at desc,e.id desc limit 1
  )
  select rate_bs_per_usd from opening
  union
  select e.rate_bs_per_usd from public.exchange_rates e
  where e.effective_at > (p_date::timestamp at time zone 'America/Caracas')
    and e.effective_at < ((p_date+1)::timestamp at time zone 'America/Caracas')
    and e.effective_at <= statement_timestamp();
$$;
revoke all on function app_private.payment_operation_day_rates_v1(date) from public,anon,authenticated,service_role;

create function app_private.payment_day_coverage_quote_v1(p_order bigint,p_date date,p_amount numeric,p_rate numeric)
returns table(rate numeric,pending_usd numeric,pending_bs numeric)
language sql stable security invoker set search_path='' as $$
  select d.rate,s.pending_usd,s.pending_bs
  from app_private.payment_operation_day_rates_v1(p_date) d
  cross join lateral public.get_order_financial_state(p_order,p_date,d.rate) s
  where s.pending_usd>0
  order by (s.pending_bs=p_amount) desc,(d.rate=p_rate) desc,d.rate desc limit 1;
$$;
revoke all on function app_private.payment_day_coverage_quote_v1(bigint,date,numeric,numeric) from public,anon,authenticated,service_role;

-- Certifies coverage separately from native money. Partial payments use their
-- selected daily rate; only an exact full pending quote can identify another
-- daily rate automatically. Never borrow a rate from another day/budget.
create function app_private.prepare_payment_day_coverage_v1(p_report bigint,p_date date,p_amount numeric,p_rate numeric)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.payment_reports%rowtype; s record; chosen numeric;
  e app_private.payment_rate_reviews_v1%rowtype; direct_pos boolean; valid_rate boolean;
begin
  select * into r from public.payment_reports where id=p_report;
  if not found or r.status::text<>'pending' or r.reported_currency_code::text<>'VES'
    or r.event_payment_id is not null or p_amount is distinct from r.reported_amount
    or p_rate is distinct from r.reported_exchange_rate_ves_per_usd
    or p_date is distinct from coalesce(r.operation_date,(r.created_at at time zone 'America/Caracas')::date)
    or not app_private.order_uses_current_usd_v1(r.order_id) then return false; end if;
  perform 1 from public.orders where id=r.order_id for update;
  select * into e from app_private.payment_rate_reviews_v1 where report_id=p_report for update;
  if e.consumed_movement_id is not null or (e.approved_at is not null and e.source not in ('operation_day_rate','pos_receipt')) then return false; end if;
  select exists(select 1 from app_private.payment_operation_day_rates_v1(p_date) d where d.rate=p_rate) into valid_rate;
  select exists(select 1 from public.money_accounts a where a.id=r.reported_money_account_id
    and a.account_kind::text='pos' and position('Metodo: pos' in coalesce(r.notes,''))>0) into direct_pos;
  if not valid_rate and not direct_pos then return false; end if;
  select * into s from public.get_order_financial_state(r.order_id,p_date,p_rate);
  if not found or s.pending_usd<=0 or not exists(select 1 from public.order_collection_precision_basis_v1(r.order_id)) then return false; end if;
  chosen:=p_rate;
  if valid_rate then
    select q.rate into chosen from app_private.payment_day_coverage_quote_v1(r.order_id,p_date,p_amount,p_rate) q;
    chosen:=coalesce(chosen,p_rate);
  end if;
  select * into s from public.get_order_financial_state(r.order_id,p_date,chosen);
  insert into app_private.payment_rate_reviews_v1(report_id,order_id,pricing_hash,baseline_pending_usd,
    quoted_pending_usd,quoted_pending_bs,quoted_rate,source,reported_amount,reported_rate,
    decision,coverage_rate,coverage_pending_usd,coverage_pending_bs,approved_by,approved_at,reason)
  values(r.id,r.order_id,app_private.payment_quote_pricing_hash_v1(r.order_id),s.pending_usd,
    s.pending_usd,s.pending_bs,chosen,case when valid_rate then 'operation_day_rate' else 'pos_receipt' end,p_amount,p_rate,
    case when chosen=p_rate then 'reported' else 'quoted' end,chosen,s.pending_usd,s.pending_bs,
    auth.uid(),statement_timestamp(),case when valid_rate then 'Tasa vigente en la fecha real del pago. Aplicación de norma diaria; no requiere excepción.'
      else 'Recepción por punto: se registra el dinero real a la tasa reportada, sin aprobar un presupuesto de otro día.' end)
  on conflict(report_id) do update set pricing_hash=excluded.pricing_hash,baseline_pending_usd=excluded.baseline_pending_usd,
    source=excluded.source,decision=excluded.decision,coverage_rate=excluded.coverage_rate,
    coverage_pending_usd=excluded.coverage_pending_usd,coverage_pending_bs=excluded.coverage_pending_bs,
    approved_by=excluded.approved_by,approved_at=excluded.approved_at,reason=excluded.reason;
  return true;
end $$;
revoke all on function app_private.prepare_payment_day_coverage_v1(bigint,date,numeric,numeric) from public,anon,authenticated,service_role;

do $patch$
declare d text; a text;
begin
  d:=pg_get_functiondef('app_private.capture_payment_rate_review_v1()'::regprocedure);
  a:=' select * into o from public.orders where id=new.order_id for update;';
  if position(a in d)=0 then raise exception 'Rate capture changed'; end if;
  d:=replace(d,a,$i$ if app_private.prepare_payment_day_coverage_v1(new.id,
    coalesce(new.operation_date,(new.created_at at time zone 'America/Caracas')::date),
    new.reported_amount,new.reported_exchange_rate_ves_per_usd) then return new; end if;
$i$||a);
  execute d;
  d:=pg_get_functiondef('app_private.guard_payment_rate_review_v1()'::regprocedure);
  a:=' select * into e from app_private.payment_rate_reviews_v1 where report_id=new.payment_report_id for update;';
  if position(a in d)=0 then raise exception 'Rate guard changed'; end if;
  d:=replace(d,a,$i$ perform app_private.prepare_payment_day_coverage_v1(new.payment_report_id,new.movement_date,
    new.amount,new.exchange_rate_ves_per_usd);
$i$||a);
  -- An intra-day rate is valid even if the order/quote itself was recorded later.
  d:=replace(d,$a$if e.decision='quoted' and ($a$,$b$if e.decision='quoted' and e.source<>'operation_day_rate' and ($b$);
  execute d;
  d:=pg_get_functiondef('public.counter_apply_order_payments_block2(uuid,bigint,jsonb,text,jsonb,text)'::regprocedure);
  a:='select 1 from app_private.payment_rate_reviews_v1 where report_id=v_report_id);';
  if position(a in d)=0 then raise exception 'Counter rate boundary changed'; end if;
  execute replace(d,a,'select 1 from app_private.payment_rate_reviews_v1 where report_id=v_report_id and approved_at is null);');
  -- A read is still read-only: pending reports from before this migration show
  -- their daily coverage preview, but are not approved/posted just by opening.
  d:=pg_get_functiondef('app_private.read_payment_rate_review_v1(bigint)'::regprocedure);
  d:=replace(d,'declare e app_private.payment_rate_reviews_v1%rowtype;',
    'declare r public.payment_reports%rowtype; daily_quote record; pd date; e app_private.payment_rate_reviews_v1%rowtype;');
  a:=' if not found then return jsonb_build_object(''available'',false); end if;';
  if position(a in d)=0 then raise exception 'Rate review read changed'; end if;
  d:=replace(d,a,a||$i$
 if e.approved_at is null and e.consumed_movement_id is null then
   select * into r from public.payment_reports where id=p_report_id;
   pd:=coalesce(r.operation_date,(r.created_at at time zone 'America/Caracas')::date);
   if r.status::text='pending' and app_private.order_uses_current_usd_v1(r.order_id)
     and exists(select 1 from app_private.payment_operation_day_rates_v1(pd) d where d.rate=r.reported_exchange_rate_ves_per_usd) then
     select * into daily_quote from app_private.payment_day_coverage_quote_v1(r.order_id,pd,r.reported_amount,r.reported_exchange_rate_ves_per_usd);
     if found then return jsonb_build_object('available',true,'canApprove',false,'reportId',r.id,'orderId',r.order_id,
       'amountBs',r.reported_amount,'recordedRate',r.reported_exchange_rate_ves_per_usd,
       'quoteRate',daily_quote.rate,'quoteUsd',daily_quote.pending_usd,'quoteBs',daily_quote.pending_bs,'source','operation_day_rate',
       'decision',case when daily_quote.rate=r.reported_exchange_rate_ves_per_usd then 'reported' else 'quoted' end,'applied',false); end if;
   end if;
 end if;
$i$);
  d:=replace(d,$a$case when e.decision='quoted' then$a$,$b$case when e.decision='quoted' or e.source in ('operation_day_rate','pos_receipt') then$b$);
  execute d;
end $patch$;

-- Reuse the existing small quote endpoint; no additional initial query.
create function app_private.counter_read_payment_quote_at_rate_v1(p_order_id bigint,p_operation_date date,p_rate numeric)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d date:=coalesce(p_operation_date,(now() at time zone 'America/Caracas')::date); r numeric; s record; rates jsonb;
begin
  if auth.uid() is null or not(public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'No autorizado.' using errcode='42501'; end if;
  if d>(now() at time zone 'America/Caracas')::date then raise exception 'La fecha del pago no puede ser futura.'; end if;
  if not exists(select 1 from public.orders where id=p_order_id) then raise exception 'No se encontró la orden.'; end if;
  select jsonb_agg(rate order by rate desc) into rates from app_private.payment_operation_day_rates_v1(d);
  select e.rate_bs_per_usd into r from public.exchange_rates e
    where e.effective_at < ((d+1)::timestamp at time zone 'America/Caracas') and e.effective_at<=statement_timestamp()
    order by e.effective_at desc,e.id desc limit 1;
  if p_rate is not null then
    if not exists(select 1 from app_private.payment_operation_day_rates_v1(d) x where x.rate=p_rate) then
      raise exception 'Selecciona una tasa que estuvo vigente el día del pago.'; end if;
    r:=p_rate;
  end if;
  select * into s from public.get_order_financial_state(p_order_id,d,r);
  if s.collection_mode in ('native_usd','post_delivery_usd') and coalesce(r,0)<=0 then raise exception 'No hay tasa registrada para el día del pago.'; end if;
  return jsonb_build_object('operationDate',d,'pendingUsd',s.pending_usd,'pendingBs',s.pending_bs,'exchangeRate',coalesce(r,0),
    'snapshotRate',s.snapshot_rate_bs_per_usd,'collectionMode',s.collection_mode,'dayRates',coalesce(rates,'[]'::jsonb));
end $$;
revoke all on function app_private.counter_read_payment_quote_at_rate_v1(bigint,date,numeric) from public,anon,service_role;
grant execute on function app_private.counter_read_payment_quote_at_rate_v1(bigint,date,numeric) to authenticated;
create function public.counter_read_payment_quote_at_rate_v1(p_order_id bigint,p_operation_date date,p_rate numeric default null)
returns jsonb language sql stable security invoker set search_path='' as $$
  select app_private.counter_read_payment_quote_at_rate_v1(p_order_id,p_operation_date,p_rate);
$$;
revoke all on function public.counter_read_payment_quote_at_rate_v1(bigint,date,numeric) from public,anon,service_role;
grant execute on function public.counter_read_payment_quote_at_rate_v1(bigint,date,numeric) to authenticated;
create or replace function public.counter_read_payment_quote(p_order_id bigint,p_operation_date date default null)
returns jsonb language sql stable security invoker set search_path='' as $$
  select app_private.counter_read_payment_quote_at_rate_v1(p_order_id,p_operation_date,null);
$$;
notify pgrst,'reload schema';
commit;
