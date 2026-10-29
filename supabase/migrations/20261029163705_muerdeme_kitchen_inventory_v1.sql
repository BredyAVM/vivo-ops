-- Muérdeme operational recipes share the existing inventory ledger. No sales activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table app_private.muerdeme_inventory_recipe_revisions(
 entry_id uuid not null references app_private.muerdeme_menu_entries(id),variant_key text not null,
 revision integer not null check(revision>0),menu_revision integer not null check(menu_revision>0),
 signature jsonb not null,document jsonb not null,operation_id uuid not null unique,
 actor_id uuid not null references public.profiles(id),created_at timestamptz not null default now(),
 primary key(entry_id,variant_key,revision)
);
create index muerdeme_inventory_recipe_actor_idx on app_private.muerdeme_inventory_recipe_revisions(actor_id);
alter table app_private.muerdeme_inventory_recipe_revisions enable row level security;
revoke all on app_private.muerdeme_inventory_recipe_revisions from public,anon,authenticated,service_role;
grant select,insert on app_private.muerdeme_inventory_recipe_revisions to authenticated;
create policy muerdeme_inventory_recipe_read on app_private.muerdeme_inventory_recipe_revisions for select to authenticated
 using((select app_private.muerdeme_order_menu_access_v1()));
create policy muerdeme_inventory_recipe_insert on app_private.muerdeme_inventory_recipe_revisions for insert to authenticated
 with check((select app_private.commercial_foundation_is_admin_v1()) and actor_id=(select auth.uid()));

-- Persist certificates independently of row IDs: the shared editor can replace item rows atomically.
create table app_private.muerdeme_inventory_certificates(
 id uuid primary key,order_id bigint not null references public.orders(id)on delete cascade,
 order_item_id bigint unique references public.order_items(id)on delete set null deferrable initially deferred,
 quote jsonb not null,snapshot jsonb not null,created_at timestamptz not null default now()
);
create index muerdeme_inventory_certificates_order_idx on app_private.muerdeme_inventory_certificates(order_id);
alter table app_private.muerdeme_inventory_certificates enable row level security;
revoke all on app_private.muerdeme_inventory_certificates from public,anon,authenticated,service_role;
grant select,insert,update on app_private.muerdeme_inventory_certificates to authenticated;
create policy muerdeme_inventory_certificate_access on app_private.muerdeme_inventory_certificates for all to authenticated
 using((select app_private.muerdeme_order_reader_v1()) and exists(select 1 from public.orders o where o.id=muerdeme_inventory_certificates.order_id
   and(public.has_role('admin')or public.has_role('master')or o.attributed_advisor_id=(select auth.uid()))))
 with check((select app_private.muerdeme_order_reader_v1()) and exists(select 1 from public.orders o where o.id=muerdeme_inventory_certificates.order_id
   and(public.has_role('admin')or public.has_role('master')or o.attributed_advisor_id=(select auth.uid()))));
create function app_private.muerdeme_inventory_certificate_guard_v1()
returns trigger language plpgsql security invoker set search_path='' as $f$
begin
 if pg_trigger_depth()<2 then raise exception 'Los consumos se certifican al guardar la orden.'using errcode='42501';end if;
 if tg_op='INSERT' then
  if new.snapshot->>'certificateId' is distinct from new.id::text or new.snapshot->>'status' is distinct from 'ready'
    or new.quote is distinct from public.muerdeme_order_quote_v1(new.quote->'selection',new.quote->'revisions')
    or (new.snapshot-'certificateId')is distinct from app_private.muerdeme_inventory_snapshot_v1(new.quote)then
   raise exception 'El consumo certificado no coincide con la preparación vigente.'using errcode='22023';
  end if;
 end if;
 if tg_op='UPDATE' and(to_jsonb(new)-'order_item_id')is distinct from(to_jsonb(old)-'order_item_id')then
  raise exception 'El consumo certificado es inmutable.'using errcode='42501';end if;
 if new.order_item_id is not null and exists(select 1 from public.order_items i where i.id=new.order_item_id
    and (i.order_id<>new.order_id or i.product_id<>(new.quote->>'productId')::bigint))then
  raise exception 'La preparación no pertenece al producto y la orden indicados.'using errcode='22023';
 end if;
 return new;
