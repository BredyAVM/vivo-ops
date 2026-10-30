-- Existing VIVO beverages are references, not Muérdeme products or duplicate stock.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function app_private.muerdeme_vivo_drink_refs_v1(p_doc jsonb)
returns table(product_id bigint) language sql immutable security invoker set search_path='' as $f$
 select distinct substring(c->>'entryId' from 6)::bigint
 from jsonb_array_elements(coalesce(p_doc->'comboGroups','[]'::jsonb))g
 cross join lateral jsonb_array_elements(g->'choices')c
 where g->>'kind'='drink' and c->>'entryId' ~ '^vivo:[1-9][0-9]{0,15}$';
$f$;

create function app_private.muerdeme_vivo_drink_entry_v1(p_product bigint)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare p public.products%rowtype;lines jsonb;total integer;valid integer;signature text;revision bigint;menu_revision bigint;
begin
 if app_private.muerdeme_order_menu_access_v1()is not true then raise exception 'Requiere acceso al menú.'using errcode='42501';end if;
 if p_product is null or p_product<=0 or p_product>9007199254740991 then return null;end if;
 select * into p from public.products where id=p_product;
 if not found or p.is_active is not true or p.type::text is distinct from 'product' or p.inventory_group::text is distinct from 'beverages'
  or coalesce(p.is_combo,false) or coalesce(p.is_detail_editable,false) or coalesce(p.inventory_policy::text,'') not in('self','direct')
  or p.inventory_configuration_status is distinct from 'ready'
  or coalesce(p.extra_fields->>'commercial_brand','vivo')='muerdeme'
  or coalesce(p.extra_fields->>'catalog_access_scope','')in('admin_internal','crm_only','advisor_gift','advisor_gift_only') then return null;end if;
 select count(*),count(*)filter(where l.quantity_units>0 and l.quantity_units<1000000000
  and l.quantity_units=round(l.quantity_units,6) and i.is_active and i.merged_into_item_id is null
  and i.tracking_mode='transactional' and coalesce('sale'=any(i.consumption_triggers),false))into total,valid
 from public.product_inventory_links l left join public.inventory_items i on i.id=l.inventory_item_id
 where l.product_id=p_product and l.configuration_version=1;
 if total=0 or total>80 or valid<>total then return null;end if;
 select jsonb_agg(jsonb_build_object('inventoryItemId',id,'name',name,'unitName',unit,'quantity',quantity)order by id)into lines
 from(select i.id,i.name,i.unit_name unit,sum(l.quantity_units)quantity
  from public.product_inventory_links l join public.inventory_items i on i.id=l.inventory_item_id
  where l.product_id=p_product and l.configuration_version=1 group by i.id,i.name,i.unit_name)t;
 signature:=md5(jsonb_build_object('name',p.name,'lines',lines)::text);
 revision:=(('x'||substring(signature from 1 for 13))::bit(52)::bigint)+1;
 menu_revision:=(('x'||substring(md5(p.name) from 1 for 13))::bit(52)::bigint)+1;
 return jsonb_build_object('entryId','vivo:'||p.id,'revision',menu_revision,'productId',p.id,
  'updatedAt',coalesce(to_jsonb(p)->>'updated_at',to_jsonb(p)->>'created_at','1970-01-01T00:00:00Z'),
  'sharedStock',jsonb_build_object('revision',revision,'lines',lines),'document',jsonb_build_object('schemaVersion',1,'kind','drink',
   'name',p.name,'archived',false,'variants',jsonb_build_array(jsonb_build_object('key','standard','label','Incluida',
    'priceUsd',0,'burger',null)),'comboGroups','[]'::jsonb,'friesUpgrades','[]'::jsonb));
end;
$f$;

