-- Remote migration version: 20260914180507.
begin;
set local lock_timeout='5s';

-- Standalone errands are remuneration, never orders, sales, inventory or customer collections.
create table public.delivery_extra_services (
  id uuid primary key,
  responsible_key text not null,
  responsible_name text not null,
  service_date date not null check(isfinite(service_date)),
  concept text not null check(length(btrim(concept)) between 3 and 200),
  amount_usd numeric(16,2) not null check(amount_usd>0 and amount_usd<=999999999.99),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  request jsonb not null,
  payment_id uuid references public.delivery_service_payments(request_id),
  voided_at timestamptz, voided_by uuid references auth.users(id), void_reason text,
  check(payment_id is null or voided_at is null)
);
create index delivery_extra_services_period on public.delivery_extra_services(service_date,responsible_key);
create index delivery_extra_services_payment on public.delivery_extra_services(payment_id) where payment_id is not null;
create index delivery_extra_services_creator on public.delivery_extra_services(created_by);
create index delivery_extra_services_voider on public.delivery_extra_services(voided_by) where voided_by is not null;
alter table public.delivery_extra_services enable row level security;
revoke all on public.delivery_extra_services from public,anon,authenticated,service_role;
grant select on public.delivery_extra_services to authenticated;
create policy delivery_extra_services_admin_read on public.delivery_extra_services for select to authenticated
  using(exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role='admin'));

create function public.admin_delivery_extras_v1(p_from date,p_to date)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_rows jsonb; v_payees jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_to<p_from or p_to-p_from>366 then
    raise exception 'Período inválido.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'responsibleKey',e.responsible_key,'responsible',e.responsible_name,
    'date',e.service_date,'concept',e.concept,'amount',e.amount_usd,'paymentId',e.payment_id,
    'voided',e.voided_at is not null,'voidReason',e.void_reason,
    'fingerprint',md5(jsonb_build_array(e.id,e.responsible_key,e.service_date,e.concept,e.amount_usd,e.payment_id,e.voided_at)::text))
    order by e.service_date desc,e.created_at desc),'[]'::jsonb) into v_rows
  from public.delivery_extra_services e where service_date between p_from and p_to;
  if jsonb_array_length(v_rows)>5000 then raise exception 'Selecciona un período menor (máximo 5000 servicios adicionales).'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('key',q.key,'name',q.name) order by q.name),'[]'::jsonb) into v_payees from (
    select 'internal:'||p.user_id::text key,p.full_name name from public.get_driver_profiles() p where p.is_active
    union all select 'external:'||id::text,name from public.delivery_partners where is_active
  )q;
  return jsonb_build_object('version',1,'from',p_from,'to',p_to,'rows',v_rows,'payees',v_payees);
end $$;

create function app_private.create_delivery_extra_v1(p_request_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_old public.delivery_extra_services; v_name text;
  v_key text:=p_input->>'responsibleKey'; v_date date:=(p_input->>'date')::date;
  v_amount numeric:=(p_input->>'amount')::numeric; v_concept text:=btrim(p_input->>'concept');
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo administración puede registrar servicios adicionales.' using errcode='42501'; end if;
  if p_request_id is null or jsonb_typeof(p_input) is distinct from 'object' or v_date is null or not isfinite(v_date)
    or v_date>(statement_timestamp() at time zone 'America/Caracas')::date or v_amount is null
    or not(v_amount>0 and v_amount<=999999999.99) or round(v_amount,2)<>v_amount
    or v_concept is null or length(v_concept) not between 3 and 200 then
    raise exception 'Revisa fecha, concepto e importe (máximo dos decimales).' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('delivery-extra:'||p_request_id::text,0));
  select * into v_old from public.delivery_extra_services where id=p_request_id;
  if found then
    if v_old.created_by<>v_uid or v_old.request<>p_input then raise exception 'Este envío ya se usó con otros datos.' using errcode='22023'; end if;
    if v_old.voided_at is not null then raise exception 'El servicio fue anulado.' using errcode='22023'; end if;
    return jsonb_build_object('id',v_old.id,'replayed',true);
  end if;
  -- Use the existing internal-driver role and external partner catalogs, including payees with no orders this week.
  if v_key like 'internal:%' then
    select full_name into v_name from public.profiles p where 'internal:'||p.id::text=v_key and p.is_active
      and exists(select 1 from public.user_roles where user_id=p.id and role='driver');
  elsif v_key like 'external:%' then
    select name into v_name from public.delivery_partners where 'external:'||id::text=v_key and is_active;
  end if;
  if v_name is null then raise exception 'Selecciona un motorizado o empresa activa.' using errcode='22023'; end if;
  insert into public.delivery_extra_services(id,responsible_key,responsible_name,service_date,concept,amount_usd,created_by,request)
    values(p_request_id,v_key,v_name,v_date,v_concept,v_amount,v_uid,p_input);
  return jsonb_build_object('id',p_request_id,'replayed',false);
