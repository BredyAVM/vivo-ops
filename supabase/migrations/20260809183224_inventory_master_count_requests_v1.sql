-- Block 25: let Master request blind item counts without creating a second
-- inventory model. The request reuses inventory_counts/count_lines and only
-- snapshots the expected balance; it never changes stock or order state.

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.inventory_counts
  add column request_operation_id uuid;

create unique index inventory_counts_request_operation_id_uidx
  on public.inventory_counts using btree (request_operation_id)
  where request_operation_id is not null;

comment on column public.inventory_counts.request_operation_id is
  'Idempotency key used only when Master or Administration opens a requested count.';

create or replace function public.inventory_request_count_v1(
  p_operation_id uuid,
  p_inventory_item_ids bigint[],
  p_due_at timestamptz default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_count_id bigint;
  v_due_at timestamptz;
  v_item_ids bigint[];
  v_conflicting_items text;
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
    raise exception 'Solo Máster o Administración pueden solicitar conteos.' using errcode = '42501';
  end if;

  if p_operation_id is null then
    raise exception 'La clave de operación es obligatoria.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  select count_header.id
  into v_count_id
  from public.inventory_counts count_header
  where count_header.request_operation_id = p_operation_id;

  if found then
    return jsonb_build_object(
      'status', 'replayed',
      'inventory_count_id', v_count_id
    );
  end if;

  if p_inventory_item_ids is null
    or cardinality(p_inventory_item_ids) = 0
    or cardinality(p_inventory_item_ids) > 200 then
    raise exception 'La solicitud debe incluir entre 1 y 200 ítems.' using errcode = '22023';
  end if;

  if array_position(p_inventory_item_ids, null) is not null then
    raise exception 'La solicitud contiene un ítem inválido.' using errcode = '22023';
  end if;

  select array_agg(distinct item_id order by item_id)
  into v_item_ids
  from unnest(p_inventory_item_ids) item_id;

  if cardinality(v_item_ids) <> cardinality(p_inventory_item_ids) then
    raise exception 'Un ítem no puede repetirse en la misma solicitud.' using errcode = '22023';
  end if;

  if nullif(btrim(p_notes), '') is not null and length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  v_due_at := coalesce(p_due_at, now() + interval '30 minutes');
  if v_due_at < now() then
    raise exception 'La fecha límite del conteo no puede estar en el pasado.' using errcode = '22023';
  end if;

  -- Lock the selected catalog rows so every line receives one consistent
  -- expected-balance snapshot.
  perform item.id
  from public.inventory_items item
  where item.id = any(v_item_ids)
  order by item.id
  for share;

  if (
    select count(*)
    from public.inventory_items item
    where item.id = any(v_item_ids)
      and item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
      and app_private.inventory_item_is_initialized_v1(item.id)
  ) <> cardinality(v_item_ids) then
    raise exception 'Uno o más ítems no están activos, inventariables o inicializados.' using errcode = '22023';
  end if;

  select string_agg(item.name, ', ' order by item.name)
  into v_conflicting_items
  from public.inventory_count_lines count_line
  join public.inventory_counts count_header
    on count_header.id = count_line.inventory_count_id
  join public.inventory_items item
    on item.id = count_line.inventory_item_id
  where count_line.inventory_item_id = any(v_item_ids)
    and count_header.status in ('open', 'submitted', 'recount_requested')
    and count_line.line_status in ('pending', 'submitted', 'recount_requested');

  if v_conflicting_items is not null then
    raise exception 'Ya existe un conteo pendiente para: %.', v_conflicting_items
      using errcode = '23505';
  end if;

  insert into public.inventory_counts (
    count_kind,
    status,
    responsible_role,
    requested_by_user_id,
    created_by_user_id,
    due_at,
    notes,
    request_operation_id
  )
  values (
    'requested',
    'open',
    'kitchen',
    v_actor,
    v_actor,
    v_due_at,
    nullif(btrim(p_notes), ''),
    p_operation_id
  )
  returning id into v_count_id;

  insert into public.inventory_count_lines (
    inventory_count_id,
    inventory_item_id,
    expected_quantity_units,
    line_status
  )
  select
    v_count_id,
    item.id,
    item.current_stock_units,
    'pending'
  from public.inventory_items item
  where item.id = any(v_item_ids)
  order by item.id;

  return jsonb_build_object(
    'status', 'applied',
    'inventory_count_id', v_count_id,
    'item_count', cardinality(v_item_ids),
    'due_at', v_due_at
  );
end;
$$;

revoke all on function public.inventory_request_count_v1(uuid, bigint[], timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.inventory_request_count_v1(uuid, bigint[], timestamptz, text)
  to authenticated, service_role;

comment on function public.inventory_request_count_v1(uuid, bigint[], timestamptz, text) is
  'Opens an idempotent blind count request for Kitchen; snapshots expected stock without changing inventory or orders.';
