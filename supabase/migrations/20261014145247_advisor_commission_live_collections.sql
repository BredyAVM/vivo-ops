-- Filename aligned with the applied Supabase migration history.
begin;
set local lock_timeout = '5s';

-- Ownership evidence, not a second copy of orders or payments. One source can
-- have exactly one destination; all amounts are the unpaid credit at transfer.
create table public.advisor_commission_carry_transfers (
  source_closure_id bigint primary key references public.advisor_commission_closures(id),
  destination_closure_id bigint not null references public.advisor_commission_closures(id),
  credit_usd numeric not null check (credit_usd >= 0),
  advisor_debt_usd numeric not null check (advisor_debt_usd >= 0),
  order_ids bigint[] not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  reason text not null,
  check (source_closure_id <> destination_closure_id)
);
create index advisor_commission_carry_destination_idx on public.advisor_commission_carry_transfers(destination_closure_id);
alter table public.advisor_commission_carry_transfers enable row level security;
revoke all on public.advisor_commission_carry_transfers from public,anon,authenticated,service_role;
grant select on public.advisor_commission_carry_transfers to authenticated;
create policy commission_carry_read on public.advisor_commission_carry_transfers for select to authenticated
using (exists (select 1 from public.advisor_commission_closures c where c.id=source_closure_id
  and (c.advisor_user_id=(select auth.uid()) or exists(select 1 from public.user_roles r
    where r.user_id=(select auth.uid()) and r.role in ('admin','master')))));

-- Preserve already confirmed historical carry: exact amount, nearest preceding
-- closure, never a preliminary proposal. No generated identifiers are hardcoded.
insert into public.advisor_commission_carry_transfers
  (source_closure_id,destination_closure_id,credit_usd,advisor_debt_usd,order_ids,created_at,created_by,reason)
