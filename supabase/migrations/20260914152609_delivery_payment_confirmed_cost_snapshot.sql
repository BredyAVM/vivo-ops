-- Remote migration version: 20260914152609.
begin;
set local lock_timeout='5s';
-- Freeze explicitly confirmed proposals in the order too, so legacy readers agree after payment.
create or replace function app_private.pay_delivery_services_v1(p_request_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_prior public.delivery_service_payments; v_account public.money_accounts;
  v_movement public.money_movements; v_order public.orders; v_row jsonb; v_cost jsonb; v_evidence jsonb:='[]';
  v_report jsonb; v_service jsonb; v_amount numeric; v_total numeric:=0; v_key text; v_name text;
  v_from date:=(p_input->>'from')::date; v_to date:=(p_input->>'to')::date;
  v_date date:=(p_input->>'paymentDate')::date; v_rate numeric:=(p_input->>'rate')::numeric;
  v_native numeric:=(p_input->>'amount')::numeric; v_existing bigint:=(p_input->>'existingMovementId')::bigint;
  v_result jsonb; v_snapshot jsonb; v_notes text:=nullif(btrim(p_input->>'notes'),'');
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo administración puede registrar pagos de delivery.' using errcode='42501'; end if;
  if p_request_id is null or jsonb_typeof(p_input) is distinct from 'object'
    or jsonb_typeof(p_input->'items') is distinct from 'array' then raise exception 'Solicitud inválida.' using errcode='22023'; end if;
  if jsonb_array_length(p_input->'items') not between 1 and 500 or v_date is null or not isfinite(v_date)
    or v_date>(statement_timestamp() at time zone 'America/Caracas')::date
    or coalesce((p_input->>'confirmedUnpaid')::boolean,false)=false
    or length(coalesce(v_notes,''))>500 or length(coalesce(p_input->>'reference',''))>120 then
    raise exception 'Revisa fecha, selección y confirmación de pagos anteriores.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('delivery-service-payment:'||p_request_id::text,0));
  select * into v_prior from public.delivery_service_payments where request_id=p_request_id;
  if found then
    if v_prior.created_by<>v_uid or v_prior.request<>p_input then raise exception 'Este envío ya se usó con otros datos.' using errcode='22023'; end if;
    if v_prior.voided_at is not null then raise exception 'Ese registro fue anulado; no lo reenvíes.' using errcode='22023'; end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  if (select count(distinct x->>'id') from jsonb_array_elements(p_input->'items')x)<>jsonb_array_length(p_input->'items') then
    raise exception 'Hay órdenes repetidas.' using errcode='22023'; end if;
  -- Lock every order in stable order before recalculating; prevents overlapping periods paying twice.
  perform id from public.orders where id in(select (x->>'id')::bigint from jsonb_array_elements(p_input->'items')x) order by id for update;
  v_report:=public.admin_delivery_services_v1(v_from,v_to);
  for v_row in select x from jsonb_array_elements(p_input->'items')x order by (x->>'id')::bigint loop
    select * into v_order from public.orders where id=(v_row->>'id')::bigint;
    select x into v_service from jsonb_array_elements(v_report->'rows')x where (x->>'id')::bigint=v_order.id;
    if v_service is null or v_service->>'mode'='unassigned' then raise exception 'Una entrega ya no pertenece al período o no tiene responsable.' using errcode='22023'; end if;
    if v_key is null then v_key:=v_service->>'responsibleKey'; v_name:=v_service->>'responsible'; end if;
    if v_key<>v_service->>'responsibleKey' then raise exception 'Selecciona un solo motorizado o empresa por pago.' using errcode='22023'; end if;
    if (v_service->>'legacyPaid')::boolean or exists(select 1 from public.delivery_service_payment_items where order_id=v_order.id) then
      raise exception 'Una entrega ya tiene pago vinculado. Actualiza la consulta.' using errcode='22023'; end if;
    v_cost:=v_service->'cost';
    if v_row->>'fingerprint' is distinct from v_cost->>'fingerprint' then
      raise exception 'Cambió una entrega o tarifa. Actualiza y revisa antes de pagar.' using errcode='40001'; end if;
    v_amount:=coalesce((v_cost->>'stored')::numeric,(v_cost->>'proposed')::numeric);
    if v_amount is null or v_amount<0 or v_amount>999999999.99 then raise exception 'Completa los costos pendientes antes de pagar.' using errcode='22023'; end if;
    if v_cost->>'stored' is null and not coalesce((p_input->>'confirmTariffs')::boolean,false) then
      raise exception 'Confirma que las tarifas propuestas aplican a este período.' using errcode='22023'; end if;
    if v_cost->>'stored' is null then
      v_snapshot:=jsonb_build_object('version',1,'source','admin_payment_tariff_confirmation_v1',
        'currency','USD','cost_usd',v_amount,'recorded_at',statement_timestamp(),'recorded_by',v_uid,
        'assignment_kind',v_service->>'mode','driver_user_id',v_order.internal_driver_user_id,
        'partner_id',v_order.external_partner_id,'tariff',v_cost->'basis','payment_request_id',p_request_id);
      update public.orders set extra_fields=jsonb_set(coalesce(extra_fields,'{}'::jsonb),'{delivery}',
        coalesce(extra_fields->'delivery','{}'::jsonb)||jsonb_build_object('cost_usd',v_amount,
          'cost_source','admin_payment_tariff_confirmation_v1','cost_snapshot',v_snapshot))
      where id=v_order.id;
      insert into public.order_events(order_id,event,performed_by,meta)
      values(v_order.id,'delivery_cost_recorded',v_uid,jsonb_build_object('snapshot',v_snapshot,
        'previous_delivery',v_order.extra_fields->'delivery','reason','Tarifa confirmada al registrar pago de servicios'));
      insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
      values(v_order.id,v_order.order_number,'delivery_cost_recorded','delivery','Costo de delivery confirmado',
        'Tarifa confirmada al registrar pago de servicios','info',v_uid,v_snapshot);
    end if;
    v_total:=v_total+v_amount;
    v_evidence:=v_evidence||jsonb_build_array(jsonb_build_object('id',v_order.id,'cost',v_amount,'service',v_service));
  end loop;
  if v_total<=0 then raise exception 'El pago debe ser mayor a cero.' using errcode='22023'; end if;
  if v_existing is not null then
    select * into v_movement from public.money_movements where id=v_existing for update;
    if not found or v_movement.status<>'confirmed' or v_movement.direction<>'outflow'
      or v_movement.movement_type<>'expense_payment' or v_movement.order_id is not null or v_movement.payment_report_id is not null
      or v_movement.movement_group_id is not null or v_movement.amount_usd_equivalent<>v_total then
      raise exception 'El egreso debe estar confirmado, ser independiente y coincidir exactamente con el total USD.' using errcode='22023'; end if;
    if exists(select 1 from public.delivery_service_payments where money_movement_id=v_existing and voided_at is null) then
      raise exception 'Ese egreso ya está vinculado a otro pago de delivery.' using errcode='22023'; end if;
    if exists(select 1 from public.commission_payment_operations where payment_movement_id=v_existing or fee_movement_id=v_existing) then
      raise exception 'Ese egreso pertenece a comisiones, no a delivery.' using errcode='22023'; end if;
  else
    select * into v_account from public.money_accounts where id=(p_input->>'accountId')::bigint for update;
    if not found or not v_account.is_active or v_account.currency_code not in ('USD','VES') then
      raise exception 'Selecciona una cuenta activa USD o VES.' using errcode='22023'; end if;
    if v_account.currency_code='USD' then v_rate:=null;
    elsif v_rate is null or not(v_rate>0 and v_rate<=1000000000) then raise exception 'Indica la tasa de este pago.' using errcode='22023'; end if;
    if v_native is null or not(v_native>0 and v_native<=1000000000) or round(v_native,2)<>v_native
      or round(v_native/coalesce(v_rate,1),2)<>v_total then
      raise exception 'El monto de la cuenta debe corresponder al total seleccionado.' using errcode='22023'; end if;
    insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,status,approval_required,
      direction,movement_type,money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,
      reference_code,counterparty_name,description,notes,movement_group_id)
    values(v_date,v_uid,statement_timestamp(),v_uid,'confirmed',false,'outflow','expense_payment',v_account.id,
      v_account.currency_code,v_native,v_rate,v_total,nullif(btrim(p_input->>'reference'),''),v_name,
      'Delivery · '||v_from::text||' al '||v_to::text,v_notes,p_request_id) returning * into v_movement;
  end if;
  v_result:=jsonb_build_object('paymentId',p_request_id,'movementId',v_movement.id,'totalUsd',v_total,
    'deliveries',jsonb_array_length(v_evidence),'linkedExisting',v_existing is not null,'replayed',false,
    'paymentDate',v_movement.movement_date,'accountId',v_movement.money_account_id,'currency',v_movement.currency_code,
    'amount',v_movement.amount,'rate',v_movement.exchange_rate_ves_per_usd,'reference',v_movement.reference_code);
  insert into public.delivery_service_payments(request_id,created_by,period_from,period_to,responsible_key,responsible_name,money_movement_id,total_usd,request,result,evidence)
  values(p_request_id,v_uid,v_from,v_to,v_key,v_name,v_movement.id,v_total,p_input,v_result,v_evidence);
  insert into public.delivery_service_payment_items(order_id,payment_id,cost_usd,evidence)
    select (x->>'id')::bigint,p_request_id,(x->>'cost')::numeric,x->'service' from jsonb_array_elements(v_evidence)x;
  return v_result;
end $$;

commit;