end;
$f$;
create trigger muerdeme_inventory_certificate_guard before insert or update on app_private.muerdeme_inventory_certificates
 for each row execute function app_private.muerdeme_inventory_certificate_guard_v1();

create function app_private.muerdeme_inventory_signature_v1(p_kind text,p_variant jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $f$
 select jsonb_build_object('kind',p_kind,'key',p_variant->>'key','pattyCount',p_variant->'burger'->'pattyCount',
  'ingredients',coalesce((select jsonb_agg(jsonb_build_object('key',a->>'key','label',a->>'label') order by(a->>'key')collate "C")
    from jsonb_array_elements(coalesce(p_variant->'burger'->'ingredients','[]'::jsonb))a),'[]'::jsonb));
$f$;
create function app_private.muerdeme_inventory_recipe_guard_v1()
returns trigger language plpgsql security invoker set search_path='' as $f$
declare d jsonb;v jsonb;l jsonb;r integer;mr integer;
begin
 if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Requiere administración activa.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('muerdeme-menu-drafts:v1',0));
 select document,revision into d,mr from app_private.muerdeme_menu_revisions where entry_id=new.entry_id order by revision desc limit 1;
 select a into v from jsonb_array_elements(d->'variants')a where a->>'key'=new.variant_key;
 perform app_private.muerdeme_menu_check_v1(v is not null and d->'archived'='false'::jsonb and new.menu_revision=mr
   and new.signature=app_private.muerdeme_inventory_signature_v1(d->>'kind',v),'El menú cambió. Vuelve a consultar antes de guardar el consumo.');
 select coalesce(max(revision),0) into r from app_private.muerdeme_inventory_recipe_revisions where entry_id=new.entry_id and variant_key=new.variant_key;
 perform app_private.muerdeme_menu_check_v1(new.revision=r+1 and new.actor_id=(select auth.uid()),'La receta cambió o el autor no coincide. Vuelve a consultar.');
 perform app_private.muerdeme_menu_check_v1(jsonb_typeof(new.document)='object' and pg_column_size(new.document)<=24000
  and (select count(*)=4 from jsonb_object_keys(new.document)) and new.document ?& array['schemaVersion','mode','note','lines']
  and new.document->'schemaVersion'='1'::jsonb and new.document->>'mode' in('tracked','untracked','components')
  and jsonb_typeof(new.document->'note')='string' and length(new.document->>'note')<=300
  and jsonb_typeof(new.document->'lines')='array' and jsonb_array_length(new.document->'lines')<=80,'La receta está incompleta.');
 if new.document->>'mode'='tracked' then
   perform app_private.muerdeme_menu_check_v1(jsonb_array_length(new.document->'lines')>0,'Añade al menos un insumo y su cantidad.');
 else
   perform app_private.muerdeme_menu_check_v1(new.document->'lines'='[]'::jsonb and (case when new.document->>'mode'='components'
    then d->>'kind'='combo' else length(btrim(new.document->>'note'))>=4 end),'Indica por qué no mueve inventario; solo un combo consume desde sus componentes.');
 end if;
 for l in select a from jsonb_array_elements(new.document->'lines')a loop
  perform app_private.muerdeme_menu_check_v1(jsonb_typeof(l)='object' and (select count(*)=3 from jsonb_object_keys(l))
   and l ?& array['inventoryItemId','quantity','ingredientKey'] and jsonb_typeof(l->'inventoryItemId')='number'
   and (l->>'inventoryItemId')~'^[1-9][0-9]*$' and jsonb_typeof(l->'quantity')='number'
   and (l->>'quantity')::numeric>0 and (l->>'quantity')::numeric<1000000000
   and round((l->>'quantity')::numeric,6)=(l->>'quantity')::numeric,'Selecciona un insumo y cantidad positiva de hasta seis decimales.');
  perform app_private.muerdeme_menu_check_v1(l->'ingredientKey'='null'::jsonb or (d->>'kind'='burger'
   and exists(select 1 from jsonb_array_elements(v->'burger'->'ingredients')a where a->>'key'=l->>'ingredientKey')),'El ingrediente no pertenece a esta presentación.');
  perform app_private.muerdeme_menu_check_v1(exists(select 1 from public.inventory_items i where i.id=(l->>'inventoryItemId')::bigint
   and i.is_active and i.merged_into_item_id is null and i.tracking_mode='transactional' and 'sale'=any(i.consumption_triggers)),
   'El insumo no está habilitado para consumo por venta. Revisa su configuración en inventario.');
 end loop;
 perform app_private.muerdeme_menu_check_v1((select count(*)=count(distinct (a->>'inventoryItemId',coalesce(a->>'ingredientKey','')))
   from jsonb_array_elements(new.document->'lines')a),'Ese insumo e ingrediente ya están relacionados.');
 return new;
