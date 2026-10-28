create schema auth;
create schema app_private;
create role anon;
create role authenticated;
create role service_role;
grant usage on schema public, auth to anon, authenticated, service_role;
create table public.profiles(id uuid primary key, is_active boolean not null default true);
create table public.user_roles(user_id uuid references public.profiles(id), role text not null);
create function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$f$;
create function public.has_role(p_role text) returns boolean language sql stable security definer
set search_path = '' as $f$
  select exists(select 1 from public.user_roles where user_id = (select auth.uid()) and role = p_role);
$f$;
create table public.products(
  id bigint primary key, name text not null, is_active boolean not null default true,
  source_price_amount numeric not null, source_price_currency text not null,
  commission_mode text not null default 'default', commission_value numeric,
  current_stock_units numeric not null default 0
);
create table public.clients(
  id bigint primary key, full_name text not null, primary_advisor_id uuid,
  client_type text, recent_addresses jsonb not null default '[]'
);
create table public.orders(id bigint primary key, client_id bigint, total_usd numeric, total_bs_snapshot numeric);
create table public.order_items(id bigint primary key, order_id bigint, product_id bigint, line_total_usd numeric);
create table public.order_payments(id bigint primary key, order_id bigint, amount numeric, currency text, status text);
create table public.advisor_commission_closures(id bigint primary key, net_usd numeric, status text);
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.clients enable row level security;
create policy profile_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.has_role('admin'));
create policy product_read on public.products for select to authenticated using (true);
create policy client_read on public.clients for select to authenticated
  using (primary_advisor_id = (select auth.uid()) or public.has_role('admin'));
grant select on public.profiles, public.products, public.clients to authenticated;
insert into public.profiles values
  ('00000000-0000-4000-8000-000000000001',true),
  ('00000000-0000-4000-8000-000000000002',true),
  ('00000000-0000-4000-8000-000000000003',false),
  ('00000000-0000-4000-8000-000000000004',true);
insert into public.user_roles values
  ('00000000-0000-4000-8000-000000000001','admin'),
  ('00000000-0000-4000-8000-000000000002','advisor'),
  ('00000000-0000-4000-8000-000000000003','admin'),
  ('00000000-0000-4000-8000-000000000004','master');
insert into public.products(id,name,source_price_amount,source_price_currency,current_stock_units)
  select n,'Producto ' || lpad(n::text,3,'0'),14,'USD',100 from generate_series(1,31) n;
insert into public.products(id,name,source_price_amount,source_price_currency,commission_mode,commission_value)
  values (32,'Tequeños históricos',11500,'VES','fixed_item',5);
insert into public.clients values (1,'Cliente compartido','00000000-0000-4000-8000-000000000002','own','[{"address":"Dirección guardada"}]');
insert into public.orders values (10,1,14,12346.32);
insert into public.order_items values (10,10,1,14);
insert into public.order_payments values (10,10,12346.32,'VES','confirmed');
insert into public.advisor_commission_closures values (10,0.70,'paid');
