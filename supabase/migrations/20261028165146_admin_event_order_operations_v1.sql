-- Narrow, administrative event operations. Existing orders/drafts are never backfilled.
-- All writes run with the caller's RLS and the ordinary pricing/inventory triggers.
create or replace function public.admin_event_order_read_v1(p_order_id bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  o public.orders%rowtype; item public.order_items%rowtype; terms jsonb; commission jsonb;
  parts jsonb; breakdown jsonb; products jsonb; currency text; amount numeric;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'Solo Administración puede modificar el evento.' using errcode='42501';
  end if;
  select * into o from public.orders where id=p_order_id;
  if not found or o.extra_fields->'event_budget' is null or o.extra_fields ? 'event_extension' then
    raise exception 'Esta orden no es el evento inicial. Las ampliaciones conservan su autorización propia.';
  end if;
  select i.* into strict item from public.order_items i join public.products p on p.id=i.product_id
    where i.order_id=o.id and p.sku='PACK_EVENTO';
  if item.qty<>1 or exists(select 1 from public.order_items i left join public.products p on p.id=i.product_id
    where i.order_id=o.id and i.id<>item.id and (i.line_total_usd<>0 or i.line_total_bs_snapshot<>0
      or not (coalesce(p.internal_rider_pay_usd,0)>0 or p.name ilike '%delivery%'))) then
    raise exception 'Este evento tiene otras partidas. Revisa sus precios desde el editor general antes de modificar su composición.';
  end if;
  select payload into terms from public.order_admin_adjustments
    where order_id=o.id and order_item_id=item.id and payload->>'kind'='event_commercial_terms'
    order by created_at desc,id desc limit 1;
  select payload into commission from public.order_admin_adjustments
    where order_id=o.id and order_item_id=item.id and payload->>'kind'='order_commission_terms'
    order by created_at desc,id desc limit 1;
  if commission->>'action'='clear' then commission:=null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',component_product_id,'product_name',component_name_snapshot,
    'qty',qty,'preparation_mode',preparation_mode) order by component_product_id),'[]') into parts
    from public.order_item_components where order_item_id=item.id;
  if jsonb_array_length(parts)=0 then raise exception 'La composición del evento requiere revisión de inventario antes de editar.'; end if;
  currency:=coalesce(item.pricing_origin_currency,terms->>'negotiated_currency','USD');
  amount:=case when currency='VES' then item.line_total_bs_snapshot else item.line_total_usd end;
  breakdown:=terms->'commercial_breakdown';
  -- Read the prior audited Bellavista format as well as the new currency-neutral format.
  if breakdown is not null and breakdown<>'null'::jsonb then
    breakdown:=jsonb_build_object('combos',breakdown->'combos','pieces_per_combo',breakdown->'pieces_per_combo',
      'price_per_combo',coalesce(breakdown->'price_per_combo',breakdown->'price_per_combo_usd'),
      'stand',coalesce(breakdown->'stand',breakdown->'stand_usd'),'discount_pct',breakdown->'discount_pct');
    -- A later price correction may have superseded the old explanatory breakdown.
    if (terms->>'negotiated_amount')::numeric is distinct from amount then breakdown:=null; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by p.name),'[]') into products
    from public.products p where p.is_active and p.sku<>'PACK_EVENTO'
      and coalesce(p.extra_fields->>'catalog_access_scope','')<>'admin_internal'
      and not coalesce(p.is_detail_editable,false) and coalesce(p.inventory_policy::text,'')<>'components'
      and coalesce(p.internal_rider_pay_usd,0)=0 and p.name not ilike '%delivery%'
      and not exists(select 1 from public.product_components pc where pc.parent_product_id=p.id);
  return jsonb_build_object('order_id',o.id,'version',o.last_modified_at,'status',o.status,
    'title',coalesce(o.extra_fields#>>'{event_budget,title}',item.product_name_snapshot),
    'currency',currency,'amount',amount,'total_usd',o.total_usd,
    'fx_rate',(o.extra_fields#>>'{pricing,fx_rate}')::numeric,
    'components_editable',o.status::text in ('created','queued'),'components',parts,'breakdown',breakdown,
    'commission_mode',coalesce(commission->>'commission_mode',terms->>'commission_mode','default'),
    'commission_value',coalesce(commission->'commission_value',terms->'commission_value'),'products',products);
end $$;

create or replace function public.admin_event_order_update_v1(p_order_id bigint,p_expected_version timestamptz,p_input jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  o public.orders%rowtype; item public.order_items%rowtype; before_state jsonb; after_state jsonb;
  old_terms jsonb; parts jsonb:='[]'; entry jsonb; p public.products%rowtype;
  changed boolean; amount numeric; usd numeric; bs numeric; fx numeric; currency text;
  b jsonb; combos numeric; pieces numeric; price numeric; stand numeric; pct numeric;
  subtotal numeric; discount numeric; detail text:=''; why text; event_id bigint; old_inventory text;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'Solo Administración puede modificar el evento.' using errcode='42501';
  end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'La orden no está disponible.'; end if;
  if o.last_modified_at is distinct from p_expected_version then
    raise exception 'La orden cambió mientras la editabas. Cierra y vuelve a abrir el evento.' using errcode='40001';
  end if;
  before_state:=public.admin_event_order_read_v1(o.id);
  if o.status::text='cancelled' then raise exception 'La orden está cancelada.'; end if;
  select i.* into strict item from public.order_items i join public.products catalog on catalog.id=i.product_id
    where i.order_id=o.id and catalog.sku='PACK_EVENTO' for update of i;
  why:=btrim(p_input->>'reason');
  if why is null or length(why) not between 1 and 1000 then raise exception 'Indica el motivo del cambio (hasta 1000 caracteres).'; end if;
  currency:=before_state->>'currency'; fx:=(before_state->>'fx_rate')::numeric;
  if currency not in ('USD','VES') or fx is null or fx<=0 or fx::text in ('NaN','Infinity','-Infinity') then
    raise exception 'La moneda o tasa guardada del evento requiere revisión.';
  end if;
  if p_input->>'mode'='breakdown' then
    b:=p_input->'breakdown'; combos:=(b->>'combos')::numeric; pieces:=(b->>'pieces_per_combo')::numeric;
    price:=(b->>'price_per_combo')::numeric; stand:=(b->>'stand')::numeric; pct:=(b->>'discount_pct')::numeric;
    if combos is null or combos<>trunc(combos) or combos not between 1 and 100000
      or pieces is null or pieces<>trunc(pieces) or pieces not between 1 and 1000
      or price is null or price not between 0 and 10000000 or stand is null or stand not between 0 and 10000000
      or pct is null or pct not between 0 and 100 or price<>round(price,2) or stand<>round(stand,2) or pct<>round(pct,2)
      then raise exception 'Revisa cantidades, precios y descuento del evento. Usa hasta dos decimales.'; end if;
    subtotal:=round(combos*round(price,2),2)+round(stand,2); discount:=round(subtotal*pct/100,2);
    amount:=round(subtotal-discount,2);
    b:=b||jsonb_build_object('products',round(combos*round(price,2),2),'subtotal',subtotal,'discount',discount,
      'total',amount,'currency',currency,'discount_included_in_negotiated_amount',true);
  elsif p_input->>'mode'='total' then amount:=(p_input->>'amount')::numeric;
  else raise exception 'Selecciona cómo calcular el precio.'; end if;
  if amount is null or amount not between 0 and 10000000 or amount<>round(amount,2) or subtotal>10000000 then raise exception 'Indica un total válido con hasta dos decimales.'; end if;
  usd:=round(case when currency='USD' then amount else amount/fx end,2);
  bs:=round(case when currency='VES' then amount else amount*fx end,2);
  if coalesce((o.extra_fields#>>'{pricing,invoice_tax_pct}')::numeric,0)<>0
    or coalesce((o.extra_fields#>>'{pricing,discount_pct}')::numeric,0)<>0 then
    raise exception 'Este evento tiene impuesto o descuento adicional en la orden. Revisa esas condiciones desde el editor general.';
  end if;
  if jsonb_typeof(p_input->'components') is distinct from 'array'
    or jsonb_array_length(p_input->'components') not between 1 and 50 then raise exception 'El evento debe tener entre 1 y 50 productos.'; end if;
  for entry in select value from jsonb_array_elements(p_input->'components') loop
    if (entry->>'qty')::numeric is null or (entry->>'qty')::numeric not between 1 and 1000000
      or (entry->>'qty')::numeric<>trunc((entry->>'qty')::numeric)
      or coalesce(entry->>'preparation_mode','') not in ('kitchen','on_site','not_applicable') then
      raise exception 'Revisa las unidades y la preparación de cada producto.';
    end if;
    select * into p from public.products where id=(entry->>'product_id')::bigint for share;
    if not found then raise exception 'El producto ya no existe.'; end if;
    if exists(select 1 from jsonb_array_elements(parts) x where x->>'product_id'=p.id::text) then raise exception 'Un producto está repetido.'; end if;
    parts:=parts||jsonb_build_array(jsonb_build_object('product_id',p.id,'product_name',p.name,
      'qty',(entry->>'qty')::numeric,'preparation_mode',entry->>'preparation_mode'));
  end loop;
  -- Compare only operational identity: names may have changed in the live catalog.
  if p_input->>'mode'='breakdown' and jsonb_array_length(parts)=1 and (parts#>>'{0,qty}')::numeric<>combos*pieces then
    raise exception 'Las piezas del producto deben coincidir con los combitos y las piezas por combito.';
  end if;
  changed:=(select jsonb_agg(x-'product_name' order by (x->>'product_id')::bigint) from jsonb_array_elements(parts)x)
    is distinct from (select jsonb_agg(x-'product_name' order by (x->>'product_id')::bigint) from jsonb_array_elements(before_state->'components')x);
  if changed and o.status::text not in ('created','queued') then
    raise exception 'La preparación ya comenzó. Aquí puedes ajustar el precio; para cambiar piezas primero devuelve la orden a cola por el circuito operativo.';
  end if;
  if changed then
    for entry in select value from jsonb_array_elements(parts) loop
      select * into p from public.products where id=(entry->>'product_id')::bigint;
      if p.is_active is not true or coalesce(p.is_detail_editable,false) or p.inventory_policy::text='components'
        or coalesce(p.extra_fields->>'catalog_access_scope','')='admin_internal'
        or coalesce(p.internal_rider_pay_usd,0)>0 or p.name ilike '%delivery%'
        or exists(select 1 from public.product_components pc where pc.parent_product_id=p.id) then
        raise exception 'Selecciona productos activos de composición fija. El delivery se modifica desde la entrega.';
      end if;
      insert into public.product_components(parent_product_id,component_product_id,component_mode,quantity,counts_toward_detail_limit,is_required,sort_order)
        values(item.product_id,p.id,'selectable',1,true,false,1000)
        on conflict(parent_product_id,component_product_id,component_mode) do nothing;
      detail:=detail||format(E'%s %s\n@sel|%s|%s\n@prep|%s|%s\n',entry->>'qty',p.name,p.id,entry->>'qty',p.id,entry->>'preparation_mode');
    end loop;
    detail:=detail||format('@event|draft|%s',o.extra_fields#>>'{event_budget,draft_id}');
  else detail:=item.notes; parts:=before_state->'components'; end if;
  select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id)::text,'[]')) into old_inventory
    from public.inventory_movements m where m.order_id=o.id;
  select payload into old_terms from public.order_admin_adjustments where order_id=o.id and order_item_id=item.id
    and payload->>'kind'='event_commercial_terms' order by created_at desc,id desc limit 1;
  -- The accepted draft remains immutable. A new terms entry explains this revision.
  insert into public.order_admin_adjustments(order_id,order_item_id,adjustment_type,reason,payload,created_by_user_id)
  values(o.id,item.id,'other',why,coalesce(old_terms,'{}')||jsonb_build_object('kind','event_commercial_terms',
    'source','admin_event_order_editor','schema_version',1,'draft_id',o.extra_fields#>'{event_budget,draft_id}',
    'negotiated_currency',currency,'negotiated_amount',amount,'total_usd',usd,'fx_rate',fx,
    'components',parts,'commercial_breakdown',b),auth.uid());
  update public.order_items set notes=detail,pricing_origin_currency=currency,pricing_origin_amount=amount,
    unit_price_usd_snapshot=usd,line_total_usd=usd,unit_price_bs_snapshot=bs,line_total_bs_snapshot=bs,
    admin_price_override_usd=case when currency='VES' then amount/fx else usd end,
    admin_price_override_reason=why,admin_price_override_by_user_id=auth.uid(),admin_price_override_at=clock_timestamp()
    where id=item.id;
  update public.orders set total_usd=usd,total_bs_snapshot=bs,
    extra_fields=jsonb_set(extra_fields,'{pricing}',coalesce(extra_fields->'pricing','{}')||jsonb_build_object(
      'subtotal_usd',usd,'subtotal_bs',bs,'total_usd',usd,'total_bs',bs,
      'subtotal_after_discount_usd',usd,'subtotal_after_discount_bs',bs,
      'discount_enabled',false,'discount_pct',0,'discount_amount_usd',0,'discount_amount_bs',0)),
    last_modified_at=clock_timestamp(),last_modified_by=auth.uid(),
    queued_needs_reapproval=case when status::text='queued' then true else queued_needs_reapproval end,
    queued_last_modified_at=case when status::text='queued' then clock_timestamp() else queued_last_modified_at end,
    queued_last_modified_by=case when status::text='queued' then auth.uid() else queued_last_modified_by end where id=o.id;
  after_state:=public.admin_event_order_read_v1(o.id);
  if (after_state->>'amount')::numeric<>amount or (after_state->>'total_usd')::numeric<>usd
    or (select jsonb_agg(x-'product_name' order by (x->>'product_id')::bigint) from jsonb_array_elements(after_state->'components')x)
      is distinct from (select jsonb_agg(x-'product_name' order by (x->>'product_id')::bigint) from jsonb_array_elements(parts)x) then
    raise exception 'La composición o el precio no pudo guardarse completo. No se aplicó el cambio.';
  end if;
  if old_inventory is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id)::text,'[]'))
    from public.inventory_movements m where m.order_id=o.id) then raise exception 'La revisión intentó mover inventario físico. No se aplicó el cambio.'; end if;
  insert into public.order_admin_adjustments(order_id,order_item_id,adjustment_type,reason,payload,created_by_user_id)
    values(o.id,item.id,'item_price_override',why,jsonb_build_object('source','admin_event_order_editor',
      'kind','item_price_override','product_name',item.product_name_snapshot,'qty',1,
      'original_unit_price_usd',item.unit_price_usd_snapshot,'override_unit_price_usd',usd,
      'override_source_currency',currency,'override_source_amount',amount,
      'original_line_total_usd',item.line_total_usd,'override_line_total_usd',usd,'delta_usd',usd-item.line_total_usd,
      'before',before_state-'products','after',after_state-'products'),auth.uid());
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values(o.id,o.order_number,'order_modified','order','Evento modificado',why,'warning',auth.uid(),
      jsonb_build_object('source','admin_event_order_editor','components_changed',changed,
      'before',before_state-'products','after',after_state-'products')) returning id into event_id;
  insert into public.order_timeline_event_recipients(event_id,target_role,requires_action)
    values(event_id,'master',o.status::text='queued');
  return jsonb_build_object('total_usd',usd,'amount',amount);
end $$;

revoke all on function public.admin_event_order_read_v1(bigint) from public,anon;
revoke all on function public.admin_event_order_update_v1(bigint,timestamptz,jsonb) from public,anon;
grant execute on function public.admin_event_order_read_v1(bigint) to authenticated;
grant execute on function public.admin_event_order_update_v1(bigint,timestamptz,jsonb) to authenticated;

-- One draft row lock serializes conversion/retry. No order can commit without
-- its items, accepted commercial terms, draft link and actionable notification.
create or replace function public.convert_event_budget_atomic_v1(p_draft_id bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  d public.advisor_order_drafts%rowtype; ev jsonb; p public.products%rowtype;
  parent public.products%rowtype; client public.clients%rowtype; entry jsonb;
  actor uuid:=auth.uid(); amount numeric; usd numeric; bs numeric; fx numeric; currency text;
  cid bigint; oid bigint; iid bigint; event_id bigint; mode text; commission numeric;
  details text:=''; parts jsonb:='[]'; deliveries jsonb:='[]'; quantity numeric;
  v_phone text; v_full_name text; extra jsonb; existing_number text; address text;
begin
  if actor is null or public.is_admin() is not true then
    raise exception 'Solo Administración puede convertir presupuestos de eventos.' using errcode='42501';
  end if;
  select * into d from public.advisor_order_drafts where id=p_draft_id for update;
  if not found then raise exception 'El presupuesto ya no existe.'; end if;
  ev:=d.payload->'event_budget';
  if ev->>'kind' is distinct from 'admin_event_budget' or d.payload ? 'event_extension' then raise exception 'Este borrador no es un presupuesto inicial de evento.'; end if;
  if d.converted_order_id is not null then
    select order_number into existing_number from public.orders where id=d.converted_order_id;
    if not found then raise exception 'El presupuesto tiene una vinculación incompleta. Administración debe revisarla antes de reintentar.'; end if;
    return jsonb_build_object('id',d.converted_order_id,'orderNumber',existing_number,'reused',true);
  end if;
  if d.status not in ('draft','quoted') then raise exception 'El presupuesto está archivado o ya no se puede convertir.'; end if;
  if not exists(select 1 from public.get_advisor_profiles() a where a.user_id=d.advisor_user_id and a.is_active is distinct from false) then
    raise exception 'El asesor del presupuesto ya no está activo.';
  end if;
  fx:=d.fx_rate; currency:=ev->>'negotiated_currency'; amount:=(ev->>'negotiated_amount')::numeric;
  mode:=coalesce(ev->>'commission_mode','default'); commission:=(ev->>'commission_value')::numeric;
  if fx is null or fx<=0 or fx::text in ('NaN','Infinity','-Infinity') or currency not in ('USD','VES')
    or currency is null or amount is null or amount not between 0 and 10000000 then raise exception 'Revisa la moneda, el precio y la tasa guardada del presupuesto.'; end if;
  if mode not in ('default','none','fixed_item','fixed_order') or (mode in ('fixed_item','fixed_order') and (commission is null or commission not between 0 and 100)) then
    raise exception 'Las condiciones de comisión requieren revisión.';
  end if;
  if coalesce(ev->>'event_date','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(ev->>'event_time','')!~'^([01]\d|2[0-3]):[0-5]\d$'
    or coalesce(ev->>'fulfillment','') not in ('pickup','delivery') then raise exception 'Revisa fecha, hora y entrega del evento.'; end if;
  perform (ev->>'event_date')::date;
  address:=nullif(btrim(ev->>'delivery_address'),'');
  if ev->>'fulfillment'='delivery' and address is null then raise exception 'Indica la dirección del evento.'; end if;
  usd:=round(case when currency='VES' then amount/fx else amount end,2);
  bs:=round(case when currency='VES' then amount else amount*fx end,2);
  if d.total_usd is distinct from usd or d.total_bs is distinct from bs then raise exception 'El total guardado no coincide con las condiciones del presupuesto. Revisa el presupuesto antes de convertir.'; end if;
  select * into parent from public.products where sku='PACK_EVENTO' for share;
  if not found then raise exception 'Falta el identificador interno del evento.'; end if;
  if jsonb_typeof(ev->'components') is distinct from 'array' or jsonb_array_length(ev->'components') not between 1 and 50 then raise exception 'Agrega productos al evento.'; end if;
  for entry in select value from jsonb_array_elements(ev->'components') loop
    select * into p from public.products where id=(entry->>'product_id')::bigint for share;
    quantity:=(entry->>'qty')::numeric;
    if not found or p.is_active is not true or p.id=parent.id or coalesce(p.extra_fields->>'catalog_access_scope','')='admin_internal'
      or quantity is null or quantity not between 1 and 1000000 or quantity<>trunc(quantity)
      or coalesce(entry->>'preparation_mode','') not in ('kitchen','on_site','not_applicable') then raise exception 'Revisa los productos, unidades y preparación del presupuesto.'; end if;
    if coalesce(p.internal_rider_pay_usd,0)>0 or p.name ilike '%delivery%' then
      deliveries:=deliveries||jsonb_build_array(jsonb_build_object('product_id',p.id,'qty',quantity));
    else
      parts:=parts||jsonb_build_array(jsonb_build_object('product_id',p.id,'product_name',p.name,'qty',quantity,'preparation_mode',entry->>'preparation_mode'));
      insert into public.product_components(parent_product_id,component_product_id,component_mode,quantity,counts_toward_detail_limit,is_required,sort_order)
        values(parent.id,p.id,'selectable',1,true,false,1000) on conflict(parent_product_id,component_product_id,component_mode) do nothing;
      details:=details||format(E'%s %s\n@sel|%s|%s\n@prep|%s|%s\n',quantity,p.name,p.id,quantity,p.id,entry->>'preparation_mode');
    end if;
  end loop;
  if jsonb_array_length(parts)=0 then raise exception 'Agrega al menos un producto real además del delivery.'; end if;
  if ev->>'fulfillment'='delivery' and jsonb_array_length(deliveries)=0 then raise exception 'Agrega el producto de delivery al presupuesto.'; end if;
  details:=details||format('@event|draft|%s',d.id);
  if d.client_id is not null then
    select * into client from public.clients where id=d.client_id for update;
    if not found then raise exception 'El cliente ya no existe.'; end if;
    cid:=client.id;
  else
    v_full_name:=nullif(btrim(coalesce(d.new_client_snapshot->>'full_name',d.new_client_snapshot->>'fullName')),'');
    v_phone:=regexp_replace(coalesce(d.new_client_snapshot->>'phone',''),'\D','','g');
    if v_phone like '00%' then v_phone:=substr(v_phone,3);
    elsif v_phone like '0%' and length(v_phone)>=10 then v_phone:='58'||substr(v_phone,2);
    elsif length(v_phone) between 9 and 10 then v_phone:='58'||v_phone; end if;
    v_phone:='+'||v_phone;
    if v_full_name is null or v_phone!~'^\+[1-9]\d{6,14}$' then raise exception 'Revisa el nombre y teléfono del nuevo cliente.'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('event-client:'||v_phone,0));
    select * into client from public.clients c where c.phone=v_phone order by c.id limit 1 for update;
    if found then cid:=client.id;
    else insert into public.clients(full_name,phone,client_type) values(v_full_name,v_phone,'assigned') returning * into client; cid:=client.id; end if;
  end if;
  -- Add the delivery address without overwriting fiscal/commercial client fields.
  if ev->>'fulfillment'='delivery' then
    update public.clients set recent_addresses=(select jsonb_agg(value) from (
      select jsonb_build_object('address_text',address,'gps_url',null) as value,0 as n
      union all select value,ordinality::integer from jsonb_array_elements(coalesce(client.recent_addresses,'[]')) with ordinality
        where value->>'address_text' is distinct from address order by n limit 2) addresses) where id=cid;
  end if;
  extra:=jsonb_build_object('schedule',jsonb_build_object('date',ev->>'event_date','time_24',ev->>'event_time','asap',false),
    'receiver',jsonb_build_object('name',client.full_name,'phone',client.phone),
    'pricing',jsonb_build_object('fx_rate',fx,'subtotal_usd',usd,'subtotal_bs',bs,'total_usd',usd,'total_bs',bs,
      'subtotal_after_discount_usd',usd,'subtotal_after_discount_bs',bs,'discount_enabled',false,'discount_pct',0,
      'discount_amount_usd',0,'discount_amount_bs',0,'invoice_tax_pct',0,'invoice_tax_amount_usd',0,'invoice_tax_amount_bs',0),
    'payment',jsonb_build_object('currency',currency,'method',null,'requires_change',false,'client_fund_used_usd',0),
    'documents',jsonb_build_object('has_invoice',false,'has_delivery_note',false),
    'note',ev->>'notes','ui',jsonb_build_object('quote_only',false),
    'event_budget',jsonb_build_object('draft_id',d.id,'title',ev->>'title','commission_mode',mode,'commission_value',commission));
  insert into public.orders(order_number,client_id,created_by_user_id,attributed_advisor_id,source,fulfillment,status,
    total_usd,total_bs_snapshot,receiver_name,receiver_phone,delivery_address,notes,extra_fields)
    values('EV-'||d.id::text||'-'||substr(md5(d.id::text),1,6),cid,actor,d.advisor_user_id,'advisor',
      (ev->>'fulfillment')::public.fulfillment_type,'created',usd,bs,client.full_name,client.phone,
      case when ev->>'fulfillment'='delivery' then address else null end,ev->>'notes',extra) returning id into oid;
  insert into public.order_items(order_id,product_id,qty,notes,product_name_snapshot,sku_snapshot,
    pricing_origin_currency,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd,unit_price_bs_snapshot,line_total_bs_snapshot,
    admin_price_override_usd,admin_price_override_reason,admin_price_override_by_user_id,admin_price_override_at)
    values(oid,parent.id,1,details,ev->>'title',parent.sku,currency,amount,usd,usd,bs,bs,
      case when currency='VES' then amount/fx else usd end,'Precio negociado del evento: '||(ev->>'title'),actor,clock_timestamp()) returning id into iid;
  insert into public.order_admin_adjustments(order_id,order_item_id,adjustment_type,reason,payload,created_by_user_id)
    values(oid,iid,'other','Condiciones comerciales del evento',jsonb_build_object('kind','event_commercial_terms',
      'schema_version',1,'draft_id',d.id,'negotiated_currency',currency,'negotiated_amount',amount,'total_usd',usd,
      'fx_rate',fx,'commission_mode',mode,'commission_value',commission,'components',parts),actor);
  insert into public.order_admin_adjustments(order_id,order_item_id,adjustment_type,reason,payload,created_by_user_id)
    values(oid,iid,'item_price_override','Precio negociado del evento',jsonb_build_object('source','event_budget_conversion',
      'kind','item_price_override','product_name',ev->>'title','qty',1,
      'original_unit_price_usd',usd,'override_unit_price_usd',usd,'override_source_currency',currency,'override_source_amount',amount,
      'original_line_total_usd',usd,'override_line_total_usd',usd,'delta_usd',0),actor);
  for entry in select value from jsonb_array_elements(deliveries) loop
    insert into public.order_items(order_id,product_id,qty,notes,unit_price_usd_snapshot,line_total_usd,
      unit_price_bs_snapshot,line_total_bs_snapshot,pricing_origin_currency,pricing_origin_amount,
      admin_price_override_usd,admin_price_override_reason,admin_price_override_by_user_id,admin_price_override_at)
      values(oid,(entry->>'product_id')::bigint,(entry->>'qty')::numeric,null,0,0,0,0,'USD',0,
        0,'Incluido dentro del precio negociado del evento.',actor,clock_timestamp());
  end loop;
  update public.orders set total_usd=usd,total_bs_snapshot=bs,extra_fields=extra where id=oid;
  update public.advisor_order_drafts set status='converted',converted_order_id=oid,converted_at=clock_timestamp(),updated_at=clock_timestamp() where id=d.id;
  -- Fail closed if a nonblocking inventory trigger could not freeze a component.
  if exists(select 1 from jsonb_array_elements(parts)x where not exists(select 1 from public.order_item_components c
    where c.order_item_id=iid and c.component_product_id=(x->>'product_id')::bigint
      and c.qty=(x->>'qty')::numeric and c.preparation_mode=x->>'preparation_mode')) then
    raise exception 'No se pudo guardar la composición completa. El presupuesto sigue disponible para corregir y reintentar.';
  end if;
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    select oid,order_number,'order_created','approval','Orden creada','Evento pendiente de aprobación.','warning',actor,
      jsonb_build_object('source','event_budget_conversion','draft_id',d.id) from public.orders where id=oid returning id into event_id;
  insert into public.order_timeline_event_recipients(event_id,target_role,requires_action) values(event_id,'master',true);
  insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action) values(event_id,d.advisor_user_id,false);
  return jsonb_build_object('id',oid,'reused',false);
end $$;
revoke all on function public.convert_event_budget_atomic_v1(bigint) from public,anon;
grant execute on function public.convert_event_budget_atomic_v1(bigint) to authenticated;