end;
$f$;
create trigger muerdeme_inventory_recipe_guard before insert on app_private.muerdeme_inventory_recipe_revisions
 for each row execute function app_private.muerdeme_inventory_recipe_guard_v1();

create function public.admin_muerdeme_inventory_recipe_save_v1(p_entry_id uuid,p_variant_key text,p_menu_revision integer,p_expected_revision integer,p_document jsonb,p_operation_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $f$
declare saved app_private.muerdeme_inventory_recipe_revisions%rowtype;d jsonb;v jsonb;r integer;mr integer;
begin
 if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Requiere administración activa.' using errcode='42501';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Reintenta en una nueva consulta.' using errcode='25001';end if;
 perform app_private.muerdeme_menu_check_v1(p_operation_id is not null and p_expected_revision>=0 and p_menu_revision>0
  and p_variant_key is not null and length(p_variant_key)<=64,'Vuelve a consultar la presentación.');
 perform pg_advisory_xact_lock(hashtextextended('muerdeme-menu-drafts:v1',0));
 select * into saved from app_private.muerdeme_inventory_recipe_revisions where operation_id=p_operation_id;
 if found then
  perform app_private.muerdeme_menu_check_v1(saved.entry_id=p_entry_id and saved.variant_key=p_variant_key and saved.revision=p_expected_revision+1
   and saved.menu_revision=p_menu_revision and saved.document=p_document and saved.actor_id=(select auth.uid()),'La solicitud ya fue utilizada con otros datos.');
  return jsonb_build_object('revision',saved.revision);
 end if;
 select coalesce(max(revision),0) into r from app_private.muerdeme_inventory_recipe_revisions where entry_id=p_entry_id and variant_key=p_variant_key;
 if r is distinct from p_expected_revision then raise exception 'La receta cambió. Vuelve a consultar.' using errcode='40001';end if;
 select document,revision into d,mr from app_private.muerdeme_menu_revisions where entry_id=p_entry_id order by revision desc limit 1;
 if mr is distinct from p_menu_revision then raise exception 'El menú cambió. Vuelve a consultar.' using errcode='40001';end if;
 select a into v from jsonb_array_elements(d->'variants')a where a->>'key'=p_variant_key;
 insert into app_private.muerdeme_inventory_recipe_revisions(entry_id,variant_key,revision,menu_revision,signature,document,operation_id,actor_id)
 values(p_entry_id,p_variant_key,r+1,mr,app_private.muerdeme_inventory_signature_v1(d->>'kind',v),p_document,p_operation_id,(select auth.uid()));
 return jsonb_build_object('revision',r+1);
end;
$f$;

create function public.admin_muerdeme_inventory_recipe_read_v1(p_entry_id uuid,p_variant_key text default null,p_query text default '')
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare d jsonb;v jsonb;r integer;recipe jsonb;items jsonb;more boolean;
begin
 if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Requiere administración activa.' using errcode='42501';end if;
 perform app_private.muerdeme_menu_check_v1(p_query is not null and length(p_query)<=100,'Revisa la búsqueda de insumos.');
 select document,revision into d,r from app_private.muerdeme_menu_revisions where entry_id=p_entry_id order by revision desc limit 1;
 if d is null then raise exception 'No se encontró el producto.' using errcode='P0002';end if;
 p_variant_key:=coalesce(p_variant_key,d->'variants'->0->>'key');
 select a into v from jsonb_array_elements(d->'variants')a where a->>'key'=p_variant_key;
 if v is null then raise exception 'No se encontró la presentación.' using errcode='P0002';end if;
 select jsonb_build_object('revision',revision,'document',document,'updatedAt',created_at,'signatureMatches',signature=app_private.muerdeme_inventory_signature_v1(d->>'kind',v))
 into recipe from app_private.muerdeme_inventory_recipe_revisions where entry_id=p_entry_id and variant_key=p_variant_key order by revision desc limit 1;
 with candidates as(select i.*,exists(select 1 from jsonb_array_elements(coalesce(recipe->'document'->'lines','[]'::jsonb))a where(a->>'inventoryItemId')::bigint=i.id) selected
   from public.inventory_items i where (i.is_active and i.merged_into_item_id is null and i.tracking_mode='transactional' and 'sale'=any(i.consumption_triggers))
    or exists(select 1 from jsonb_array_elements(coalesce(recipe->'document'->'lines','[]'::jsonb))a where(a->>'inventoryItemId')::bigint=i.id)),
 bounded as(select *,row_number()over(order by selected desc,name,id)n from candidates where selected or btrim(p_query)=''
   or position(translate(lower(btrim(p_query)),'áéíóúüñ','aeiouun')in translate(lower(name),'áéíóúüñ','aeiouun'))>0 order by selected desc,name,id limit 201)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'unitName',unit_name,'currentStock',current_stock_units,
   'eligible',is_active and merged_into_item_id is null and tracking_mode='transactional' and 'sale'=any(consumption_triggers))order by n)filter(where n<=200),'[]'::jsonb),
   coalesce(bool_or(n=201),false)into items,more from bounded;
 return jsonb_build_object('entryId',p_entry_id,'menuRevision',r,'menu',d,'variantKey',p_variant_key,'recipe',recipe,'items',items,'hasMore',more);
