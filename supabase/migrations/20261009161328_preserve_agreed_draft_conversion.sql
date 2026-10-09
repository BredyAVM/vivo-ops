-- Keep saved quotations as bounded, private evidence. Never grant a browser
-- flag, GUC or native currency alone permission to insert an old price.
begin;
set local lock_timeout='5s';

alter table public.order_items add column draft_price_agreement_key text;

create table app_private.advisor_draft_price_agreements_v1 (
  draft_id bigint not null references public.advisor_order_drafts(id) on delete cascade,
  line_key text not null,
  advisor_user_id uuid not null,
  client_id bigint,
  terms jsonb not null,
  captured_at timestamptz not null default statement_timestamp(),
  primary key(draft_id,line_key)
);
create table app_private.draft_conversion_price_context_v1 (
  order_id bigint not null,
  line_key text not null,
  transaction_id bigint not null,
  terms jsonb not null,
  applied_item_id bigint,
  primary key(order_id,line_key)
);
alter table app_private.advisor_draft_price_agreements_v1 enable row level security;
alter table app_private.draft_conversion_price_context_v1 enable row level security;
revoke all on app_private.advisor_draft_price_agreements_v1,
  app_private.draft_conversion_price_context_v1 from public,anon,authenticated,service_role;

create function app_private.draft_commercial_terms_v1(p_line jsonb,p_fx numeric)
returns jsonb language plpgsql immutable set search_path='' as $function$
declare
  product_id bigint;
  qty numeric;
  amount numeric;
  currency text;
  unit_usd numeric;
  line_usd numeric;
  unit_bs numeric;
  line_bs numeric;
begin
  product_id := (p_line->>'product_id')::bigint;
  qty := (p_line->>'qty')::numeric;
  amount := (p_line->>'source_price_amount')::numeric;
  currency := p_line->>'source_price_currency';
  if product_id is null or product_id<=0 or qty is null or qty<=0 or qty>9999
    or qty::text in ('NaN','Infinity','-Infinity') or amount is null or amount<0
    or amount::text in ('NaN','Infinity','-Infinity') or p_fx is null or p_fx<=0
    or p_fx::text in ('NaN','Infinity','-Infinity') or currency is null or currency not in ('USD','VES')
    or p_line->'crm_benefit' is not null and p_line->'crm_benefit'<>'null'::jsonb then
    return null;
  end if;
  if currency='VES' then
    unit_bs:=round(amount,2); line_bs:=round(unit_bs*qty,2);
    unit_usd:=round(unit_bs/p_fx,2); line_usd:=round(line_bs/p_fx,2);
  else
    unit_usd:=round(amount,2); line_usd:=round(unit_usd*qty,2);
    unit_bs:=round(unit_usd*p_fx,2); line_bs:=round(line_usd*p_fx,2);
  end if;
  if (p_line->>'unit_price_usd_snapshot')::numeric is distinct from unit_usd
    or (p_line->>'line_total_usd')::numeric is distinct from line_usd then return null; end if;
  return jsonb_build_object('product_id',product_id,'qty',qty,
    'pricing_origin_currency',currency,'pricing_origin_amount',amount,
    'unit_price_usd_snapshot',unit_usd,'line_total_usd',line_usd,
    'unit_price_bs_snapshot',unit_bs,'line_total_bs_snapshot',line_bs,
    'pricing_fx_rate_snapshot',p_fx);
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end;
$function$;
revoke all on function app_private.draft_commercial_terms_v1(jsonb,numeric) from public,anon;

-- New evidence is accepted only at the current native catalog price. Previously
-- captured evidence survives non-commercial saves, but cannot move to a client.
create function app_private.capture_draft_price_agreements_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
declare line jsonb; terms jsonb; previous app_private.advisor_draft_price_agreements_v1%rowtype;
  key text; fx numeric; catalog record;
