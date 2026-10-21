-- Completed orders can gain a credit after an administrative price/fulfillment
-- correction. Keep Master's pre-handoff scope; only Admin can resolve after delivery.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$ begin
  if (select md5(replace(prosrc,chr(13),'')) from pg_proc
      where oid='public.store_operational_order_excess_v1(bigint,text)'::regprocedure)
      is distinct from 'e1a32403622afc9cc82cb94ee92b201c' then
    raise exception 'Excess resolver changed; review before replacing its implementation';
  end if;
end $$;

create or replace function public.store_operational_order_excess_v1(p_order_id bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_state record; v_excess numeric; v_id bigint;
  v_payment record; v_remaining numeric; v_credit numeric; v_ids jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Solo Máster o Administración puede resolver este excedente.' using errcode='42501';
  end if;
  if length(btrim(coalesce(p_reason,'')))<4 then raise exception 'Indica el motivo del saldo a favor.'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.client_id is null or not (
    v_order.status::text in ('created','queued','confirmed','in_kitchen','ready')
    or (v_order.status::text='delivered' and public.has_role('admin'))
  ) then
    raise exception 'La orden ya no admite esta resolución operativa.';
  end if;
  perform id from public.clients where id=v_order.client_id for update;
  select * into v_state from public.get_order_financial_state(p_order_id,null,null);
  v_excess := greatest(0,round(coalesce(v_state.overpaid_usd,0)-coalesce((select sum(amount_usd_equivalent)
    from public.order_change_obligations where order_id=p_order_id and status='pending'),0)
    -coalesce((select sum(amount_usd_equivalent) from public.money_movements where order_id=p_order_id
      and direction='outflow' and movement_type='withdrawal' and status='pending'),0),2));
  if v_excess<=0 then return jsonb_build_object('ok',true,'amountUsd',0); end if;
  -- Keep report ownership for canonical payment-void reversal and retain both
  -- order/client locks: concurrent requests cannot credit the same excess twice.
  v_remaining := v_excess;
  for v_payment in
    select m.payment_report_id,
      greatest(0,round(sum(case when m.direction='inflow' then m.amount_usd_equivalent else -m.amount_usd_equivalent end)
        -coalesce((select sum(case when f.movement_type='credit' then f.amount_usd else -f.amount_usd end)
          from public.client_fund_movements f where f.order_id=p_order_id and f.payment_report_id=m.payment_report_id
          and f.reason_code in ('payment_overage_stored','retention_overage_stored','payment_void_fund_reversal')),0),2)) as available_usd
    from public.money_movements m where m.order_id=p_order_id and m.status='confirmed'
      and m.payment_report_id is not null and m.movement_type in ('order_payment','change_given')
    group by m.payment_report_id order by m.payment_report_id desc
  loop
    v_credit := least(v_remaining,v_payment.available_usd);
    if v_credit<=0 then continue; end if;
    insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,
      order_id,payment_report_id,reason_code,notes,created_by_user_id)
    values(v_order.client_id,'credit','USD',v_credit,v_credit,p_order_id,v_payment.payment_report_id,
      'payment_overage_stored',btrim(p_reason),auth.uid()) returning id into v_id;
    v_ids := v_ids || jsonb_build_array(v_id);
    v_remaining := round(v_remaining-v_credit,2);
    exit when v_remaining<=0;
  end loop;
  if v_remaining>0 then
    raise exception 'El excedente no tiene reportes de pago suficientes para conciliarlo. No se guardó nada; revisa sus pagos.' using errcode='22023';
  end if;
  update public.clients set fund_balance_usd=round(coalesce(fund_balance_usd,0)+v_excess,2) where id=v_order.client_id;
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,actor_user_id,payload)
  values(p_order_id,v_order.order_number,'order_edit_excess_stored','payment','Saldo a favor guardado en fondo',btrim(p_reason),auth.uid(),
    jsonb_build_object('amount_usd',v_excess,'fund_movement_ids',v_ids));
  return jsonb_build_object('ok',true,'amountUsd',v_excess,'fundMovementIds',v_ids);
end;
$$;
revoke all on function public.store_operational_order_excess_v1(bigint,text) from public,anon;
grant execute on function public.store_operational_order_excess_v1(bigint,text) to authenticated;
commit;
