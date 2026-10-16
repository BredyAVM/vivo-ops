-- Fix future edits only. No existing order, award or balance is changed here.
-- Preserve the installed auth/CRM/inventory/price guards and routine ACLs.
do $migration$
declare
  definition text;
  old_retention text := E'    where not exists(select 1 from public.order_items i where i.id=retained and i.reward_grant_id is not null)\n      or exists(select 1 from public.order_items i join jsonb_array_elements(p_items) incoming(value)';
  new_retention text := E'    where exists(select 1 from public.order_items i join jsonb_array_elements(p_items) incoming(value)';
  quantity_anchor text := 'and i.product_id=(incoming.value->>''product_id'')::bigint and i.qty=(incoming.value->>''qty'')::numeric));';
  quantity_guard text := 'and (i.reward_grant_id is null or (i.product_id=(incoming.value->>''product_id'')::bigint and i.qty=(incoming.value->>''qty'')::numeric))));';
  totals_anchor text := E'  select\n    count(*)::integer,\n    pg_catalog.round(coalesce(sum(item.line_total_usd), 0), 2),';
begin
  definition := pg_get_functiondef('app_private.update_order_core_atomic_v1(bigint,timestamptz,jsonb,jsonb)'::regprocedure);
  if strpos(definition, old_retention) = 0 or strpos(definition, totals_anchor) = 0
    or strpos(definition, quantity_anchor) = 0
    or strpos(definition, 'reward_edit_funding_integrity_v1') > 0 then
    raise exception 'El editor canónico cambió; revisa la integración del crédito antes de aplicar la migración.';
  end if;
  -- Adding funding to an ordinary retained row must rebuild it too. The former
  -- predicate checked only rows which ALREADY had a prize, silently ignoring
  -- a newly requested payer when an old-price serializer retained the item ID.
  definition := replace(definition, old_retention, new_retention);
  -- Ordinary quantity reductions still use the certified operational path;
  -- only an existing prize requires its entitlement's exact quantity/product.
  definition := replace(definition, quantity_anchor, quantity_guard);
  definition := replace(definition, totals_anchor, $guard$
  -- reward_edit_funding_integrity_v1: all-or-nothing proof before totals/save.
  -- Pair input and persisted IDs by ordinal, never by product/name (duplicates
  -- can be legitimate). The normal triggers remain authoritative for pricing.
  if exists (
    select 1
    from jsonb_array_elements(p_items) with ordinality incoming(value, position)
    left join public.order_items item
      on item.id = (v_item_ids ->> (incoming.position::integer - 1))::bigint
     and item.order_id = p_order_id
    where item.id is null
      or item.reward_grant_id is distinct from nullif(incoming.value->>'reward_grant_id','')::bigint
      or item.reward_purpose is distinct from nullif(incoming.value->>'reward_purpose','')
      or (item.reward_grant_id is not null and (
        not exists (
          select 1 from public.advisor_reward_grants grant_row
          where grant_row.id = item.reward_grant_id
            and (grant_row.kind = 'product_units' or item.reward_amount_usd
              is not distinct from nullif(incoming.value->>'reward_amount_usd','')::numeric)
        )
        or item.line_total_usd is distinct from round(item.reward_base_line_usd - item.reward_amount_usd, 2)
        or not exists (
          select 1 from public.advisor_reward_uses use_row
          where use_row.order_item_id = item.id and use_row.order_id = p_order_id
            and use_row.grant_id = item.reward_grant_id
            and use_row.purpose = item.reward_purpose
            and use_row.status = 'reserved'
            and use_row.funded_usd = item.reward_amount_usd
        )
      ))
  ) then
    raise exception 'No se pudo conservar el premio y su reserva. No se guardaron los cambios; revisa el crédito y vuelve a intentar.'
      using errcode = 'P0001';
  end if;

$guard$ || totals_anchor);
  execute definition;
end;
$migration$;
