-- Retain exact, already-approved lines for Master operational edits.
-- No data backfill, privilege changes, trigger bypass or new price approval.
set local lock_timeout = '5s';

do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.update_order_core_atomic_v1(bigint,timestamptz,jsonb,jsonb)'::regprocedure
  );
  anchor text;
  addition text;
begin
  if position('v_preserved_approved_ids' in definition) > 0 then
    raise exception 'Approved-price preservation already installed; inspect before replacing it.';
  end if;
  anchor := '  v_preserved_legacy_ids bigint[] := array[]::bigint[];';
  if position(anchor in definition) = 0 then raise exception 'Atomic editor declaration changed'; end if;
  definition := replace(definition, anchor,
    anchor || E'\n  v_preserved_approved_ids bigint[] := array[]::bigint[];');

  anchor := '  -- All other ordinary rows follow the original atomic rebuild and CRM guard.';
  if position(anchor in definition) = 0 then raise exception 'Atomic editor rebuild changed'; end if;
  addition := $addition$  -- Identity, context and complete economic evidence must still match the locked
  -- database row. An inactive catalog product can be retained, never re-granted.
  if v_is_master and not v_is_admin then
    select coalesce(pg_catalog.array_agg(item.id), array[]::bigint[])
    into v_preserved_approved_ids
    from public.order_items item
    join pg_catalog.jsonb_array_elements(p_items) incoming(value)
      on nullif(incoming.value ->> 'order_item_id', '')::bigint = item.id
    where item.order_id = p_order_id
      and item.admin_price_override_usd is not null
      and item.crm_play_member_id is null
      and v_new_client_id is not distinct from v_order.client_id
      and v_new_advisor_id is not distinct from v_order.attributed_advisor_id
      and v_new_source = v_order.source::text
      and item.product_id = (incoming.value ->> 'product_id')::bigint
      and item.qty = (incoming.value ->> 'qty')::numeric
      and item.pricing_origin_currency = incoming.value ->> 'pricing_origin_currency'
      and item.pricing_origin_amount = (incoming.value ->> 'pricing_origin_amount')::numeric
      and item.unit_price_usd_snapshot = (incoming.value ->> 'unit_price_usd_snapshot')::numeric
      and item.line_total_usd = (incoming.value ->> 'line_total_usd')::numeric
      and item.unit_price_bs_snapshot = (incoming.value ->> 'unit_price_bs_snapshot')::numeric
      and item.line_total_bs_snapshot = (incoming.value ->> 'line_total_bs_snapshot')::numeric
      and item.admin_price_override_usd = (incoming.value ->> 'admin_price_override_usd')::numeric
      and btrim(coalesce(item.admin_price_override_reason, '')) =
        btrim(coalesce(incoming.value ->> 'admin_price_override_reason', ''))
      and item.override_unit_price_usd is not distinct from
        nullif(incoming.value ->> 'override_unit_price_usd', '')::numeric
      and item.crm_play_benefit_id is not distinct from
        nullif(incoming.value ->> 'crm_play_benefit_id', '')::bigint
      and item.crm_play_benefit_upgrade_id is not distinct from
        nullif(incoming.value ->> 'crm_play_benefit_upgrade_id', '')::bigint
      and nullif(incoming.value ->> 'crm_play_member_id', '') is null
      and (select coalesce(pg_catalog.array_agg(btrim(line) order by btrim(line)), array[]::text[])
        from pg_catalog.regexp_split_to_table(coalesce(item.notes, ''), E'\r?\n') line
        where btrim(line) <> '')
        = (select coalesce(pg_catalog.array_agg(btrim(line) order by btrim(line)), array[]::text[])
        from pg_catalog.regexp_split_to_table(coalesce(incoming.value ->> 'notes', ''), E'\r?\n') line
        where btrim(line) <> '');
  end if;

  if not v_is_admin and (
    exists (
      select 1 from pg_catalog.jsonb_array_elements(p_items) incoming(value)
      where nullif(incoming.value ->> 'admin_price_override_usd', '') is not null
        and not coalesce(nullif(incoming.value ->> 'order_item_id', '')::bigint = any(v_preserved_approved_ids), false)
    ) or exists (
      select 1 from public.order_items item
      where item.order_id = p_order_id and item.admin_price_override_usd is not null
        and not (item.id = any(v_preserved_approved_ids))
    )
  ) then
    raise exception 'Solo Administración puede cambiar una línea con precio especial. Conserva sus productos, cantidades y precios autorizados.'
      using errcode = '42501';
  end if;

  -- Reuse the existing retention path: no delete/insert, no approval restamping,
  -- no inventory replay and no loss of linked administrative evidence.
  v_preserved_legacy_ids := v_preserved_legacy_ids || v_preserved_approved_ids;

$addition$;
  definition := replace(definition, anchor, addition || anchor);
  execute definition;
end;
$migration$;
