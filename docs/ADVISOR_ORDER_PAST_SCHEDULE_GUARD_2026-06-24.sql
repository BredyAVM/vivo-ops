-- Impide que un asesor cree una orden con fecha/hora programada anterior
-- al minuto actual en America/Caracas. Master/admin pueden registrar órdenes
-- históricas cuando sea necesario. No afecta actualizaciones ni órdenes existentes.

create or replace function public.trg_orders_advisor_schedule_not_past_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  v_schedule jsonb := coalesce(new.extra_fields -> 'schedule', '{}'::jsonb);
  v_date text := trim(coalesce(v_schedule ->> 'date', ''));
  v_time text := trim(coalesce(v_schedule ->> 'time_24', ''));
  v_scheduled_at timestamptz;
begin
  -- Los registros hechos por master/admin pueden corregir o cargar casos históricos.
  if public.is_master_or_admin() then
    return new;
  end if;

  -- La política de INSERT ya limita este caso a su asesor atribuido; esta regla
  -- únicamente protege el alta originada desde el módulo de asesores.
  if coalesce(new.source::text, '') <> 'advisor' or not public.has_role('advisor') then
    return new;
  end if;

  -- "Lo antes posible" representa la operación actual, no un horario fijo.
  if lower(coalesce(v_schedule ->> 'asap', 'false')) = 'true' then
    return new;
  end if;

  if v_date !~ '^\d{4}-\d{2}-\d{2}$' or v_time !~ '^\d{2}:\d{2}$' then
    raise exception using
      errcode = '22023',
      message = 'El asesor debe indicar una fecha y hora de entrega válidas.';
  end if;

  v_scheduled_at := (v_date || ' ' || v_time)::timestamp at time zone 'America/Caracas';

  if v_scheduled_at < date_trunc('minute', now()) then
    raise exception using
      errcode = '22023',
      message = 'No puedes crear una orden con fecha y hora anteriores al momento actual.';
  end if;

  return new;
end;
$function$;

drop trigger if exists orders_advisor_schedule_not_past_guard on public.orders;

create trigger orders_advisor_schedule_not_past_guard
before insert on public.orders
for each row
execute function public.trg_orders_advisor_schedule_not_past_guard();
