-- Remote migration version: 20260911210715. Unknown cost never means zero. No historical backfill or payment.
begin;
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
