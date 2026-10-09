-- Stage 3: inactive until the audited catalog cutover. No historical order is
-- enrolled, and no browser flag can choose a collection rule.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $guard$ begin
  if md5(pg_get_functiondef('get_order_financial_state(bigint,date,numeric)'::regprocedure)) <> '2ff19668e28b81ef3c3d21174425e8f0' then
    raise exception 'Financial definition changed: get_order_financial_state(bigint,date,numeric)'; end if;
  if md5(pg_get_functiondef('counter_read_payment_quote(bigint,date)'::regprocedure)) <> '6ac63c220d806cf3c33fa491c2dec6ac' then
    raise exception 'Financial definition changed: counter_read_payment_quote(bigint,date)'; end if;
  if md5(pg_get_functiondef('order_collection_precision_basis_v1(bigint)'::regprocedure)) <> 'd70a555b814aa441b0a31ec6436911a6' then
    raise exception 'Financial definition changed: order_collection_precision_basis_v1(bigint)'; end if;
  if md5(pg_get_functiondef('app_private.capture_order_payment_precision_v1()'::regprocedure)) <> 'bc03ebea4872b1855b41367aa1f19761' then
    raise exception 'Financial definition changed: app_private.capture_order_payment_precision_v1()'; end if;
  if md5(pg_get_functiondef('app_private.reserve_draft_conversion_prices_v1(bigint,bigint,jsonb)'::regprocedure)) <> 'd25642e51dbbaaeef77ca83e8e11210e' then
    raise exception 'Financial definition changed: app_private.reserve_draft_conversion_prices_v1(bigint,bigint,jsonb)'; end if;
end; $guard$;

create table app_private.usd_catalog_cutover_v1 (
  singleton boolean primary key default true check(singleton),
  activated_at timestamptz,
  rule_version text not null default 'native_usd_v1' check(rule_version='native_usd_v1')
);
insert into app_private.usd_catalog_cutover_v1(singleton) values(true);
create table app_private.native_usd_orders_v1 (
  order_id bigint primary key references public.orders(id) on delete cascade,
  created_at timestamptz not null default statement_timestamp()
);
create table app_private.native_usd_drafts_v1 (
  draft_id bigint primary key references public.advisor_order_drafts(id) on delete cascade,
  created_at timestamptz not null default statement_timestamp()
);
alter table app_private.usd_catalog_cutover_v1 enable row level security;
alter table app_private.native_usd_orders_v1 enable row level security;
alter table app_private.native_usd_drafts_v1 enable row level security;
revoke all on app_private.usd_catalog_cutover_v1,app_private.native_usd_orders_v1,
  app_private.native_usd_drafts_v1 from public,anon,authenticated,service_role;

create function app_private.stamp_native_usd_creation_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  -- Serialize the entire creation transaction with the catalog activation.
  perform pg_catalog.pg_advisory_xact_lock_shared(20261009,1);
  if exists(select 1 from app_private.usd_catalog_cutover_v1 where activated_at is not null) then
    if tg_table_name='orders' then
      insert into app_private.native_usd_orders_v1(order_id) values(new.id);
    else
      insert into app_private.native_usd_drafts_v1(draft_id) values(new.id);
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function app_private.stamp_native_usd_creation_v1() from public,anon,authenticated,service_role;
create trigger native_usd_creation_v1 after insert on public.orders
  for each row execute function app_private.stamp_native_usd_creation_v1();
create trigger native_usd_creation_v1 after insert on public.advisor_order_drafts
  for each row execute function app_private.stamp_native_usd_creation_v1();

create function app_private.order_uses_current_usd_v1(p_order bigint)
returns boolean language sql stable security definer set search_path='' as $function$
  select exists(select 1 from app_private.native_usd_orders_v1 n join public.orders o on o.id=n.order_id
    where n.order_id=p_order and (auth.role()='service_role' or (auth.uid() is not null and
      (public.is_master_or_admin() or public.has_role('counter') or
        (public.has_role('advisor') and o.attributed_advisor_id=auth.uid())))));
$function$;
revoke all on function app_private.order_uses_current_usd_v1(bigint) from public,anon;
grant execute on function app_private.order_uses_current_usd_v1(bigint) to authenticated,service_role;

