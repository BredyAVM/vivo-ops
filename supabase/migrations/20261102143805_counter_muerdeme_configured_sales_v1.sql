-- Counter uses the existing sellable menu, recipe certificates and stock ledger.
-- Does not activate Muérdeme, change VIVO products or alter financial histories.
create or replace function app_private.muerdeme_order_reader_v1()
returns boolean language sql stable security invoker set search_path='' as $f$
  select (select auth.uid()) is not null
    and exists(select 1 from public.profiles where id=(select auth.uid()) and is_active)
    and (public.has_role('admin') or public.has_role('master') or public.has_role('advisor') or public.has_role('counter'));
$f$;

-- Private invoker helper, called only by the existing authorized Counter writer.
-- VIVO returns immediately, without a menu/recipe query.
create function app_private.counter_muerdeme_item_v1(p_item jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $f$
declare details jsonb;marker text;markers integer;provided jsonb;q jsonb;preview jsonb;
begin
  details:=coalesce(p_item->'editableDetailLines','[]'::jsonb);
  if jsonb_typeof(details)<>'array' then return null;end if;
  if not exists(select 1 from jsonb_array_elements_text(details)a where position('@muerdeme|'in a)>0) then return null;end if;
  if app_private.muerdeme_order_reader_v1() is not true then
    raise exception 'Requiere un usuario de ventas activo.'using errcode='42501';
  end if;
  perform app_private.muerdeme_menu_check_v1(
    (select sales_enabled from app_private.commercial_brands where code='muerdeme'),
    'Muérdeme está en preparación. Retira sus productos para guardar solo VIVO; la apertura comercial sigue pendiente.');
  select count(*),min(a)into markers,marker from jsonb_array_elements_text(details)a where a like '@muerdeme|%';
  perform app_private.muerdeme_menu_check_v1(markers=1 and length(marker)<=45000 and (p_item->>'qty')::numeric=1,
    'Cada hamburguesa o combo conserva su configuración individual. Usa cantidad 1.');
  begin provided:=substring(marker from 11)::jsonb;
  exception when invalid_text_representation then
    raise exception 'Vuelve a configurar el producto Muérdeme.'using errcode='22023';end;
  q:=public.muerdeme_order_quote_v1(provided->'selection',provided->'revisions');
  perform app_private.muerdeme_menu_check_v1(q=provided and (q->>'productId')::bigint=(p_item->>'productId')::bigint
    and exists(select 1 from app_private.muerdeme_menu_order_products l where l.product_id=(p_item->>'productId')::bigint
      and l.entry_id=(q->'selection'->>'entryId')::uuid),
    'El precio o la configuración cambió. Vuelve a consultar Muérdeme.');
  preview:=public.muerdeme_inventory_preview_v1(q->'selection',q->'revisions',null,null);
  perform app_private.muerdeme_menu_check_v1(preview#>>'{snapshot,status}'='ready',
    'Falta completar la preparación e inventario de Muérdeme.');
  return q;
end;
$f$;
revoke all on function app_private.counter_muerdeme_item_v1(jsonb)from public,anon,authenticated,service_role;

do $patch$
declare body text;original text;
begin
  original:=replace(pg_get_functiondef('public.counter_create_direct_sale_without_commercial_guard_v1(uuid,jsonb)'::regprocedure),E'\r\n',E'\n');
  body:=replace(original,'  v_item_notes text;',E'  v_item_notes text;\n  v_menu_quote jsonb;\n  v_menu_quotes jsonb := ''[]'';\n  v_menu_item_index integer := 0;');
  if body=original then raise exception 'Counter item declaration changed';end if;
  original:=body;
  body:=replace(body,'  v_client_name := nullif(trim(p_payload->>''clientName''), '''');',
    E'  if p_payload->''items'' is null or jsonb_typeof(p_payload->''items'')<>''array'' then raise exception ''counter_items_required'';end if;\n  if jsonb_array_length(p_payload->''items'')not between 1 and 100 then raise exception ''counter_items_count_invalid'';end if;\n  for v_item in select value from jsonb_array_elements(p_payload->''items'')loop\n    v_menu_quotes:=v_menu_quotes||jsonb_build_array(app_private.counter_muerdeme_item_v1(v_item));\n  end loop;\n  v_client_name := nullif(trim(p_payload->>''clientName''), '''');');
  if body=original then raise exception 'Counter pre-client validation anchor changed';end if;
  original:=body;
  body:=replace(body,E'      v_qty := (v_item->>''qty'')::numeric;\n      select *',
    E'      v_qty := (v_item->>''qty'')::numeric;\n      v_menu_quote := nullif(v_menu_quotes->v_menu_item_index,''null''::jsonb);\n      v_menu_item_index := v_menu_item_index+1;\n      select *');
  if body=original then raise exception 'Counter configured item anchor changed';end if;
  original:=body;
  body:=replace(body,E'      where id = (v_item->>''productId'')::bigint\n        and is_active = true;',
    E'      where id = (v_item->>''productId'')::bigint\n        and (is_active = true or v_menu_quote is not null);');
  if body=original then raise exception 'Counter product lookup changed';end if;
  original:=body;
  body:=replace(body,E'    v_item_notes := public.counter_direct_sale_item_notes(\n      v_product.id,\n      v_qty,\n      v_item->>''notes'',\n      coalesce(v_item->''editableDetailLines'', ''[]''::jsonb)\n    );',
    E'    if v_menu_quote is not null then\n      select string_agg(a,E''\\n'') into v_item_notes from jsonb_array_elements_text(v_menu_quote->''detailLines'')a;\n      v_item_notes := concat_ws(E''\\n'',v_item_notes,''@muerdeme|''||v_menu_quote::text);\n    else\n      v_item_notes := public.counter_direct_sale_item_notes(v_product.id,v_qty,v_item->>''notes'',coalesce(v_item->''editableDetailLines'',''[]''::jsonb));\n    end if;');
  if body=original then raise exception 'Counter notes anchor changed';end if;
  original:=body;
  body:=replace(body,E'      v_product.source_price_currency::text,\n      v_product.source_price_amount\n    );',
    E'      v_product.source_price_currency::text,\n      case when v_menu_quote is null then v_product.source_price_amount else (v_menu_quote->>''unitUsd'')::numeric end\n    );');
  if body=original then raise exception 'Counter source amount anchor changed';end if;
  execute body;

  -- The later existing Muérdeme guard validates and writes the certified price.
  -- Never reset it to the inactive adapter's placeholder zero in Counter pricing.
  original:=replace(pg_get_functiondef('public.trg_order_items_set_pricing()'::regprocedure),E'\r\n',E'\n');
  body:=replace(original,'if v_is_counter_direct_sale then',
    'if v_is_counter_direct_sale and position(''@muerdeme|''in coalesce(new.notes,''''))=0 then');
  if body=original then raise exception 'Counter pricing anchor changed';end if;
  execute body;

  -- Included shared VIVO drinks retain Master's commercial suspension checks.
  original:=replace(pg_get_functiondef('public.counter_create_direct_sale(uuid,jsonb)'::regprocedure),E'\r\n',E'\n');
  body:=replace(original,E'  ) candidate;',E'    union\n    select substring(slot->>''entryId''from 6)::bigint\n    from public.order_items item\n    cross join lateral regexp_split_to_table(coalesce(item.notes,''''),E''\\n'')line\n    cross join lateral jsonb_array_elements(case when line like ''@muerdeme|%'' then (substring(line from 11)::jsonb)->''selection''->''slots'' else ''[]''::jsonb end)slot\n    where item.order_id=v_order_id and slot->>''entryId''~''^vivo:[1-9][0-9]*$''\n  ) candidate;');
  if body=original then raise exception 'Counter shared product suspension anchor changed';end if;
  execute body;
end;
$patch$;
