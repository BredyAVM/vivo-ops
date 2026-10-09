-- Preparation only: no catalog activation, backfill, payment or inventory write.
-- Retain certified ordinary/approved lines instead of rebuilding them on an
-- unrelated edit. Uses the existing atomic editor's locks and ownership checks.
begin;
set local lock_timeout = '5s';

create or replace function app_private.order_item_same_commercial_terms_v1(p_old jsonb, p_new jsonb)
returns boolean language sql immutable set search_path = '' as $function$
  select coalesce(
    (select jsonb_object_agg(key, p_old -> key) from unnest(array[
      'product_id','qty','pricing_origin_currency','pricing_origin_amount',
      'unit_price_usd_snapshot','line_total_usd','unit_price_bs_snapshot','line_total_bs_snapshot',
      'admin_price_override_reason','admin_price_override_by_user_id','admin_price_override_at',
      'override_unit_price_usd','override_reason','override_approved_by','override_approved_at',
      'crm_play_member_id','crm_play_benefit_id','crm_play_benefit_upgrade_id'
    ]) key)
    = (select jsonb_object_agg(key, p_new -> key) from unnest(array[
      'product_id','qty','pricing_origin_currency','pricing_origin_amount',
      'unit_price_usd_snapshot','line_total_usd','unit_price_bs_snapshot','line_total_bs_snapshot',
      'admin_price_override_reason','admin_price_override_by_user_id','admin_price_override_at',
      'override_unit_price_usd','override_reason','override_approved_by','override_approved_at',
      'crm_play_member_id','crm_play_benefit_id','crm_play_benefit_upgrade_id'
    ]) key)
    -- JS transports numeric approvals as doubles. Comparison only; retain the
    -- exact stored value and evidence, never write the rounded comparison value.
    and round((p_old ->> 'admin_price_override_usd')::numeric,12)
      is not distinct from round((p_new ->> 'admin_price_override_usd')::numeric,12)
    and p_old ->> 'crm_play_member_id' is null
    and p_old ->> 'crm_play_benefit_id' is null
    and p_old ->> 'crm_play_benefit_upgrade_id' is null
    and p_old ->> 'pricing_origin_currency' in ('USD','VES')
    and (p_old ->> 'qty')::numeric > 0 and (p_old ->> 'qty')::numeric <= 9999
    and not exists (select 1 from unnest(array['pricing_origin_amount','unit_price_usd_snapshot',
      'line_total_usd','unit_price_bs_snapshot','line_total_bs_snapshot']) key
      where p_old ->> key is null or p_old ->> key in ('NaN','Infinity','-Infinity')
        or (p_old ->> key)::numeric < 0)
    -- Missing FX in an older serializer is not a new exchange-rate instruction.
    and (not (p_new ? 'pricing_fx_rate_snapshot') or
      p_old -> 'pricing_fx_rate_snapshot' is not distinct from p_new -> 'pricing_fx_rate_snapshot')
    -- An approval includes its complete composition, not just a displayed price.
    and (p_old ->> 'admin_price_override_usd' is null or
      (select coalesce(array_agg(btrim(line) order by btrim(line)),array[]::text[])
        from regexp_split_to_table(coalesce(p_old ->> 'notes',''), E'\r?\n') line where btrim(line)<>'')
      = (select coalesce(array_agg(btrim(line) order by btrim(line)),array[]::text[])
        from regexp_split_to_table(coalesce(p_new ->> 'notes',''), E'\r?\n') line where btrim(line)<>'')), false);
$function$;
revoke all on function app_private.order_item_same_commercial_terms_v1(jsonb,jsonb) from public,anon;
grant execute on function app_private.order_item_same_commercial_terms_v1(jsonb,jsonb) to authenticated;

do $migration$
declare
  definition text;
  anchor text := E'begin\n';
  name text;
  prefix text := $prefix$
  -- A note-only edit never recomputes a certified USD/Bs snapshot.
  if tg_op='UPDATE' and auth.uid() is not null
    and new.order_id=old.order_id
    and (to_jsonb(new)-'notes')=(to_jsonb(old)-'notes')
    and app_private.order_item_same_commercial_terms_v1(to_jsonb(old),to_jsonb(new))
    and exists (select 1 from public.orders o where o.id=old.order_id
      and o.status::text in ('created','queued','confirmed','in_kitchen','ready')
      and (public.is_master_or_admin() or (public.has_role('advisor')
        and o.attributed_advisor_id=auth.uid() and not coalesce(o.is_price_locked,false)
        and o.status::text in ('created','queued')))) then
    return new;
  end if;
  $prefix$;
begin
  foreach name in array array['trg_order_items_guard','trg_order_items_pricing_guard','trg_order_items_set_pricing'] loop
    definition := replace(pg_get_functiondef(('public.'||name||'()')::regprocedure),chr(13),'');
    if position('order_item_same_commercial_terms_v1' in definition)>0
      or position(anchor in definition)=0 then raise exception 'Commercial guard changed: %',name; end if;
    execute replace(definition,anchor,anchor||prefix);
  end loop;
  definition := replace(pg_get_functiondef(
    'app_private.update_order_core_atomic_v1(bigint,timestamptz,jsonb,jsonb)'::regprocedure),chr(13),'');
  anchor := '  -- All other ordinary rows follow the original atomic rebuild and CRM guard.';
  if position(anchor in definition)=0 or position('Certified unchanged commercial rows' in definition)>0 then
    raise exception 'Atomic commercial retention anchor changed';
  end if;
  definition := replace(definition,anchor,$addition$
  -- Certified unchanged commercial rows: all authorized roles, including Admin.
  -- Keep identity, FX, approver/date, commissions and inventory links intact.
  if v_new_client_id is not distinct from v_order.client_id
    and v_new_advisor_id is not distinct from v_order.attributed_advisor_id
    and v_new_source=v_order.source::text then
    v_preserved_legacy_ids := v_preserved_legacy_ids || array(
      select item.id from public.order_items item
      join jsonb_array_elements(p_items) incoming(value)
        on nullif(incoming.value->>'order_item_id','')::bigint=item.id
      where item.order_id=p_order_id
        and app_private.order_item_same_commercial_terms_v1(to_jsonb(item),
          to_jsonb(jsonb_populate_record(item,incoming.value-array['order_item_id',
            'admin_price_override_by_user_id','admin_price_override_at']))));
  end if;
$addition$||anchor);
  execute definition;
end;
$migration$;
commit;
