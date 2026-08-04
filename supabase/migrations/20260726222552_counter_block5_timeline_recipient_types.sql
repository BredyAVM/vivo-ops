begin;
create or replace function public.counter_update_pickup_schedule(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_schedule_date date,
  p_schedule_time time without time zone,
  p_reason text,
  p_send_to_kitchen boolean default false
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
  v_result jsonb;
  v_extra_fields jsonb;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Only Counter or Master/Admin can update a pickup schedule';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  if p_schedule_date is null or p_schedule_time is null then
    raise exception 'A pickup date and time are required';
  end if;

  if char_length(btrim(coalesce(p_reason, ''))) < 4 then
    raise exception 'A clear schedule correction reason is required';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'schedule_date', p_schedule_date,
    'schedule_time', to_char(p_schedule_time, 'HH24:MI'),
    'reason', btrim(p_reason),
    'send_to_kitchen', coalesce(p_send_to_kitchen, false)
  );

  select claim.receipt_id, claim.existing_result
  into v_receipt_id, v_existing_result
  from public.counter_claim_command(
    p_idempotency_key,
    'update_pickup_schedule',
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
    raise exception 'Counter cannot change the schedule of a delivery order';
  end if;

  if v_order.status not in ('created', 'queued', 'confirmed', 'in_kitchen') then
    raise exception 'A pickup schedule can only be changed before the order is ready';
  end if;

  if coalesce(p_send_to_kitchen, false)
     and v_order.status not in ('created', 'queued') then
    raise exception 'This pickup is already in the kitchen flow';
  end if;

  v_extra_fields := jsonb_set(
    coalesce(v_order.extra_fields, '{}'::jsonb),
    '{schedule}',
    jsonb_build_object(
      'asap', false,
      'date', to_char(p_schedule_date, 'YYYY-MM-DD'),
      'time_24', to_char(p_schedule_time, 'HH24:MI'),
      'time_12', to_char(p_schedule_time, 'FMHH12:MI AM')
    ),
    true
  );
  v_extra_fields := jsonb_set(
    v_extra_fields,
    '{counter}',
    coalesce(v_extra_fields -> 'counter', '{}'::jsonb)
      || jsonb_build_object(
        'last_schedule_correction_at', v_now,
        'last_schedule_correction_by', v_uid,
        'last_schedule_correction_reason', btrim(p_reason)
      ),
    true
  );

  update public.orders
  set
    extra_fields = v_extra_fields,
    status = case
      when coalesce(p_send_to_kitchen, false)
        then 'confirmed'::public.order_status
      else status
    end,
    sent_to_kitchen_at = case
      when coalesce(p_send_to_kitchen, false) then v_now
      else sent_to_kitchen_at
    end,
    sent_to_kitchen_by = case
      when coalesce(p_send_to_kitchen, false) then v_uid
      else sent_to_kitchen_by
    end,
    needs_reapproval = case
      when coalesce(p_send_to_kitchen, false) then false
      else needs_reapproval
    end,
    queued_needs_reapproval = case
      when coalesce(p_send_to_kitchen, false) then false
      else queued_needs_reapproval
    end,
    last_modified_at = v_now,
    last_modified_by = v_uid
  where id = p_order_id;

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
    case
      when coalesce(p_send_to_kitchen, false)
        then 'counter_pickup_sent_to_kitchen'
      else 'counter_pickup_schedule_corrected'
    end,
    'kitchen',
    case
      when coalesce(p_send_to_kitchen, false)
        then 'Mostrador corrigio el pickup y lo envio a cocina'
      else 'Mostrador corrigio la fecha del pickup'
    end,
    btrim(p_reason),
    'warning',
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'schedule_date', p_schedule_date,
      'schedule_time', to_char(p_schedule_time, 'HH24:MI'),
      'sent_to_kitchen', coalesce(p_send_to_kitchen, false)
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
    case
      when coalesce(p_send_to_kitchen, false)
        then 'sent_to_kitchen'
      else 'pickup_schedule_corrected'
    end,
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'reason', btrim(p_reason),
      'schedule_date', p_schedule_date,
      'schedule_time', to_char(p_schedule_time, 'HH24:MI')
    )
  );

  v_result := jsonb_build_object(
    'status',
      case
        when coalesce(p_send_to_kitchen, false) then 'sent_to_kitchen'
        else 'schedule_updated'
      end,
    'orderId', p_order_id,
    'scheduleDate', to_char(p_schedule_date, 'YYYY-MM-DD'),
    'scheduleTime', to_char(p_schedule_time, 'HH24:MI'),
    'sentToKitchen', coalesce(p_send_to_kitchen, false)
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_update_pickup_schedule(
  uuid,
  bigint,
  date,
  time without time zone,
  text,
  boolean
) from public, anon;
grant execute on function public.counter_update_pickup_schedule(
  uuid,
  bigint,
  date,
  time without time zone,
  text,
  boolean
) to authenticated, service_role;

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
  v_change_request_id bigint;
  v_event_id bigint;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_signature text;
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
    raise exception 'This pickup already has a change awaiting Master approval';
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

  if (v_order.status = 'ready' or v_order.is_price_locked)
     and char_length(v_reason) < 4 then
    raise exception 'A clear reason is required to request this protected pickup change';
  end if;

  if v_order.status = 'ready' or v_order.is_price_locked then
    v_signature := public.counter_pickup_order_signature(p_order_id);

    insert into public.counter_pickup_change_requests (
      order_id,
      requested_by_user_id,
      reason,
      request_payload,
      base_signature
    ) values (
      p_order_id,
      v_uid,
      v_reason,
      v_plan,
      v_signature
    )
    returning id into v_change_request_id;

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
      'counter_pickup_change_requested',
      'approval',
      'Cambio de pickup protegido requiere autorizacion',
      v_reason,
      'warning',
      v_uid,
      jsonb_build_object(
        'source', 'counter',
        'request_id', v_change_request_id,
        'total_usd', v_plan #> '{pricing,total_usd}',
        'had_reduction', v_plan -> 'hadReduction',
        'has_additions', v_plan -> 'hasAdditions',
        'needs_kitchen', v_plan -> 'needsKitchen'
      )
    )
    returning id into v_event_id;

    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    )
    select v_event_id, 'master', null::uuid, true
    union all
    select v_event_id, 'advisor', v_order.attributed_advisor_id, false
    where v_order.attributed_advisor_id is not null;

    v_result := jsonb_build_object(
      'status', 'pending_approval',
      'orderId', p_order_id,
      'requestId', v_change_request_id,
      'returnedToKitchen', false,
      'totalUsd', (v_plan #>> '{pricing,total_usd}')::numeric,
      'totalBs', (v_plan #>> '{pricing,total_bs}')::numeric
    );

    return public.counter_complete_command(v_receipt_id, v_result);
  end if;

  v_apply_result := public.counter_apply_pickup_item_plan(
    p_order_id,
    v_plan,
    v_uid,
    coalesce(nullif(v_reason, ''), 'Cambio solicitado por cliente en mostrador'),
    false
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
      when v_order.status in ('confirmed', 'in_kitchen') then 'kitchen'
      else 'order'
    end,
    'Mostrador modifico un pickup activo',
    nullif(v_reason, ''),
    case
      when v_order.status in ('confirmed', 'in_kitchen') then 'warning'
      else 'info'
    end,
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'total_usd', v_apply_result -> 'totalUsd',
      'had_reduction', v_plan -> 'hadReduction',
      'has_additions', v_plan -> 'hasAdditions'
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
  where v_order.status in ('confirmed', 'in_kitchen')
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
      'total_usd', v_apply_result -> 'totalUsd'
    )
  );

  v_result := jsonb_build_object(
    'status', 'applied',
    'orderId', p_order_id,
    'requestId', null,
    'returnedToKitchen', false,
    'totalUsd', v_apply_result -> 'totalUsd',
    'totalBs', v_apply_result -> 'totalBs'
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

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

create or replace function public.counter_decide_pickup_change(
  p_idempotency_key uuid,
  p_request_id bigint,
  p_decision text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_request public.counter_pickup_change_requests%rowtype;
  v_order public.orders%rowtype;
  v_receipt_id bigint;
  v_existing_result jsonb;
  v_request_payload jsonb;
  v_result jsonb;
  v_apply_result jsonb;
  v_event_id bigint;
  v_current_signature text;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_return_to_kitchen boolean;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_master_or_admin() then
    raise exception 'Only Master/Admin can decide a ready pickup change';
  end if;

  if p_request_id is null or p_request_id <= 0 then
    raise exception 'A valid request_id is required';
  end if;

  p_decision := lower(btrim(coalesce(p_decision, '')));
  if p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject';
  end if;

  select *
  into v_request
  from public.counter_pickup_change_requests request
  where request.id = p_request_id
  for update;

  if not found then
    raise exception 'Pickup change request % not found', p_request_id;
  end if;

  v_request_payload := jsonb_build_object(
    'request_id', p_request_id,
    'decision', p_decision,
    'notes', v_notes
  );

  select claim.receipt_id, claim.existing_result
  into v_receipt_id, v_existing_result
  from public.counter_claim_command(
    p_idempotency_key,
    'decide_pickup_change',
    v_request.order_id,
    null,
    v_request_payload
  ) claim;

  if v_existing_result is not null then
    return v_existing_result;
  end if;

  if v_request.status <> 'pending' then
    raise exception 'This pickup change request is no longer pending';
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = v_request.order_id
  for update;

  if not found then
    raise exception 'Order % not found', v_request.order_id;
  end if;

  if p_decision = 'reject' then
    v_result := jsonb_build_object(
      'status', 'rejected',
      'requestId', p_request_id,
      'orderId', v_request.order_id,
      'returnedToKitchen', false
    );

    update public.counter_pickup_change_requests
    set
      status = 'rejected',
      reviewed_by_user_id = v_uid,
      reviewed_at = v_now,
      review_notes = v_notes,
      result_payload = v_result
    where id = p_request_id;

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
      v_request.order_id,
      v_order.order_number,
      'counter_pickup_change_rejected',
      'approval',
      'Master rechazo el cambio del pickup',
      coalesce(v_notes, v_request.reason),
      'warning',
      v_uid,
      jsonb_build_object('request_id', p_request_id)
    )
    returning id into v_event_id;

    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    )
    select v_event_id, 'counter', null::uuid, false
    union all
    select v_event_id, 'advisor', v_order.attributed_advisor_id, false
    where v_order.attributed_advisor_id is not null;

    return public.counter_complete_command(v_receipt_id, v_result);
  end if;

  v_current_signature := public.counter_pickup_order_signature(v_request.order_id);
  if v_current_signature is distinct from v_request.base_signature then
    v_result := jsonb_build_object(
      'status', 'stale',
      'requestId', p_request_id,
      'orderId', v_request.order_id,
      'returnedToKitchen', false
    );

    update public.counter_pickup_change_requests
    set
      status = 'stale',
      reviewed_by_user_id = v_uid,
      reviewed_at = v_now,
      review_notes = coalesce(v_notes, 'La orden cambio despues de la solicitud.'),
      result_payload = v_result
    where id = p_request_id;

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
      v_request.order_id,
      v_order.order_number,
      'counter_pickup_change_stale',
      'approval',
      'La solicitud de cambio ya no coincide con el pickup',
      'La orden cambio despues de que Counter solicito la autorizacion.',
      'warning',
      v_uid,
      jsonb_build_object('request_id', p_request_id)
    );

    return public.counter_complete_command(v_receipt_id, v_result);
  end if;

  v_return_to_kitchen :=
    v_order.status = 'ready'
    and coalesce(
      (v_request.request_payload ->> 'needsKitchen')::boolean,
      false
    );
  v_apply_result := public.counter_apply_pickup_item_plan(
    v_request.order_id,
    v_request.request_payload,
    v_uid,
    v_request.reason,
    v_return_to_kitchen
  );
  v_result := jsonb_build_object(
    'status', 'approved',
    'requestId', p_request_id,
    'orderId', v_request.order_id,
    'returnedToKitchen', v_return_to_kitchen,
    'totalUsd', v_apply_result -> 'totalUsd',
    'totalBs', v_apply_result -> 'totalBs'
  );

  update public.counter_pickup_change_requests
  set
    status = 'approved',
    reviewed_by_user_id = v_uid,
    reviewed_at = v_now,
    review_notes = v_notes,
    applied_at = v_now,
    result_payload = v_result
  where id = p_request_id;

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
    v_request.order_id,
    v_order.order_number,
    'counter_pickup_change_approved',
    case when v_return_to_kitchen then 'kitchen' else 'approval' end,
    case
      when v_return_to_kitchen
        then 'Master aprobo el cambio y el pickup regreso a cocina'
      else 'Master aprobo el cambio del pickup listo'
    end,
    coalesce(v_notes, v_request.reason),
    case when v_return_to_kitchen then 'warning' else 'info' end,
    v_uid,
    jsonb_build_object(
      'request_id', p_request_id,
      'returned_to_kitchen', v_return_to_kitchen,
      'total_usd', v_apply_result -> 'totalUsd'
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  select v_event_id, 'counter', null::uuid, false
  union all
  select v_event_id, 'kitchen', null::uuid, false
  where v_return_to_kitchen
  union all
  select v_event_id, 'advisor', v_order.attributed_advisor_id, false
  where v_order.attributed_advisor_id is not null;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    v_request.order_id,
    'counter_pickup_change_approved',
    v_uid,
    jsonb_build_object(
      'request_id', p_request_id,
      'returned_to_kitchen', v_return_to_kitchen
    )
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_decide_pickup_change(
  uuid,
  bigint,
  text,
  text
) from public, anon;
grant execute on function public.counter_decide_pickup_change(
  uuid,
  bigint,
  text,
  text
) to authenticated, service_role;

create or replace function public.counter_complete_pickup(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_state record;
  v_active_rate numeric;
  v_payment_method text;
  v_has_advisor boolean;
  v_receipt_id bigint;
  v_existing_result jsonb;
  v_request_payload jsonb;
  v_result jsonb;
  v_extra_fields jsonb;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Only Counter or Master/Admin can complete a pickup';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'notes', nullif(btrim(coalesce(p_notes, '')), '')
  );

  select claim.receipt_id, claim.existing_result
  into v_receipt_id, v_existing_result
  from public.counter_claim_command(
    p_idempotency_key,
    'complete_pickup',
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
    raise exception 'This command only completes pickup orders';
  end if;

  if v_order.status <> 'ready' then
    raise exception 'A pickup can only be delivered from ready';
  end if;

  if exists (
    select 1
    from public.counter_pickup_change_requests request
    where request.order_id = p_order_id
      and request.status = 'pending'
  ) then
    raise exception 'Resolve the pending pickup change before delivery';
  end if;

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  select *
  into v_state
  from public.get_order_financial_state(
    p_order_id,
    null,
    v_active_rate
  );

  v_payment_method := coalesce(
    nullif(v_order.extra_fields #>> '{payment,method}', ''),
    'pending'
  );
  v_has_advisor := v_order.attributed_advisor_id is not null;

  if v_payment_method in ('pos', 'cash_usd', 'cash_ves')
     and coalesce(v_state.pending_usd, v_order.total_usd) > 0.005 then
    raise exception 'Counter must collect the expected cash or POS balance before pickup';
  end if;

  if not v_has_advisor
     and (
       coalesce(v_state.pending_usd, v_order.total_usd) > 0.005
       or coalesce(v_state.pending_reports_count, 0) > 0
     ) then
    raise exception 'Master must confirm payment before delivering a pickup without advisor';
  end if;

  v_extra_fields := jsonb_set(
    coalesce(v_order.extra_fields, '{}'::jsonb),
    '{pickup}',
    coalesce(v_order.extra_fields -> 'pickup', '{}'::jsonb)
      || jsonb_build_object(
        'collected_at', v_now,
        'collected_by_user_id', v_uid,
        'notes', nullif(btrim(coalesce(p_notes, '')), '')
      ),
    true
  );

  update public.orders
  set
    status = 'delivered',
    extra_fields = v_extra_fields,
    last_modified_at = v_now,
    last_modified_by = v_uid
  where id = p_order_id;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'delivered',
    v_uid,
    jsonb_build_object(
      'fulfillment', 'pickup',
      'delivered_by_role', 'counter',
      'payment_status', v_state.payment_status,
      'pending_usd', v_state.pending_usd,
      'pending_reports_count', v_state.pending_reports_count
    )
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
    'counter_pickup_delivered',
    'delivery',
    'Pickup entregado en mostrador',
    nullif(btrim(coalesce(p_notes, '')), ''),
    'info',
    v_uid,
    jsonb_build_object(
      'source', 'counter',
      'payment_status', v_state.payment_status,
      'pending_usd', v_state.pending_usd,
      'pending_reports_count', v_state.pending_reports_count,
      'advisor_responsible_for_collection',
        v_has_advisor
        and (
          coalesce(v_state.pending_usd, 0) > 0.005
          or coalesce(v_state.pending_reports_count, 0) > 0
        )
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  select v_event_id, 'master', null::uuid, false
  union all
  select
    v_event_id,
    'advisor',
    v_order.attributed_advisor_id,
    coalesce(v_state.pending_usd, 0) > 0.005
      or coalesce(v_state.pending_reports_count, 0) > 0
  where v_order.attributed_advisor_id is not null;

  v_result := jsonb_build_object(
    'status', 'delivered',
    'orderId', p_order_id,
    'deliveredAt', v_now,
    'paymentStatus', v_state.payment_status,
    'pendingUsd', v_state.pending_usd,
    'pendingReportsCount', v_state.pending_reports_count,
    'advisorResponsibleForCollection',
      v_has_advisor
      and (
        coalesce(v_state.pending_usd, 0) > 0.005
        or coalesce(v_state.pending_reports_count, 0) > 0
      )
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_complete_pickup(
  uuid,
  bigint,
  text
) from public, anon;
grant execute on function public.counter_complete_pickup(
  uuid,
  bigint,
  text
) to authenticated, service_role;

commit;
