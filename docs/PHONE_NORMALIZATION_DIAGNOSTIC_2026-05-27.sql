-- Diagnostico de telefonos para VIVO Ops.
-- No borra, no fusiona y no actualiza datos por si solo.
-- Regla base: si no hay codigo internacional explicito, se asume Venezuela (+58).

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

-- 1) Clientes cuyo telefono principal cambiaria al formato canonico.
select
  id,
  full_name,
  phone as phone_actual,
  public.vivo_guess_phone_e164(phone) as phone_canonico
from public.clients
where coalesce(phone, '') <> ''
  and public.vivo_guess_phone_e164(phone) is not null
  and phone is distinct from public.vivo_guess_phone_e164(phone)
order by updated_at desc nulls last, id desc;

-- 2) Posibles duplicados por telefono principal canonico.
select
  public.vivo_guess_phone_e164(phone) as phone_canonico,
  count(*) as cantidad,
  array_agg(id order by id) as client_ids,
  array_agg(full_name order by id) as nombres,
  array_agg(phone order by id) as telefonos_actuales
from public.clients
where public.vivo_guess_phone_e164(phone) is not null
group by public.vivo_guess_phone_e164(phone)
having count(*) > 1
order by cantidad desc, phone_canonico;

-- 3) Telefonos que no se pudieron interpretar.
select
  id,
  full_name,
  phone
from public.clients
where coalesce(phone, '') <> ''
  and public.vivo_guess_phone_e164(phone) is null
order by updated_at desc nulls last, id desc;

-- 4) Actualizacion controlada SOLO para filas sin conflicto.
-- Revisar los resultados anteriores antes de ejecutar este bloque.
/*
with normalized as (
  select
    id,
    public.vivo_guess_phone_e164(phone) as phone_canonico
  from public.clients
  where public.vivo_guess_phone_e164(phone) is not null
),
safe_rows as (
  select n.*
  from normalized n
  where not exists (
    select 1
    from normalized other
    where other.phone_canonico = n.phone_canonico
      and other.id <> n.id
  )
)
update public.clients c
set phone = s.phone_canonico,
    updated_at = now()
from safe_rows s
where c.id = s.id
  and c.phone is distinct from s.phone_canonico;
*/

-- 5) Cuando ya no haya duplicados, se puede proteger la tabla con indice unico.
-- Ejecutar solo despues de limpiar duplicados reales.
/*
create unique index concurrently if not exists clients_phone_unique_not_null
on public.clients (phone)
where phone is not null and phone <> '';
*/

