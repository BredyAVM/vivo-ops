-- Inventory order issue reconciliation: transaction-only certification.
-- Run with a privileged SQL session. Every mutation is rolled back.

begin;

do $$
declare
  v_order_id bigint;
  v_order_item_id bigint;
  v_root_qty numeric;
  v_detail_limit numeric;
  v_snapshot_counted numeric;
begin
  select order_row.id, order_item.id, order_item.qty, product.detail_units_limit
  into v_order_id, v_order_item_id, v_root_qty, v_detail_limit
  from public.orders order_row
  join public.order_items order_item on order_item.order_id = order_row.id
  join public.products product on product.id = order_item.product_id
  where order_row.order_number = 'VO-20260814-1809'
    and product.name = 'Single Pack (10 und)'
  limit 1;

  if v_order_item_id is null then
    raise exception 'No se encontró el caso certificado de Single Pack.';
  end if;

  perform app_private.inventory_sync_order_item_components_v1(v_order_item_id);

  select coalesce(sum(snapshot.qty), 0)
  into v_snapshot_counted
  from public.order_item_components snapshot
  join public.product_components component
    on component.parent_product_id = (
      select order_item.product_id
      from public.order_items order_item
      where order_item.id = v_order_item_id
    )
   and component.component_product_id = snapshot.component_product_id
  where snapshot.order_item_id = v_order_item_id
    and component.counts_toward_detail_limit;

  if v_snapshot_counted <> v_root_qty * v_detail_limit then
    raise exception 'La composición repetida no totalizó correctamente: % <> %.',
      v_snapshot_counted,
      v_root_qty * v_detail_limit;
  end if;

  if jsonb_array_length(
    app_private.inventory_resolve_order_sale_v1(v_order_id) -> 'errors'
  ) > 0 then
    raise exception 'El resolver mantuvo errores después de reconstruir la composición.';
  end if;
end;
$$;

do $$
declare
  v_admin_user_id uuid;
  v_order_id bigint;
  v_before bigint;
  v_after bigint;
begin
  select role_row.user_id
  into v_admin_user_id
  from public.user_roles role_row
  where role_row.role = 'admin'::public.user_role
  order by role_row.user_id
  limit 1;

  select order_row.id
  into v_order_id
  from public.orders order_row
  where order_row.status in (
      'queued'::public.order_status,
      'confirmed'::public.order_status,
      'in_kitchen'::public.order_status,
      'ready'::public.order_status,
      'out_for_delivery'::public.order_status
    )
    and exists (
      select 1 from public.order_items order_item where order_item.order_id = order_row.id
    )
  order by order_row.id desc
  limit 1;

  if v_admin_user_id is null or v_order_id is null then
    raise exception 'No existe un administrador o una orden activa para la prueba.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin_user_id::text, true);

  select count(*)
  into v_before
  from public.order_timeline_events event
  where event.order_id = v_order_id
    and event.event_type = 'inventory_commitment_sync_failed'
    and event.payload ->> 'error' like '%order_without_items%';

  delete from public.order_items order_item where order_item.order_id = v_order_id;

  select count(*)
  into v_after
  from public.order_timeline_events event
  where event.order_id = v_order_id
    and event.event_type = 'inventory_commitment_sync_failed'
    and event.payload ->> 'error' like '%order_without_items%';

  if v_after <> v_before then
    raise exception 'Eliminar temporalmente las partidas volvió a generar order_without_items.';
  end if;

  if exists (
    select 1
    from public.inventory_planned_flows flow
    where flow.order_id = v_order_id
      and flow.flow_type = 'order_commitment'
      and flow.status in ('draft', 'active')
  ) then
    raise exception 'La orden vacía conservó compromisos activos.';
  end if;
end;
$$;

do $$
declare
  v_order_id bigint;
  v_first_event_id bigint;
  v_second_event_id bigint;
  v_open_recipients integer;
begin
  select order_row.id
  into v_order_id
  from public.orders order_row
  order by order_row.id desc
  limit 1;

  v_first_event_id := app_private.inventory_record_order_issue_v1(
    v_order_id,
    'inventory_commitment_sync_failed',
    'transaction_probe',
    'Prueba de deduplicación',
    'Esta incidencia solo existe dentro de una transacción revertida.',
    'warning',
    null,
    jsonb_build_object('error', 'rollback_dedup_probe')
  );
  v_second_event_id := app_private.inventory_record_order_issue_v1(
    v_order_id,
    'inventory_commitment_sync_failed',
    'transaction_probe',
    'Prueba de deduplicación',
    'Esta incidencia solo existe dentro de una transacción revertida.',
    'warning',
    null,
    jsonb_build_object('error', 'rollback_dedup_probe')
  );

  if v_first_event_id is null or v_second_event_id is distinct from v_first_event_id then
    raise exception 'La incidencia repetida no fue deduplicada.';
  end if;

  perform app_private.inventory_resolve_order_issue_v1(
    v_order_id,
    'inventory_commitment_sync_failed',
    'transaction_probe',
    null,
    'rollback_probe_resolved'
  );

  select count(*)
  into v_open_recipients
  from public.order_timeline_event_recipients recipient
  where recipient.event_id = v_first_event_id
    and recipient.requires_action
    and recipient.read_at is null;

  if v_open_recipients <> 0 then
    raise exception 'La incidencia reconciliada conservó destinatarios accionables.';
  end if;
end;
$$;

rollback;
