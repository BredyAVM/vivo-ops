-- Additive, future-only evidence. No historical payments/allocations are updated
-- and get_order_financial_state / native_usd pricing rules are not replaced.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table app_private.order_payment_quotes_v1 (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id),
  pricing_hash text not null,
  pending_usd numeric not null check(pending_usd>0),
  pending_bs numeric not null check(pending_bs>0),
  rate numeric not null check(rate>0),
  operation_date date not null,
  collection_mode text not null,
  created_at timestamptz not null default statement_timestamp(),
  created_by uuid not null references auth.users(id),
  unique(order_id,pricing_hash,pending_usd,pending_bs,rate,operation_date)
);
create index order_payment_quotes_actor_idx on app_private.order_payment_quotes_v1(created_by);

create table app_private.payment_rate_reviews_v1 (
  report_id bigint primary key references public.payment_reports(id),
  order_id bigint not null references public.orders(id),
  pricing_hash text not null,
  baseline_pending_usd numeric not null,
  quoted_pending_usd numeric,
  quoted_pending_bs numeric,
  quoted_rate numeric,
  quote_id bigint references app_private.order_payment_quotes_v1(id),
  approved_quote_id bigint references app_private.order_payment_quotes_v1(id),
  source text not null,
  reported_amount numeric not null,
  reported_rate numeric not null,
  created_at timestamptz not null default statement_timestamp(),
  decision text check(decision in ('quoted','reported')),
  coverage_rate numeric,
  coverage_pending_usd numeric,
  coverage_pending_bs numeric,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  reason text,
  consumed_movement_id bigint unique references public.money_movements(id) deferrable initially deferred
);
create index payment_rate_reviews_order_idx on app_private.payment_rate_reviews_v1(order_id);
create index payment_rate_reviews_quote_idx on app_private.payment_rate_reviews_v1(quote_id);
create index payment_rate_reviews_approved_quote_idx on app_private.payment_rate_reviews_v1(approved_quote_id);
create index payment_rate_reviews_actor_idx on app_private.payment_rate_reviews_v1(approved_by);
alter table app_private.order_payment_quotes_v1 enable row level security;
alter table app_private.payment_rate_reviews_v1 enable row level security;
revoke all on app_private.order_payment_quotes_v1,app_private.payment_rate_reviews_v1 from public,anon,authenticated,service_role;

create function app_private.payment_quote_pricing_hash_v1(p_order bigint) returns text
language sql stable security invoker set search_path='' as $$
 select md5(jsonb_build_object('client',o.client_id,'pricing',o.extra_fields->'pricing',
   'total_usd',o.total_usd,'total_bs',o.total_bs_snapshot,
   'items',(select jsonb_agg(jsonb_build_array(i.id,i.product_id,i.qty,i.line_total_usd,
     i.line_total_bs_snapshot,i.pricing_origin_currency,i.pricing_fx_rate_snapshot,i.override_unit_price_usd,i.admin_price_override_usd) order by i.id)
     from public.order_items i where i.order_id=o.id))::text)
 from public.orders o where o.id=p_order;
$$;
revoke all on function app_private.payment_quote_pricing_hash_v1(bigint) from public,anon,authenticated,service_role;

