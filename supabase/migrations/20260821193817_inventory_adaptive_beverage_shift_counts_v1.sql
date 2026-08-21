set lock_timeout = '5s';
set statement_timeout = '30s';

alter table public.inventory_items
  add column if not exists primary_count_location_code text;

alter table public.inventory_items
  drop constraint if exists inventory_items_primary_count_location_code_check;

alter table public.inventory_items
  add constraint inventory_items_primary_count_location_code_check
  check (
    primary_count_location_code is null
    or (
      char_length(primary_count_location_code) between 1 and 80
      and primary_count_location_code ~ '^[a-z0-9][a-z0-9_]*$'
    )
  ) not valid;

alter table public.inventory_items
  validate constraint inventory_items_primary_count_location_code_check;

create index if not exists inventory_items_count_program_idx
  on public.inventory_items (
    inventory_group,
    primary_count_role,
    primary_count_frequency,
    primary_count_location_code,
    id
  )
  where is_active and merged_into_item_id is null;

-- Initial physical routes follow the two exhibitor coolers described by the
-- operation. Reserve units are counted together with their corresponding
-- cooler, so the canonical stock remains one balance per beverage.
update public.inventory_items
set primary_count_location_code = 'beverage_pepsi'
where inventory_group = 'beverages'
  and merged_into_item_id is null
  and (
    lower(name) like 'pepsi%'
    or lower(name) like 'yukery%'
    or lower(name) like 'yukipack%'
    or lower(name) like 'lipton%'
    or lower(name) like 'malta%'
  );

update public.inventory_items
set primary_count_location_code = 'beverage_coca_cola'
where inventory_group = 'beverages'
  and merged_into_item_id is null
  and primary_count_location_code is null
  and (
    lower(name) like 'coca-cola%'
    or lower(name) like 'chinotto%'
    or lower(name) like 'fanta%'
    or lower(name) like 'frescolita%'
    or lower(name) like 'hit%'
    or lower(name) like 'jugo del valle%'
  );

update public.inventory_items
set primary_count_location_code = 'beverage_reserve'
where inventory_group = 'beverages'
  and merged_into_item_id is null
  and primary_count_location_code is null;

-- The seven beverages with material dispatch velocity in the audited 30-day
-- period remain daily. The long tail moves to a weekly cycle. Administration
-- can change either value later through the existing item controls.
update public.inventory_items
set primary_count_frequency = case
      when lower(name) in (
        'coca-cola 1,5 lts',
        'coca-cola 2 lts',
        'coca-cola lata',
        'malta lata',
        'pepsi 1,5 lts',
        'pepsi 2 lts',
        'pepsi lata'
      ) then 'daily'
      else 'weekly'
    end,
    primary_count_role = 'kitchen'::public.user_role
where inventory_group = 'beverages'
  and is_active
  and merged_into_item_id is null;

