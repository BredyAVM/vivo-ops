create or replace function public.counter_change_pickup_items(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_existing_items jsonb,
  p_added_items jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_receipt_id bigint;
  v_existing_result jsonb;
  v_request_payload jsonb;
  v_plan jsonb;
  v_apply_result jsonb;
  v_result jsonb;
  v_event_id bigint;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_return_to_kitchen boolean := false;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Only Counter or Master/Admin can change pickup items';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  p_existing_items := coalesce(p_existing_items, '[]'::jsonb);
  p_added_items := coalesce(p_added_items, '[]'::jsonb);

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'existing_items', p_existing_items,
    'added_items', p_added_items,
    'reason', nullif(v_reason, '')
  );

  select claim.receipt_id, claim.existing_result
  into v_receipt_id, v_existing_result
  from public.counter_claim_command(
    p_idempotency_key,
    'change_pickup_items',
    p_order_id,
    null,
    v_request_payload
  ) claim;

  if v_existing_result is not null then
    return v_existing_result;
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_order.fulfillment <> 'pickup' then
    raise exception 'Counter cannot modify delivery order items';
  end if;

  if v_order.status not in ('created', 'queued', 'confirmed', 'in_kitchen', 'ready') then
    raise exception 'This pickup can no longer be modified from Counter';
  end if;

  if exists (
    select 1
    from public.counter_pickup_change_requests request
    where request.order_id = p_order_id
      and request.status = 'pending'
  ) then
    raise exception 'This pickup has a legacy change request awaiting Master resolution';
  end if;

  v_plan := public.counter_build_pickup_item_plan(
    p_order_id,
    p_existing_items,
    p_added_items
  );

  if coalesce((v_plan ->> 'hadReduction')::boolean, false)
     and char_length(v_reason) < 4 then
    raise exception 'A clear reason is required to reduce or remove products';
  end if;

  v_return_to_kitchen :=
    v_order.status = 'ready'
    and coalesce((v_plan ->> 'needsKitchen')::boolean, false);

  v_apply_result := public.counter_apply_pickup_item_plan(
    p_order_id,
    v_plan,
    v_uid,
    coalesce(nullif(v_reason, ''), 'Cambio solicitado por cliente en mostrador'),
    v_return_to_kitchen
  );

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
  ) values (
    p_order_id,
    v_order.order_number,
    'counter_pickup_items_changed',
    case
      when v_order.status in ('confirmed', 'in_kitchen', 'ready') then 'kitchen'
      else 'order'
    end,
    case
      when v_return_to_kitchen
        then 'Mostrador modifico un pickup listo y lo devolvio a cocina'
      when v_order.status = 'ready'
        then 'Mostrador modifico un pickup listo'
      else 'Mostrador modifico un pickup activo'
    end,
    nullif(v_reason, ''),
    case
      when v_order.status in ('confirmed', 'in_kitchen', 'ready') then 'warning'
      else 'info'
    end,
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'total_usd', v_apply_result -> 'totalUsd',
      'had_reduction', v_plan -> 'hadReduction',
      'has_additions', v_plan -> 'hasAdditions',
      'returned_to_kitchen', v_return_to_kitchen
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  select v_event_id, 'kitchen', null::uuid, false
  where v_order.status in ('confirmed', 'in_kitchen', 'ready')
  union all
  select v_event_id, 'advisor', v_order.attributed_advisor_id, false
  where v_order.attributed_advisor_id is not null;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'counter_pickup_items_changed',
    v_uid,
    jsonb_build_object(
      'reason', nullif(v_reason, ''),
      'total_usd', v_apply_result -> 'totalUsd',
      'returned_to_kitchen', v_return_to_kitchen
    )
  );

  v_result := jsonb_build_object(
    'status', 'applied',
    'orderId', p_order_id,
    'requestId', null,
    'returnedToKitchen', v_return_to_kitchen,
    'totalUsd', v_apply_result -> 'totalUsd',
    'totalBs', v_apply_result -> 'totalBs'
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

comment on function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) is
'Modifica directamente pickups activos desde Counter. Reducciones exigen motivo; delivery se rechaza; un pickup listo con aumentos vuelve a cocina.';

revoke all on function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) from public, anon;

grant execute on function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) to authenticated, service_role;