begin
  if new.status not in ('draft','quoted') or jsonb_typeof(new.payload->'items') is distinct from 'array' then return new; end if;
  if jsonb_array_length(new.payload->'items')>200 then
    raise exception 'El presupuesto admite como máximo 200 ítems.' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(new.payload->'items') i
    where nullif(i->>'localId','') is not null group by i->>'localId' having count(*)>1) then
    raise exception 'Hay ítems duplicados en el presupuesto. Vuelve a abrirlo antes de guardar.' using errcode='22023'; end if;
  fx:=coalesce(new.fx_rate,nullif(new.payload->>'fxRate','')::numeric);
  delete from app_private.advisor_draft_price_agreements_v1 a where a.draft_id=new.id
    and (a.advisor_user_id is distinct from new.advisor_user_id
      or a.client_id is not null and a.client_id is distinct from new.client_id
      or not exists(select 1 from jsonb_array_elements(new.payload->'items') i where i->>'localId'=a.line_key));
  for line in select value from jsonb_array_elements(new.payload->'items') loop
    key:=nullif(line->>'localId','');
    if key is null or length(key)>200 then continue; end if;
    select * into previous from app_private.advisor_draft_price_agreements_v1
      where draft_id=new.id and line_key=key;
    if found then
      terms:=app_private.draft_commercial_terms_v1(line,(previous.terms->>'pricing_fx_rate_snapshot')::numeric);
      if terms=previous.terms then
        update app_private.advisor_draft_price_agreements_v1 set client_id=new.client_id
          where draft_id=new.id and line_key=key;
        continue;
      end if;
      delete from app_private.advisor_draft_price_agreements_v1 where draft_id=new.id and line_key=key;
    end if;
    terms:=app_private.draft_commercial_terms_v1(line,fx);
    if terms is null then continue; end if;
    select source_price_currency::text currency,source_price_amount amount,type::text kind
      into catalog from public.products where id=(terms->>'product_id')::bigint and is_active;
    if not found or catalog.kind='gambit' or catalog.currency<>terms->>'pricing_origin_currency'
      or catalog.amount is distinct from (terms->>'pricing_origin_amount')::numeric then continue; end if;
    if fx is distinct from (select rate_bs_per_usd from public.exchange_rates
      where is_active order by effective_at desc limit 1) then continue; end if;
    insert into app_private.advisor_draft_price_agreements_v1(draft_id,line_key,advisor_user_id,client_id,terms)
      values(new.id,key,new.advisor_user_id,new.client_id,terms);
  end loop;
  return new;
end;
$function$;
revoke all on function app_private.capture_draft_price_agreements_v1() from public,anon,authenticated,service_role;
create trigger draft_price_agreements_v1 after insert or update of payload,client_id,advisor_user_id,fx_rate
  on public.advisor_order_drafts for each row execute function app_private.capture_draft_price_agreements_v1();

-- Grandfather the bounded saved evidence explicitly requested by Administration.
-- No public draft/order/catalog/ledger row is changed by this capture.
insert into app_private.advisor_draft_price_agreements_v1(draft_id,line_key,advisor_user_id,client_id,terms)
select d.id,i->>'localId',d.advisor_user_id,d.client_id,
  app_private.draft_commercial_terms_v1(i,coalesce(d.fx_rate,nullif(d.payload->>'fxRate','')::numeric))
from public.advisor_order_drafts d cross join lateral jsonb_array_elements(d.payload->'items') i
join public.products p on p.id=(app_private.draft_commercial_terms_v1(i,coalesce(d.fx_rate,nullif(d.payload->>'fxRate','')::numeric))->>'product_id')::bigint
where d.status in ('draft','quoted') and p.type::text<>'gambit' and nullif(i->>'localId','') is not null
  and length(i->>'localId')<=200
  and app_private.draft_commercial_terms_v1(i,coalesce(d.fx_rate,nullif(d.payload->>'fxRate','')::numeric)) is not null;

