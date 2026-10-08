-- Append a physically dispatched beverage, not general post-dispatch editing.
-- Timestamp matches the migration applied to the linked project.
begin;
set local lock_timeout = '5s';
create or replace function app_private.master_append_dispatched_beverage_v1(
  p_order_id bigint, p_product_id bigint, p_qty numeric,
  p_expected_last_modified_at timestamptz, p_operation_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_product public.products%rowtype;
  v_item public.order_items%rowtype;
  v_settlement public.delivery_settlements%rowtype;
  v_prior jsonb;
  v_pricing jsonb;
  v_receipt jsonb;
  v_fx numeric;
  v_unit_usd numeric;
  v_unit_bs numeric;
  v_line_usd numeric;
  v_line_bs numeric;
  v_old_sub_usd numeric;
  v_old_sub_bs numeric;
  v_sub_usd numeric;
  v_sub_bs numeric;
  v_discount numeric;
  v_tax numeric;
  v_discount_usd numeric;
  v_discount_bs numeric;
  v_net_usd numeric;
  v_net_bs numeric;
  v_tax_usd numeric;
  v_tax_bs numeric;
  v_total_usd numeric;
  v_total_bs numeric;
  v_resolution jsonb;
  v_route record;
  v_routes integer := 0;
  v_inventory_status text := 'applied';
  v_message text;
  v_event_id bigint;
begin
  if v_actor is null or public.is_master_or_admin() is not true then
    raise exception 'Solo Máster o Administración pueden incorporar una bebida en camino.' using errcode = '42501';
  end if;
  if p_operation_id is null or p_qty is null or p_qty::text in ('NaN','Infinity','-Infinity')
    or p_qty <= 0 or p_qty > 999 or p_qty <> trunc(p_qty)
    or length(btrim(coalesce(p_reason,''))) not between 4 and 1000 then
    raise exception 'Indica bebida, cantidad entera positiva y motivo.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('beverage-append:' || p_operation_id::text,0));
  if exists(select 1 from public.order_timeline_events where event_type='order_dispatched_beverage_appended'
    and payload->>'operation_id'=p_operation_id::text and order_id<>p_order_id) then
    raise exception 'La solicitud ya corresponde a otra orden.' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('order-edit:' || p_order_id::text,0));
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'La orden no existe.' using errcode='P0002'; end if;
  select payload into v_prior from public.order_timeline_events
    where order_id=p_order_id and event_type='order_dispatched_beverage_appended'
      and payload->>'operation_id'=p_operation_id::text limit 1;
  if found then
    if (v_prior->>'product_id')::bigint is distinct from p_product_id
      or (v_prior->>'qty')::numeric is distinct from p_qty
      or v_prior->>'reason' is distinct from btrim(p_reason) then
      raise exception 'La solicitud ya corresponde a otra incorporación.' using errcode='22023';
    end if;
    return v_prior || jsonb_build_object('ok',true,'replayed',true);
  end if;
  if v_order.status::text <> 'out_for_delivery' or v_order.fulfillment::text <> 'delivery' then
    raise exception 'Esta incorporación solo aplica a delivery en camino. No reabre órdenes entregadas o canceladas.' using errcode='55000';
  end if;
  if v_order.last_modified_at is distinct from p_expected_last_modified_at then
    raise exception 'La orden cambió. Cierra y vuelve a abrirla antes de incorporar la bebida.' using errcode='40001';
  end if;
  select * into v_product from public.products where id=p_product_id for share;
  if not found or v_product.is_active is not true or v_product.type::text <> 'product'
    or v_product.inventory_group::text is distinct from 'beverages'
    or coalesce(v_product.is_detail_editable,false)
    or coalesce(v_product.extra_fields->>'catalog_access_scope','') in ('admin_internal','crm_only','advisor_gift','advisor_gift_only')
    or v_product.source_price_currency is null or v_product.source_price_currency::text not in ('USD','VES')
    or v_product.source_price_amount is null or v_product.source_price_amount <= 0
    or v_product.source_price_amount::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Selecciona una bebida activa, de composición fija y precio normal de catálogo.' using errcode='22023';
  end if;
  v_pricing := v_order.extra_fields->'pricing';
  v_fx := nullif(v_pricing->>'fx_rate','')::numeric;
  v_old_sub_usd := nullif(v_pricing->>'subtotal_usd','')::numeric;
  v_old_sub_bs := nullif(v_pricing->>'subtotal_bs','')::numeric;
  v_discount := case when coalesce((v_pricing->>'discount_enabled')::boolean,false)
    then coalesce((v_pricing->>'discount_pct')::numeric,0) else 0 end;
  v_tax := coalesce((v_pricing->>'invoice_tax_pct')::numeric,0);
  if v_fx is null or v_fx <= 0 or v_fx::text in ('NaN','Infinity','-Infinity')
    or v_old_sub_usd is null or v_old_sub_bs is null or v_order.total_bs_snapshot is null
    or v_old_sub_usd::text in ('NaN','Infinity','-Infinity')
    or v_old_sub_bs::text in ('NaN','Infinity','-Infinity')
    or v_discount not between 0 and 100 or v_tax not between 0 and 100
    or v_discount::text='NaN' or v_tax::text='NaN' then
    raise exception 'La orden necesita conciliar su snapshot de precio antes de incorporar una bebida.' using errcode='55000';
  end if;
  -- Do not silently repair old totals or rebuild original lines.
  if abs(v_old_sub_usd-(select coalesce(sum(line_total_usd),0) from public.order_items where order_id=p_order_id)) > 0.02
    or abs(v_old_sub_bs-(select coalesce(sum(line_total_bs_snapshot),0) from public.order_items where order_id=p_order_id)) > 0.02
    or exists(select 1 from public.order_items where order_id=p_order_id and line_total_bs_snapshot is null)
    or abs(v_order.total_usd-round(round(v_old_sub_usd-round(v_old_sub_usd*v_discount/100,2),2)*(1+v_tax/100),2)) > 0.02
    or abs(v_order.total_bs_snapshot-round(round(v_old_sub_bs-round(v_old_sub_bs*v_discount/100,2),2)*(1+v_tax/100),2)) > 0.02 then
    raise exception 'Los totales anteriores requieren conciliación; no se recalculan silenciosamente.' using errcode='55000';
  end if;
  select * into v_settlement from public.delivery_settlements where order_id=p_order_id for update;
  -- A recorded cash-custody plan is a separate economic axis: do not silently
  -- rewrite it from an item append. Ordinary direct payments need no new plan.
  if exists(select 1 from public.delivery_settlement_entries where settlement_id=v_settlement.id) then
    raise exception 'La orden tiene una liquidación de efectivo registrada. Requiere conciliar esa liquidación antes de ampliar el cobro.' using errcode='55000';
  end if;
  if v_product.source_price_currency::text='VES' then
    v_unit_bs := round(v_product.source_price_amount,2);
    v_unit_usd := round(v_unit_bs/v_fx,2);
    v_line_bs := round(v_unit_bs*p_qty,2);
    v_line_usd := round(v_line_bs/v_fx,2);
  else
    -- The existing price trigger uses catalog base USD; refuse inconsistent catalogs.
    if round(v_product.base_price_usd,2) is distinct from round(v_product.source_price_amount,2) then
      raise exception 'El precio USD de catálogo necesita conciliación.' using errcode='55000';
    end if;
    v_unit_usd := round(v_product.source_price_amount,2);
    v_unit_bs := round(v_unit_usd*v_fx,2);
    v_line_usd := round(v_unit_usd*p_qty,2);
    v_line_bs := round(v_line_usd*v_fx,2);
  end if;
  insert into public.order_items(order_id,product_id,qty,sku_snapshot,product_name_snapshot,
    unit_price_usd_snapshot,line_total_usd,pricing_origin_currency,pricing_origin_amount,
    pricing_fx_rate_snapshot,unit_price_bs_snapshot,line_total_bs_snapshot)
  values(p_order_id,p_product_id,p_qty,v_product.sku,v_product.name,v_unit_usd,v_line_usd,
    v_product.source_price_currency::text,v_product.source_price_amount,v_fx,v_unit_bs,v_line_bs)
  returning * into v_item;
  if v_item.line_total_usd is distinct from v_line_usd or v_item.line_total_bs_snapshot is distinct from v_line_bs then
    raise exception 'El catálogo cambió la cotización. No se guardó la incorporación.' using errcode='40001';
  end if;
  v_sub_usd := round(v_old_sub_usd+v_line_usd,2); v_sub_bs := round(v_old_sub_bs+v_line_bs,2);
  v_discount_usd := round(v_sub_usd*v_discount/100,2); v_discount_bs := round(v_sub_bs*v_discount/100,2);
  v_net_usd := v_sub_usd-v_discount_usd; v_net_bs := v_sub_bs-v_discount_bs;
  v_tax_usd := round(v_net_usd*v_tax/100,2); v_tax_bs := round(v_net_bs*v_tax/100,2);
  v_total_usd := v_net_usd+v_tax_usd; v_total_bs := v_net_bs+v_tax_bs;
  v_pricing := v_pricing || jsonb_build_object('subtotal_usd',v_sub_usd,'subtotal_bs',v_sub_bs,
    'discount_amount_usd',v_discount_usd,'discount_amount_bs',v_discount_bs,
    'subtotal_after_discount_usd',v_net_usd,'subtotal_after_discount_bs',v_net_bs,
    'invoice_tax_amount_usd',v_tax_usd,'invoice_tax_amount_bs',v_tax_bs,
    'total_usd',v_total_usd,'total_bs',v_total_bs);
  update public.orders set total_usd=v_total_usd,total_bs_snapshot=v_total_bs,
    extra_fields=jsonb_set(extra_fields,'{pricing}',v_pricing),
    last_modified_at=clock_timestamp(),last_modified_by=v_actor where id=p_order_id;
  begin
    perform app_private.inventory_close_order_commitments_v1(p_order_id,'fulfilled',v_actor);
  exception when others then
    get stacked diagnostics v_message=message_text;
    v_inventory_status := 'review_required';
    perform app_private.inventory_record_order_issue_v1(p_order_id,'inventory_sale_sync_failed','beverage_append',
      'Compromisos de bebida pendientes de conciliación','La bebida ya acompaña el envío; revisar sus compromisos.',
      'critical',v_actor,jsonb_build_object('operation_id',p_operation_id,'order_item_id',v_item.id,'error',v_message));
  end;
  begin
    if not app_private.inventory_catalog_is_ready_v1() then raise exception 'Inventario no está listo.'; end if;
    v_resolution := app_private.inventory_resolve_order_sale_routes_base_v1(p_order_id);
    for v_route in
      select (line.value->>'inventory_item_id')::bigint item_id,
        sum((source.value->>'quantity_units')::numeric) quantity_units
      from jsonb_array_elements(v_resolution->'lines') line(value)
      cross join lateral jsonb_array_elements(line.value->'sources') source(value)
      where (source.value->>'order_item_id')::bigint=v_item.id
      group by (line.value->>'inventory_item_id')::bigint order by 1
    loop
      if v_route.quantity_units is null or v_route.quantity_units <= 0
        or not app_private.inventory_item_is_initialized_v1(v_route.item_id) then
        raise exception 'La bebida necesita conciliar su ruta física o conteo de apertura.';
      end if;
      perform app_private.inventory_apply_delta_v1(p_operation_id,v_route.item_id,'sale_out',-v_route.quantity_units,
        'order_delivery','Bebida incorporada después del despacho. ' || btrim(p_reason),p_order_id,null,v_actor,null);
      v_routes := v_routes+1;
    end loop;
    if v_routes=0 then raise exception 'No se encontró una ruta física para la bebida.'; end if;
  exception when others then
    get stacked diagnostics v_message=message_text;
    v_inventory_status := 'review_required';
    perform app_private.inventory_record_order_issue_v1(p_order_id,'inventory_sale_sync_failed','beverage_append',
      'Bebida pendiente de conciliación','Se incorporó la bebida al cobro; su salida física necesita revisión.',
      'critical',v_actor,jsonb_build_object('operation_id',p_operation_id,'order_item_id',v_item.id,'error',v_message));
  end;
  v_receipt := jsonb_build_object('operation_id',p_operation_id,'product_id',p_product_id,'qty',p_qty,
    'order_item_id',v_item.id,'reason',btrim(p_reason),
    'inventory_status',v_inventory_status,'order_status',v_order.status,
    'previous_total_usd',v_order.total_usd,'previous_total_bs',v_order.total_bs_snapshot,
    'total_usd',v_total_usd,'total_bs',v_total_bs,'line_usd',v_line_usd,'line_bs',v_line_bs,'fx_rate',v_fx);
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
  values(p_order_id,v_order.order_number,'order_dispatched_beverage_appended','order','Bebida incorporada al envío',
    format('%s × %s, precio de catálogo. Total anterior Bs %s / $%s; nuevo Bs %s / $%s. Motivo: %s',
      p_qty,v_item.product_name_snapshot,v_order.total_bs_snapshot,v_order.total_usd,v_total_bs,v_total_usd,btrim(p_reason)),
    'warning',v_actor,v_receipt) returning id into v_event_id;
  insert into public.order_timeline_event_recipients(event_id,target_role,requires_action)
    values(v_event_id,'kitchen',true),(v_event_id,'counter',true);
  if v_order.attributed_advisor_id is not null then
    insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action) values(v_event_id,v_order.attributed_advisor_id,false);
  end if;
  if v_settlement.responsible_user_id is not null and v_settlement.responsible_user_id is distinct from v_order.attributed_advisor_id then
    insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action) values(v_event_id,v_settlement.responsible_user_id,true);
  end if;
  return v_receipt || jsonb_build_object('ok',true);
end;
$$;
revoke all on function app_private.master_append_dispatched_beverage_v1(bigint,bigint,numeric,timestamptz,uuid,text) from public,anon;
grant execute on function app_private.master_append_dispatched_beverage_v1(bigint,bigint,numeric,timestamptz,uuid,text) to authenticated;
create or replace function public.master_append_dispatched_beverage_v1(
  p_order_id bigint,p_product_id bigint,p_qty numeric,p_expected_last_modified_at timestamptz,
  p_operation_id uuid,p_reason text
) returns jsonb language sql security invoker set search_path='' as $$
  select app_private.master_append_dispatched_beverage_v1(p_order_id,p_product_id,p_qty,
    p_expected_last_modified_at,p_operation_id,p_reason);
$$;
revoke all on function public.master_append_dispatched_beverage_v1(bigint,bigint,numeric,timestamptz,uuid,text) from public,anon;
grant execute on function public.master_append_dispatched_beverage_v1(bigint,bigint,numeric,timestamptz,uuid,text) to authenticated;
commit;
