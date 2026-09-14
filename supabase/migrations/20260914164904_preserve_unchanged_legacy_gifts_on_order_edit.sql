-- Preserve already-existing, unchanged legacy campaign lines during an order edit.
-- No orders are repaired or rescheduled here; no CRM membership is manufactured.
-- New or changed campaign lines still pass the existing CRM authorization trigger.
set local lock_timeout = '5s';

do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.update_order_core_atomic_v1(bigint,timestamptz,jsonb,jsonb)'::regprocedure
  );
  old_block text;
  new_block text;
begin
  if position('v_preserved_legacy_ids' in definition) > 0 then
    raise exception 'Legacy preservation is already installed; inspect before replacing it.';
  end if;
  old_block := '  v_item_ids jsonb := ''[]''::jsonb;';
  if position(old_block in definition) = 0 then raise exception 'Atomic editor declaration changed'; end if;
  definition := replace(definition, old_block,
    old_block || E'\n  v_preserved_legacy_ids bigint[] := array[]::bigint[];');

  old_block := $old$  -- Ordinary rows are rebuilt inside this transaction. If any later validation
  -- fails, PostgreSQL rolls the complete header and item set back together.
  delete from public.order_items item
  where item.order_id = p_order_id
    and item.crm_play_member_id is null;$old$;
  new_block := $new$  -- A date/address edit is not a new gift grant. Retain only exact existing
  -- legacy lines for the same order, client, advisor and source. Never trust a
  -- browser flag, product name or a copied line as proof of gift entitlement.
  perform item.id from public.order_items item
  where item.order_id = p_order_id order by item.id for update;

  select coalesce(pg_catalog.array_agg(item.id), array[]::bigint[])
  into v_preserved_legacy_ids
  from public.order_items item
  join public.products product on product.id = item.product_id
  join pg_catalog.jsonb_array_elements(p_items) incoming(value)
    on nullif(incoming.value ->> 'order_item_id', '')::bigint = item.id
  where item.order_id = p_order_id
    and v_new_client_id is not distinct from v_order.client_id
    and v_new_advisor_id is not distinct from v_order.attributed_advisor_id
    and v_new_source = v_order.source::text
    and item.crm_play_member_id is null
    and item.crm_play_benefit_id is null
    and item.crm_play_benefit_upgrade_id is null
    and (product.type::text = 'gambit'
      or product.extra_fields ->> 'catalog_access_scope' = 'crm_only')
    and coalesce(product.extra_fields ->> 'catalog_access_scope', '') <> 'advisor_gift'
    and nullif(incoming.value ->> 'crm_play_member_id', '') is null
    and nullif(incoming.value ->> 'crm_play_benefit_id', '') is null
    and nullif(incoming.value ->> 'crm_play_benefit_upgrade_id', '') is null
    and item.product_id = (incoming.value ->> 'product_id')::bigint
    and item.qty = (incoming.value ->> 'qty')::numeric
    and item.pricing_origin_currency = incoming.value ->> 'pricing_origin_currency'
    and item.pricing_origin_amount = (incoming.value ->> 'pricing_origin_amount')::numeric
    and item.unit_price_usd_snapshot = (incoming.value ->> 'unit_price_usd_snapshot')::numeric
    and item.line_total_usd = (incoming.value ->> 'line_total_usd')::numeric
    and item.unit_price_bs_snapshot = (incoming.value ->> 'unit_price_bs_snapshot')::numeric
    and item.line_total_bs_snapshot = (incoming.value ->> 'line_total_bs_snapshot')::numeric
    and item.admin_price_override_usd is not distinct from
      nullif(incoming.value ->> 'admin_price_override_usd', '')::numeric
    and item.override_unit_price_usd is not distinct from
      nullif(incoming.value ->> 'override_unit_price_usd', '')::numeric
    -- Detail serializers may reorder lines. Compare the complete multiset,
    -- including @sel quantities, without discarding duplicates or composition.
    and (select coalesce(pg_catalog.array_agg(btrim(line) order by btrim(line)), array[]::text[])
      from pg_catalog.regexp_split_to_table(coalesce(item.notes, ''), E'\r?\n') line
      where btrim(line) <> '')
      = (select coalesce(pg_catalog.array_agg(btrim(line) order by btrim(line)), array[]::text[])
      from pg_catalog.regexp_split_to_table(coalesce(incoming.value ->> 'notes', ''), E'\r?\n') line
      where btrim(line) <> '');

  -- All other ordinary rows follow the original atomic rebuild and CRM guard.
  delete from public.order_items item
  where item.order_id = p_order_id
    and item.crm_play_member_id is null
    and not (item.id = any(v_preserved_legacy_ids));$new$;
  if position(old_block in definition) = 0 then raise exception 'Atomic editor deletion changed'; end if;
  definition := replace(definition, old_block, new_block);

  old_block := '    v_existing := null;';
  new_block := $new$    if nullif(v_item ->> 'order_item_id', '')::bigint = any(v_preserved_legacy_ids) then
      v_item_ids := v_item_ids || pg_catalog.jsonb_build_array((v_item ->> 'order_item_id')::bigint);
      continue;
    end if;

    v_existing := null;$new$;
  if position(old_block in definition) = 0 then raise exception 'Atomic editor item loop changed'; end if;
  definition := replace(definition, old_block, new_block);
  execute definition;
end;
$migration$;
