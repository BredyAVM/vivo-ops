-- Versioned catalogue maintenance. Does not activate sales or rewrite orders.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table app_private.muerdeme_menu_revisions add column change_note text
  check(change_note is null or length(change_note)between 1 and 300);

do $patch$
declare d text;anchor text;
begin
  d:=pg_get_functiondef('app_private.muerdeme_menu_revision_guard_v1()'::regprocedure);
  anchor:=$a$perform app_private.muerdeme_menu_check_v1(exists(select 1 from app_private.commercial_brands where code='muerdeme' and not sales_enabled),'El menú ya está en operación. Utiliza su configuración comercial vigente.');$a$;
  if position(anchor in d)=0 then raise exception 'Menu revision preparation guard changed';end if;
  d:=replace(d,anchor,'');
  anchor:='  return new;';
  if position(anchor in d)=0 then raise exception 'Menu revision return changed';end if;
  d:=replace(d,anchor,$a$  new.change_note:=coalesce(nullif(btrim(new.change_note),''),case when new.revision=1 then 'Carga inicial' else 'Actualización del catálogo' end);
  return new;$a$);
  execute d;

  -- The shared-drinks editor keeps its bounded lookups and passes this flag on.
  d:=pg_get_functiondef('app_private.muerdeme_menu_editor_base_v1(uuid,text,text)'::regprocedure);
  anchor:=$a$'lookupHasMore',has_more);$a$;
  if position(anchor in d)=0 then raise exception 'Menu editor result changed';end if;
  execute replace(d,anchor,$a$'lookupHasMore',has_more,'salesEnabled',(select sales_enabled from app_private.commercial_brands where code='muerdeme'));$a$);
  d:=pg_get_functiondef('public.admin_muerdeme_menu_list_v1(text,text,integer,boolean)'::regprocedure);
  anchor:=$a$'hasNext',has_next,'page',p_page);$a$;
  if position(anchor in d)=0 then raise exception 'Menu list result changed';end if;
  execute replace(d,anchor,$a$'hasNext',has_next,'page',p_page,'salesEnabled',(select sales_enabled from app_private.commercial_brands where code='muerdeme'));$a$);
end;
$patch$;

create function public.admin_muerdeme_menu_save_v2(p_entry_id uuid,p_expected_revision integer,p_document jsonb,p_operation_id uuid,p_change_note text)
returns jsonb language plpgsql security invoker set search_path='' as $f$
declare saved app_private.muerdeme_menu_revisions%rowtype;entry uuid;current_revision integer;kind text;note text;
begin
  if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Esta operación requiere un administrador activo.'using errcode='42501';end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Reintenta el guardado en una nueva consulta.'using errcode='25001';end if;
  perform app_private.muerdeme_menu_check_v1(p_operation_id is not null and p_expected_revision is not null
    and((p_entry_id is null and p_expected_revision=0)or(p_entry_id is not null and p_expected_revision>0)), 'Vuelve a consultar el producto antes de guardar.');
  note:=coalesce(nullif(btrim(p_change_note),''),case when p_expected_revision=0 then 'Carga inicial' else 'Actualización del catálogo' end);
  perform app_private.muerdeme_menu_check_v1(length(note)<=300,'La nota del cambio admite hasta 300 caracteres.');
  perform pg_advisory_xact_lock(hashtextextended('muerdeme-menu-drafts:v1',0));
  if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Esta operación requiere un administrador activo.'using errcode='42501';end if;
  select * into saved from app_private.muerdeme_menu_revisions where operation_id=p_operation_id;
  if found then
    perform app_private.muerdeme_menu_check_v1(saved.actor_id=(select auth.uid())and saved.document=p_document
      and saved.revision=p_expected_revision+1 and((p_entry_id is null and saved.revision=1)or p_entry_id=saved.entry_id)
      and coalesce(saved.change_note,case when saved.revision=1 then 'Carga inicial' else 'Actualización del catálogo' end)=note,'La solicitud ya fue utilizada con otros datos.');
    return jsonb_build_object('entryId',saved.entry_id,'revision',saved.revision);
  end if;
  if p_entry_id is null then
    entry:=gen_random_uuid();
    perform app_private.muerdeme_menu_validate_v1(p_document,entry);
    insert into app_private.muerdeme_menu_entries(id,kind,created_by)values(entry,p_document->>'kind',(select auth.uid()));
  else
    entry:=p_entry_id;
    select e.kind into kind from app_private.muerdeme_menu_entries e where e.id=entry;
    perform app_private.muerdeme_menu_check_v1(kind is not null,'No se encontró el producto solicitado.');
    select coalesce(max(revision),0)into current_revision from app_private.muerdeme_menu_revisions where entry_id=entry;
    if current_revision<>p_expected_revision then raise exception 'El producto cambió. Vuelve a consultarlo antes de guardar.'using errcode='40001';end if;
  end if;
  insert into app_private.muerdeme_menu_revisions(entry_id,revision,document,operation_id,actor_id,change_note)
    values(entry,p_expected_revision+1,p_document,p_operation_id,(select auth.uid()),note);
  return jsonb_build_object('entryId',entry,'revision',p_expected_revision+1);
end;
$f$;

