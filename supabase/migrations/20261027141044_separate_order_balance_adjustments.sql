-- Prospective balance adjustments only. No historical order, payment, price or
-- commission closure is rewritten or enrolled by this migration.
-- Filename aligned with the production migration version assigned on application.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $guard$
declare r record;
begin
  for r in select * from (values
    ('public.get_order_financial_state(bigint,date,numeric)','0aac0c1186e5c2c800bb8f8c09d7112f'),
    ('app_private.confirm_payment_report_atomic_v1(jsonb)','a2e1fd5958146b9e83e39c2ab49207c9'),
    ('app_private.void_financial_movement_v1(bigint,uuid,text)','c9235076ab700909076a049f61e2b01b'),
    ('public.counter_waive_order_change(uuid,bigint,numeric,text)','d29efb1d280536a12d2d357979fb9cf4')
  ) x(signature,expected_hash) loop
    if (select md5(prosrc) from pg_proc where oid=r.signature::regprocedure) is distinct from r.expected_hash then
      raise exception 'Financial implementation changed: %',r.signature;
    end if;
  end loop;
end $guard$;

create table public.order_balance_adjustments_v1 (
  request_id uuid primary key,
  order_id bigint not null references public.orders(id),
  kind text not null check(kind in ('shortfall_waived','change_waived')),
  amount_usd numeric not null check(amount_usd>0 and amount_usd<=1 and amount_usd::text not in ('NaN','Infinity','-Infinity')),
  source text not null check(source in ('admin_shortfall','payment_confirmation','counter_change_waived')),
  payment_report_id bigint references public.payment_reports(id),
  supporting_movement_ids bigint[] not null default '{}',
  audit_adjustment_id bigint not null references public.order_admin_adjustments(id),
  reason text not null,
  request_payload jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  created_by uuid not null references auth.users(id)
);
create index order_balance_adjustments_v1_order_idx on public.order_balance_adjustments_v1(order_id);
create index order_balance_adjustments_v1_report_idx on public.order_balance_adjustments_v1(payment_report_id);
create index order_balance_adjustments_v1_actor_idx on public.order_balance_adjustments_v1(created_by);
create index order_balance_adjustments_v1_audit_idx on public.order_balance_adjustments_v1(audit_adjustment_id);
alter table public.order_balance_adjustments_v1 enable row level security;
revoke all on public.order_balance_adjustments_v1 from public,anon,authenticated,service_role;
grant select on public.order_balance_adjustments_v1 to authenticated,service_role;
create policy order_balance_adjustments_v1_read on public.order_balance_adjustments_v1
for select to authenticated using (exists(select 1 from public.orders o
  where o.id=order_balance_adjustments_v1.order_id and
  ((select public.is_master_or_admin()) or (select public.has_role('counter')) or
   ((select public.has_role('advisor')) and o.attributed_advisor_id=(select auth.uid())))));

-- Owner-only primitive. Callers already hold the order lock and verify the
-- operational balance; no API role may invoke or write this ledger directly.
create function app_private.record_order_balance_adjustment_v1(
  p_request uuid,p_order bigint,p_kind text,p_amount numeric,p_source text,
  p_reason text,p_report bigint default null,p_request_payload jsonb default '{}'
) returns bigint language plpgsql security invoker set search_path='' as $fn$
declare v_audit bigint; v_support bigint[];
begin
  select coalesce(array_agg(id order by id),'{}'::bigint[]) into v_support
  from public.money_movements where order_id=p_order and status='confirmed';
  insert into public.order_admin_adjustments(order_id,adjustment_type,reason,notes,payload,created_by_user_id)
  values(p_order,'other',case when p_kind='shortfall_waived' then 'Faltante perdonado' else 'Cambio cedido por el cliente' end,
    p_reason,jsonb_build_object('kind','order_balance_adjustment_v1','balance_kind',p_kind,
      'amount_usd',p_amount,'closed_balance_usd',p_amount,'request_id',p_request,
      'source',p_source,'payment_report_id',p_report,'price_unchanged',true),auth.uid()) returning id into v_audit;
  insert into public.order_balance_adjustments_v1(request_id,order_id,kind,amount_usd,source,payment_report_id,
    supporting_movement_ids,audit_adjustment_id,reason,request_payload,created_by)
  values(p_request,p_order,p_kind,p_amount,p_source,p_report,v_support,v_audit,p_reason,p_request_payload,auth.uid());
  return v_audit;
end $fn$;
revoke all on function app_private.record_order_balance_adjustment_v1(uuid,bigint,text,numeric,text,text,bigint,jsonb)
  from public,anon,authenticated,service_role;