create or replace function app_private.inventory_shift_count_selection_v1(
  p_business_date date
)
returns table (
  inventory_item_id bigint,
  sort_priority integer,
  selection_reason text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with item_context as (
    select
      item.id,
      item.inventory_group,
      item.current_stock_units,
      item.low_stock_threshold,
      item.primary_count_frequency,
      coalesce(item.primary_count_location_code, 'beverage_reserve') as count_location_code,
      latest.counted_at as last_counted_at,
      latest.difference_quantity_units as last_difference_units,
      latest.counted_at is not null
        and (latest.counted_at at time zone 'America/Caracas')::date = p_business_date
        as counted_on_business_date,
      exists (
        select 1
        from public.inventory_movements movement
        where movement.inventory_item_id = item.id
          and movement.movement_type in ('inbound', 'return_in')
          and movement.created_at > coalesce(latest.counted_at, '-infinity'::timestamptz)
      ) as received_after_last_count,
      case item.primary_count_frequency
        when 'per_shift' then true
        when 'daily' then latest.counted_at is null
          or (latest.counted_at at time zone 'America/Caracas')::date < p_business_date
        when 'weekly' then latest.counted_at is null
          or (latest.counted_at at time zone 'America/Caracas')::date <= p_business_date - 7
        when 'biweekly' then latest.counted_at is null
          or (latest.counted_at at time zone 'America/Caracas')::date <= p_business_date - 14
        when 'monthly' then latest.counted_at is null
          or (latest.counted_at at time zone 'America/Caracas')::date <= (p_business_date - interval '1 month')::date
        else false
      end as frequency_due
    from public.inventory_items item
    left join lateral (
      select
        count_line.counted_at,
        count_line.difference_quantity_units
      from public.inventory_count_lines count_line
      join public.inventory_counts count_header
        on count_header.id = count_line.inventory_count_id
      where count_line.inventory_item_id = item.id
        and count_line.counted_at is not null
        and count_header.status <> 'cancelled'
      order by count_line.counted_at desc, count_line.id desc
      limit 1
    ) latest on true
    where item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
      and item.primary_count_role = 'kitchen'::public.user_role
      and app_private.inventory_item_is_initialized_v1(item.id)
  ),
  selected_long_cycle_location as (
    select context.count_location_code
    from item_context context
    where context.inventory_group = 'beverages'
      and context.primary_count_frequency in ('weekly', 'biweekly', 'monthly')
      and context.frequency_due
      and (context.current_stock_units > 0 or context.received_after_last_count)
    group by context.count_location_code
    order by min(context.last_counted_at) nulls first, context.count_location_code
    limit 1
  )
  select
    context.id as inventory_item_id,
    case
      when context.inventory_group = 'raw' then 10
      when context.inventory_group = 'prefried' then 20
      when context.inventory_group = 'sauces' then 30
      when context.inventory_group <> 'beverages' then 40
      when context.received_after_last_count then 50
      when coalesce(context.last_difference_units, 0) <> 0 then 51
      when context.low_stock_threshold is not null
        and context.current_stock_units > 0
        and context.current_stock_units <= context.low_stock_threshold then 52
      when context.primary_count_frequency in ('per_shift', 'daily') then 53
      else 60
    end as sort_priority,
    case
      when context.inventory_group <> 'beverages' then 'fixed_per_shift'
      when context.received_after_last_count then 'received_after_count'
      when coalesce(context.last_difference_units, 0) <> 0
        and not context.counted_on_business_date then 'previous_variance'
      when context.low_stock_threshold is not null
        and context.current_stock_units > 0
        and context.current_stock_units <= context.low_stock_threshold
        and not context.counted_on_business_date then 'near_threshold'
      when context.primary_count_frequency = 'per_shift' then 'beverage_per_shift'
      when context.primary_count_frequency = 'daily' then 'daily_cycle'
      else 'scheduled_cycle'
    end as selection_reason
  from item_context context
  where (
      context.inventory_group <> 'beverages'
      and context.primary_count_frequency = 'per_shift'
    )
    or (
      context.inventory_group = 'beverages'
      and (
        context.primary_count_frequency = 'per_shift'
        or (
          context.primary_count_frequency = 'daily'
          and context.frequency_due
          and (context.current_stock_units > 0 or context.received_after_last_count)
        )
        or context.received_after_last_count
        or (
          coalesce(context.last_difference_units, 0) <> 0
          and not context.counted_on_business_date
        )
        or (
          context.low_stock_threshold is not null
          and context.current_stock_units > 0
          and context.current_stock_units <= context.low_stock_threshold
          and not context.counted_on_business_date
        )
        or (
          context.primary_count_frequency in ('weekly', 'biweekly', 'monthly')
          and context.frequency_due
          and (context.current_stock_units > 0 or context.received_after_last_count)
          and context.count_location_code = (
            select location.count_location_code
            from selected_long_cycle_location location
          )
        )
      )
    );
$$;

revoke all on function app_private.inventory_shift_count_selection_v1(date)
  from public, anon, authenticated, service_role;

create or replace function public.inventory_open_shift_count_v2(
  p_operation_id uuid,
  p_business_date date,
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
  v_item_ids bigint[];
  v_item_count integer;
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
    raise exception 'Solo Cocina o Administración pueden abrir un conteo por turno.'
      using errcode = '42501';
  end if;

  if p_operation_id is null then
    raise exception 'La operación es obligatoria.' using errcode = '22023';
  end if;

  if p_business_date is null
    or p_business_date < v_today - 1
    or p_business_date > v_today
  then
    raise exception 'La fecha operativa debe ser hoy o ayer.' using errcode = '22023';
  end if;

  if length(coalesce(p_notes, '')) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-guard-change:' || p_business_date::text, 0)
  );

  select count_header.id, count_header.status, count_header.count_kind,
         count_header.shift_business_date
  into v_existing
  from public.inventory_counts count_header
  where count_header.request_operation_id = p_operation_id
  for update;

  if found then
    if v_existing.count_kind <> 'shift_change'
      or v_existing.shift_business_date is distinct from p_business_date
    then
      raise exception 'La operación ya fue usada para otro conteo.' using errcode = '23505';
    end if;

    return jsonb_build_object(
      'status', 'replayed',
      'inventory_count_id', v_existing.id,
      'shift_business_date', p_business_date
    );
  end if;

  select count_header.id, count_header.status
  into v_existing
  from public.inventory_counts count_header
  where count_header.count_kind = 'shift_change'
    and count_header.shift_business_date = p_business_date
    and count_header.status = 'open'
  order by count_header.id desc
  limit 1
  for update;

  if found then
    return jsonb_build_object(
      'status', 'resumed',
      'inventory_count_id', v_existing.id,
      'shift_business_date', p_business_date
    );
  end if;

  select array_agg(selection.inventory_item_id order by selection.sort_priority, item.name, item.id)
  into v_item_ids
  from app_private.inventory_shift_count_selection_v1(p_business_date) selection
  join public.inventory_items item on item.id = selection.inventory_item_id;

  v_item_count := coalesce(cardinality(v_item_ids), 0);

  if v_item_count = 0 then
    raise exception 'No hay ítems operativos configurados para el conteo por turno.';
  end if;

  if v_item_count > 200 then
    raise exception 'El programa de conteo por turno supera el máximo de 200 ítems.';
  end if;

  perform 1
  from public.inventory_items item
  where item.id = any(v_item_ids)
  order by item.id
  for share;

  insert into public.inventory_counts (
    count_kind,
    status,
    responsible_role,
    created_by_user_id,
    request_operation_id,
    shift_business_date,
    shift_code,
    notes
  )
  values (
    'shift_change',
    'open',
    'kitchen',
    v_actor,
    p_operation_id,
    p_business_date,
    null,
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
  where item.id = any(v_item_ids)
  order by array_position(v_item_ids, item.id);

  return jsonb_build_object(
    'status', 'applied',
    'inventory_count_id', v_count_id,
    'item_count', v_item_count,
    'shift_business_date', p_business_date
  );
end;
$$;

revoke all on function public.inventory_open_shift_count_v2(uuid, date, text)
  from public, anon;
grant execute on function public.inventory_open_shift_count_v2(uuid, date, text)
  to authenticated, service_role;

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

  if v_count.status = 'recount_requested' then
    select child.id
    into v_existing_recount_id
    from public.inventory_counts child
    where child.parent_count_id = v_count.id
      and child.status in ('open', 'submitted', 'recount_requested')
    order by child.id desc
    limit 1;

    return jsonb_build_object(
      'status', 'replayed',
      'inventory_count_id', v_count.id,
      'recount_inventory_count_id', v_existing_recount_id,
      'variance_count', (
        select count(*)
        from public.inventory_count_lines line
        where line.inventory_count_id = v_count.id
          and line.line_status = 'recount_requested'
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
  from public.inventory_count_lines line
  where line.inventory_count_id = v_count.id
    and line.line_status = 'submitted'
    and coalesce(line.difference_quantity_units, 0) <> 0;

  if v_variance_count = 0 then
    return jsonb_build_object(
      'status', 'no_variance',
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
    'Segunda verificación ciega automática de las diferencias del conteo padre.'
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
    and coalesce(parent_line.difference_quantity_units, 0) <> 0
  order by parent_line.id;

  update public.inventory_count_lines parent_line
  set line_status = case
        when coalesce(parent_line.difference_quantity_units, 0) <> 0
          then 'recount_requested'
        else 'accepted'
      end
  where parent_line.inventory_count_id = v_count.id
    and parent_line.line_status = 'submitted';

  update public.inventory_counts
  set status = 'recount_requested',
      notes = case
        when notes is null then 'El sistema abrió una segunda verificación ciega para las diferencias.'
        else notes || E'\nEl sistema abrió una segunda verificación ciega para las diferencias.'
      end
  where id = v_count.id;

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

create or replace function public.inventory_submit_shift_count_with_recount_v1(
  p_operation_id uuid,
  p_lines jsonb,
  p_notes text default null,
  p_existing_count_id bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_submit_result jsonb;
  v_recount_result jsonb;
  v_count_id bigint;
begin
  v_submit_result := public.inventory_submit_count_v1(
    p_operation_id,
    'shift_change',
    p_lines,
    p_notes,
    null,
    p_existing_count_id
  );
  v_count_id := nullif(v_submit_result ->> 'inventory_count_id', '')::bigint;
  if v_count_id is null then
    raise exception 'El conteo presentado no devolvió un identificador.';
  end if;

  v_recount_result := public.inventory_prepare_automatic_recount_v1(v_count_id);
  return v_submit_result || jsonb_build_object(
    'recount_inventory_count_id', v_recount_result -> 'recount_inventory_count_id',
    'variance_count', coalesce((v_recount_result ->> 'variance_count')::integer, 0),
    'verification_status', v_recount_result ->> 'status'
  );
end;
$$;

revoke all on function public.inventory_submit_shift_count_with_recount_v1(uuid, jsonb, text, bigint)
  from public, anon;
grant execute on function public.inventory_submit_shift_count_with_recount_v1(uuid, jsonb, text, bigint)
  to authenticated, service_role;

create or replace function public.inventory_update_item_controls_v1(
  p_configuration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.inventory_items%rowtype;
  v_item_id bigint;
  v_name text;
  v_availability_mode text;
  v_low_stock_threshold numeric;
  v_low_stock_inclusive boolean;
  v_target_stock_units numeric;
  v_shelf_life_days integer;
  v_primary_count_frequency text;
  v_primary_count_role text;
  v_primary_count_location_code text;
  v_notes text;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede modificar controles de inventario.' using errcode = '42501';
  end if;
  if p_configuration is null or jsonb_typeof(p_configuration) <> 'object' then
    raise exception 'La configuración del ítem debe ser un objeto.' using errcode = '22023';
  end if;
  if pg_column_size(p_configuration) > 32768 then
    raise exception 'La configuración supera el tamaño permitido.' using errcode = '22023';
  end if;

  v_item_id := nullif(btrim(coalesce(p_configuration ->> 'inventory_item_id', '')), '')::bigint;
  if v_item_id is null then
    raise exception 'inventory_item_id es obligatorio.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-item-controls:' || v_item_id::text, 0)
  );

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = v_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario no encontrado.' using errcode = 'P0002';
  end if;
  if v_item.merged_into_item_id is not null then
    raise exception 'Un alias histórico no puede modificarse.' using errcode = '22023';
  end if;

  v_name := btrim(coalesce(p_configuration ->> 'name', ''));
  v_availability_mode := nullif(lower(btrim(coalesce(p_configuration ->> 'availability_mode', ''))), '');
  v_low_stock_threshold := nullif(
    btrim(coalesce(p_configuration ->> 'low_stock_threshold', '')),
    ''
  )::numeric;
  v_low_stock_inclusive := coalesce(
    nullif(btrim(coalesce(p_configuration ->> 'low_stock_inclusive', '')), '')::boolean,
    true
  );
  v_target_stock_units := nullif(
    btrim(coalesce(p_configuration ->> 'target_stock_units', '')),
    ''
  )::numeric;
  v_shelf_life_days := nullif(
    btrim(coalesce(p_configuration ->> 'shelf_life_days', '')),
    ''
  )::integer;
  v_primary_count_frequency := nullif(
    lower(btrim(coalesce(p_configuration ->> 'primary_count_frequency', ''))),
    ''
  );
  v_primary_count_role := nullif(
    lower(btrim(coalesce(p_configuration ->> 'primary_count_role', ''))),
    ''
  );
  v_primary_count_location_code := nullif(
    lower(btrim(coalesce(p_configuration ->> 'primary_count_location_code', ''))),
    ''
  );
  v_notes := nullif(btrim(coalesce(p_configuration ->> 'notes', '')), '');

  if v_name = '' or char_length(v_name) > 160 then
    raise exception 'El nombre es obligatorio y admite hasta 160 caracteres.' using errcode = '22023';
  end if;
  if v_availability_mode is not null
    and v_availability_mode not in ('on_hand_only', 'immediate_recipe', 'scheduled_recipe')
  then
    raise exception 'El modo de disponibilidad no es válido.' using errcode = '22023';
  end if;
  if v_low_stock_threshold is not null and v_low_stock_threshold < 0 then
    raise exception 'La alerta mínima no puede ser negativa.' using errcode = '22023';
  end if;
  if v_target_stock_units is not null and v_target_stock_units < 0 then
    raise exception 'El stock objetivo no puede ser negativo.' using errcode = '22023';
  end if;
  if v_shelf_life_days is not null and v_shelf_life_days < 0 then
    raise exception 'La vida útil no puede ser negativa.' using errcode = '22023';
  end if;
  if v_primary_count_frequency is not null
    and v_primary_count_frequency not in ('per_shift', 'daily', 'weekly', 'biweekly', 'monthly')
  then
    raise exception 'La frecuencia de conteo no es válida.' using errcode = '22023';
  end if;
  if v_primary_count_role is not null
    and v_primary_count_role not in ('admin', 'master', 'kitchen', 'counter')
  then
    raise exception 'El rol de conteo no es válido.' using errcode = '22023';
  end if;
  if v_primary_count_location_code is not null
    and v_primary_count_location_code not in (
      'beverage_pepsi',
      'beverage_coca_cola',
      'beverage_reserve'
    )
  then
    raise exception 'La ruta física de conteo no es válida.' using errcode = '22023';
  end if;
  if v_item.inventory_group = 'beverages' and v_primary_count_location_code is null then
    raise exception 'Las bebidas deben tener una ruta física de conteo.' using errcode = '22023';
  end if;
  if v_item.inventory_group <> 'beverages' and v_primary_count_location_code is not null then
    raise exception 'La ruta de cava solo aplica a bebidas.' using errcode = '22023';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  update public.inventory_items
  set name = v_name,
      availability_mode = v_availability_mode,
      low_stock_threshold = v_low_stock_threshold,
      low_stock_inclusive = v_low_stock_inclusive,
      target_stock_units = v_target_stock_units,
      shelf_life_days = v_shelf_life_days,
      primary_count_frequency = v_primary_count_frequency,
      primary_count_role = v_primary_count_role::public.user_role,
      primary_count_location_code = v_primary_count_location_code,
      notes = v_notes
  where id = v_item_id;

  return jsonb_build_object(
    'status', 'updated',
    'inventory_item_id', v_item_id,
    'stock_changed', false,
    'structural_fields_changed', false
  );
end;
$$;

revoke all on function public.inventory_update_item_controls_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_update_item_controls_v1(jsonb)
  to authenticated, service_role;

create or replace function app_private.inventory_default_count_location_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.inventory_group = 'beverages' and new.primary_count_location_code is null then
    new.primary_count_location_code := case
      when lower(new.name) like 'pepsi%'
        or lower(new.name) like 'yukery%'
        or lower(new.name) like 'yukipack%'
        or lower(new.name) like 'lipton%'
        or lower(new.name) like 'malta%'
      then 'beverage_pepsi'
      when lower(new.name) like 'coca-cola%'
        or lower(new.name) like 'chinotto%'
        or lower(new.name) like 'fanta%'
        or lower(new.name) like 'frescolita%'
        or lower(new.name) like 'hit%'
        or lower(new.name) like 'jugo del valle%'
      then 'beverage_coca_cola'
      else 'beverage_reserve'
    end;
  elsif new.inventory_group <> 'beverages' then
    new.primary_count_location_code := null;
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_items_default_count_location_trg
  on public.inventory_items;
create trigger inventory_items_default_count_location_trg
before insert or update of inventory_group, primary_count_location_code
on public.inventory_items
for each row
execute function app_private.inventory_default_count_location_v1();

comment on column public.inventory_items.primary_count_location_code is
  'Primary physical counting route. Beverage routes include the exhibitor cooler plus its reserve units; stock remains consolidated per item.';
comment on function app_private.inventory_shift_count_selection_v1(date) is
  'Selects fixed per-shift items plus due or exceptional beverages, rotating one due long-cycle beverage route at a time.';
comment on function public.inventory_open_shift_count_v2(uuid, date, text) is
  'Opens or resumes a blind flexible guard-change count with fixed food sections and adaptive beverage selection.';
comment on function public.inventory_prepare_automatic_recount_v1(bigint) is
  'Opens one immediate blind recount containing only nonzero variances from a submitted Kitchen shift count.';
comment on function public.inventory_submit_shift_count_with_recount_v1(uuid, jsonb, text, bigint) is
  'Atomically submits a Kitchen shift count and opens its blind variance-only verification when needed.';
comment on function public.inventory_update_item_controls_v1(jsonb) is
  'Admin-only safe edit of item naming, availability, alerts, counting cadence and physical beverage route. It never changes stock or structural identity.';
comment on function app_private.inventory_default_count_location_v1() is
  'Defaults newly created beverages to the generic reserve route without changing their canonical stock balance.';
