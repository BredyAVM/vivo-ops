-- Family rules are the authority. Product options are only stable references for
-- order selection, reservations and financial audit, generated automatically.
-- Safety scope verified before release: the only coupon is NC #36 in draft;
-- there are no published coupons and no automatic family opt-ins. No campaign
-- is activated and no order/redemption/cost history is changed by this migration.
-- Future published expansion requires an explicit per-play admin checkbox.
do $$ begin
  if exists(select 1 from public.crm_plays where status<>'draft'
    and rules_snapshot#>>'{coupon_draft,auto_include_new_products}'='true') then
    raise exception 'Review existing published family opt-ins before applying this change.';
  end if;
end $$;
create or replace function app_private.crm_coupon_family_v1(
  p_group text,p_name text,p_sku text,p_type text,p_active boolean,p_extra jsonb
) returns text language sql immutable set search_path='' as $$
  select case when p_active and p_type='product'
    and coalesce(p_extra->>'catalog_access_scope','') not in ('admin_internal','advisor_gift_only','gambit_disabled')
    then case when app_private.crm_is_delivery_product_v1(p_name,p_sku) then 'delivery'
      when p_group='beverages' then 'beverages' end end;
$$;

create or replace function app_private.crm_coupon_product_v1(p_product bigint)
returns boolean language sql stable set search_path='' as $$
  select app_private.crm_coupon_family_v1(p.inventory_group,p.name,p.sku,p.type::text,p.is_active,p.extra_fields) is not null
  from public.products p where p.id=p_product;
$$;

create or replace function app_private.crm_coupon_product_for_play_v1(p_product bigint,p_play bigint)
returns boolean language sql stable set search_path='' as $$
  select coalesce((
    coalesce(c.rules_snapshot#>'{coupon_draft,eligible_categories}','["beverages","delivery"]'::jsonb)
    ? app_private.crm_coupon_family_v1(p.inventory_group,p.name,p.sku,p.type::text,p.is_active,p.extra_fields)
  ),false) from public.products p cross join public.crm_plays c where p.id=p_product and c.id=p_play;
$$;

create or replace function app_private.crm_play_benefit_guard_v2()
returns trigger language plpgsql set search_path='' as $$
declare play_status text; play_rules jsonb; cap numeric; advisor numeric;
begin
  select status,rules_snapshot into play_status,play_rules from public.crm_plays
  where id=case when tg_op='DELETE' then old.play_id else new.play_id end;
  if play_status is null then raise exception 'CRM play does not exist'; end if;
  if play_status<>'draft' then
    -- Published terms cannot change. Only a new, eligible product reference with
    -- the already agreed cap/cost split may join a dynamic family coupon.
    if tg_op<>'INSERT' or play_status not in ('frozen','active','paused')
      or coalesce(play_rules#>>'{coupon_draft,eligibility_mode}','')<>'families'
      or coalesce(play_rules#>>'{coupon_draft,auto_include_new_products}','false')<>'true' then
      raise exception 'CRM play benefit options are immutable after review begins';
    end if;
    cap:=(play_rules#>>'{coupon_draft,maximum_discount_usd}')::numeric;
    advisor:=(play_rules#>>'{coupon_draft,economics,advisor_contribution_usd}')::numeric;
    if app_private.crm_coupon_product_for_play_v1(new.product_id,new.play_id) is not true
      or coalesce(play_rules#>>'{coupon_draft,economics,review_status}','')<>'approved'
      or cap is null or advisor is null or new.quantity<>1
      or new.unit_benefit_value_usd<>cap or new.unit_advisor_cost_usd<>advisor
      or new.unit_company_cost_usd<>cap-advisor or new.unit_budget_cost_usd<>cap-advisor then
      raise exception 'El producto nuevo debe respetar las familias y condiciones publicadas del cupón.' using errcode='22023';
    end if;
  end if;
  if tg_op<>'DELETE' and new.sort_order>8 and jsonb_typeof(play_rules->'coupon_draft') is distinct from 'object' then
    raise exception 'Las jugadas de obsequios permiten hasta ocho alternativas.' using errcode='22023';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;

create or replace function app_private.crm_sync_coupon_options_v1(p_play bigint,p_product bigint default null)
returns integer language plpgsql security definer set search_path='' as $$
declare play_row public.crm_plays%rowtype; cap numeric; advisor numeric; last_sort integer; added integer; fx numeric;
begin
  select * into play_row from public.crm_plays where id=p_play;
  if play_row.id is null or play_row.status not in ('draft','frozen','active','paused')
    or coalesce(play_row.rules_snapshot#>>'{coupon_draft,eligibility_mode}','')<>'families'
    or (play_row.ends_at is not null and play_row.ends_at<=now()) then return 0; end if;
  if play_row.status<>'draft' and coalesce(play_row.rules_snapshot#>>'{coupon_draft,auto_include_new_products}','false')<>'true' then return 0; end if;
  if play_row.status<>'draft' and not exists(select 1 from public.products p where (p_product is null or p.id=p_product)
    and app_private.crm_coupon_product_for_play_v1(p.id,p_play) is true
    and not exists(select 1 from public.crm_play_benefits b where b.play_id=p_play and b.product_id=p.id)) then return 0; end if;
  select * into play_row from public.crm_plays where id=p_play for update;
  if play_row.status not in ('draft','frozen','active','paused')
    or coalesce(play_row.rules_snapshot#>>'{coupon_draft,eligibility_mode}','')<>'families'
    or (play_row.ends_at is not null and play_row.ends_at<=now()) then return 0; end if;
  if play_row.status<>'draft' and coalesce(play_row.rules_snapshot#>>'{coupon_draft,auto_include_new_products}','false')<>'true' then return 0; end if;
  cap:=(play_row.rules_snapshot#>>'{coupon_draft,maximum_discount_usd}')::numeric;
  advisor:=coalesce((play_row.rules_snapshot#>>'{coupon_draft,economics,advisor_contribution_usd}')::numeric,0);
  if cap is null or cap<=0 or advisor<0 or advisor>cap then raise exception 'Revisa los costos y el límite del cupón.'; end if;
  if play_row.status='draft' then
    -- A draft can change its families/costs. Never rewrite a reference that has
    -- already entered an order or its financial audit.
    delete from public.crm_play_benefits b where b.play_id=p_play
      and app_private.crm_coupon_product_for_play_v1(b.product_id,p_play) is not true
      and not exists(select 1 from public.crm_play_redemptions r where r.play_benefit_id=b.id)
      and not exists(select 1 from public.order_items i where i.crm_play_benefit_id=b.id)
      and not exists(select 1 from public.crm_play_member_benefit_selections s where s.play_benefit_id=b.id);
    update public.crm_play_benefits b set unit_benefit_value_usd=cap,unit_advisor_cost_usd=advisor,
      unit_company_cost_usd=cap-advisor,unit_budget_cost_usd=cap-advisor
    where b.play_id=p_play and (b.unit_benefit_value_usd,b.unit_advisor_cost_usd,b.unit_company_cost_usd,b.unit_budget_cost_usd)
      is distinct from (cap,advisor,cap-advisor,cap-advisor)
      and not exists(select 1 from public.crm_play_redemptions r where r.play_benefit_id=b.id)
      and not exists(select 1 from public.order_items i where i.crm_play_benefit_id=b.id);
  end if;
  select coalesce(max(sort_order),0) into last_sort from public.crm_play_benefits where play_id=p_play;
  fx:=public.get_active_exchange_rate();
  insert into public.crm_play_benefits(play_id,product_id,quantity,sort_order,unit_budget_cost_usd,
    unit_benefit_value_usd,unit_advisor_cost_usd,unit_company_cost_usd,product_name_snapshot,
    source_price_currency_snapshot,source_price_amount_snapshot,catalog_price_usd_snapshot)
  select p_play,p.id,1,last_sort+row_number() over(order by p.id),cap-advisor,cap,advisor,cap-advisor,p.name,
    p.source_price_currency,p.source_price_amount,
    round(case when p.source_price_currency::text='VES' then p.source_price_amount/nullif(fx,0)
      else coalesce(p.source_price_amount,p.base_price_usd) end,6)
  from public.products p where (p_product is null or p.id=p_product)
    and app_private.crm_coupon_product_for_play_v1(p.id,p_play) is true
    and not exists(select 1 from public.crm_play_benefits b where b.play_id=p_play and b.product_id=p.id)
  on conflict(play_id,product_id) do nothing;
  get diagnostics added=row_count;
  return added;
end $$;

create or replace function public.crm_sync_coupon_options_v1(p_play_id bigint)
returns integer language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not (public.is_master_or_admin() or exists(
    select 1 from public.crm_play_members m where m.play_id=p_play_id and m.advisor_id_snapshot=auth.uid()
      and m.workflow_status<>'removed')) then
    raise exception 'No tienes acceso a esta jugada.' using errcode='42501';
  end if;
  return app_private.crm_sync_coupon_options_v1(p_play_id);
end $$;
revoke all on function public.crm_sync_coupon_options_v1(bigint) from public,anon;
grant execute on function public.crm_sync_coupon_options_v1(bigint) to authenticated;

create or replace function app_private.crm_coupon_catalog_changed_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare family text; play_key bigint;
begin
  family:=app_private.crm_coupon_family_v1(new.inventory_group,new.name,new.sku,new.type::text,new.is_active,new.extra_fields);
  if family is null then return new; end if;
  if tg_op='UPDATE' then
    if family is not distinct from app_private.crm_coupon_family_v1(old.inventory_group,old.name,old.sku,old.type::text,old.is_active,old.extra_fields) then return new; end if;
  end if;
  for play_key in select p.id from public.crm_plays p
    where p.status in ('draft','frozen','active','paused') and (p.ends_at is null or p.ends_at>now())
    and p.rules_snapshot#>>'{coupon_draft,eligibility_mode}'='families'
    and (p.status='draft' or p.rules_snapshot#>>'{coupon_draft,auto_include_new_products}'='true')
    and coalesce(p.rules_snapshot#>'{coupon_draft,eligible_categories}','[]'::jsonb) ? family
    order by p.id loop perform app_private.crm_sync_coupon_options_v1(play_key,new.id); end loop;
  return new;
end $$;
create trigger crm_coupon_catalog_changed after insert or update of inventory_group,name,sku,type,is_active,extra_fields
on public.products for each row execute function app_private.crm_coupon_catalog_changed_v1();

do $migration$
declare s text; changed text;
begin
  select pg_get_functiondef('app_private.crm_order_item_guard_v1()'::regprocedure) into s;
  changed:=replace(s,'app_private.crm_coupon_product_v1(new.product_id)',
    'app_private.crm_coupon_product_for_play_v1(new.product_id,member_row.play_id)');
  if changed=s then raise exception 'Coupon item guard changed; family guard not applied'; end if;
  execute changed;
  select pg_get_functiondef('public.crm_confirm_play_v1(bigint)'::regprocedure) into s;
  changed:=replace(s,'app_private.crm_coupon_product_v1(b.product_id)',
    'app_private.crm_coupon_product_for_play_v1(b.product_id,p_play_id)');
  if changed=s then raise exception 'Coupon confirmation guard changed; family guard not applied'; end if;
  execute changed;
  select pg_get_functiondef('app_private.crm_coupon_deferred_guard_v1()'::regprocedure) into s;
  changed:=replace(s,'p.name ~* ''^Delivery Zona [1-7]$''','app_private.crm_is_delivery_product_v1(p.name,p.sku)');
  if changed=s then raise exception 'Coupon channel guard changed; family guard not applied'; end if;
  execute changed;
end $migration$;

revoke all on function app_private.crm_coupon_family_v1(text,text,text,text,boolean,jsonb),
  app_private.crm_coupon_product_for_play_v1(bigint,bigint),app_private.crm_sync_coupon_options_v1(bigint,bigint),
  app_private.crm_coupon_catalog_changed_v1() from public,anon,authenticated;
