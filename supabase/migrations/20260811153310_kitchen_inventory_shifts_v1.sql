-- Canonical identity and auditable opening for Cocina's two daily inventory shifts.
-- This remains independent from order acceptance and kitchen production status.

alter table public.inventory_counts
  add column if not exists shift_business_date date,
  add column if not exists shift_code text,
  add column if not exists submitted_by_user_id uuid
    references public.profiles(id)
    on delete restrict;

alter table public.inventory_counts
  drop constraint if exists inventory_counts_shift_identity_check;

alter table public.inventory_counts
  add constraint inventory_counts_shift_identity_check
  check (
    (
      count_kind = 'shift_change'
      and shift_business_date is not null
      and shift_code in ('shift_1', 'shift_2')
    )
    or (
      count_kind <> 'shift_change'
      and shift_business_date is null
      and shift_code is null
    )
  );

create unique index if not exists inventory_counts_active_shift_identity_key
  on public.inventory_counts (shift_business_date, shift_code)
  where count_kind = 'shift_change'
    and shift_business_date is not null
    and shift_code is not null
    and status in ('open', 'submitted', 'accepted', 'recount_requested');

create index if not exists inventory_counts_shift_business_date_idx
  on public.inventory_counts (shift_business_date desc, shift_code, status)
  where count_kind = 'shift_change' and shift_business_date is not null;

create index if not exists inventory_counts_submitted_by_user_id_idx
  on public.inventory_counts (submitted_by_user_id)
  where submitted_by_user_id is not null;

create or replace function app_private.inventory_capture_count_submitter_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'open'
    and new.status = 'submitted'
    and new.submitted_by_user_id is null
  then
    new.submitted_by_user_id := auth.uid();
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_capture_count_submitter_v1()
  from public, anon, authenticated;

drop trigger if exists inventory_counts_capture_submitter_v1
  on public.inventory_counts;

create trigger inventory_counts_capture_submitter_v1
before update of status on public.inventory_counts
for each row
execute function app_private.inventory_capture_count_submitter_v1();

create or replace function public.inventory_open_shift_count_v1(
  p_business_date date,
  p_shift_code text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_existing record;
  v_count_id bigint;
  v_item_count integer;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin', 'kitchen')
  ) then
    raise exception 'Solo Cocina o Administracion pueden abrir un conteo de turno.' using errcode = '42501';
  end if;

  if p_business_date is null
    or p_business_date < v_today - 1
    or p_business_date > v_today
  then
    raise exception 'La fecha operativa debe ser hoy o ayer.' using errcode = '22023';
  end if;

  if p_shift_code not in ('shift_1', 'shift_2') then
    raise exception 'Selecciona Turno 1 o Turno 2.' using errcode = '22023';
  end if;

  if length(coalesce(p_notes, '')) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'inventory-shift:' || p_business_date::text || ':' || p_shift_code,
      0
    )
  );

  select count_header.id, count_header.status
  into v_existing
  from public.inventory_counts count_header
  where count_header.count_kind = 'shift_change'
    and count_header.shift_business_date = p_business_date
    and count_header.shift_code = p_shift_code
    and count_header.status in ('open', 'submitted', 'accepted', 'recount_requested')
  order by count_header.id desc
  limit 1
  for update;

  if found then
    if v_existing.status = 'open' then
      return jsonb_build_object(
        'status', 'replayed',
        'inventory_count_id', v_existing.id,
        'shift_business_date', p_business_date,
        'shift_code', p_shift_code
      );
    end if;

    raise exception 'Este turno ya fue cerrado y no admite otro conteo.' using errcode = '23505';
  end if;

  perform 1
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
    and item.primary_count_frequency = 'per_shift'
    and item.primary_count_role = 'kitchen'
    and app_private.inventory_item_is_initialized_v1(item.id)
  order by item.id
  for share;

  select count(*)
  into v_item_count
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
    and item.primary_count_frequency = 'per_shift'
    and item.primary_count_role = 'kitchen'
    and app_private.inventory_item_is_initialized_v1(item.id);

  if v_item_count = 0 then
    raise exception 'No hay items operativos configurados para el conteo por turno.';
  end if;

  if v_item_count > 200 then
    raise exception 'El programa de conteo por turno supera el maximo de 200 items.';
  end if;

  insert into public.inventory_counts (
    count_kind,
    status,
    responsible_role,
    created_by_user_id,
    shift_business_date,
    shift_code,
    notes
  )
  values (
    'shift_change',
    'open',
    'kitchen',
    v_actor,
    p_business_date,
    p_shift_code,
    nullif(btrim(p_notes), '')
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
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
    and item.primary_count_frequency = 'per_shift'
    and item.primary_count_role = 'kitchen'
    and app_private.inventory_item_is_initialized_v1(item.id)
  order by item.id;

  return jsonb_build_object(
    'status', 'applied',
    'inventory_count_id', v_count_id,
    'item_count', v_item_count,
    'shift_business_date', p_business_date,
    'shift_code', p_shift_code
  );
end;
$$;

revoke all on function public.inventory_open_shift_count_v1(date, text, text)
  from public, anon;
grant execute on function public.inventory_open_shift_count_v1(date, text, text)
  to authenticated, service_role;

comment on column public.inventory_counts.shift_business_date is
  'Caracas operating date for canonical Kitchen shift counts.';
comment on column public.inventory_counts.shift_code is
  'Canonical Kitchen shift identity: shift_1 or shift_2.';
comment on column public.inventory_counts.submitted_by_user_id is
  'Authenticated actor who moved an open count to submitted.';
comment on function public.inventory_open_shift_count_v1(date, text, text) is
  'Atomically opens or resumes one blind Kitchen count per operating date and shift.';

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_counts'
  ) then
    execute 'alter publication supabase_realtime add table public.inventory_counts';
  end if;

  if exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_planned_flows'
  ) then
    execute 'alter publication supabase_realtime add table public.inventory_planned_flows';
  end if;
end;
$$;
