-- Supplemental recounts for an existing count lineage.
-- Reuses inventory_counts.parent_count_id and inventory_count_lines.recounted_from_line_id.
-- No table or column is added.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.inventory_request_supplemental_recount_v1(
  p_parent_count_id bigint,
  p_line_ids bigint[],
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_parent public.inventory_counts%rowtype;
  v_recount_id bigint;
  v_now timestamptz := now();
  v_added_count integer;
  v_was_open boolean := false;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Máster o Administración pueden ampliar un reconteo.'
      using errcode = '42501';
  end if;

  if p_parent_count_id is null or p_parent_count_id <= 0 then
    raise exception 'El conteo padre es obligatorio.' using errcode = '22023';
  end if;

  if p_line_ids is null or cardinality(p_line_ids) = 0 then
    raise exception 'Selecciona al menos un ítem para el reconteo complementario.'
      using errcode = '22023';
  end if;

  if cardinality(p_line_ids) > 200 then
    raise exception 'El reconteo admite hasta 200 ítems.' using errcode = '22023';
  end if;

  if cardinality(p_line_ids) <> (
    select count(distinct selected.line_id)
    from unnest(p_line_ids) selected(line_id)
  ) then
    raise exception 'Una línea no puede repetirse.' using errcode = '22023';
  end if;

  if length(coalesce(p_notes, '')) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(p_parent_count_id);

  select count_header.*
  into v_parent
  from public.inventory_counts count_header
  where count_header.id = p_parent_count_id
  for update;

  if not found then
    raise exception 'Conteo padre no encontrado.';
  end if;

  if v_parent.status not in ('accepted', 'recount_requested') then
    raise exception 'El conteo debe estar aceptado o tener un reconteo en curso.'
      using errcode = '22023';
  end if;

  if (
    select count(*)
    from public.inventory_count_lines parent_line
    where parent_line.inventory_count_id = v_parent.id
      and parent_line.id = any(p_line_ids)
      and parent_line.line_status = 'accepted'
  ) <> cardinality(p_line_ids) then
    raise exception 'Uno o más ítems ya están en reconteo o no pertenecen al conteo padre.'
      using errcode = '22023';
  end if;

  -- If a sibling recount is still open, extend it. Submitted recounts stay
  -- immutable; in that case a second sibling is created and both remain linked.
  select child.id
  into v_recount_id
  from public.inventory_counts child
  where child.parent_count_id = v_parent.id
    and child.count_kind = 'recount'
    and child.status = 'open'
  order by child.id desc
  limit 1
  for update;

  if found then
    v_was_open := true;
  else
    insert into public.inventory_counts (
      count_kind,
      status,
      responsible_role,
      parent_count_id,
      requested_by_user_id,
      created_by_user_id,
      notes
    )
    values (
      'recount',
      'open',
      v_parent.responsible_role,
      v_parent.id,
      v_actor,
      v_actor,
      nullif(btrim(p_notes), '')
    )
    returning id into v_recount_id;
  end if;

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
  where parent_line.inventory_count_id = v_parent.id
    and parent_line.id = any(p_line_ids)
    and parent_line.line_status = 'accepted'
  order by parent_line.id;
  get diagnostics v_added_count = row_count;

  if v_added_count <> cardinality(p_line_ids) then
    raise exception 'No se pudieron preparar todos los ítems seleccionados.';
  end if;

  update public.inventory_count_lines parent_line
  set line_status = 'recount_requested',
      reviewed_by_user_id = v_actor,
      reviewed_at = v_now
  where parent_line.inventory_count_id = v_parent.id
    and parent_line.id = any(p_line_ids)
    and parent_line.line_status = 'accepted';

  update public.inventory_counts
  set status = 'recount_requested',
      reviewed_by_user_id = v_actor,
      reviewed_at = v_now,
      notes = case
        when nullif(btrim(p_notes), '') is null then notes
        when notes is null then btrim(p_notes)
        else notes || E'\n' || btrim(p_notes)
      end
  where id = v_parent.id;

  if v_was_open and nullif(btrim(p_notes), '') is not null then
    update public.inventory_counts
    set notes = case
      when notes is null then btrim(p_notes)
      else notes || E'\n' || btrim(p_notes)
    end
    where id = v_recount_id;
  end if;

  return jsonb_build_object(
    'status', case when v_was_open then 'expanded' else 'created' end,
    'inventory_count_id', v_parent.id,
    'recount_inventory_count_id', v_recount_id,
    'added_line_count', v_added_count
  );
end;
$$;

revoke all on function public.inventory_request_supplemental_recount_v1(bigint, bigint[], text)
  from public, anon;
grant execute on function public.inventory_request_supplemental_recount_v1(bigint, bigint[], text)
  to authenticated, service_role;

comment on function public.inventory_request_supplemental_recount_v1(bigint, bigint[], text) is
  'Adds accepted parent lines to its open recount or creates a linked supplemental sibling; submitted history remains immutable.';
