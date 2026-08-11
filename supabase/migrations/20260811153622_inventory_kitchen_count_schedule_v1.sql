-- Phase 3 / Cocina: scheduled count reminders without a parallel schedule table.
-- Reuses inventory_items.primary_count_frequency, inventory_counts and the
-- canonical inventory alert center. Alerts never block orders or late counts.

set lock_timeout = '5s';
set statement_timeout = '120s';

create function app_private.inventory_set_shift_count_due_at_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.count_kind = 'shift_change'
    and new.shift_business_date is not null
    and new.due_at is null
  then
    new.due_at := (new.shift_business_date + 1)::timestamp
      at time zone 'America/Caracas';
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_set_shift_count_due_at_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists inventory_counts_set_shift_due_at_v1
  on public.inventory_counts;

create trigger inventory_counts_set_shift_due_at_v1
before insert or update of count_kind, shift_business_date, due_at
on public.inventory_counts
for each row
execute function app_private.inventory_set_shift_count_due_at_v1();

update public.inventory_counts count_header
set due_at = (count_header.shift_business_date + 1)::timestamp
  at time zone 'America/Caracas'
where count_header.count_kind = 'shift_change'
  and count_header.shift_business_date is not null
  and count_header.due_at is null
  and count_header.status in ('open', 'recount_requested');

alter function app_private.inventory_refresh_alerts_core_v1()
  rename to inventory_refresh_alerts_base_v1;

create function app_private.inventory_refresh_count_schedule_alerts_v1()
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
  v_shift_code text;
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

  -- The two shift identities already exist. A missing shift is detected only
  -- after its complete operating day has ended in Caracas.
  v_business_date := v_today - 1;
  if v_business_date >= date '2026-08-11' then
    foreach v_shift_code in array array['shift_1'::text, 'shift_2'::text]
    loop
      if not exists (
        select 1
        from public.inventory_counts count_header
        where count_header.count_kind = 'shift_change'
          and count_header.shift_business_date = v_business_date
          and count_header.shift_code = v_shift_code
          and count_header.status in (
            'open', 'submitted', 'accepted', 'recount_requested', 'expired'
          )
      ) then
        v_alert_key := format(
          'control:count-schedule-missed:kitchen:%s:%s',
          v_business_date,
          v_shift_code
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
            'count_schedule_missed',
            'warning',
            true,
            'open',
            format(
              'Inventario de %s no realizado',
              case v_shift_code when 'shift_1' then 'Turno 1' else 'Turno 2' end
            ),
            format(
              'Cocina no registró el inventario del %s. Esto no bloquea órdenes.',
              to_char(v_business_date, 'DD/MM/YYYY')
            ),
            jsonb_build_object(
              'detection_source', 'inventory_schedule',
              'responsible_role', 'kitchen',
              'count_frequency', 'per_shift',
              'shift_business_date', v_business_date,
              'shift_code', v_shift_code
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
          set last_detected_at = v_started_at,
              updated_at = v_started_at
          where id = v_alert_id;
        end if;

        if v_alert_id is not null then
          v_detected := v_detected + 1;
        end if;
      end if;
    end loop;
  end if;

  -- Periodic reminders derive directly from each item's configured frequency.
  -- No schedule row or duplicated source of truth is introduced.
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
      md5(coalesce(string_agg(
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

revoke all on function app_private.inventory_refresh_count_schedule_alerts_v1()
  from public, anon, authenticated, service_role;

create function app_private.inventory_refresh_alerts_core_v1()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_base jsonb;
  v_schedule jsonb;
begin
  v_base := app_private.inventory_refresh_alerts_base_v1();
  v_schedule := app_private.inventory_refresh_count_schedule_alerts_v1();

  return v_base || jsonb_build_object(
    'scheduled_detected_or_updated',
      coalesce((v_schedule ->> 'detected_or_updated')::integer, 0),
    'scheduled_automatically_resolved',
      coalesce((v_schedule ->> 'automatically_resolved')::integer, 0)
  );
end;
$$;

revoke all on function app_private.inventory_refresh_alerts_base_v1()
  from public, anon, authenticated, service_role;
revoke all on function app_private.inventory_refresh_alerts_core_v1()
  from public, anon, authenticated, service_role;

comment on function app_private.inventory_refresh_count_schedule_alerts_v1() is
  'Detects missed Kitchen shifts and overdue configured periodic counts without blocking operations.';
comment on function app_private.inventory_refresh_alerts_core_v1() is
  'Refreshes canonical inventory alerts plus count schedule reminders.';
