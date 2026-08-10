-- Inventory remains advisory throughout the order lifecycle. This migration
-- reuses the existing order timeline and inventory alert center; it adds no
-- tables or columns.

create or replace function app_private.inventory_record_order_issue_v1(
  p_order_id bigint,
  p_event_type text,
  p_stage text,
  p_title text,
  p_message text,
  p_severity text,
  p_actor_user_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id bigint;
  v_order_number text;
begin
  select order_row.order_number
  into v_order_number
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    return null;
  end if;

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  )
  values (
    p_order_id,
    v_order_number,
    coalesce(nullif(btrim(p_event_type), ''), 'inventory_sync_issue'),
    'inventory',
    coalesce(nullif(btrim(p_title), ''), 'Incidencia de inventario'),
    nullif(btrim(p_message), ''),
    case
      when p_severity in ('info', 'warning', 'critical') then p_severity
      else 'warning'
    end,
    p_actor_user_id,
    coalesce(p_payload, '{}'::jsonb)
      || jsonb_build_object(
        'source', 'inventory_engine',
        'stage', coalesce(nullif(btrim(p_stage), ''), 'unknown'),
        'non_blocking', true
      )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  values
    (v_event_id, 'master', null, true),
    (v_event_id, 'admin', null, true);

  return v_event_id;
exception when others then
  raise warning 'No se pudo registrar la incidencia de inventario para la orden %: [%] %',
    p_order_id, sqlstate, sqlerrm;
  return null;
end;
$$;

revoke all on function app_private.inventory_record_order_issue_v1(
  bigint, text, text, text, text, text, uuid, jsonb
) from public, anon, authenticated, service_role;

-- A composition snapshot is useful for inventory, but never authoritative
-- enough to reject the order-item write that caused it.
create or replace function app_private.inventory_order_item_snapshot_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sqlstate text;
  v_message text;
  v_detail text;
begin
  begin
    perform app_private.inventory_sync_order_item_components_v1(new.id);
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail;

    perform app_private.inventory_record_order_issue_v1(
      new.order_id,
      'inventory_snapshot_sync_failed',
      'order_item_snapshot',
      'Composición de inventario pendiente',
      'La partida se guardó sin bloqueo, pero su composición inventariable requiere revisión.',
      'warning',
      auth.uid(),
      jsonb_build_object(
        'sqlstate', v_sqlstate,
        'error', v_message,
        'detail', nullif(v_detail, ''),
        'order_item_id', new.id,
        'product_id', new.product_id,
        'trigger_operation', tg_op
      )
    );
  end;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_item_snapshot_trigger_v1()
  from public, anon, authenticated, service_role;

-- Commitment recalculation after an item change is advisory as well.
create or replace function app_private.inventory_order_item_commitment_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id bigint;
  v_order record;
  v_actor uuid;
  v_caller uuid := auth.uid();
  v_caller_can_refresh boolean := false;
  v_sqlstate text;
  v_message text;
  v_detail text;
begin
  v_order_id := case when tg_op = 'DELETE' then old.order_id else new.order_id end;

  begin
    select
      order_row.source::text as source,
      order_row.status::text as status,
      order_row.needs_reapproval,
      order_row.queued_needs_reapproval,
      order_row.last_modified_by,
      order_row.sent_to_kitchen_by,
      order_row.created_by_user_id
    into v_order
    from public.orders order_row
    where order_row.id = v_order_id;

    if found then
      v_caller_can_refresh := v_order.source = 'walk_in'
        or exists (
          select 1
          from public.user_roles role_row
          where role_row.user_id = v_caller
            and role_row.role in (
              'admin'::public.user_role,
              'master'::public.user_role
            )
        );

      if v_caller_can_refresh
        and v_order.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
        and not coalesce(v_order.needs_reapproval, false)
        and not coalesce(v_order.queued_needs_reapproval, false)
      then
        v_actor := app_private.inventory_resolve_commitment_actor_v1(
          v_order_id,
          coalesce(
            v_caller,
            v_order.last_modified_by,
            v_order.sent_to_kitchen_by,
            v_order.created_by_user_id
          )
        );
        perform app_private.inventory_materialize_order_commitment_v1(v_order_id, v_actor);
      end if;
    end if;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail;

    perform app_private.inventory_record_order_issue_v1(
      v_order_id,
      'inventory_commitment_sync_failed',
      'order_item_change',
      'Compromiso de inventario pendiente',
      'La partida cambió sin bloqueo, pero la proyección de inventario requiere revisión.',
      'warning',
      v_caller,
      jsonb_build_object(
        'sqlstate', v_sqlstate,
        'error', v_message,
        'detail', nullif(v_detail, ''),
        'order_item_id', case when tg_op = 'DELETE' then old.id else new.id end,
        'trigger_operation', tg_op
      )
    );
  end;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.inventory_order_item_commitment_trigger_v1()
  from public, anon, authenticated, service_role;

-- Approval, rescheduling, cancellation and delivery all survive an inventory
-- commitment failure. The failure is routed to the existing timeline.
create or replace function app_private.inventory_order_commitment_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_has_items boolean;
  v_has_open_commitment boolean;
  v_should_refresh boolean := false;
  v_sqlstate text;
  v_message text;
  v_detail text;
begin
  begin
    v_actor := app_private.inventory_resolve_commitment_actor_v1(
      new.id,
      coalesce(auth.uid(), new.last_modified_by, new.sent_to_kitchen_by, new.created_by_user_id)
    );

    if new.status = 'delivered'::public.order_status then
      perform app_private.inventory_close_order_commitments_v1(new.id, 'fulfilled', v_actor);
    elsif new.status in ('created'::public.order_status, 'cancelled'::public.order_status) then
      perform app_private.inventory_close_order_commitments_v1(new.id, 'cancelled', v_actor);
    elsif coalesce(new.needs_reapproval, false)
      or coalesce(new.queued_needs_reapproval, false)
    then
      perform app_private.inventory_close_order_commitments_v1(new.id, 'cancelled', v_actor);
    elsif new.status in (
      'queued'::public.order_status,
      'confirmed'::public.order_status,
      'in_kitchen'::public.order_status,
      'ready'::public.order_status,
      'out_for_delivery'::public.order_status
    ) then
      select exists (
        select 1
        from public.order_items order_item
        where order_item.order_id = new.id
      ) into v_has_items;

      if v_has_items then
        select exists (
          select 1
          from public.inventory_planned_flows flow
          where flow.order_id = new.id
            and flow.flow_type = 'order_commitment'
            and flow.status in ('draft', 'active')
        ) into v_has_open_commitment;

        if tg_op = 'INSERT' then
          v_should_refresh := not v_has_open_commitment;
        else
          v_should_refresh := (
            old.status is distinct from new.status
            and new.status = 'queued'::public.order_status
          ) or (
            coalesce(old.needs_reapproval, false)
            and not coalesce(new.needs_reapproval, false)
          ) or (
            coalesce(old.queued_needs_reapproval, false)
            and not coalesce(new.queued_needs_reapproval, false)
          ) or (
            old.extra_fields #> '{schedule}' is distinct from new.extra_fields #> '{schedule}'
          ) or not v_has_open_commitment;
        end if;

        if v_should_refresh then
          perform app_private.inventory_materialize_order_commitment_v1(new.id, v_actor);
        end if;
      end if;
    end if;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail;

    perform app_private.inventory_record_order_issue_v1(
      new.id,
      'inventory_commitment_sync_failed',
      'order_lifecycle',
      'Proyección de inventario pendiente',
      'La orden continuó sin bloqueo, pero su compromiso de inventario requiere revisión.',
      'warning',
      coalesce(auth.uid(), new.last_modified_by, new.sent_to_kitchen_by, new.created_by_user_id),
      jsonb_build_object(
        'sqlstate', v_sqlstate,
        'error', v_message,
        'detail', nullif(v_detail, ''),
        'order_status', new.status::text,
        'trigger_operation', tg_op
      )
    );
  end;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_commitment_trigger_v1()
  from public, anon, authenticated, service_role;

-- Automatic sale consumption stays real even when stock becomes negative.
-- Every other inventory error is captured and cannot roll delivery back.
create or replace function app_private.inventory_order_sale_cutover_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_operation_id uuid;
  v_sqlstate text;
  v_message text;
  v_detail text;
begin
  if old.status is distinct from new.status
    and new.status = 'delivered'
  then
    v_actor := coalesce(
      auth.uid(),
      new.last_modified_by,
      new.sent_to_kitchen_by,
      new.created_by_user_id
    );
    v_operation_id := pg_catalog.md5(
      'vivo.inventory.order.sale.v2:' || new.id::text
    )::uuid;

    begin
      if app_private.inventory_catalog_is_ready_v1() then
        perform public.inventory_commit_order_sale_v1(
          v_operation_id,
          new.id,
          format('Consumo automático al entregar la orden %s.', new.id)
        );
      end if;
    exception when others then
      get stacked diagnostics
        v_sqlstate = returned_sqlstate,
        v_message = message_text,
        v_detail = pg_exception_detail;

      perform app_private.inventory_record_order_issue_v1(
        new.id,
        'inventory_sale_sync_failed',
        'order_delivery',
        'Entrega sin conciliación de inventario',
        'La orden se entregó sin bloqueo, pero el consumo de inventario no pudo registrarse automáticamente.',
        'critical',
        v_actor,
        jsonb_build_object(
          'operation_id', v_operation_id,
          'sqlstate', v_sqlstate,
          'error', v_message,
          'detail', nullif(v_detail, '')
        )
      );
    end;
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_sale_cutover_trigger_v1()
  from public, anon, authenticated, service_role;

-- Negative physical stock is always a critical control incident, even when an
-- item has no procurement threshold, recipe or directly active product link.
create or replace function app_private.inventory_sync_negative_balance_alert_v1(
  p_inventory_item_id bigint,
  p_detected_at timestamptz default clock_timestamp()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_alert_key text := format('control:negative-balance:item:%s', p_inventory_item_id);
  v_alert_id bigint;
  v_policy_enabled boolean := false;
  v_is_operational boolean := false;
begin
  select
    item.id,
    item.name,
    item.unit_name,
    item.current_stock_units,
    item.tracking_mode,
    item.is_active,
    item.merged_into_item_id
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id;

  if not found then
    return null;
  end if;

  select exists (
    select 1
    from app_private.inventory_effective_alert_policy_v1('control', p_inventory_item_id) policy
    where policy.is_enabled
  ) into v_policy_enabled;

  v_is_operational := v_item.is_active
    and v_item.tracking_mode <> 'not_tracked'
    and v_item.merged_into_item_id is null
    and app_private.inventory_item_is_initialized_v1(v_item.id);

  if v_policy_enabled
    and v_is_operational
    and v_item.current_stock_units < 0
  then
    insert into public.inventory_alerts (
      alert_key,
      alert_category,
      alert_type,
      severity,
      requires_action,
      status,
      inventory_item_id,
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
      'negative_stock',
      'critical',
      true,
      'open',
      v_item.id,
      format('Existencia física negativa: %s', v_item.name),
      format(
        'El saldo canónico quedó en %s %s. La operación continuó sin bloqueo y requiere conciliación.',
        v_item.current_stock_units,
        v_item.unit_name
      ),
      jsonb_build_object(
        'detection_source', 'inventory_balance_guard',
        'current_stock_units', v_item.current_stock_units,
        'tracking_mode', v_item.tracking_mode,
        'non_blocking', true
      ),
      p_detected_at,
      p_detected_at,
      p_detected_at,
      p_detected_at
    )
    on conflict (alert_key) where status in ('open', 'managed')
    do update set
      alert_category = excluded.alert_category,
      alert_type = excluded.alert_type,
      severity = excluded.severity,
      requires_action = excluded.requires_action,
      inventory_item_id = excluded.inventory_item_id,
      title = excluded.title,
      message = excluded.message,
      details = excluded.details,
      last_detected_at = excluded.last_detected_at,
      updated_at = excluded.updated_at
    returning id into v_alert_id;
  else
    update public.inventory_alerts alert
    set status = 'resolved',
        resolved_by_user_id = null,
        resolved_at = p_detected_at,
        updated_at = p_detected_at,
        details = alert.details || jsonb_build_object(
          'resolution_source', 'inventory_balance_guard',
          'resolved_reason', case
            when not v_policy_enabled then 'policy_disabled'
            when not v_is_operational then 'item_not_operational'
            else 'balance_recovered'
          end,
          'resolved_balance_units', v_item.current_stock_units
        )
    where alert.alert_key = v_alert_key
      and alert.status in ('open', 'managed')
    returning alert.id into v_alert_id;
  end if;

  return v_alert_id;
end;
$$;

revoke all on function app_private.inventory_sync_negative_balance_alert_v1(
  bigint, timestamptz
) from public, anon, authenticated, service_role;

create or replace function app_private.inventory_negative_balance_alert_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform app_private.inventory_sync_negative_balance_alert_v1(
      new.id,
      clock_timestamp()
    );
  exception when others then
    raise warning 'No se pudo sincronizar la alerta de saldo negativo para el ítem %: [%] %',
      new.id, sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function app_private.inventory_negative_balance_alert_trigger_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists inventory_negative_balance_alert_v1 on public.inventory_items;
create trigger inventory_negative_balance_alert_v1
after update of current_stock_units on public.inventory_items
for each row
when (old.current_stock_units is distinct from new.current_stock_units)
execute function app_private.inventory_negative_balance_alert_trigger_v1();

-- Reconcile any negative operational balance that existed before the trigger.
do $$
declare
  v_item record;
begin
  for v_item in
    select item.id
    from public.inventory_items item
    where item.current_stock_units < 0
      and item.is_active
      and item.tracking_mode <> 'not_tracked'
      and item.merged_into_item_id is null
    order by item.id
  loop
    begin
      perform app_private.inventory_sync_negative_balance_alert_v1(
        v_item.id,
        clock_timestamp()
      );
    exception when others then
      raise warning 'No se pudo reconciliar la alerta negativa inicial del ítem %: [%] %',
        v_item.id, sqlstate, sqlerrm;
    end;
  end loop;
end;
$$;

comment on function app_private.inventory_record_order_issue_v1(
  bigint, text, text, text, text, text, uuid, jsonb
) is 'Records an advisory inventory failure in the existing order timeline for Master and administration.';
comment on function app_private.inventory_order_sale_cutover_trigger_v1() is
  'Never blocks order delivery: records canonical consumption when possible and an inventory incident otherwise.';
comment on function app_private.inventory_sync_negative_balance_alert_v1(bigint, timestamptz) is
  'Maintains a critical control alert for every operational inventory item whose canonical balance is negative.';
