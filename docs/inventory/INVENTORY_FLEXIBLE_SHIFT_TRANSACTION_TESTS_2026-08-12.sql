-- Certificación reversible de conteos por turno flexibles de Cocina.
-- Ejecutar después de inventory_flexible_shift_counts_v1. Todo termina en ROLLBACK.
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

create temporary table _flexible_shift_fixture as
select
  ((now() at time zone 'America/Caracas')::date - 1) as business_date,
  gen_random_uuid() as operation_1,
  gen_random_uuid() as operation_2,
  gen_random_uuid() as operation_3;

create temporary table _flexible_shift_first as
select public.inventory_open_shift_count_v2(
  fixture.operation_1,
  fixture.business_date,
  'Certificación reversible de conteo por turno.'
) result
from _flexible_shift_fixture fixture;

do $test$
declare
  v_first_id bigint;
  v_replayed_id bigint;
  v_second_id bigint;
  v_resumed_id bigint;
begin
  if auth.uid() is null then
    raise exception 'La prueba requiere al menos un usuario con rol Cocina.';
  end if;

  select (result ->> 'inventory_count_id')::bigint
  into v_first_id
  from _flexible_shift_first;

  select (
    public.inventory_open_shift_count_v2(
      fixture.operation_1,
      fixture.business_date,
      'Reintento idempotente.'
    ) ->> 'inventory_count_id'
  )::bigint
  into v_replayed_id
  from _flexible_shift_fixture fixture;

  if v_first_id is null or v_replayed_id <> v_first_id then
    raise exception 'Abrir nuevamente la misma operación no fue idempotente.';
  end if;

  perform public.inventory_submit_count_v1(
    gen_random_uuid(),
    'shift_change',
    (
      select jsonb_agg(
        jsonb_build_object(
          'inventory_item_id', line.inventory_item_id,
          'counted_quantity_units', greatest(line.expected_quantity_units, 0),
          'note', 'Conteo reversible.'
        )
        order by line.inventory_item_id
      )
      from public.inventory_count_lines line
      where line.inventory_count_id = v_first_id
        and line.line_status = 'pending'
    ),
    'Primer conteo flexible reversible.',
    null,
    v_first_id
  );

  if not exists (
    select 1
    from public.inventory_counts count_header
    where count_header.id = v_first_id
      and count_header.status = 'submitted'
      and count_header.shift_code is null
  ) then
    raise exception 'El primer conteo no quedó presentado y sin numeración.';
  end if;

  select (
    public.inventory_open_shift_count_v2(
      fixture.operation_2,
      fixture.business_date,
      'Segundo cambio de guardia.'
    ) ->> 'inventory_count_id'
  )::bigint
  into v_second_id
  from _flexible_shift_fixture fixture;

  if v_second_id is null or v_second_id = v_first_id then
    raise exception 'No se pudo abrir otro conteo para la misma fecha.';
  end if;

  select (
    public.inventory_open_shift_count_v2(
      fixture.operation_3,
      fixture.business_date,
      'Debe reanudar el conteo abierto.'
    ) ->> 'inventory_count_id'
  )::bigint
  into v_resumed_id
  from _flexible_shift_fixture fixture;

  if v_resumed_id <> v_second_id then
    raise exception 'La nueva apertura no reanudó el conteo que seguía abierto.';
  end if;
end;
$test$;

select jsonb_build_object(
  'certification', 'pass',
  'rule', 'unlimited_submitted_counts_one_open_per_date',
  'orders_touched', 0,
  'rollback', true
) as flexible_shift_certification;

rollback;
