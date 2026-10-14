CREATE OR REPLACE FUNCTION app_private.order_item_operational_quantity_v1(p_old jsonb, p_new jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select (p_new - array['qty','line_total_usd','line_total_bs_snapshot','notes'])
      = (p_old - array['qty','line_total_usd','line_total_bs_snapshot','notes'])
    and p_old->>'crm_play_member_id' is null
    and p_old->>'crm_play_benefit_id' is null
    and p_old->>'crm_play_benefit_upgrade_id' is null
    and (p_old->>'qty')::numeric > 0
    and (p_new->>'qty')::numeric > 0
    and (p_new->>'qty')::numeric <= 9999
    and (p_new->>'line_total_usd')::numeric in (
      (p_old->>'line_total_usd')::numeric,
      round(case when p_old->>'admin_price_override_usd' is null then (p_old->>'unit_price_usd_snapshot')::numeric
        else (p_old->>'line_total_usd')::numeric / (p_old->>'qty')::numeric end * (p_new->>'qty')::numeric,2))
    and (p_new->>'line_total_bs_snapshot')::numeric in (
      (p_old->>'line_total_bs_snapshot')::numeric,
      round((p_old->>'unit_price_bs_snapshot')::numeric * (p_new->>'qty')::numeric,2))
    and (p_old->>'admin_price_override_usd' is null or p_new->>'notes' is not distinct from p_old->>'notes');
$function$
;
CREATE OR REPLACE FUNCTION app_private.order_item_reduced_commercial_terms_v1(p_old jsonb, p_new jsonb, p_parent_fx numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare qty numeric; previous_qty numeric; expected_usd numeric; expected_bs numeric; fx numeric;
begin
  qty:=(p_new->>'qty')::numeric; previous_qty:=(p_old->>'qty')::numeric;
  if qty is null or qty<=0 or qty>=previous_qty or qty::text in ('NaN','Infinity','-Infinity') then return false; end if;
  expected_bs:=round((p_old->>'unit_price_bs_snapshot')::numeric*qty,2);
  fx:=coalesce((p_old->>'pricing_fx_rate_snapshot')::numeric,p_parent_fx);
  expected_usd:=case when p_old->>'pricing_origin_currency'='VES' and fx>0
    then round(expected_bs/fx,2) else round((p_old->>'line_total_usd')::numeric/previous_qty*qty,2) end;
  return app_private.order_item_same_commercial_terms_v1(p_old,p_new||jsonb_build_object(
      'qty',previous_qty,'line_total_usd',p_old->'line_total_usd','line_total_bs_snapshot',p_old->'line_total_bs_snapshot'))
    and (p_new->>'line_total_usd')::numeric=expected_usd
    and (p_new->>'line_total_bs_snapshot')::numeric=expected_bs;
exception when invalid_text_representation or numeric_value_out_of_range or division_by_zero then return false;
end;
$function$
;
CREATE OR REPLACE FUNCTION app_private.order_item_same_commercial_terms_v1(p_old jsonb, p_new jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
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
$function$
;
