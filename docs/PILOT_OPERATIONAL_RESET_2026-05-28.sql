-- Reset operativo para piloto.
-- NO toca clientes, productos, catalogo, cuentas, reglas, usuarios ni roles.
-- Recomendado: correr primero el bloque de diagnostico y tomar backup en Supabase.
-- Este reset es independiente de la importacion de clientes.
-- No correr antes del adiestramiento del domingo; el blanqueo real va el lunes antes del piloto.

-- 1) Diagnostico previo
select 'orders' as table_name, count(*) from public.orders
union all select 'order_items', count(*) from public.order_items
union all select 'payment_reports', count(*) from public.payment_reports
union all select 'money_movements_order_linked', count(*) from public.money_movements where order_id is not null or payment_report_id is not null
union all select 'order_timeline_events', count(*) from public.order_timeline_events
union all select 'order_timeline_event_recipients', count(*) from public.order_timeline_event_recipients
union all select 'order_admin_adjustments', count(*) from public.order_admin_adjustments
union all select 'order_events_legacy', count(*) from public.order_events;

-- 2) Reset operativo
-- Ejecutar solo despues de backup, confirmacion y cierre del adiestramiento.
/*
begin;

delete from public.order_timeline_event_recipients
where event_id in (select id from public.order_timeline_events);

delete from public.order_timeline_events;

delete from public.order_events;

delete from public.money_movements
where order_id is not null
   or payment_report_id is not null;

delete from public.payment_reports;

delete from public.order_admin_adjustments;

delete from public.order_items;

delete from public.orders;

do $$
begin
  if to_regclass('public.master_inbox_item_states') is not null then
    execute 'delete from public.master_inbox_item_states where order_id is not null';
  end if;
end $$;

-- Fondos generados por pruebas de ordenes/pagos. Mantener en 0 para piloto limpio.
update public.clients
set fund_balance_usd = 0,
    updated_at = now()
where coalesce(fund_balance_usd, 0) <> 0;

commit;
*/

-- 3) Diagnostico posterior
/*
select 'orders' as table_name, count(*) from public.orders
union all select 'order_items', count(*) from public.order_items
union all select 'payment_reports', count(*) from public.payment_reports
union all select 'money_movements_order_linked', count(*) from public.money_movements where order_id is not null or payment_report_id is not null
union all select 'order_timeline_events', count(*) from public.order_timeline_events
union all select 'order_timeline_event_recipients', count(*) from public.order_timeline_event_recipients
union all select 'order_admin_adjustments', count(*) from public.order_admin_adjustments
union all select 'order_events_legacy', count(*) from public.order_events;
*/

-- 4) Opcional: reiniciar secuencias si se quiere arrancar IDs desde 1.
-- No es necesario porque el localizador de orden usa fecha.
/*
alter sequence if exists public.orders_id_seq restart with 1;
alter sequence if exists public.order_items_id_seq restart with 1;
alter sequence if exists public.payment_reports_id_seq restart with 1;
alter sequence if exists public.money_movements_id_seq restart with 1;
alter sequence if exists public.order_timeline_events_id_seq restart with 1;
alter sequence if exists public.order_timeline_event_recipients_id_seq restart with 1;
alter sequence if exists public.order_admin_adjustments_id_seq restart with 1;
alter sequence if exists public.order_events_id_seq restart with 1;
*/
