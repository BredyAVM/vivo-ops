-- Preparation catalogue only; never writes public.products or order/financial data.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create table app_private.muerdeme_menu_entries (
  id uuid primary key default gen_random_uuid(),
  brand_code text not null default 'muerdeme' check (brand_code='muerdeme')
    references app_private.commercial_brands(code),
  kind text not null check (kind in ('burger','extra','fries','drink','combo')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index muerdeme_menu_entries_kind_idx on app_private.muerdeme_menu_entries(kind,id);
create table app_private.muerdeme_menu_revisions (
  entry_id uuid not null references app_private.muerdeme_menu_entries(id),
  revision integer not null check(revision>0),
  document jsonb not null check(jsonb_typeof(document)='object' and octet_length(document::text)<=100000),
  operation_id uuid not null unique,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key(entry_id,revision)
);
alter table app_private.muerdeme_menu_entries enable row level security;
alter table app_private.muerdeme_menu_revisions enable row level security;
revoke all on app_private.muerdeme_menu_entries,app_private.muerdeme_menu_revisions from public,anon,authenticated,service_role;
grant select,insert on app_private.muerdeme_menu_entries,app_private.muerdeme_menu_revisions to authenticated;
create policy muerdeme_menu_entries_read on app_private.muerdeme_menu_entries for select to authenticated
  using ((select app_private.commercial_foundation_is_admin_v1()));
create policy muerdeme_menu_entries_insert on app_private.muerdeme_menu_entries for insert to authenticated
  with check ((select app_private.commercial_foundation_is_admin_v1()) and created_by=(select auth.uid()));
create policy muerdeme_menu_revisions_read on app_private.muerdeme_menu_revisions for select to authenticated
  using ((select app_private.commercial_foundation_is_admin_v1()));
create policy muerdeme_menu_revisions_insert on app_private.muerdeme_menu_revisions for insert to authenticated
  with check ((select app_private.commercial_foundation_is_admin_v1()) and actor_id=(select auth.uid()));

create function app_private.muerdeme_menu_check_v1(p_ok boolean,p_message text) returns void
language plpgsql security invoker set search_path='' as $f$
begin if p_ok is not true then raise exception '%',p_message using errcode='22023'; end if; end; $f$;
create function app_private.muerdeme_menu_price_v1(p_value jsonb,p_pending boolean default false) returns boolean
language sql immutable security invoker set search_path='' as $f$
  select case when p_value='null'::jsonb then p_pending
    when jsonb_typeof(p_value)='number' then (p_value#>>'{}')::numeric>=0
      and (p_value#>>'{}')::numeric<1000000000
      and (p_value#>>'{}')::numeric=round((p_value#>>'{}')::numeric,2)
    else false end;
$f$;
create function app_private.muerdeme_menu_refs_v1(p_doc jsonb)
returns table(entry_id uuid,variant_key text,kind text)
language sql immutable security invoker set search_path='' as $f$
  select (x->>'entryId')::uuid,x->>'variantKey','extra'::text
  from jsonb_array_elements(p_doc->'variants') v
  cross join lateral jsonb_array_elements(coalesce(v->'burger'->'extras','[]'::jsonb)) x
  union all
  select (v->'burger'->'includedFries'->>'entryId')::uuid,v->'burger'->'includedFries'->>'variantKey','fries'::text
  from jsonb_array_elements(p_doc->'variants') v
  where jsonb_typeof(v->'burger'->'includedFries')='object'
  union all
  select (x->>'entryId')::uuid,x->>'variantKey',g->>'kind'
  from jsonb_array_elements(p_doc->'comboGroups') g
  cross join lateral jsonb_array_elements(g->'choices') x;
$f$;

create function app_private.muerdeme_menu_validate_v1(p_doc jsonb,p_entry_id uuid) returns void
language plpgsql security invoker set search_path='' as $f$
declare
  v jsonb; b jsonb; x jsonb; g jsonb; c jsonb; u jsonb;
  keys text[]:='{}'; ingredient_keys text[]; extra_keys text[]; group_keys text[]:='{}'; choice_keys text[]; upgrade_keys text[]:='{}';
  key_pattern text:='^[a-zA-Z][a-zA-Z0-9_-]{0,63}$';
  uuid_pattern text:='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  slots integer:=0; ref record; target jsonb; target_kind text; target_variant jsonb;
  has_fries_group boolean:=false; burger_includes_fries boolean:=false;
begin
  perform app_private.muerdeme_menu_check_v1(app_private.commercial_foundation_is_admin_v1(),'Esta operación requiere un administrador activo.');
  perform app_private.muerdeme_menu_check_v1(jsonb_typeof(p_doc)='object' and octet_length(p_doc::text)<=100000,'La configuración es demasiado extensa o está incompleta.');
  perform app_private.muerdeme_menu_check_v1(p_doc ?& array['schemaVersion','kind','name','archived','variants','comboGroups','friesUpgrades']
    and p_doc-array['schemaVersion','kind','name','archived','variants','comboGroups','friesUpgrades']='{}'::jsonb
    and p_doc->'schemaVersion'='1'::jsonb and p_doc->>'kind' in ('burger','extra','fries','drink','combo')
    and jsonb_typeof(p_doc->'name')='string' and length(btrim(p_doc->>'name')) between 1 and 120
    and jsonb_typeof(p_doc->'archived')='boolean','Revisa el nombre y el tipo de producto.');
  perform app_private.muerdeme_menu_check_v1(jsonb_typeof(p_doc->'variants')='array'
    and jsonb_typeof(p_doc->'comboGroups')='array' and jsonb_typeof(p_doc->'friesUpgrades')='array','Revisa las presentaciones del producto.');
  perform app_private.muerdeme_menu_check_v1(jsonb_array_length(p_doc->'variants') between 1 and 20
    and jsonb_array_length(p_doc->'comboGroups')<=12 and jsonb_array_length(p_doc->'friesUpgrades')<=50,'La configuración supera el límite de opciones.');
  for v in select value from jsonb_array_elements(p_doc->'variants') loop
    perform app_private.muerdeme_menu_check_v1(jsonb_typeof(v)='object' and v ?& array['key','label','priceUsd','burger']
      and v-array['key','label','priceUsd','burger']='{}'::jsonb and jsonb_typeof(v->'key')='string' and v->>'key' ~ key_pattern
      and jsonb_typeof(v->'label')='string' and length(btrim(v->>'label')) between 1 and 100
      and not (v->>'key'=any(keys)) and app_private.muerdeme_menu_price_v1(v->'priceUsd',true),'Revisa el nombre y el precio en USD de las presentaciones.');
    keys:=array_append(keys,v->>'key');
    if p_doc->>'kind'<>'burger' then
      perform app_private.muerdeme_menu_check_v1(v->'burger'='null'::jsonb,'Solo las hamburguesas llevan ingredientes y extras.');
      continue;
    end if;
    b:=v->'burger';
    perform app_private.muerdeme_menu_check_v1(jsonb_typeof(b)='object' and b ?& array['pattyCount','ingredients','extras','includedFries']
      and b-array['pattyCount','ingredients','extras','includedFries']='{}'::jsonb
      and b->'pattyCount' in ('1'::jsonb,'2'::jsonb)
      and jsonb_typeof(b->'ingredients')='array' and jsonb_typeof(b->'extras')='array','Selecciona simple o doble y revisa sus ingredientes.');
    perform app_private.muerdeme_menu_check_v1(jsonb_array_length(b->'ingredients')<=40 and jsonb_array_length(b->'extras')<=40,'Hay demasiados ingredientes o extras.');
    ingredient_keys:='{}'; extra_keys:='{}';
    for x in select value from jsonb_array_elements(b->'ingredients') loop
      perform app_private.muerdeme_menu_check_v1(jsonb_typeof(x)='object' and x ?& array['key','label','removable']
        and x-array['key','label','removable']='{}'::jsonb and jsonb_typeof(x->'key')='string' and x->>'key' ~ key_pattern
        and jsonb_typeof(x->'label')='string' and length(btrim(x->>'label')) between 1 and 80
        and jsonb_typeof(x->'removable')='boolean' and not(x->>'key'=any(ingredient_keys)),'Revisa los ingredientes y cuáles se pueden retirar.');
      ingredient_keys:=array_append(ingredient_keys,x->>'key');
    end loop;
    for x in select value from jsonb_array_elements(b->'extras') loop
      perform app_private.muerdeme_menu_check_v1(jsonb_typeof(x)='object' and x ?& array['entryId','variantKey','maxQty']
        and x-array['entryId','variantKey','maxQty']='{}'::jsonb and x->>'entryId' ~ uuid_pattern and jsonb_typeof(x->'variantKey')='string' and x->>'variantKey' ~ key_pattern
        and jsonb_typeof(x->'maxQty')='number' and x->>'maxQty' ~ '^[0-9]{1,2}$'
        and not((x->>'entryId')||':'||(x->>'variantKey')=any(extra_keys)),'Revisa las opciones y cantidades de extras.');
      perform app_private.muerdeme_menu_check_v1((x->>'maxQty')::int between 1 and 20,'La cantidad máxima de un extra debe estar entre 1 y 20.');
      extra_keys:=array_append(extra_keys,(x->>'entryId')||':'||(x->>'variantKey'));
    end loop;
    x:=b->'includedFries';
    if x<>'null'::jsonb then
      perform app_private.muerdeme_menu_check_v1(jsonb_typeof(x)='object' and x ?& array['entryId','variantKey','quantity']
        and x-array['entryId','variantKey','quantity']='{}'::jsonb and x->>'entryId' ~ uuid_pattern and jsonb_typeof(x->'variantKey')='string' and x->>'variantKey' ~ key_pattern
        and jsonb_typeof(x->'quantity')='number' and x->>'quantity' ~ '^[0-9]{1,2}$','Selecciona las papas incluidas y su presentación.');
      perform app_private.muerdeme_menu_check_v1((x->>'quantity')::int between 1 and 20,'Revisa las porciones de papas incluidas.');
    end if;
  end loop;
  perform app_private.muerdeme_menu_check_v1(p_doc->>'kind'='combo' or jsonb_array_length(p_doc->'comboGroups')=0,'Solo un combo puede llevar grupos de productos.');
  for g in select value from jsonb_array_elements(p_doc->'comboGroups') loop
    perform app_private.muerdeme_menu_check_v1(jsonb_typeof(g)='object' and g ?& array['key','label','kind','quantity','choices']
      and g-array['key','label','kind','quantity','choices']='{}'::jsonb and jsonb_typeof(g->'key')='string' and g->>'key' ~ key_pattern
      and jsonb_typeof(g->'label')='string' and length(btrim(g->>'label')) between 1 and 100
      and g->>'kind' in ('burger','fries','drink') and not(g->>'key'=any(group_keys))
      and jsonb_typeof(g->'quantity')='number' and g->>'quantity' ~ '^[0-9]{1,2}$'
      and jsonb_typeof(g->'choices')='array','Revisa el nombre, tipo y cantidad del grupo del combo.');
    perform app_private.muerdeme_menu_check_v1((g->>'quantity')::int between 1 and 50 and jsonb_array_length(g->'choices')<=50,'Revisa las cantidades y opciones del combo.');
    slots:=slots+(g->>'quantity')::int; group_keys:=array_append(group_keys,g->>'key'); choice_keys:='{}';
    if g->>'kind'='fries' and jsonb_array_length(g->'choices')>0 then has_fries_group:=true; end if;
    for c in select value from jsonb_array_elements(g->'choices') loop
      perform app_private.muerdeme_menu_check_v1(jsonb_typeof(c)='object' and c ?& array['entryId','variantKey','supplementUsd']
        and c-array['entryId','variantKey','supplementUsd']='{}'::jsonb and c->>'entryId' ~ uuid_pattern
        and jsonb_typeof(c->'variantKey')='string' and c->>'variantKey' ~ key_pattern and app_private.muerdeme_menu_price_v1(c->'supplementUsd')
        and not((c->>'entryId')||':'||(c->>'variantKey')=any(choice_keys)),'Revisa las opciones y suplementos en USD del combo.');
      choice_keys:=array_append(choice_keys,(c->>'entryId')||':'||(c->>'variantKey'));
    end loop;
  end loop;
  perform app_private.muerdeme_menu_check_v1(slots<=100,'Un combo admite hasta 100 unidades configurables.');
  perform app_private.muerdeme_menu_check_v1(p_doc->>'kind'='fries' or jsonb_array_length(p_doc->'friesUpgrades')=0,'Solo las papas llevan ampliaciones de tamaño.');
  for u in select value from jsonb_array_elements(p_doc->'friesUpgrades') loop
    perform app_private.muerdeme_menu_check_v1(jsonb_typeof(u)='object' and u ?& array['fromKey','toKey','supplementUsd']
      and u-array['fromKey','toKey','supplementUsd']='{}'::jsonb and jsonb_typeof(u->'fromKey')='string' and jsonb_typeof(u->'toKey')='string' and u->>'fromKey'=any(keys) and u->>'toKey'=any(keys)
      and u->>'fromKey'<>u->>'toKey' and app_private.muerdeme_menu_price_v1(u->'supplementUsd')
      and not((u->>'fromKey')||':'||(u->>'toKey')=any(upgrade_keys)),'Revisa las ampliaciones de papas y su suplemento en USD.');
    upgrade_keys:=array_append(upgrade_keys,(u->>'fromKey')||':'||(u->>'toKey'));
  end loop;
  perform app_private.muerdeme_menu_check_v1((select count(distinct entry_id)<=100 from app_private.muerdeme_menu_refs_v1(p_doc)),'Un producto admite hasta 100 productos vinculados.');
  for ref in select * from app_private.muerdeme_menu_refs_v1(p_doc) loop
    perform app_private.muerdeme_menu_check_v1(ref.entry_id<>p_entry_id,'Un producto no puede incluirse a sí mismo.');
    select e.kind,r.document into target_kind,target
    from app_private.muerdeme_menu_entries e
    join lateral (select document from app_private.muerdeme_menu_revisions where entry_id=e.id order by revision desc limit 1) r on true
    where e.id=ref.entry_id and e.brand_code='muerdeme';
    perform app_private.muerdeme_menu_check_v1(target is not null and target_kind=ref.kind and target->'archived'='false'::jsonb,'Una opción vinculada no está disponible o no corresponde al tipo indicado.');
    select value into target_variant from jsonb_array_elements(target->'variants') where value->>'key'=ref.variant_key;
    perform app_private.muerdeme_menu_check_v1(target_variant is not null,'Una presentación vinculada ya no existe. Revisa sus opciones.');
    if ref.kind='burger' and jsonb_typeof(target_variant->'burger'->'includedFries')='object' then burger_includes_fries:=true; end if;
  end loop;
  perform app_private.muerdeme_menu_check_v1(not(has_fries_group and burger_includes_fries),'Las hamburguesas ya incluyen papas. Usa hamburguesas solas o retira el grupo adicional de papas.');
end;
$f$;

create function app_private.muerdeme_menu_revision_guard_v1() returns trigger
language plpgsql security invoker set search_path='' as $f$
declare v_kind text; v_previous integer;
begin
  perform app_private.muerdeme_menu_check_v1(app_private.commercial_foundation_is_admin_v1(),'Esta operación requiere un administrador activo.');
  perform pg_advisory_xact_lock(hashtextextended('muerdeme-menu-drafts:v1',0));
  perform app_private.muerdeme_menu_check_v1(exists(select 1 from app_private.commercial_brands where code='muerdeme' and not sales_enabled),'El menú ya está en operación. Utiliza su configuración comercial vigente.');
  select kind into v_kind from app_private.muerdeme_menu_entries where id=new.entry_id;
  perform app_private.muerdeme_menu_check_v1(v_kind is not null and new.document->>'kind'=v_kind,'No se puede cambiar el tipo de un producto existente.');
  perform app_private.muerdeme_menu_validate_v1(new.document,new.entry_id);
  select coalesce(max(revision),0) into v_previous from app_private.muerdeme_menu_revisions where entry_id=new.entry_id;
  perform app_private.muerdeme_menu_check_v1(new.revision=v_previous+1 and new.actor_id=(select auth.uid()),'La versión o el autor de la configuración no son válidos.');
  if new.document->'archived'='false'::jsonb then
    perform app_private.muerdeme_menu_check_v1(not exists(
      select 1 from app_private.muerdeme_menu_entries e
      join lateral(select document from app_private.muerdeme_menu_revisions where entry_id=e.id order by revision desc limit 1) r on true
      where e.id<>new.entry_id and e.kind=v_kind and r.document->'archived'='false'::jsonb
        and lower(btrim(r.document->>'name'))=lower(btrim(new.document->>'name'))
    ),'Ya existe otro producto de este tipo con ese nombre.');
  end if;
  return new;
end;
$f$;
create function app_private.muerdeme_menu_parent_guard_v1() returns trigger
language plpgsql security invoker set search_path='' as $f$
declare parent record;
begin
  for parent in
    select e.id,r.document from app_private.muerdeme_menu_entries e
    join lateral(select document from app_private.muerdeme_menu_revisions where entry_id=e.id order by revision desc limit 1) r on true
    where e.id<>new.entry_id and r.document->'archived'='false'::jsonb
      and exists(select 1 from app_private.muerdeme_menu_refs_v1(r.document) ref where ref.entry_id=new.entry_id)
  loop
    begin perform app_private.muerdeme_menu_validate_v1(parent.document,parent.id);
    exception when sqlstate '22023' then
      raise exception 'El cambio dejaría incompleto «%». Ajusta primero sus opciones vinculadas.',parent.document->>'name' using errcode='22023';
    end;
  end loop;
  return new;
end;
$f$;
create trigger muerdeme_menu_revision_guard before insert on app_private.muerdeme_menu_revisions
  for each row execute function app_private.muerdeme_menu_revision_guard_v1();
create trigger muerdeme_menu_parent_guard after insert on app_private.muerdeme_menu_revisions
  for each row execute function app_private.muerdeme_menu_parent_guard_v1();

create function public.admin_muerdeme_menu_save_v1(p_entry_id uuid,p_expected_revision integer,p_document jsonb,p_operation_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $f$
declare v_saved app_private.muerdeme_menu_revisions%rowtype; v_id uuid; v_revision integer; v_kind text;
begin
  if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Esta operación requiere un administrador activo.' using errcode='42501'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Reintenta el guardado en una nueva consulta.' using errcode='25001'; end if;
  perform app_private.muerdeme_menu_check_v1(p_operation_id is not null and p_expected_revision is not null
    and ((p_entry_id is null and p_expected_revision=0) or(p_entry_id is not null and p_expected_revision>0)),'Vuelve a consultar el producto antes de guardar.');
  perform pg_advisory_xact_lock(hashtextextended('muerdeme-menu-drafts:v1',0));
  if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Esta operación requiere un administrador activo.' using errcode='42501'; end if;
  select * into v_saved from app_private.muerdeme_menu_revisions where operation_id=p_operation_id;
  if found then
    perform app_private.muerdeme_menu_check_v1(v_saved.actor_id=(select auth.uid()) and v_saved.document=p_document
      and v_saved.revision=p_expected_revision+1 and ((p_entry_id is null and v_saved.revision=1) or p_entry_id=v_saved.entry_id),'La solicitud ya fue utilizada con otros datos.');
    return jsonb_build_object('entryId',v_saved.entry_id,'revision',v_saved.revision);
  end if;
  perform app_private.muerdeme_menu_check_v1(exists(select 1 from app_private.commercial_brands where code='muerdeme' and not sales_enabled),'El menú ya está en operación. Utiliza su configuración comercial vigente.');
  if p_entry_id is null then
    v_id:=gen_random_uuid();
    perform app_private.muerdeme_menu_validate_v1(p_document,v_id);
    insert into app_private.muerdeme_menu_entries(id,kind,created_by) values(v_id,p_document->>'kind',(select auth.uid()));
  else
    v_id:=p_entry_id;
    select kind into v_kind from app_private.muerdeme_menu_entries where id=v_id;
    perform app_private.muerdeme_menu_check_v1(v_kind is not null,'No se encontró el producto solicitado.');
    select coalesce(max(revision),0) into v_revision from app_private.muerdeme_menu_revisions where entry_id=v_id;
    if v_revision<>p_expected_revision then raise exception 'El producto cambió. Vuelve a consultarlo antes de guardar.' using errcode='40001'; end if;
  end if;
  insert into app_private.muerdeme_menu_revisions(entry_id,revision,document,operation_id,actor_id)
    values(v_id,p_expected_revision+1,p_document,p_operation_id,(select auth.uid()));
  return jsonb_build_object('entryId',v_id,'revision',p_expected_revision+1);
end;
$f$;

create function public.admin_muerdeme_menu_list_v1(p_query text default '',p_kind text default null,p_page integer default 1,p_archived boolean default false)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare rows jsonb; has_next boolean;
begin
  if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Esta operación requiere un administrador activo.' using errcode='42501'; end if;
  perform app_private.muerdeme_menu_check_v1(p_query is not null and length(p_query)<=100 and p_page between 1 and 10000
    and (p_kind is null or p_kind in ('burger','extra','fries','drink','combo')) and p_archived is not null,'Filtros del catálogo inválidos.');
  with page_rows as (
    select e.id,e.kind,r.document,r.revision,r.created_at from app_private.muerdeme_menu_entries e
    join lateral(select document,revision,created_at from app_private.muerdeme_menu_revisions where entry_id=e.id order by revision desc limit 1) r on true
    where (p_kind is null or e.kind=p_kind) and (r.document->>'archived')::boolean=p_archived
      and (btrim(p_query)='' or position(translate(lower(btrim(p_query)),'áéíóúüñ','aeiouun') in translate(lower(r.document->>'name'),'áéíóúüñ','aeiouun'))>0)
    order by r.document->>'name',e.id limit 26 offset (p_page-1)*25
  ), numbered as(select *,row_number()over(order by document->>'name',id) n from page_rows)
  select coalesce(jsonb_agg(jsonb_build_object('entryId',id,'kind',kind,'name',document->>'name','archived',(document->>'archived')::boolean,
    'revision',revision,'variantCount',jsonb_array_length(document->'variants'),
    'missingPrices',(select count(*) from jsonb_array_elements(document->'variants') v where v->'priceUsd'='null'::jsonb),'updatedAt',created_at)
    order by document->>'name',id)filter(where n<=25),'[]'::jsonb),coalesce(bool_or(n=26),false) into rows,has_next from numbered;
  return jsonb_build_object('version','muerdeme-menu-v1','rows',rows,'hasNext',has_next,'page',p_page);
end;
$f$;

create function public.admin_muerdeme_menu_editor_v1(p_entry_id uuid default null,p_kind text default 'burger',p_reference_query text default '')
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare current_entry jsonb:=null; current_doc jsonb; kinds text[]; lookups jsonb; has_more boolean;
begin
  if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Esta operación requiere un administrador activo.' using errcode='42501'; end if;
  perform app_private.muerdeme_menu_check_v1(p_reference_query is not null and length(p_reference_query)<=100,'Revisa la búsqueda de opciones.');
  if p_entry_id is not null then
    select jsonb_build_object('entryId',e.id,'revision',r.revision,'document',r.document,'updatedAt',r.created_at),r.document,e.kind
    into current_entry,current_doc,p_kind from app_private.muerdeme_menu_entries e
    join lateral(select revision,document,created_at from app_private.muerdeme_menu_revisions where entry_id=e.id order by revision desc limit 1) r on true
    where e.id=p_entry_id;
    if current_entry is null then raise exception 'No se encontró el producto solicitado.' using errcode='P0002'; end if;
  end if;
  perform app_private.muerdeme_menu_check_v1(p_kind in ('burger','extra','fries','drink','combo'),'Selecciona un tipo de producto válido.');
  kinds:=case p_kind when 'burger' then array['extra','fries'] when 'combo' then array['burger','fries','drink'] else array[]::text[] end;
  with candidates as (
    select e.id,e.kind,r.document,
      exists(select 1 from app_private.muerdeme_menu_refs_v1(coalesce(current_doc,'{"variants":[],"comboGroups":[]}'::jsonb)) ref where ref.entry_id=e.id) selected
    from app_private.muerdeme_menu_entries e
    join lateral(select document from app_private.muerdeme_menu_revisions where entry_id=e.id order by revision desc limit 1) r on true
    where e.kind=any(kinds) and e.id is distinct from p_entry_id
  ), limited as (
    select *,row_number()over(order by selected desc,document->>'name',id) n from candidates
    where selected or (document->'archived'='false'::jsonb and (btrim(p_reference_query)='' or position(translate(lower(btrim(p_reference_query)),'áéíóúüñ','aeiouun') in translate(lower(document->>'name'),'áéíóúüñ','aeiouun'))>0))
    order by selected desc,document->>'name',id limit 201
  )
  select coalesce(jsonb_agg(jsonb_build_object('entryId',id,'kind',kind,'name',document->>'name','archived',(document->>'archived')::boolean,
    'variants',(select jsonb_agg(jsonb_build_object('key',v->>'key','label',v->>'label','priceUsd',v->'priceUsd','hasFries',coalesce(jsonb_typeof(v->'burger'->'includedFries')='object',false)) order by ord)
      from jsonb_array_elements(document->'variants')with ordinality a(v,ord))) order by selected desc,document->>'name',id)filter(where n<=200),'[]'::jsonb),
    coalesce(bool_or(n=201),false) into lookups,has_more from limited;
  return jsonb_build_object('version','muerdeme-menu-v1','entry',current_entry,'lookups',lookups,'lookupHasMore',has_more);
end;
$f$;

revoke all on function app_private.muerdeme_menu_check_v1(boolean,text),app_private.muerdeme_menu_price_v1(jsonb,boolean),
  app_private.muerdeme_menu_refs_v1(jsonb),app_private.muerdeme_menu_validate_v1(jsonb,uuid),
  app_private.muerdeme_menu_revision_guard_v1(),app_private.muerdeme_menu_parent_guard_v1(),
  public.admin_muerdeme_menu_save_v1(uuid,integer,jsonb,uuid),public.admin_muerdeme_menu_list_v1(text,text,integer,boolean),
  public.admin_muerdeme_menu_editor_v1(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function app_private.muerdeme_menu_check_v1(boolean,text),app_private.muerdeme_menu_price_v1(jsonb,boolean),
  app_private.muerdeme_menu_refs_v1(jsonb),app_private.muerdeme_menu_validate_v1(jsonb,uuid),
  public.admin_muerdeme_menu_save_v1(uuid,integer,jsonb,uuid),public.admin_muerdeme_menu_list_v1(text,text,integer,boolean),
  public.admin_muerdeme_menu_editor_v1(uuid,text,text) to authenticated;
comment on table app_private.muerdeme_menu_entries is 'Muérdeme preparation identities only; not saleable products.';
comment on table app_private.muerdeme_menu_revisions is 'Immutable audited menu drafts. Prices may remain pending; publication is a separate future command.';
commit;
