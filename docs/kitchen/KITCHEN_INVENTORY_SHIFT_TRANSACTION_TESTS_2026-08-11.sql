-- Certificacion reversible de los dos turnos canonicos de Cocina.
-- Ejecutar despues de aplicar kitchen_inventory_shifts_v1. Todo termina en ROLLBACK.
begin;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', actor.user_id, 'role', 'authenticated')::text,
  true
)
from (
  select role_row.user_id
  from public.user_roles role_row
  where role_row.role = 'kitchen'
  order by role_row.user_id
  limit 1
) actor;

do $$
begin
  if auth.uid() is null then
    raise exception 'La prueba requiere al menos un usuario con rol Kitchen.';
  end if;
end;
$$;

create temporary table _kitchen_shift_fixture as
select candidate.business_date, candidate.shift_code
from (
  values
    (((now() at time zone 'America/Caracas')::date), 'shift_1'::text),
    (((now() at time zone 'America/Caracas')::date), 'shift_2'::text),
    (((now() at time zone 'America/Caracas')::date - 1), 'shift_1'::text),
    (((now() at time zone 'America/Caracas')::date - 1), 'shift_2'::text)
) candidate(business_date, shift_code)
where not exists (
  select 1
  from public.inventory_counts count_header
  where count_header.count_kind = 'shift_change'
    and count_header.shift_business_date = candidate.business_date
    and count_header.shift_code = candidate.shift_code
    and count_header.status in ('open', 'submitted', 'accepted', 'recount_requested')
)
limit 1;

do $$
begin
  if not exists (select 1 from _kitchen_shift_fixture) then
    raise exception 'No queda un turno libre entre hoy y ayer para la prueba reversible.';
  end if;
end;
$$;

create temporary table _kitchen_shift_open_result as
select public.inventory_open_shift_count_v1(
  fixture.business_date,
  fixture.shift_code,
  'Certificacion reversible de turnos Cocina.'
) result
from _kitchen_shift_fixture fixture;

do $$
declare
  v_first_id bigint;
  v_replayed_id bigint;
  v_expected_items integer;
  v_open_lines integer;
begin
  select (result ->> 'inventory_count_id')::bigint
  into v_first_id
  from _kitchen_shift_open_result;

  select (
    public.inventory_open_shift_count_v1(
      fixture.business_date,
      fixture.shift_code,
      'Reintento idempotente.'
    ) ->> 'inventory_count_id'
  )::bigint
  into v_replayed_id
  from _kitchen_shift_fixture fixture;

  if v_first_id is null or v_first_id <> v_replayed_id then
    raise exception 'Abrir el mismo turno no fue idempotente.';
  end if;

  select count(*)
  into v_expected_items
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
    and item.primary_count_frequency = 'per_shift'
    and item.primary_count_role = 'kitchen'
    and app_private.inventory_item_is_initialized_v1(item.id);

  select count(*)
  into v_open_lines
  from public.inventory_count_lines line
  where line.inventory_count_id = v_first_id
    and line.line_status = 'pending';

  if v_open_lines <> v_expected_items or v_open_lines = 0 then
    raise exception 'El turno no abrio exactamente el programa ciego de Cocina.';
  end if;
end;
$$;

create temporary table _kitchen_shift_submit_result as
select public.inventory_submit_count_v1(
  gen_random_uuid(),
  'shift_change',
  (
    select jsonb_agg(
      jsonb_build_object(
        'inventory_item_id', line.inventory_item_id,
        'counted_quantity_units', line.expected_quantity_units,
        'note', 'Conteo reversible sin diferencia.'
      )
      order by line.inventory_item_id
    )
    from public.inventory_count_lines line
    where line.inventory_count_id = (result ->> 'inventory_count_id')::bigint
      and line.line_status = 'pending'
  ),
  'Cierre reversible de certificacion.',
  null,
  (result ->> 'inventory_count_id')::bigint
) result
from _kitchen_shift_open_result;

do $$
declare
  v_count_id bigint;
begin
  select (result ->> 'inventory_count_id')::bigint
  into v_count_id
  from _kitchen_shift_submit_result;

  if not exists (
    select 1
    from public.inventory_counts count_header
    where count_header.id = v_count_id
      and count_header.status = 'submitted'
      and count_header.shift_business_date is not null
      and count_header.shift_code in ('shift_1', 'shift_2')
      and count_header.created_by_user_id = auth.uid()
      and count_header.submitted_by_user_id = auth.uid()
      and count_header.submitted_at is not null
  ) then
    raise exception 'El cierre no conservo turno, actor y horas auditables.';
  end if;

  begin
    perform public.inventory_open_shift_count_v1(
      fixture.business_date,
      fixture.shift_code,
      'Intento duplicado que debe fallar.'
    )
    from _kitchen_shift_fixture fixture;
    raise exception 'El mismo turno pudo cerrarse dos veces.';
  exception when unique_violation then
    null;
  end;
end;
$$;

select jsonb_build_object(
  'certification', 'pass',
  'inventory_count_id', (result ->> 'inventory_count_id')::bigint,
  'orders_touched', 0,
  'rollback', true
) as kitchen_shift_certification
from _kitchen_shift_submit_result;

rollback;