end $$;
create function public.create_delivery_extra_v1(p_request_id uuid,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select app_private.create_delivery_extra_v1(p_request_id,p_input); $$;

create function app_private.void_delivery_extra_v1(p_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_extra public.delivery_extra_services; v_uid uuid:=auth.uid();
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 6 and 500 then raise exception 'Indica el motivo (6 a 500 caracteres).' using errcode='22023'; end if;
  select * into v_extra from public.delivery_extra_services where id=p_id for update;
  if not found then raise exception 'Servicio no encontrado.' using errcode='22023'; end if;
  if v_extra.payment_id is not null then raise exception 'Anula primero la liquidación que incluye este servicio.' using errcode='22023'; end if;
  if v_extra.voided_at is not null then return jsonb_build_object('voided',true,'replayed',true); end if;
  update public.delivery_extra_services set voided_at=statement_timestamp(),voided_by=v_uid,void_reason=btrim(p_reason) where id=p_id;
  return jsonb_build_object('voided',true,'replayed',false);
end $$;
create function public.void_delivery_extra_v1(p_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path='' as $$ select app_private.void_delivery_extra_v1(p_id,p_reason); $$;
revoke all on function public.admin_delivery_extras_v1(date,date),
  app_private.create_delivery_extra_v1(uuid,jsonb),public.create_delivery_extra_v1(uuid,jsonb),
  app_private.void_delivery_extra_v1(uuid,text),public.void_delivery_extra_v1(uuid,text) from public,anon,service_role;
grant execute on function public.admin_delivery_extras_v1(date,date),
  app_private.create_delivery_extra_v1(uuid,jsonb),public.create_delivery_extra_v1(uuid,jsonb),
  app_private.void_delivery_extra_v1(uuid,text),public.void_delivery_extra_v1(uuid,text) to authenticated;

create or replace function app_private.pay_delivery_services_v1(p_request_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_prior public.delivery_service_payments; v_account public.money_accounts;
  v_movement public.money_movements; v_order public.orders; v_row jsonb; v_cost jsonb; v_evidence jsonb:='[]';
  v_report jsonb; v_service jsonb; v_amount numeric; v_total numeric:=0; v_key text; v_name text;
  v_from date:=(p_input->>'from')::date; v_to date:=(p_input->>'to')::date;
  v_date date:=(p_input->>'paymentDate')::date; v_rate numeric:=(p_input->>'rate')::numeric;
  v_native numeric:=(p_input->>'amount')::numeric; v_existing bigint:=(p_input->>'existingMovementId')::bigint;
  v_extra public.delivery_extra_services; v_extras jsonb:=coalesce(p_input->'extras','[]'::jsonb);
  v_extra_evidence jsonb:='[]'; v_order_total numeric:=0; v_extra_total numeric:=0;
  v_result jsonb; v_snapshot jsonb; v_notes text:=nullif(btrim(p_input->>'notes'),'');
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo administración puede registrar pagos de delivery.' using errcode='42501'; end if;
  if p_request_id is null or jsonb_typeof(p_input) is distinct from 'object'
    or jsonb_typeof(p_input->'items') is distinct from 'array' or jsonb_typeof(v_extras) is distinct from 'array' then raise exception 'Solicitud inválida.' using errcode='22023'; end if;
  if jsonb_array_length(p_input->'items')+jsonb_array_length(v_extras) not between 1 and 500 or v_date is null or not isfinite(v_date)
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
  perform id from public.delivery_extra_services where id in(select (x->>'id')::uuid from jsonb_array_elements(v_extras)x) order by id for update;
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
  v_order_total:=v_total;
  if (select count(distinct x->>'id') from jsonb_array_elements(v_extras)x)<>jsonb_array_length(v_extras) then
    raise exception 'Hay servicios adicionales repetidos.' using errcode='22023'; end if;
  for v_row in select x from jsonb_array_elements(v_extras)x order by x->>'id' loop
    select * into v_extra from public.delivery_extra_services where id=(v_row->>'id')::uuid;
    if not found or v_extra.voided_at is not null or v_extra.payment_id is not null
      or v_extra.service_date not between v_from and v_to then
      raise exception 'Un servicio adicional no pertenece al período, fue anulado o ya está pagado.' using errcode='22023'; end if;
    if v_key is null then v_key:=v_extra.responsible_key; v_name:=v_extra.responsible_name; end if;
    if v_key<>v_extra.responsible_key then raise exception 'Selecciona un solo motorizado o empresa por pago.' using errcode='22023'; end if;
    if v_row->>'fingerprint' is distinct from md5(jsonb_build_array(v_extra.id,v_extra.responsible_key,v_extra.service_date,
      v_extra.concept,v_extra.amount_usd,v_extra.payment_id,v_extra.voided_at)::text) then
      raise exception 'Cambió un servicio adicional. Actualiza antes de pagar.' using errcode='40001'; end if;
    v_extra_total:=v_extra_total+v_extra.amount_usd;
    v_extra_evidence:=v_extra_evidence||jsonb_build_array(jsonb_build_object('id',v_extra.id,
      'date',v_extra.service_date,'concept',v_extra.concept,'amount',v_extra.amount_usd,'responsible',v_extra.responsible_name));
  end loop;
  v_total:=v_total+v_extra_total;
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
    'deliveries',jsonb_array_length(v_evidence),'orderTotalUsd',v_order_total,'extraTotalUsd',v_extra_total,'extras',v_extra_evidence,'linkedExisting',v_existing is not null,'replayed',false,
    'paymentDate',v_movement.movement_date,'accountId',v_movement.money_account_id,'currency',v_movement.currency_code,
    'amount',v_movement.amount,'rate',v_movement.exchange_rate_ves_per_usd,'reference',v_movement.reference_code);
  insert into public.delivery_service_payments(request_id,created_by,period_from,period_to,responsible_key,responsible_name,money_movement_id,total_usd,request,result,evidence)
  values(p_request_id,v_uid,v_from,v_to,v_key,v_name,v_movement.id,v_total,p_input,v_result,v_evidence);
  insert into public.delivery_service_payment_items(order_id,payment_id,cost_usd,evidence)
    select (x->>'id')::bigint,p_request_id,(x->>'cost')::numeric,x->'service' from jsonb_array_elements(v_evidence)x;
  update public.delivery_extra_services set payment_id=p_request_id
    where id in(select (x->>'id')::uuid from jsonb_array_elements(v_extras)x);
  return v_result;
end $$;


create or replace function app_private.void_delivery_service_payment_v1(p_payment_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_pay public.delivery_service_payments; v_now timestamptz:=statement_timestamp(); v_uid uuid:=auth.uid();
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 6 and 500 then raise exception 'Indica el motivo (6 a 500 caracteres).' using errcode='22023'; end if;
  -- Match the payment command lock order: orders, payment record, movement.
  perform id from public.orders where id in(select order_id from public.delivery_service_payment_items where payment_id=p_payment_id) order by id for update;
  perform id from public.delivery_extra_services where payment_id=p_payment_id order by id for update;
  select * into v_pay from public.delivery_service_payments where request_id=p_payment_id for update;
  if not found then raise exception 'Pago no encontrado.' using errcode='22023'; end if;
  if v_pay.voided_at is not null then return jsonb_build_object('voided',true,'replayed',true); end if;
  perform id from public.money_movements where id=v_pay.money_movement_id for update;
  update public.delivery_service_payments set voided_at=v_now,voided_by=v_uid,void_reason=btrim(p_reason) where request_id=p_payment_id;
  if not (v_pay.result->>'linkedExisting')::boolean then
    update public.money_movements set status='voided',voided_at=v_now,voided_by_user_id=v_uid,void_reason=btrim(p_reason)
    where id=v_pay.money_movement_id;
  end if;
  -- Complete evidence stays immutable in the parent record; release only active claims.
  update public.delivery_extra_services set payment_id=null where payment_id=p_payment_id;
  delete from public.delivery_service_payment_items where payment_id=p_payment_id;
  return jsonb_build_object('voided',true,'replayed',false);
end $$;

commit;