end;
$f$;

create function app_private.muerdeme_inventory_consume_v1(p_graph jsonb,p_unit jsonb,p_qty numeric)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare x jsonb;e jsonb;v jsonb;rec app_private.muerdeme_inventory_recipe_revisions%rowtype;l jsonb;i record;
 lines jsonb:='[]';issues jsonb:='[]';revs jsonb:='{}';
begin
 x:=app_private.muerdeme_order_resolve_v1(p_graph,p_unit);e:=x->'entry';v:=x->'variant';
 select * into rec from app_private.muerdeme_inventory_recipe_revisions where entry_id=(e->>'entryId')::uuid and variant_key=v->>'key' order by revision desc limit 1;
 if not found and e->'document'->>'kind'='combo' then
   return jsonb_build_object('lines','[]'::jsonb,'issues','[]'::jsonb,'revisions',jsonb_build_object((e->>'entryId')||':'||(v->>'key'),0));
 end if;
 if rec.revision is null or rec.signature is distinct from app_private.muerdeme_inventory_signature_v1(e->'document'->>'kind',v) then
   return jsonb_build_object('lines','[]'::jsonb,'issues',jsonb_build_array('Revisar consumo: '||(x->>'label')||'.'),'revisions','{}'::jsonb);
 end if;
 revs:=jsonb_build_object((e->>'entryId')||':'||(v->>'key'),rec.revision);
 for l in select a from jsonb_array_elements(rec.document->'lines')a loop
   if l->>'ingredientKey' is not null and p_unit->'removed' ? (l->>'ingredientKey')then continue;end if;
   select * into i from public.inventory_items where id=(l->>'inventoryItemId')::bigint;
   if not found or not i.is_active or i.merged_into_item_id is not null or i.tracking_mode<>'transactional' or not coalesce('sale'=any(i.consumption_triggers),false)then
     issues:=issues||jsonb_build_array('El insumo de '||(e->'document'->>'name')||' ya no está habilitado para consumo por venta.');continue;
   end if;
   lines:=lines||jsonb_build_array(jsonb_build_object('inventoryItemId',i.id,'name',i.name,'unitName',i.unit_name,'quantity',(l->>'quantity')::numeric*p_qty));
 end loop;
 return jsonb_build_object('lines',lines,'issues',issues,'revisions',revs);
