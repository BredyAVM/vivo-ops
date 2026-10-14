-- Reward funding is not cash, a customer balance, or a CRM entitlement.
-- Applied version recorded by the project migration service.
alter table public.advisor_reward_grants add column reserved_amount numeric(12,2) not null default 0,
  add column used_amount numeric(12,2) not null default 0,
  add constraint reward_balances_valid check(reserved_amount>=0 and used_amount>=0 and reserved_amount+used_amount<=amount);
alter table public.order_items add column reward_grant_id bigint references public.advisor_reward_grants(id),
  add column reward_purpose text,
  add column reward_amount_usd numeric(12,2),
  add column reward_base_line_usd numeric(12,2),
  add column reward_base_line_bs numeric(16,2),
  add constraint reward_item_link_complete check((reward_grant_id is null and reward_purpose is null and reward_amount_usd is null
    and reward_base_line_usd is null and reward_base_line_bs is null)
    or (reward_grant_id is not null and reward_purpose is not null and reward_purpose in ('customer_gift','personal_purchase')
      and reward_amount_usd is not null and reward_base_line_usd is not null and reward_base_line_bs is not null
      and reward_amount_usd>0 and reward_base_line_usd>=reward_amount_usd and reward_base_line_bs>=0));
create index order_items_reward_idx on public.order_items(reward_grant_id) where reward_grant_id is not null;

-- An administrator identifies the advisor's own customer record explicitly.
-- Profiles have no phone field; do not guess identity from a name or a purchase.
create table public.advisor_reward_personal_clients(
  advisor_id uuid primary key references public.profiles(id),
  client_id bigint not null unique references public.clients(id),
  assigned_by uuid not null references public.profiles(id),
  assigned_at timestamptz not null default statement_timestamp()
);
alter table public.advisor_reward_personal_clients enable row level security;
create policy reward_personal_client_read on public.advisor_reward_personal_clients for select to authenticated
  using(advisor_id=(select auth.uid()) or (select public.is_admin()));
revoke all on public.advisor_reward_personal_clients from public,anon,authenticated;
grant select on public.advisor_reward_personal_clients to authenticated;
grant all on public.advisor_reward_personal_clients to service_role;
create function app_private.reward_require_actor_v1() returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and is_active) then
    raise exception 'Debes iniciar sesión con un usuario activo para utilizar premios.' using errcode='42501'; end if;
end; $$;
revoke all on function app_private.reward_require_actor_v1() from public,anon,authenticated;
create function public.reward_set_personal_client_v1(p_advisor uuid,p_client bigint) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform app_private.reward_require_actor_v1();
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo administración puede vincular el consumo propio.' using errcode='42501'; end if;
  perform 1 from public.profiles where id=p_advisor and is_active for update;
  if not found or not exists(select 1 from public.user_roles where user_id=p_advisor and role='advisor')
    or not exists(select 1 from public.clients where id=p_client) then raise exception 'Selecciona un asesor y cliente válidos.'; end if;
  if exists(select 1 from public.advisor_reward_uses where advisor_id=p_advisor and purpose='personal_purchase' and status='reserved') then
    raise exception 'Libera primero los pedidos personales reservados.'; end if;
  insert into public.advisor_reward_personal_clients(advisor_id,client_id,assigned_by) values(p_advisor,p_client,auth.uid())
    on conflict(advisor_id) do update set client_id=excluded.client_id,assigned_by=excluded.assigned_by,assigned_at=statement_timestamp();
end; $$;
revoke all on function public.reward_set_personal_client_v1(uuid,bigint) from public,anon;
grant execute on function public.reward_set_personal_client_v1(uuid,bigint) to authenticated;

