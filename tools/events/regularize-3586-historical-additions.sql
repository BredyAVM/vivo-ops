-- User-confirmed historical correction: 250 extra pieces already delivered.
-- Deliberately defaults to ROLLBACK. No schema changes or disabled triggers.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '25s';

do $repair$
declare
  actor constant uuid := '8c296814-8b98-48d4-8db1-ce27b4c808eb';
  repair_key constant text := 'order-3586-delivered-250-pieces-usd150';
  why constant text := 'Registro tardío autorizado: 250 mini tequeños fritos adicionales, ya entregados el 30/10/2026, por USD 150. No repetir cocina, entrega ni consumo de stock actual.';
  o public.orders%rowtype; original_item jsonb; movements jsonb; flows jsonb;
  payments jsonb; finance record; new_item bigint; event_id bigint; initial_collection_mode text;
  history jsonb; updated_note text; fx numeric; bs numeric;
begin
  perform set_config('request.jwt.claim.sub', actor::text, true);
  if public.is_admin() is not true then raise exception 'Expected authorized administrative repair context.'; end if;
  select * into strict o from public.orders where id=3586 for update;
  if exists(select 1 from public.order_admin_adjustments
    where order_id=o.id and payload->>'repair_key'=repair_key) then
    if o.total_usd<>271.50 or (select count(*) from public.order_items where order_id=o.id)<>2 then
      raise exception 'Existing repair is inconsistent; audit before retrying.';
    end if;
    return;
  end if;
  if o.client_id<>2812 or o.order_number<>'VO-20261027-9519'
    or o.status::text<>'delivered' or o.fulfillment::text<>'pickup'
    or o.total_usd<>121.50 or o.last_modified_at<>'2026-10-30T21:07:50.515701Z'::timestamptz
    or o.extra_fields#>>'{schedule,date}'<>'2026-10-30'
    or (select count(*) from public.order_items where order_id=o.id)<>1 then
    raise exception 'Order baseline changed; audit again.';
  end if;
  select to_jsonb(i) into strict original_item from public.order_items i
    where id=15572 and order_id=o.id and product_id=105 and qty=1 and line_total_usd=121.50;
  fx:=(o.extra_fields#>>'{pricing,fx_rate}')::numeric;
  if fx<>887.30 or not exists(select 1 from public.products where id=5 and sku='MINI_TEQ_F_25' and units_per_service=25) then
    raise exception 'Original rate or product units changed.';
  end if;
  if not exists(select 1 from public.inventory_count_lines
    where id=6814 and inventory_item_id=1 and line_status='accepted'
      and movement_id=18268 and counted_at>'2026-10-30T21:07:50Z') then
    raise exception 'Subsequent accepted physical count evidence is missing.';
  end if;
  select * into strict finance from public.get_order_financial_state(o.id);
  initial_collection_mode:=finance.collection_mode;
  if finance.pending_usd<>121.50 or finance.confirmed_paid_usd<>0
    or finance.pending_reports_count<>0 then raise exception 'Financial baseline changed.'; end if;
  select jsonb_agg(to_jsonb(m) order by id) into movements from public.inventory_movements m where order_id=o.id;
  select jsonb_agg(to_jsonb(f) order by id) into flows from public.inventory_planned_flows f where order_id=o.id;
  select jsonb_agg(to_jsonb(p) order by id) into payments from public.payment_reports p where order_id=o.id;
  bs:=round(150*fx,2);
  history:=jsonb_build_object('kind','historical_delivered_addition','repair_key',repair_key,
    'effective_date','2026-10-30','recorded_at',clock_timestamp(),
    'additional_units',250,'services',10,'units_per_service',25,'amount_usd',150,
    'initial_total_usd',121.50,'final_total_usd',271.50,'final_units',425,
    'inventory_treatment','no_current_movement_after_subsequent_physical_count',
    'subsequent_count_line_id',6814,'subsequent_count_movement_id',18268,
    'authorization','User explicitly confirmed the extra 250 pieces were already delivered and omitted from registration.',
    'support_admin_context',actor,'exact_additional_delivery_time_known',false);

  insert into public.order_items(order_id,product_id,qty,notes,
    pricing_origin_currency,pricing_origin_amount,pricing_fx_rate_snapshot,
    unit_price_usd_snapshot,line_total_usd,unit_price_bs_snapshot,line_total_bs_snapshot,
    admin_price_override_usd,admin_price_override_reason,admin_price_override_by_user_id,admin_price_override_at)
  values(o.id,5,10,'250 piezas adicionales ya entregadas. Registro historico; no preparar de nuevo.',
    'USD',15,fx,15,150,round(15*fx,2),bs,15,why,actor,clock_timestamp()) returning id into new_item;
  update public.order_items set product_name_snapshot='Mini Tequeños Fritos adicionales' where id=new_item;

  updated_note:=coalesce(o.notes,'')||E'\n\nREGISTRO TARDIO DE ADICIONALES: 250 mini tequenos fritos ya entregados el 30/10/2026 por USD 150,00. Evento original USD 121,50 + adicionales USD 150,00 = TOTAL USD 271,50. Total: 425 piezas. Sin nueva preparacion, retiro ni consumo actual de inventario. Se conservan las condiciones de comision de la orden.';
  update public.orders set total_usd=271.50,total_bs_snapshot=round(271.50*fx,2),notes=updated_note,
    extra_fields=jsonb_set(jsonb_set(o.extra_fields,'{pricing}',(o.extra_fields->'pricing')||jsonb_build_object(
      'subtotal_usd',271.50,'subtotal_bs',round(271.50*fx,2),
      'subtotal_after_discount_usd',271.50,'subtotal_after_discount_bs',round(271.50*fx,2),
      'total_usd',271.50,'total_bs',round(271.50*fx,2))),'{note}',to_jsonb(updated_note)),
    last_modified_at=clock_timestamp(),last_modified_by=actor where id=o.id;
  insert into public.order_admin_adjustments(order_id,order_item_id,adjustment_type,reason,payload,created_by_user_id)
    values(o.id,new_item,'other',why,history||jsonb_build_object('before_order',to_jsonb(o),'new_item_id',new_item),actor);
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values(o.id,o.order_number,'order_modified','order','Adicionales entregados registrados',
      'Registro tardio: 250 mini tequenos fritos adicionales por $150. Total de la orden: $271,50. Ya entregados; no requiere nueva preparacion ni entrega.',
      'info',actor,history||jsonb_build_object('order_item_id',new_item)) returning id into event_id;
  insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action)
    values(event_id,o.attributed_advisor_id,false);
  insert into public.order_timeline_event_recipients(event_id,target_role,requires_action) values(event_id,'master',false);
  set constraints all immediate;

  if (select to_jsonb(i) from public.order_items i where id=15572) is distinct from original_item
    or (select jsonb_agg(to_jsonb(m) order by id) from public.inventory_movements m where order_id=o.id) is distinct from movements
    or (select jsonb_agg(to_jsonb(f) order by id) from public.inventory_planned_flows f where order_id=o.id) is distinct from flows
    or (select jsonb_agg(to_jsonb(p) order by id) from public.payment_reports p where order_id=o.id) is distinct from payments then
    raise exception 'Original item, inventory or payments changed unexpectedly.';
  end if;
  if not exists(select 1 from public.order_items where id=new_item and product_id=5 and qty=10
      and line_total_usd=150 and line_total_bs_snapshot=bs and pricing_origin_amount=15)
    or (select count(*) from public.order_items where order_id=o.id)<>2
    or not exists(select 1 from public.orders where id=o.id and status=o.status
      and ready_at is not distinct from o.ready_at and sent_to_kitchen_at is not distinct from o.sent_to_kitchen_at
      and kitchen_started_at is not distinct from o.kitchen_started_at
      and extra_fields->'pickup'=o.extra_fields->'pickup' and extra_fields->'schedule'=o.extra_fields->'schedule'
      and not needs_reapproval and not queued_needs_reapproval) then
    raise exception 'Quantity, price or operational state did not match the correction.';
  end if;
  select * into strict finance from public.get_order_financial_state(o.id);
  if finance.total_usd<>271.50 or finance.pending_usd<>271.50 or finance.confirmed_paid_usd<>0
    or finance.total_bs<>round(271.50*fx,2) or finance.collection_mode<>initial_collection_mode
    then raise exception 'Final financial totals or collection policy do not match.'; end if;
end $repair$;

select o.id,o.status,o.total_usd,o.total_bs_snapshot,
  (select jsonb_agg(jsonb_build_object('id',i.id,'product',i.product_name_snapshot,'qty',i.qty,'total_usd',i.line_total_usd) order by i.id)
    from public.order_items i where i.order_id=o.id) items,
  (select to_jsonb(f) from public.get_order_financial_state(o.id) f) finance
from public.orders o where id=3586;
rollback;