select s.id,d.id,(s.snapshot#>>'{settlement,retainedCommissionUsd}')::numeric,0,
  array(select distinct (j->>'orderId')::bigint from jsonb_array_elements(coalesce(s.snapshot->'orders','[]')) j
    where j->>'orderId' ~ '^[0-9]+$'), coalesce(d.closed_at,d.generated_at),d.closed_by_user_id,
  'Arrastre histórico ya incluido en una liquidación conformada; conciliación de propiedad.'
from public.advisor_commission_closures d
join public.advisor_commission_periods dp on dp.id=d.period_id
cross join lateral (
  select c.* from public.advisor_commission_closures c join public.advisor_commission_periods p on p.id=c.period_id
  where c.advisor_user_id=d.advisor_user_id and p.date_from<dp.date_from
  order by p.date_from desc limit 1
) s
where d.status in ('closed','paid') and s.status in ('closed','paid')
  and s.snapshot#>>'{settlement,formulaVersion}'='advisor-settlement-v1'
  and (s.snapshot#>>'{settlement,retainedCommissionUsd}')::numeric>0
  and (d.snapshot#>>'{settlement,carriedCommissionUsd}')::numeric=(s.snapshot#>>'{settlement,retainedCommissionUsd}')::numeric
  and d.snapshot#>>'{settlement,carrySource}' in ('settlement','manual-bootstrap');

create function app_private.commission_collection_state_v1(p_closure_id bigint) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare
  c public.advisor_commission_closures%rowtype; t public.advisor_commission_carry_transfers%rowtype;
  ids bigint[]; live_orders jsonb; n integer; debt numeric; paid numeric; incoming numeric; incoming_debt numeric;
  carried numeric; prior_debt numeric; credit numeric; due numeric; held numeric; advisor_debt numeric;
begin
  select * into c from public.advisor_commission_closures where id=p_closure_id;
  if not found then raise exception 'Liquidación no encontrada.' using errcode='22023'; end if;
  if auth.uid() is null or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active)
    or not (c.advisor_user_id=auth.uid() or exists(select 1 from public.user_roles r
      where r.user_id=auth.uid() and r.role in ('admin','master'))) then
    raise exception 'No puedes consultar esta liquidación.' using errcode='42501';
  end if;
  if c.status<>'preliminary' and c.snapshot#>>'{settlement,formulaVersion}' is distinct from 'advisor-settlement-v1' then
    return jsonb_build_object('closureId',c.id,'supported',false,'checkedAt',statement_timestamp());
  end if;
  select coalesce(sum(credit_usd),0),coalesce(sum(advisor_debt_usd),0) into incoming,incoming_debt
    from public.advisor_commission_carry_transfers where destination_closure_id=c.id;
  select array_agg(distinct id order by id) into ids from (
    select (j->>'orderId')::bigint id from jsonb_array_elements(coalesce(c.snapshot->'orders','[]')) j where j->>'orderId' ~ '^[0-9]+$'
    union select unnest(order_ids) from public.advisor_commission_carry_transfers where destination_closure_id=c.id
  ) q;
  ids:=coalesce(ids,'{}');
  select count(*),coalesce(sum(round(greatest(f.pending_usd,0),2)),0),coalesce(jsonb_agg(jsonb_build_object(
    'orderId',f.order_id,'clientName',coalesce(cl.full_name,'Cliente'),'deliveryDate',f.delivery_reference_date,
    'totalUsd',round(f.total_usd,2),'billedUsd',round(f.total_usd,2),'confirmedPaidUsd',round(f.confirmed_paid_usd,2),
    'pendingUsd',round(greatest(f.pending_usd,0),2),'paymentStatus',f.payment_status) order by f.order_id),'[]'::jsonb)
    into n,debt,live_orders from public.get_orders_financial_state(ids) f
    join public.orders o on o.id=f.order_id left join public.clients cl on cl.id=o.client_id;
  if n<>cardinality(ids) then raise exception 'No se pudo verificar la cobranza de todas las órdenes. No se puede pagar ni transferir.' using errcode='22023'; end if;
  select coalesce(sum(amount_usd_equivalent),0) into paid from public.money_movements
    where status='confirmed' and direction='outflow' and movement_type='expense_payment'
      and description like 'Liquidación de comisión · Cierre '||c.id||' ·%';
  if c.status='preliminary' then
    if exists(select 1 from public.advisor_commission_carry_transfers where destination_closure_id=c.id)
      and (coalesce((c.snapshot#>>'{commissionBootstrap,commissionCarryUsd}')::numeric,0)<>0
        or coalesce((c.snapshot#>>'{commissionBootstrap,advisorDebtCarryUsd}')::numeric,0)<>0) then
      raise exception 'El arrastre ya está vinculado: elimina el saldo inicial manual para no duplicarlo.' using errcode='22023';
    end if;
    carried:=incoming+coalesce((c.snapshot#>>'{commissionBootstrap,commissionCarryUsd}')::numeric,0);
    prior_debt:=incoming_debt+coalesce((c.snapshot#>>'{commissionBootstrap,advisorDebtCarryUsd}')::numeric,0);
  else
    -- These values are part of the agreement. Imported historical transfers
    -- already exist inside them; adding incoming again would pay twice.
    carried:=coalesce((c.snapshot#>>'{settlement,carriedCommissionUsd}')::numeric,0);
    prior_debt:=coalesce((c.snapshot#>>'{settlement,priorAdvisorDebtUsd}')::numeric,0);
  end if;
  credit:=round(carried+c.gross_commission_usd+coalesce((c.snapshot#>>'{settlement,positiveAdjustmentsUsd}')::numeric,0)
    -c.gift_deductions_usd-c.manual_deductions_usd-prior_debt
    -coalesce((c.snapshot#>>'{settlement,negativeAdjustmentsUsd}')::numeric,0),2);
  advisor_debt:=greatest(0,-credit); credit:=greatest(0,credit);
  held:=least(greatest(0,credit-paid),debt); due:=greatest(0,credit-debt);
  select * into t from public.advisor_commission_carry_transfers where source_closure_id=c.id;
  return jsonb_build_object('closureId',c.id,'supported',true,'checkedAt',statement_timestamp(),
    'agreedPayableUsd',c.payable_usd,'paidUsd',round(paid,2),'customerDebtUsd',debt,
    'carriedCommissionUsd',carried,'priorAdvisorDebtUsd',prior_debt,'creditUsd',credit,
    'payableUsd',case when t.source_closure_id is not null then paid else due end,
    'pendingUsd',case when t.source_closure_id is not null then 0 else greatest(0,due-paid) end,
    'retainedUsd',case when t.source_closure_id is not null then 0 else held end,
    'remainingCreditUsd',case when t.source_closure_id is not null then 0 else greatest(0,credit-paid) end,
    'advisorDebtUsd',case when t.source_closure_id is not null then 0 else advisor_debt end,
    'overpaidUsd',greatest(0,paid-due),'orderIds',to_jsonb(ids),'orders',live_orders,
    'transferredToClosureId',t.destination_closure_id,'transferredCreditUsd',t.credit_usd,
    'transferredAt',t.created_at,'incomingTransferCount',(select count(*) from public.advisor_commission_carry_transfers where destination_closure_id=c.id));
end;
$fn$;
revoke all on function app_private.commission_collection_state_v1(bigint) from public,anon,authenticated,service_role;

create function public.advisor_commission_collections_v1(p_closure_ids bigint[]) returns jsonb
language plpgsql security invoker set search_path='' as $fn$
declare result jsonb:='[]'; id bigint;
begin
  if coalesce(cardinality(p_closure_ids),0)>100 then raise exception 'Consulta demasiado amplia.' using errcode='22023'; end if;
  for id in select distinct unnest(p_closure_ids) loop
    result:=result||jsonb_build_array(app_private.commission_collection_state_v1(id));
  end loop;
  return result;
end;
$fn$;
grant execute on function app_private.commission_collection_state_v1(bigint) to authenticated;
revoke all on function public.advisor_commission_collections_v1(bigint[]) from public,anon,authenticated,service_role;
grant execute on function public.advisor_commission_collections_v1(bigint[]) to authenticated;

create function app_private.transfer_commission_collection_v1(p_source bigint,p_destination bigint,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare s public.advisor_commission_closures%rowtype; d public.advisor_commission_closures%rowtype; state jsonb; previous bigint;
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles r join public.profiles p on p.id=r.user_id
    where r.user_id=auth.uid() and r.role='admin' and p.is_active) then raise exception 'Esta acción requiere administración.' using errcode='42501'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 3 and 500 or p_source=p_destination then raise exception 'Indica origen, destino y motivo.' using errcode='22023'; end if;
  select * into s from public.advisor_commission_closures where id=p_source;
  if not found then raise exception 'Origen no encontrado.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('commission-advisor:'||s.advisor_user_id::text,0));
  perform 1 from public.advisor_commission_closures where id in (p_source,p_destination) order by id for update;
  select * into s from public.advisor_commission_closures where id=p_source;
  select * into d from public.advisor_commission_closures where id=p_destination;
  select destination_closure_id into previous from public.advisor_commission_carry_transfers where source_closure_id=p_source;
  if found then
    if previous=p_destination then return jsonb_build_object('replayed',true); end if;
    raise exception 'Este saldo ya fue transferido a otra liquidación.' using errcode='22023';
  end if;
  if d.id is null or d.advisor_user_id<>s.advisor_user_id or s.status not in ('closed','paid') or d.status<>'preliminary'
    or s.snapshot#>>'{commissionWorkflow,conformity,status}' is distinct from 'confirmed'
    or not exists(select 1 from public.advisor_commission_periods sp,public.advisor_commission_periods dp
      where sp.id=s.period_id and dp.id=d.period_id and dp.date_from>sp.date_from and dp.status='open')
    or coalesce((d.snapshot#>>'{commissionBootstrap,commissionCarryUsd}')::numeric,0)<>0
    or coalesce((d.snapshot#>>'{commissionBootstrap,advisorDebtCarryUsd}')::numeric,0)<>0 then
    raise exception 'El destino debe ser un preliminar posterior del mismo asesor, sin saldo inicial manual.' using errcode='22023';
  end if;
  state:=app_private.commission_collection_state_v1(p_source);
  perform 1 from public.orders where id in (select jsonb_array_elements_text(state->'orderIds')::bigint) order by id for update;
  state:=app_private.commission_collection_state_v1(p_source);
  if (state->>'supported')::boolean is distinct from true or ((state->>'remainingCreditUsd')::numeric=0
    and (state->>'advisorDebtUsd')::numeric=0 and (state->>'customerDebtUsd')::numeric=0) then
    raise exception 'No hay saldo ni cobranza que transferir.' using errcode='22023';
  end if;
  insert into public.advisor_commission_carry_transfers(source_closure_id,destination_closure_id,credit_usd,advisor_debt_usd,order_ids,created_by,reason)
    values(p_source,p_destination,(state->>'remainingCreditUsd')::numeric,(state->>'advisorDebtUsd')::numeric,
      array(select jsonb_array_elements_text(state->'orderIds')::bigint),auth.uid(),btrim(p_reason));
  return state||jsonb_build_object('replayed',false,'destinationClosureId',p_destination);
end;
$fn$;
revoke all on function app_private.transfer_commission_collection_v1(bigint,bigint,text) from public,anon,authenticated,service_role;
grant execute on function app_private.transfer_commission_collection_v1(bigint,bigint,text) to authenticated;
create function public.transfer_commission_collection_v1(p_source bigint,p_destination bigint,p_reason text) returns jsonb
language sql security invoker set search_path='' as $fn$
  select app_private.transfer_commission_collection_v1(p_source,p_destination,p_reason);
$fn$;
revoke all on function public.transfer_commission_collection_v1(bigint,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.transfer_commission_collection_v1(bigint,bigint,text) to authenticated;

create function app_private.confirm_commission_collection_v1(p_closure_id bigint,p_expected_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare c public.advisor_commission_closures%rowtype; state jsonb; stamp timestamptz:=statement_timestamp();
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles r join public.profiles p on p.id=r.user_id
    where r.user_id=auth.uid() and r.role='admin' and p.is_active) then raise exception 'Esta acción requiere administración.' using errcode='42501'; end if;
  select * into c from public.advisor_commission_closures where id=p_closure_id;
  if not found then raise exception 'Liquidación no encontrada.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('commission-advisor:'||c.advisor_user_id::text,0));
  select * into c from public.advisor_commission_closures where id=p_closure_id for update;
  if c.status not in ('preliminary','closed') or c.snapshot is distinct from p_expected_snapshot then
    raise exception 'La liquidación cambió; recarga antes de dar conformidad.' using errcode='22023'; end if;
  if c.status='preliminary' then
    state:=app_private.commission_collection_state_v1(c.id);
    perform 1 from public.orders where id in (select jsonb_array_elements_text(state->'orderIds')::bigint) order by id for update;
    state:=app_private.commission_collection_state_v1(c.id);
    if c.payable_usd is distinct from (state->>'payableUsd')::numeric
      or c.pending_collection_usd is distinct from (state->>'customerDebtUsd')::numeric
      or coalesce((c.snapshot#>>'{settlement,carriedCommissionUsd}')::numeric,0)<>(state->>'carriedCommissionUsd')::numeric
      or coalesce((c.snapshot#>>'{settlement,priorAdvisorDebtUsd}')::numeric,0)<>(state->>'priorAdvisorDebtUsd')::numeric then
      raise exception 'La cobranza o los arrastres cambiaron; actualiza el cálculo antes de confirmar.' using errcode='22023'; end if;
  end if;
  update public.advisor_commission_closures set snapshot=jsonb_set(coalesce(snapshot,'{}'),'{commissionWorkflow}',
    coalesce(snapshot->'commissionWorkflow','{}')||jsonb_build_object('version',1,'conformity',jsonb_build_object(
      'status','confirmed','confirmedAt',stamp,'recordedByUserId',auth.uid(),'source','admin-recorded'))),
    status='closed',closed_at=coalesce(closed_at,stamp),closed_by_user_id=coalesce(closed_by_user_id,auth.uid()),updated_at=stamp
    where id=c.id;
  return jsonb_build_object('closureId',c.id,'confirmed',true);
end;
$fn$;
revoke all on function app_private.confirm_commission_collection_v1(bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function app_private.confirm_commission_collection_v1(bigint,jsonb) to authenticated;
create function public.confirm_commission_collection_v1(p_closure_id bigint,p_expected_snapshot jsonb) returns jsonb
language sql security invoker set search_path='' as $fn$
  select app_private.confirm_commission_collection_v1(p_closure_id,p_expected_snapshot);
$fn$;
revoke all on function public.confirm_commission_collection_v1(bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.confirm_commission_collection_v1(bigint,jsonb) to authenticated;

create function app_private.guard_commission_transfer_evidence_v1() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare state jsonb;
begin
  if old.status='preliminary' and new.status='closed' then
    state:=app_private.commission_collection_state_v1(old.id);
    if new.payable_usd is distinct from (state->>'payableUsd')::numeric
      or new.pending_collection_usd is distinct from (state->>'customerDebtUsd')::numeric
      or coalesce((new.snapshot#>>'{settlement,carriedCommissionUsd}')::numeric,0)<>(state->>'carriedCommissionUsd')::numeric
      or coalesce((new.snapshot#>>'{settlement,priorAdvisorDebtUsd}')::numeric,0)<>(state->>'priorAdvisorDebtUsd')::numeric then
      raise exception 'Actualiza la cobranza y los arrastres antes de conformar el acuerdo.' using errcode='23514';
    end if;
  end if;
  if exists(select 1 from public.advisor_commission_carry_transfers where source_closure_id=old.id)
    and (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then
    raise exception 'El saldo ya fue trasladado: su liquidación de origen conserva la evidencia.' using errcode='23514';
  end if;
  if (new.advisor_user_id,new.period_id) is distinct from (old.advisor_user_id,old.period_id)
    and exists(select 1 from public.advisor_commission_carry_transfers where destination_closure_id=old.id) then
    raise exception 'No se puede reasignar el destino de un arrastre.' using errcode='23514';
  end if;
  return new;
end;
$fn$;
revoke all on function app_private.guard_commission_transfer_evidence_v1() from public,anon,authenticated,service_role;
create trigger guard_commission_transfer_evidence_v1 before update on public.advisor_commission_closures
for each row execute function app_private.guard_commission_transfer_evidence_v1();

-- Amend only the established payment command, preserving idempotency, fees,
-- receipt linkage and the immutable agreed snapshot. Fail if anchors changed.
do $patch$
declare body text; original text;
begin
  original:=pg_get_functiondef('app_private.record_commission_payment_v1(uuid,bigint,bigint,numeric,numeric,numeric,date,text)'::regprocedure);
  body:=replace(original,'select * into v_closure from public.advisor_commission_closures where id=p_closure_id for update;',
    'perform pg_advisory_xact_lock(hashtextextended(''commission-advisor:''||(select advisor_user_id::text from public.advisor_commission_closures where id=p_closure_id),0));
     select * into v_closure from public.advisor_commission_closures where id=p_closure_id for update;');
  body:=replace(body,'v_closure.status<>''closed''','v_closure.status not in (''closed'',''paid'')');
  body:=replace(body,'v_remaining:=round(v_closure.payable_usd-v_paid,2);',
    'perform 1 from public.orders where id in (select jsonb_array_elements_text(app_private.commission_collection_state_v1(p_closure_id)->''orderIds'')::bigint) order by id for update;
     if exists(select 1 from public.advisor_commission_carry_transfers where source_closure_id=p_closure_id) then
       raise exception ''Este saldo se paga en el período al que fue transferido.'' using errcode=''22023''; end if;
     v_remaining:=(app_private.commission_collection_state_v1(p_closure_id)->>''pendingUsd'')::numeric;');
  body:=replace(body,'if v_remaining=0 then','if v_paid+p_amount_usd>=v_closure.payable_usd and v_closure.status<>''paid'' then');
  if body=original or strpos(body,'v_remaining:=round(v_closure.payable_usd-v_paid,2);')>0 or strpos(body,'commission-advisor:')=0
    or strpos(body,'v_closure.status<>''closed''')>0 or strpos(body,'if v_remaining=0 then')>0 then
    raise exception 'El contrato del comando de pagos cambió. Revisa la migración.';
  end if;
  execute body;
  original:=pg_get_functiondef('app_private.guard_commission_payment_evidence_v1()'::regprocedure);
  body:=replace(original,'new.payable_usd=(select','new.payable_usd<=(select');
  if body=original then raise exception 'El contrato de protección cambió.'; end if;
  execute body;
  original:=pg_get_functiondef('app_private.reverse_commission_payment_v1(uuid,uuid,text)'::regprocedure);
  body:=replace(original,'perform 1 from public.advisor_commission_closures where id=v_op.closure_id for update;',
    'perform pg_advisory_xact_lock(hashtextextended(''commission-advisor:''||(select advisor_user_id::text from public.advisor_commission_closures where id=v_op.closure_id),0));
     perform 1 from public.advisor_commission_closures where id=v_op.closure_id for update;
     if exists(select 1 from public.advisor_commission_carry_transfers where source_closure_id=v_op.closure_id) then
       raise exception ''El saldo fue transferido; concilia el destino antes de anular un abono de origen.'' using errcode=''22023''; end if;');
  body:=replace(body,'update public.advisor_commission_closures set status=''closed'',paid_at=null,paid_by_user_id=null where id=v_op.closure_id;',
    'update public.advisor_commission_closures c set status=case when c.payable_usd<=(select coalesce(sum(m.amount_usd_equivalent),0) from public.commission_payment_operations o join public.money_movements m on m.id=o.payment_movement_id where o.closure_id=c.id and m.status=''confirmed'') then ''paid'' else ''closed'' end,
     paid_at=case when c.payable_usd<=(select coalesce(sum(m.amount_usd_equivalent),0) from public.commission_payment_operations o join public.money_movements m on m.id=o.payment_movement_id where o.closure_id=c.id and m.status=''confirmed'') then c.paid_at else null end,
     paid_by_user_id=case when c.payable_usd<=(select coalesce(sum(m.amount_usd_equivalent),0) from public.commission_payment_operations o join public.money_movements m on m.id=o.payment_movement_id where o.closure_id=c.id and m.status=''confirmed'') then c.paid_by_user_id else null end where c.id=v_op.closure_id;');
  if body=original or strpos(body,'commission-advisor:')=0 then raise exception 'El contrato de anulación cambió.'; end if;
  execute body;
end;
$patch$;
notify pgrst,'reload schema';
commit;