end;
$f$;
create function app_private.muerdeme_inventory_unit_v1(p_graph jsonb,p_unit jsonb,p_slot text,p_qty numeric default 1)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare x jsonb;e jsonb;v jsonb;result jsonb;child jsonb;ex jsonb;fr jsonb;k jsonb:='[]';removed jsonb;extras jsonb;
begin
 x:=app_private.muerdeme_order_resolve_v1(p_graph,p_unit);e:=x->'entry';v:=x->'variant';
 if e->'document'->>'kind'='fries' and p_unit->>'friesUpgrade' is not null then
   return app_private.muerdeme_inventory_unit_v1(p_graph,jsonb_set(jsonb_set(p_unit,'{variantKey}',p_unit->'friesUpgrade'),'{friesUpgrade}','null'),p_slot,p_qty);
 end if;
 result:=app_private.muerdeme_inventory_consume_v1(p_graph,p_unit,p_qty);
 select coalesce(jsonb_agg(a->>'label' order by ord),'[]'::jsonb) into removed
  from jsonb_array_elements(v->'burger'->'ingredients')with ordinality t(a,ord)where p_unit->'removed' ? (a->>'key');
 select coalesce(jsonb_agg((a->>'quantity')||' '||(app_private.muerdeme_order_resolve_v1(p_graph,a,'extra')->>'label')order by ord),'[]'::jsonb)into extras
  from jsonb_array_elements(p_unit->'extras')with ordinality t(a,ord);
 if e->'document'->>'kind' in('burger','fries','drink')then k:=jsonb_build_array(jsonb_build_object('kind',e->'document'->>'kind','label',x->>'label',
  'quantity',p_qty,'slot',p_slot,'removed',removed,'extras',extras));end if;
 for ex in select a from jsonb_array_elements(p_unit->'extras')a loop
  child:=app_private.muerdeme_inventory_consume_v1(p_graph,jsonb_build_object('entryId',ex->>'entryId','variantKey',ex->>'variantKey','removed','[]'::jsonb),p_qty*(ex->>'quantity')::numeric);
  result:=jsonb_build_object('lines',(result->'lines')||(child->'lines'),'issues',(result->'issues')||(child->'issues'),'revisions',(result->'revisions')||(child->'revisions'));
 end loop;
 fr:=v->'burger'->'includedFries';
 if fr is not null and fr<>'null'::jsonb then
  child:=app_private.muerdeme_inventory_unit_v1(p_graph,jsonb_build_object('entryId',fr->>'entryId','variantKey',coalesce(p_unit->>'friesUpgrade',fr->>'variantKey'),
    'removed','[]'::jsonb,'extras','[]'::jsonb,'friesUpgrade',null),case when p_slot=''then'Papas incluidas'else p_slot||' · Papas incluidas'end,p_qty*(fr->>'quantity')::numeric);
  result:=jsonb_build_object('lines',(result->'lines')||(child->'lines'),'issues',(result->'issues')||(child->'issues'),'revisions',(result->'revisions')||(child->'revisions'));k:=k||(child->'kitchen');
 end if;
 return result||jsonb_build_object('kitchen',k);
