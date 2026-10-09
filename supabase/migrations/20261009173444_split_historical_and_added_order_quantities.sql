begin;
set local lock_timeout='5s';

-- A reduction can remove agreed units, never add new ones at a historical price.
create function app_private.order_item_reduced_commercial_terms_v1(p_old jsonb,p_new jsonb,p_parent_fx numeric)
returns boolean language plpgsql immutable set search_path='' as $function$
declare qty numeric; previous_qty numeric; expected_usd numeric; expected_bs numeric; fx numeric;
begin
  qty:=(p_new->>'qty')::numeric; previous_qty:=(p_old->>'qty')::numeric;
  if qty is null or qty<=0 or qty>=previous_qty or qty::text in ('NaN','Infinity','-Infinity') then return false; end if;
  expected_bs:=round((p_old->>'unit_price_bs_snapshot')::numeric*qty,2);
  fx:=coalesce((p_old->>'pricing_fx_rate_snapshot')::numeric,p_parent_fx);
  expected_usd:=case when p_old->>'pricing_origin_currency'='VES' and fx>0
    then round(expected_bs/fx,2) else round((p_old->>'line_total_usd')::numeric/previous_qty*qty,2) end;
  return app_private.order_item_same_commercial_terms_v1(p_old,p_new||jsonb_build_object(
      'qty',previous_qty,'line_total_usd',p_old->'line_total_usd','line_total_bs_snapshot',p_old->'line_total_bs_snapshot'))
    and (p_new->>'line_total_usd')::numeric=expected_usd
    and (p_new->>'line_total_bs_snapshot')::numeric=expected_bs;
exception when invalid_text_representation or numeric_value_out_of_range or division_by_zero then return false;
end;
$function$;
revoke all on function app_private.order_item_reduced_commercial_terms_v1(jsonb,jsonb,numeric) from public,anon;
grant execute on function app_private.order_item_reduced_commercial_terms_v1(jsonb,jsonb,numeric) to authenticated,service_role;

