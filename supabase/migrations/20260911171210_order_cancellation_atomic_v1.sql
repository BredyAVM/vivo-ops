-- Version aligned with the migration applied to the linked project.
begin;
set local lock_timeout='5s';
create table public.order_cancellation_operations (
 order_id bigint primary key references public.orders(id),
 request_id uuid not null unique,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 request jsonb not null,
 snapshot jsonb not null,
 result jsonb not null
);
alter table public.order_cancellation_operations enable row level security;
revoke all on public.order_cancellation_operations from public,anon,authenticated,service_role;
grant select on public.order_cancellation_operations to authenticated;
create policy order_cancellation_read on public.order_cancellation_operations for select to authenticated using(public.is_master_or_admin());

create function app_private.preview_order_cancellation_v1(p_order_id bigint) returns jsonb
language plpgsql volatile security definer set search_path='' as $fn$
declare
 v_order public.orders%rowtype; v_cash numeric; v_stored numeric; v_used numeric; v_backed numeric;
 v_money jsonb; v_funds jsonb; v_reports jsonb; v_fingerprint text;
begin
 if auth.uid() is null or not public.is_master_or_admin() then raise exception 'Solo Master/Admin puede cancelar órdenes.' using errcode='42501'; end if;
 select * into v_order from public.orders where id=p_order_id;
 if not found or v_order.status='cancelled' then raise exception 'No se encontró una orden vigente para cancelar.' using errcode='22023'; end if;
 if exists(select 1 from public.money_movements where order_id=p_order_id and status='pending') then
   raise exception 'Hay movimientos de dinero pendientes. Revísalos antes de cancelar para no duplicar una devolución.' using errcode='22023'; end if;
 if exists(select 1 from public.order_change_obligations where order_id=p_order_id and status not in ('completed','cancelled','voided')) then
   raise exception 'Hay una entrega de cambio pendiente. Resuélvela antes de cancelar.' using errcode='22023'; end if;
 if exists(select 1 from public.money_movements m where m.order_id=p_order_id and
   ((m.status not in ('confirmed','voided') and m.confirmed_at is not null) or
    (m.status='confirmed' and not (
      (m.direction='inflow' and m.movement_type='order_payment') or
      (m.direction='outflow' and m.movement_type='change_given') or
      (m.direction='outflow' and m.movement_type='withdrawal' and (
        exists(select 1 from public.client_fund_payout_operations op where op.request_id=m.movement_group_id and op.order_id=p_order_id and op.voided_at is null) or
        exists(select 1 from public.counter_command_receipts r where r.idempotency_key=m.movement_group_id and r.order_id=p_order_id and r.command_type='request_refund') or
        exists(select 1 from public.payment_confirmation_operations op where op.movement_group_id=m.movement_group_id and op.order_id=p_order_id and op.request->>'paymentKind'='retention')
      )))))) then
   raise exception 'La orden tiene movimientos que requieren conciliación antes de cancelar.' using errcode='22023'; end if;
 if exists(select 1 from public.client_fund_movements f where f.order_id=p_order_id and (
   f.client_id is distinct from v_order.client_id or not (
     (f.movement_type='debit' and f.reason_code in ('order_fund_applied','payment_void_fund_reversal')) or
     (f.movement_type='credit' and f.reason_code in ('order_fund_restore','payment_overage_stored','retention_overage_stored')) or
     (f.reason_code in ('client_fund_payout','client_fund_payout_reversal') and exists(select 1 from public.client_fund_payout_operations op where op.request_id=f.movement_group_id and op.order_id=p_order_id)) or
     (f.movement_type='debit' and f.reason_code='counter_change_given' and exists(select 1 from public.counter_command_receipts r where r.idempotency_key=f.movement_group_id and r.order_id=p_order_id and r.command_type='give_order_change' and r.status='completed'))
   ))) then
   raise exception 'El historial de fondo contiene operaciones antiguas sin vínculo suficiente. Requiere conciliación antes de cancelar.' using errcode='22023'; end if;
 select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]') into v_money from public.money_movements m where m.order_id=p_order_id;
 select coalesce(jsonb_agg(to_jsonb(f) order by f.id),'[]') into v_funds from public.client_fund_movements f where f.order_id=p_order_id;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') into v_reports from public.payment_reports r where r.order_id=p_order_id;
 select round(coalesce(sum(case when movement_type='credit' and reason_code in ('payment_overage_stored','retention_overage_stored') then amount_usd
   when movement_type='debit' and reason_code='payment_void_fund_reversal' then -amount_usd else 0 end),0),2),
   round(coalesce(sum(case when movement_type='debit' and reason_code='order_fund_applied' then amount_usd
     when movement_type='credit' and reason_code='order_fund_restore' then -amount_usd else 0 end),0),2)
 into v_stored,v_used from public.client_fund_movements where order_id=p_order_id;
 if not exists(select 1 from public.client_fund_movements where order_id=p_order_id and reason_code in ('order_fund_applied','order_fund_restore')) then
   v_used:=round(coalesce((v_order.extra_fields#>>'{payment,client_fund_used_usd}')::numeric,0),2);
 end if;
 select coalesce(sum(op.fund_debit_usd),0) into v_backed from public.client_fund_payout_operations op where op.order_id=p_order_id and op.voided_at is null;
 select v_backed+coalesce(sum(f.amount_usd),0) into v_backed from public.client_fund_movements f
   where f.order_id=p_order_id and f.reason_code='counter_change_given' and f.movement_type='debit'
   and exists(select 1 from public.money_movements m where m.movement_group_id=f.movement_group_id and m.order_id=p_order_id and m.status='confirmed' and m.movement_type='change_given');
 select round(coalesce(sum(case when direction='inflow' then amount_usd_equivalent else -amount_usd_equivalent end),0)-v_stored+v_backed,2)
 into v_cash from public.money_movements where order_id=p_order_id and status='confirmed';
 if not(v_cash>=0 and v_cash<=1000000000) or not(v_stored>=0 and v_stored<=1000000000) or not(v_used>=0 and v_used<=1000000000) then
   raise exception 'Los importes de la orden no concilian. No se puede cancelar automáticamente.' using errcode='22023'; end if;
 if v_cash+v_used>0 and v_order.client_id is null then raise exception 'La orden tiene dinero, pero no tiene cliente asociado.' using errcode='22023'; end if;
 v_fingerprint:=md5(jsonb_build_object('orderId',v_order.id,'status',v_order.status,'clientId',v_order.client_id,
   'totalUsd',v_order.total_usd,'totalBs',v_order.total_bs_snapshot,
   'pricing',v_order.extra_fields->'pricing','payment',v_order.extra_fields->'payment','money',v_money,'funds',v_funds,'reports',v_reports)::text);
 return jsonb_build_object('orderId',p_order_id,'cashAvailableUsd',v_cash,'fundUsedUsd',v_used,'alreadyStoredUsd',v_stored,
   'fingerprint',v_fingerprint,'money',v_money,'funds',v_funds,'reports',v_reports);
end $fn$;
create function public.preview_order_cancellation_v1(p_order_id bigint) returns jsonb language sql security invoker set search_path=''
as $$select app_private.preview_order_cancellation_v1(p_order_id)-array['money','funds','reports']$$;
revoke all on function app_private.preview_order_cancellation_v1(bigint),public.preview_order_cancellation_v1(bigint) from public,anon,service_role;
grant execute on function app_private.preview_order_cancellation_v1(bigint),public.preview_order_cancellation_v1(bigint) to authenticated;

create function app_private.cancel_order_atomic_v1(p_request_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare
 v_uid uuid:=auth.uid(); v_now timestamptz:=statement_timestamp(); v_order public.orders%rowtype;
 v_prior public.order_cancellation_operations%rowtype; v_snapshot jsonb; v_cash numeric; v_used numeric; v_credit numeric;
 v_lines jsonb:=coalesce(p_input->'refundLines','[]'); v_line jsonb; v_refund numeric:=0; v_reason text:=btrim(p_input->>'reason');
 v_handling text:=p_input->>'paidHandling'; v_account bigint; v_currency public.currency_code; v_amount numeric; v_rate numeric; v_usd numeric;
 v_id bigint; v_ids jsonb:='[]'; v_fund_ids jsonb:='[]'; v_event bigint; v_payload jsonb; v_result jsonb; v_extra jsonb;
begin
 if v_uid is null or not public.is_master_or_admin() then raise exception 'Solo Master/Admin puede cancelar órdenes.' using errcode='42501'; end if;
 if p_request_id is null or jsonb_typeof(p_input) is distinct from 'object' or coalesce(length(v_reason),0) not between 1 and 1000 then
   raise exception 'Indica una orden y un motivo de cancelación válidos.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('order-cancel:'||p_request_id::text,0));
 select * into v_order from public.orders where id=(p_input->>'orderId')::bigint for update;
 if not found then raise exception 'No se encontró la orden.' using errcode='22023'; end if;
 select * into v_prior from public.order_cancellation_operations where order_id=v_order.id or request_id=p_request_id;
 if found then
   if v_prior.order_id<>v_order.id or v_prior.request_id<>p_request_id or v_prior.created_by<>v_uid or v_prior.request<>p_input or v_order.status<>'cancelled' then
     raise exception 'La cancelación ya fue registrada con otra solicitud.' using errcode='22023'; end if;
   return v_prior.result||jsonb_build_object('replayed',true);
 end if;
 if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines)>12 then raise exception 'Líneas de devolución inválidas.' using errcode='22023'; end if;
 perform id from public.money_accounts where id in (
   select money_account_id from public.money_movements where order_id=v_order.id union
   select (value->>'moneyAccountId')::bigint from jsonb_array_elements(v_lines)) order by id for update;
 perform id from public.money_movements where order_id=v_order.id order by id for update;
 perform id from public.payment_reports where order_id=v_order.id order by id for update;
 perform id from public.clients where id=v_order.client_id for update;
 perform id from public.client_fund_movements where order_id=v_order.id order by id for update;
 v_snapshot:=app_private.preview_order_cancellation_v1(v_order.id);
 if p_input->>'fingerprint' is distinct from v_snapshot->>'fingerprint' then raise exception 'El saldo cambió. Actualiza el resumen de cancelación antes de confirmar.' using errcode='22023'; end if;
 v_cash:=(v_snapshot->>'cashAvailableUsd')::numeric; v_used:=(v_snapshot->>'fundUsedUsd')::numeric;
 if v_cash>0 and coalesce(v_handling,'') not in ('store_fund','refund') then raise exception 'Elige devolver el pago o guardarlo en fondo.' using errcode='22023'; end if;
 if (v_handling is distinct from 'refund' and jsonb_array_length(v_lines)>0) or (v_handling='refund' and (v_cash=0 or jsonb_array_length(v_lines)=0)) then
   raise exception 'La devolución no coincide con la opción seleccionada.' using errcode='22023'; end if;
 for v_line in select value from jsonb_array_elements(v_lines) loop
   v_account:=(v_line->>'moneyAccountId')::bigint; v_currency:=(v_line->>'currencyCode')::public.currency_code;
   v_amount:=(v_line->>'amount')::numeric; v_rate:=(v_line->>'exchangeRateVesPerUsd')::numeric;
   if v_currency is null or v_currency not in ('USD','VES') or not exists(select 1 from public.money_accounts where id=v_account and is_active and currency_code=v_currency)
     or v_amount is null or not(v_amount>0 and v_amount<=1000000000) or v_amount<>round(v_amount,2)
     or (v_currency='USD' and v_rate is not null) or (v_currency='VES' and (v_rate is null or not(v_rate>0 and v_rate<=1000000000))) then
     raise exception 'Cuenta, moneda, monto o tasa de devolución inválidos.' using errcode='22023'; end if;
   v_usd:=round(v_amount/coalesce(v_rate,1),2);
   if v_usd<=0 then raise exception 'Monto convertido inválido.' using errcode='22023'; end if;
   v_refund:=v_refund+v_usd;
 end loop;
 if v_refund>v_cash or (coalesce((p_input->>'requireExactRefund')::boolean,false) and v_handling='refund' and v_refund<>v_cash) then
   raise exception 'La devolución debe respetar el disponible de USD %.',v_cash using errcode='22023'; end if;
 v_credit:=v_used+v_cash-v_refund;
 if v_credit>0 then
   update public.clients set fund_balance_usd=round(coalesce(fund_balance_usd,0)+v_credit,2) where id=v_order.client_id;
   if not found then raise exception 'No se pudo restaurar el fondo del cliente.' using errcode='22023'; end if;
   if v_used>0 then
     insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,order_id,reason_code,notes,created_by_user_id,movement_group_id)
     values(v_order.client_id,'credit','USD',v_used,v_used,v_order.id,'order_fund_restore',v_reason,v_uid,p_request_id) returning id into v_id;
     v_fund_ids:=v_fund_ids||jsonb_build_array(v_id);
   end if;
   if v_cash-v_refund>0 then
     insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,order_id,reason_code,notes,created_by_user_id,movement_group_id)
     values(v_order.client_id,'credit','USD',v_cash-v_refund,v_cash-v_refund,v_order.id,'order_cancelled_payment_stored',v_reason,v_uid,p_request_id) returning id into v_id;
     v_fund_ids:=v_fund_ids||jsonb_build_array(v_id);
   end if;
 end if;
 for v_line in select value from jsonb_array_elements(v_lines) loop
   v_account:=(v_line->>'moneyAccountId')::bigint; v_currency:=(v_line->>'currencyCode')::public.currency_code;
   v_amount:=(v_line->>'amount')::numeric; v_rate:=(v_line->>'exchangeRateVesPerUsd')::numeric;
   v_usd:=round(v_amount/coalesce(v_rate,1),2);
   insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,status,approval_required,direction,movement_type,
     money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,description,notes,order_id,movement_group_id)
   values((v_now at time zone 'America/Caracas')::date,v_uid,v_now,v_uid,'confirmed',false,'outflow','withdrawal',v_account,v_currency,v_amount,v_rate,v_usd,
     'Devolución por cancelación · orden '||v_order.id,coalesce(v_line->>'notes',v_reason),v_order.id,p_request_id) returning id into v_id;
   v_ids:=v_ids||jsonb_build_array(v_id);
 end loop;
 update public.payment_reports set status='rejected',reviewed_at=v_now,reviewed_by_user_id=v_uid,
   review_notes=concat_ws(E'\n',review_notes,'Orden cancelada: '||v_reason) where order_id=v_order.id and status='pending';
 v_extra:=case when jsonb_typeof(v_order.extra_fields)='object' then v_order.extra_fields else '{}'::jsonb end;
 v_extra:=jsonb_set(v_extra,'{payment}',(case when jsonb_typeof(v_extra->'payment')='object' then v_extra->'payment' else '{}'::jsonb end)||jsonb_build_object('client_fund_used_usd',0),true);
 v_payload:=jsonb_build_object('reason',v_reason,'paid_handling',v_handling,'confirmed_paid_usd',v_cash,'restored_fund_usd',v_used,
   'already_stored_usd',(v_snapshot->>'alreadyStoredUsd')::numeric,'refund_usd',v_refund,'fund_credit_usd',v_credit,
   'movement_group_id',p_request_id,'movement_ids',v_ids,'fund_movement_ids',v_fund_ids,'previous_status',v_order.status);
 insert into public.order_events(order_id,event_type,event_group,title,message,severity,actor_user_id,payload)
   values(v_order.id,'order_cancelled','approval','Orden cancelada',v_reason,'critical',v_uid,v_payload);
 insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
   values(v_order.id,v_order.order_number,'order_cancelled','approval','Orden cancelada',v_reason,'critical',v_uid,v_payload) returning id into v_event;
 v_result:=jsonb_build_object('orderId',v_order.id,'eventId',v_event,'payload',v_payload,'replayed',false);
 insert into public.order_cancellation_operations(order_id,request_id,created_by,request,snapshot,result)
   values(v_order.id,p_request_id,v_uid,p_input,v_snapshot||jsonb_build_object('order',to_jsonb(v_order)),v_result);
 update public.orders set status='cancelled',review_notes=v_reason,queued_needs_reapproval=false,queued_last_modified_at=null,
   queued_last_modified_by=null,last_modified_at=v_now,last_modified_by=v_uid,extra_fields=v_extra where id=v_order.id;
 return v_result;
