-- Reuse administrative budgets as event roots and extension requests. No parallel ledger.
create index if not exists advisor_drafts_event_root_v1
on public.advisor_order_drafts ((payload #>> '{event_extension,root_id}'))
where payload ? 'event_extension';
create unique index if not exists advisor_drafts_event_request_v1
on public.advisor_order_drafts ((payload #>> '{event_extension,request_id}'))
where payload ? 'event_extension';

-- An ordinary editor rebuilds extra_fields. Preserve event identity, never overwrite it.
create or replace function app_private.preserve_event_identity_v1() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.extra_fields ? 'event_budget' then
    new.extra_fields := coalesce(new.extra_fields,'{}') || jsonb_build_object('event_budget',old.extra_fields->'event_budget');
  end if;
  if old.extra_fields ? 'event_extension' then
    new.extra_fields := coalesce(new.extra_fields,'{}') || jsonb_build_object('event_extension',old.extra_fields->'event_extension');
  end if;
  return new;
end $$;
create trigger orders_preserve_event_identity_v1 before update of extra_fields on public.orders
for each row execute function app_private.preserve_event_identity_v1();

-- Existing pricing triggers use catalog prices. This final BEFORE trigger uses ONLY
-- an approved administrative quote linked to this exact new order, not client prices.
create or replace function app_private.event_extension_item_snapshot_v1() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d public.advisor_order_drafts%rowtype; e jsonb; l jsonb;
begin
  select extra_fields->'event_extension' into e from public.orders where id=coalesce(new.order_id,old.order_id);
  if e is null then return coalesce(new,old); end if;
  select * into d from public.advisor_order_drafts where id=(e->>'request_draft_id')::bigint;
  if tg_op <> 'INSERT' or d.converted_order_id is distinct from new.order_id
    or d.payload #>> '{event_extension,stage}' is distinct from 'creating' then
    raise exception 'Esta ampliación conserva su presupuesto. Cancela y solicita una nueva ampliación para cambiar su contenido.' using errcode='55000';
  end if;
  select value into l from jsonb_array_elements(d.payload #> '{event_extension,order_lines}')
    where (value->>'product_id')::bigint=new.product_id;
  if l is null or new.qty is distinct from (l->>'qty')::numeric
    or new.notes is distinct from (l->>'notes')
    or exists(select 1 from public.order_items where order_id=new.order_id and product_id=new.product_id) then
    raise exception 'La línea no corresponde a la ampliación autorizada.';
  end if;
  new.unit_price_usd_snapshot := (l->>'unit_usd')::numeric;
  new.line_total_usd := (l->>'line_usd')::numeric;
  new.unit_price_bs_snapshot := (l->>'unit_bs')::numeric;
  new.line_total_bs_snapshot := (l->>'line_bs')::numeric;
  new.pricing_origin_currency := l->>'currency';
  new.pricing_origin_amount := (l->>'unit_origin')::numeric;
  return new;
end $$;
create trigger z_event_extension_item_snapshot_v1 before insert or update or delete on public.order_items
for each row execute function app_private.event_extension_item_snapshot_v1();

create or replace function app_private.event_workspace_command_v1(
  p_root_id bigint,p_action text,p_input jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid:=auth.uid(); root public.advisor_order_drafts%rowtype;
  req public.advisor_order_drafts%rowtype; base public.orders%rowtype;
  product public.products%rowtype; ev jsonb; ext jsonb; rates jsonb; rate jsonb;
  row_data jsonb; rows_data jsonb:='[]'; components jsonb:='[]'; order_lines jsonb:='[]';
  qty numeric; amount numeric; total numeric:=0; fx numeric; usd numeric; bs numeric;
  currency text; mode text; commission numeric; request_id uuid; new_id bigint;
  order_id_new bigint; item_id bigint; technical_id bigint; event_id bigint;
  detail text:=''; composed_amount numeric:=0; can_price boolean:=true; title text;
begin
  if actor is null then raise exception 'No autenticado.' using errcode='42501'; end if;
  select * into root from public.advisor_order_drafts where id=p_root_id for update;
  if not found or root.payload #>> '{event_budget,kind}' is distinct from 'admin_event_budget'
    or root.payload ? 'event_extension' then raise exception 'El evento no existe.'; end if;
  if not public.is_master_or_admin() and (not public.has_role('advisor') or root.advisor_user_id is distinct from actor) then
    raise exception 'No tienes acceso a este evento.' using errcode='42501';
  end if;
  ev:=root.payload->'event_budget'; rates:=coalesce(root.payload #> '{event_terms,rates}','[]');
  if p_action='terms' then
    if not public.is_admin() then raise exception 'Solo Administración autoriza precios y comisiones.' using errcode='42501'; end if;
    currency:=p_input->>'currency'; mode:=p_input->>'commission_mode';
    commission:=(p_input->>'commission_value')::numeric;
    if currency is null or currency not in ('USD','VES') or mode is null or mode not in ('default','fixed_item','none')
      or (mode='fixed_item' and (commission is null or commission<0 or commission>100 or commission::text in ('NaN','Infinity','-Infinity'))) then
      raise exception 'Moneda o comisión no válida.';
    end if;
    if jsonb_typeof(p_input->'rates') is distinct from 'array' or jsonb_array_length(p_input->'rates')>150 then raise exception 'Tarifas no válidas.'; end if;
    for row_data in select value from jsonb_array_elements(p_input->'rates') loop
      select * into product from public.products where id=(row_data->>'product_id')::bigint;
      amount:=(row_data->>'price')::numeric;
      if not found or not product.is_active or product.sku='PACK_EVENTO' or product.type::text='gambit'
        or coalesce(product.extra_fields->>'catalog_access_scope','')='admin_internal'
        or coalesce(product.is_detail_editable,false)
        or amount is null or amount<0 or amount::text in ('NaN','Infinity','-Infinity')
        or row_data->>'unit' is null or row_data->>'unit' not in ('UND','servicio','envase')
        or row_data->>'preparation_mode' is null or row_data->>'preparation_mode' not in ('kitchen','on_site','not_applicable') then
        raise exception 'Revisa producto, precio, unidad y preparación. Los productos configurables requieren un presupuesto específico.';
      end if;
      if exists(select 1 from jsonb_array_elements(rows_data) r where r->>'product_id'=product.id::text) then raise exception 'Producto repetido en tarifas.'; end if;
      rows_data:=rows_data||jsonb_build_array(jsonb_build_object('product_id',product.id,'product_name',product.name,
        'price',round(amount,4),'unit',row_data->>'unit','preparation_mode',row_data->>'preparation_mode'));
    end loop;
    update public.advisor_order_drafts set payload=payload||jsonb_build_object('event_terms',jsonb_build_object(
      'currency',currency,'commission_mode',mode,'commission_value',commission,'rates',rows_data,
      'authorized_by',actor,'authorized_at',clock_timestamp())) where id=root.id;
    return jsonb_build_object('ok',true);
  end if;
  if root.converted_order_id is null then raise exception 'Convierte primero el presupuesto inicial en orden.'; end if;
  select * into base from public.orders where id=root.converted_order_id;
  if p_action='request' then
    if coalesce(root.payload #>> '{event_state,closed}','false')='true' or base.status::text='cancelled' then raise exception 'Este evento está cerrado o cancelado.'; end if;
    request_id:=(p_input->>'request_id')::uuid;
    if request_id is null then raise exception 'Falta el identificador de la solicitud.'; end if;
    select * into req from public.advisor_order_drafts where payload #>> '{event_extension,request_id}'=request_id::text;
    if found then
      if req.payload #>> '{event_extension,root_id}' <> root.id::text
        or req.payload #> '{event_extension,request_input}' is distinct from p_input then raise exception 'La solicitud ya se utilizó con otros datos.'; end if;
      return jsonb_build_object('ok',true,'id',req.id,'reused',true);
    end if;
    if jsonb_typeof(p_input->'items') is distinct from 'array' or jsonb_array_length(p_input->'items') not between 1 and 150 then raise exception 'Agrega productos a la ampliación.'; end if;
    if nullif(p_input->>'date','') is null or nullif(p_input->>'time','') is null
      or (p_input->>'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Indica fecha y hora.'; end if;
    perform (p_input->>'date')::date;
    if p_input->>'fulfillment' is null or p_input->>'fulfillment' not in ('pickup','delivery') then raise exception 'Selecciona entrega o retiro.'; end if;
    if p_input->>'fulfillment'='delivery' and nullif(btrim(p_input->>'address'),'') is null then raise exception 'Indica la dirección.'; end if;
    for row_data in select value from jsonb_array_elements(p_input->'items') loop
      select * into product from public.products where id=(row_data->>'product_id')::bigint;
      qty:=(row_data->>'qty')::numeric;
      if not found or not product.is_active or product.sku='PACK_EVENTO' or product.type::text='gambit'
        or coalesce(product.extra_fields->>'catalog_access_scope','')='admin_internal'
        or coalesce(product.is_detail_editable,false)
        or qty is null or qty<=0 or qty>100000 or qty<>trunc(qty) then raise exception 'Selecciona productos activos y cantidades enteras positivas.'; end if;
      if exists(select 1 from jsonb_array_elements(rows_data) r where r->>'product_id'=product.id::text) then raise exception 'Combina las cantidades del producto repetido.'; end if;
      select value into rate from jsonb_array_elements(rates) where (value->>'product_id')::bigint=product.id;
      if rate is null then can_price:=false; end if;
      rows_data:=rows_data||jsonb_build_array(jsonb_build_object('product_id',product.id,'product_name',product.name,'qty',qty,
        'unit',coalesce(rate->>'unit','por definir'),'price',rate->'price','preparation_mode',coalesce(rate->>'preparation_mode','kitchen'),
        'physical_qty',qty * case when rate->>'unit'='servicio' and product.inventory_policy::text in ('self','direct') then greatest(coalesce(product.units_per_service,1),1) else 1 end,
        'is_delivery',coalesce(product.internal_rider_pay_usd,0)>0 or lower(product.name) like '%delivery%'));
    end loop;
    if p_input->>'fulfillment'='delivery' and not exists(select 1 from jsonb_array_elements(rows_data) r where (r->>'is_delivery')::boolean) then raise exception 'Agrega el servicio de delivery para este viaje.'; end if;
    if exists(select 1 from jsonb_array_elements(rows_data) r where (r->>'is_delivery')::boolean and (r->>'qty')::numeric<>1)
      or (select count(*) from jsonb_array_elements(rows_data) r where (r->>'is_delivery')::boolean)>1 then raise exception 'Cada ampliación admite un viaje. Solicita otra para un viaje adicional.'; end if;
    if not exists(select 1 from jsonb_array_elements(rows_data) r where not (r->>'is_delivery')::boolean) then raise exception 'Incluye los productos que se enviarán.'; end if;
    currency:=coalesce(root.payload #>> '{event_terms,currency}','USD');
    if can_price then select sum((r->>'qty')::numeric*(r->>'price')::numeric) into total from jsonb_array_elements(rows_data) r; end if;
    ext:=jsonb_build_object('root_id',root.id,'request_id',request_id,'request_input',p_input,
      'stage',case when can_price then 'priced' else 'requested' end,'items',rows_data,'currency',currency,
      'amount',case when can_price then round(total,2) else null end,'terms_snapshot',root.payload->'event_terms',
      'requested_by',actor,'requested_at',clock_timestamp());
    insert into public.advisor_order_drafts(advisor_user_id,status,title,client_id,client_snapshot,payload)
      values(root.advisor_user_id,'draft','Ampliación · '||root.title,base.client_id,root.client_snapshot,
        jsonb_build_object('event_budget',jsonb_build_object('kind','admin_event_budget'),'event_extension',ext)) returning id into new_id;
    title:=case when can_price then 'Ampliación pendiente de Máster' else 'Ampliación pendiente de precio' end;
  elsif p_action in ('price','approve','reject') then
    select * into req from public.advisor_order_drafts where id=(p_input->>'id')::bigint for update;
    if not found or req.payload #>> '{event_extension,root_id}' is distinct from root.id::text then raise exception 'La solicitud no pertenece a este evento.'; end if;
    ext:=req.payload->'event_extension'; new_id:=req.id;
    if p_action='approve' and req.converted_order_id is not null then return jsonb_build_object('ok',true,'order_id',req.converted_order_id,'reused',true); end if;
    if ext->>'stage' not in ('requested','priced') then raise exception 'Esta solicitud ya está resuelta.'; end if;
    if p_action='price' then
      if not public.is_admin() then raise exception 'Solo Administración autoriza precios y comisiones.' using errcode='42501'; end if;
      amount:=(p_input->>'amount')::numeric; currency:=p_input->>'currency'; mode:=p_input->>'commission_mode'; commission:=(p_input->>'commission_value')::numeric;
      if amount is null or amount<0 or amount::text in ('NaN','Infinity','-Infinity') or currency is null or currency not in ('USD','VES')
        or mode is null or mode not in ('default','fixed_item','none')
        or (mode='fixed_item' and (commission is null or commission<0 or commission>100 or commission::text in ('NaN','Infinity','-Infinity'))) then raise exception 'Precio, moneda o comisión no válidos.'; end if;
      -- Every unpriced line needs an explicit unit and preparation mode from Administration.
      for row_data in select value from jsonb_array_elements(ext->'items') loop
        select value into rate from jsonb_array_elements(coalesce(p_input->'items','[]')) where value->>'product_id'=row_data->>'product_id';
        if rate->>'unit' is null or rate->>'unit' not in ('UND','servicio','envase')
          or rate->>'preparation_mode' is null or rate->>'preparation_mode' not in ('kitchen','on_site','not_applicable') then raise exception 'Define unidad y preparación de cada producto.'; end if;
        select * into product from public.products where id=(row_data->>'product_id')::bigint;
        rows_data:=rows_data||jsonb_build_array(row_data||jsonb_build_object('unit',rate->>'unit','preparation_mode',rate->>'preparation_mode',
          'physical_qty',(row_data->>'qty')::numeric * case when rate->>'unit'='servicio' and product.inventory_policy::text in ('self','direct') then greatest(coalesce(product.units_per_service,1),1) else 1 end));
      end loop;
      ext:=ext||jsonb_build_object('stage','priced','items',rows_data,'currency',currency,'amount',round(amount,2),'terms_snapshot',jsonb_build_object(
        'commission_mode',mode,'commission_value',commission,'authorized_by',actor,'authorized_at',clock_timestamp()));
      update public.advisor_order_drafts set payload=jsonb_set(payload,'{event_extension}',ext) where id=req.id;
      title:='Precio autorizado · pendiente de Máster';
    elsif p_action='reject' then
      if not public.is_master_or_admin() then raise exception 'Solo Máster o Administración pueden rechazar.' using errcode='42501'; end if;
      if length(btrim(coalesce(p_input->>'reason','')))<3 then raise exception 'Indica el motivo del rechazo.'; end if;
      update public.advisor_order_drafts set status='archived',payload=jsonb_set(payload,'{event_extension}',ext||jsonb_build_object('stage','rejected','reason',left(p_input->>'reason',2000),'reviewed_by',actor)) where id=req.id;
      title:='Ampliación rechazada';
    else
      if not public.is_master_or_admin() then raise exception 'Solo Máster o Administración pueden aprobar operativamente.' using errcode='42501'; end if;
      if ext->>'stage'<>'priced' or ext #>> '{terms_snapshot,authorized_by}' is null then raise exception 'Administración debe autorizar el precio antes de aprobar.'; end if;
      if coalesce(root.payload #>> '{event_state,closed}','false')='true' or base.status::text='cancelled' then raise exception 'El evento está cerrado o cancelado.'; end if;
      select rate_bs_per_usd into fx from public.exchange_rates where is_active order by effective_at desc limit 1;
      if fx is null or fx<=0 then raise exception 'Falta la tasa activa.'; end if;
      amount:=(ext->>'amount')::numeric; currency:=ext->>'currency';
      usd:=round(case when currency='VES' then amount/fx else amount end,2);
      bs:=round(case when currency='VES' then amount else amount*fx end,2);
      select id into technical_id from public.products where sku='PACK_EVENTO';
      if technical_id is null then raise exception 'Falta el identificador interno de eventos.'; end if;
      for row_data in select value from jsonb_array_elements(ext->'items') loop
        select * into product from public.products where id=(row_data->>'product_id')::bigint for share;
        if not product.is_active then raise exception 'El producto % está inactivo. Solicita una revisión.',product.name; end if;
        if (row_data->>'is_delivery')::boolean then
          order_lines:=order_lines||jsonb_build_array(jsonb_build_object('product_id',product.id,'qty',1,'notes',null,
            'unit_usd',0,'line_usd',0,'unit_bs',0,'line_bs',0,'currency',currency,'unit_origin',0));
        else
          components:=components||jsonb_build_array(jsonb_build_object('product_id',product.id,'product_name',product.name,
            'qty',(row_data->>'physical_qty')::numeric,'preparation_mode',row_data->>'preparation_mode'));
          detail:=detail||format(E'%s %s\n@sel|%s|%s\n@prep|%s|%s\n',row_data->>'physical_qty',product.name,product.id,row_data->>'physical_qty',product.id,row_data->>'preparation_mode');
          insert into public.product_components(parent_product_id,component_product_id,component_mode,quantity,counts_toward_detail_limit,is_required,sort_order)
          values(technical_id,product.id,'selectable',1,true,false,1000) on conflict(parent_product_id,component_product_id,component_mode) do nothing;
        end if;
      end loop;
      detail:=detail||format('@event|draft|%s',req.id);
      order_lines:=jsonb_build_array(jsonb_build_object('product_id',technical_id,'qty',1,'notes',detail,
        'unit_usd',usd,'line_usd',usd,'unit_bs',bs,'line_bs',bs,'currency',currency,'unit_origin',amount))||order_lines;
      insert into public.orders(order_number,client_id,created_by_user_id,attributed_advisor_id,source,fulfillment,status,
        total_usd,total_bs_snapshot,receiver_name,receiver_phone,delivery_address,notes,extra_fields)
      values('EV-'||req.id::text||'-'||substr(md5(req.id::text),1,6),base.client_id,actor,root.advisor_user_id,'advisor',
        (ext #>> '{request_input,fulfillment}')::public.fulfillment_type,'created',usd,bs,base.receiver_name,base.receiver_phone,
        ext #>> '{request_input,address}',concat('Ampliación de ',root.title,'. ',ext #>> '{request_input,note}'),
        jsonb_build_object('schedule',jsonb_build_object('date',ext #>> '{request_input,date}','time_24',ext #>> '{request_input,time}','asap',false),
          'pricing',jsonb_build_object('fx_rate',fx,'subtotal_usd',usd,'subtotal_bs',bs,'total_usd',usd,'total_bs',bs,'discount_enabled',false,'invoice_tax_pct',0),
          'payment',jsonb_build_object('currency',currency,'client_fund_used_usd',0),'ui',jsonb_build_object('quote_only',false),
          'event_budget',jsonb_build_object('draft_id',req.id,'title',root.title,'commission_mode',ext #>> '{terms_snapshot,commission_mode}','commission_value',ext #> '{terms_snapshot,commission_value}'),
          'event_extension',jsonb_build_object('root_id',root.id,'root_order_id',root.converted_order_id,'request_draft_id',req.id))) returning id into order_id_new;
      update public.advisor_order_drafts set converted_order_id=order_id_new,payload=jsonb_set(payload,'{event_extension}',ext||jsonb_build_object('stage','creating','order_lines',order_lines)) where id=req.id;
      for row_data in select value from jsonb_array_elements(order_lines) loop
        insert into public.order_items(order_id,product_id,qty,notes) values(order_id_new,(row_data->>'product_id')::bigint,(row_data->>'qty')::numeric,row_data->>'notes') returning id into item_id;
        if (row_data->>'product_id')::bigint=technical_id then
          insert into public.order_admin_adjustments(order_id,order_item_id,adjustment_type,reason,notes,payload,created_by_user_id)
          values(order_id_new,item_id,'other','Condiciones autorizadas de ampliación','Máster ejecuta la autorización; no cambia el precio.',
            jsonb_build_object('kind','event_commercial_terms','draft_id',req.id,'root_id',root.id,'negotiated_currency',currency,'negotiated_amount',amount,
              'total_usd',usd,'fx_rate',fx,'commission_mode',ext #>> '{terms_snapshot,commission_mode}','commission_value',ext #> '{terms_snapshot,commission_value}',
              'authorized_by',ext #>> '{terms_snapshot,authorized_by}','components',components),actor);
        end if;
      end loop;
      update public.orders set total_usd=usd,total_bs_snapshot=bs where id=order_id_new;
      update public.advisor_order_drafts set status='converted',converted_at=clock_timestamp(),total_usd=usd,total_bs=bs,fx_rate=fx,
        payload=jsonb_set(payload,'{event_extension}',ext||jsonb_build_object('stage','approved','order_lines',order_lines,'approved_by',actor,'approved_at',clock_timestamp())) where id=req.id;
      perform public.approve_order(order_id_new);
      title:='Ampliación aprobada · orden #'||order_id_new;
    end if;
  elsif p_action='close' then
    if not public.is_master_or_admin() then raise exception 'Solo Máster o Administración pueden cerrar el evento.' using errcode='42501'; end if;
    if exists(select 1 from public.advisor_order_drafts d where d.payload #>> '{event_extension,root_id}'=root.id::text and d.payload #>> '{event_extension,stage}' in ('requested','priced')) then raise exception 'Resuelve las solicitudes pendientes antes de cerrar.'; end if;
    update public.advisor_order_drafts set payload=payload||jsonb_build_object('event_state',jsonb_build_object('closed',true,'closed_by',actor,'closed_at',clock_timestamp())) where id=root.id;
    title:='Evento cerrado para nuevas ampliaciones';
  else raise exception 'Acción no válida.';
  end if;
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
  values(base.id,base.order_number,'event_extension_'||p_action,'order',title,root.title,'info',actor,
    jsonb_build_object('event_root_id',root.id,'request_draft_id',new_id,'extension_order_id',order_id_new,'href','/app/events/'||root.id)) returning id into event_id;
  if p_action in ('request','price') then
    insert into public.order_timeline_event_recipients(event_id,target_role,requires_action)
    values(event_id,case when p_action='request' and not can_price then 'admin' else 'master' end,true);
  end if;
  insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action) values(event_id,root.advisor_user_id,false);
  return jsonb_build_object('ok',true,'id',new_id,'order_id',order_id_new);
end $$;

create or replace function public.event_workspace_command_v1(p_root_id bigint,p_action text,p_input jsonb default '{}')
returns jsonb language sql security invoker set search_path='' as $$ select app_private.event_workspace_command_v1(p_root_id,p_action,p_input) $$;
revoke all on function app_private.event_workspace_command_v1(bigint,text,jsonb),public.event_workspace_command_v1(bigint,text,jsonb) from public,anon;
grant execute on function app_private.event_workspace_command_v1(bigint,text,jsonb),public.event_workspace_command_v1(bigint,text,jsonb) to authenticated;
revoke all on function app_private.preserve_event_identity_v1(),app_private.event_extension_item_snapshot_v1() from public,anon,authenticated;

-- Role-scoped read API; master does not gain general access to advisor drafts.
create or replace function app_private.event_workspace_read_v1(p_root_id bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; root public.advisor_order_drafts%rowtype;
begin
  if auth.uid() is null or not (public.is_master_or_admin() or public.has_role('advisor')) then raise exception 'Sin acceso.' using errcode='42501'; end if;
  if p_root_id is null then
    select coalesce(jsonb_agg(r),'[]') into result from (
      select d.id,d.title,d.status,d.converted_order_id,d.payload #>> '{event_budget,event_date}' event_date,d.payload #> '{event_state}' event_state,
        (select count(*) from public.advisor_order_drafts q where q.payload #>> '{event_extension,root_id}'=d.id::text and q.payload #>> '{event_extension,stage}' in ('requested','priced')) pending
      from public.advisor_order_drafts d where d.payload #>> '{event_budget,kind}'='admin_event_budget' and not d.payload ? 'event_extension'
        and (public.is_master_or_admin() or d.advisor_user_id=auth.uid()) and d.status<>'archived'
      order by d.updated_at desc limit 100
    ) r;
    return result;
  end if;
  select * into root from public.advisor_order_drafts where id=p_root_id;
  if not found or root.payload #>> '{event_budget,kind}' is distinct from 'admin_event_budget' or root.payload ? 'event_extension'
    or (not public.is_master_or_admin() and root.advisor_user_id is distinct from auth.uid()) then raise exception 'Evento no disponible.' using errcode='42501'; end if;
  return jsonb_build_object('root',jsonb_build_object('id',root.id,'title',root.title,'converted_order_id',root.converted_order_id,'payload',root.payload),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'converted_order_id',d.converted_order_id,'extension',d.payload->'event_extension') order by d.created_at desc)
      from public.advisor_order_drafts d where d.payload #>> '{event_extension,root_id}'=root.id::text),'[]'),
    'orders',coalesce((select jsonb_agg(to_jsonb(f)) from public.orders o cross join lateral public.get_order_financial_state(o.id) f
      where o.id=root.converted_order_id or o.id in(select d.converted_order_id from public.advisor_order_drafts d where d.payload #>> '{event_extension,root_id}'=root.id::text)),'[]'),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by p.name) from public.products p
      where p.is_active and p.sku<>'PACK_EVENTO' and p.type::text<>'gambit' and not coalesce(p.is_detail_editable,false)
        and coalesce(p.extra_fields->>'catalog_access_scope','')<>'admin_internal'),'[]'));
end $$;
create or replace function public.event_workspace_read_v1(p_root_id bigint default null) returns jsonb
language sql stable security invoker set search_path='' as $$ select app_private.event_workspace_read_v1(p_root_id) $$;
revoke all on function app_private.event_workspace_read_v1(bigint),public.event_workspace_read_v1(bigint) from public,anon;
grant execute on function app_private.event_workspace_read_v1(bigint),public.event_workspace_read_v1(bigint) to authenticated;
