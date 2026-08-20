-- Reconcile advisory inventory incidents raised by normal order edits and
-- configurable-product quantities. This migration adds no tables or columns.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function app_private.inventory_resolve_order_issue_v1(
  p_order_id bigint,
  p_event_type text,
  p_stage text default null,
  p_order_item_id bigint default null,
  p_resolution_reason text default 'inventory_reconciled'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  if p_order_id is null or nullif(btrim(p_event_type), '') is null then
    return 0;
  end if;

  with candidates as (
    select event.id
    from public.order_timeline_events event
    where event.order_id = p_order_id
      and event.event_group = 'inventory'
      and event.event_type = p_event_type
      and (p_stage is null or event.payload ->> 'stage' = p_stage)
      and (
        p_order_item_id is null
        or nullif(event.payload ->> 'order_item_id', '')::bigint = p_order_item_id
      )
      and exists (
        select 1
        from public.order_timeline_event_recipients recipient
        where recipient.event_id = event.id
          and recipient.requires_action
          and recipient.read_at is null
      )
  ),
  resolved_events as (
    update public.order_timeline_events event
    set payload = event.payload || jsonb_build_object(
      'inventory_issue_status', 'resolved',
      'inventory_issue_resolved_at', clock_timestamp(),
      'inventory_issue_resolution_reason', coalesce(
        nullif(btrim(p_resolution_reason), ''),
        'inventory_reconciled'
      )
    )
    where event.id in (select candidate.id from candidates candidate)
    returning event.id
  )
  update public.order_timeline_event_recipients recipient
  set
    requires_action = false,
    read_at = coalesce(recipient.read_at, clock_timestamp())
  where recipient.event_id in (
    select resolved_event.id from resolved_events resolved_event
  )
    and (recipient.requires_action or recipient.read_at is null);

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function app_private.inventory_resolve_order_issue_v1(
  bigint, text, text, bigint, text
) from public, anon, authenticated, service_role;

comment on function app_private.inventory_resolve_order_issue_v1(
  bigint, text, text, bigint, text
) is 'Closes advisory inventory timeline recipients after the underlying order issue has been reconciled.';

-- Keep one actionable notification per unresolved issue signature. Repeated
-- lifecycle updates must not flood Master and administration with duplicates.
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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  select order_row.order_number
  into v_order_number
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    return null;
  end if;

  select event.id
  into v_event_id
  from public.order_timeline_events event
  where event.order_id = p_order_id
    and event.event_group = 'inventory'
    and event.event_type = coalesce(
      nullif(btrim(p_event_type), ''),
      'inventory_sync_issue'
    )
    and event.payload ->> 'stage' = coalesce(
      nullif(btrim(p_stage), ''),
      'unknown'
    )
    and (event.payload ->> 'error') is not distinct from (v_payload ->> 'error')
    and (event.payload ->> 'order_item_id') is not distinct from (v_payload ->> 'order_item_id')
    and exists (
      select 1
      from public.order_timeline_event_recipients recipient
      where recipient.event_id = event.id
        and recipient.requires_action
        and recipient.read_at is null
    )
  order by event.created_at desc, event.id desc
  limit 1;

  if found then
    update public.order_timeline_events event
    set payload = event.payload || jsonb_build_object(
      'last_detected_at', clock_timestamp(),
      'last_trigger_operation', v_payload ->> 'trigger_operation'
    )
    where event.id = v_event_id;
    return v_event_id;
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
    v_payload || jsonb_build_object(
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

-- Structured @sel markers describe one configurable presentation. The order
-- item quantity repeats that same composition. Snapshots remain total physical
-- quantities so the existing recursive resolver and every downstream consumer
-- continue to share one canonical representation.
create or replace function app_private.inventory_sync_order_item_components_v1(
  p_order_item_id bigint
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_item record;
  v_markers jsonb := '{}'::jsonb;
  v_counted_quantity numeric := 0;
  v_inserted integer := 0;
begin
  select
    order_item.id,
    order_item.order_id,
    order_item.product_id,
    order_item.qty,
    order_item.notes,
    product.name as product_name,
    product.detail_units_limit,
    product.is_detail_editable
  into v_order_item
  from public.order_items order_item
  join public.products product on product.id = order_item.product_id
  where order_item.id = p_order_item_id;

  if not found then
    raise exception 'order_item % no existe.', p_order_item_id using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.regexp_split_to_table(
      coalesce(v_order_item.notes, ''),
      E'\\r?\\n'
    ) split_line(line)
    where btrim(split_line.line) like '@sel|%'
      and btrim(split_line.line) !~ E'^@sel\\|[1-9][0-9]*\\|[0-9]+(\\.[0-9]+)?$'
  ) then
    raise exception 'El pedido contiene una selección estructurada inválida.'
      using errcode = '22023';
  end if;

  select coalesce(
    jsonb_object_agg(marker.component_product_id::text, marker.quantity),
    '{}'::jsonb
  )
  into v_markers
  from (
    select
      pg_catalog.split_part(btrim(split_line.line), '|', 2)::bigint as component_product_id,
      sum(pg_catalog.split_part(btrim(split_line.line), '|', 3)::numeric) as quantity
    from pg_catalog.regexp_split_to_table(
      coalesce(v_order_item.notes, ''),
      E'\\r?\\n'
    ) split_line(line)
    where btrim(split_line.line) ~ E'^@sel\\|[1-9][0-9]*\\|[0-9]+(\\.[0-9]+)?$'
    group by pg_catalog.split_part(btrim(split_line.line), '|', 2)::bigint
  ) marker;

  if exists (
    select 1
    from jsonb_each_text(v_markers) marker(component_product_id, quantity)
    where marker.quantity::numeric <= 0
       or not exists (
         select 1
         from public.product_components component
         where component.parent_product_id = v_order_item.product_id
           and component.component_product_id = marker.component_product_id::bigint
       )
  ) then
    raise exception 'La selección contiene un componente no permitido o una cantidad inválida.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.product_components component
    join jsonb_each_text(v_markers) marker(component_product_id, quantity)
      on marker.component_product_id::bigint = component.component_product_id
    where component.parent_product_id = v_order_item.product_id
      and component.component_mode = 'fixed'::public.product_component_mode
      and component.is_required
      and marker.quantity::numeric <> component.quantity
  ) then
    raise exception 'La selección por presentación no coincide con uno o más componentes fijos.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.product_components component
    join jsonb_each_text(v_markers) marker(component_product_id, quantity)
      on marker.component_product_id::bigint = component.component_product_id
    where component.parent_product_id = v_order_item.product_id
      and component.component_mode = 'fixed'::public.product_component_mode
      and not component.is_required
      and marker.quantity::numeric > component.quantity
  ) then
    raise exception 'La selección supera la cantidad permitida por presentación de un componente opcional.'
      using errcode = '22023';
  end if;

  select coalesce(sum(
    case
      when component.component_mode = 'fixed'::public.product_component_mode
        and component.is_required
      then component.quantity
      when v_markers ? component.component_product_id::text
      then (v_markers ->> component.component_product_id::text)::numeric
      else 0
    end
  ) filter (where component.counts_toward_detail_limit), 0)
  into v_counted_quantity
  from public.product_components component
  where component.parent_product_id = v_order_item.product_id;

  if v_order_item.is_detail_editable
    and v_order_item.detail_units_limit > 0
    and v_counted_quantity <> v_order_item.detail_units_limit
  then
    raise exception '% exige % unidades seleccionadas por presentación y recibió %.',
      v_order_item.product_name,
      v_order_item.detail_units_limit,
      v_counted_quantity
      using errcode = '22023';
  end if;

  if v_order_item.is_detail_editable
    and v_order_item.detail_units_limit = 0
    and exists (
      select 1
      from public.product_components component
      where component.parent_product_id = v_order_item.product_id
        and component.component_mode = 'selectable'::public.product_component_mode
    )
    and v_counted_quantity <= 0
  then
    raise exception '% necesita al menos una unidad seleccionada.', v_order_item.product_name
      using errcode = '22023';
  end if;

  delete from public.order_item_components snapshot
  where snapshot.order_item_id = p_order_item_id;

  insert into public.order_item_components (
    order_item_id,
    component_product_id,
    qty,
    component_name_snapshot
  )
  select
    v_order_item.id,
    component.component_product_id,
    case
      when component.component_mode = 'fixed'::public.product_component_mode
        and component.is_required
      then v_order_item.qty * component.quantity
      else v_order_item.qty
        * (v_markers ->> component.component_product_id::text)::numeric
    end,
    component_product.name
  from public.product_components component
  join public.products component_product on component_product.id = component.component_product_id
  where component.parent_product_id = v_order_item.product_id
    and (
      (
        component.component_mode = 'fixed'::public.product_component_mode
        and component.is_required
      )
      or v_markers ? component.component_product_id::text
    )
  order by component.sort_order, component.id;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function app_private.inventory_sync_order_item_components_v1(bigint)
  from public, anon, authenticated, service_role;

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
    perform app_private.inventory_resolve_order_issue_v1(
      new.order_id,
      'inventory_snapshot_sync_failed',
      'order_item_snapshot',
      new.id,
      'component_snapshot_rebuilt'
    );
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
  v_has_items boolean := false;
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
      if v_order.status in ('created', 'cancelled', 'delivered') then
        perform app_private.inventory_resolve_order_issue_v1(
          v_order_id,
          'inventory_commitment_sync_failed',
          null,
          null,
          'order_no_longer_requires_commitment'
        );
      elsif v_order.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
        and not coalesce(v_order.needs_reapproval, false)
        and not coalesce(v_order.queued_needs_reapproval, false)
      then
        select exists (
          select 1
          from public.order_items order_item
          where order_item.order_id = v_order_id
        ) into v_has_items;

        v_actor := app_private.inventory_resolve_commitment_actor_v1(
          v_order_id,
          coalesce(
            v_caller,
            v_order.last_modified_by,
            v_order.sent_to_kitchen_by,
            v_order.created_by_user_id
          )
        );

        if not v_has_items then
          perform app_private.inventory_close_order_commitments_v1(
            v_order_id,
            'cancelled',
            v_actor
          );
          perform app_private.inventory_resolve_order_issue_v1(
            v_order_id,
            'inventory_commitment_sync_failed',
            null,
            null,
            'order_temporarily_without_items'
          );
        else
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

          if v_caller_can_refresh then
            perform app_private.inventory_materialize_order_commitment_v1(
              v_order_id,
              v_actor
            );
            perform app_private.inventory_resolve_order_issue_v1(
              v_order_id,
              'inventory_commitment_sync_failed',
              null,
              null,
              'order_commitment_rebuilt'
            );
          end if;
        end if;
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
      perform app_private.inventory_resolve_order_issue_v1(
        new.id,
        'inventory_commitment_sync_failed',
        null,
        null,
        'order_delivered'
      );
    elsif new.status in ('created'::public.order_status, 'cancelled'::public.order_status) then
      perform app_private.inventory_close_order_commitments_v1(new.id, 'cancelled', v_actor);
      perform app_private.inventory_resolve_order_issue_v1(
        new.id,
        'inventory_commitment_sync_failed',
        null,
        null,
        'order_not_committed'
      );
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

      if not v_has_items then
        perform app_private.inventory_close_order_commitments_v1(new.id, 'cancelled', v_actor);
        perform app_private.inventory_resolve_order_issue_v1(
          new.id,
          'inventory_commitment_sync_failed',
          null,
          null,
          'order_temporarily_without_items'
        );
      else
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
          perform app_private.inventory_resolve_order_issue_v1(
            new.id,
            'inventory_commitment_sync_failed',
            null,
            null,
            'order_commitment_rebuilt'
          );
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
        perform app_private.inventory_resolve_order_issue_v1(
          new.id,
          'inventory_sale_sync_failed',
          null,
          null,
          'order_sale_applied'
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

-- Rebuild every still-addressable composition that currently has an actionable
-- snapshot incident. Deleted order items are obsolete by definition.
do $$
declare
  v_issue record;
begin
  for v_issue in
    select distinct
      event.order_id,
      nullif(event.payload ->> 'order_item_id', '')::bigint as order_item_id
    from public.order_timeline_events event
    where event.event_group = 'inventory'
      and event.event_type = 'inventory_snapshot_sync_failed'
      and exists (
        select 1
        from public.order_timeline_event_recipients recipient
        where recipient.event_id = event.id
          and recipient.requires_action
          and recipient.read_at is null
      )
    order by event.order_id
  loop
    begin
      if v_issue.order_item_id is null or not exists (
        select 1
        from public.order_items order_item
        where order_item.id = v_issue.order_item_id
          and order_item.order_id = v_issue.order_id
      ) then
        perform app_private.inventory_resolve_order_issue_v1(
          v_issue.order_id,
          'inventory_snapshot_sync_failed',
          'order_item_snapshot',
          v_issue.order_item_id,
          'order_item_no_longer_exists'
        );
      else
        perform app_private.inventory_sync_order_item_components_v1(v_issue.order_item_id);
        perform app_private.inventory_resolve_order_issue_v1(
          v_issue.order_id,
          'inventory_snapshot_sync_failed',
          'order_item_snapshot',
          v_issue.order_item_id,
          'component_snapshot_rebuilt'
        );
      end if;
    exception when others then
      raise notice 'La composición de la orden % partida % sigue pendiente: [%] %',
        v_issue.order_id, v_issue.order_item_id, sqlstate, sqlerrm;
    end;
  end loop;
end;
$$;

-- Replay only delivered orders that have a sale incident and no sale movement.
-- Existing movement operations are authoritative and are never duplicated.
do $$
declare
  v_order record;
  v_order_item record;
  v_line record;
  v_resolution jsonb;
  v_operation_id uuid;
  v_item_ids bigint[];
  v_actor uuid;
begin
  for v_order in
    select distinct
      order_row.id,
      coalesce(
        order_row.last_modified_by,
        order_row.sent_to_kitchen_by,
        order_row.created_by_user_id,
        (
          select role_row.user_id
          from public.user_roles role_row
          where role_row.role = 'admin'::public.user_role
          order by role_row.user_id
          limit 1
        )
      ) as actor_user_id
    from public.orders order_row
    join public.order_timeline_events event on event.order_id = order_row.id
    where order_row.status = 'delivered'::public.order_status
      and event.event_group = 'inventory'
      and event.event_type = 'inventory_sale_sync_failed'
      and exists (
        select 1
        from public.order_timeline_event_recipients recipient
        where recipient.event_id = event.id
          and recipient.requires_action
          and recipient.read_at is null
      )
      and not exists (
        select 1
        from public.inventory_movements movement
        where movement.order_id = order_row.id
          and movement.movement_type = 'sale_out'
      )
    order by order_row.id
  loop
    begin
      if v_order.actor_user_id is null then
        raise exception 'No existe un actor trazable para la orden %.', v_order.id;
      end if;

      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('inventory_order_sale:' || v_order.id::text, 0)
      );
      perform 1 from public.orders order_row where order_row.id = v_order.id for update;

      if exists (
        select 1
        from public.inventory_movements movement
        where movement.order_id = v_order.id
          and movement.movement_type = 'sale_out'
      ) then
        continue;
      end if;

      for v_order_item in
        select order_item.id
        from public.order_items order_item
        where order_item.order_id = v_order.id
        order by order_item.id
      loop
        perform app_private.inventory_sync_order_item_components_v1(v_order_item.id);
      end loop;

      v_resolution := app_private.inventory_resolve_order_sale_v1(v_order.id);
      select array_agg(
        (line.value ->> 'inventory_item_id')::bigint
        order by (line.value ->> 'inventory_item_id')::bigint
      )
      into v_item_ids
      from jsonb_array_elements(v_resolution -> 'lines') line(value);

      if coalesce(cardinality(v_item_ids), 0) > 0 then
        perform 1
        from public.inventory_items inventory_item
        where inventory_item.id = any(v_item_ids)
        order by inventory_item.id
        for update;

        if exists (
          select 1
          from public.inventory_items inventory_item
          where inventory_item.id = any(v_item_ids)
            and (
              not inventory_item.is_active
              or inventory_item.tracking_mode = 'not_tracked'
              or inventory_item.merged_into_item_id is not null
              or not app_private.inventory_item_is_initialized_v1(inventory_item.id)
            )
        ) then
          raise exception 'La orden % contiene un ítem de inventario no operativo.', v_order.id;
        end if;

        v_operation_id := pg_catalog.md5(
          'vivo.inventory.order.sale.v2:' || v_order.id::text
        )::uuid;
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(v_operation_id::text, 0)
        );

        for v_line in
          select
            (line.value ->> 'inventory_item_id')::bigint as inventory_item_id,
            (line.value ->> 'quantity_units')::numeric as quantity_units
          from jsonb_array_elements(v_resolution -> 'lines') line(value)
          order by (line.value ->> 'inventory_item_id')::bigint
        loop
          perform app_private.inventory_apply_delta_v1(
            v_operation_id,
            v_line.inventory_item_id,
            'sale_out',
            -v_line.quantity_units,
            'order_delivery',
            format('Conciliación canónica de la orden entregada %s.', v_order.id),
            v_order.id,
            null,
            v_order.actor_user_id,
            null
          );
        end loop;
      end if;

      perform app_private.inventory_resolve_order_issue_v1(
        v_order.id,
        'inventory_sale_sync_failed',
        null,
        null,
        case
          when coalesce(cardinality(v_item_ids), 0) = 0 then 'order_has_no_inventory_effect'
          else 'order_sale_reconciled'
        end
      );
      perform app_private.inventory_resolve_order_issue_v1(
        v_order.id,
        'inventory_commitment_sync_failed',
        null,
        null,
        'delivered_order_sale_reconciled'
      );
    exception when others then
      raise notice 'La venta de la orden % sigue pendiente: [%] %',
        v_order.id, sqlstate, sqlerrm;
    end;
  end loop;
