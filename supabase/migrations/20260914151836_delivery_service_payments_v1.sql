-- Remote migration version: 20260914151836.
begin;
set local lock_timeout='5s';

-- A service payment is not a customer collection/custody settlement.
create table public.delivery_service_payments (
  request_id uuid primary key,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  period_from date not null, period_to date not null,
  responsible_key text not null, responsible_name text not null,
  money_movement_id bigint not null references public.money_movements(id),
  total_usd numeric(16,2) not null check(total_usd>0),
  request jsonb not null, result jsonb not null, evidence jsonb not null,
  voided_at timestamptz, voided_by uuid references auth.users(id), void_reason text,
  check(period_to>=period_from and period_to-period_from<=366)
);
create table public.delivery_service_payment_items (
  order_id bigint primary key references public.orders(id),
  payment_id uuid not null references public.delivery_service_payments(request_id),
  cost_usd numeric(16,2) not null check(cost_usd>=0),
  evidence jsonb not null
);
create index delivery_service_payment_items_payment_idx on public.delivery_service_payment_items(payment_id);
create unique index delivery_service_active_movement_idx on public.delivery_service_payments(money_movement_id) where voided_at is null;
alter table public.delivery_service_payments enable row level security;
alter table public.delivery_service_payment_items enable row level security;
revoke all on public.delivery_service_payments,public.delivery_service_payment_items from public,anon,authenticated,service_role;
grant select on public.delivery_service_payments,public.delivery_service_payment_items to authenticated;
create policy delivery_service_payments_read on public.delivery_service_payments for select to authenticated
  using(exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role='admin'));
create policy delivery_service_payment_items_read on public.delivery_service_payment_items for select to authenticated
  using(exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role='admin'));