create function public.record_order_payment_quote_v1(p_order_id bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.orders%rowtype; s record; q app_private.order_payment_quotes_v1%rowtype;
  r numeric; d date:=(statement_timestamp() at time zone 'America/Caracas')::date; h text;
begin
 if auth.uid() is null then raise exception 'No autenticado.' using errcode='42501'; end if;
 select * into o from public.orders where id=p_order_id for update;
 if not found or o.status::text='cancelled' or not(public.is_master_or_admin()
   or (public.has_role('advisor') and o.attributed_advisor_id=auth.uid())) then
   raise exception 'No autorizado para cotizar esta orden.' using errcode='42501'; end if;
 select rate_bs_per_usd into r from public.exchange_rates where is_active order by effective_at desc,id desc limit 1;
 if r is null or r<=0 then raise exception 'No hay una tasa vigente válida.'; end if;
 select * into strict s from public.get_order_financial_state(p_order_id,d,r);
 if s.pending_usd<=0 or s.pending_bs<=0 then return jsonb_build_object('certificateId',null); end if;
 if s.collection_mode='snapshot_quote' then r:=s.snapshot_rate_bs_per_usd; end if;
 h:=app_private.payment_quote_pricing_hash_v1(p_order_id);
 insert into app_private.order_payment_quotes_v1(order_id,pricing_hash,pending_usd,pending_bs,rate,operation_date,collection_mode,created_by)
 values(p_order_id,h,s.pending_usd,s.pending_bs,r,d,s.collection_mode,auth.uid()) on conflict do nothing;
 select * into strict q from app_private.order_payment_quotes_v1 where order_id=p_order_id and pricing_hash=h
   and pending_usd=s.pending_usd and pending_bs=s.pending_bs and rate=r and operation_date=d;
 return jsonb_build_object('certificateId',q.id,'pendingUsd',q.pending_usd,'pendingBs',q.pending_bs,
   'exchangeRate',q.rate,'generatedAt',q.created_at,'operationDate',q.operation_date,
   'collectionMode',q.collection_mode,'pendingReportsCount',s.pending_reports_count,'activeRate',
   (select rate_bs_per_usd from public.exchange_rates where is_active order by effective_at desc,id desc limit 1));
end $$;
revoke all on function public.record_order_payment_quote_v1(bigint) from public,anon,service_role;
grant execute on function public.record_order_payment_quote_v1(bigint) to authenticated;

-- A coincidence only flags a discrepancy. It NEVER certifies that a customer
-- paid an old quote or grants the old rate automatically.
create function app_private.capture_payment_rate_review_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare o public.orders%rowtype; s record; b record; q app_private.order_payment_quotes_v1%rowtype;
  h text; r numeric; d date; requested boolean;
begin
 if new.reported_currency_code::text<>'VES' or new.reported_exchange_rate_ves_per_usd is null
   or new.status::text<>'pending' or new.event_payment_id is not null then return new; end if;
 select * into o from public.orders where id=new.order_id for update;
 if not found or o.status::text='cancelled' then return new; end if;
 d:=coalesce(new.operation_date,(new.created_at at time zone 'America/Caracas')::date);
 select * into s from public.get_order_financial_state(new.order_id,d,new.reported_exchange_rate_ves_per_usd);
 if not found or s.pending_usd<=0 then return new; end if;
 -- Guard only certified new-dollar sales. Legacy snapshot/post-delivery rules
 -- retain their existing behavior; an explicit request can still be reviewed.
 requested:=position('[Revisar tasa acordada]' in coalesce(new.notes,''))>0;
 if not requested and new.reported_amount=s.pending_bs then return new; end if;
 if not requested and not exists(select 1 from app_private.native_usd_orders_v1 where order_id=new.order_id) then return new; end if;
 h:=app_private.payment_quote_pricing_hash_v1(new.order_id);
 select * into q from app_private.order_payment_quotes_v1 where order_id=new.order_id and pricing_hash=h
   and pending_usd=s.pending_usd and pending_bs=new.reported_amount and rate<>new.reported_exchange_rate_ves_per_usd
   and operation_date<=d order by created_at desc,id desc limit 1;
 r:=nullif(o.extra_fields#>>'{pricing,fx_rate}','')::numeric;
 select * into b from public.get_order_financial_state(new.order_id,d,r);
 if q.id is null and not requested and not(r>0 and r<>new.reported_exchange_rate_ves_per_usd
   and b.pending_usd=s.pending_usd and b.pending_bs=new.reported_amount) then return new; end if;
 insert into app_private.payment_rate_reviews_v1(report_id,order_id,pricing_hash,baseline_pending_usd,
   quoted_pending_usd,quoted_pending_bs,quoted_rate,quote_id,source,reported_amount,reported_rate)
 values(new.id,new.order_id,h,s.pending_usd,coalesce(q.pending_usd,b.pending_usd),
   coalesce(q.pending_bs,b.pending_bs),coalesce(q.rate,r),q.id,
   case when q.id is not null then 'payment_quote' when requested then 'requested_review' else 'order_budget' end,
   new.reported_amount,new.reported_exchange_rate_ves_per_usd);
 return new;
end $$;
revoke all on function app_private.capture_payment_rate_review_v1() from public,anon,authenticated,service_role;
create trigger capture_payment_rate_review after insert on public.payment_reports
 for each row execute function app_private.capture_payment_rate_review_v1();

create function public.read_payment_rate_review_v1(p_report_id bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e app_private.payment_rate_reviews_v1%rowtype;
begin
 if auth.uid() is null or not public.is_master_or_admin() then raise exception 'No autorizado.' using errcode='42501'; end if;
 select * into e from app_private.payment_rate_reviews_v1 where report_id=p_report_id;
 if not found then return jsonb_build_object('available',false); end if;
 return jsonb_build_object('available',true,'canApprove',public.has_role('admin'),'reportId',e.report_id,'orderId',e.order_id,
   'amountBs',e.reported_amount,'recordedRate',e.reported_rate,
   'quoteRate',case when e.decision='quoted' then e.coverage_rate else e.quoted_rate end,
   'quoteUsd',case when e.decision='quoted' then e.coverage_pending_usd else e.quoted_pending_usd end,
   'quoteBs',case when e.decision='quoted' then e.coverage_pending_bs else e.quoted_pending_bs end,'source',e.source,
   'quoteCandidates',coalesce((select jsonb_agg(v) from (select q.id,q.rate,q.pending_usd as "pendingUsd",q.pending_bs as "pendingBs",q.created_at as "createdAt"
     from app_private.order_payment_quotes_v1 q where q.order_id=e.order_id and q.pricing_hash=e.pricing_hash
       and q.pending_usd=e.baseline_pending_usd order by q.created_at desc,q.id desc limit 20) v),'[]'::jsonb),
   'decision',e.decision,'applied',e.consumed_movement_id is not null);
end $$;
revoke all on function public.read_payment_rate_review_v1(bigint) from public,anon,service_role;
grant execute on function public.read_payment_rate_review_v1(bigint) to authenticated;

create function public.approve_payment_rate_review_v1(p_report_id bigint,p_decision text,p_reason text,p_quote_id bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e app_private.payment_rate_reviews_v1%rowtype; r public.payment_reports%rowtype; s record; o public.orders%rowtype;
 v_selected_quote app_private.order_payment_quotes_v1%rowtype; v_quote_rate numeric; v_quote_bs numeric; v_quote_usd numeric;
begin
 if auth.uid() is null or not public.has_role('admin') then raise exception 'Solo Administración puede confirmar la tasa acordada.' using errcode='42501'; end if;
 if p_decision is null or p_decision not in ('quoted','reported') or length(btrim(coalesce(p_reason,'')))<4 then
   raise exception 'Selecciona el tratamiento del pago e indica el acuerdo comprobado.'; end if;
 select order_id into r.order_id from public.payment_reports where id=p_report_id;
 select * into strict o from public.orders where id=r.order_id for update;
 select * into strict r from public.payment_reports where id=p_report_id for update;
 select * into e from app_private.payment_rate_reviews_v1 where report_id=p_report_id for update;
 if not found then raise exception 'Este pago no tiene una revisión de tasa certificada.'; end if;
 if e.approved_at is not null then
   if e.decision=p_decision and e.reason=btrim(p_reason) and e.approved_quote_id is not distinct from p_quote_id then return public.read_payment_rate_review_v1(p_report_id); end if;
   raise exception 'La decisión ya quedó registrada; no se puede sustituir silenciosamente.'; end if;
 if r.status::text<>'pending' or o.status::text='cancelled' or e.pricing_hash<>app_private.payment_quote_pricing_hash_v1(e.order_id)
   or r.reported_amount<>e.reported_amount or r.reported_exchange_rate_ves_per_usd<>e.reported_rate then
   raise exception 'El pedido o el reporte cambió. Revisa la orden antes de aprobar la tasa.'; end if;
 select * into strict s from public.get_order_financial_state(e.order_id,coalesce(r.operation_date,(r.created_at at time zone 'America/Caracas')::date),e.reported_rate);
 if s.pending_usd is distinct from e.baseline_pending_usd then raise exception 'El saldo cambió por otro pago o ajuste. Revisa la orden.'; end if;
 if not exists(select 1 from public.order_collection_precision_basis_v1(e.order_id)) then
   raise exception 'La orden no tiene cobertura precisa certificable. Requiere auditoría individual.'; end if;
 v_quote_rate:=e.quoted_rate; v_quote_bs:=e.quoted_pending_bs; v_quote_usd:=e.quoted_pending_usd;
 if p_quote_id is not null then
   if p_decision<>'quoted' then raise exception 'Una cotización solo corresponde a la opción de tasa acordada.'; end if;
   select * into v_selected_quote from app_private.order_payment_quotes_v1 where id=p_quote_id and order_id=e.order_id
     and pricing_hash=e.pricing_hash and pending_usd=s.pending_usd;
   if not found or v_selected_quote.operation_date>coalesce(r.operation_date,(r.created_at at time zone 'America/Caracas')::date) then
     raise exception 'La cotización no corresponde a esta orden, saldo o fecha de pago.'; end if;
   v_quote_rate:=v_selected_quote.rate;v_quote_bs:=v_selected_quote.pending_bs;v_quote_usd:=v_selected_quote.pending_usd;
 end if;
 if p_decision='quoted' and (v_quote_rate>0 and v_quote_bs>0 and v_quote_usd=s.pending_usd) is not true then
   raise exception 'No hay una cotización anterior verificable para este saldo.'; end if;
 if p_decision='quoted' and p_quote_id is null and e.quote_id is not null and exists(select 1 from app_private.order_payment_quotes_v1 q
   where q.id=e.quote_id and q.operation_date>coalesce(r.operation_date,(r.created_at at time zone 'America/Caracas')::date)) then
   raise exception 'La cotización es posterior a la fecha del pago. Requiere revisión individual.'; end if;
 if p_decision='quoted' and p_quote_id is null and e.quote_id is null
   and (o.created_at at time zone 'America/Caracas')::date>coalesce(r.operation_date,(r.created_at at time zone 'America/Caracas')::date) then
   raise exception 'El presupuesto de la orden es posterior a la fecha del pago. Requiere revisión individual.'; end if;
 update app_private.payment_rate_reviews_v1 set decision=p_decision,reason=btrim(p_reason),approved_by=auth.uid(),approved_at=statement_timestamp(),
   approved_quote_id=p_quote_id,coverage_rate=case when p_decision='quoted' then v_quote_rate else e.reported_rate end,
   coverage_pending_usd=s.pending_usd,coverage_pending_bs=case when p_decision='quoted' then v_quote_bs else s.pending_bs end
 where report_id=p_report_id;
 insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,actor_user_id,payload)
 values(o.id,o.order_number,'payment_rate_review_approved','payment','Tasa del pago revisada',btrim(p_reason),auth.uid(),
   jsonb_build_object('report_id',p_report_id,'decision',p_decision,'quoted_rate',v_quote_rate,'cash_rate',e.reported_rate,
   'amount_bs',e.reported_amount,'quote_id',coalesce(p_quote_id,e.quote_id),'no_cash_movement',true));
 return public.read_payment_rate_review_v1(p_report_id);
end $$;
revoke all on function public.approve_payment_rate_review_v1(bigint,text,text,bigint) from public,anon,service_role;
grant execute on function public.approve_payment_rate_review_v1(bigint,text,text,bigint) to authenticated;

create function app_private.guard_payment_rate_review_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare e app_private.payment_rate_reviews_v1%rowtype; s record; r public.payment_reports%rowtype; o public.orders%rowtype;
begin
 if new.status::text<>'confirmed' or new.direction::text<>'inflow' or new.movement_type::text<>'order_payment'
   or new.payment_report_id is null then return new; end if;
 if tg_op='UPDATE' then if old.status::text='confirmed' then return new; end if; end if;
 select * into o from public.orders where id=new.order_id for update;
 select * into r from public.payment_reports where id=new.payment_report_id for update;
 select * into e from app_private.payment_rate_reviews_v1 where report_id=new.payment_report_id for update;
 if not found then return new; end if;
 if o.status::text='cancelled' then raise exception 'La orden está cancelada. No se confirmó nada.'; end if;
 if e.approved_at is null then raise exception 'Este pago puede corresponder a una tasa acordada anterior. Administración debe revisar la tasa antes de confirmarlo.' using errcode='22023'; end if;
 if e.consumed_movement_id is not null then raise exception 'La cobertura de este reporte ya fue utilizada; no se puede reactivar ni duplicar.'; end if;
 if new.currency_code::text<>'VES' or new.order_id<>e.order_id or new.amount<>e.reported_amount
   or new.exchange_rate_ves_per_usd<>e.reported_rate
   or new.amount_usd_equivalent is distinct from round(new.amount/new.exchange_rate_ves_per_usd,2)
   or r.status::text is distinct from 'pending' or r.order_id is distinct from e.order_id
   or r.reported_currency_code::text is distinct from 'VES'
   or r.reported_amount is distinct from e.reported_amount
   or r.reported_exchange_rate_ves_per_usd is distinct from e.reported_rate
   or e.pricing_hash<>app_private.payment_quote_pricing_hash_v1(e.order_id) then
   raise exception 'El pago o la orden cambió después de revisar la tasa. No se confirmó nada.'; end if;
 select * into strict s from public.get_order_financial_state(e.order_id,new.movement_date,new.exchange_rate_ves_per_usd);
 if s.pending_usd is distinct from e.coverage_pending_usd then raise exception 'El saldo cambió después de revisar la tasa. No se confirmó nada.'; end if;
 if e.decision='quoted' and (
   exists(select 1 from app_private.order_payment_quotes_v1 q where q.id=coalesce(e.approved_quote_id,e.quote_id)
     and q.operation_date>new.movement_date)
   or (coalesce(e.approved_quote_id,e.quote_id) is null and (o.created_at at time zone 'America/Caracas')::date>new.movement_date)
 ) then raise exception 'La cotización es posterior a la fecha que intentas confirmar. Revisa la fecha real del pago.'; end if;
 if not exists(select 1 from public.order_collection_precision_basis_v1(e.order_id)) then
   raise exception 'La cobertura precisa dejó de ser verificable. No se confirmó nada.'; end if;
 update app_private.payment_rate_reviews_v1 set consumed_movement_id=new.id where report_id=e.report_id;
 return new;
end $$;
revoke all on function app_private.guard_payment_rate_review_v1() from public,anon,authenticated,service_role;
create trigger a00_guard_payment_rate_review before insert or update of status on public.money_movements
 for each row execute function app_private.guard_payment_rate_review_v1();

-- Keep the existing transaction, idempotency and native money valuation. Only
-- a newly reviewed report can supply an explicit, immutable coverage quote.
do $patch$
declare d text; anchor text;
begin
 d:=pg_get_functiondef('app_private.capture_order_payment_precision_v1()'::regprocedure);
 if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='app_private.capture_order_payment_precision_v1()'::regprocedure)<>'ce0b7a713b772f10e34eaaf42fb6e704' then raise exception 'Precision capture changed; review migration'; end if;
 anchor:='  select * into v_allocation from app_private.collection_payment_allocation_v1(';
 if position(anchor in d)=0 then raise exception 'Precision capture anchor missing'; end if;
 d:=replace(d,anchor,$insert$  if exists(select 1 from app_private.payment_rate_reviews_v1 e where e.report_id=new.payment_report_id
      and e.approved_at is not null and e.consumed_movement_id=new.id) then
    select e.coverage_rate,e.coverage_pending_usd,e.coverage_pending_bs into v_rate,v_state.pending_usd,v_state.pending_bs
      from app_private.payment_rate_reviews_v1 e where e.report_id=new.payment_report_id;
  end if;
$insert$||anchor);
 execute d;
 d:=pg_get_functiondef('public.counter_apply_order_payments_block2(uuid,bigint,jsonb,text,jsonb,text)'::regprocedure);
 if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='public.counter_apply_order_payments_block2(uuid,bigint,jsonb,text,jsonb,text)'::regprocedure)<>'55d16e671205f29ebc508ea547e0f35f' then raise exception 'Counter confirmation changed; review migration'; end if;
 anchor:='    if v_auto_confirm then';
 if position(anchor in d)=0 then raise exception 'Counter confirmation anchor missing'; end if;
 -- Ambiguous tender remains a single pending report, even for POS/cash. It is
 -- never silently valued/posted at the wrong rate and must not be re-entered.
 execute replace(d,anchor,$insert$    v_auto_confirm := v_auto_confirm and not exists(
      select 1 from app_private.payment_rate_reviews_v1 where report_id=v_report_id);
$insert$||anchor);
end $patch$;
notify pgrst,'reload schema';
commit;
