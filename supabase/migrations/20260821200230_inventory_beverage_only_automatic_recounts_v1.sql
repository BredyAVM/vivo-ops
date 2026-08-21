set lock_timeout = '5s';
set statement_timeout = '30s';

-- Automatic zero-difference verification is intentionally limited to drinks.
-- Food, prefried stock and sauces still adjust to the physical count, retain
-- their variance for Master review, and never open an automatic recount.
create or replace function public.inventory_prepare_automatic_recount_v1(
  p_inventory_count_id bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_count record;
  v_existing_recount_id bigint;
  v_recount_id bigint;
  v_variance_count integer;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin', 'kitchen')
  ) then
    raise exception 'Solo Cocina o Administración pueden preparar la verificación ciega.'
      using errcode = '42501';
  end if;

  select count_header.*
  into v_count
  from public.inventory_counts count_header
  where count_header.id = p_inventory_count_id
  for update;

  if not found then
    raise exception 'Conteo no encontrado.' using errcode = 'P0002';
  end if;

  if v_count.count_kind <> 'shift_change'
    or v_count.responsible_role <> 'kitchen'::public.user_role
  then
    raise exception 'La verificación automática solo aplica al conteo por turno de Cocina.'
      using errcode = '22023';
  end if;

  select child.id
  into v_existing_recount_id
  from public.inventory_counts child
  where child.parent_count_id = v_count.id
    and child.count_kind = 'recount'
    and child.notes like 'Segunda verificación ciega automática de bebidas%'
  order by child.id desc
  limit 1;

  if found then
    return jsonb_build_object(
      'status', 'replayed',
      'inventory_count_id', v_count.id,
      'recount_inventory_count_id', v_existing_recount_id,
      'variance_count', (
        select count(*)
        from public.inventory_count_lines child_line
        where child_line.inventory_count_id = v_existing_recount_id
      )
    );
  end if;

  if v_count.status <> 'submitted' then
    raise exception 'El conteo debe estar presentado antes de verificar diferencias.';
  end if;

  if v_count.submitted_by_user_id is distinct from v_actor
    and not exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = v_actor and role_row.role = 'admin'
    )
  then
    raise exception 'Solo quien presentó el conteo puede iniciar su verificación automática.'
      using errcode = '42501';
  end if;

  select count(*)
  into v_variance_count
  from public.inventory_count_lines count_line
  join public.inventory_items item on item.id = count_line.inventory_item_id
  where count_line.inventory_count_id = v_count.id
    and count_line.line_status = 'submitted'
    and item.inventory_group = 'beverages'
    and coalesce(count_line.difference_quantity_units, 0) <> 0;

  if v_variance_count = 0 then
    return jsonb_build_object(
      'status', 'no_beverage_variance',
      'inventory_count_id', v_count.id,
      'recount_inventory_count_id', null,
      'variance_count', 0
    );
  end if;

  insert into public.inventory_counts (
    count_kind,
    status,
    responsible_role,
    parent_count_id,
    requested_by_user_id,
    created_by_user_id,
    due_at,
    notes
  )
  values (
    'recount',
    'open',
    'kitchen',
    v_count.id,
    v_actor,
    v_actor,
    now() + interval '2 hours',
    'Segunda verificación ciega automática de bebidas con diferencias. Los demás grupos permanecen en revisión normal del Máster.'
  )
  returning id into v_recount_id;

  insert into public.inventory_count_lines (
    inventory_count_id,
    inventory_item_id,
    expected_quantity_units,
    line_status,
    recounted_from_line_id
  )
  select
    v_recount_id,
    parent_line.inventory_item_id,
    item.current_stock_units,
    'pending',
    parent_line.id
  from public.inventory_count_lines parent_line
  join public.inventory_items item on item.id = parent_line.inventory_item_id
  where parent_line.inventory_count_id = v_count.id
    and parent_line.line_status = 'submitted'
    and item.inventory_group = 'beverages'
    and coalesce(parent_line.difference_quantity_units, 0) <> 0
  order by parent_line.id;

  return jsonb_build_object(
    'status', 'applied',
    'inventory_count_id', v_count.id,
    'recount_inventory_count_id', v_recount_id,
    'variance_count', v_variance_count
  );
end;
$$;

revoke all on function public.inventory_prepare_automatic_recount_v1(bigint)
  from public, anon;
grant execute on function public.inventory_prepare_automatic_recount_v1(bigint)
  to authenticated, service_role;

create or replace function app_private.inventory_guard_unresolved_child_acceptance_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'accepted'
    and old.status is distinct from 'accepted'
    and exists (
      select 1
      from public.inventory_counts child
      where child.parent_count_id = new.id
        and child.status in ('open', 'submitted', 'recount_requested')
    )
  then
    raise exception 'Primero debe resolverse el reconteo vinculado antes de aceptar el conteo padre.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_counts_guard_unresolved_child_acceptance_trg
  on public.inventory_counts;
create trigger inventory_counts_guard_unresolved_child_acceptance_trg
before update of status on public.inventory_counts
for each row
execute function app_private.inventory_guard_unresolved_child_acceptance_v1();

revoke all on function app_private.inventory_guard_unresolved_child_acceptance_v1()
  from public, anon, authenticated, service_role;

comment on function public.inventory_prepare_automatic_recount_v1(bigint) is
  'Opens an immediate blind recount only for beverage variances. Other groups remain submitted for normal Master review.';
comment on function app_private.inventory_guard_unresolved_child_acceptance_v1() is
  'Prevents accepting a parent count while any linked recount is unresolved.';