end $fn$;
create function public.cancel_order_atomic_v1(p_request_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path=''
as $$select app_private.cancel_order_atomic_v1(p_request_id,p_input)$$;
revoke all on function app_private.cancel_order_atomic_v1(uuid,jsonb),public.cancel_order_atomic_v1(uuid,jsonb) from public,anon,service_role;
grant execute on function app_private.cancel_order_atomic_v1(uuid,jsonb),public.cancel_order_atomic_v1(uuid,jsonb) to authenticated;

-- Certified cancellation freezes its financial basis: old payment/change void
-- buttons must not create a second refund or undo only part of the settlement.
create function app_private.guard_cancelled_order_financials_v1() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare v_id bigint;
begin
 for v_id in select distinct id from unnest(array[case when tg_op<>'INSERT' then old.order_id end,
   case when tg_op<>'DELETE' then new.order_id end]) id where id is not null order by id loop
   perform id from public.orders where id=v_id for update;
   if tg_op='INSERT' and exists(select 1 from public.orders where id=v_id and status='cancelled') then
     raise exception 'No se puede registrar dinero nuevo en una orden cancelada.' using errcode='23514'; end if;
   if exists(select 1 from public.order_cancellation_operations where order_id=v_id) then
     raise exception 'La orden ya tiene una cancelación liquidada. Su dinero no se puede modificar por separado.' using errcode='23514'; end if;
 end loop;
 if tg_op='DELETE' then return old; end if; return new;
end $fn$;
create trigger guard_cancelled_order_money before insert or update or delete on public.money_movements for each row execute function app_private.guard_cancelled_order_financials_v1();
create trigger guard_cancelled_order_reports before insert or update or delete on public.payment_reports for each row execute function app_private.guard_cancelled_order_financials_v1();
create trigger guard_cancelled_order_fund before insert or update or delete on public.client_fund_movements for each row execute function app_private.guard_cancelled_order_financials_v1();
revoke all on function app_private.guard_cancelled_order_financials_v1() from public,anon,authenticated,service_role;
create function app_private.guard_settled_cancelled_order_v1() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin
 -- Only this transaction can create the protected receipt. Allow its initial
 -- status transition, but no later reopening, repricing or client reassignment.
 if old.status<>'cancelled' and new.status='cancelled' then
   if exists(select 1 from public.order_cancellation_operations where order_id=old.id) then return new; end if;
   -- The legacy direct-cancel guard is activated after the UI cutover, so an
   -- old multi-step form cannot credit a fund and then fail its final status.
 end if;
 if exists(select 1 from public.order_cancellation_operations where order_id=old.id) and
   (new.status is distinct from old.status or new.client_id is distinct from old.client_id
    or new.total_usd is distinct from old.total_usd or new.total_bs_snapshot is distinct from old.total_bs_snapshot
    or new.extra_fields->'payment' is distinct from old.extra_fields->'payment'
    or new.extra_fields->'pricing' is distinct from old.extra_fields->'pricing') then
   raise exception 'La cancelación ya está liquidada. No se puede reabrir ni modificar su base financiera.' using errcode='23514';
 end if;
 return new;
end $fn$;
create trigger guard_settled_cancelled_order before update on public.orders for each row execute function app_private.guard_settled_cancelled_order_v1();
revoke all on function app_private.guard_settled_cancelled_order_v1() from public,anon,authenticated,service_role;
commit;
