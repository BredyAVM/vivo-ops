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

  if exists (
    select 1
    from public.order_change_obligations obligation
    where obligation.order_id = p_order_id
      and obligation.status = 'pending'
  ) then
    raise exception 'Complete the pending customer change before pickup delivery';
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