-- Older clients keep the same command and automatic note, including exact retries.
create or replace function public.admin_muerdeme_menu_save_v1(p_entry_id uuid,p_expected_revision integer,p_document jsonb,p_operation_id uuid)
returns jsonb language sql security invoker set search_path='' as $f$
  select public.admin_muerdeme_menu_save_v2(p_entry_id,p_expected_revision,p_document,p_operation_id,null);
$f$;

create function app_private.muerdeme_menu_changes_v1(p_before jsonb,p_after jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $f$
  with variants as(
    select coalesce(a->>'key',b->>'key')key,a,b from jsonb_array_elements(coalesce(p_before->'variants','[]'::jsonb))a
    full join jsonb_array_elements(p_after->'variants')b on a->>'key'=b->>'key'
  ), labels as(
    select array_remove(array[
      case when p_before is null then 'Carga inicial' end,
      case when p_before is not null and p_before->'name' is distinct from p_after->'name' then 'Nombre' end,
      case when p_before is not null and p_before->'archived' is distinct from p_after->'archived' then 'Estado' end,
      case when exists(select 1 from variants where a is null or b is null or a->'label' is distinct from b->'label')then 'Presentaciones' end,
      case when exists(select 1 from variants where a->'priceUsd' is distinct from b->'priceUsd')then 'Precios USD' end,
      case when exists(select 1 from variants where a->'burger' is distinct from b->'burger')then 'Configuración de hamburguesas' end,
      case when coalesce(p_before->'comboGroups','[]'::jsonb) is distinct from p_after->'comboGroups' then 'Composición y suplementos del combo' end,
      case when coalesce(p_before->'friesUpgrades','[]'::jsonb) is distinct from p_after->'friesUpgrades' then 'Ampliaciones de papas' end,
      case when coalesce(p_before->'comboIncentiveUsd','null'::jsonb) is distinct from coalesce(p_after->'comboIncentiveUsd','null'::jsonb)then 'Estímulo fijo USD' end
    ],null)as changes
  )
  select jsonb_build_object('labels',to_jsonb(changes),
    'prices',(select coalesce(jsonb_agg(jsonb_build_object('key',key,'label',coalesce(b->>'label',a->>'label'),
      'before',a->'priceUsd','after',b->'priceUsd','added',a is null,'removed',b is null)order by key),'[]'::jsonb)
      from variants where a is null or b is null or a->'priceUsd' is distinct from b->'priceUsd'),
    'recipeReview',(select coalesce(jsonb_agg(b->>'label'order by key),'[]'::jsonb)from variants where b is not null
      and p_after->>'kind'<>'combo'and(a is null or app_private.muerdeme_inventory_signature_v1(p_after->>'kind',a)
        is distinct from app_private.muerdeme_inventory_signature_v1(p_after->>'kind',b))))from labels;
$f$;

create function public.admin_muerdeme_menu_history_v1(p_entry_id uuid,p_page integer default 1)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare rows jsonb;more boolean;name text;
begin
  if app_private.commercial_foundation_is_admin_v1() is not true then raise exception 'Esta operación requiere un administrador activo.'using errcode='42501';end if;
  perform app_private.muerdeme_menu_check_v1(p_entry_id is not null and p_page between 1 and 10000,'Revisa el producto y la página del historial.');
  select document->>'name'into name from app_private.muerdeme_menu_revisions where entry_id=p_entry_id order by revision desc limit 1;
  if name is null then raise exception 'No se encontró el producto solicitado.'using errcode='P0002';end if;
  with selected as(
    select * from app_private.muerdeme_menu_revisions where entry_id=p_entry_id order by revision desc limit 26 offset(p_page-1)*25
  ), numbered as(select *,row_number()over(order by revision desc)n from selected)
  select coalesce(jsonb_agg(jsonb_build_object('revision',r.revision,'name',r.document->>'name',
    'actor',coalesce(nullif(to_jsonb(p)->>'full_name',''),'Administrador'),'note',r.change_note,
    'createdAt',r.created_at,'changes',app_private.muerdeme_menu_changes_v1(previous.document,r.document))order by r.revision desc)
    filter(where r.n<=25),'[]'::jsonb),coalesce(bool_or(r.n=26),false)into rows,more
  from numbered r left join app_private.muerdeme_menu_revisions previous on previous.entry_id=r.entry_id and previous.revision=r.revision-1
  left join public.profiles p on p.id=r.actor_id;
  return jsonb_build_object('entryId',p_entry_id,'name',name,'rows',rows,'page',p_page,'hasNext',more);
end;
$f$;

revoke all on function public.admin_muerdeme_menu_save_v2(uuid,integer,jsonb,uuid,text),
  app_private.muerdeme_menu_changes_v1(jsonb,jsonb),public.admin_muerdeme_menu_history_v1(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_muerdeme_menu_save_v2(uuid,integer,jsonb,uuid,text),
  app_private.muerdeme_menu_changes_v1(jsonb,jsonb),public.admin_muerdeme_menu_history_v1(uuid,integer)to authenticated;
comment on table app_private.muerdeme_menu_revisions is 'Append-only commercial catalogue versions. New quotes use latest; saved orders and certificates retain their versions. Sales activation is separate.';
commit;
