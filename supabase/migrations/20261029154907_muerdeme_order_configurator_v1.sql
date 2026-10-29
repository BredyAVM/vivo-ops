-- Preparation adapters and canonical per-unit configurations. Sales remain disabled.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function app_private.muerdeme_order_reader_v1()
returns boolean language sql stable security invoker set search_path='' as $f$
  select (select auth.uid()) is not null and exists(select 1 from public.profiles where id=(select auth.uid()) and is_active)
    and (public.has_role('admin') or public.has_role('master') or public.has_role('advisor'));
$f$;
create policy commercial_brands_seller_read on app_private.commercial_brands for select to authenticated
  using ((select app_private.muerdeme_order_reader_v1()));
create function app_private.muerdeme_order_menu_access_v1()
returns boolean language sql stable security invoker set search_path='' as $f$
  select app_private.muerdeme_order_reader_v1() and (public.has_role('admin') or exists(
    select 1 from app_private.commercial_brands where code='muerdeme' and sales_enabled));
$f$;
create policy muerdeme_menu_entries_seller_read on app_private.muerdeme_menu_entries for select to authenticated
  using ((select app_private.muerdeme_order_menu_access_v1()));
create policy muerdeme_menu_revisions_seller_read on app_private.muerdeme_menu_revisions for select to authenticated
  using ((select app_private.muerdeme_order_menu_access_v1()));

