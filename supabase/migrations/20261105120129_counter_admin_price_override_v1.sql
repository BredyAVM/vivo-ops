-- Keep Counter catalogue pricing for ordinary sales; explicit administrative
-- adjustments use the same validated USD/VES route as other orders.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $patch$
declare d text;anchor text;
begin
  d:=replace(pg_get_functiondef('public.trg_order_items_set_pricing()'::regprocedure),chr(13),'');
  anchor:=$a$    if v_is_counter_direct_sale and position('@muerdeme|'in coalesce(new.notes,''))=0 then$a$;
  if position(anchor in d)=0 then raise exception 'Counter pricing branch changed';end if;
  d:=replace(d,anchor,$a$    if v_is_counter_direct_sale and position('@muerdeme|'in coalesce(new.notes,''))=0
      and new.admin_price_override_usd is null then$a$);

  anchor:=$a$  if not v_is_crm_item and not v_is_counter_direct_sale
    and new.pricing_origin_currency = 'VES'$a$;
  if position(anchor in d)=0 then raise exception 'Administrative VES branch changed';end if;
  d:=replace(d,anchor,$a$  if not v_is_crm_item and (not v_is_counter_direct_sale or new.admin_price_override_usd is not null)
    and new.pricing_origin_currency = 'VES'$a$);

  anchor:=$a$  if not v_is_crm_item
    and not v_is_counter_direct_sale
    and new.pricing_origin_currency = 'USD'$a$;
  if position(anchor in d)=0 then raise exception 'Administrative USD branch changed';end if;
  d:=replace(d,anchor,$a$  if not v_is_crm_item
    and new.pricing_origin_currency = 'USD'$a$);
  execute d;
end;
$patch$;
commit;
