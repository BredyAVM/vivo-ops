-- Fase 3 / Cocina: prueba reversible de turnos y ciclos periódicos.
-- Valida identidad única, vencimiento, alerta y cierre sin bloquear órdenes.

begin;

do $$
declare
  v_kitchen_user_id uuid;
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_business_date date;
  v_shift_code text;
  v_first_open jsonb;
  v_replayed_open jsonb;
  v_shift_count_id bigint;
  v_item_id bigint;
  v_item_stock numeric;
  v_periodic_result jsonb;
  v_periodic_count_id bigint;
  v_alert_id bigint;
  v_alert_status text;
begin
  select role_row.user_id
  into v_kitchen_user_id
  from public.user_roles role_row
  where role_row.role = 'kitchen'::public.user_role
  order by role_row.user_id
  limit 1;

  select candidate.business_date, candidate.shift_code
  into v_business_date, v_shift_code
  from (
    select v_today as business_date, code as shift_code
    from unnest(array['shift_1'::text, 'shift_2'::text]) code
    union all
    select v_today - 1, code
    from unnest(array['shift_1'::text, 'shift_2'::text]) code
  ) candidate
  where not exists (
    select 1
    from public.inventory_counts count_header
    where count_header.count_kind = 'shift_change'
      and count_header.shift_business_date = candidate.business_date
      and count_header.shift_code = candidate.shift_code
      and count_header.status in ('open', 'submitted', 'accepted', 'recount_requested')
  )
  order by candidate.business_date desc, candidate.shift_code
  limit 1;

  select item.id, item.current_stock_units
  into v_item_id, v_item_stock
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
    and item.primary_count_role = 'kitchen'
    and item.primary_count_frequency = 'per_shift'
    and app_private.inventory_item_is_initialized_v1(item.id)
  order by item.id
  limit 1;

  if v_kitchen_user_id is null or v_business_date is null or v_item_id is null then
    raise exception 'La prueba requiere Cocina, un turno disponible y un ítem inicializado.';
  end if;

  perform set_config('request.jwt.claim.sub', v_kitchen_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_first_open := public.inventory_open_shift_count_v1(
    v_business_date,
    v_shift_code,
    'phase_3_schedule_test'
  );
  v_replayed_open := public.inventory_open_shift_count_v1(
    v_business_date,
    v_shift_code,
    'phase_3_schedule_test'
  );
  v_shift_count_id := (v_first_open ->> 'inventory_count_id')::bigint;

  if v_shift_count_id is distinct from (v_replayed_open ->> 'inventory_count_id')::bigint then
    raise exception 'La apertura del mismo turno no fue idempotente.';
  end if;

  if not exists (
    select 1
    from public.inventory_counts count_header
    where count_header.id = v_shift_count_id
      and count_header.due_at = (v_business_date + 1)::timestamp at time zone 'America/Caracas'
  ) then
    raise exception 'El turno no recibió el vencimiento de Caracas esperado.';
  end if;

  -- Reutiliza temporalmente un ítem ya abierto para simular un programa semanal.
  update public.inventory_items
  set primary_count_frequency = 'weekly'
  where id = v_item_id;

  update public.inventory_count_lines count_line
  set counted_at = clock_timestamp() - interval '8 days'
  from public.inventory_counts count_header
  where count_line.inventory_count_id = count_header.id
    and count_line.inventory_item_id = v_item_id
    and count_header.status in ('submitted', 'accepted', 'recount_requested')
    and count_line.counted_at is not null;

  perform app_private.inventory_refresh_count_schedule_alerts_v1();

  select alert.id
  into v_alert_id
  from public.inventory_alerts alert
  where alert.status in ('open', 'managed')
    and alert.alert_type = 'periodic_count_overdue'
    and alert.details ->> 'count_frequency' = 'weekly'
    and alert.details -> 'inventory_item_ids' @> jsonb_build_array(v_item_id)
  order by alert.id desc
  limit 1;

  if v_alert_id is null then
    raise exception 'No se generó la alerta semanal vencida.';
  end if;

  v_periodic_result := public.inventory_submit_count_v1(
    '33000000-0000-4000-8000-000000000001'::uuid,
    'periodic',
    jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_item_id,
      'counted_quantity_units', v_item_stock,
      'note', 'phase_3_schedule_test'
    )),
    'phase_3_schedule_test',
    null,
    null
  );
  v_periodic_count_id := (v_periodic_result ->> 'inventory_count_id')::bigint;

  if not exists (
    select 1
    from public.inventory_counts count_header
    where count_header.id = v_periodic_count_id
      and count_header.count_kind = 'periodic'
      and count_header.status = 'submitted'
      and count_header.responsible_role = 'kitchen'::public.user_role
  ) then
    raise exception 'El conteo periódico no quedó presentado por Cocina.';
  end if;

  perform app_private.inventory_refresh_count_schedule_alerts_v1();
  select alert.status into v_alert_status
  from public.inventory_alerts alert
  where alert.id = v_alert_id;

  if v_alert_status is distinct from 'resolved' then
    raise exception 'La alerta no se resolvió al completar el conteo.';
  end if;
end;
$$;

rollback;

-- Verificación posterior esperada:
-- 1) cero conteos con notes = 'phase_3_schedule_test';
-- 2) cero alertas con details.detection_source = 'inventory_schedule' creadas por la prueba;
-- 3) frecuencia y saldo del ítem restaurados;
-- 4) ninguna orden o evento de orden modificado.
