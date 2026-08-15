-- An interrupted count must be removable from the operational queue without
-- deleting its audit trail. Reuse inventory_counts.status = 'cancelled'; no new
-- tables or columns are required.

create or replace function public.inventory_cancel_open_count_v1(
  p_inventory_count_id bigint,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_count public.inventory_counts%rowtype;
  v_is_manager boolean;
  v_is_kitchen boolean;
  v_reason text := nullif(btrim(p_notes), '');
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;

  if p_inventory_count_id is null or p_inventory_count_id <= 0 then
    raise exception 'El conteo indicado no es valido.' using errcode = '22023';
  end if;

  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception 'La nota no puede superar 1.000 caracteres.' using errcode = '22023';
  end if;

  select
    exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role in ('admin', 'master')
    ),
    exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role = 'kitchen'
    )
  into v_is_manager, v_is_kitchen;

  select count_header.*
  into v_count
  from public.inventory_counts count_header
  where count_header.id = p_inventory_count_id
  for update;

  if not found then
    raise exception 'Conteo no encontrado.';
  end if;

  if not v_is_manager and not (
    v_is_kitchen
    and v_count.responsible_role = 'kitchen'::public.user_role
    and v_count.created_by_user_id = v_actor
    and v_count.count_kind in ('shift_change', 'periodic')
  ) then
    raise exception 'No tienes permiso para eliminar este conteo abierto.' using errcode = '42501';
  end if;

  if v_count.status = 'cancelled' then
    return jsonb_build_object(
      'status', 'replayed',
      'inventory_count_id', v_count.id,
      'count_status', v_count.status
    );
  end if;

  if v_count.status <> 'open' then
    raise exception 'Solo se puede eliminar un conteo que todavia este abierto.';
  end if;

  if v_count.submitted_at is not null or exists (
    select 1
    from public.inventory_count_lines count_line
    where count_line.inventory_count_id = v_count.id
      and (
        count_line.movement_id is not null
        or count_line.counted_quantity_units is not null
        or count_line.counted_at is not null
      )
  ) then
    raise exception 'Este conteo ya contiene datos aplicados y no puede eliminarse.';
  end if;

  if exists (
    select 1
    from public.inventory_counts child_count
    where child_count.parent_count_id = v_count.id
      and child_count.status <> 'cancelled'
  ) then
    raise exception 'Este conteo tiene un reconteo relacionado y no puede eliminarse.';
  end if;

  update public.inventory_counts
  set status = 'cancelled',
      reviewed_at = v_now,
      reviewed_by_user_id = v_actor,
      notes = case
        when v_reason is null and notes is null then 'Conteo abierto eliminado antes de ser presentado.'
        when v_reason is null then notes || E'\nConteo abierto eliminado antes de ser presentado.'
        when notes is null then v_reason
        else notes || E'\n' || v_reason
      end
  where id = v_count.id;

  return jsonb_build_object(
    'status', 'applied',
    'inventory_count_id', v_count.id,
    'count_status', 'cancelled'
  );
end;
$$;

revoke all on function public.inventory_cancel_open_count_v1(bigint, text)
  from public, anon, authenticated;
grant execute on function public.inventory_cancel_open_count_v1(bigint, text)
  to authenticated;

comment on function public.inventory_cancel_open_count_v1(bigint, text) is
  'Retira un conteo abierto sin movimientos de la operacion conservando su trazabilidad como cancelado; Master/Administracion o Cocina para sus propios conteos por turno.';
