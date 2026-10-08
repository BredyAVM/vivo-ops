-- Backward-compatible scope: any purchase remains the default for other plays.
set lock_timeout='5s';
set statement_timeout='60s';

create or replace function app_private.crm_purchased_product_ids_v1(p_rules jsonb)
returns bigint[] language plpgsql stable set search_path='' as $$
declare values_json jsonb := coalesce(p_rules->'purchased_product_ids','[]'::jsonb); ids bigint[];
begin
  if jsonb_typeof(values_json)<>'array' or jsonb_array_length(values_json)>50
    or coalesce(p_rules->>'purchased_product_mode','any') not in ('any','all') then
    raise exception 'Selecciona hasta 50 productos y el modo cualquiera o todos.' using errcode='22023';
  end if;
  if coalesce(p_rules->>'purchased_product_scope','any_purchase') not in ('any_purchase','latest_delivery') then
    raise exception 'Selecciona dónde buscar los productos: historial o último delivery.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(values_json) v where jsonb_typeof(v)<>'number' or v::text !~ '^[1-9][0-9]{0,14}$') then
    raise exception 'Los productos del filtro deben tener identificadores válidos.' using errcode='22023';
  end if;
  select coalesce(array_agg(distinct v::bigint),'{}'::bigint[]) into ids from jsonb_array_elements_text(values_json) v;
  if exists(select 1 from unnest(ids) selected(product_id) where not exists(select 1 from public.products p where p.id=selected.product_id)) then
    raise exception 'Uno de los productos seleccionados no existe.' using errcode='22023';
  end if;
  return ids;
end;
$$;
revoke all on function app_private.crm_purchased_product_ids_v1(jsonb) from public,anon,authenticated,service_role;

create or replace function app_private.crm_clients_with_products_v1(p_rules jsonb,p_as_of timestamptz)
returns table(client_id bigint,matched_product_ids bigint[])
language plpgsql stable set search_path='' as $$
declare ids bigint[] := app_private.crm_purchased_product_ids_v1(p_rules);
begin
  if cardinality(ids)=0 then return; end if;
  if coalesce(p_rules->>'purchased_product_scope','any_purchase')='latest_delivery' then
    return query
    with last_delivery as materialized (
      -- Choose the last delivery BEFORE matching products. A newer delivery with
      -- no selected product excludes the client; pickup never replaces delivery.
      select distinct on (f.client_id) f.client_id,f.fact_origin,f.source_record_id
      from public.commercial_order_facts f
      where f.fulfillment='delivery' and f.event_kind='purchase'
        and f.net_total_usd>0 and f.purchased_at<=p_as_of
      -- Deterministic ties: live wins over historical, then highest source ID.
      order by f.client_id,f.purchased_at desc,f.fact_origin desc,f.source_record_id desc
    ), lines as materialized (
      select 'historical'::text origin,i.historical_order_id order_id,i.product_id
      from public.historical_order_items i where i.product_id=any(ids) and i.quantity>0
      union all
      select 'live'::text,i.order_id,i.product_id from public.order_items i where i.product_id=any(ids) and i.qty>0
    )
    select d.client_id,array_agg(distinct l.product_id)
    from last_delivery d join lines l on l.origin=d.fact_origin and l.order_id=d.source_record_id
    group by d.client_id
    having coalesce(p_rules->>'purchased_product_mode','any')='any' or count(distinct l.product_id)=cardinality(ids);
    return;
  end if;
  return query
  with lines as materialized (
    select 'historical'::text origin,i.historical_order_id order_id,i.product_id
    from public.historical_order_items i where i.product_id=any(ids) and i.quantity>0
    union all
    select 'live'::text,i.order_id,i.product_id from public.order_items i where i.product_id=any(ids) and i.qty>0
  )
  select f.client_id,array_agg(distinct l.product_id)
  from lines l join public.commercial_order_facts f on f.fact_origin=l.origin and f.source_record_id=l.order_id
  where f.event_kind='purchase' and f.net_total_usd>0 and f.purchased_at<=p_as_of
  group by f.client_id
  having coalesce(p_rules->>'purchased_product_mode','any')='any' or count(distinct l.product_id)=cardinality(ids);
end;
$$;
revoke all on function app_private.crm_clients_with_products_v1(jsonb,timestamptz) from public,anon,authenticated,service_role;
