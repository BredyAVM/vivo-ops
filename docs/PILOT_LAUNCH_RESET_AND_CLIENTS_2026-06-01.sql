-- Hito de arranque operativo real - 2026-06-01
-- Objetivo:
-- - Borrar historico/pruebas operativas.
-- - Reiniciar ordenes desde id 1.
-- - Dejar cuentas en cero sin borrar cuentas ni reglas.
-- - Reemplazar clientes por la base final.
-- - Conservar catalogo, productos, recetas, reglas, usuarios y roles.
--
-- CSV staging generado:
-- docs/clientes_final_stage_2026-06-01.csv
--
-- Flujo recomendado:
-- 1. Crear staging con el bloque A.
-- 2. Importar docs/clientes_final_stage_2026-06-01.csv en public.client_import_stage_20260601.
-- 3. Correr diagnostico B.
-- 4. Si los numeros cuadran, correr reset/import C.
-- 5. Opcionalmente correr D si tambien quieres inventario en cero.

-- A) Crear staging de clientes finales
drop table if exists public.client_import_stage_20260601;

create table public.client_import_stage_20260601 (
  legacy_control text,
  canonical_legacy_control text,
  full_name text,
  phone_e164 text,
  phone_raw text,
  legacy_created_at text,
  legacy_client_type text,
  import_active text,
  import_reason text
);

-- Importar aqui el CSV:
-- docs/clientes_final_stage_2026-06-01.csv

-- B) Diagnostico despues de importar CSV
select
  count(*) as filas_stage,
  count(*) filter (where import_reason = 'canonical') as canonicos_activos,
  count(*) filter (where import_reason = 'duplicate_phone_alias') as aliases_duplicados,
  count(*) filter (where import_reason = 'invalid_phone') as invalidos_inactivos,
  count(distinct nullif(phone_e164, '')) as telefonos_unicos
from public.client_import_stage_20260601;

select
  legacy_client_type,
  count(*) as filas,
  count(*) filter (where import_reason = 'canonical') as canonicos_activos,
  count(*) filter (where import_reason = 'duplicate_phone_alias') as aliases_duplicados,
  count(*) filter (where import_reason = 'invalid_phone') as invalidos_inactivos
from public.client_import_stage_20260601
group by legacy_client_type
order by legacy_client_type;

select
  phone_e164,
  count(*) as cantidad,
  array_agg(legacy_control order by legacy_control::int) as controles,
  array_agg(full_name order by legacy_control::int) as nombres
from public.client_import_stage_20260601
where nullif(phone_e164, '') is not null
group by phone_e164
having count(*) > 1
order by cantidad desc, phone_e164
limit 40;

-- Conteos actuales antes del blanqueo.
select 'orders' as table_name, count(*) from public.orders
union all select 'order_items', count(*) from public.order_items
union all select 'payment_reports', count(*) from public.payment_reports
union all select 'money_movements', count(*) from public.money_movements
union all select 'money_account_closures', count(*) from public.money_account_closures
union all select 'order_timeline_events', count(*) from public.order_timeline_events
union all select 'order_timeline_event_recipients', count(*) from public.order_timeline_event_recipients
union all select 'order_admin_adjustments', count(*) from public.order_admin_adjustments
union all select 'order_events_legacy', count(*) from public.order_events
union all select 'master_inbox_item_states', count(*) from public.master_inbox_item_states
union all select 'clients', count(*) from public.clients
union all select 'money_accounts', count(*) from public.money_accounts
union all select 'money_account_payment_rules', count(*) from public.money_account_payment_rules;

