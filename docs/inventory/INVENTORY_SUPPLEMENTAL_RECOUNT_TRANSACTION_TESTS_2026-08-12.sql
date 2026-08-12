-- Certificación reversible de reconteos complementarios.
-- Requiere inventory_supplemental_recounts_v1. Todo termina en ROLLBACK.
begin;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', actor.user_id, 'role', 'authenticated')::text,
  true
)
from (
  select role_row.user_id
  from public.user_roles role_row
  where role_row.role = 'master'
  order by role_row.user_id
  limit 1
) actor;

create temporary table _supplemental_fixture as
select
  parent.id as parent_count_id,
  (array_agg(line.id order by line.id))[1] as line_id_1,
  (array_agg(line.id order by line.id))[2] as line_id_2,
  (array_agg(line.id order by line.id))[3] as line_id_3
from public.inventory_counts parent
join public.inventory_count_lines line
  on line.inventory_count_id = parent.id
 and line.line_status = 'accepted'
where parent.status = 'accepted'
group by parent.id
having count(*) >= 3
order by parent.id desc
limit 1;

do $test$
declare
  v_parent_id bigint;
  v_line_1 bigint;
  v_line_2 bigint;
  v_line_3 bigint;
  v_first jsonb;
  v_second jsonb;
  v_third jsonb;
  v_recount_id bigint;
  v_sibling_recount_id bigint;
  v_admin uuid;
  v_submission_lines jsonb;
begin
  if auth.uid() is null then
    raise exception 'La prueba requiere al menos un usuario Máster.';
  end if;

  select parent_count_id, line_id_1, line_id_2, line_id_3
  into v_parent_id, v_line_1, v_line_2, v_line_3
  from _supplemental_fixture;

  if v_parent_id is null then
    raise exception 'No hay un conteo aceptado con tres líneas para la prueba.';
  end if;

  v_first := public.inventory_request_supplemental_recount_v1(
    v_parent_id,
    array[v_line_1],
    'Primera parte reversible.'
  );
  v_recount_id := (v_first ->> 'recount_inventory_count_id')::bigint;

  v_second := public.inventory_request_supplemental_recount_v1(
    v_parent_id,
    array[v_line_2],
    'Segunda parte reversible.'
  );

  if v_first ->> 'status' <> 'created'
    or v_second ->> 'status' <> 'expanded'
    or (v_second ->> 'recount_inventory_count_id')::bigint <> v_recount_id
  then
    raise exception 'La solicitud abierta no se amplió correctamente.';
  end if;

  if (
    select count(*)
    from public.inventory_count_lines child_line
    where child_line.inventory_count_id = v_recount_id
      and child_line.recounted_from_line_id in (v_line_1, v_line_2)
      and child_line.line_status = 'pending'
  ) <> 2 then
    raise exception 'El reconteo no recibió las dos líneas.';
  end if;

  select role_row.user_id
  into v_admin
  from public.user_roles role_row
  where role_row.role = 'admin'
  order by role_row.user_id
  limit 1;

  if v_admin is null then
    raise exception 'La prueba requiere al menos un usuario Administrador.';
  end if;

  select jsonb_agg(jsonb_build_object(
    'inventory_item_id', child_line.inventory_item_id,
    'counted_quantity_units', child_line.expected_quantity_units,
    'note', 'Presentación reversible.'
  ) order by child_line.id)
  into v_submission_lines
  from public.inventory_count_lines child_line
  where child_line.inventory_count_id = v_recount_id;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_submit_staged_recount_v1(
    gen_random_uuid(),
    v_recount_id,
    v_submission_lines,
    null
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', (
      select role_row.user_id
      from public.user_roles role_row
      where role_row.role = 'master'
      order by role_row.user_id
      limit 1
    ), 'role', 'authenticated')::text,
    true
  );

  v_third := public.inventory_request_supplemental_recount_v1(
    v_parent_id,
    array[v_line_3],
    'Hijo complementario reversible.'
  );
  v_sibling_recount_id := (v_third ->> 'recount_inventory_count_id')::bigint;

  if v_third ->> 'status' <> 'created'
    or v_sibling_recount_id = v_recount_id
    or not exists (
      select 1
      from public.inventory_counts first_child
      where first_child.id = v_recount_id
        and first_child.status = 'submitted'
    )
    or not exists (
      select 1
      from public.inventory_count_lines sibling_line
      where sibling_line.inventory_count_id = v_sibling_recount_id
        and sibling_line.recounted_from_line_id = v_line_3
        and sibling_line.line_status = 'pending'
    )
  then
    raise exception 'El reconteo presentado no conservó su historia o no creó el hijo complementario.';
  end if;
end;
$test$;

select jsonb_build_object(
  'certification', 'pass',
  'created_then_expanded', true,
  'submitted_then_sibling_created', true,
  'orders_touched', 0,
  'rollback', true
) as supplemental_recount_certification;

rollback;