do $migration$
declare definition text; name text; anchor text; prefix text := $prefix$
  if tg_op='UPDATE' and auth.uid() is not null and new.order_id=old.order_id
    and exists(select 1 from public.orders o where o.id=old.order_id
      and o.status::text in ('created','queued','confirmed','in_kitchen','ready')
      and (public.is_master_or_admin() or (public.has_role('counter') and o.fulfillment::text='pickup')
        or (public.has_role('advisor') and o.attributed_advisor_id=auth.uid()
          and not coalesce(o.is_price_locked,false) and o.status::text in ('created','queued')))
      and app_private.order_item_reduced_commercial_terms_v1(to_jsonb(old),to_jsonb(new),
        nullif(o.extra_fields#>>'{pricing,fx_rate}','')::numeric)) then
    return new;
  end if;
  -- A direct table update is not a back door to increase an old-price line.
  if tg_op='UPDATE' and new.product_id=old.product_id and new.qty>old.qty
    and old.crm_play_member_id is null and exists(select 1 from public.products p
      where p.id=old.product_id and (p.source_price_currency::text is distinct from old.pricing_origin_currency
        or p.source_price_amount is distinct from old.pricing_origin_amount)) then
    raise exception 'La cantidad añadida usa el precio actual. Agrégala como una línea nueva, conservando la cantidad acordada.' using errcode='22023';
  end if;
$prefix$;
begin
  foreach name in array array['trg_order_items_guard','trg_order_items_pricing_guard','trg_order_items_set_pricing'] loop
    definition:=replace(pg_get_functiondef(('public.'||name||'()')::regprocedure),chr(13),'');
    if position(E'begin\n' in definition)=0 or position('order_item_reduced_commercial_terms_v1' in definition)>0 then
      raise exception 'Quantity guard anchor changed: %',name; end if;
    -- Insert only at the root body; draft protection contains a nested BEGIN.
    definition:=overlay(definition placing E'begin\n'||prefix
      from position(E'begin\n' in definition) for length(E'begin\n'));
    if name='trg_order_items_set_pricing' then
      anchor:='  -- VES is the economic source: convert the whole line before rounding USD.';
      if position(anchor in definition)=0 then raise exception 'New native item pricing anchor changed'; end if;
      definition:=replace(definition,anchor,$native$
  -- New ordinary lines use the native catalog price in BOTH currencies.
  -- Certified draft lines returned earlier; approved adjustments keep their own route.
  if tg_op='INSERT' and not v_is_crm_item and not v_is_counter_direct_sale
    and new.admin_price_override_usd is null and new.override_unit_price_usd is null then
    v_fx_rate:=coalesce(new.pricing_fx_rate_snapshot,v_product.fx_rate);
    if public.is_admin() is not true and v_fx_rate is distinct from v_product.fx_rate
      and v_fx_rate is distinct from (select rate_bs_per_usd from public.exchange_rates
        where is_active order by effective_at desc limit 1) then
      raise exception 'La tasa no coincide con la orden ni con la tasa activa.' using errcode='42501'; end if;
    if v_fx_rate is null or v_fx_rate<=0 or v_fx_rate::text in ('NaN','Infinity','-Infinity')
      or new.qty is null or new.qty<=0 or new.qty::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Cantidad o tasa inválida para agregar el producto.' using errcode='22023'; end if;
    new.pricing_origin_currency:=v_product.source_price_currency::text;
    new.pricing_origin_amount:=v_product.source_price_amount;
    if new.pricing_origin_amount is null or new.pricing_origin_amount<0
      or new.pricing_origin_amount::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Precio de catálogo inválido.' using errcode='22023'; end if;
    new.admin_price_override_reason:=null;
    new.admin_price_override_by_user_id:=null;
    new.admin_price_override_at:=null;
    new.pricing_fx_rate_snapshot:=v_fx_rate;
    if new.pricing_origin_currency='VES' then
      new.unit_price_bs_snapshot:=round(v_product.source_price_amount,2);
      new.line_total_bs_snapshot:=round(new.unit_price_bs_snapshot*new.qty,2);
      new.unit_price_usd_snapshot:=round(new.unit_price_bs_snapshot/v_fx_rate,2);
      new.line_total_usd:=round(new.line_total_bs_snapshot/v_fx_rate,2);
    elsif new.pricing_origin_currency='USD' then
      new.unit_price_usd_snapshot:=round(v_product.source_price_amount,2);
      new.line_total_usd:=round(new.unit_price_usd_snapshot*new.qty,2);
      new.unit_price_bs_snapshot:=round(new.unit_price_usd_snapshot*v_fx_rate,2);
      new.line_total_bs_snapshot:=round(new.line_total_usd*v_fx_rate,2);
    else raise exception 'Moneda de origen inválida.' using errcode='22023'; end if;
    return new;
  end if;
  -- VES is the economic source: convert the whole line before rounding USD.
$native$);
    end if;
    execute definition;
  end loop;
  definition:=replace(pg_get_functiondef('app_private.update_order_core_atomic_v1(bigint,timestamptz,jsonb,jsonb)'::regprocedure),chr(13),'');
  anchor:=$anchor$        and app_private.order_item_same_commercial_terms_v1(to_jsonb(item),
          to_jsonb(jsonb_populate_record(item,incoming.value-array['order_item_id',
            'admin_price_override_by_user_id','admin_price_override_at']))));$anchor$;
  if position(anchor in definition)=0 then raise exception 'Quantity retained core anchor changed'; end if;
  definition:=replace(definition,anchor,$replacement$        and (app_private.order_item_same_commercial_terms_v1(to_jsonb(item),
          to_jsonb(jsonb_populate_record(item,incoming.value-array['order_item_id',
            'admin_price_override_by_user_id','admin_price_override_at'])))
          or app_private.order_item_reduced_commercial_terms_v1(to_jsonb(item),
            to_jsonb(jsonb_populate_record(item,incoming.value-array['order_item_id',
              'admin_price_override_by_user_id','admin_price_override_at'])),
            nullif(v_order.extra_fields#>>'{pricing,fx_rate}','')::numeric)));$replacement$);
  anchor:='  -- Operational retained rows: preserve the unit snapshots and item identity.';
  if position(anchor in definition)=0 then raise exception 'Quantity preflight core anchor changed'; end if;
  definition:=replace(definition,anchor,$preflight$
  if exists(select 1 from public.order_items item join jsonb_array_elements(p_items) incoming(value)
      on nullif(incoming.value->>'order_item_id','')::bigint=item.id
    join public.products p on p.id=item.product_id
    where item.order_id=p_order_id and item.product_id=(incoming.value->>'product_id')::bigint
      and item.crm_play_member_id is null and (incoming.value->>'qty')::numeric>item.qty
      and (p.source_price_currency::text is distinct from item.pricing_origin_currency
        or p.source_price_amount is distinct from item.pricing_origin_amount)) then
    raise exception 'La cantidad añadida usa el precio actual. Agrégala como una línea nueva, conservando la cantidad acordada.' using errcode='22023';
  end if;
  -- Operational retained rows: preserve the unit snapshots and item identity.
$preflight$);
  execute definition;
end;
$migration$;
commit;
