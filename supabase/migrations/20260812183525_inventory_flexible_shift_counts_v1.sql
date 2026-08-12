-- Flexible Kitchen guard-change counts.
-- Reuses inventory_counts.request_operation_id for idempotency and keeps
-- shift_code only as historical metadata. No schedule or balance table is added.

set lock_timeout = '5s';
set statement_timeout = '120s';

alter table public.inventory_counts
  drop constraint inventory_counts_shift_identity_check;

alter table public.inventory_counts
  add constraint inventory_counts_shift_identity_check
  check (
    (
      count_kind = 'shift_change'
      and shift_business_date is not null
      and (shift_code is null or shift_code in ('shift_1', 'shift_2'))
    )
    or (
      count_kind <> 'shift_change'
      and shift_business_date is null
      and shift_code is null
    )
  ) not valid;

alter table public.inventory_counts
  validate constraint inventory_counts_shift_identity_check;

drop index if exists public.inventory_counts_active_shift_identity_key;

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
    pg_catalog.hashtextextended(
      'inventory-guard-change:' || p_business_date::text,
      0
    )
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

  -- A guard change must finish its open count before another one starts. Once
  -- submitted, any number of later guard changes may be opened on the same day.
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
    raise exception 'No hay ítems operativos configurados para el conteo por turno.';
  end if;

  if v_item_count > 200 then
    raise exception 'El programa de conteo por turno supera el máximo de 200 ítems.';
  end if;

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
    'shift_business_date', p_business_date
  );
end;
$$;

-- Compatibility for any client that still sends the old Turno 1/Turno 2
-- payload during deployment. Both labels now open the same unnumbered workflow.
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
begin
  if p_shift_code not in ('shift_1', 'shift_2') then
    raise exception 'Identidad histórica de turno inválida.' using errcode = '22023';
  end if;

  return public.inventory_open_shift_count_v2(
    pg_catalog.md5(
      coalesce(auth.uid()::text, '') || ':' || p_business_date::text || ':' || p_shift_code
    )::uuid,
    p_business_date,
    p_notes
  );
end;
$$;

revoke all on function public.inventory_open_shift_count_v2(uuid, date, text)
  from public, anon;
grant execute on function public.inventory_open_shift_count_v2(uuid, date, text)
  to authenticated, service_role;

revoke all on function public.inventory_open_shift_count_v1(date, text, text)
  from public, anon;
grant execute on function public.inventory_open_shift_count_v1(date, text, text)
  to authenticated, service_role;

create or replace function app_private.inventory_refresh_count_schedule_alerts_v1()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_today date := (v_started_at at time zone 'America/Caracas')::date;
  v_business_date date;
  v_frequency text;
  v_interval interval;
  v_item_count integer;
  v_item_ids jsonb;
  v_item_names jsonb;
  v_signature text;
  v_alert_key text;
  v_alert_id bigint;
  v_detected integer := 0;
  v_resolved integer := 0;