create function app_private.close_order_balance_difference_v1(
  p_request_id uuid,p_order_id bigint,p_expected_usd numeric,p_notes text default null
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_order public.orders%rowtype; v_prior public.order_balance_adjustments_v1%rowtype;
  v_state record; v_audit bigint; v_request jsonb; v_notes text;
begin
  if auth.uid() is null or not public.has_role('admin') then
    raise exception 'Solo Administración puede perdonar un faltante.' using errcode='42501';
  end if;
  if p_request_id is null or p_order_id is null or p_order_id<=0 or p_expected_usd is null
    or p_expected_usd::text in ('NaN','Infinity','-Infinity') or p_expected_usd<=0 or p_expected_usd>0.09 then
    raise exception 'Revisa el faltante. El límite autorizado sigue siendo USD 0,09.' using errcode='22023';
  end if;
  v_notes:=coalesce(nullif(btrim(p_notes),''),'Faltante perdonado por Administración');
  if length(v_notes)>500 then raise exception 'El motivo no puede superar 500 caracteres.' using errcode='22023'; end if;
  v_request:=jsonb_build_object('order_id',p_order_id,'expected_usd',p_expected_usd,'notes',v_notes);
  perform pg_advisory_xact_lock(hashtextextended('balance-adjustment:'||p_request_id::text,0));
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.status='cancelled' then
    raise exception 'La orden no existe o está cancelada.' using errcode='22023';
  end if;
  select * into v_prior from public.order_balance_adjustments_v1 where request_id=p_request_id;
  if found then
    if v_prior.created_by<>auth.uid() or v_prior.source<>'admin_shortfall' or v_prior.request_payload<>v_request then
      raise exception 'La solicitud ya fue utilizada con otros datos.' using errcode='22023';
    end if;
    if exists(select 1 from unnest(v_prior.supporting_movement_ids) support(id)
      left join public.money_movements m on m.id=support.id and m.order_id=v_prior.order_id
      where m.id is null or m.status is distinct from 'confirmed') then
      raise exception 'El ajuste dejó de aplicar porque se anuló un movimiento de respaldo. Actualiza la orden.' using errcode='22023';
    end if;
    return jsonb_build_object('id',p_order_id,'adjustmentId',v_prior.audit_adjustment_id,
      'amountUsd',v_prior.amount_usd,'replayed',true);
  end if;
  select * into v_state from public.get_order_financial_state(p_order_id);
  if not found or v_state.pending_usd is null or v_state.pending_usd::text in ('NaN','Infinity','-Infinity')
    or v_state.pending_usd<=0.005 or v_state.pending_usd>0.09
    or round(v_state.pending_usd,2) is distinct from round(p_expected_usd,2) then
    raise exception 'El saldo cambió o supera el límite. Actualiza la orden antes de cerrar.' using errcode='22023';
  end if;
  v_audit:=app_private.record_order_balance_adjustment_v1(p_request_id,p_order_id,'shortfall_waived',
    v_state.pending_usd,'admin_shortfall',v_notes,null,v_request);
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
  values(p_order_id,v_order.order_number,'order_balance_adjusted','payment','Faltante perdonado',v_notes,'info',auth.uid(),
    jsonb_build_object('adjustment_id',v_audit,'amount_usd',v_state.pending_usd,'price_unchanged',true));
  return jsonb_build_object('id',p_order_id,'adjustmentId',v_audit,'amountUsd',v_state.pending_usd,'replayed',false);
end $fn$;
revoke all on function app_private.close_order_balance_difference_v1(uuid,bigint,numeric,text) from public,anon,authenticated,service_role;
grant execute on function app_private.close_order_balance_difference_v1(uuid,bigint,numeric,text) to authenticated;
create function public.close_order_balance_difference_v1(
  p_request_id uuid,p_order_id bigint,p_expected_usd numeric,p_notes text default null
) returns jsonb language sql security invoker set search_path='' as $fn$
  select app_private.close_order_balance_difference_v1(p_request_id,p_order_id,p_expected_usd,p_notes);
$fn$;
revoke all on function public.close_order_balance_difference_v1(uuid,bigint,numeric,text) from public,anon,authenticated,service_role;
grant execute on function public.close_order_balance_difference_v1(uuid,bigint,numeric,text) to authenticated;

-- Keep the entire precision, rate and legacy calculation intact. Only the final
-- outstanding balance incorporates new, explicitly authorized adjustments.
do $patch$
declare d text; anchor text; replacement text; final_sql text; start_at integer; end_at integer;
begin
  d:=pg_get_functiondef('public.get_order_financial_state(bigint,date,numeric)'::regprocedure);
  anchor:=E'\nselect\n  canonical.order_id';
  start_at:=strpos(d,anchor);
  if start_at=0 then raise exception 'Canonical final projection changed'; end if;
  final_sql:=substr(d,start_at);
  final_sql:=replace(final_sql,'canonical.canonical_pending_usd','canonical.settled_pending_usd');
  final_sql:=replace(final_sql,'canonical.raw_overpaid_usd','canonical.settled_overpaid_usd');
  final_sql:=replace(final_sql,E'    when canonical.native_usd then case',E'    when canonical.adjustment_count>0 then round(canonical.settled_pending_usd * case\n      when canonical.native_usd then case when canonical.current_rate>0 and canonical.current_rate::text not in (''NaN'',''Infinity'',''-Infinity'') then canonical.current_rate else null end\n      when canonical.delivery_reference_date is not null and canonical.effective_operation_date>canonical.delivery_reference_date\n        and coalesce(p_active_bs_rate,0)>0 then p_active_bs_rate\n      else canonical.snapshot_rate_bs_per_usd end,2)\n    when canonical.native_usd then case');
  final_sql:=replace(final_sql,'from canonical;','from separate_balances canonical;');
  replacement:=$cte$,
financial_waivers as (
  select count(*) as adjustment_count,
    coalesce(sum(case when a.kind='shortfall_waived' then -a.amount_usd else a.amount_usd end),0) as balance_delta
  from public.order_balance_adjustments_v1 a
  where a.order_id=p_order_id and not exists (
    select 1 from unnest(a.supporting_movement_ids) support(id)
    left join public.money_movements m on m.id=support.id and m.order_id=a.order_id
    where m.id is null or m.status is distinct from 'confirmed'
  )
), separate_balances as (
  select c.*,w.adjustment_count,
    greatest(0,c.canonical_pending_usd-c.raw_overpaid_usd+w.balance_delta) as settled_pending_usd,
    greatest(0,c.raw_overpaid_usd-c.canonical_pending_usd-w.balance_delta) as settled_overpaid_usd
  from canonical c cross join financial_waivers w
)
$cte$;
  execute left(d,start_at-1)||replacement||final_sql;

  d:=pg_get_functiondef('app_private.confirm_payment_report_atomic_v1(jsonb)'::regprocedure);
  start_at:=strpos(d,'  if v_handling=''close_difference'' and v_excess>0 then');
  end_at:=strpos(d,'  v_payload := jsonb_build_object(');
  if start_at=0 or end_at<=start_at then raise exception 'Confirmation balance block changed'; end if;
  replacement:=$gain$  if v_handling='close_difference' and v_excess>0 then
    if v_after.overpaid_usd>1 then raise exception 'Solo se pueden cerrar diferencias de hasta 1,00 USD.' using errcode='22023'; end if;
    v_adjustment_id:=app_private.record_order_balance_adjustment_v1(v_group,v_order.id,'change_waived',v_excess,
      'payment_confirmation',coalesce(v_notes,'Cambio cedido voluntariamente por el cliente'),v_report_id,p_input);
  end if;
$gain$;
  execute overlay(d placing replacement from start_at for end_at-start_at);

  d:=pg_get_functiondef('app_private.void_financial_movement_v1(bigint,uuid,text)'::regprocedure);
  anchor:='where op.report_id=any(v_report_ids) order by a.id desc';
  if strpos(d,anchor)=0 then raise exception 'Financial reversal block changed'; end if;
  execute replace(d,anchor,'where op.report_id=any(v_report_ids) and a.payload->>''kind''=''rounding_gain_close'' order by a.id desc');
  -- New adjustments cease to apply when a supporting movement is voided. Their
  -- immutable evidence remains; only legacy price-changing closes restore prices.

  d:=pg_get_functiondef('public.counter_waive_order_change(uuid,bigint,numeric,text)'::regprocedure);
  start_at:=strpos(d,'  insert into public.order_admin_adjustments (');
  end_at:=strpos(d,'  insert into public.order_events (');
  if start_at=0 or end_at<=start_at then raise exception 'Counter waiver audit block changed'; end if;
  replacement:=$counter$  v_adjustment_id:=app_private.record_order_balance_adjustment_v1(p_idempotency_key,p_order_id,
    'change_waived',v_available,'counter_change_waived',
    coalesce(nullif(btrim(p_notes),''),'Cambio cedido voluntariamente por el cliente'),null,v_request_payload);

$counter$;
  execute overlay(d placing replacement from start_at for end_at-start_at);
end $patch$;

-- A still-open tab from the preceding release must not use its old direct
-- price-changing shortfall action during the database/application rollout.
create function app_private.reject_price_changing_balance_close_v1()
returns trigger language plpgsql security invoker set search_path='' as $fn$
begin
  if (new.total_usd is distinct from old.total_usd or new.total_bs_snapshot is distinct from old.total_bs_snapshot)
    and new.extra_fields#>'{payment,rounding_close}' is not null
    and new.extra_fields#>'{payment,rounding_close}' is distinct from old.extra_fields#>'{payment,rounding_close}' then
    raise exception 'Actualiza la pantalla: cerrar un saldo ya no puede modificar el precio de la orden.' using errcode='22023';
  end if;
  return new;
end $fn$;
revoke all on function app_private.reject_price_changing_balance_close_v1() from public,anon,authenticated,service_role;
create trigger reject_price_changing_balance_close_v1 before update on public.orders
for each row execute function app_private.reject_price_changing_balance_close_v1();

comment on table public.order_balance_adjustments_v1 is
'Prospective non-cash waivers. Sale prices, tax, commission bases and paid commission closures are never rewritten. Voiding supporting payments deactivates the waiver without deleting its evidence.';
commit;
