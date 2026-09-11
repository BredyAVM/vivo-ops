-- Remote migration version: 20260911021217. New assignments only; no historical backfill or money movement.
begin;

create or replace function public.assign_internal_driver(p_order_id bigint, p_driver_user_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
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
$$;

create or replace function public.assign_external_partner(p_order_id bigint, p_partner_id bigint, p_reference text default null)
returns void language plpgsql security invoker set search_path = '' as $$
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
$$;

create or replace function public.clear_delivery_assignment(p_order_id bigint, p_notes text default null)
returns void language plpgsql security invoker set search_path = '' as $$
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
$$;

create function public.assign_delivery_with_cost_v1(
  p_order_id bigint, p_kind text, p_driver_user_id uuid, p_partner_id bigint,
  p_reference text, p_distance_km numeric, p_cost_usd numeric
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.orders; v_snapshot jsonb; v_source text;
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
  if p_distance_km is not null and (p_distance_km::text in ('NaN','Infinity','-Infinity') or p_distance_km < 0 or p_distance_km > 999999) then
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
  else
    if p_driver_user_id is not null then raise exception 'Conflicting assignment' using errcode='22023'; end if;
    perform public.assign_external_partner(p_order_id,p_partner_id,p_reference);
    v_source:='external_partner_manual_v1';
  end if;
  -- Input captured at assignment time; not a payment or a retroactive tariff estimate.
  v_snapshot:=jsonb_build_object('version',1,'recorded_at',clock_timestamp(),'recorded_by',auth.uid(),
    'assignment_kind',p_kind,'driver_user_id',p_driver_user_id,'partner_id',p_partner_id,
    'reference',p_reference,'distance_km',case when p_kind='external' then p_distance_km else null end,
    'currency','USD','cost_usd',round(p_cost_usd,2),'source',v_source,
    'cost_status',case when p_cost_usd is null then 'missing' else 'recorded' end);
  update public.orders set extra_fields=jsonb_set(extra_fields,'{delivery}',
    (extra_fields->'delivery') || jsonb_build_object('cost_usd',round(p_cost_usd,2),
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
revoke execute on function public.assign_internal_driver(bigint,uuid), public.assign_external_partner(bigint,bigint,text), public.clear_delivery_assignment(bigint,text) from public,anon;
grant execute on function public.assign_internal_driver(bigint,uuid), public.assign_external_partner(bigint,bigint,text), public.clear_delivery_assignment(bigint,text) to authenticated;
commit;