-- Preserve the existing UUID graph for Muérdeme references and old saved documents.
do $patch$
declare d text;anchor text;
begin
 d:=pg_get_functiondef('app_private.muerdeme_menu_refs_v1(jsonb)'::regprocedure);
 anchor:=$a$cross join lateral jsonb_array_elements(g->'choices') x;$a$;
 if position(anchor in d)=0 then raise exception 'No se encontró el lector de referencias esperado.';end if;
 execute replace(d,anchor,$a$cross join lateral jsonb_array_elements(g->'choices') x
  where x->>'entryId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';$a$);
 d:=pg_get_functiondef('app_private.muerdeme_menu_validate_v1(jsonb,uuid)'::regprocedure);
 anchor:=$a$and c->>'entryId' ~ uuid_pattern$a$;
 if position(anchor in d)=0 then raise exception 'No se encontró la validación de opciones esperada.';end if;
 d:=replace(d,anchor,$a$and ((g->>'kind'='drink' and c->>'entryId' ~ '^vivo:[1-9][0-9]{0,15}$' and c->>'variantKey'='standard')
   or (g->>'kind'<>'drink' and c->>'entryId' ~ uuid_pattern))$a$);
 anchor:=$a$  for v in select value from jsonb_array_elements(p_doc->'variants') loop$a$;
 if position(anchor in d)=0 then raise exception 'No se encontró la validación de presentaciones esperada.';end if;
 d:=replace(d,anchor,$a$  perform app_private.muerdeme_menu_check_v1(p_doc->>'kind'<>'drink',
    'Las bebidas se seleccionan desde el catálogo VIVO dentro del combo; no crees una bebida duplicada.');
  for ref in select * from app_private.muerdeme_vivo_drink_refs_v1(p_doc) loop
    perform app_private.muerdeme_menu_check_v1(app_private.muerdeme_vivo_drink_entry_v1(ref.product_id)is not null,
      'La bebida VIVO no está disponible o su inventario necesita revisión.');
  end loop;
  perform app_private.muerdeme_menu_check_v1((select count(distinct entry_id)from app_private.muerdeme_menu_refs_v1(p_doc))
    +(select count(*)from app_private.muerdeme_vivo_drink_refs_v1(p_doc))<=100,'Un producto admite hasta 100 productos vinculados.');
  for v in select value from jsonb_array_elements(p_doc->'variants') loop$a$);
 execute d;
 -- Private bases retain all existing authorization, bounds and legacy reads.
 d:=pg_get_functiondef('public.muerdeme_order_menu_graph_v1(uuid)'::regprocedure);
 execute replace(d,'public.muerdeme_order_menu_graph_v1(','app_private.muerdeme_order_menu_graph_base_v1(');
 d:=pg_get_functiondef('public.admin_muerdeme_menu_editor_v1(uuid,text,text)'::regprocedure);
 execute replace(d,'public.admin_muerdeme_menu_editor_v1(','app_private.muerdeme_menu_editor_base_v1(');
 d:=pg_get_functiondef('app_private.muerdeme_order_resolve_v1(jsonb,jsonb,text)'::regprocedure);
 anchor:=$a$(e->>'revision')::integer$a$;
 if position(anchor in d)=0 then raise exception 'No se encontró la revisión de referencia esperada.';end if;
 execute replace(d,anchor,$a$(e->>'revision')::bigint$a$);
 d:=pg_get_functiondef('public.muerdeme_order_menu_search_v1(text,text,integer)'::regprocedure);
 anchor:=$a$where e.kind<>'extra' and$a$;
 if position(anchor in d)=0 then raise exception 'No se encontró la búsqueda de menú esperada.';end if;
 execute replace(d,anchor,$a$where e.kind not in('extra','drink') and$a$);
end;
$patch$;

