-- Remote migration version: 20260911135611.
begin;
-- No backfill: this command runs only for an explicit correction by an Admin.
create function public.correct_delivered_delivery_v1(
  p_order_id bigint, p_kind text, p_driver_user_id uuid, p_partner_id bigint,
  p_reference text, p_distance_km numeric, p_cost_usd numeric, p_notes text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_order public.orders; v_partner public.delivery_partners;
  v_before jsonb; v_delivery jsonb; v_snapshot jsonb; v_payload jsonb;
  v_event_id bigint; v_time timestamptz:=clock_timestamp();
  v_notes text:=btrim(regexp_replace(p_notes, '\s+', ' ', 'g'));
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo un administrador puede corregir entregas.' using errcode='42501';
  end if;
  if v_notes is null or length(v_notes)<6 or length(v_notes)>500 then
    raise exception 'Indica un motivo de entre 6 y 500 caracteres.' using errcode='22023';
  end if;
  if p_kind is null or p_kind not in ('internal','external') then
    raise exception 'Tipo de entrega inválido.' using errcode='22023';
  end if;
  if p_cost_usd is not null and (p_cost_usd::text in ('NaN','Infinity','-Infinity') or p_cost_usd<0 or p_cost_usd>999999999.99) then
    raise exception 'Costo de delivery inválido.' using errcode='22023';
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.status<>'delivered' or v_order.fulfillment<>'delivery' then
    raise exception 'Esta corrección solo aplica a pedidos delivery ya entregados.' using errcode='22023';
  end if;
  if jsonb_typeof(v_order.extra_fields)<>'object' then
    raise exception 'Metadatos de orden inválidos.' using errcode='22023';
  end if;
  v_delivery:=case when jsonb_typeof(v_order.extra_fields->'delivery')='object' then v_order.extra_fields->'delivery' else '{}'::jsonb end;
  v_before:=jsonb_build_object('delivery_mode',v_order.delivery_mode,
    'internal_driver_user_id',v_order.internal_driver_user_id,'external_partner_id',v_order.external_partner_id,
    'external_driver_name',v_order.external_driver_name,'external_driver_phone',v_order.external_driver_phone,
    'external_reference',v_order.external_reference,'distance_km',v_delivery->'distance_km',
    'cost_usd',v_delivery->'cost_usd','cost_source',v_delivery->'cost_source','cost_snapshot',v_delivery->'cost_snapshot',
    'delivery_metadata',v_delivery);
  if p_kind='internal' then
    if p_driver_user_id is null or p_partner_id is not null or not exists(select 1 from public.profiles where id=p_driver_user_id) then
      raise exception 'Selecciona un driver interno válido.' using errcode='22023';
    end if;
  else
    if p_driver_user_id is not null or p_partner_id is null then
      raise exception 'Selecciona un partner externo válido.' using errcode='22023';
    end if;
    if p_distance_km is null or p_distance_km::text in ('NaN','Infinity','-Infinity') or p_distance_km<=0 or p_distance_km>999999 then
      raise exception 'Indica una distancia válida en km.' using errcode='22023';
    end if;
    select * into v_partner from public.delivery_partners where id=p_partner_id for share;
    if not found then raise exception 'No se pudo cargar el partner externo.' using errcode='22023'; end if;
  end if;
  v_snapshot:=jsonb_build_object('version',1,'recorded_at',v_time,'recorded_by',auth.uid(),
    'assignment_kind',p_kind,'driver_user_id',p_driver_user_id,'partner_id',p_partner_id,
    'reference',case when p_kind='external' then nullif(btrim(p_reference),'') else null end,
    'distance_km',case when p_kind='external' then round(p_distance_km,2) else null end,
    'currency','USD','cost_usd',round(p_cost_usd,2),'source','admin_delivered_correction_'||p_kind,
    'cost_status',case when p_cost_usd is null then 'missing' else 'recorded' end,'notes',v_notes);
  update public.orders set
    delivery_mode=(case when p_kind='internal' then 'internal' else 'external' end)::public.delivery_mode,
    internal_driver_user_id=p_driver_user_id,external_partner_id=p_partner_id,
    external_driver_name=v_partner.name,external_driver_phone=v_partner.whatsapp_phone,
    external_reference=v_snapshot->>'reference',last_modified_at=v_time,last_modified_by=auth.uid(),
    extra_fields=jsonb_set(v_order.extra_fields,'{delivery}',v_delivery || jsonb_build_object(
      'delivery_mode',p_kind,'distance_km',v_snapshot->'distance_km','cost_usd',v_snapshot->'cost_usd',
      'cost_source',v_snapshot->'source','cost_snapshot',v_snapshot,
      'corrected_at',v_time,'corrected_by_user_id',auth.uid(),'correction_notes',v_notes))
  where id=p_order_id;
  v_payload:=jsonb_build_object('assignment_kind',p_kind,'notes',v_notes,'previous',v_before,'snapshot',v_snapshot,
    'driver_user_id',p_driver_user_id,'partner_id',p_partner_id,'partner_name',v_partner.name,
    'reference',v_snapshot->'reference','distance_km',v_snapshot->'distance_km','cost_usd',v_snapshot->'cost_usd');
  insert into public.order_events(order_id,event,performed_by,meta)
  values(p_order_id,'delivery_assignment_corrected',auth.uid(),v_payload);
  -- The history users actually see is part of this same transaction.
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
  values(p_order_id,v_order.order_number,'delivery_assignment_corrected','delivery','Entrega corregida',v_notes,'warning',auth.uid(),v_payload)
  returning id into v_event_id;
  return jsonb_build_object('eventId',v_event_id,'payload',v_payload);
end;
$$;
revoke all on function public.correct_delivered_delivery_v1(bigint,text,uuid,bigint,text,numeric,numeric,text) from public,anon,service_role;
grant execute on function public.correct_delivered_delivery_v1(bigint,text,uuid,bigint,text,numeric,numeric,text) to authenticated;
commit;
