-- Indices de performance para piloto.
-- Objetivo: bajar tiempo de carga en master/advisor y evitar timeouts al crecer clientes/ordenes.
-- Ejecutar en Supabase SQL Editor antes del piloto.
-- No usar dentro de begin/commit.

-- Busqueda flexible de clientes por nombre/telefono.
-- Necesario para ilike '%texto%' en asesor y master.
create extension if not exists pg_trgm with schema extensions;

create index if not exists idx_clients_phone_trgm
on public.clients using gin (phone gin_trgm_ops)
where phone is not null;

create index if not exists idx_clients_full_name_trgm
on public.clients using gin (full_name gin_trgm_ops)
where full_name is not null and is_active = true;

create index if not exists idx_clients_updated_at_desc
on public.clients (updated_at desc);

create index if not exists idx_clients_primary_advisor
on public.clients (primary_advisor_id)
where primary_advisor_id is not null;

-- Ordenes: dashboard master, home asesor, busqueda por cliente y pantallas de detalle.
create index if not exists idx_orders_created_at_desc
on public.orders (created_at desc);

create index if not exists idx_orders_status_created_at_desc
on public.orders (status, created_at desc);

create index if not exists idx_orders_advisor_created_at_desc
on public.orders (attributed_advisor_id, created_at desc)
where attributed_advisor_id is not null;

create index if not exists idx_orders_advisor_client_created_at_desc
on public.orders (attributed_advisor_id, client_id, created_at desc)
where attributed_advisor_id is not null and client_id is not null;

create index if not exists idx_orders_client_created_at_desc
on public.orders (client_id, created_at desc)
where client_id is not null;

create index if not exists idx_orders_order_number
on public.orders (order_number);

-- Items y snapshots de orden.
create index if not exists idx_order_items_order_id_id
on public.order_items (order_id, id);

create index if not exists idx_order_items_product_id
on public.order_items (product_id)
where product_id is not null;

-- Pagos: resumen por orden, pendientes por confirmar y trazabilidad.
create index if not exists idx_payment_reports_order_created_at_desc
on public.payment_reports (order_id, created_at desc);

create index if not exists idx_payment_reports_order_status_created_at_desc
on public.payment_reports (order_id, status, created_at desc);

create index if not exists idx_payment_reports_status_created_at_desc
on public.payment_reports (status, created_at desc);

create index if not exists idx_payment_reports_account_created_at_desc
on public.payment_reports (reported_money_account_id, created_at desc)
where reported_money_account_id is not null;

-- Movimientos de dinero: cuentas, cierres, pagos ligados a orden y auditoria.
create index if not exists idx_money_movements_order_id
on public.money_movements (order_id)
where order_id is not null;

create index if not exists idx_money_movements_payment_report_id
on public.money_movements (payment_report_id)
where payment_report_id is not null;

create index if not exists idx_money_movements_account_status_date_desc
on public.money_movements (money_account_id, status, movement_date desc, created_at desc);

create index if not exists idx_money_movements_date_created_desc
on public.money_movements (movement_date desc, created_at desc);

create index if not exists idx_money_movements_group_id
on public.money_movements (movement_group_id)
where movement_group_id is not null;

-- Timeline nuevo: base operativa para inbox, seguimiento y eventos.
create index if not exists idx_order_timeline_events_order_created_at_desc
on public.order_timeline_events (order_id, created_at desc);

create index if not exists idx_order_timeline_events_order_type_created_at_desc
on public.order_timeline_events (order_id, event_type, created_at desc);

create index if not exists idx_order_timeline_events_created_at_desc
on public.order_timeline_events (created_at desc);

-- Recipients del timeline: campana, inbox y notificaciones por rol/usuario.
create index if not exists idx_order_timeline_recipients_event_id
on public.order_timeline_event_recipients (event_id);

create index if not exists idx_order_timeline_recipients_user_read
on public.order_timeline_event_recipients (target_user_id, read_at)
where target_user_id is not null;

create index if not exists idx_order_timeline_recipients_role_read
on public.order_timeline_event_recipients (target_role, read_at)
where target_role is not null;

-- Estados del inbox master.
create index if not exists idx_master_inbox_item_states_status_order
on public.master_inbox_item_states (status, order_id)
where order_id is not null;

create index if not exists idx_master_inbox_item_states_item
on public.master_inbox_item_states (item_id, item_type);

-- Catalogo/configuracion usados al crear ordenes.
create index if not exists idx_products_active_name
on public.products (is_active, name);

create index if not exists idx_product_components_parent_sort
on public.product_components (parent_product_id, sort_order);

create index if not exists idx_product_components_component
on public.product_components (component_product_id);

create index if not exists idx_exchange_rates_active_effective_desc
on public.exchange_rates (is_active, effective_at desc);

create index if not exists idx_money_account_payment_rules_lookup
on public.money_account_payment_rules (money_account_id, role, payment_method_code, is_active);

-- Roles y perfiles.
create index if not exists idx_user_roles_user_role
on public.user_roles (user_id, role);

create index if not exists idx_user_roles_role_user
on public.user_roles (role, user_id);

-- Inventario basico.
create index if not exists idx_inventory_movements_item_created_desc
on public.inventory_movements (inventory_item_id, created_at desc);

create index if not exists idx_inventory_movements_order_type
on public.inventory_movements (order_id, movement_type)
where order_id is not null;

-- Actualizar estadisticas del planner despues de crear indices.
analyze public.clients;
analyze public.orders;
analyze public.order_items;
analyze public.payment_reports;
analyze public.money_movements;
analyze public.order_timeline_events;
analyze public.order_timeline_event_recipients;
analyze public.master_inbox_item_states;
analyze public.products;
analyze public.product_components;
analyze public.exchange_rates;
analyze public.money_account_payment_rules;
analyze public.user_roles;
analyze public.inventory_movements;
