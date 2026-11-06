-- One bounded, read-only snapshot per explicit copy. No financial writes or broad table grants.
create function app_private.order_whatsapp_snapshot_v1(p_order_id bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o public.orders%rowtype; result jsonb;
begin
  if auth.uid() is null then raise exception 'No autenticado.' using errcode='42501'; end if;
  if p_order_id is null or p_order_id<=0 then raise exception 'Orden inválida.' using errcode='22023'; end if;
  select * into o from public.orders where id=p_order_id;
  if not found or not (public.is_master_or_admin() or
    (public.has_role('advisor') and o.attributed_advisor_id=auth.uid())) then
    raise exception 'No tienes acceso a esta orden.' using errcode='42501';
  end if;
  -- STABLE keeps header, lines and canonical financial evidence on the same read snapshot.
  select jsonb_build_object(
    'order',jsonb_build_object('id',o.id,'status',o.status,'fulfillment',o.fulfillment,
      'total_usd',o.total_usd,'total_bs_snapshot',o.total_bs_snapshot,'extra_fields',o.extra_fields,
      'delivery_address',o.delivery_address,'receiver_name',o.receiver_name,
      'receiver_phone',o.receiver_phone,'notes',o.notes),
    'client',jsonb_build_object('full_name',c.full_name,'phone',c.phone),
    'advisor_name',coalesce(nullif(u.raw_user_meta_data->>'full_name',''),
      nullif(u.raw_user_meta_data->>'name',''),nullif(p.full_name,''),'Asesor'),
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'qty',i.qty,
      'product_name_snapshot',i.product_name_snapshot,'line_total_usd',i.line_total_usd,'notes',i.notes,
      'product_type',cat.type,'units_per_service',cat.units_per_service,'inventory_group',cat.inventory_group,
      'internal_rider_pay_usd',cat.internal_rider_pay_usd) order by i.id)
      from public.order_items i join public.products cat on cat.id=i.product_id where i.order_id=o.id),'[]'::jsonb),
    'finance',(select to_jsonb(f) from public.get_order_financial_state(o.id) f),
    'calculated_at',statement_timestamp()
  ) into result from public.clients c
    left join public.profiles p on p.id=o.attributed_advisor_id
    left join auth.users u on u.id=o.attributed_advisor_id where c.id=o.client_id;
  if result is null or result->'finance'='null'::jsonb then
    raise exception 'No se pudo verificar el estado actual del pedido.';
  end if;
  return result;
end;
$$;
revoke all on function app_private.order_whatsapp_snapshot_v1(bigint) from public,anon,authenticated;
grant execute on function app_private.order_whatsapp_snapshot_v1(bigint) to authenticated;

create function public.read_order_whatsapp_snapshot_v1(p_order_id bigint)
returns jsonb language sql stable security invoker set search_path='' as $$
  select app_private.order_whatsapp_snapshot_v1(p_order_id);
$$;
revoke all on function public.read_order_whatsapp_snapshot_v1(bigint) from public,anon;
grant execute on function public.read_order_whatsapp_snapshot_v1(bigint) to authenticated;