do $migration$
declare definition text; anchor text; replacement text;
begin
  -- Only the existing, authorized, locked draft-conversion primitive can
  -- grandfather a newly inserted empty order. Existing drafts have no marker.
  definition:=pg_get_functiondef('app_private.reserve_draft_conversion_prices_v1(bigint,bigint,jsonb)'::regprocedure);
  anchor:='  delete from app_private.draft_conversion_price_context_v1 where order_id=p_order;';
  if position(anchor in definition)=0 then raise exception 'Draft policy anchor changed'; end if;
  replacement:=E'  if not exists(select 1 from app_private.native_usd_drafts_v1 where draft_id=p_draft) then\n    delete from app_private.native_usd_orders_v1 where order_id=p_order;\n  end if;\n'||anchor;
  execute replace(definition,anchor,replacement);

  definition:=pg_get_functiondef('public.order_collection_precision_basis_v1(bigint)'::regprocedure);
  anchor:='select o.*, o.extra_fields->''pricing'' as pricing,';
  if position(anchor in definition)=0 then raise exception 'Precise basis anchor changed'; end if;
  definition:=replace(definition,anchor,'select o.*, app_private.order_uses_current_usd_v1(o.id) as native_usd, o.extra_fields->''pricing'' as pricing,');
  anchor:='when all_ves then header_bs/fx else precise-discount_usd+tax_usd end';
  if position(anchor in definition)=0 then raise exception 'Precise currency anchor changed'; end if;
  definition:=replace(definition,anchor,'when native_usd then header_usd when all_ves then header_bs/fx else precise-discount_usd+tax_usd end');
  anchor:='and (enrolled or (';
  if position(anchor in definition)=0 then raise exception 'Precise enrollment anchor changed'; end if;
  execute replace(definition,anchor,'and (native_usd or enrolled or (');

  definition:=pg_get_functiondef('public.get_order_financial_state(bigint,date,numeric)'::regprocedure);
  anchor:='select adjusted.*, precision.total_precise_usd,';
  if position(anchor in definition)=0 then raise exception 'Canonical policy anchor changed'; end if;
  definition:=replace(definition,anchor,E'select adjusted.*, app_private.order_uses_current_usd_v1(adjusted.order_id) as native_usd,\n    coalesce(p_active_bs_rate,(select rate_bs_per_usd from public.exchange_rates where is_active order by effective_at desc limit 1)) as current_rate, precision.total_precise_usd,');
  anchor:='raw.total_precise_usd is null';
  if position(anchor in definition)=0 then raise exception 'Canonical closure anchor changed'; end if;
  definition:=replace(definition,anchor,'not raw.native_usd and raw.total_precise_usd is null');
  anchor:='when canonical.canonical_pending_usd <= 0.005 then 0';
  if position(anchor in definition)=0 then raise exception 'Canonical Bs anchor changed'; end if;
  definition:=replace(definition,anchor,anchor||E'\n    when canonical.native_usd then case when canonical.current_rate>0 and canonical.current_rate::text not in (''NaN'',''Infinity'',''-Infinity'')\n      then round(canonical.canonical_pending_usd*canonical.current_rate,2) else null end');
  anchor:='when canonical.canonical_pending_usd <= 0.005 then ''closed''';
  if position(anchor in definition)=0 then raise exception 'Canonical mode anchor changed'; end if;
  definition:=replace(definition,anchor,anchor||E'\n    when canonical.native_usd then ''native_usd''');
  execute definition;

  definition:=pg_get_functiondef('app_private.capture_order_payment_precision_v1()'::regprocedure);
  anchor:='when v_state.delivery_reference_date is null or new.movement_date<=v_state.delivery_reference_date';
  if position(anchor in definition)=0 then raise exception 'Payment coverage anchor changed'; end if;
  definition:=replace(definition,anchor,E'when app_private.order_uses_current_usd_v1(new.order_id) then new.exchange_rate_ves_per_usd\n    '||anchor);
  execute definition;

  definition:=pg_get_functiondef('public.counter_read_payment_quote(bigint,date)'::regprocedure);
  anchor:='v_state.collection_mode = ''post_delivery_usd''';
  if position(anchor in definition)=0 then raise exception 'Counter quote anchor changed'; end if;
  execute replace(definition,anchor,'v_state.collection_mode in (''post_delivery_usd'',''native_usd'')');
end;
$migration$;
commit;
