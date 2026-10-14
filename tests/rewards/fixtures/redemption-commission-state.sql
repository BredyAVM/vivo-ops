CREATE OR REPLACE FUNCTION app_private.commission_collection_state_v1(p_closure_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$

;