-- C) Reset operativo + importacion final de clientes
-- Ejecutar solo despues de backup y despues de confirmar el diagnostico.
/*
begin;

create table if not exists public.client_legacy_aliases (
  id bigserial primary key,
  source text not null,
  legacy_control text not null,
  client_id bigint not null references public.clients(id) on delete cascade,
  full_name_snapshot text,
  phone_raw text,
  phone_e164 text,
  canonical_legacy_control text,
  import_reason text,
  created_at timestamptz not null default now(),
  unique (source, legacy_control)
);

delete from public.order_timeline_event_recipients;
delete from public.order_timeline_events;
delete from public.master_inbox_item_states;
delete from public.order_events;
delete from public.money_account_closures;
delete from public.money_movements;
delete from public.payment_reports;
delete from public.order_admin_adjustments;
delete from public.inventory_movements where order_id is not null;
delete from public.order_items;
delete from public.orders;

-- Clientes de prueba/anteriores fuera; se reemplazan por base final.
delete from public.client_legacy_aliases where source = 'clientes_final_2026-06-01';
delete from public.clients;

alter sequence if exists public.orders_id_seq restart with 1;
alter sequence if exists public.order_items_id_seq restart with 1;
alter sequence if exists public.payment_reports_id_seq restart with 1;
alter sequence if exists public.money_movements_id_seq restart with 1;
alter sequence if exists public.money_account_closures_id_seq restart with 1;
alter sequence if exists public.order_timeline_events_id_seq restart with 1;
alter sequence if exists public.order_timeline_event_recipients_id_seq restart with 1;
alter sequence if exists public.order_admin_adjustments_id_seq restart with 1;
alter sequence if exists public.order_events_id_seq restart with 1;

with client_rows as (
  select
    legacy_control::bigint as id,
    legacy_control,
    full_name,
    nullif(phone_e164, '') as phone_e164,
    phone_raw,
    legacy_created_at,
    legacy_client_type,
    import_reason
  from public.client_import_stage_20260601
  where import_reason in ('canonical', 'invalid_phone')
)
insert into public.clients (
  id,
  full_name,
  phone,
  client_type,
  is_active,
  fund_balance_usd,
  extra_fields,
  created_at,
  updated_at
)
select
  id,
  full_name,
  phone_e164,
  case
    when lower(coalesce(legacy_client_type, '')) like '%asign%' then 'assigned'
    when lower(coalesce(legacy_client_type, '')) like '%prop%' then 'own'
    else 'legacy'
  end,
  import_reason = 'canonical',
  0,
  jsonb_build_object(
    'legacy_import', jsonb_build_object(
      'source', 'clientes_final_2026-06-01',
      'legacy_control', legacy_control,
      'legacy_phone_raw', phone_raw,
      'legacy_created_at', legacy_created_at,
      'legacy_client_type', legacy_client_type,
      'import_reason', import_reason,
      'imported_at', now()
    )
  ),
  now(),
  now()
from client_rows
order by id;

insert into public.client_legacy_aliases (
  source,
  legacy_control,
  client_id,
  full_name_snapshot,
  phone_raw,
  phone_e164,
  canonical_legacy_control,
  import_reason
)
select
  'clientes_final_2026-06-01',
  s.legacy_control,
  s.canonical_legacy_control::bigint,
  s.full_name,
  s.phone_raw,
  nullif(s.phone_e164, ''),
  s.canonical_legacy_control,
  s.import_reason
from public.client_import_stage_20260601 s
where exists (
  select 1
  from public.clients c
  where c.id = s.canonical_legacy_control::bigint
);

select setval(
  pg_get_serial_sequence('public.clients', 'id'),
  coalesce((select max(id) from public.clients), 1),
  true
);

commit;
*/

-- Verificacion posterior
/*
select 'orders' as table_name, count(*) from public.orders
union all select 'order_items', count(*) from public.order_items
union all select 'payment_reports', count(*) from public.payment_reports
union all select 'money_movements', count(*) from public.money_movements
union all select 'money_account_closures', count(*) from public.money_account_closures
union all select 'order_timeline_events', count(*) from public.order_timeline_events
union all select 'order_timeline_event_recipients', count(*) from public.order_timeline_event_recipients
union all select 'order_admin_adjustments', count(*) from public.order_admin_adjustments
union all select 'order_events_legacy', count(*) from public.order_events
union all select 'master_inbox_item_states', count(*) from public.master_inbox_item_states
union all select 'clients', count(*) from public.clients
union all select 'client_legacy_aliases', count(*) from public.client_legacy_aliases where source = 'clientes_final_2026-06-01'
union all select 'money_accounts', count(*) from public.money_accounts
union all select 'money_account_payment_rules', count(*) from public.money_account_payment_rules;

select
  client_type,
  count(*) as clientes
from public.clients
group by client_type
order by client_type;
*/

-- D) OPCIONAL: inventario a cero.
-- Ejecutar solo si el stock actual tambien era de prueba.
/*
begin;

delete from public.inventory_movements;

update public.products
set current_stock_units = 0
where current_stock_units is not null;

update public.inventory_items
set current_stock_units = 0
where current_stock_units is not null;

alter sequence if exists public.inventory_movements_id_seq restart with 1;

commit;
*/