begin
  if not exists (
    select 1
    from app_private.inventory_effective_alert_policy_v1('control', null) policy
    where policy.is_enabled
  ) then
    return jsonb_build_object(
      'detected_or_updated', 0,
      'automatically_resolved', 0,
      'refreshed_at', v_started_at
    );
  end if;

  -- Guard changes are operational facts, not a fixed list of numbered shifts.
  -- The control center only warns when a complete day had no shift count at all.
  v_business_date := v_today - 1;
  if v_business_date >= date '2026-08-11'
    and not exists (
      select 1
      from public.inventory_counts count_header
      where count_header.count_kind = 'shift_change'
        and count_header.shift_business_date = v_business_date
        and count_header.status in (
          'open', 'submitted', 'accepted', 'recount_requested', 'expired'
        )
    )
  then
    v_alert_key := format(
      'control:count-schedule-missed:kitchen:%s',
      v_business_date
    );

    select alert.id
    into v_alert_id
    from public.inventory_alerts alert
    where alert.alert_key = v_alert_key
      and alert.status in ('open', 'managed')
    order by alert.id desc
    limit 1;

    if not found then
      insert into public.inventory_alerts (
        alert_key,
        alert_category,
        alert_type,
        severity,
        requires_action,
        status,
        title,
        message,
        details,
        first_detected_at,
        last_detected_at,
        created_at,
        updated_at
      )
      values (
        v_alert_key,
        'control',
        'count_schedule_missed',
        'warning',
        true,
        'open',
        'Conteo por turno no realizado',
        format(
          'Cocina no registró ningún conteo por turno el %s. Esto no bloquea órdenes.',
          to_char(v_business_date, 'DD/MM/YYYY')
        ),
        jsonb_build_object(
          'detection_source', 'inventory_schedule',
          'schedule_mode', 'flexible_guard_changes',
          'responsible_role', 'kitchen',
          'count_frequency', 'per_shift',
          'shift_business_date', v_business_date,
          'minimum_daily_counts', 1
        ),
        v_started_at,
        v_started_at,
        v_started_at,
        v_started_at
      )
      returning id into v_alert_id;
    else
      update public.inventory_alerts
      set message = format(
            'Cocina no registró ningún conteo por turno el %s. Esto no bloquea órdenes.',
            to_char(v_business_date, 'DD/MM/YYYY')
          ),
          details = jsonb_build_object(
            'detection_source', 'inventory_schedule',
            'schedule_mode', 'flexible_guard_changes',
            'responsible_role', 'kitchen',
            'count_frequency', 'per_shift',
            'shift_business_date', v_business_date,
            'minimum_daily_counts', 1
          ),
          last_detected_at = v_started_at,
          updated_at = v_started_at
      where id = v_alert_id;
    end if;

    if v_alert_id is not null then
      v_detected := v_detected + 1;
    end if;
  end if;

  -- Periodic reminders continue deriving from each item's configured frequency.
  foreach v_frequency in array array['daily'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text]
  loop
    v_interval := case v_frequency
      when 'daily' then interval '1 day'
      when 'weekly' then interval '7 days'
      when 'biweekly' then interval '14 days'
      else interval '1 month'
    end;

    with last_counts as (
      select
        item.id,
        item.name,
        max(line.counted_at) filter (
          where count_header.status in ('submitted', 'accepted', 'recount_requested')
        ) as last_counted_at
      from public.inventory_items item
      left join public.inventory_count_lines line
        on line.inventory_item_id = item.id
       and line.counted_at is not null
      left join public.inventory_counts count_header
        on count_header.id = line.inventory_count_id
      where item.is_active
        and item.merged_into_item_id is null
        and item.tracking_mode in ('transactional', 'periodic_count')
        and item.primary_count_role = 'kitchen'
        and item.primary_count_frequency = v_frequency
        and app_private.inventory_item_is_initialized_v1(item.id)
      group by item.id, item.name
    ), overdue as (
      select *
      from last_counts
      where last_counted_at is null
         or last_counted_at + v_interval < v_started_at
    )
    select
      count(*),
      coalesce(jsonb_agg(id order by id), '[]'::jsonb),
      coalesce(jsonb_agg(name order by name), '[]'::jsonb),
      pg_catalog.md5(coalesce(string_agg(
        id::text || ':' || coalesce(last_counted_at::text, 'never'),
        ',' order by id
      ), ''))
    into v_item_count, v_item_ids, v_item_names, v_signature
    from overdue;

    if v_item_count > 0 then
      v_alert_key := format(
        'control:periodic-count-overdue:kitchen:%s:%s',
        v_frequency,
        v_signature
      );

      select alert.id
      into v_alert_id
      from public.inventory_alerts alert
      where alert.alert_key = v_alert_key
      order by alert.id desc
      limit 1;

      if not found then
        insert into public.inventory_alerts (
          alert_key,
          alert_category,
          alert_type,
          severity,
          requires_action,
          status,
          title,
          message,
          details,
          first_detected_at,
          last_detected_at,
          created_at,
          updated_at
        )
        values (
          v_alert_key,
          'control',
          'periodic_count_overdue',
          'warning',
          true,
          'open',
          case v_frequency
            when 'daily' then 'Inventario diario pendiente'
            when 'weekly' then 'Inventario semanal pendiente'
            when 'biweekly' then 'Inventario quincenal pendiente'
            else 'Inventario mensual pendiente'
          end,
          format(
            '%s ítems requieren conteo de Cocina. Esto no bloquea órdenes.',
            v_item_count
          ),
          jsonb_build_object(
            'detection_source', 'inventory_schedule',
            'responsible_role', 'kitchen',
            'count_frequency', v_frequency,
            'inventory_item_ids', v_item_ids,
            'inventory_item_names', v_item_names,
            'overdue_item_count', v_item_count
          ),
          v_started_at,
          v_started_at,
          v_started_at,
          v_started_at
        )
        returning id into v_alert_id;
      elsif exists (
        select 1
        from public.inventory_alerts alert
        where alert.id = v_alert_id
          and alert.status in ('open', 'managed')
      ) then
        update public.inventory_alerts
        set message = format(
              '%s ítems requieren conteo de Cocina. Esto no bloquea órdenes.',
              v_item_count
            ),
            details = jsonb_build_object(
              'detection_source', 'inventory_schedule',
              'responsible_role', 'kitchen',
              'count_frequency', v_frequency,
              'inventory_item_ids', v_item_ids,
              'inventory_item_names', v_item_names,
              'overdue_item_count', v_item_count
            ),
            last_detected_at = v_started_at,
            updated_at = v_started_at
        where id = v_alert_id;
      end if;

      if v_alert_id is not null then
        v_detected := v_detected + 1;
      end if;
    end if;
  end loop;

  update public.inventory_alerts alert
  set status = 'resolved',
      resolved_at = v_started_at,
      updated_at = v_started_at,
      details = alert.details || jsonb_build_object(
        'resolution_source', 'automatic',
        'resolved_reason', 'schedule_condition_cleared'
      )
  where alert.status in ('open', 'managed')
    and alert.details ->> 'detection_source' = 'inventory_schedule'
    and alert.last_detected_at < v_started_at;
  get diagnostics v_resolved = row_count;

  return jsonb_build_object(
    'detected_or_updated', v_detected,
    'automatically_resolved', v_resolved,
    'refreshed_at', v_started_at
  );
end;
$$;

-- Any previous Turno 1/Turno 2 missing alert is obsolete under the flexible rule.
update public.inventory_alerts alert
set status = 'resolved',
    resolved_at = coalesce(alert.resolved_at, now()),
    updated_at = now(),
    details = alert.details || jsonb_build_object(
      'resolution_source', 'schedule_migration',
      'resolved_reason', 'numbered_shift_schedule_retired'
    )
where alert.alert_type = 'count_schedule_missed'
  and alert.status in ('open', 'managed')
  and alert.details ? 'shift_code';

comment on column public.inventory_counts.shift_code is
  'Historical Turno 1/Turno 2 identity. New flexible guard-change counts leave it null.';
comment on function public.inventory_open_shift_count_v2(uuid, date, text) is
  'Opens or resumes an idempotent blind guard-change count; multiple completed counts may exist per operating day.';
comment on function public.inventory_open_shift_count_v1(date, text, text) is
  'Compatibility wrapper for clients deployed before flexible unnumbered guard-change counts.';
comment on function app_private.inventory_refresh_count_schedule_alerts_v1() is
  'Warns only when a full operating day has no guard-change count, plus configured overdue periodic counts.';
