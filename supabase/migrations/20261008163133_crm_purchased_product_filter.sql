-- Product IDs, not campaign names, define the history filter. No new public API.
set lock_timeout='5s';
set statement_timeout='60s';

alter table public.crm_play_amendments drop constraint crm_play_amendments_type_check;
alter table public.crm_play_amendments add constraint crm_play_amendments_type_check
check (amendment_type in ('message_updated','member_added','member_removed','advisor_excluded','criteria_corrected'));

create function app_private.crm_purchased_product_ids_v1(p_rules jsonb)
returns bigint[] language plpgsql stable set search_path='' as $$
declare values_json jsonb := coalesce(p_rules->'purchased_product_ids','[]'::jsonb); ids bigint[];
begin
  if jsonb_typeof(values_json)<>'array' or jsonb_array_length(values_json)>50
    or coalesce(p_rules->>'purchased_product_mode','any') not in ('any','all') then
    raise exception 'Selecciona hasta 50 productos y el modo cualquiera o todos.' using errcode='22023';
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

-- A single set-based scan per preview, using existing product/order indexes.
create function app_private.crm_clients_with_products_v1(p_rules jsonb,p_as_of timestamptz)
returns table(client_id bigint,matched_product_ids bigint[])
language plpgsql stable set search_path='' as $$
declare ids bigint[] := app_private.crm_purchased_product_ids_v1(p_rules);
begin
  if cardinality(ids)=0 then return; end if;
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

create function app_private.crm_product_filter_settings_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform app_private.crm_purchased_product_ids_v1(new.rules_snapshot);
  if tg_op='UPDATE' and new.status is distinct from old.status and new.status in ('frozen','active')
    and cardinality(app_private.crm_purchased_product_ids_v1(new.rules_snapshot))>0
    and exists (
      select 1 from public.crm_play_members m
      where m.play_id=new.id and m.workflow_status<>'removed'
        -- Explicit, audited manual inclusions remain permitted outside criteria.
        and not coalesce((m.decision_snapshot->>'manual_inclusion')::boolean,false)
        and not exists(select 1 from app_private.crm_clients_with_products_v1(new.rules_snapshot,coalesce(new.snapshot_at,now())) x where x.client_id=m.client_id)
    ) then
    raise exception 'La lista incluye clientes sin los productos requeridos. Vuelve a probar antes de confirmar o compartir.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.crm_product_filter_settings_guard_v1() from public,anon,authenticated,service_role;
create trigger crm_product_filter_settings_guard before insert or update of rules_snapshot,status on public.crm_plays
for each row execute function app_private.crm_product_filter_settings_guard_v1();

do $patch$
declare definition text; anchor text;
begin
  definition := pg_get_functiondef('public.crm_rebuild_play_members_v1(bigint)'::regprocedure);
  anchor := '  insert into public.crm_play_members (';
  if position(anchor in definition)=0 then raise exception 'Product preview insert anchor missing'; end if;
  definition := replace(definition,anchor,'  with product_matches as materialized (select * from app_private.crm_clients_with_products_v1(rules,generated_at))' || chr(10) || anchor);
  anchor := '  where client_row.is_active';
  if position(anchor in definition)=0 then raise exception 'Product preview join anchor missing'; end if;
  definition := replace(definition,anchor,'  left join product_matches on product_matches.client_id=metric.client_id' || chr(10) || anchor);
  anchor := '    and metric.purchase_count >= minimum_purchases';
  if position(anchor in definition)=0 then raise exception 'Product preview filter anchor missing'; end if;
  definition := replace(definition,anchor,'    and (cardinality(app_private.crm_purchased_product_ids_v1(rules))=0 or product_matches.client_id is not null)' || chr(10) || anchor);
  anchor := '''primary_advisor_id'', client_row.primary_advisor_id';
  if position(anchor in definition)=0 then raise exception 'Product preview evidence anchor missing'; end if;
  definition := replace(definition,anchor,anchor || ', ''matched_product_ids'', coalesce(product_matches.matched_product_ids,''{}''::bigint[])');
  execute definition;
end;
$patch$;
