create sequence public.test_menu_product_id start 1000;
alter table public.products alter column id set default nextval('public.test_menu_product_id');
alter table public.products add column sku text,add column is_combo boolean default false,add column type text default 'product',
 add column base_price_usd numeric default 0,add column extra_fields jsonb default '{}',add column is_inventory_item boolean default true,
 add column inventory_enabled boolean default false,add column inventory_policy text default 'direct',add column inventory_configuration_status text default 'ready',
 add column units_per_service numeric default 1,add column allows_half_service boolean default false,add column detail_units_limit numeric default 0,add column is_detail_editable boolean default false;
alter table public.orders add column extra_fields jsonb default '{"pricing":{"fx_rate":884.75}}',add column order_number bigint default 10,
 add column status text default 'queued',add column attributed_advisor_id uuid default '00000000-0000-4000-8000-000000000002';
alter table public.order_items add column qty numeric default 1,add column notes text,add column pricing_origin_currency text default 'USD',
 add column pricing_origin_amount numeric default 14,add column admin_price_override_usd numeric,add column override_unit_price_usd numeric,
 add column crm_play_member_id bigint,add column reward_grant_id bigint,add column product_name_snapshot text,
 add column unit_price_usd_snapshot numeric,add column unit_price_bs_snapshot numeric,add column line_total_bs_snapshot numeric,
 add column pricing_fx_rate_snapshot numeric;
grant insert,update on public.products to authenticated;
grant usage on sequence public.test_menu_product_id to authenticated;
create policy product_prepare on public.products for insert to authenticated with check(public.has_role('admin'));
create policy product_update on public.products for update to authenticated using(public.has_role('admin'))with check(public.has_role('admin'));
grant select,insert,update,delete on public.orders,public.order_items to authenticated;
create type public.product_component_mode as enum('fixed','selectable');
create table public.product_components(parent_product_id bigint,component_product_id bigint,quantity numeric,component_mode public.product_component_mode,counts_toward_detail_limit boolean,is_required boolean);
create table public.order_item_components(id bigint,order_item_id bigint,component_product_id bigint,qty numeric);
create table public.product_inventory_links(product_id bigint,inventory_item_id bigint,configuration_version integer default 1,quantity_units numeric);
create table public.inventory_items(id bigint primary key,name text,unit_name text,current_stock_units numeric,is_active boolean default true,
 merged_into_item_id bigint,tracking_mode text default 'transactional',consumption_triggers text[]default array['sale']);
alter table public.inventory_items enable row level security;
create policy inventory_read on public.inventory_items for select to authenticated using(true);
grant select on public.inventory_items,public.product_inventory_links,public.product_components,public.order_item_components to authenticated;