create or replace function public.muerdeme_order_menu_graph_v1(p_entry_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare result jsonb;entry jsonb;ref record;
begin
 result:=app_private.muerdeme_order_menu_graph_base_v1(p_entry_id);
 for ref in select distinct r.product_id from jsonb_array_elements(result->'entries')e
  cross join lateral app_private.muerdeme_vivo_drink_refs_v1(e->'document')r order by r.product_id loop
  entry:=app_private.muerdeme_vivo_drink_entry_v1(ref.product_id);
  perform app_private.muerdeme_menu_check_v1(entry is not null,'Una bebida VIVO del combo no está disponible. Revisa su catálogo e inventario.');
  result:=jsonb_set(result,'{entries}',(result->'entries')||jsonb_build_array(entry));
 end loop;
 perform app_private.muerdeme_menu_check_v1(jsonb_array_length(result->'entries')<=201,'El producto tiene demasiadas opciones vinculadas.');
 return result;
end;
$f$;

create or replace function public.admin_muerdeme_menu_editor_v1(p_entry_id uuid default null,p_kind text default 'burger',p_reference_query text default '')
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare result jsonb;lookups jsonb;more boolean;
begin
 result:=app_private.muerdeme_menu_editor_base_v1(p_entry_id,p_kind,p_reference_query);
 if coalesce(result#>>'{entry,document,kind}',p_kind)<>'combo' then return result;end if;
 with candidates as (
  select a,false selected from jsonb_array_elements(result->'lookups')a where a->>'kind'<>'drink'
  union all
  select jsonb_build_object('entryId',e->>'entryId','kind','drink','name',e#>>'{document,name}','archived',false,
   'variants',jsonb_build_array(jsonb_build_object('key','standard','label','Incluida','priceUsd',0,'hasFries',false))),
   exists(select 1 from app_private.muerdeme_vivo_drink_refs_v1(result#>'{entry,document}')r where r.product_id=p.id)
  from public.products p cross join lateral(select app_private.muerdeme_vivo_drink_entry_v1(p.id)e)t
  where p.inventory_group::text='beverages' and e is not null
   and(exists(select 1 from app_private.muerdeme_vivo_drink_refs_v1(result#>'{entry,document}')r where r.product_id=p.id)
    or btrim(p_reference_query)='' or position(translate(lower(btrim(p_reference_query)),'áéíóúüñ','aeiouun')in translate(lower(p.name),'áéíóúüñ','aeiouun'))>0)
 ), ranked as (
  select a,selected or exists(select 1 from app_private.muerdeme_menu_refs_v1(coalesce(result#>'{entry,document}','{"variants":[],"comboGroups":[]}'::jsonb))r where r.entry_id::text=a->>'entryId')keep,
   row_number()over(order by selected desc,a->>'name',a->>'entryId')n from candidates
 ), limited as(select a,row_number()over(order by keep desc,a->>'name',a->>'entryId')n from ranked order by keep desc,a->>'name',a->>'entryId' limit 201)
 select coalesce(jsonb_agg(a order by n)filter(where n<=200),'[]'::jsonb),coalesce(bool_or(n=201),false)into lookups,more from limited;
 return result||jsonb_build_object('lookups',lookups,'lookupHasMore',more or(result->>'lookupHasMore')::boolean);
end;
$f$;

do $patch$
declare d text;anchor text;
begin
 d:=pg_get_functiondef('app_private.muerdeme_inventory_consume_v1(jsonb,jsonb,numeric)'::regprocedure);
 anchor:=$a$ select * into rec from app_private.muerdeme_inventory_recipe_revisions$a$;
 if position(anchor in d)=0 then raise exception 'No se encontró el consumo de inventario esperado.';end if;
 d:=replace(d,anchor,$a$ if e->>'entryId' ~ '^vivo:[1-9][0-9]{0,15}$' then
  select coalesce(jsonb_agg(jsonb_build_object('inventoryItemId',a->'inventoryItemId','name',a->'name',
    'unitName',a->'unitName','quantity',(a->>'quantity')::numeric*p_qty)order by(a->>'inventoryItemId')::bigint),'[]'::jsonb)into lines
  from jsonb_array_elements(e#>'{sharedStock,lines}')a;
  return jsonb_build_object('lines',lines,'issues','[]'::jsonb,'revisions',jsonb_build_object((e->>'entryId')||':'||(v->>'key'),(e#>>'{sharedStock,revision}')::bigint));
 end if;
 select * into rec from app_private.muerdeme_inventory_recipe_revisions$a$);
 execute d;
end;
$patch$;

revoke all on function app_private.muerdeme_vivo_drink_refs_v1(jsonb),app_private.muerdeme_vivo_drink_entry_v1(bigint),
 app_private.muerdeme_order_menu_graph_base_v1(uuid),app_private.muerdeme_menu_editor_base_v1(uuid,text,text)
 from public,anon,authenticated,service_role;
grant execute on function app_private.muerdeme_vivo_drink_refs_v1(jsonb),app_private.muerdeme_vivo_drink_entry_v1(bigint),
 app_private.muerdeme_order_menu_graph_base_v1(uuid),app_private.muerdeme_menu_editor_base_v1(uuid,text,text)to authenticated;
commit;
