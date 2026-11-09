-- A coupon uses existing CRM membership/reservation/delivery records, with one
-- allowance across the selected products. No campaign is activated here.
alter table public.order_items
  add column crm_coupon_source_currency text check (crm_coupon_source_currency in ('USD','VES')),
  add column crm_coupon_source_amount numeric check (crm_coupon_source_amount >= 0),
  add column crm_coupon_discount_usd numeric check (crm_coupon_discount_usd >= 0);
alter table public.crm_play_redemptions
  add column coupon_source_currency text,
  add column coupon_source_amount numeric;

create or replace function app_private.crm_coupon_cap_v1(p_play bigint)
returns numeric language sql stable set search_path='' as $$
  select nullif(p.rules_snapshot#>>'{coupon_draft,maximum_discount_usd}','')::numeric
  from public.crm_plays p where p.id=p_play and jsonb_typeof(p.rules_snapshot->'coupon_draft')='object';
$$;

create or replace function app_private.crm_coupon_product_v1(p_product bigint)
returns boolean language sql stable set search_path='' as $$
  select coalesce(p.is_active and p.type::text='product' and
    (p.inventory_group='beverages' or p.name ~* '^Delivery Zona [1-7]$')
    and coalesce(p.extra_fields->>'catalog_access_scope','') not in ('admin_internal','advisor_gift_only','gambit_disabled'),false)
  from public.products p where p.id=p_product;
$$;

create or replace function app_private.crm_coupon_quote_v1(p_order bigint,p_member bigint,p_benefit bigint)
returns table(source_currency text,source_amount numeric,gross_usd numeric,discount_usd numeric,net_usd numeric,prior_discount_usd numeric)
language sql stable set search_path='' as $$
  with selected as (
    select b.id,b.product_id,b.quantity,app_private.crm_coupon_cap_v1(b.play_id) cap,
      coalesce(kept.crm_coupon_source_currency,previous.coupon_source_currency,p.source_price_currency::text) currency,
      coalesce(kept.crm_coupon_source_amount,previous.coupon_source_amount,p.source_price_amount,p.base_price_usd) amount,
      nullif(o.extra_fields#>>'{pricing,fx_rate}','')::numeric fx
    from public.crm_play_member_benefit_selections s
    join public.crm_play_benefits b on b.id=s.play_benefit_id and b.play_id=s.play_id
    join public.products p on p.id=b.product_id
    join public.orders o on o.id=p_order
    left join lateral (select i.crm_coupon_source_currency,i.crm_coupon_source_amount from public.order_items i
      where i.order_id=p_order and i.crm_play_member_id=p_member and i.crm_play_benefit_id=b.id
      and i.crm_coupon_source_currency is not null order by i.id limit 1) kept on true
    left join lateral (select r.coupon_source_currency,r.coupon_source_amount from public.crm_play_redemptions r
      where r.order_id=p_order and r.play_member_id=p_member and r.play_benefit_id=b.id
      and r.coupon_source_currency is not null order by r.id desc limit 1) previous on true
    where s.play_member_id=p_member
  ), priced as (
    select *,round(case when currency='VES' then amount/nullif(fx,0) else amount end*quantity,2) gross from selected
  ), allocation as (
    select *,coalesce(sum(gross) over(order by id rows between unbounded preceding and 1 preceding),0) prior from priced
  )
  select currency,amount,gross,least(gross,greatest(0,cap-prior)),
    gross-least(gross,greatest(0,cap-prior)),least(cap,prior)
  from allocation where id=p_benefit;
$$;

-- Patch only the coupon branch; ordinary gifts retain their existing checks.
do $migration$
declare s text; changed text;
begin
  select pg_get_functiondef('app_private.crm_order_item_guard_v1()'::regprocedure) into s;
  changed:=replace(s,'  is_existing_redemption boolean := false;', E'  is_existing_redemption boolean := false;\n  coupon_quote record;\n  coupon_cap numeric;');
  changed:=replace(changed,'  if not is_crm_item then',E'  if not is_crm_item then\n    new.crm_coupon_source_currency:=null; new.crm_coupon_source_amount:=null; new.crm_coupon_discount_usd:=null;');
  changed:=replace(changed,'    expected_product_id := benefit_row.product_id;',E'    coupon_cap:=app_private.crm_coupon_cap_v1(member_row.play_id);\n    expected_product_id := benefit_row.product_id;');
  changed:=replace(changed,'    if tg_op=''UPDATE'' and', '    if coupon_cap is null and tg_op=''UPDATE'' and');
  changed:=replace(changed,'    expected_line_total_usd := pg_catalog.round(greatest(0, expected_line_total_usd), 2);',$patch$
    if coupon_cap is not null then
      if new.crm_play_benefit_upgrade_id is not null or new.reward_grant_id is not null
        or new.admin_price_override_usd is not null or new.override_unit_price_usd is not null
        or app_private.crm_coupon_product_v1(new.product_id) is not true then
        raise exception 'El cupón solo admite las bebidas y el delivery autorizados, sin otro descuento en la misma línea.' using errcode='22023';
      end if;
      perform pg_advisory_xact_lock(hashtextextended('crm-play-member:'||new.crm_play_member_id,0));
      select * into coupon_quote from app_private.crm_coupon_quote_v1(new.order_id,new.crm_play_member_id,new.crm_play_benefit_id);
      if coupon_quote.gross_usd is null or coupon_quote.discount_usd is null then
        raise exception 'No se pudo verificar el precio y el límite compartido del cupón.' using errcode='22023';
      end if;
      new.crm_coupon_source_currency:=coupon_quote.source_currency;
      new.crm_coupon_source_amount:=coupon_quote.source_amount;
      new.crm_coupon_discount_usd:=coupon_quote.discount_usd;
      expected_line_total_usd:=coupon_quote.net_usd;
    else
      new.crm_coupon_source_currency:=null; new.crm_coupon_source_amount:=null; new.crm_coupon_discount_usd:=null;
    end if;
    expected_line_total_usd := pg_catalog.round(greatest(0, expected_line_total_usd), 2);$patch$);
  if changed=s or position('coupon_quote.net_usd' in changed)=0 then raise exception 'CRM item guard changed; coupon patch not applied'; end if;
  execute changed;

  select pg_get_functiondef('app_private.crm_play_redemption_guard_v1()'::regprocedure) into s;
  changed:=replace(s,'  lifecycle_time timestamptz;',E'  lifecycle_time timestamptz;\n  coupon_cap numeric;\n  coupon_quote record;\n  coupon_item record;');
  changed:=replace(changed,'      or new.created_at is distinct from old.created_at',E'      or new.coupon_source_currency is distinct from old.coupon_source_currency\n      or new.coupon_source_amount is distinct from old.coupon_source_amount\n      or new.created_at is distinct from old.created_at');
  changed:=replace(changed,'  if new.order_item_id is null or not exists (',$patch$
  coupon_cap:=app_private.crm_coupon_cap_v1(member_row.play_id);
  if coupon_cap is not null then
    select * into coupon_item from public.order_items where id=new.order_item_id and order_id=new.order_id;
    expected_line_total:=coupon_item.line_total_usd;
    if coupon_item.crm_coupon_discount_usd is null then raise exception 'La línea no contiene un cupón válido.'; end if;
  end if;
  if new.order_item_id is null or not exists ($patch$);
  changed:=replace(changed,'  new.company_cost_usd := pg_catalog.round(option_row.unit_company_cost_usd * option_row.quantity, 2);',$patch$
  new.company_cost_usd := pg_catalog.round(option_row.unit_company_cost_usd * option_row.quantity, 2);
  if coupon_cap is not null then
    select * into coupon_quote from app_private.crm_coupon_quote_v1(new.order_id,new.play_member_id,new.play_benefit_id);
    new.benefit_value_usd:=coupon_item.crm_coupon_discount_usd;
    new.benefit_credit_usd:=new.benefit_value_usd;
    new.advisor_charge_usd:=round((coupon_quote.prior_discount_usd+new.benefit_credit_usd)*option_row.unit_advisor_cost_usd/coupon_cap,2)
      -round(coupon_quote.prior_discount_usd*option_row.unit_advisor_cost_usd/coupon_cap,2);
    new.company_cost_usd:=new.benefit_credit_usd-new.advisor_charge_usd;
    new.coupon_source_currency:=coupon_item.crm_coupon_source_currency;
    new.coupon_source_amount:=coupon_item.crm_coupon_source_amount;
  end if;$patch$);
  if changed=s or position('new.coupon_source_amount:=' in changed)=0 then raise exception 'CRM redemption guard changed; coupon patch not applied'; end if;
  execute changed;

  -- CRM guard runs before these catalog guards and supplies the certified net price.
  foreach s in array array['public.trg_order_items_pricing_guard()','public.trg_order_items_set_pricing()'] loop
    select pg_get_functiondef(s::regprocedure) into changed;
    changed:=replace(changed,E'begin\n',E'begin\n  if new.crm_play_member_id is not null and new.crm_coupon_source_currency is not null then return new; end if;\n');
    if position('new.crm_coupon_source_currency is not null' in changed)=0 then raise exception 'Coupon pricing patch failed'; end if;
    execute changed;
  end loop;
end $migration$;

create or replace function app_private.crm_coupon_reprice_reservation_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  if new.crm_coupon_source_currency is null or
    (new.crm_coupon_discount_usd,new.line_total_usd) is not distinct from (old.crm_coupon_discount_usd,old.line_total_usd) then return new; end if;
  if exists(select 1 from public.crm_play_redemptions where order_item_id=old.id and status='redeemed') then
    raise exception 'Un cupón entregado conserva sus importes; requiere el flujo de corrección del administrador.' using errcode='55000';
  end if;
  actor:=coalesce(auth.uid(),(select attributed_advisor_id from public.orders where id=new.order_id));
  update public.crm_play_redemptions set status='voided',voided_at=now(),void_reason='Recalculo del limite compartido del cupon'
    where order_item_id=new.id and status='reserved';
  insert into public.crm_play_redemptions(play_member_id,play_benefit_id,order_id,order_item_id,product_id,quantity,status,reserved_by_user_id,reserved_at)
    values(new.crm_play_member_id,new.crm_play_benefit_id,new.order_id,new.id,new.product_id,new.qty,'reserved',actor,now());
  return new;
end $$;
create trigger crm_coupon_reservation_update after update on public.order_items
for each row when (new.crm_play_member_id is not null) execute function app_private.crm_coupon_reprice_reservation_v1();

create or replace function app_private.crm_coupon_deferred_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare order_key bigint; member_key bigint; cap numeric; q record; it record; used numeric; channel text;
begin
  if tg_table_name='orders' then order_key:=new.id;
  elsif tg_op='DELETE' then order_key:=old.order_id;
  else order_key:=new.order_id; end if;
  perform 1 from public.orders where id=order_key for update;
  select fulfillment::text into channel from public.orders where id=order_key;
  for member_key in select distinct i.crm_play_member_id from public.order_items i
    join public.crm_play_members m on m.id=i.crm_play_member_id
    where i.order_id=order_key and app_private.crm_coupon_cap_v1(m.play_id) is not null loop
    perform pg_advisory_xact_lock(hashtextextended('crm-play-member:'||member_key,0));
    select app_private.crm_coupon_cap_v1(play_id) into cap from public.crm_play_members where id=member_key;
    select sum(crm_coupon_discount_usd) into used from public.order_items where order_id=order_key and crm_play_member_id=member_key;
    if used is null or used>cap+0.001 then raise exception 'El cupón supera su límite compartido.' using errcode='22023'; end if;
    if (select count(*) from public.order_items i join public.products p on p.id=i.product_id where i.order_id=order_key and i.crm_play_member_id=member_key and p.name ~* '^Delivery Zona [1-7]$')>1
      or (channel<>'delivery' and exists(select 1 from public.order_items i join public.products p on p.id=i.product_id where i.order_id=order_key and i.crm_play_member_id=member_key and p.name ~* '^Delivery Zona [1-7]$')) then
      raise exception 'El cupón admite un solo envío y requiere un pedido de tipo delivery.' using errcode='22023';
    end if;
    for it in select * from public.order_items where order_id=order_key and crm_play_member_id=member_key loop
      select * into q from app_private.crm_coupon_quote_v1(order_key,member_key,it.crm_play_benefit_id);
      if q.discount_usd is null or abs(it.crm_coupon_discount_usd-q.discount_usd)>0.001 or abs(it.line_total_usd-q.net_usd)>0.001 then
        raise exception 'Recalcula el cupón después de cambiar las bebidas o el delivery.' using errcode='22023';
      end if;
    end loop;
  end loop;
  return null;
end $$;
create constraint trigger crm_coupon_shared_limit after insert or update or delete on public.order_items
deferrable initially deferred for each row execute function app_private.crm_coupon_deferred_guard_v1();
create constraint trigger crm_coupon_order_channel after update on public.orders
deferrable initially deferred for each row when (old.fulfillment is distinct from new.fulfillment)
execute function app_private.crm_coupon_deferred_guard_v1();

-- A draft may keep undecided costs, but it cannot be confirmed or used with them.
do $migration$
declare s text; changed text;
begin
  select pg_get_functiondef('public.crm_confirm_play_v1(bigint)'::regprocedure) into s;
  changed:=replace(s,'  active_rate := public.get_active_exchange_rate();',$patch$
  if play_row.rules_snapshot ? 'coupon_draft' then
    if app_private.crm_coupon_cap_v1(p_play_id) is null or app_private.crm_coupon_cap_v1(p_play_id)<=0
      or play_row.benefit_recurrence_mode<>'once' or play_row.benefit_selection_mode<>'multiple'
      or coalesce(play_row.rules_snapshot#>>'{coupon_draft,execution_support}','')<>'shared_cap_v1'
      or coalesce(play_row.rules_snapshot#>>'{coupon_draft,economics,review_status}','pending')<>'approved' then
      raise exception 'Revisa y confirma los costos del cupón antes de confirmar la jugada.' using errcode='55000';
    end if;
    if nullif(play_row.rules_snapshot#>>'{coupon_draft,economics,advisor_contribution_usd}','') is null
      or nullif(play_row.rules_snapshot#>>'{coupon_draft,economics,company_contribution_usd}','') is null
      or (play_row.rules_snapshot#>>'{coupon_draft,economics,advisor_contribution_usd}')::numeric<0
      or (play_row.rules_snapshot#>>'{coupon_draft,economics,company_contribution_usd}')::numeric<0
      or round((play_row.rules_snapshot#>>'{coupon_draft,economics,advisor_contribution_usd}')::numeric
        +(play_row.rules_snapshot#>>'{coupon_draft,economics,company_contribution_usd}')::numeric,2)<>app_private.crm_coupon_cap_v1(p_play_id) then
      raise exception 'Los aportes de empresa y asesor deben completar el límite del cupón.';
    end if;
    if exists(select 1 from public.crm_play_benefits b where b.play_id=p_play_id and
      (app_private.crm_coupon_product_v1(b.product_id) is not true or b.quantity<>1
       or b.unit_benefit_value_usd<>app_private.crm_coupon_cap_v1(p_play_id)
       or b.unit_advisor_cost_usd<>(play_row.rules_snapshot#>>'{coupon_draft,economics,advisor_contribution_usd}')::numeric
       or b.unit_company_cost_usd<>(play_row.rules_snapshot#>>'{coupon_draft,economics,company_contribution_usd}')::numeric)) then
      raise exception 'La configuración de productos y costos del cupón no coincide con su límite.';
    end if;
  end if;
  active_rate := public.get_active_exchange_rate();$patch$);
  if changed=s then raise exception 'CRM confirm guard changed; coupon patch not applied'; end if;
  execute changed;
end $migration$;

create or replace function public.crm_prepare_coupon_selection_v1(p_member bigint,p_benefits bigint[],p_order bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode='42501'; end if;
  if p_order is not null and not exists(select 1 from public.orders o join public.crm_play_members m
    on m.id=p_member and m.client_id=o.client_id and m.advisor_id_snapshot=o.attributed_advisor_id
    where o.id=p_order and o.status::text not in ('delivered','cancelled') and
    (o.attributed_advisor_id=auth.uid() or public.is_master_or_admin())) then
    raise exception 'El cupón no corresponde al pedido que estás modificando.' using errcode='42501';
  end if;
  perform set_config('app.crm_coupon_order',coalesce(p_order::text,''),true);
  result:=public.crm_set_play_benefits_v2(p_member,p_benefits);
  perform set_config('app.crm_coupon_order','',true);
  return result;
end $$;
revoke all on function public.crm_prepare_coupon_selection_v1(bigint,bigint[],bigint) from public,anon;
grant execute on function public.crm_prepare_coupon_selection_v1(bigint,bigint[],bigint) to authenticated;

do $migration$
declare s text; changed text;
begin
  select pg_get_functiondef('public.crm_set_play_benefits_v2(bigint,bigint[])'::regprocedure) into s;
  changed:=replace(s,'  select pg_catalog.array_agg(option_id order by sort_order, option_id)',$patch$
  if app_private.crm_coupon_cap_v1(member_row.play_id) is not null and exists(
    select 1 from public.crm_play_redemptions r where r.play_member_id=p_play_member_id and r.status in ('reserved','redeemed')
    and (r.status='redeemed' or r.order_id is distinct from nullif(current_setting('app.crm_coupon_order',true),'')::bigint)
  ) then raise exception 'Este cupón ya está reservado o entregado en otra orden.' using errcode='23505'; end if;
  select pg_catalog.array_agg(option_id order by sort_order, option_id)$patch$);
  if s=changed then raise exception 'CRM selection guard changed; coupon patch not applied'; end if;
  execute changed;
  select pg_get_functiondef('public.crm_refresh_play_preview_summary_v1(bigint)'::regprocedure) into s;
  changed:=replace(s,'  select pg_catalog.jsonb_build_object(',$patch$
  if play_rules ? 'coupon_draft' then
    value_min:=0; value_max:=(play_rules#>>'{coupon_draft,maximum_discount_usd}')::numeric;
    company_min:=0; advisor_min:=0;
    if coalesce(play_rules#>>'{coupon_draft,economics,review_status}','pending')='approved' then
      company_max:=(play_rules#>>'{coupon_draft,economics,company_contribution_usd}')::numeric;
      advisor_max:=(play_rules#>>'{coupon_draft,economics,advisor_contribution_usd}')::numeric;
    else company_max:=null; advisor_max:=null; end if;
  end if;
  select pg_catalog.jsonb_build_object($patch$);
  if s=changed then raise exception 'CRM preview summary changed; coupon patch not applied'; end if;
  execute changed;
end $migration$;

revoke all on function app_private.crm_coupon_cap_v1(bigint), app_private.crm_coupon_product_v1(bigint),
  app_private.crm_coupon_quote_v1(bigint,bigint,bigint),app_private.crm_coupon_reprice_reservation_v1(),
  app_private.crm_coupon_deferred_guard_v1() from public,anon,authenticated;
