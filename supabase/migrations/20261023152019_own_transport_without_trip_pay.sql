begin;
set local lock_timeout='5s';

-- Named transport without a per-trip supplier/account. The existing external
-- carrier-name storage is reused; the explicit subtype distinguishes own fleet.
create or replace function public.is_own_transport_v1(o public.orders)
returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(o.fulfillment::text='delivery' and o.delivery_mode::text='external'
    and o.internal_driver_user_id is null and o.external_partner_id is null
    and nullif(btrim(o.external_driver_name),'') is not null
    and o.extra_fields #>> '{delivery,own_transport,version}'='1'
    and o.extra_fields #>> '{delivery,own_transport,name}'=o.external_driver_name
    and o.extra_fields #>> '{delivery,cost_source}'='own_transport_v1'
    and o.extra_fields #> '{delivery,cost_usd}'='0'::jsonb,false);
$$;
revoke all on function public.is_own_transport_v1(public.orders) from public,anon;
grant execute on function public.is_own_transport_v1(public.orders) to authenticated,service_role;

create or replace function app_private.guard_own_transport_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_changed boolean;
begin
  if tg_op='INSERT' then
    if coalesce(new.extra_fields->'delivery','{}') ? 'own_transport' then
      raise exception 'Asigna transporte propio desde la orden ya creada.' using errcode='42501';
    end if;
    return new;
  end if;
  if not (coalesce(new.extra_fields->'delivery','{}') ? 'own_transport')
    and not (coalesce(old.extra_fields->'delivery','{}') ? 'own_transport') then return new; end if;
  v_changed := (new.delivery_mode,new.internal_driver_user_id,new.external_partner_id,new.external_driver_name,
    new.external_driver_phone,new.fulfillment,new.extra_fields#>'{delivery,own_transport}',
    new.extra_fields#>'{delivery,cost_usd}',new.extra_fields#>'{delivery,cost_source}')
    is distinct from (old.delivery_mode,old.internal_driver_user_id,old.external_partner_id,old.external_driver_name,
    old.external_driver_phone,old.fulfillment,old.extra_fields#>'{delivery,own_transport}',
    old.extra_fields#>'{delivery,cost_usd}',old.extra_fields#>'{delivery,cost_source}');
  if v_changed then
    if auth.uid() is null or public.is_master_or_admin() is not true then
      raise exception 'Solo Máster o Administración pueden cambiar el transporte propio.' using errcode='42501';
    end if;
    if old.status::text not in ('confirmed','in_kitchen','ready') and not public.is_admin() then
      raise exception 'La asignación ya salió; no puede cambiarse desde Máster.' using errcode='55000';
    end if;
  end if;
  -- A pre-dispatch change to pickup must not carry the former transport subtype.
  if v_changed and new.fulfillment::text<>'delivery' and public.is_own_transport_v1(old) then
    new.delivery_mode:=null; new.external_driver_name:=null; new.external_driver_phone:=null;
    new.external_reference:=null;
    new.extra_fields:=jsonb_set(new.extra_fields,'{delivery}',
      (coalesce(new.extra_fields->'delivery','{}') - 'own_transport' - 'cost_snapshot')
        || jsonb_build_object('cost_usd',null,'cost_source',null));
  end if;
  if new.extra_fields->'delivery' ? 'own_transport' and not public.is_own_transport_v1(new) then
    raise exception 'Transporte propio requiere responsable y remuneración cero explícita.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_own_transport_v1() from public,anon,authenticated;
create trigger guard_own_transport_v1 before insert or update on public.orders for each row
  execute function app_private.guard_own_transport_v1();

create or replace function public.assign_own_transport_v1(
  p_order_id bigint,p_name text,p_phone text,p_notes text,p_operation_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_uid uuid:=auth.uid(); v_order public.orders%rowtype; v_event_id bigint;
  v_name text:=btrim(coalesce(p_name,'')); v_phone text:=nullif(btrim(p_phone),'');
  v_notes text:=nullif(btrim(p_notes),''); v_transport jsonb; v_prior jsonb; v_result jsonb;
begin
  if v_uid is null or public.is_master_or_admin() is not true then
    raise exception 'Solo Máster o Administración pueden asignar transporte propio.' using errcode='42501'; end if;
  if p_operation_id is null or length(v_name) not between 2 and 160
    or length(coalesce(v_phone,''))>50 or length(coalesce(v_notes,''))>1000 then
    raise exception 'Indica quién lleva el pedido (2 a 160 caracteres).' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('own-transport:'||p_operation_id::text,0));
  select payload into v_prior from public.order_timeline_events
    where event_type='own_transport_assigned' and payload->>'operation_id'=p_operation_id::text limit 1;
  if found then
    if (v_prior->>'order_id')::bigint is distinct from p_order_id or v_prior->>'name' is distinct from v_name
      or v_prior->>'phone' is distinct from v_phone or v_prior->>'notes' is distinct from v_notes
      or v_prior->>'actor_user_id' is distinct from v_uid::text then
      raise exception 'La solicitud ya corresponde a otra asignación.' using errcode='22023'; end if;
    return v_prior || jsonb_build_object('ok',true,'replayed',true);
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.fulfillment::text<>'delivery'
    or v_order.status::text not in ('confirmed','in_kitchen','ready') then
    raise exception 'Asigna transporte propio a un delivery en cocina o listo, antes de su salida.' using errcode='55000'; end if;
  if v_order.internal_driver_user_id is not null or v_order.external_partner_id is not null
    or nullif(btrim(v_order.external_driver_name),'') is not null then
    raise exception 'La orden ya tiene responsable. Quita la asignación antes de cambiarlo.' using errcode='40001'; end if;
  if exists(select 1 from public.delivery_settlements where order_id=p_order_id)
    or exists(select 1 from public.delivery_service_payment_items where order_id=p_order_id) then
    raise exception 'La orden tiene custodia o un pago de servicio; requiere revisión antes de reasignar.' using errcode='55000'; end if;
  v_transport:=jsonb_build_object('version',1,'name',v_name,'phone',v_phone,'notes',v_notes,
    'operation_id',p_operation_id,'assigned_at',clock_timestamp(),'assigned_by',v_uid);
  update public.orders set delivery_mode='external',internal_driver_user_id=null,external_partner_id=null,
    external_driver_name=v_name,external_driver_phone=v_phone,external_reference=null,
    last_modified_at=clock_timestamp(),last_modified_by=v_uid,
    extra_fields=jsonb_set(coalesce(extra_fields,'{}'),'{delivery}',
      (case when jsonb_typeof(extra_fields->'delivery')='object' then extra_fields->'delivery' else '{}'::jsonb end)
      - 'cost_snapshot' - 'corrected_at' - 'corrected_by' - 'corrected_by_user_id' - 'correction_notes'
      || jsonb_build_object('own_transport',v_transport,'cost_usd',0,'cost_source','own_transport_v1','distance_km',null,
        'cost_snapshot',jsonb_build_object('version',1,'assignment_kind','own_transport','currency','USD',
          'cost_usd',0,'source','own_transport_v1','recorded_by',v_uid,'recorded_at',clock_timestamp())))
    where id=p_order_id;
  v_result:=jsonb_build_object('order_id',p_order_id,'operation_id',p_operation_id,'actor_user_id',v_uid,
    'name',v_name,'phone',v_phone,'notes',v_notes,'cost_usd',0);
  insert into public.order_events(order_id,event,performed_by,meta)
    values(p_order_id,'own_transport_assigned',v_uid,v_result||jsonb_build_object('previous_delivery',v_order.extra_fields->'delivery'));
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values(p_order_id,v_order.order_number,'own_transport_assigned','delivery','Transporte propio asignado',
      v_name||' · sin pago por viaje.','info',v_uid,v_result) returning id into v_event_id;
  insert into public.order_timeline_event_recipients(event_id,target_role,target_user_id,requires_action)
    values(v_event_id,'master',null,false);
  if v_order.attributed_advisor_id is not null then
    insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action)
      values(v_event_id,v_order.attributed_advisor_id,false); end if;
  perform public.close_assign_driver_tasks(p_order_id,v_uid);
  return v_result||jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.assign_own_transport_v1(bigint,text,text,text,uuid) from public,anon;
grant execute on function public.assign_own_transport_v1(bigint,text,text,text,uuid) to authenticated;

-- Amend canonical readers/guards in place, refusing unexpected installed bodies.
do $$
declare r record; v_definition text;
begin
  for r in select * from (values
    ('public.trg_orders_delivery_mode_guard()',
      'new.delivery_mode::text = ''external'' and new.external_partner_id is null',
      'new.delivery_mode::text = ''external'' and new.external_partner_id is null and not public.is_own_transport_v1(new)'),
    ('public.out_for_delivery(bigint)',
      'v_delivery_mode = ''external'' and v_external_partner_id is null',
      'v_delivery_mode = ''external'' and v_external_partner_id is null and not exists(select 1 from public.orders own_order where own_order.id=p_order_id and public.is_own_transport_v1(own_order))'),
    ('public.counter_dispatch_order(bigint,integer)',
      'v_delivery_mode = ''external'' and v_external_partner_id is null',
      'v_delivery_mode = ''external'' and v_external_partner_id is null and not exists(select 1 from public.orders own_order where own_order.id=p_order_id and public.is_own_transport_v1(own_order))'),
    ('public.assign_internal_driver(bigint,uuid)',
      '- ''cost_snapshot'' - ''corrected_at''', '- ''own_transport'' - ''cost_snapshot'' - ''corrected_at'''),
    ('public.assign_external_partner(bigint,bigint,text)',
      '- ''cost_snapshot'' - ''corrected_at''', '- ''own_transport'' - ''cost_snapshot'' - ''corrected_at'''),
    ('public.clear_delivery_assignment(bigint,text)',
      '- ''cost_snapshot'' - ''corrected_at''', '- ''own_transport'' - ''cost_snapshot'' - ''corrected_at'''),
    ('public.correct_delivered_delivery_v1(bigint,text,uuid,bigint,text,numeric,numeric,text)',
      'v_delivery || jsonb_build_object(', '(v_delivery - ''own_transport'') || jsonb_build_object('),
    ('public.admin_delivery_services_v1(date,date)',
      'where o.fulfillment=''delivery'' and o.status=''delivered''',
      'where o.fulfillment=''delivery'' and o.status=''delivered'' and not public.is_own_transport_v1(o)')
  ) patch(signature,old_text,new_text) loop
    v_definition:=pg_get_functiondef(r.signature::regprocedure);
    if position(r.old_text in v_definition)=0 then
      raise exception 'Unexpected installed routine: %',r.signature; end if;
    execute replace(v_definition,r.old_text,r.new_text);
  end loop;
end;
$$;
commit;