end;
$$;

-- Historic sale incidents that already have canonical movements and all
-- commitment incidents on terminal orders are no longer actionable.
do $$
declare
  v_order record;
begin
  for v_order in
    select distinct order_row.id, order_row.status::text as status
    from public.orders order_row
    join public.order_timeline_events event on event.order_id = order_row.id
    where event.event_group = 'inventory'
      and event.event_type in (
        'inventory_commitment_sync_failed',
        'inventory_sale_sync_failed'
      )
      and exists (
        select 1
        from public.order_timeline_event_recipients recipient
        where recipient.event_id = event.id
          and recipient.requires_action
          and recipient.read_at is null
      )
    order by order_row.id
  loop
    if v_order.status in ('created', 'cancelled', 'delivered') then
      perform app_private.inventory_resolve_order_issue_v1(
        v_order.id,
        'inventory_commitment_sync_failed',
        null,
        null,
        'terminal_order_has_no_open_commitment'
      );
    end if;

    if exists (
      select 1
      from public.inventory_movements movement
      where movement.order_id = v_order.id
        and movement.movement_type = 'sale_out'
    ) then
      perform app_private.inventory_resolve_order_issue_v1(
        v_order.id,
        'inventory_sale_sync_failed',
        null,
        null,
        'canonical_sale_movement_exists'
      );
    end if;
  end loop;
end;
$$;

comment on function app_private.inventory_sync_order_item_components_v1(bigint) is
  'Stores total physical component quantities while interpreting structured selections as one configurable presentation.';
comment on function app_private.inventory_record_order_issue_v1(
  bigint, text, text, text, text, text, uuid, jsonb
) is 'Records one non-blocking actionable event per unresolved inventory issue signature.';
comment on function app_private.inventory_order_item_commitment_trigger_v1() is
  'Keeps order-item edits non-blocking and treats a temporary empty order as a valid zero commitment.';