create function app_private.reserve_draft_conversion_prices_v1(p_order bigint,p_draft bigint,p_items jsonb)
returns void language plpgsql security definer set search_path='' as $function$
declare line jsonb; agreement app_private.advisor_draft_price_agreements_v1%rowtype; parent public.orders%rowtype;
begin
  if auth.uid() is null or public.has_role('advisor') is not true then
    raise exception 'Asesor no autorizado.' using errcode='42501'; end if;
  select * into parent from public.orders where id=p_order and created_by_user_id=auth.uid()
    and attributed_advisor_id=auth.uid() and status::text='created';
  if not found or not exists(select 1 from public.advisor_order_drafts
    where id=p_draft and advisor_user_id=auth.uid() and status in ('draft','quoted')) then
    raise exception 'No se puede verificar este presupuesto.' using errcode='42501'; end if;
  if exists(select 1 from public.order_items where order_id=p_order) then
    raise exception 'La conversión requiere una orden nueva sin ítems.' using errcode='42501'; end if;
  perform 1 from public.advisor_order_drafts where id=p_draft and advisor_user_id=auth.uid()
    and status in ('draft','quoted') for update;
  if not found then raise exception 'Este presupuesto ya fue convertido.' using errcode='22023'; end if;
  delete from app_private.draft_conversion_price_context_v1 where order_id=p_order;
  for line in select value from jsonb_array_elements(p_items) loop
    select * into agreement from app_private.advisor_draft_price_agreements_v1
      where draft_id=p_draft and line_key=line->>'draft_price_agreement_key'
        and advisor_user_id=auth.uid();
    if not found then
      if exists(select 1 from public.advisor_order_drafts d,
        lateral jsonb_array_elements(d.payload->'items') i where d.id=p_draft
        and i->>'localId'=line->>'draft_price_agreement_key'
        and (i->'crm_benefit' is null or i->'crm_benefit'='null'::jsonb)) then
        raise exception 'No se pudieron verificar las condiciones guardadas de este ítem. Revisa el presupuesto antes de convertirlo.' using errcode='22023';
      end if;
      continue;
    end if;
    if agreement.client_id is not null and agreement.client_id is distinct from parent.client_id then
      raise exception 'El presupuesto pertenece a otro cliente. Crea uno nuevo para este cliente.' using errcode='42501'; end if;
    if nullif(parent.extra_fields#>>'{pricing,fx_rate}','')::numeric
      is distinct from (agreement.terms->>'pricing_fx_rate_snapshot')::numeric then
      raise exception 'La conversión debe conservar la tasa acordada del presupuesto.' using errcode='22023'; end if;
    if exists(select 1 from jsonb_each(agreement.terms) term
      where term.key<>'pricing_fx_rate_snapshot' and line->term.key is distinct from term.value)
      or line->>'crm_play_member_id' is not null or line->>'crm_play_benefit_id' is not null
      or line->>'crm_play_benefit_upgrade_id' is not null then
      raise exception 'El ítem del presupuesto cambió. Conserva la cantidad acordada y agrega lo nuevo por separado.' using errcode='22023';
    end if;
    insert into app_private.draft_conversion_price_context_v1(order_id,line_key,transaction_id,terms)
      values(p_order,agreement.line_key,txid_current(),agreement.terms);
  end loop;
  update public.advisor_order_drafts set status='converted',converted_order_id=p_order,
    converted_at=statement_timestamp() where id=p_draft and advisor_user_id=auth.uid();
end;
$function$;
revoke all on function app_private.reserve_draft_conversion_prices_v1(bigint,bigint,jsonb) from public,anon,service_role;
grant execute on function app_private.reserve_draft_conversion_prices_v1(bigint,bigint,jsonb) to authenticated;

create function app_private.apply_agreed_draft_item_v1(p_item public.order_items)
returns public.order_items language plpgsql security definer set search_path='' as $function$
declare context app_private.draft_conversion_price_context_v1%rowtype; result public.order_items%rowtype;
begin
  if auth.uid() is null or public.has_role('advisor') is not true or p_item.draft_price_agreement_key is null then return null; end if;
  select c.* into context from app_private.draft_conversion_price_context_v1 c
    join public.orders o on o.id=c.order_id where c.order_id=p_item.order_id
    and c.line_key=p_item.draft_price_agreement_key and c.transaction_id=txid_current()
    and o.created_by_user_id=auth.uid() and o.attributed_advisor_id=auth.uid() and o.status::text='created'
    for update of c;
  if not found then return null; end if;
  if context.applied_item_id is not null and context.applied_item_id<>p_item.id
    or p_item.product_id is distinct from (context.terms->>'product_id')::bigint
    or p_item.qty is distinct from (context.terms->>'qty')::numeric
    or p_item.override_unit_price_usd is not null or p_item.admin_price_override_usd is not null
    or p_item.override_reason is not null or p_item.override_approved_by is not null or p_item.override_approved_at is not null
    or p_item.admin_price_override_reason is not null or p_item.admin_price_override_by_user_id is not null or p_item.admin_price_override_at is not null
    or p_item.crm_play_member_id is not null or p_item.crm_play_benefit_id is not null
    or p_item.crm_play_benefit_upgrade_id is not null then
    raise exception 'La evidencia del presupuesto no corresponde a este ítem.' using errcode='42501'; end if;
  result:=jsonb_populate_record(p_item,context.terms);
  select name,sku into result.product_name_snapshot,result.sku_snapshot from public.products where id=result.product_id;
  update app_private.draft_conversion_price_context_v1 set applied_item_id=result.id
    where order_id=result.order_id and line_key=result.draft_price_agreement_key;
  return result;
end;
$function$;
revoke all on function app_private.apply_agreed_draft_item_v1(public.order_items) from public,anon,service_role;
grant execute on function app_private.apply_agreed_draft_item_v1(public.order_items) to authenticated;

create function app_private.finish_draft_conversion_prices_v1(p_order bigint)
returns void language plpgsql security definer set search_path='' as $function$
begin
  if auth.uid() is null or not exists(select 1 from public.orders where id=p_order
    and created_by_user_id=auth.uid() and attributed_advisor_id=auth.uid()) then
    raise exception 'Asesor no autorizado.' using errcode='42501'; end if;
  delete from app_private.draft_conversion_price_context_v1 where order_id=p_order and transaction_id=txid_current();
end;
$function$;
revoke all on function app_private.finish_draft_conversion_prices_v1(bigint) from public,anon,service_role;
grant execute on function app_private.finish_draft_conversion_prices_v1(bigint) to authenticated;

do $migration$
declare definition text; name text; anchor text; prefix text := $prefix$
  if tg_op='INSERT' and new.draft_price_agreement_key is not null then
    declare agreed public.order_items%rowtype;
    begin
      agreed:=app_private.apply_agreed_draft_item_v1(new);
      if agreed.id is not null then return agreed; end if;
    end;
  end if;
$prefix$;
begin
  foreach name in array array['trg_order_items_guard','trg_order_items_pricing_guard','trg_order_items_set_pricing'] loop
    definition:=replace(pg_get_functiondef(('public.'||name||'()')::regprocedure),chr(13),'');
    if position(E'begin\n' in definition)=0 or position('apply_agreed_draft_item_v1' in definition)>0 then
      raise exception 'Draft guard anchor changed: %',name; end if;
    execute replace(definition,E'begin\n',E'begin\n'||prefix);
  end loop;
  definition:=replace(pg_get_functiondef('public.advisor_create_order_atomic_v1(uuid,bigint,public.fulfillment_type,numeric,numeric,text,text,text,text,jsonb,jsonb,bigint)'::regprocedure),chr(13),'');
  anchor:='  insert into public.order_items (';
  if position(anchor in definition)=0 or position('reserve_draft_conversion_prices_v1' in definition)>0 then raise exception 'Draft conversion anchor changed'; end if;
  definition:=replace(definition,anchor,E'  if p_draft_id is not null then\n    perform app_private.reserve_draft_conversion_prices_v1(v_order_id,p_draft_id,p_items);\n  end if;\n\n'||anchor);
  definition:=replace(definition,'    crm_play_benefit_upgrade_id'||E'\n  )','    crm_play_benefit_upgrade_id,'||E'\n    draft_price_agreement_key\n  )');
  definition:=replace(definition,'    input.crm_play_benefit_upgrade_id'||E'\n  from','    input.crm_play_benefit_upgrade_id,'||E'\n    input.draft_price_agreement_key\n  from');
  definition:=replace(definition,'    crm_play_benefit_upgrade_id bigint'||E'\n  );','    crm_play_benefit_upgrade_id bigint,'||E'\n    draft_price_agreement_key text\n  );');
  definition:=replace(definition,'  get diagnostics v_inserted_items = row_count;',E'  get diagnostics v_inserted_items = row_count;\n  if p_draft_id is not null then\n    perform app_private.finish_draft_conversion_prices_v1(v_order_id);\n  end if;');
  execute definition;
end;
$migration$;
commit;
