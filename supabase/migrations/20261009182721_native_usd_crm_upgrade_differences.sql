-- Published play snapshots and existing redemption amounts remain immutable.
-- Current prices are a read-time projection, used only for new USD orders.
begin;
set local lock_timeout='5s';

do $guard$ begin
  if md5(pg_get_functiondef('app_private.crm_play_redemption_guard_v1()'::regprocedure)) <> '992596cea8b0a9501c43f04d8e2c4608' then
    raise exception 'CRM definition changed: app_private.crm_play_redemption_guard_v1()'; end if;
  if md5(pg_get_functiondef('app_private.crm_order_item_guard_v1()'::regprocedure)) <> 'c5299aead06a59db2cf2dc8fa6d39998' then
    raise exception 'CRM definition changed: app_private.crm_order_item_guard_v1()'; end if;
end; $guard$;

create function app_private.usd_catalog_is_active_v1()
returns boolean language sql stable security definer set search_path='' as $function$
  select exists(select 1 from app_private.usd_catalog_cutover_v1 where activated_at is not null)
    and (auth.role()='service_role' or (auth.uid() is not null and
      (public.is_master_or_admin() or public.has_role('advisor') or public.has_role('counter'))));
$function$;
revoke all on function app_private.usd_catalog_is_active_v1() from public,anon;
grant execute on function app_private.usd_catalog_is_active_v1() to authenticated,service_role;

-- Unnamed composite argument: a PostgREST computed field, not a write RPC.
-- Re-read the canonical row; caller-supplied composite contents are not evidence.
create function public.current_customer_difference_usd(public.crm_play_benefit_upgrades)
returns numeric language sql stable security invoker set search_path='' as $function$
  select case when (select app_private.usd_catalog_is_active_v1()) and base.sku='SINGLE_6'
    and target.sku in ('SINGLE_8','SINGLE_10') and base.source_price_currency::text='USD'
    and target.source_price_currency::text='USD'
    then round(greatest(0,target.source_price_amount*u.target_quantity-base.source_price_amount*b.quantity),2)
    else u.customer_difference_usd_snapshot end
  from public.crm_play_benefit_upgrades u join public.crm_play_benefits b on b.id=u.play_benefit_id
  join public.products base on base.id=b.product_id join public.products target on target.id=u.target_product_id
  where u.id=($1).id;
$function$;
revoke all on function public.current_customer_difference_usd(public.crm_play_benefit_upgrades) from public,anon;
grant execute on function public.current_customer_difference_usd(public.crm_play_benefit_upgrades) to authenticated,service_role;

create function app_private.order_crm_upgrade_difference_v1(p_order bigint,p_upgrade bigint)
returns numeric language sql stable security invoker set search_path='' as $function$
  select case when app_private.order_uses_current_usd_v1(p_order)
    then public.current_customer_difference_usd(u) else u.customer_difference_usd_snapshot end
  from public.crm_play_benefit_upgrades u where u.id=p_upgrade;
$function$;
revoke all on function app_private.order_crm_upgrade_difference_v1(bigint,bigint) from public,anon;
grant execute on function app_private.order_crm_upgrade_difference_v1(bigint,bigint) to authenticated,service_role;

create function app_private.sync_single_upgrade_products_v1()
returns void language plpgsql security definer set search_path='' as $function$
begin
  -- Explicit SKU mapping; do not infer price from an arbitrary display name.
  update public.products gift set source_price_currency='USD',
    source_price_amount=round(greatest(0,target.source_price_amount-base.source_price_amount),2)
  from (values ('LOYAL_SINGLE_8','SINGLE_8'),('LC_SINGLE_8','SINGLE_8'),('ANIVERSARIO_8_SP','SINGLE_8'),
    ('LOYAL_SINGLE_10','SINGLE_10'),('LC_SINGLE_10','SINGLE_10'),('ANIVERSARIO_10','SINGLE_10')) map(gift_sku,target_sku)
  join public.products target on target.sku=map.target_sku
  cross join public.products base
  where gift.sku=map.gift_sku and gift.is_active and gift.type::text='gambit' and base.sku='SINGLE_6'
    and base.source_price_currency::text='USD' and target.source_price_currency::text='USD'
    and (gift.source_price_currency::text is distinct from 'USD'
      or gift.source_price_amount is distinct from round(greatest(0,target.source_price_amount-base.source_price_amount),2));
end;
$function$;
revoke all on function app_private.sync_single_upgrade_products_v1() from public,anon,authenticated,service_role;

create function app_private.single_upgrade_catalog_trigger_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if exists(select 1 from changed_products where sku in ('SINGLE_6','SINGLE_8','SINGLE_10'))
    and exists(select 1 from app_private.usd_catalog_cutover_v1 where activated_at is not null) then
    perform app_private.sync_single_upgrade_products_v1();
  end if;
  return null;
end;
$function$;
revoke all on function app_private.single_upgrade_catalog_trigger_v1() from public,anon,authenticated,service_role;
create trigger single_upgrade_catalog_v1 after update on public.products
  referencing new table as changed_products for each statement
  execute function app_private.single_upgrade_catalog_trigger_v1();

do $patch$
declare definition text; anchor text;
begin
  definition:=pg_get_functiondef('app_private.crm_order_item_guard_v1()'::regprocedure);
  anchor:='expected_line_total_usd := coalesce(upgrade_row.customer_difference_usd_snapshot, 0);';
  if position(anchor in definition)=0 then raise exception 'CRM line difference anchor changed'; end if;
  definition:=replace(definition,anchor,'expected_line_total_usd := coalesce(app_private.order_crm_upgrade_difference_v1(new.order_id,new.crm_play_benefit_upgrade_id), 0);');
  -- An unchanged, reserved/redeemed item keeps its certified price even if the
  -- catalog changes again. Authorization/selection/product checks run first.
  anchor:='    expected_line_total_usd := pg_catalog.round(greatest(0, expected_line_total_usd), 2);';
  if position(anchor in definition)=0 then raise exception 'CRM retention anchor changed'; end if;
  definition:=replace(definition,anchor,E'    if tg_op=''UPDATE'' and\n      (to_jsonb(new)-array[''notes'']) is not distinct from (to_jsonb(old)-array[''notes''])\n      and exists(select 1 from public.crm_play_redemptions r where r.order_item_id=old.id and r.order_id=old.order_id\n        and r.play_member_id=old.crm_play_member_id and r.play_benefit_id=old.crm_play_benefit_id\n        and r.play_benefit_upgrade_id is not distinct from old.crm_play_benefit_upgrade_id and r.status in (''reserved'',''redeemed'')) then\n      return new;\n    end if;\n\n'||anchor);
  execute definition;

  definition:=pg_get_functiondef('app_private.crm_play_redemption_guard_v1()'::regprocedure);
  anchor:='expected_line_total := coalesce(upgrade_row.customer_difference_usd_snapshot, 0);';
  if position(anchor in definition)=0 then raise exception 'CRM reservation difference anchor changed'; end if;
  definition:=replace(definition,anchor,E'expected_line_total := case when tg_op=''UPDATE'' then old.customer_paid_difference_usd\n      else coalesce(app_private.order_crm_upgrade_difference_v1(new.order_id,new.play_benefit_upgrade_id),0) end;');
  execute definition;
end;
$patch$;
notify pgrst,'reload schema';
commit;
