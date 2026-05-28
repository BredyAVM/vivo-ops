-- Importacion controlada de clientes reales.
-- No ejecutar la importacion real hasta recibir la lista final del lunes 2026-06-01.
-- El CSV revisado hoy se uso solo para diagnostico y preparacion.
-- Flujo:
-- 1. Crear tabla staging.
-- 2. Importar CSV desde Supabase Table Editor a public.client_import_stage.
-- 3. Revisar invalidos y duplicados.
-- 4. Insertar solo telefonos unicos que no existan.

create or replace function public.vivo_guess_phone_e164(raw_phone text)
returns text
language sql
immutable
as $$
  with cleaned as (
    select
      trim(coalesce(raw_phone, '')) as raw_text,
      regexp_replace(coalesce(raw_phone, ''), '[^0-9+]', '', 'g') as compact_text,
      regexp_replace(coalesce(raw_phone, ''), '[^0-9]', '', 'g') as digits
  ),
  normalized as (
    select
      case
        when raw_text = '' then null
        when compact_text like '+%' then '+' || regexp_replace(compact_text, '[^0-9]', '', 'g')
        when digits like '00%' then '+' || substr(digits, 3)
        when digits like '58%' and length(digits) between 11 and 14 then '+' || digits
        when digits like '0%' and length(digits) >= 10 then '+58' || substr(digits, 2)
        when length(digits) between 9 and 10 then '+58' || digits
        else null
      end as e164
    from cleaned
  )
  select case
    when e164 ~ '^\+[1-9][0-9]{6,14}$' then e164
    else null
  end
  from normalized;
$$;

drop table if exists public.client_import_stage;

create table public.client_import_stage (
  legacy_control text,
  phone_raw text,
  full_name text,
  legacy_created_at text,
  legacy_client_type text
);

-- IMPORTANTE:
-- Al importar el CSV final de clientes, mapear columnas asi:
-- `Nro. Cont.` / `N° Cont.` -> legacy_control
-- `Telefono` -> phone_raw
-- `Cliente ` -> full_name
-- `Fecha de Ingreso` -> legacy_created_at
-- `Tipo de Cliente` -> legacy_client_type

-- Diagnostico staging
select
  count(*) as filas,
  count(public.vivo_guess_phone_e164(phone_raw)) as telefonos_validos,
  count(*) filter (
    where coalesce(phone_raw, '') <> ''
      and public.vivo_guess_phone_e164(phone_raw) is null
  ) as telefonos_invalidos
from public.client_import_stage;

-- Invalidos a revisar manualmente
select
  legacy_control,
  full_name,
  phone_raw,
  legacy_client_type
from public.client_import_stage
where coalesce(phone_raw, '') <> ''
  and public.vivo_guess_phone_e164(phone_raw) is null
order by legacy_control;

-- Duplicados dentro del CSV por telefono canonico
select
  public.vivo_guess_phone_e164(phone_raw) as phone_canonico,
  count(*) as cantidad,
  array_agg(legacy_control order by legacy_control) as controles,
  array_agg(full_name order by legacy_control) as nombres,
  array_agg(phone_raw order by legacy_control) as telefonos_originales
from public.client_import_stage
where public.vivo_guess_phone_e164(phone_raw) is not null
group by public.vivo_guess_phone_e164(phone_raw)
having count(*) > 1
order by cantidad desc, phone_canonico;

-- Clientes del CSV que ya existen en Supabase
select
  s.legacy_control,
  s.full_name as csv_name,
  s.phone_raw,
  public.vivo_guess_phone_e164(s.phone_raw) as phone_canonico,
  c.id as existing_client_id,
  c.full_name as existing_name
from public.client_import_stage s
join public.clients c
  on c.phone = public.vivo_guess_phone_e164(s.phone_raw)
where public.vivo_guess_phone_e164(s.phone_raw) is not null
order by s.legacy_control;

-- Insercion segura: solo telefonos validos, no duplicados dentro del CSV,
-- y que no existan ya en clients.
/*
with normalized as (
  select
    trim(legacy_control) as legacy_control,
    nullif(trim(full_name), '') as full_name,
    phone_raw,
    public.vivo_guess_phone_e164(phone_raw) as phone_e164,
    nullif(trim(legacy_created_at), '') as legacy_created_at,
    nullif(trim(legacy_client_type), '') as legacy_client_type
  from public.client_import_stage
),
unique_stage as (
  select n.*
  from normalized n
  where n.phone_e164 is not null
    and n.full_name is not null
    and not exists (
      select 1
      from normalized other
      where other.phone_e164 = n.phone_e164
        and other.legacy_control <> n.legacy_control
    )
),
to_insert as (
  select u.*
  from unique_stage u
  left join public.clients c on c.phone = u.phone_e164
  where c.id is null
)
insert into public.clients (
  full_name,
  phone,
  client_type,
  is_active,
  extra_fields,
  created_at,
  updated_at
)
select
  full_name,
  phone_e164,
  case
    when lower(coalesce(legacy_client_type, '')) like '%asign%' then 'assigned'
    when lower(coalesce(legacy_client_type, '')) like '%prop%' then 'own'
    else 'legacy'
  end,
  true,
  jsonb_build_object(
    'legacy_import', jsonb_build_object(
      'source', 'clientes_final_2026-06-01.csv',
      'legacy_control', legacy_control,
      'legacy_phone_raw', phone_raw,
      'legacy_created_at', legacy_created_at,
      'legacy_client_type', legacy_client_type,
      'imported_at', now()
    )
  ),
  now(),
  now()
from to_insert;
*/

-- Resumen posterior
/*
select
  count(*) as total_clients,
  count(*) filter (where phone is null or phone = '') as sin_telefono,
  count(*) filter (where is_active) as activos
from public.clients;
*/