create table public.advisor_reward_uses(
  id bigint generated always as identity primary key,
  grant_id bigint not null references public.advisor_reward_grants(id),
  advisor_id uuid not null references public.profiles(id),
  order_id bigint references public.orders(id),
  order_item_id bigint unique, -- immutable evidence survives an item rebuild/removal
  client_id bigint references public.clients(id),
  client_name_snapshot text,
  product_id bigint references public.products(id),
  product_name_snapshot text,
  commission_closure_id bigint references public.advisor_commission_closures(id),
  request_token uuid unique,
  purpose text not null check(purpose in ('customer_gift','personal_purchase','advisor_debt')),
  amount numeric(12,2) not null check(amount>0),
  funded_usd numeric(12,2) not null check(funded_usd>0),
  status text not null check(status in ('reserved','used','released')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  check((purpose='advisor_debt' and commission_closure_id is not null and request_token is not null
    and order_id is null and order_item_id is null and client_id is null and product_id is null)
    or (purpose<>'advisor_debt' and commission_closure_id is null and request_token is null
      and order_id is not null and order_item_id is not null and client_id is not null and product_id is not null))
);
create index reward_uses_grant_status_idx on public.advisor_reward_uses(grant_id,status);
create index reward_uses_order_idx on public.advisor_reward_uses(order_id) where order_id is not null;
create index reward_uses_owner_idx on public.advisor_reward_uses(advisor_id,id desc);
create index reward_uses_client_idx on public.advisor_reward_uses(client_id) where client_id is not null;
create index reward_uses_product_idx on public.advisor_reward_uses(product_id) where product_id is not null;
create index reward_uses_actor_idx on public.advisor_reward_uses(created_by);
create index reward_uses_closure_idx on public.advisor_reward_uses(commission_closure_id) where commission_closure_id is not null;
create table public.advisor_reward_use_events(
  id bigint generated always as identity primary key,
  use_id bigint not null references public.advisor_reward_uses(id),
  advisor_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  event_type text not null check(event_type in ('reserved','used','released','reversed')),
  amount numeric(12,2) not null check(amount>0),
  reason text not null,
  created_at timestamptz not null default statement_timestamp()
);
create index reward_use_events_use_idx on public.advisor_reward_use_events(use_id,id);
create index reward_use_events_owner_idx on public.advisor_reward_use_events(advisor_id,id desc);
create index reward_use_events_actor_idx on public.advisor_reward_use_events(actor_id);
alter table public.advisor_reward_uses enable row level security;
alter table public.advisor_reward_use_events enable row level security;
create policy reward_uses_read on public.advisor_reward_uses for select to authenticated
  using(advisor_id=(select auth.uid()) or (select public.is_admin()));
create policy reward_use_events_read on public.advisor_reward_use_events for select to authenticated
  using(advisor_id=(select auth.uid()) or (select public.is_admin()));
revoke all on public.advisor_reward_uses,public.advisor_reward_use_events from public,anon,authenticated;
grant select on public.advisor_reward_uses,public.advisor_reward_use_events to authenticated;
grant all on public.advisor_reward_uses,public.advisor_reward_use_events to service_role;
revoke all on sequence public.advisor_reward_uses_id_seq,public.advisor_reward_use_events_id_seq from public,anon,authenticated;
grant all on sequence public.advisor_reward_uses_id_seq,public.advisor_reward_use_events_id_seq to service_role;

create function public.reward_lock_order_grants_v1(p_order bigint,p_items jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare ord public.orders%rowtype; g_id bigint;
begin
  perform app_private.reward_require_actor_v1();
  select * into ord from public.orders where id=p_order for update;
  if auth.uid() is null or ord.id is null or not(public.is_master_or_admin() or
    (public.has_role('advisor') and ord.attributed_advisor_id=auth.uid())) then raise exception 'No puedes reservar premios para este pedido.' using errcode='42501'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>200 then raise exception 'Lista de productos inválida.'; end if;
  for g_id in select distinct id from (
    select nullif(j->>'reward_grant_id','')::bigint id from jsonb_array_elements(p_items) j
    union select grant_id from public.advisor_reward_uses where order_id=p_order and status in ('reserved','used')
  ) q where id is not null order by id loop
    perform 1 from public.advisor_reward_grants where id=g_id and advisor_id=ord.attributed_advisor_id for update;
    if not found then raise exception 'Premio no disponible para este asesor.' using errcode='42501'; end if;
  end loop;
end; $$;
revoke all on function public.reward_lock_order_grants_v1(bigint,jsonb) from public,anon;
grant execute on function public.reward_lock_order_grants_v1(bigint,jsonb) to authenticated;

create function app_private.reward_use_guard_v1() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or auth.uid() is null or current_setting('app.reward_use_command',true) is distinct from 'lifecycle' then
    raise exception 'Los movimientos del premio solo cambian mediante el proceso autorizado.' using errcode='42501'; end if;
  if tg_op='UPDATE' and (to_jsonb(new)-array['status','updated_at']) is distinct from (to_jsonb(old)-array['status','updated_at']) then
    raise exception 'La evidencia del consumo no se puede reescribir.'; end if;
  if tg_op='UPDATE' and new.status is distinct from old.status and not
    ((old.status='reserved' and new.status in ('used','released')) or (old.status='used' and new.status='released')) then
    raise exception 'Transición de premio no permitida.'; end if;
  return new;
end; $$;
create trigger reward_use_guard before insert or update or delete on public.advisor_reward_uses
  for each row execute function app_private.reward_use_guard_v1();
create function app_private.reward_use_event_guard_v1() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op<>'INSERT' or auth.uid() is null or new.actor_id<>auth.uid()
    or current_setting('app.reward_use_command',true) is distinct from 'lifecycle' then raise exception 'El historial del premio es inmutable.'; end if;
  return new;
end; $$;
create trigger reward_use_event_guard before insert or update or delete on public.advisor_reward_use_events
  for each row execute function app_private.reward_use_event_guard_v1();

-- Only operational balances may change; original amount and terms stay immutable.
do $$ declare definition text; anchor text:='  if tg_op=''DELETE'''; begin
  definition:=pg_get_functiondef('app_private.reward_grant_guard_v1()'::regprocedure);
  if strpos(definition,anchor)=0 then raise exception 'El guard del premio cambió.'; end if;
  execute replace(definition,anchor,$guard$
  if tg_op='UPDATE' and auth.uid() is not null and current_setting('app.reward_balance_command',true)='refresh' then
    if (to_jsonb(new)-array['reserved_amount','used_amount']) is distinct from (to_jsonb(old)-array['reserved_amount','used_amount'])
      or new.reserved_amount is distinct from (select coalesce(sum(u.amount),0) from public.advisor_reward_uses u where u.grant_id=old.id and u.status='reserved')
      or new.used_amount is distinct from (select coalesce(sum(u.amount),0) from public.advisor_reward_uses u where u.grant_id=old.id and u.status='used') then
      raise exception 'El saldo no coincide con los movimientos certificados.'; end if;
    return new;
  end if;
$guard$||anchor);
end; $$;
create function app_private.reward_refresh_balance_v1(p_grant bigint) returns void language plpgsql security definer set search_path='' as $$
begin
  perform set_config('app.reward_balance_command','refresh',true);
  update public.advisor_reward_grants g set
    reserved_amount=(select coalesce(sum(u.amount),0) from public.advisor_reward_uses u where u.grant_id=g.id and u.status='reserved'),
    used_amount=(select coalesce(sum(u.amount),0) from public.advisor_reward_uses u where u.grant_id=g.id and u.status='used') where g.id=p_grant;
end; $$;

create function app_private.reward_price_item_v1(p_new public.order_items,p_old public.order_items,p_operation text)
returns public.order_items language plpgsql security definer set search_path='' as $$
declare item public.order_items:=p_new; ord public.orders%rowtype; gift public.advisor_reward_grants%rowtype;
  prod public.products%rowtype; fx numeric; gross numeric; gross_bs numeric; funded numeric; consumed numeric;
  delivery_day date;
begin
  perform app_private.reward_require_actor_v1();
  select * into ord from public.orders where id=item.order_id for update;
  if auth.uid() is null or ord.id is null or not (public.is_master_or_admin()
    or (public.has_role('advisor') and ord.attributed_advisor_id=auth.uid())) then raise exception 'No puedes aplicar este premio a la orden.' using errcode='42501'; end if;
  if ord.status::text not in ('created','queued','confirmed','in_kitchen','ready')
    or (not public.is_master_or_admin() and (ord.status::text not in ('created','queued') or coalesce(ord.is_price_locked,false))) then
    raise exception 'La orden ya no admite cambios en el premio.' using errcode='55000'; end if;
  select * into gift from public.advisor_reward_grants where id=item.reward_grant_id for update;
  if gift.id is null or gift.advisor_id is distinct from ord.attributed_advisor_id or gift.status<>'active'
    or item.crm_play_member_id is not null or item.crm_play_benefit_id is not null or item.crm_play_benefit_upgrade_id is not null then
    raise exception 'El premio no corresponde al asesor o se está mezclando con una jugada CRM.' using errcode='42501'; end if;
  if item.reward_purpose not in ('customer_gift','personal_purchase') or item.reward_purpose is null
    or not (gift.terms_snapshot->'purposes') ? item.reward_purpose then raise exception 'Este premio no permite ese uso.' using errcode='42501'; end if;
  if item.reward_purpose='personal_purchase' and not exists(select 1 from public.advisor_reward_personal_clients
    where advisor_id=gift.advisor_id and client_id=ord.client_id) then
    raise exception 'Administración debe vincular tu ficha de cliente antes de usar el premio para consumo propio.' using errcode='42501'; end if;
  if item.reward_purpose='customer_gift' and exists(select 1 from public.advisor_reward_personal_clients where advisor_id=gift.advisor_id and client_id=ord.client_id) then
    raise exception 'Tu ficha personal requiere un premio autorizado para consumo propio, no un fondo para obsequiar a clientes.' using errcode='42501'; end if;
  if p_operation='UPDATE' and p_old.reward_grant_id is not null then
    if (to_jsonb(item)-'notes') is distinct from (to_jsonb(p_old)-'notes') then
      raise exception 'Para cambiar el beneficio retira la línea y vuelve a agregarla. No se modifica un consumo existente.'; end if;
    p_old.notes:=item.notes; return p_old;
  end if;
  delivery_day:=coalesce(nullif(ord.extra_fields#>>'{schedule,date}','')::date,(statement_timestamp() at time zone 'America/Caracas')::date);
  if gift.expires_on is not null and (gift.expires_on<(statement_timestamp() at time zone 'America/Caracas')::date or delivery_day>gift.expires_on) then
    raise exception 'El premio está vencido o la fecha del pedido supera su último día.'; end if;
  select * into prod from public.products where id=item.product_id and is_active;
  if prod.id is null or prod.type::text='gambit' or coalesce((prod.extra_fields->>'inventory_component_only')::boolean,false)
    or coalesce(prod.extra_fields->>'catalog_access_scope','') in ('admin_internal','crm_only','gambit_disabled','advisor_gift','advisor_gift_only') then
    raise exception 'Selecciona el producto normal de venta, no un producto exclusivo de jugada.'; end if;
  if gift.terms_snapshot->>'product_scope'='selected_products'
    and not exists(select 1 from jsonb_array_elements_text(gift.terms_snapshot->'allowed_product_ids') x where x::bigint=prod.id) then
    raise exception 'El producto no está permitido por este premio.'; end if;
  if item.qty is null or item.qty<=0 or item.qty::text in ('NaN','Infinity','-Infinity') then raise exception 'Cantidad inválida.'; end if;
  if item.draft_price_agreement_key is not null or item.admin_price_override_usd is not null or item.override_unit_price_usd is not null then
    raise exception 'El premio no se combina con un precio manual ni con un acuerdo de borrador anterior.'; end if;
  fx:=coalesce(item.pricing_fx_rate_snapshot,nullif(ord.extra_fields#>>'{pricing,fx_rate}','')::numeric);
  if fx is null or fx<=0 or fx::text in ('NaN','Infinity','-Infinity') or (fx is distinct from nullif(ord.extra_fields#>>'{pricing,fx_rate}','')::numeric
    and fx is distinct from (select rate_bs_per_usd from public.exchange_rates where is_active order by effective_at desc limit 1)) then raise exception 'Tasa inválida para aplicar el premio.'; end if;
  if prod.source_price_amount is null or prod.source_price_amount<=0 or prod.source_price_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'El producto requiere un precio de catálogo positivo.'; end if;
  if prod.source_price_currency::text='VES' then gross_bs:=round(round(prod.source_price_amount,2)*item.qty,2); gross:=round(gross_bs/fx,2);
  elsif prod.source_price_currency::text='USD' then gross:=round(round(prod.source_price_amount,2)*item.qty,2);gross_bs:=round(gross*fx,2);
  else raise exception 'Moneda de catálogo inválida.'; end if;
  if gift.kind='product_units' then
    if prod.id is distinct from (gift.terms_snapshot->>'product_id')::bigint or item.qty<>trunc(item.qty) then raise exception 'Las unidades solo cubren el producto y cantidad entera del premio.'; end if;
    consumed:=item.qty; funded:=gross;
  else
    funded:=item.reward_amount_usd; consumed:=funded;
    if funded is null or funded<=0 or funded<>round(funded,2) or funded>gross or funded::text in ('NaN','Infinity','-Infinity') then raise exception 'El crédito debe ser positivo y no superar el precio de la línea.'; end if;
  end if;
  if gift.amount-gift.used_amount-gift.reserved_amount<consumed then raise exception 'No hay suficiente premio disponible. Actualiza el monedero.' using errcode='40001'; end if;
  item.reward_amount_usd:=funded;item.reward_base_line_usd:=gross;item.reward_base_line_bs:=gross_bs;
  item.pricing_origin_currency:=prod.source_price_currency::text;item.pricing_origin_amount:=prod.source_price_amount;
  item.pricing_fx_rate_snapshot:=fx;item.product_name_snapshot:=prod.name;item.sku_snapshot:=prod.sku;
  item.line_total_usd:=round(gross-funded,2);
  item.line_total_bs_snapshot:=case when funded=gross then 0 else greatest(0,round(gross_bs-funded*fx,2)) end;
  item.unit_price_usd_snapshot:=round(item.line_total_usd/item.qty,2);item.unit_price_bs_snapshot:=round(item.line_total_bs_snapshot/item.qty,2);
  item.override_unit_price_usd:=null;item.override_reason:=null;item.override_approved_by:=null;item.override_approved_at:=null;
  return item;
end; $$;

-- Reuse the canonical pricing guards, with a fully validated reward branch.
do $$ declare definition text; routine text; anchor text:=E'begin\n'; branch text; begin
  foreach routine in array array['public.trg_order_items_pricing_guard()','public.trg_order_items_set_pricing()'] loop
    definition:=pg_get_functiondef(routine::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'El guard de precios cambió: %',routine; end if;
    branch:=anchor||$branch$
  if new.reward_grant_id is not null then
    -- The later security-definer reward trigger validates ownership, funding and both currencies.
    return new;
  end if;
  if tg_op='UPDATE' and old.reward_grant_id is not null then raise exception 'Retira y vuelve a agregar la línea para quitar el premio.'; end if;
$branch$;
    execute overlay(definition placing branch from strpos(definition,anchor) for length(anchor));
  end loop;
end; $$;

create function app_private.reward_price_trigger_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.reward_grant_id is null then
    if tg_op='UPDATE' and old.reward_grant_id is not null then raise exception 'Retira la línea para quitar el premio.'; end if;
    return new;
  end if;
  return app_private.reward_price_item_v1(new,case when tg_op='UPDATE' then old else null::public.order_items end,tg_op);
end; $$;
create trigger reward_price_validate before insert or update on public.order_items
  for each row execute function app_private.reward_price_trigger_v1();

-- Extend only the structured item input. All original role, stale-edit, pricing,
-- inventory, CRM, fund and creation-idempotency logic stays in the canonical commands.
do $$ declare definition text; anchor text; begin
  definition:=pg_get_functiondef('public.advisor_create_order_atomic_v1(uuid,bigint,public.fulfillment_type,numeric,numeric,text,text,text,text,jsonb,jsonb,bigint)'::regprocedure);
  anchor:=E'    draft_price_agreement_key\n  )';
  if strpos(definition,anchor)=0 or strpos(definition,E'    input.draft_price_agreement_key\n  from')=0
    or strpos(definition,E'    draft_price_agreement_key text\n  );')=0 then raise exception 'La creación de órdenes cambió; revisa la integración del monedero.'; end if;
  definition:=replace(definition,anchor,E'    draft_price_agreement_key, reward_grant_id, reward_purpose, reward_amount_usd\n  )');
  definition:=replace(definition,E'    input.draft_price_agreement_key\n  from',E'    input.draft_price_agreement_key, input.reward_grant_id, input.reward_purpose, input.reward_amount_usd\n  from');
  definition:=replace(definition,E'    draft_price_agreement_key text\n  );',E'    draft_price_agreement_key text, reward_grant_id bigint, reward_purpose text, reward_amount_usd numeric\n  );');
  anchor:='  insert into public.order_items';
  if strpos(definition,anchor)=0 then raise exception 'No se encontró la inserción canónica de productos.'; end if;
  definition:=replace(definition,anchor,E'  perform public.reward_lock_order_grants_v1(v_order_id,p_items);\n'||anchor);
  execute definition;
  definition:=pg_get_functiondef('app_private.update_order_core_atomic_v1(bigint,timestamptz,jsonb,jsonb)'::regprocedure);
  anchor:=E'        crm_play_benefit_upgrade_id\n      )';
  if strpos(definition,anchor)=0 or strpos(definition,E'        nullif(v_item ->> ''crm_play_benefit_upgrade_id'', '''')::bigint\n      )')=0
    or strpos(definition,'  -- All other ordinary rows follow the original atomic rebuild and CRM guard.')=0 then raise exception 'El editor de órdenes cambió; revisa la integración del monedero.'; end if;
  definition:=replace(definition,anchor,E'        crm_play_benefit_upgrade_id, reward_grant_id, reward_purpose, reward_amount_usd\n      )');
  definition:=replace(definition,E'        nullif(v_item ->> ''crm_play_benefit_upgrade_id'', '''')::bigint\n      )',
    E'        nullif(v_item ->> ''crm_play_benefit_upgrade_id'', '''')::bigint,\n        nullif(v_item ->> ''reward_grant_id'','''')::bigint,\n        nullif(v_item ->> ''reward_purpose'',''''),\n        nullif(v_item ->> ''reward_amount_usd'','''')::numeric\n      )');
  definition:=replace(definition,'  -- All other ordinary rows follow the original atomic rebuild and CRM guard.',$retention$
  -- Retain a reward line only when its entitlement and quantity are unchanged.
  -- Rebuilds release the previous reservation before the new one is validated.
  v_preserved_legacy_ids:=array(select distinct retained from unnest(v_preserved_legacy_ids) retained
    where not exists(select 1 from public.order_items i where i.id=retained and i.reward_grant_id is not null)
      or exists(select 1 from public.order_items i join jsonb_array_elements(p_items) incoming(value)
        on nullif(incoming.value->>'order_item_id','')::bigint=i.id where i.id=retained
          and i.reward_grant_id is not distinct from nullif(incoming.value->>'reward_grant_id','')::bigint
          and i.reward_purpose is not distinct from nullif(incoming.value->>'reward_purpose','')
          and i.reward_amount_usd is not distinct from nullif(incoming.value->>'reward_amount_usd','')::numeric
          and i.product_id=(incoming.value->>'product_id')::bigint and i.qty=(incoming.value->>'qty')::numeric));
  -- All other ordinary rows follow the original atomic rebuild and CRM guard.
$retention$);
  definition:=replace(definition,'  -- Retain a reward line only',E'  perform public.reward_lock_order_grants_v1(p_order_id,p_items);\n  -- Retain a reward line only');
  execute definition;
end; $$;

create function app_private.reward_item_lifecycle_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare g public.advisor_reward_grants%rowtype; usage public.advisor_reward_uses%rowtype; o public.orders%rowtype; v_amount numeric;
begin
  if tg_op='DELETE' then
    if old.reward_grant_id is null then return old; end if;
    select * into o from public.orders where id=old.order_id for update;
    if auth.uid() is null or not (public.is_master_or_admin() or (public.has_role('advisor') and o.attributed_advisor_id=auth.uid())) then
      raise exception 'No puedes liberar este premio.' using errcode='42501'; end if;
    if not public.is_master_or_admin() and (o.status::text not in ('created','queued') or coalesce(o.is_price_locked,false)) then
      raise exception 'La orden ya no admite retirar el premio.' using errcode='55000'; end if;
    select * into g from public.advisor_reward_grants where id=old.reward_grant_id for update;
    select * into usage from public.advisor_reward_uses where order_item_id=old.id for update;
    if usage.status='used' then raise exception 'El obsequio entregado no puede quitarse de una orden.'; end if;
    if usage.status='reserved' then
      perform set_config('app.reward_use_command','lifecycle',true);
      update public.advisor_reward_uses set status='released',updated_at=statement_timestamp() where id=usage.id;
      insert into public.advisor_reward_use_events(use_id,advisor_id,actor_id,event_type,amount,reason)
        values(usage.id,usage.advisor_id,auth.uid(),'released',usage.amount,'Premio liberado al retirar o reconstruir la línea del pedido.');
      perform app_private.reward_refresh_balance_v1(g.id);
    end if;
    return old;
  end if;
  if new.reward_grant_id is null or tg_op='UPDATE' then return new; end if;
  select * into o from public.orders where id=new.order_id for update;
  select * into g from public.advisor_reward_grants where id=new.reward_grant_id for update;
  v_amount:=case when g.kind='product_units' then new.qty else new.reward_amount_usd end;
  if v_amount>g.amount-g.used_amount-g.reserved_amount then raise exception 'No hay saldo suficiente para reservar el premio.' using errcode='40001'; end if;
  perform set_config('app.reward_use_command','lifecycle',true);
  insert into public.advisor_reward_uses(grant_id,advisor_id,order_id,order_item_id,client_id,client_name_snapshot,product_id,product_name_snapshot,purpose,amount,funded_usd,status,created_by)
    values(g.id,g.advisor_id,o.id,new.id,o.client_id,(select full_name from public.clients where id=o.client_id),new.product_id,new.product_name_snapshot,new.reward_purpose,v_amount,new.reward_amount_usd,'reserved',auth.uid()) returning * into usage;
  insert into public.advisor_reward_use_events(use_id,advisor_id,actor_id,event_type,amount,reason)
    values(usage.id,g.advisor_id,auth.uid(),'reserved',v_amount,'Premio reservado al guardar el pedido; todavía no entregado.');
  perform app_private.reward_refresh_balance_v1(g.id);
  return new;
end; $$;
create trigger reward_item_reserve after insert on public.order_items for each row when(new.reward_grant_id is not null)
  execute function app_private.reward_item_lifecycle_v1();
create trigger reward_item_release before delete on public.order_items for each row when(old.reward_grant_id is not null)
  execute function app_private.reward_item_lifecycle_v1();

create function app_private.reward_order_lifecycle_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare usage public.advisor_reward_uses%rowtype; g_id bigint;
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.advisor_reward_uses where order_id=old.id) then raise exception 'El pedido con historial de premio no se puede borrar; cancélalo.'; end if;
    return old;
  end if;
  if old.status::text='cancelled' and new.status::text<>'cancelled' and exists(select 1 from public.order_items where order_id=new.id and reward_grant_id is not null) then
    raise exception 'El premio de un pedido cancelado fue liberado. Crea una nueva reserva antes de volver a utilizarlo.'; end if;
  if not exists(select 1 from public.advisor_reward_uses where order_id=new.id and status in ('reserved','used')) then return new; end if;
  if old.status::text='delivered' and new.status::text not in ('delivered','cancelled') then
    raise exception 'Un premio entregado solo puede revertirse mediante la cancelación certificada del pedido.'; end if;
  if new.client_id is distinct from old.client_id or new.attributed_advisor_id is distinct from old.attributed_advisor_id then
    raise exception 'Retira los premios antes de cambiar el cliente o asesor del pedido.'; end if;
  if exists(select 1 from public.advisor_reward_uses u join public.advisor_reward_grants g on g.id=u.grant_id
    where u.order_id=new.id and u.status='reserved' and g.expires_on is not null
      and coalesce(nullif(new.extra_fields#>>'{schedule,date}','')::date,(u.created_at at time zone 'America/Caracas')::date)>g.expires_on) then
    raise exception 'La fecha del pedido supera el vencimiento del premio. Retíralo o selecciona una fecha válida.'; end if;
  if new.status::text not in ('delivered','cancelled') or new.status is not distinct from old.status then return new; end if;
  for g_id in select distinct grant_id from public.advisor_reward_uses where order_id=new.id and status in ('reserved','used') order by grant_id loop
    perform 1 from public.advisor_reward_grants where id=g_id for update;
  end loop;
  perform set_config('app.reward_use_command','lifecycle',true);
  for usage in select * from public.advisor_reward_uses where order_id=new.id and status in ('reserved','used') order by id for update loop
    if new.status::text='delivered' and usage.status='reserved' then
      if not exists(select 1 from public.order_items i where i.id=usage.order_item_id and i.order_id=new.id
        and i.reward_grant_id=usage.grant_id and i.product_id=usage.product_id and i.reward_amount_usd=usage.funded_usd) then raise exception 'La reserva del premio no coincide con el pedido.'; end if;
      update public.advisor_reward_uses set status='used',updated_at=statement_timestamp() where id=usage.id;
      insert into public.advisor_reward_use_events(use_id,advisor_id,actor_id,event_type,amount,reason)
        values(usage.id,usage.advisor_id,auth.uid(),'used',usage.amount,'Premio consumido al confirmar la entrega del pedido.');
    elsif new.status::text='cancelled' then
      update public.advisor_reward_uses set status='released',updated_at=statement_timestamp() where id=usage.id;
      insert into public.advisor_reward_use_events(use_id,advisor_id,actor_id,event_type,amount,reason)
        values(usage.id,usage.advisor_id,auth.uid(),case when usage.status='used' then 'reversed' else 'released' end,usage.amount,'Premio restituido por cancelación certificada del pedido.');
    end if;
    perform app_private.reward_refresh_balance_v1(usage.grant_id);
  end loop;
  return new;
end; $$;
create trigger reward_order_guard before update or delete on public.orders for each row execute function app_private.reward_order_lifecycle_v1();

-- Once usage exists, revocation cannot invalidate orders already financed by a prize.
do $$ declare definition text; anchor text:='  -- Block 2 has no redemption path.'; begin
  definition:=pg_get_functiondef('public.reward_revoke_grant_v1(bigint,text)'::regprocedure);
  if strpos(definition,anchor)=0 then raise exception 'La revocación cambió.'; end if;
  execute replace(definition,anchor,E'  if v_grant.reserved_amount>0 or v_grant.used_amount>0 then\n    raise exception ''No se puede revocar un premio reservado o utilizado. Revisa primero sus pedidos y movimientos.'';\n  end if;\n'||anchor);
end; $$;

-- Do not issue an unusable product-specific award from an exclusive CRM SKU.
do $$ declare definition text; anchor text:='  v_terms:=to_jsonb(v_draft)'; begin
  definition:=pg_get_functiondef('public.reward_issue_draft_v1(bigint,integer,text)'::regprocedure);
  if strpos(definition,anchor)=0 then raise exception 'La emisión de premios cambió.'; end if;
  execute replace(definition,anchor,$catalog$
  if exists(select 1 from public.products p where p.id=any(v_draft.allowed_product_ids)
    and (p.type::text='gambit' or coalesce((p.extra_fields->>'inventory_component_only')::boolean,false)
      or coalesce(p.extra_fields->>'catalog_access_scope','') in ('admin_internal','crm_only','gambit_disabled','advisor_gift','advisor_gift_only'))) then
    raise exception 'Para premios selecciona productos normales de venta, no componentes ni productos exclusivos de jugada.';
  end if;
$catalog$||anchor);
end; $$;

revoke all on function app_private.reward_use_guard_v1(),app_private.reward_use_event_guard_v1(),
  app_private.reward_refresh_balance_v1(bigint),app_private.reward_price_item_v1(public.order_items,public.order_items,text),
  app_private.reward_price_trigger_v1(),app_private.reward_item_lifecycle_v1(),app_private.reward_order_lifecycle_v1() from public,anon,authenticated;
notify pgrst,'reload schema';
