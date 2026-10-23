CREATE OR REPLACE FUNCTION public.admin_delivery_services_v1(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
      'amountUsd',pi.cost_usd,'date',coalesce(m.movement_date,(pay.result->>'paymentDate')::date),'status',coalesce(m.status,'confirmed')) end,
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
end $function$;

CREATE OR REPLACE FUNCTION public.assign_delivery_with_cost_v1(p_order_id bigint, p_kind text, p_driver_user_id uuid, p_partner_id bigint, p_reference text, p_distance_km numeric, p_cost_usd numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.assign_external_partner(p_order_id bigint, p_partner_id bigint, p_reference text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_order public.orders;
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Only master/admin can assign a partner' using errcode='42501';
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.fulfillment <> 'delivery' or v_order.status not in ('confirmed','in_kitchen','ready') then
    raise exception 'Order cannot be assigned in its current state' using errcode='22023';
  end if;
  if p_partner_id is null then raise exception 'Select a partner' using errcode='22023'; end if;
  update public.orders set delivery_mode='external', external_partner_id=p_partner_id,
    external_reference=p_reference, internal_driver_user_id=null,
    external_driver_name=null, external_driver_phone=null,
    extra_fields=jsonb_set(extra_fields,'{delivery}',
      (case when jsonb_typeof(extra_fields->'delivery')='object' then extra_fields->'delivery' else '{}'::jsonb end)
      - 'cost_snapshot' - 'corrected_at' - 'corrected_by' - 'corrected_by_user_id' - 'correction_notes'
      || jsonb_build_object('cost_usd',null,'cost_source',null,'distance_km',null))
  where id=p_order_id;
  insert into public.order_events(order_id,event,performed_by,meta)
  values(p_order_id,'driver_assigned_external',auth.uid(),jsonb_build_object(
    'external_partner_id',p_partner_id,'reference',p_reference,'previous_delivery',v_order.extra_fields->'delivery',
    'previous_driver_user_id',v_order.internal_driver_user_id,'previous_partner_id',v_order.external_partner_id));
  perform public.close_assign_driver_tasks(p_order_id,auth.uid());
end;
$function$;

CREATE OR REPLACE FUNCTION public.assign_internal_driver(p_order_id bigint, p_driver_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_order public.orders;
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Only master/admin can assign a driver' using errcode='42501';
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.fulfillment <> 'delivery' or v_order.status not in ('confirmed','in_kitchen','ready') then
    raise exception 'Order cannot be assigned in its current state' using errcode='22023';
  end if;
  if p_driver_user_id is null then raise exception 'Select a driver' using errcode='22023'; end if;
  update public.orders set delivery_mode='internal', internal_driver_user_id=p_driver_user_id,
    external_partner_id=null, external_driver_name=null, external_driver_phone=null, external_reference=null,
    extra_fields=jsonb_set(extra_fields,'{delivery}',
      (case when jsonb_typeof(extra_fields->'delivery')='object' then extra_fields->'delivery' else '{}'::jsonb end)
      - 'cost_snapshot' - 'corrected_at' - 'corrected_by' - 'corrected_by_user_id' - 'correction_notes'
      || jsonb_build_object('cost_usd',null,'cost_source',null,'distance_km',null))
  where id=p_order_id;
  insert into public.order_events(order_id,event,performed_by,meta)
  values(p_order_id,'driver_assigned_internal',auth.uid(),jsonb_build_object(
    'driver_user_id',p_driver_user_id,'previous_delivery',v_order.extra_fields->'delivery',
    'previous_driver_user_id',v_order.internal_driver_user_id,'previous_partner_id',v_order.external_partner_id));
  perform public.close_assign_driver_tasks(p_order_id,auth.uid());
end;
$function$;

CREATE OR REPLACE FUNCTION public.clear_delivery_assignment(p_order_id bigint, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_order public.orders;
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Only master/admin can clear delivery assignment' using errcode='42501';
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found' using errcode='22023'; end if;
  -- Existing order guards still reject removing an assignment while out/delivered.
  update public.orders set internal_driver_user_id=null, external_partner_id=null,
    external_driver_name=null, external_driver_phone=null, external_reference=null,
    last_modified_at=now(), last_modified_by=auth.uid(),
    review_notes=coalesce(nullif(btrim(p_notes),''),review_notes),
    extra_fields=jsonb_set(extra_fields,'{delivery}',
      (case when jsonb_typeof(extra_fields->'delivery')='object' then extra_fields->'delivery' else '{}'::jsonb end)
      - 'cost_snapshot' - 'corrected_at' - 'corrected_by' - 'corrected_by_user_id' - 'correction_notes'
      || jsonb_build_object('cost_usd',null,'cost_source',null,'distance_km',null))
  where id=p_order_id;
  insert into public.order_events(order_id,event,performed_by,meta)
  values(p_order_id,'delivery_assignment_cleared',auth.uid(),jsonb_build_object(
    'notes',p_notes,'previous_delivery',v_order.extra_fields->'delivery',
    'previous_driver_user_id',v_order.internal_driver_user_id,'previous_partner_id',v_order.external_partner_id));
end;
$function$;

CREATE OR REPLACE FUNCTION public.counter_dispatch_order(p_order_id bigint, p_eta_minutes integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_order_number text;
  v_fulfillment public.fulfillment_type;
  v_status public.order_status;
  v_delivery_mode text;
  v_internal_driver_user_id uuid;
  v_external_partner_id bigint;
  v_advisor_user_id uuid;
  v_event_id bigint;
  v_now timestamptz := now();
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_master_or_admin()
    or public.has_role('counter')
  ) then
    raise exception 'Only Counter or Master/Admin can dispatch an order';
  end if;

  if p_eta_minutes is not null
     and (p_eta_minutes < 1 or p_eta_minutes > 1440) then
    raise exception 'ETA must be between 1 and 1440 minutes';
  end if;

  select
    order_row.order_number,
    order_row.fulfillment,
    order_row.status,
    order_row.delivery_mode::text,
    order_row.internal_driver_user_id,
    order_row.external_partner_id,
    order_row.attributed_advisor_id
  into
    v_order_number,
    v_fulfillment,
    v_status,
    v_delivery_mode,
    v_internal_driver_user_id,
    v_external_partner_id,
    v_advisor_user_id
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment <> 'delivery' then
    raise exception 'Order % is not a delivery order', p_order_id;
  end if;

  if v_status <> 'ready' then
    raise exception 'Order % can only be dispatched from ready', p_order_id;
  end if;

  if v_delivery_mode = 'internal' and v_internal_driver_user_id is null then
    raise exception 'Order % has no internal driver assigned', p_order_id;
  end if;

  if v_delivery_mode = 'external' and v_external_partner_id is null then
    raise exception 'Order % has no external partner assigned', p_order_id;
  end if;

  if v_delivery_mode is null then
    raise exception 'Order % has no delivery assignment', p_order_id;
  end if;

  update public.orders
  set
    status = 'out_for_delivery',
    eta_minutes = p_eta_minutes,
    extra_fields = coalesce(extra_fields, '{}'::jsonb)
      || jsonb_build_object(
        'delivery',
        coalesce(extra_fields -> 'delivery', '{}'::jsonb)
          || jsonb_build_object(
            'eta_minutes', p_eta_minutes,
            'eta_recorded_at', v_now
          )
      )
  where id = p_order_id;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'out_for_delivery',
    v_uid,
    jsonb_build_object(
      'delivery_mode', v_delivery_mode,
      'internal_driver_user_id', v_internal_driver_user_id,
      'external_partner_id', v_external_partner_id,
      'eta_minutes', p_eta_minutes
    )
  );

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  ) values (
    p_order_id,
    v_order_number,
    'out_for_delivery',
    'delivery',
    'Orden en camino',
    case
      when p_eta_minutes is null then 'La orden saliÃ³ en camino.'
      else format('La orden saliÃ³ en camino con ETA de %s min.', p_eta_minutes)
    end,
    'info',
    v_uid,
    jsonb_build_object('delivery_eta_minutes', p_eta_minutes)
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  values (v_event_id, 'master', null, false);

  if v_advisor_user_id is not null then
    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    )
    values (v_event_id, null, v_advisor_user_id, false);
  end if;

  if v_internal_driver_user_id is not null
     and v_internal_driver_user_id is distinct from v_advisor_user_id then
    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    )
    values (v_event_id, null, v_internal_driver_user_id, false);
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delivery_service_cost_v1(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.mark_delivered(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_fulfillment public.fulfillment_type;
  v_status public.order_status;
  v_completed_at timestamptz := now();
begin
  if not public.is_master_or_admin() then
    raise exception 'Only Master/Admin can use the legacy delivery completion command';
  end if;

  select order_row.fulfillment, order_row.status
  into v_fulfillment, v_status
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment = 'delivery' and v_status <> 'out_for_delivery' then
    raise exception 'Delivery order % can only be completed from out_for_delivery', p_order_id;
  elsif v_fulfillment = 'pickup' and v_status <> 'ready' then
    raise exception 'Pickup order % can only be completed from ready', p_order_id;
  elsif v_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Unsupported fulfillment type for order %', p_order_id;
  end if;

  update public.orders
  set
    status = 'delivered',
    extra_fields = coalesce(extra_fields, '{}'::jsonb)
      || jsonb_build_object(
        'delivery',
        coalesce(
          case
            when jsonb_typeof(coalesce(extra_fields, '{}'::jsonb) -> 'delivery') = 'object'
              then coalesce(extra_fields, '{}'::jsonb) -> 'delivery'
            else '{}'::jsonb
          end,
          '{}'::jsonb
        ) || jsonb_build_object('completed_at', v_completed_at)
      )
  where id = p_order_id;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'delivered',
    (select auth.uid()),
    jsonb_build_object(
      'fulfillment', v_fulfillment,
      'delivered_by_role', 'master_or_admin',
      'completed_at', v_completed_at
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.out_for_delivery(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_fulfillment public.fulfillment_type;
  v_delivery_mode text;
  v_internal_driver_user_id uuid;
  v_external_partner_id bigint;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can set out_for_delivery';
  end if;

  -- Leer y validar orden
  select
    o.fulfillment,
    o.delivery_mode::text,
    o.internal_driver_user_id,
    o.external_partner_id
  into
    v_fulfillment,
    v_delivery_mode,
    v_internal_driver_user_id,
    v_external_partner_id
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment <> 'delivery' then
    raise exception 'Order % is not a delivery order', p_order_id;
  end if;

  -- Debe tener asignación válida antes de salir
  if v_delivery_mode = 'internal' and v_internal_driver_user_id is null then
    raise exception 'Order % has delivery_mode=internal but no internal driver assigned', p_order_id;
  end if;

  if v_delivery_mode = 'external' and v_external_partner_id is null then
    raise exception 'Order % has delivery_mode=external but no external partner assigned', p_order_id;
  end if;

  if v_delivery_mode is null then
    raise exception 'Order % has no delivery assignment (delivery_mode is null)', p_order_id;
  end if;

  -- Solo se puede salir a delivery desde READY
  update public.orders
  set status = 'out_for_delivery'
  where id = p_order_id
    and status = 'ready';

  if not found then
    raise exception 'Order % cannot be set out_for_delivery from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'out_for_delivery',
    auth.uid(),
    jsonb_build_object(
      'delivery_mode', v_delivery_mode,
      'internal_driver_user_id', v_internal_driver_user_id,
      'external_partner_id', v_external_partner_id
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_orders_delivery_mode_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Solo aplica a órdenes delivery
  if new.fulfillment = 'delivery' then

    -- ✅ Regla correcta:
    -- delivery_mode SOLO es obligatorio cuando la orden va a salir a ruta (out_for_delivery)
    -- (y opcionalmente cuando ya está delivered, para consistencia).
    if new.status in ('out_for_delivery', 'delivered') then
      if new.delivery_mode is null then
        raise exception 'Delivery orders require delivery_mode (internal/external) before out_for_delivery.';
      end if;

      -- Si es internal, debe haber driver interno asignado
      if new.delivery_mode::text = 'internal' and new.internal_driver_user_id is null then
        raise exception 'Delivery orders with delivery_mode=internal require internal_driver_user_id before out_for_delivery.';
      end if;

      -- Si es external, debe haber partner externo asignado
      if new.delivery_mode::text = 'external' and new.external_partner_id is null then
        raise exception 'Delivery orders with delivery_mode=external require external_partner_id before out_for_delivery.';
      end if;
    end if;

  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_orders_external_partner_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.external_partner_id is not null then
    if new.fulfillment::text <> 'delivery' then
      raise exception
        using message = 'external_partner_id is only allowed when fulfillment = delivery.';
    end if;

    if new.delivery_mode is null or new.delivery_mode::text <> 'external' then
      raise exception
        using message = 'external_partner_id requires delivery_mode = external.';
    end if;

    if new.internal_driver_user_id is not null then
      raise exception
        using message = 'External partner orders must not have internal_driver_user_id.';
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.counter_dispatch_delivery_block2(p_idempotency_key uuid, p_order_id bigint, p_eta_minutes integer DEFAULT NULL::integer, p_expected_collection_lines jsonb DEFAULT '[]'::jsonb, p_cash_change_lines jsonb DEFAULT '[]'::jsonb, p_digital_change_lines jsonb DEFAULT '[]'::jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_order record;
  v_delivery_mode public.delivery_mode;
  v_responsible_name text;
  v_responsible_phone text;
  v_settlement_id bigint;
  v_settlement_status text;
  v_line jsonb;
  v_line_key text;
  v_account_id bigint;
  v_account record;
  v_currency public.currency_code;
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_equiv numeric(12,2);
  v_operation_date date;
  v_movement_id bigint;
  v_entries jsonb := '[]'::jsonb;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_master_or_admin()
    or public.has_role('counter')
  ) then
    raise exception 'Only Counter or Master/Admin can dispatch a delivery';
  end if;

  if p_eta_minutes is not null
     and (p_eta_minutes < 1 or p_eta_minutes > 1440) then
    raise exception 'ETA must be between 1 and 1440 minutes';
  end if;

  p_expected_collection_lines := coalesce(p_expected_collection_lines, '[]'::jsonb);
  p_cash_change_lines := coalesce(p_cash_change_lines, '[]'::jsonb);
  p_digital_change_lines := coalesce(p_digital_change_lines, '[]'::jsonb);

  if jsonb_typeof(p_expected_collection_lines) <> 'array'
     or jsonb_array_length(p_expected_collection_lines) > 12
     or jsonb_typeof(p_cash_change_lines) <> 'array'
     or jsonb_array_length(p_cash_change_lines) > 12
     or jsonb_typeof(p_digital_change_lines) <> 'array'
     or jsonb_array_length(p_digital_change_lines) > 12 then
    raise exception 'Delivery settlement lines must be arrays with at most 12 lines each';
  end if;

  if exists (
    select 1
    from (
      select nullif(btrim(line ->> 'line_key'), '') as line_key, count(*) as uses
      from (
        select line from jsonb_array_elements(p_expected_collection_lines) line
        union all
        select line from jsonb_array_elements(p_cash_change_lines) line
        union all
        select line from jsonb_array_elements(p_digital_change_lines) line
      ) combined
      group by nullif(btrim(line ->> 'line_key'), '')
    ) keys
    where keys.line_key is null or keys.uses > 1
  ) then
    raise exception 'Every dispatch settlement line requires a unique non-empty line_key';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'eta_minutes', p_eta_minutes,
    'expected_collection_lines', p_expected_collection_lines,
    'cash_change_lines', p_cash_change_lines,
    'digital_change_lines', p_digital_change_lines,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'dispatch_delivery',
    p_order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select
    order_row.id,
    order_row.order_number,
    order_row.fulfillment,
    order_row.status,
    order_row.delivery_mode,
    order_row.internal_driver_user_id,
    order_row.external_partner_id,
    order_row.external_driver_name,
    order_row.external_driver_phone,
    order_row.attributed_advisor_id,
    order_row.extra_fields
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.fulfillment <> 'delivery' then
    raise exception 'Only a delivery order can be dispatched';
  end if;

  if v_order.status <> 'ready' then
    raise exception 'Delivery can only be dispatched from ready';
  end if;

  v_delivery_mode := v_order.delivery_mode;
  if v_delivery_mode = 'internal' then
    if v_order.internal_driver_user_id is null then
      raise exception 'Delivery has no internal driver assigned';
    end if;

    select profile.full_name
    into v_responsible_name
    from public.profiles profile
    where profile.id = v_order.internal_driver_user_id;

    v_responsible_name := coalesce(
      nullif(btrim(v_responsible_name), ''),
      'Motorizado interno'
    );
  elsif v_delivery_mode = 'external' then
    select partner.name
    into v_responsible_name
    from public.delivery_partners partner
    where partner.id = v_order.external_partner_id;

    v_responsible_name := coalesce(
      nullif(btrim(v_order.external_driver_name), ''),
      nullif(btrim(v_responsible_name), ''),
      'Motorizado externo'
    );
    v_responsible_phone := nullif(btrim(v_order.external_driver_phone), '');
  else
    raise exception 'Delivery has no valid internal or external assignment';
  end if;

  if exists (
    select 1
    from public.delivery_settlements settlement
    where settlement.order_id = p_order_id
  ) then
    raise exception 'Delivery settlement already exists for this order';
  end if;

  for v_account_id in
    select distinct (line ->> 'money_account_id')::bigint
    from jsonb_array_elements(p_cash_change_lines) line
    order by (line ->> 'money_account_id')::bigint
  loop
    perform account.id
    from public.money_accounts account
    where account.id = v_account_id
    for update;

    if not found then
      raise exception 'Money account % not found', v_account_id;
    end if;
  end loop;

  insert into public.delivery_settlements (
    order_id,
    status,
    delivery_mode,
    responsible_user_id,
    responsible_partner_id,
    responsible_name,
    responsible_phone,
    dispatched_by_user_id,
    dispatched_at,
    notes
  ) values (
    p_order_id,
    'open',
    v_delivery_mode,
    case when v_delivery_mode = 'internal' then v_order.internal_driver_user_id else null end,
    case when v_delivery_mode = 'external' then v_order.external_partner_id else null end,
    v_responsible_name,
    v_responsible_phone,
    v_uid,
    v_now,
    nullif(btrim(p_notes), '')
  )
  returning id into v_settlement_id;

  for v_line in
    select line
    from jsonb_array_elements(p_expected_collection_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
      currency_code,
      amount,
      exchange_rate_ves_per_usd,
      amount_usd_equivalent,
      reference_code,
      notes,
      created_by_user_id
    ) values (
      v_settlement_id,
      'expected_collection',
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'expected_collection',
      'currency_code', v_currency,
      'amount', v_amount
    ));
  end loop;

  for v_line in
    select line
    from jsonb_array_elements(p_digital_change_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
      currency_code,
      amount,
      exchange_rate_ves_per_usd,
      amount_usd_equivalent,
      reference_code,
      notes,
      created_by_user_id
    ) values (
      v_settlement_id,
      'digital_change_due',
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'digital_change_due',
      'currency_code', v_currency,
      'amount', v_amount
    ));
  end loop;

  for v_line in
    select line
    from jsonb_array_elements(p_cash_change_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_account_id := (v_line ->> 'money_account_id')::bigint;
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_operation_date := coalesce(
      nullif(btrim(v_line ->> 'operation_date'), '')::date,
      (v_now at time zone 'America/Caracas')::date
    );

    select account.*
    into v_account
    from public.money_accounts account
    where account.id = v_account_id;

    if not v_account.is_active
       or v_account.currency_code <> v_currency
       or v_account.account_kind <> 'cash'
       or not public.is_counter_direct_money_account(v_account_id) then
      raise exception 'Cash change account % is not an active direct Counter cash account', v_account_id;
    end if;

    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    insert into public.money_movements (
      movement_date,
      created_by_user_id,
      confirmed_at,
      confirmed_by_user_id,
      status,
      approval_required,
      approval_required_reason,
      direction,
      movement_type,
      money_account_id,
      currency_code,
      amount,
      exchange_rate_ves_per_usd,
      amount_usd_equivalent,
      reference_code,
      counterparty_name,
      description,
      notes,
      order_id,
      payment_report_id,
      movement_group_id
    ) values (
      v_operation_date,
      v_uid,
      v_now,
      v_uid,
      'confirmed',
      false,
      null,
      'outflow',
      'change_given',
      v_account_id,
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      v_responsible_name,
      format('Cambio en custodia para delivery %s', v_order.order_number),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      p_order_id,
      null,
      p_idempotency_key
    )
    returning id into v_movement_id;

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
      currency_code,
      amount,
      exchange_rate_ves_per_usd,
      amount_usd_equivalent,
      money_account_id,
      money_movement_id,
      operation_date,
      reference_code,
      notes,
      created_by_user_id
    ) values (
      v_settlement_id,
      'cash_change_out',
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      v_account_id,
      v_movement_id,
      v_operation_date,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'cash_change_out',
      'currency_code', v_currency,
      'amount', v_amount,
      'movement_id', v_movement_id
    ));
  end loop;

  update public.orders
  set
    status = 'out_for_delivery',
    eta_minutes = p_eta_minutes,
    extra_fields = coalesce(extra_fields, '{}'::jsonb)
      || jsonb_build_object(
        'delivery',
        coalesce(extra_fields -> 'delivery', '{}'::jsonb)
          || jsonb_build_object(
            'eta_minutes', p_eta_minutes,
            'eta_recorded_at', v_now,
            'settlement_id', v_settlement_id
          )
      )
  where id = p_order_id;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'out_for_delivery',
    v_uid,
    jsonb_build_object(
      'delivery_mode', v_delivery_mode,
      'responsible_name', v_responsible_name,
      'eta_minutes', p_eta_minutes,
      'delivery_settlement_id', v_settlement_id,
      'idempotency_key', p_idempotency_key
    )
  );

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  ) values (
    p_order_id,
    v_order.order_number,
    'out_for_delivery',
    'delivery',
    'Orden en camino',
    case
      when p_eta_minutes is null
        then format('La orden salio con %s.', v_responsible_name)
      else format(
        'La orden salio con %s y ETA de %s min.',
        v_responsible_name,
        p_eta_minutes
      )
    end,
    'info',
    v_uid,
    jsonb_build_object(
      'delivery_settlement_id', v_settlement_id,
      'delivery_eta_minutes', p_eta_minutes,
      'settlement_entries', v_entries
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  ) values (
    v_event_id,
    'master',
    null,
    false
  );

  if v_order.attributed_advisor_id is not null then
    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    ) values (
      v_event_id,
      null,
      v_order.attributed_advisor_id,
      false
    );
  end if;

  if v_order.internal_driver_user_id is not null
     and v_order.internal_driver_user_id is distinct from v_order.attributed_advisor_id then
    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    ) values (
      v_event_id,
      null,
      v_order.internal_driver_user_id,
      false
    );
  end if;

  if jsonb_array_length(p_expected_collection_lines) = 0
     and jsonb_array_length(p_cash_change_lines) = 0 then
    update public.delivery_settlements
    set
      collection_finalized_by_user_id = v_uid,
      collection_finalized_at = v_now,
      updated_at = v_now
    where id = v_settlement_id;
  end if;

  v_settlement_status := public.counter_refresh_delivery_settlement_status(
    v_settlement_id,
    v_uid
  );

  v_result := jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_status', 'out_for_delivery',
    'delivery_settlement_id', v_settlement_id,
    'settlement_status', v_settlement_status,
    'entries', v_entries
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;
