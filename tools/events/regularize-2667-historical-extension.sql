-- Targeted, user-authorized historical correction. NOT a reusable operational API.
-- Default is ROLLBACK. Review its assertions and result before explicitly committing.
-- Keeps the original order and physical-count history intact. No triggers disabled.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '25s';

do $repair$
declare
  actor constant uuid := '8c296814-8b98-48d4-8db1-ce27b4c808eb';
  request_key constant uuid := 'f8795f80-1328-4ba5-a689-946406467d12';
  root public.advisor_order_drafts%rowtype;
  base public.orders%rowtype;
  child_id bigint; child_order bigint; child_item bigint; timeline_id bigint;
  ext jsonb; lines jsonb; history jsonb; original jsonb; original_items jsonb;
  original_movements jsonb; components jsonb; detail text;
  fx numeric; bs numeric; finance record;
begin
  perform set_config('request.jwt.claim.sub',actor::text,true);
  if not public.is_admin() then raise exception 'Expected authorized administrator.'; end if;
  select * into strict root from public.advisor_order_drafts where id=671 for update;
  select * into strict base from public.orders where id=2667 for update;
  if root.converted_order_id is distinct from base.id
    or root.payload #>> '{event_budget,kind}' is distinct from 'admin_event_budget'
    or root.payload #>> '{event_budget,commission_mode}' is distinct from 'default'
    or root.payload #>> '{event_budget,negotiated_currency}' is distinct from 'USD'
    or base.status::text <> 'delivered' or base.total_usd <> 152.10
    or base.extra_fields #>> '{schedule,date}' is distinct from '2026-09-18'
    or base.extra_fields #>> '{payment,method}' is distinct from 'payment_mobile'
    or base.fulfillment::text <> 'pickup' then
    raise exception 'Historical baseline changed; audit again.';
  end if;
  select converted_order_id into child_order from public.advisor_order_drafts
    where payload #>> '{event_extension,request_id}'=request_key::text;
  if found then
    if not exists(select 1 from public.orders o join public.advisor_order_drafts d on d.converted_order_id=o.id
      where o.id=child_order and d.payload #>> '{event_extension,root_id}'='671'
        and d.payload #>> '{event_extension,stage}'='approved' and o.total_usd=111.20 and o.status::text='delivered') then
      raise exception 'Request key exists with inconsistent state.';
    end if;
    return; -- Same approved repair must not create another order.
  end if;
  if exists(select 1 from public.advisor_order_drafts where payload #>> '{event_extension,root_id}'='671') then
    raise exception 'Another extension exists; audit before proceeding.';
  end if;
  select * into strict finance from public.get_order_financial_state(base.id);
  if finance.pending_usd <> 152.10 or finance.confirmed_paid_usd <> 0 or finance.pending_reports_count <> 0 then
    raise exception 'Payment state changed; audit again.';
  end if;
  if (select count(*) from public.order_items where order_id=base.id)<>1
    or not exists(select 1 from public.order_item_components c join public.order_items i on i.id=c.order_item_id
      where i.order_id=base.id and i.id=12249 and i.product_id=105 and c.component_product_id=5 and c.qty=250)
    or (select count(*) from public.order_item_components where order_item_id=12249)<>1 then
    raise exception 'Original composition changed.';
  end if;
  if not exists(select 1 from public.inventory_count_lines
    where id=3859 and inventory_item_id=1 and line_status='accepted' and movement_id=11567
      and counted_at>'2026-09-19T00:00:00Z' and counted_quantity_units=289) then
    raise exception 'Required subsequent accepted physical count is missing.';
  end if;
  if not exists(select 1 from public.products where id=105 and sku='PACK_EVENTO')
    or not exists(select 1 from public.products where id=5 and sku='MINI_TEQ_F_25') then
    raise exception 'Catalog identities changed.';
  end if;
  original:=to_jsonb(base);
  select jsonb_agg(to_jsonb(i) order by i.id) into original_items from public.order_items i where order_id=base.id;
  select jsonb_agg(to_jsonb(m) order by m.id) into original_movements from public.inventory_movements m where order_id=base.id;
  fx:=(base.extra_fields #>> '{pricing,fx_rate}')::numeric;
  if fx is distinct from 847.44 then raise exception 'Original quote rate changed.'; end if;
  bs:=round(111.20*fx,2);
  history:=jsonb_build_object('kind','historical_event_extension','request_id',request_key,
    'recorded_at',clock_timestamp(),'recorded_by',actor,'effective_date','2026-09-18',
    'delivery_time_known',false,'reporting_time_source','original_event_schedule_not_actual_delivery_time',
    'initial_groups',50,'additional_groups',40,'units_per_group',5,'price_per_group_usd',2.78,
    'initial_units',250,'additional_units',200,'final_units',450,'final_total_usd',263.30,
    'inventory_treatment','no_current_movement_after_subsequent_physical_counts',
    'subsequent_count_id',229,'subsequent_count_line_id',3859,
    'evidence','Administrator confirmed 50 initial groups and 40 additional groups of 5 UND at USD 2.78 per group.',
    'note','No se atribuye la diferencia del conteo a esta ampliación. No se repite cocina, entrega ni consumo actual.');
  components:=jsonb_build_array(jsonb_build_object('product_id',5,'product_name','Mini Tequeños Fritos','qty',200,'preparation_mode','kitchen'));
  ext:=jsonb_build_object('root_id',root.id,'request_id',request_key,'stage','creating',
    'request_input',jsonb_build_object('request_id',request_key,'date','2026-09-18','time','16:00','fulfillment','pickup',
      'note','Regularización histórica: 40 combos adicionales de 5 UND; ya entregados durante el evento.',
      'items',jsonb_build_array(jsonb_build_object('product_id',5,'qty',200))),
    'items',jsonb_build_array(jsonb_build_object('product_id',5,'product_name','Mini Tequeños Fritos',
      'qty',200,'unit','UND','price',0.556,'physical_qty',200,'preparation_mode','kitchen','is_delivery',false)),
    'currency','USD','amount',111.20,
    'terms_snapshot',jsonb_build_object('commission_mode','default','commission_value',null,
      'authorized_by',actor,'authorized_at',clock_timestamp()),
    'requested_by',actor,'requested_at',clock_timestamp(),
    'reason','40 combos × 5 UND × US$2,78 por combo. Ampliación histórica ya entregada.',
    'historical_regularization',history);
  insert into public.advisor_order_drafts(advisor_user_id,status,title,client_id,client_snapshot,payload)
    values(root.advisor_user_id,'draft','Ampliación histórica · '||root.title,base.client_id,root.client_snapshot,
      jsonb_build_object('event_budget',jsonb_build_object('kind','admin_event_budget'),'event_extension',ext)) returning id into child_id;
  detail:=format(E'200 Mini Tequeños Fritos\n@sel|5|200\n@prep|5|kitchen\n@event|draft|%s',child_id);
  lines:=jsonb_build_array(jsonb_build_object('product_id',105,'qty',1,'notes',detail,
    'unit_usd',111.20,'line_usd',111.20,'unit_bs',bs,'line_bs',bs,'currency','USD','unit_origin',111.20));
  -- Insert already delivered: intentionally do not replay status transitions or stock consumption.
  insert into public.orders(order_number,client_id,created_by_user_id,attributed_advisor_id,source,fulfillment,status,
    total_usd,total_bs_snapshot,receiver_name,receiver_phone,notes,extra_fields)
    values('EV-'||child_id::text||'-'||substr(md5(child_id::text),1,6),base.client_id,actor,root.advisor_user_id,'advisor','pickup','delivered',
      111.20,bs,base.receiver_name,base.receiver_phone,
      'Ampliación histórica de orden #2667: 40 combos de 5 UND (200 Mini Tequeños Fritos), US$111,20. Ya entregada el 18/09/2026; hora exacta no registrada. Pago pendiente. No reenviar a cocina.',
      jsonb_build_object('schedule',base.extra_fields->'schedule',
        'pricing',jsonb_build_object('fx_rate',fx,'subtotal_usd',111.20,'subtotal_bs',bs,'total_usd',111.20,'total_bs',bs,
          'subtotal_after_discount_usd',111.20,'subtotal_after_discount_bs',bs,'discount_enabled',false,'discount_pct',0,
          'discount_amount_usd',0,'discount_amount_bs',0,'invoice_tax_pct',0,'invoice_tax_amount_usd',0,'invoice_tax_amount_bs',0),
        'payment',jsonb_build_object('currency','USD','method','payment_mobile','client_fund_used_usd',0,'requires_change',false),
        'ui',jsonb_build_object('quote_only',false),
        'event_budget',jsonb_build_object('draft_id',child_id,'title',root.title,'commission_mode','default','commission_value',null),
        'event_extension',jsonb_build_object('root_id',root.id,'root_order_id',base.id,'request_draft_id',child_id),
        'historical_regularization',history)) returning id into child_order;
  update public.advisor_order_drafts set converted_order_id=child_order,
    payload=jsonb_set(payload,'{event_extension}',ext||jsonb_build_object('order_lines',lines)) where id=child_id;
  insert into public.order_items(order_id,product_id,qty,notes) values(child_order,105,1,detail) returning id into child_item;
  insert into public.order_admin_adjustments(order_id,order_item_id,adjustment_type,reason,notes,payload,created_by_user_id)
    values(child_order,child_item,'other','Regularización autorizada de ampliación histórica',
      '40 combos adicionales de 5 UND a US$2,78. Conserva presupuesto inicial y comisión general. Sin consumo de stock actual.',
      jsonb_build_object('kind','event_commercial_terms','draft_id',child_id,'root_id',root.id,
        'negotiated_currency','USD','negotiated_amount',111.20,'total_usd',111.20,'fx_rate',fx,
        'commission_mode','default','commission_value',null,'authorized_by',actor,'components',components,
        'historical_regularization',history),actor);
  update public.orders set total_usd=111.20,total_bs_snapshot=bs where id=child_order;
  update public.advisor_order_drafts set status='converted',converted_at=clock_timestamp(),total_usd=111.20,total_bs=bs,fx_rate=fx,
    payload=jsonb_set(payload,'{event_extension}',ext||jsonb_build_object('stage','approved','order_lines',lines,
      'approved_by',actor,'approved_at',clock_timestamp())) where id=child_id;
  -- Reporting date is the confirmed event date. 16:00 is only its scheduled reference,
  -- never asserted as the additional delivery's actual time; recorded_at stays explicit.
  insert into public.order_events(order_id,event,performed_by,created_at,meta)
    values(child_order,'delivered',actor,'2026-09-18T16:00:00-04:00',history||jsonb_build_object(
      'fulfillment','pickup','pending_usd',111.20,'payment_status','unpaid','delivered_by_role','admin',
      'pending_reports_count',0,'historical',true));
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values(base.id,base.order_number,'event_extension_historical_regularization','order',
      'Ampliación histórica registrada · 200 UND',
      '40 combos adicionales de 5 UND: US$111,20. Evento total: 450 UND y US$263,30, pendiente de pago. No requiere preparación ni nueva entrega.',
      'info',actor,history||jsonb_build_object('event_root_id',root.id,'request_draft_id',child_id,
        'extension_order_id',child_order,'href','/app/events/671')) returning id into timeline_id;
  insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action) values(timeline_id,root.advisor_user_id,false);
  insert into public.order_timeline_event_recipients(event_id,target_role,requires_action) values(timeline_id,'master',false);

  if (select to_jsonb(o) from public.orders o where id=base.id) is distinct from original
    or (select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where order_id=base.id) is distinct from original_items
    or (select jsonb_agg(to_jsonb(m) order by m.id) from public.inventory_movements m where order_id=base.id) is distinct from original_movements then
    raise exception 'Original order/items/inventory must remain unchanged.';
  end if;
  if exists(select 1 from public.inventory_movements where order_id=child_order)
    or exists(select 1 from public.inventory_planned_flows where order_id=child_order)
    or exists(select 1 from public.money_movements where order_id=child_order)
    or exists(select 1 from public.payment_reports where order_id=child_order)
    or not exists(select 1 from public.order_item_components where order_item_id=child_item and component_product_id=5 and qty=200)
    or (select count(*) from public.order_item_components where order_item_id=child_item)<>1 then
    raise exception 'Unexpected inventory/payment/composition effects.';
  end if;
  if not exists(select 1 from public.orders where id=child_order and status::text='delivered'
    and sent_to_kitchen_at is null and kitchen_started_at is null and ready_at is null
    and not coalesce(needs_reapproval,false) and not coalesce(queued_needs_reapproval,false)) then
    raise exception 'Historical extension must not reopen operations.';
  end if;
  select * into strict finance from public.get_order_financial_state(child_order);
  if finance.total_usd <> 111.20 or finance.pending_usd <> 111.20 or finance.confirmed_paid_usd <> 0
    or finance.snapshot_rate_bs_per_usd<>fx or finance.delivery_reference_date <> '2026-09-18'::date
    or (select sum(total_usd) from public.orders where id in (base.id,child_order))<>263.30 then
    raise exception 'Unexpected consolidated financial result.';
  end if;
end $repair$;

select d.id extension_draft_id,d.converted_order_id extension_order_id,
  d.payload #>> '{event_extension,stage}' stage,f.*
from public.advisor_order_drafts d
cross join lateral public.get_order_financial_state(d.converted_order_id) f
where d.payload #>> '{event_extension,request_id}'='f8795f80-1328-4ba5-a689-946406467d12';
rollback;