-- Current tariffs are proposals, never silently certified historical costs.
create function public.delivery_service_cost_v1(p_order_id bigint)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare o public.orders; v_stored numeric; v_proposal numeric; v_lines jsonb; v_rates jsonb;
  v_distance numeric; v_mode text; v_reason text;
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Solo máster o administración.' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id;
  if not found then raise exception 'Orden no disponible.' using errcode='22023'; end if;
  v_mode:=case when o.external_partner_id is not null then 'external'
    when o.internal_driver_user_id is not null then 'internal' else 'unassigned' end;
  if o.extra_fields#>>'{delivery,cost_usd}' ~ '^[0-9]+([.][0-9]+)?$'
    and length(o.extra_fields#>>'{delivery,cost_usd}')<=24 then
    v_stored:=round((o.extra_fields#>>'{delivery,cost_usd}')::numeric,2);
    if v_stored>999999999.99 then v_stored:=null; end if;
  end if;
  if v_mode='internal' then
    select jsonb_agg(jsonb_build_object('item',i.id,'product',p.id,'qty',i.qty,'rate',p.internal_rider_pay_usd) order by i.id),
      case when count(*)>0 and bool_and(i.qty>0 and p.internal_rider_pay_usd is not null
        and p.internal_rider_pay_usd>=0 and p.internal_rider_pay_usd<=999999999.99)
        then round(sum(i.qty*p.internal_rider_pay_usd),2) end
    into v_lines,v_proposal from public.order_items i join public.products p on p.id=i.product_id
    where i.order_id=o.id and (p.internal_rider_pay_usd is not null or p.name ilike '%delivery%' or i.product_name_snapshot ilike '%delivery%');
    if v_proposal is null then v_reason:='Falta tarifa interna o producto delivery'; end if;
  elsif v_mode='external' then
    if o.extra_fields#>>'{delivery,distance_km}' ~ '^[0-9]+([.][0-9]+)?$'
      and length(o.extra_fields#>>'{delivery,distance_km}')<=12 then
      v_distance:=(o.extra_fields#>>'{delivery,distance_km}')::numeric;
    end if;
    select jsonb_agg(jsonb_build_object('rate',r.id,'partner',r.partner_id,'from',r.km_from,'to',r.km_to,'price',r.price_usd) order by r.id)
    into v_rates from public.delivery_partner_rates r join public.delivery_partners p on p.id=r.partner_id and p.is_active
    where r.partner_id=o.external_partner_id and r.is_active and v_distance>0
      and v_distance>=r.km_from and (r.km_to is null or v_distance<=r.km_to);
    if jsonb_array_length(v_rates)=1 and (v_rates->0->>'price')::numeric between 0 and 999999999.99 then
      v_proposal:=round((v_rates->0->>'price')::numeric,2);
    else v_reason:=case when v_distance is null then 'Falta distancia' else 'Revisar tabulador de la empresa' end; end if;
  end if;
  if v_proposal>999999999.99 then v_proposal:=null; v_reason:='Costo fuera de rango'; end if;
  return jsonb_build_object('stored',v_stored,'proposed',v_proposal,'mode',v_mode,
    'source',o.extra_fields#>>'{delivery,cost_source}','reason',v_reason,
    'basis',case when v_stored is not null then o.extra_fields->'delivery'->'cost_snapshot'
      when v_mode='internal' then v_lines else v_rates end,
    'fingerprint',md5(jsonb_build_object('status',o.status,'fulfillment',o.fulfillment,
      'driver',o.internal_driver_user_id,'partner',o.external_partner_id,
      'stored',v_stored,'delivery',o.extra_fields->'delivery',
      'proposal',case when v_stored is null then v_proposal end,
      'basis',case when v_stored is null then coalesce(v_lines,v_rates) end)::text));
end $$;
revoke all on function public.delivery_service_cost_v1(bigint) from public,anon,service_role;
grant execute on function public.delivery_service_cost_v1(bigint) to authenticated;

create function public.admin_delivery_services_v1(p_from date,p_to date)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_rows jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_to<p_from or p_to-p_from>366 then
    raise exception 'Período inválido.' using errcode='22023'; end if;
  with delivered as (
    select o.*,coalesce(
      case when o.extra_fields#>>'{delivery,confirmed_delivery_date}' ~ '^\d{4}-\d{2}-\d{2}$'
        then (o.extra_fields#>>'{delivery,confirmed_delivery_date}')::date end,
      (e.delivered_at at time zone 'America/Caracas')::date) as service_date
    from public.orders o left join lateral(select max(ev.created_at) delivered_at from public.order_events ev
      where ev.order_id=o.id and ev.event='delivered' and ev.created_at<=statement_timestamp())e on true
    where o.fulfillment='delivery' and o.status='delivered'
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'id',o.id,'orderNumber',coalesce(nullif(o.order_number,''),o.id::text),'client',coalesce(c.full_name,'Cliente'),
    'date',o.service_date,'mode',cost->>'mode',
    'responsibleKey',case when o.external_partner_id is not null then 'external:'||o.external_partner_id::text
      when o.internal_driver_user_id is not null then 'internal:'||o.internal_driver_user_id::text else 'unassigned' end,
    'responsible',coalesce(dp.name,p.full_name,'Sin asignar'),'cost',cost,
    'payment',case when pay.request_id is not null then jsonb_build_object('id',pay.request_id,'movementId',pay.money_movement_id,
      'amountUsd',pi.cost_usd,'date',m.movement_date,'status',m.status) end,
    'legacyPaid',exists(select 1 from public.delivery_trips t where t.order_id=o.id and t.paid_at is not null)
    ) order by o.service_date desc,o.id desc),'[]'::jsonb) into v_rows
  from delivered o left join public.clients c on c.id=o.client_id
    left join public.profiles p on p.id=o.internal_driver_user_id
    left join public.delivery_partners dp on dp.id=o.external_partner_id
    cross join lateral(select public.delivery_service_cost_v1(o.id) cost) costs
    left join public.delivery_service_payment_items pi on pi.order_id=o.id
    left join public.delivery_service_payments pay on pay.request_id=pi.payment_id
    left join public.money_movements m on m.id=pay.money_movement_id
  where o.service_date between p_from and p_to;
  if jsonb_array_length(v_rows)>5000 then raise exception 'Selecciona un período menor (máximo 5000 entregas).'; end if;
  return jsonb_build_object('version',1,'from',p_from,'to',p_to,'asOf',statement_timestamp(),'rows',v_rows);
end $$;
revoke all on function public.admin_delivery_services_v1(date,date) from public,anon,service_role;
grant execute on function public.admin_delivery_services_v1(date,date) to authenticated;

-- A narrowly scoped command owns the payment ledger. Direct table writes stay revoked.
create function app_private.pay_delivery_services_v1(p_request_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_prior public.delivery_service_payments; v_account public.money_accounts;
  v_movement public.money_movements; v_order public.orders; v_row jsonb; v_cost jsonb; v_evidence jsonb:='[]';
  v_report jsonb; v_service jsonb; v_amount numeric; v_total numeric:=0; v_key text; v_name text;
  v_from date:=(p_input->>'from')::date; v_to date:=(p_input->>'to')::date;
  v_date date:=(p_input->>'paymentDate')::date; v_rate numeric:=(p_input->>'rate')::numeric;
  v_native numeric:=(p_input->>'amount')::numeric; v_existing bigint:=(p_input->>'existingMovementId')::bigint;
  v_result jsonb; v_notes text:=nullif(btrim(p_input->>'notes'),'');
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
create function public.pay_delivery_services_v1(p_request_id uuid,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select app_private.pay_delivery_services_v1(p_request_id,p_input); $$;
revoke all on function app_private.pay_delivery_services_v1(uuid,jsonb),public.pay_delivery_services_v1(uuid,jsonb) from public,anon,service_role;
grant execute on function app_private.pay_delivery_services_v1(uuid,jsonb),public.pay_delivery_services_v1(uuid,jsonb) to authenticated;

-- Linked evidence cannot be silently rewritten by older generic money/order screens.
create function app_private.guard_delivery_service_payment_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='money_movements' then
    if exists(select 1 from public.delivery_service_payments where money_movement_id=old.id and voided_at is null) then
      raise exception 'Este egreso está vinculado a pagos de delivery; no puede alterarse por separado.' using errcode='22023'; end if;
  elsif exists(select 1 from public.delivery_service_payment_items where order_id=old.id) then
    if tg_op='DELETE' then raise exception 'La orden tiene un pago de delivery vinculado.' using errcode='22023'; end if;
    if (new.status,new.fulfillment,new.internal_driver_user_id,new.external_partner_id,
      new.extra_fields#>'{delivery,cost_usd}',new.extra_fields#>'{delivery,confirmed_delivery_date}')
      is distinct from (old.status,old.fulfillment,old.internal_driver_user_id,old.external_partner_id,
      old.extra_fields#>'{delivery,cost_usd}',old.extra_fields#>'{delivery,confirmed_delivery_date}') then
      raise exception 'La entrega ya tiene un pago vinculado; conserva su responsable, estado y costo.' using errcode='22023'; end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function app_private.guard_delivery_service_payment_v1() from public,anon,authenticated,service_role;
create trigger guard_delivery_service_money before update or delete on public.money_movements
  for each row execute function app_private.guard_delivery_service_payment_v1();
create trigger guard_delivery_service_order before update or delete on public.orders
  for each row execute function app_private.guard_delivery_service_payment_v1();

-- Reverse the whole accounting registration, never only one of its orders.
-- Linking an existing expense can be undone without voiding that prior expense.
create function app_private.void_delivery_service_payment_v1(p_payment_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_pay public.delivery_service_payments; v_now timestamptz:=statement_timestamp(); v_uid uuid:=auth.uid();
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 6 and 500 then raise exception 'Indica el motivo (6 a 500 caracteres).' using errcode='22023'; end if;
  -- Match the payment command lock order: orders, payment record, movement.
  perform id from public.orders where id in(select order_id from public.delivery_service_payment_items where payment_id=p_payment_id) order by id for update;
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
  delete from public.delivery_service_payment_items where payment_id=p_payment_id;
  return jsonb_build_object('voided',true,'replayed',false);
end $$;
create function public.void_delivery_service_payment_v1(p_payment_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path='' as $$ select app_private.void_delivery_service_payment_v1(p_payment_id,p_reason); $$;
revoke all on function app_private.void_delivery_service_payment_v1(uuid,text),public.void_delivery_service_payment_v1(uuid,text) from public,anon,service_role;
grant execute on function app_private.void_delivery_service_payment_v1(uuid,text),public.void_delivery_service_payment_v1(uuid,text) to authenticated;

create or replace function public.assign_delivery_with_cost_v1(
  p_order_id bigint, p_kind text, p_driver_user_id uuid, p_partner_id bigint,
  p_reference text, p_distance_km numeric, p_cost_usd numeric
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_order public.orders;
  v_snapshot jsonb;
  v_source text;
  v_cost numeric := p_cost_usd;
  v_rates jsonb := '[]'::jsonb;
  v_tariff jsonb;
  v_pending_reason text;
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Only master/admin can assign delivery costs' using errcode='42501';
  end if;
  if p_kind is null or p_kind not in ('internal','external') then
    raise exception 'Invalid delivery type' using errcode='22023';
  end if;
  if p_cost_usd is not null and (p_cost_usd::text in ('NaN','Infinity','-Infinity') or p_cost_usd < 0 or p_cost_usd > 999999999.99) then
    raise exception 'Invalid delivery cost' using errcode='22023';
  end if;
  if p_distance_km is not null and (p_distance_km::text in ('NaN','Infinity','-Infinity') or p_distance_km <= 0 or p_distance_km > 999999) then
    raise exception 'Invalid distance' using errcode='22023';
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found' using errcode='22023'; end if;
  if jsonb_typeof(v_order.extra_fields) <> 'object' then
    raise exception 'Order metadata must be an object' using errcode='22023';
  end if;
  if p_kind='internal' then
    if p_partner_id is not null then raise exception 'Conflicting assignment' using errcode='22023'; end if;
    perform public.assign_internal_driver(p_order_id,p_driver_user_id);
    v_source:='internal_assignment_input';
    if v_cost is null then
      v_tariff:=public.delivery_service_cost_v1(p_order_id);
      v_cost:=(v_tariff->>'proposed')::numeric;
      if v_cost is not null then v_source:='internal_product_tariff_v1'; end if;
      v_tariff:=v_tariff->'basis';
    end if;
  else
    if p_driver_user_id is not null then raise exception 'Conflicting assignment' using errcode='22023'; end if;
    perform public.assign_external_partner(p_order_id,p_partner_id,p_reference);
    v_source:='external_partner_manual_v1';
    if v_cost is null then
      -- One statement captures the matching catalog values at assignment time.
      -- Missing/overlapping ranges are not guessed; manual amounts (including zero) win.
      if p_distance_km is not null then
        select coalesce(jsonb_agg(jsonb_build_object(
          'rate_id',r.id,'partner_id',r.partner_id,'km_from',r.km_from,
          'km_to',r.km_to,'price_usd',r.price_usd)), '[]'::jsonb)
        into v_rates
        from public.delivery_partner_rates r
        join public.delivery_partners p on p.id=r.partner_id and p.is_active
        where r.partner_id=p_partner_id and r.is_active
          and p_distance_km >= r.km_from and (r.km_to is null or p_distance_km <= r.km_to);
      end if;
      if jsonb_array_length(v_rates)=1 then
        v_tariff:=v_rates->0;
        v_cost:=(v_tariff->>'price_usd')::numeric;
        if v_cost is null or v_cost::text in ('NaN','Infinity','-Infinity') or v_cost < 0 or v_cost > 999999999.99 then
          v_cost:=null;
          v_tariff:=null;
          v_pending_reason:='invalid_tariff';
        else
          v_source:='external_partner_tariff_v1';
        end if;
      else
        v_pending_reason:=case when p_distance_km is null then 'missing_distance'
          when jsonb_array_length(v_rates)>1 then 'ambiguous_tariff' else 'no_matching_tariff' end;
      end if;
      if v_cost is null then v_source:='external_partner_pending_v1'; end if;
    end if;
  end if;
  v_snapshot:=jsonb_build_object('version',1,'recorded_at',clock_timestamp(),'recorded_by',auth.uid(),
    'assignment_kind',p_kind,'driver_user_id',p_driver_user_id,'partner_id',p_partner_id,
    'reference',p_reference,'distance_km',case when p_kind='external' then p_distance_km else null end,
    'currency','USD','cost_usd',round(v_cost,2),'source',v_source,
    'cost_status',case when v_cost is null then 'missing' else 'recorded' end,
    'tariff',v_tariff,'pending_reason',v_pending_reason);
  update public.orders set extra_fields=jsonb_set(extra_fields,'{delivery}',
    (extra_fields->'delivery') || jsonb_build_object('cost_usd',round(v_cost,2),
      'cost_source',v_source,'distance_km',v_snapshot->'distance_km','cost_snapshot',v_snapshot))
  where id=p_order_id;
  insert into public.order_events(order_id,event,performed_by,meta)
  values(p_order_id,'delivery_cost_recorded',auth.uid(),jsonb_build_object(
    'snapshot',v_snapshot,'previous_delivery',v_order.extra_fields->'delivery'));
  return v_snapshot;
end;
$$;
revoke all on function public.assign_delivery_with_cost_v1(bigint,text,uuid,bigint,text,numeric,numeric) from public,anon,service_role;
grant execute on function public.assign_delivery_with_cost_v1(bigint,text,uuid,bigint,text,numeric,numeric) to authenticated;

commit;