create table app_private.muerdeme_menu_order_products(
  entry_id uuid primary key references app_private.muerdeme_menu_entries(id),
  product_id bigint not null unique references public.products(id),
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table app_private.muerdeme_menu_order_products enable row level security;
revoke all on app_private.muerdeme_menu_order_products from public,anon,authenticated,service_role;
grant select,insert on app_private.muerdeme_menu_order_products to authenticated;
create policy muerdeme_order_products_read on app_private.muerdeme_menu_order_products for select to authenticated
  using ((select app_private.muerdeme_order_reader_v1()));
create policy muerdeme_order_products_insert on app_private.muerdeme_menu_order_products for insert to authenticated
  with check ((select app_private.commercial_foundation_is_admin_v1()) and created_by=(select auth.uid()));
create function app_private.muerdeme_order_product_link_guard_v1()
returns trigger language plpgsql security invoker set search_path='' as $f$
begin
  perform app_private.muerdeme_menu_check_v1(exists(select 1 from public.products p where p.id=new.product_id
    and p.extra_fields->>'muerdeme_menu_entry_id'=new.entry_id::text and p.extra_fields->>'commercial_brand'='muerdeme'
    and not p.is_active and p.inventory_policy='none' and not p.inventory_enabled and p.commission_mode='fixed_item'
    and p.commission_value=0),'El vínculo requiere un producto de preparación propio de Muérdeme.');
  return new;
end;
$f$;
create trigger muerdeme_order_product_link_guard before insert on app_private.muerdeme_menu_order_products
  for each row execute function app_private.muerdeme_order_product_link_guard_v1();
grant insert on app_private.commercial_product_brands to authenticated;
create policy commercial_product_brands_prepare_muerdeme on app_private.commercial_product_brands for insert to authenticated
  with check ((select app_private.commercial_foundation_is_admin_v1()) and brand_code='muerdeme'
    and exists(select 1 from app_private.muerdeme_menu_order_products l where l.product_id=commercial_product_brands.product_id));

create function app_private.muerdeme_prepare_order_product_v1()
returns trigger language plpgsql security invoker set search_path='' as $f$
declare v_product_id bigint;
begin
  if new.document->>'kind'='extra' or new.document->'archived'='true'::jsonb then return new; end if;
  if exists(select 1 from app_private.muerdeme_menu_order_products where entry_id=new.entry_id) then return new; end if;
  -- These inactive adapters never enter the ordinary VIVO sales catalogue.
  insert into public.products(name,sku,is_active,is_combo,type,base_price_usd,source_price_amount,source_price_currency,
    is_inventory_item,inventory_enabled,inventory_policy,inventory_configuration_status,commission_mode,commission_value,extra_fields)
  values(new.document->>'name','MDM-'||new.entry_id::text,false,false,'product',0,0,'USD',false,false,'none','draft','fixed_item',0,
    jsonb_build_object('commercial_brand','muerdeme','muerdeme_menu_entry_id',new.entry_id,'muerdeme_configurable',true)) returning id into v_product_id;
  insert into app_private.muerdeme_menu_order_products(entry_id,product_id) values(new.entry_id,v_product_id);
  insert into app_private.commercial_product_brands(product_id,brand_code) values(v_product_id,'muerdeme');
  return new;
end;
$f$;
create trigger muerdeme_menu_z_prepare_product after insert on app_private.muerdeme_menu_revisions
  for each row execute function app_private.muerdeme_prepare_order_product_v1();

create function public.muerdeme_order_menu_search_v1(p_query text default '',p_kind text default null,p_page integer default 1)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare v_rows jsonb; v_more boolean; v_enabled boolean;
begin
  if app_private.muerdeme_order_reader_v1() is not true then raise exception 'Requiere un usuario de ventas activo.' using errcode='42501'; end if;
  perform app_private.muerdeme_menu_check_v1(p_query is not null and length(p_query)<=100 and p_page between 1 and 10000
    and (p_kind is null or p_kind in('burger','fries','drink','combo')),'Revisa los filtros del menú.');
  select sales_enabled into v_enabled from app_private.commercial_brands where code='muerdeme';
  with candidates as (
    select e.id,e.kind,r.document,l.product_id,row_number()over(order by r.document->>'name',e.id) n
    from app_private.muerdeme_menu_entries e
    join lateral(select document from app_private.muerdeme_menu_revisions where entry_id=e.id order by revision desc limit 1)r on true
    left join app_private.muerdeme_menu_order_products l on l.entry_id=e.id
    where e.kind<>'extra' and (p_kind is null or e.kind=p_kind) and r.document->'archived'='false'::jsonb
      and (btrim(p_query)='' or position(translate(lower(btrim(p_query)),'áéíóúüñ','aeiouun') in translate(lower(r.document->>'name'),'áéíóúüñ','aeiouun'))>0)
    order by r.document->>'name',e.id limit 26 offset (p_page-1)*25
  ) select coalesce(jsonb_agg(jsonb_build_object('entryId',id,'kind',kind,'name',document->>'name','productId',product_id,
      'fromUsd',(select min((v->>'priceUsd')::numeric) from jsonb_array_elements(document->'variants')v)) order by n)
      filter(where n<=(p_page-1)*25+25),'[]'::jsonb),coalesce(bool_or(n=(p_page-1)*25+26),false) into v_rows,v_more from candidates;
  return jsonb_build_object('salesEnabled',coalesce(v_enabled,false),'rows',v_rows,'hasNext',v_more,'page',p_page);
end;
$f$;

create function public.muerdeme_order_menu_graph_v1(p_entry_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare v_entries jsonb; v_count integer;
begin
  if app_private.muerdeme_order_menu_access_v1() is not true then raise exception 'Muérdeme está en preparación. Solo administración puede probar el menú.' using errcode='42501'; end if;
  with recursive linked(id) as (
    select p_entry_id
    union
    select ref.entry_id from linked a
      join lateral(select document from app_private.muerdeme_menu_revisions where entry_id=a.id order by revision desc limit 1)r on true
      cross join lateral app_private.muerdeme_menu_refs_v1(r.document) ref
  ), bounded as (select id from linked limit 202)
  select coalesce(jsonb_agg(jsonb_build_object('entryId',e.id,'revision',r.revision,'document',r.document,'updatedAt',r.created_at,
    'productId',l.product_id) order by e.id),'[]'::jsonb),count(*) into v_entries,v_count
  from bounded b join app_private.muerdeme_menu_entries e on e.id=b.id
  join lateral(select document,revision,created_at from app_private.muerdeme_menu_revisions where entry_id=e.id order by revision desc limit 1)r on true
  left join app_private.muerdeme_menu_order_products l on l.entry_id=e.id;
  perform app_private.muerdeme_menu_check_v1(v_count>0 and v_count<=201,'El producto no está disponible o tiene demasiadas opciones vinculadas.');
  return jsonb_build_object('version','muerdeme-order-menu-v1','salesEnabled',
    (select sales_enabled from app_private.commercial_brands where code='muerdeme'),'entries',v_entries);
end;
$f$;

create function app_private.muerdeme_order_resolve_v1(p_graph jsonb,p_ref jsonb,p_kind text default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare e jsonb; v jsonb;
begin
  select a into e from jsonb_array_elements(p_graph->'entries')a where a->>'entryId'=p_ref->>'entryId';
  perform app_private.muerdeme_menu_check_v1(e is not null and e->'document'->'archived'='false'::jsonb
    and (p_kind is null or e->'document'->>'kind'=p_kind),'Una opción del menú ya no está disponible. Vuelve a consultar.');
  select a into v from jsonb_array_elements(e->'document'->'variants')a where a->>'key'=p_ref->>'variantKey';
  perform app_private.muerdeme_menu_check_v1(v is not null,'Una presentación ya no está disponible. Vuelve a consultar.');
  return jsonb_build_object('entry',e,'variant',v,'label',(e->'document'->>'name')||' · '||(v->>'label'),
    'revisions',jsonb_build_object(e->>'entryId',(e->>'revision')::integer));
end;
$f$;
create function app_private.muerdeme_order_unit_v1(p_unit jsonb,p_graph jsonb,p_prefix text)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare resolved jsonb; e jsonb; v jsonb; burger jsonb; item jsonb; allowed jsonb; other jsonb;
  ingredient jsonb; fries jsonb; rule jsonb; rev jsonb; lines jsonb; amount numeric:=0; extra_amount numeric; qty integer;
begin
  perform app_private.muerdeme_menu_check_v1(jsonb_typeof(p_unit->'removed')='array' and jsonb_array_length(p_unit->'removed')<=40
    and jsonb_typeof(p_unit->'extras')='array' and jsonb_array_length(p_unit->'extras')<=40
    and (p_unit->'friesUpgrade'='null'::jsonb or jsonb_typeof(p_unit->'friesUpgrade')='string'),'Revisa ingredientes, extras y papas.');
  perform app_private.muerdeme_menu_check_v1((select count(*)=count(distinct a) from jsonb_array_elements(p_unit->'removed')a)
    and (select count(*)=count(distinct (a->>'entryId',a->>'variantKey')) from jsonb_array_elements(p_unit->'extras')a),'Hay ingredientes o extras duplicados.');
  resolved:=app_private.muerdeme_order_resolve_v1(p_graph,p_unit);
  e:=resolved->'entry';v:=resolved->'variant';rev:=resolved->'revisions';lines:=jsonb_build_array(p_prefix||(resolved->>'label'));
  if e->'document'->>'kind'='burger' then
    burger:=v->'burger';
    for item in select a from jsonb_array_elements(p_unit->'removed')a loop
      select a into ingredient from jsonb_array_elements(burger->'ingredients')a where a->>'key'=item#>>'{}';
      perform app_private.muerdeme_menu_check_v1(ingredient->'removable'='true'::jsonb,'No se puede retirar ese ingrediente de esta presentación.');
      lines:=lines||jsonb_build_array('  Sin '||(ingredient->>'label'));
    end loop;
    for item in select a from jsonb_array_elements(p_unit->'extras')a loop
      perform app_private.muerdeme_menu_check_v1((select count(*)=3 from jsonb_object_keys(item))
        and jsonb_typeof(item->'quantity')='number' and (item->>'quantity')::numeric=trunc((item->>'quantity')::numeric),'Revisa la cantidad del extra.');
      qty:=(item->>'quantity')::integer;
      select a into allowed from jsonb_array_elements(burger->'extras')a where a->>'entryId'=item->>'entryId' and a->>'variantKey'=item->>'variantKey';
      perform app_private.muerdeme_menu_check_v1(allowed is not null and qty between 1 and (allowed->>'maxQty')::integer,'El extra o su cantidad no están permitidos.');
      other:=app_private.muerdeme_order_resolve_v1(p_graph,item,'extra');
      perform app_private.muerdeme_menu_check_v1(other->'variant'->'priceUsd'<>'null'::jsonb,'Falta definir el precio del extra en USD.');
      extra_amount:=(other->'variant'->>'priceUsd')::numeric*qty;amount:=amount+extra_amount;rev:=rev||(other->'revisions');
      lines:=lines||jsonb_build_array('  Extra: '||qty||' '||(other->>'label')||' · USD '||to_char(extra_amount,'FM999999999990.00'));
    end loop;
    if burger->'includedFries'<>'null'::jsonb then
      fries:=app_private.muerdeme_order_resolve_v1(p_graph,burger->'includedFries','fries');rev:=rev||(fries->'revisions');
      qty:=(burger->'includedFries'->>'quantity')::integer;extra_amount:=0;
      if p_unit->>'friesUpgrade' is not null then
        select a into rule from jsonb_array_elements(fries->'entry'->'document'->'friesUpgrades')a
          where a->>'fromKey'=burger->'includedFries'->>'variantKey' and a->>'toKey'=p_unit->>'friesUpgrade';
        perform app_private.muerdeme_menu_check_v1(rule is not null,'Esta ampliación de papas no está permitida.');
        fries:=app_private.muerdeme_order_resolve_v1(p_graph,jsonb_build_object('entryId',burger->'includedFries'->>'entryId','variantKey',p_unit->>'friesUpgrade'),'fries');
        extra_amount:=(rule->>'supplementUsd')::numeric*qty;amount:=amount+extra_amount;
      end if;
      lines:=lines||jsonb_build_array('  Incluye: '||qty||' '||(fries->>'label')||case when extra_amount>0 then ' · Ampliación USD '||to_char(extra_amount,'FM999999999990.00') else '' end);
    else perform app_private.muerdeme_menu_check_v1(p_unit->'friesUpgrade'='null'::jsonb,'Esta hamburguesa no incluye papas para agrandar.');end if;
  else
    perform app_private.muerdeme_menu_check_v1(jsonb_array_length(p_unit->'removed')=0 and jsonb_array_length(p_unit->'extras')=0,'Solo una hamburguesa admite ingredientes y extras.');
    if p_unit->>'friesUpgrade' is not null then
      perform app_private.muerdeme_menu_check_v1(e->'document'->>'kind'='fries','Solo las papas admiten esta ampliación.');
      select a into rule from jsonb_array_elements(e->'document'->'friesUpgrades')a where a->>'fromKey'=v->>'key' and a->>'toKey'=p_unit->>'friesUpgrade';
      perform app_private.muerdeme_menu_check_v1(rule is not null,'Esta ampliación de papas no está permitida.');
      other:=app_private.muerdeme_order_resolve_v1(p_graph,jsonb_build_object('entryId',e->>'entryId','variantKey',p_unit->>'friesUpgrade'),'fries');
      amount:=(rule->>'supplementUsd')::numeric;rev:=rev||(other->'revisions');
      lines:=lines||jsonb_build_array('  Ampliar a '||(other->>'label')||' · USD '||to_char(amount,'FM999999999990.00'));
    end if;
  end if;
  return jsonb_build_object('amountUsd',amount,'lines',lines,'revisions',rev);
end;
$f$;

create function public.muerdeme_order_quote_v1(p_selection jsonb,p_expected_revisions jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare graph jsonb; root jsonb; doc jsonb; variant jsonb; group_doc jsonb; slot jsonb; choice jsonb; result jsonb;
  rev jsonb; lines jsonb:='[]'; total numeric; pos integer; expected_slots integer:=0;
begin
  perform app_private.muerdeme_menu_check_v1(jsonb_typeof(p_selection)='object' and pg_column_size(p_selection)<=60000
    and (select count(*)=6 from jsonb_object_keys(p_selection))
    and p_selection ?& array['entryId','variantKey','removed','extras','friesUpgrade','slots']
    and jsonb_typeof(p_selection->'slots')='array' and jsonb_array_length(p_selection->'slots')<=100,'Revisa la configuración del pedido.');
  graph:=public.muerdeme_order_menu_graph_v1((p_selection->>'entryId')::uuid);
  root:=app_private.muerdeme_order_resolve_v1(graph,p_selection);doc:=root->'entry'->'document';variant:=root->'variant';rev:=root->'revisions';
  perform app_private.muerdeme_menu_check_v1(doc->>'kind'<>'extra' and root->'entry'->>'productId' is not null,'Guarda este producto en el catálogo para prepararlo para pedidos.');
  perform app_private.muerdeme_menu_check_v1(variant->'priceUsd'<>'null'::jsonb,'Falta definir el precio en USD.');
  total:=(variant->>'priceUsd')::numeric;
  if doc->>'kind'='combo' then
    perform app_private.muerdeme_menu_check_v1(p_selection->'removed'='[]'::jsonb and p_selection->'extras'='[]'::jsonb and p_selection->'friesUpgrade'='null'::jsonb,'Configura cada hamburguesa dentro del combo.');
    for group_doc in select a from jsonb_array_elements(doc->'comboGroups')a loop
      expected_slots:=expected_slots+(group_doc->>'quantity')::integer;
      for pos in 0..(group_doc->>'quantity')::integer-1 loop
        perform app_private.muerdeme_menu_check_v1((select count(*)=1 from jsonb_array_elements(p_selection->'slots')a where a->>'groupKey'=group_doc->>'key' and a->'position'=to_jsonb(pos)),'Falta elegir una unidad del combo.');
        select a into slot from jsonb_array_elements(p_selection->'slots')a where a->>'groupKey'=group_doc->>'key' and a->'position'=to_jsonb(pos);
        perform app_private.muerdeme_menu_check_v1((select count(*)=7 from jsonb_object_keys(slot)) and slot ?& array['entryId','variantKey','removed','extras','friesUpgrade','groupKey','position'],'Revisa cada unidad del combo.');
        select a into choice from jsonb_array_elements(group_doc->'choices')a where a->>'entryId'=slot->>'entryId' and a->>'variantKey'=slot->>'variantKey';
        perform app_private.muerdeme_menu_check_v1(choice is not null,'La presentación elegida no pertenece a este combo.');
        perform app_private.muerdeme_order_resolve_v1(graph,slot,group_doc->>'kind');
        result:=app_private.muerdeme_order_unit_v1(slot,graph,(group_doc->>'label')||' '||(pos+1)||': ');
        total:=total+(choice->>'supplementUsd')::numeric+(result->>'amountUsd')::numeric;lines:=lines||(result->'lines');rev:=rev||(result->'revisions');
        if (choice->>'supplementUsd')::numeric>0 then lines:=lines||jsonb_build_array('  Suplemento USD '||to_char((choice->>'supplementUsd')::numeric,'FM999999999990.00'));end if;
      end loop;
    end loop;
    perform app_private.muerdeme_menu_check_v1(jsonb_array_length(p_selection->'slots')=expected_slots,'Faltan o sobran unidades del combo.');
  else
    perform app_private.muerdeme_menu_check_v1(p_selection->'slots'='[]'::jsonb,'Este producto no admite componentes de combo.');
    result:=app_private.muerdeme_order_unit_v1(p_selection,graph,'');total:=total+(result->>'amountUsd')::numeric;lines:=result->'lines';rev:=rev||(result->'revisions');
  end if;
  if rev is distinct from p_expected_revisions then raise exception 'El menú o sus precios cambiaron. Vuelve a consultar y configurar el producto.' using errcode='40001';end if;
  perform app_private.muerdeme_menu_check_v1(total>=0 and total<1000000000,'El importe del producto supera el límite permitido.');
  return jsonb_build_object('version',1,'brand','muerdeme','productId',(root->'entry'->>'productId')::bigint,
    'title','Muérdeme · '||(root->>'label'),'unitUsd',total,'selection',p_selection,'revisions',rev,'detailLines',lines);
end;
$f$;

-- Final guard covers direct table writes and all existing order writers, too.
create function app_private.muerdeme_order_item_guard_v1()
returns trigger language plpgsql security invoker set search_path='' as $f$
declare v_entry uuid; v_quote jsonb; v_canonical jsonb; v_lines text[]; marker text; v_count integer; v_enabled boolean; v_fx numeric;
begin
  -- Existing service-role/counter VIVO writers need no access to private menu tables.
  if position('@muerdeme|' in coalesce(new.notes,''))=0 and not exists(
    select 1 from public.products p where p.id=new.product_id and p.extra_fields->>'commercial_brand'='muerdeme'
  ) then return new;end if;
  select entry_id into v_entry from app_private.muerdeme_menu_order_products where product_id=new.product_id;
  if v_entry is null then
    if position('@muerdeme|' in coalesce(new.notes,''))>0 then raise exception 'Una configuración Muérdeme no puede aplicarse a un producto VIVO.' using errcode='22023';end if;
    return new;
  end if;
  if tg_op='UPDATE' and new.product_id=old.product_id and new.qty=old.qty and new.notes is not distinct from old.notes
    and new.pricing_origin_currency is not distinct from old.pricing_origin_currency and new.pricing_origin_amount is not distinct from old.pricing_origin_amount
    and (to_jsonb(new)-'id'-'created_at')=(to_jsonb(old)-'id'-'created_at') then return new;end if;
  select sales_enabled into v_enabled from app_private.commercial_brands where code='muerdeme';
  if not coalesce(v_enabled,false) then raise exception 'Muérdeme está en preparación. Retira sus productos para guardar solo VIVO; la apertura comercial sigue pendiente.' using errcode='22023';end if;
  if tg_op='UPDATE' and new.product_id<>old.product_id and exists(select 1 from app_private.muerdeme_menu_order_products where product_id=old.product_id) then
    raise exception 'Retira el producto y agrega la nueva configuración.' using errcode='22023';end if;
  select count(*),min(line) into v_count,marker from regexp_split_to_table(coalesce(new.notes,''),E'\n')line where line like '@muerdeme|%';
  perform app_private.muerdeme_menu_check_v1(v_count=1 and length(marker)<=45000 and new.qty=1,'Cada producto Muérdeme necesita su configuración individual.');
  v_quote:=substring(marker from 11)::jsonb;
  v_canonical:=public.muerdeme_order_quote_v1(v_quote->'selection',v_quote->'revisions');
  perform app_private.muerdeme_menu_check_v1(v_quote=v_canonical and (v_quote->'selection'->>'entryId')::uuid=v_entry
    and (v_quote->>'productId')::bigint=new.product_id,'La configuración cambió. Vuelve a consultar el producto.');
  perform app_private.muerdeme_menu_check_v1(new.pricing_origin_currency='USD' and new.pricing_origin_amount=(v_quote->>'unitUsd')::numeric
    and new.admin_price_override_usd is null and new.override_unit_price_usd is null and new.crm_play_member_id is null
    and new.reward_grant_id is null,'El precio de Muérdeme se calcula desde su configuración, sin beneficios VIVO.');
  select nullif(extra_fields#>>'{pricing,fx_rate}','')::numeric into v_fx from public.orders where id=new.order_id;
  perform app_private.muerdeme_menu_check_v1(v_fx>0 and v_fx::text not in('NaN','Infinity','-Infinity'),'La orden necesita una tasa válida.');
  new.unit_price_usd_snapshot:=(v_quote->>'unitUsd')::numeric;
  new.line_total_usd:=new.unit_price_usd_snapshot;
  new.pricing_fx_rate_snapshot:=v_fx;
  new.unit_price_bs_snapshot:=round(new.unit_price_usd_snapshot*v_fx,2);
  new.line_total_bs_snapshot:=new.unit_price_bs_snapshot;
  select array_agg(a) into v_lines from jsonb_array_elements_text(v_quote->'detailLines')a;
  new.product_name_snapshot:=v_quote->>'title';
  new.notes:=array_to_string(v_lines||array['@muerdeme|'||v_canonical::text],E'\n');
  return new;
end;
$f$;
create trigger zzz_muerdeme_order_item_guard before insert or update on public.order_items
  for each row execute function app_private.muerdeme_order_item_guard_v1();

revoke all on function app_private.muerdeme_order_reader_v1(),app_private.muerdeme_order_menu_access_v1(),
 app_private.muerdeme_prepare_order_product_v1(),app_private.muerdeme_order_resolve_v1(jsonb,jsonb,text),
 app_private.muerdeme_order_product_link_guard_v1(),
 app_private.muerdeme_order_unit_v1(jsonb,jsonb,text),app_private.muerdeme_order_item_guard_v1(),
 public.muerdeme_order_menu_search_v1(text,text,integer),public.muerdeme_order_menu_graph_v1(uuid),public.muerdeme_order_quote_v1(jsonb,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function app_private.muerdeme_order_reader_v1(),app_private.muerdeme_order_menu_access_v1(),
 app_private.muerdeme_order_resolve_v1(jsonb,jsonb,text),app_private.muerdeme_order_unit_v1(jsonb,jsonb,text),
 public.muerdeme_order_menu_search_v1(text,text,integer),public.muerdeme_order_menu_graph_v1(uuid),public.muerdeme_order_quote_v1(jsonb,jsonb) to authenticated;
comment on table app_private.muerdeme_menu_order_products is 'Stable inactive product adapters for configurable Muérdeme menu entries. Not an activation or stock recipe.';
commit;