end;
$f$;
create function app_private.muerdeme_inventory_snapshot_v1(p_quote jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare g jsonb;root jsonb;s jsonb;group_doc jsonb;result jsonb;child jsonb;lines jsonb;issues jsonb;
begin
 g:=public.muerdeme_order_menu_graph_v1((p_quote->'selection'->>'entryId')::uuid);
 root:=app_private.muerdeme_order_resolve_v1(g,p_quote->'selection');
 if root->'entry'->'document'->>'kind'='combo'then
   result:=app_private.muerdeme_inventory_consume_v1(g,p_quote->'selection',1)||'{"kitchen":[]}'::jsonb;
   for s in select a from jsonb_array_elements(p_quote->'selection'->'slots')a loop
    select a into group_doc from jsonb_array_elements(root->'entry'->'document'->'comboGroups')a where a->>'key'=s->>'groupKey';
    child:=app_private.muerdeme_inventory_unit_v1(g,s,(group_doc->>'label')||' '||((s->>'position')::integer+1));
    result:=jsonb_build_object('lines',(result->'lines')||(child->'lines'),'issues',(result->'issues')||(child->'issues'),
      'revisions',(result->'revisions')||(child->'revisions'),'kitchen',(result->'kitchen')||(child->'kitchen'));
   end loop;
 else result:=app_private.muerdeme_inventory_unit_v1(g,p_quote->'selection','');end if;
 select coalesce(jsonb_agg(jsonb_build_object('inventoryItemId',id,'name',name,'unitName',unit,'quantity',quantity)order by id),'[]'::jsonb)into lines from(
  select (a->>'inventoryItemId')::bigint id,min(a->>'name')name,min(a->>'unitName')unit,round(sum((a->>'quantity')::numeric),6)quantity from jsonb_array_elements(result->'lines')a group by(a->>'inventoryItemId')::bigint)t;
 select coalesce(jsonb_agg(x order by x),'[]'::jsonb)into issues from(select distinct a x from jsonb_array_elements_text(result->'issues')a)t;
 if jsonb_array_length(lines)>300 or exists(select 1 from jsonb_array_elements(lines)a where(a->>'quantity')::numeric>=1000000000)then
  issues:=issues||'"El consumo supera el límite permitido."'::jsonb;
 end if;
 return jsonb_build_object('version',1,'entryId',p_quote->'selection'->>'entryId','productId',p_quote->'productId',
  'status',case when issues='[]'::jsonb then'ready'else'pending'end,'recipeRevisions',result->'revisions','issues',issues,
  'lines',case when issues='[]'::jsonb then lines else'[]'::jsonb end,'kitchen',result->'kitchen');
end;
$f$;
create function public.muerdeme_inventory_preview_v1(p_selection jsonb,p_revisions jsonb,p_order_id bigint default null,p_certificate_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare q jsonb;s jsonb;onhand jsonb;
begin
 q:=public.muerdeme_order_quote_v1(p_selection,p_revisions);
 if p_order_id is not null and p_certificate_id is not null then
  select snapshot into s from app_private.muerdeme_inventory_certificates where id=p_certificate_id and order_id=p_order_id and quote=q;
 end if;
 if s is null then s:=app_private.muerdeme_inventory_snapshot_v1(q);end if;
 select coalesce(jsonb_agg(jsonb_build_object('inventoryItemId',i.id,'currentStock',i.current_stock_units)order by i.id),'[]'::jsonb)into onhand
  from public.inventory_items i where exists(select 1 from jsonb_array_elements(s->'lines')a where(a->>'inventoryItemId')::bigint=i.id);
 return jsonb_build_object('snapshot',s,'onHand',onhand);
end;
$f$;

create function app_private.muerdeme_inventory_item_snapshot_v1()
returns trigger language plpgsql security invoker set search_path='' as $f$
declare q jsonb;s jsonb;requested uuid;marker text;certificate app_private.muerdeme_inventory_certificates%rowtype;
begin
 if position('@muerdeme|'in coalesce(new.notes,''))=0 then
   if position('@muerdeme-stock|'in coalesce(new.notes,''))>0 then raise exception 'El consumo Muérdeme no corresponde a este producto.'using errcode='22023';end if;
   return new;
 end if;
 select substring(a from 11)::jsonb into q from regexp_split_to_table(new.notes,E'\n')a where a like'@muerdeme|%';
 set constraints app_private.muerdeme_inventory_certificates_order_item_id_fkey deferred;
 select a into marker from regexp_split_to_table(new.notes,E'\n')a where a like'@muerdeme-stock|%';
 if marker is not null then requested:=nullif(substring(marker from 17)::jsonb->>'certificateId','')::uuid;end if;
 if requested is not null then
  select * into certificate from app_private.muerdeme_inventory_certificates where id=requested and order_id=new.order_id and quote=q
   and(order_item_id is null or order_item_id=new.id);
  if found then
   update app_private.muerdeme_inventory_certificates set order_item_id=new.id where id=certificate.id;
   new.notes:=regexp_replace(new.notes,E'(^|\n)@muerdeme-stock\\|[^\n]*','','g')||E'\n@muerdeme-stock|'||certificate.snapshot::text;return new;
  end if;
 end if;
 s:=app_private.muerdeme_inventory_snapshot_v1(q);
 perform app_private.muerdeme_menu_check_v1(s->>'status'='ready','Muérdeme requiere completar el consumo de sus presentaciones antes de guardar el pedido. Revisa Preparación e inventario.');
 update app_private.muerdeme_inventory_certificates set order_item_id=null where order_item_id=new.id;
 requested:=gen_random_uuid();s:=s||jsonb_build_object('certificateId',requested);
 insert into app_private.muerdeme_inventory_certificates(id,order_id,order_item_id,quote,snapshot)values(requested,new.order_id,new.id,q,s);
 new.notes:=regexp_replace(new.notes,E'(^|\n)@muerdeme-stock\\|[^\n]*','','g')||E'\n@muerdeme-stock|'||s::text;
 return new;
end;
$f$;
create trigger zzzz_muerdeme_inventory_snapshot before insert or update on public.order_items
 for each row execute function app_private.muerdeme_inventory_item_snapshot_v1();

-- Muérdeme adapters never also participate in the legacy physical product graph.
create function app_private.muerdeme_inventory_adapter_guard_v1()
returns trigger language plpgsql security invoker set search_path='' as $f$
begin
 if old.extra_fields->>'commercial_brand'='muerdeme' and
   (new.extra_fields->>'commercial_brand' is distinct from 'muerdeme' or new.inventory_policy is distinct from 'none'
     or new.inventory_enabled or new.is_inventory_item)then
  raise exception 'Configura el consumo de Muérdeme desde Preparación e inventario del catálogo.'using errcode='22023';
 end if;
 return new;
end;
$f$;
create trigger zzzz_muerdeme_inventory_adapter_guard before update on public.products
 for each row execute function app_private.muerdeme_inventory_adapter_guard_v1();

create function app_private.muerdeme_append_inventory_diagnostics_v1(p_order_id bigint,p_base jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare item record;s jsonb;marker text;parts jsonb:='[]';errors jsonb;lines jsonb;muids bigint[]:='{}';
begin
 -- VIVO returns the original diagnostics, without reading any recipe or stock history.
 if not exists(select 1 from public.order_items oi join public.products p on p.id=oi.product_id where oi.order_id=p_order_id and p.extra_fields->>'commercial_brand'='muerdeme')then return p_base;end if;
 errors:=coalesce(p_base->'errors','[]'::jsonb);
 for item in select oi.* from public.order_items oi join public.products p on p.id=oi.product_id where oi.order_id=p_order_id and p.extra_fields->>'commercial_brand'='muerdeme'loop
  muids:=array_append(muids,item.id);
  select a into marker from regexp_split_to_table(coalesce(item.notes,''),E'\n')a where a like'@muerdeme-stock|%';
  s:=case when marker is null then null else substring(marker from 17)::jsonb end;
  if s is null or s->>'status'<>'ready' or (s->>'productId')::bigint is distinct from item.product_id
    or not exists(select 1 from app_private.muerdeme_inventory_certificates c where c.order_item_id=item.id and c.order_id=p_order_id
      and c.id=(s->>'certificateId')::uuid and c.snapshot=s)then
   errors:=errors||jsonb_build_array(jsonb_build_object('code','muerdeme_consumption_pending','message','Falta el consumo certificado de Muérdeme.','order_item_id',item.id,'product_id',item.product_id));continue;
  end if;
  for marker in select a::text from jsonb_array_elements(s->'lines')a loop
   parts:=parts||jsonb_build_array(jsonb_build_object('inventory_item_id',(marker::jsonb->>'inventoryItemId')::bigint,
     'inventory_item_name',marker::jsonb->>'name','quantity_units',(marker::jsonb->>'quantity')::numeric,
     'sources',jsonb_build_array(jsonb_build_object('order_item_id',item.id,'root_product_id',item.product_id,'leaf_product_id',item.product_id,
       'quantity_units',(marker::jsonb->>'quantity')::numeric,'source','muerdeme_recipe'))));
  end loop;
 end loop;
 select coalesce(jsonb_agg(a),'[]'::jsonb)into errors from jsonb_array_elements(errors)a
  where not(a->>'code'='product_not_ready' and coalesce((a->>'order_item_id')::bigint=any(muids),false));
 with expanded as(select (a->>'inventory_item_id')::bigint id,a->>'inventory_item_name'name,(a->>'quantity_units')::numeric qty,a->'sources'sources
   from jsonb_array_elements(coalesce(p_base->'lines','[]'::jsonb)||parts)a),grouped as(select id,min(name)name,sum(qty)qty from expanded group by id)
 select coalesce(jsonb_agg(jsonb_build_object('inventory_item_id',g.id,'inventory_item_name',g.name,'quantity_units',g.qty,
  'sources',(select jsonb_agg(source)from expanded e cross join lateral jsonb_array_elements(e.sources)source where e.id=g.id))order by g.id),'[]'::jsonb)into lines from grouped g;
 return p_base||jsonb_build_object('errors',errors,'lines',lines);
end;
$f$;

-- Preserve the full legacy resolver, adding one final, brand-scoped merge.
do $install$
declare definition text;anchor text:=E'select jsonb_build_object(\n  ''order_id'', p_order_id,';ending text:=E')\nfrom error_payload, line_payload, selection_payload;';
 sample_ids bigint[];before_sample jsonb;after_sample jsonb;
begin
 definition:=pg_get_functiondef('app_private.inventory_order_sale_diagnostics_v1(bigint)'::regprocedure);
 if md5(definition)<>'39703329e57344c4bf06f4c7dc65235d'then raise exception 'El diagnóstico de inventario cambió. Revisa la integración antes de instalar.';end if;
 if position(anchor in definition)=0 or position(ending in definition)=0 then raise exception 'No se encontró el punto de integración de inventario.';end if;
 select array_agg(id)into sample_ids from(select distinct oi.order_id id from public.order_items oi
  where not exists(select 1 from public.order_items mi join public.products p on p.id=mi.product_id
    where mi.order_id=oi.order_id and p.extra_fields->>'commercial_brand'='muerdeme')order by id desc limit 12)t;
 select jsonb_object_agg(id::text,app_private.inventory_order_sale_diagnostics_v1(id)-'order_status')into before_sample from unnest(sample_ids)id;
 definition:=replace(definition,anchor,E'select app_private.muerdeme_append_inventory_diagnostics_v1(p_order_id,jsonb_build_object(\n  ''order_id'', p_order_id,');
 definition:=replace(definition,ending,E'))\nfrom error_payload, line_payload, selection_payload;');
 execute definition;
 select jsonb_object_agg(id::text,app_private.inventory_order_sale_diagnostics_v1(id)-'order_status')into after_sample from unnest(sample_ids)id;
 if before_sample is distinct from after_sample then raise exception 'La integración alteró el diagnóstico de VIVO. Instalación revertida.';end if;
end;
$install$;

-- Retain a requested certificate through the commercial guard. The later stock guard
-- validates its ownership and content against the immutable server-issued certificate.
do $install$
declare definition text;anchor text:=E'new.notes:=array_to_string(v_lines||array[''@muerdeme|''||v_canonical::text],E''\\n'');';
begin
 definition:=pg_get_functiondef('app_private.muerdeme_order_item_guard_v1()'::regprocedure);
 if position(anchor in definition)=0 then raise exception 'La validación Muérdeme cambió. Revisa su enlace con inventario.';end if;
 definition:=replace(definition,anchor,E'new.notes:=array_to_string(v_lines||array[''@muerdeme|''||v_canonical::text]||coalesce((select array_agg(a) from regexp_split_to_table(coalesce(new.notes,''''),E''\\n'')a where a like''@muerdeme-stock|%''),array[]::text[]),E''\\n'');');
 execute definition;
end;
$install$;

revoke all on function app_private.muerdeme_inventory_signature_v1(text,jsonb),app_private.muerdeme_inventory_recipe_guard_v1(),
 app_private.muerdeme_inventory_certificate_guard_v1(),app_private.muerdeme_inventory_adapter_guard_v1(),
 app_private.muerdeme_inventory_consume_v1(jsonb,jsonb,numeric),app_private.muerdeme_inventory_unit_v1(jsonb,jsonb,text,numeric),
 app_private.muerdeme_inventory_snapshot_v1(jsonb),app_private.muerdeme_inventory_item_snapshot_v1(),app_private.muerdeme_append_inventory_diagnostics_v1(bigint,jsonb),
 public.admin_muerdeme_inventory_recipe_save_v1(uuid,text,integer,integer,jsonb,uuid),public.admin_muerdeme_inventory_recipe_read_v1(uuid,text,text),
 public.muerdeme_inventory_preview_v1(jsonb,jsonb,bigint,uuid)from public,anon,authenticated,service_role;
grant execute on function app_private.muerdeme_inventory_signature_v1(text,jsonb),app_private.muerdeme_inventory_consume_v1(jsonb,jsonb,numeric),
 app_private.muerdeme_inventory_unit_v1(jsonb,jsonb,text,numeric),app_private.muerdeme_inventory_snapshot_v1(jsonb),
 public.admin_muerdeme_inventory_recipe_save_v1(uuid,text,integer,integer,jsonb,uuid),public.admin_muerdeme_inventory_recipe_read_v1(uuid,text,text),
 public.muerdeme_inventory_preview_v1(jsonb,jsonb,bigint,uuid)to authenticated;
-- The existing diagnostic is invoked through the existing role-checked inventory API, not a new endpoint.
comment on table app_private.muerdeme_inventory_recipe_revisions is 'Immutable quantity recipes by menu presentation; no prices, balances or sales activation.';
commit;
