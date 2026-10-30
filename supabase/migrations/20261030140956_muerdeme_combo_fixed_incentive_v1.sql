-- A combo may replace its usual order incentive with a fixed USD amount.
-- The greatest applicable amount wins once, using certified historical menu revisions.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $patch$
declare definition text;anchor text;
begin
 definition:=pg_get_functiondef('app_private.muerdeme_menu_validate_v1(jsonb,uuid)'::regprocedure);
 anchor:=$a$and p_doc-array['schemaVersion','kind','name','archived','variants','comboGroups','friesUpgrades']='{}'::jsonb$a$;
 if position(anchor in definition)=0 then raise exception 'No se encontró la validación del catálogo esperada.';end if;
 definition:=replace(definition,anchor,$a$and p_doc-array['schemaVersion','kind','name','archived','variants','comboGroups','friesUpgrades','comboIncentiveUsd']='{}'::jsonb$a$);
 anchor:=$a$  for v in select value from jsonb_array_elements(p_doc->'variants') loop$a$;
 if position(anchor in definition)=0 then raise exception 'No se encontró la validación de presentaciones esperada.';end if;
 definition:=replace(definition,anchor,$a$  if p_doc ? 'comboIncentiveUsd' then
    perform app_private.muerdeme_menu_check_v1(p_doc->>'kind'='combo'
      and app_private.muerdeme_menu_price_v1(p_doc->'comboIncentiveUsd',true),
      'Solo los combos admiten un estímulo fijo en USD, con hasta dos decimales; cero significa sin estímulo.');
  end if;
  for v in select value from jsonb_array_elements(p_doc->'variants') loop$a$);
 execute definition;
end;
$patch$;

create function app_private.muerdeme_order_incentive_amount_v1(p_order bigint,p_default numeric)
returns jsonb language sql stable security invoker set search_path='' as $f$
 with candidates as (
  select r.entry_id,r.revision,r.document,
   case when r.document->>'kind'='combo' then (r.document->>'comboIncentiveUsd')::numeric end as special
  from app_private.muerdeme_inventory_certificates c
  join public.order_items i on i.id=c.order_item_id and i.order_id=c.order_id
  join app_private.muerdeme_menu_revisions r
   on r.entry_id=(c.quote#>>'{selection,entryId}')::uuid
   and r.revision=(c.quote->'revisions'->>(c.quote#>>'{selection,entryId}'))::integer
  where c.order_id=p_order and i.qty>0 and c.snapshot->>'status'='ready'
   and exists(select 1 from jsonb_array_elements(c.snapshot->'kitchen')u
    where u->>'kind'='burger'and(u->>'quantity')::numeric>0)
 )
 select coalesce((select jsonb_build_object('amountUsd',coalesce(special,p_default))
  ||case when special is not null then jsonb_build_object('fixedCombo',jsonb_build_object(
   'entryId',entry_id,'revision',revision,'name',document->>'name','amountUsd',special))else '{}'::jsonb end
  from candidates order by coalesce(special,p_default) desc,(special is not null),entry_id,revision limit 1),
  jsonb_build_object('amountUsd',p_default));
$f$;
revoke all on function app_private.muerdeme_order_incentive_amount_v1(bigint,numeric) from public,anon,authenticated,service_role;
grant execute on function app_private.muerdeme_order_incentive_amount_v1(bigint,numeric) to authenticated;

do $patch$
declare definition text;anchor text;
begin
 definition:=pg_get_functiondef('app_private.muerdeme_incentive_state_v1(bigint)'::regprocedure);
 anchor:='status text;kind text;amount numeric;';
 if position(anchor in definition)=0 then raise exception 'No se encontró la declaración de estímulos esperada.';end if;
 definition:=replace(definition,anchor,'status text;kind text;amount numeric;decision jsonb;');
 anchor:=$a$ amount:=case when kind='first'then terms.first_order_usd else terms.recurrent_order_usd end;$a$;
 if position(anchor in definition)=0 then raise exception 'No se encontró el cálculo de estímulos esperado.';end if;
 definition:=replace(definition,anchor,$a$ decision:=app_private.muerdeme_order_incentive_amount_v1(p_order,
   case when kind='first'then terms.first_order_usd else terms.recurrent_order_usd end);
 amount:=(decision->>'amountUsd')::numeric;$a$);
 anchor:=$a$'deliveryDate',app_private.muerdeme_incentive_delivery_date_v1(o.extra_fields,o.created_at));$a$;
 if position(anchor in definition)=0 then raise exception 'No se encontró el resultado de estímulos esperado.';end if;
 definition:=replace(definition,anchor,$a$'deliveryDate',app_private.muerdeme_incentive_delivery_date_v1(o.extra_fields,o.created_at))
  ||case when decision?'fixedCombo'then jsonb_build_object('fixedCombo',decision->'fixedCombo')else '{}'::jsonb end;$a$);
 execute definition;
end;
$patch$;
commit;
