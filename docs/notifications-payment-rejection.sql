-- Ejecutar una sola vez en Supabase SQL Editor.
-- Conserva el flujo existente: payment_reports -> order_events -> notifications.
-- No escribe en order_timeline_events ni crea tablas, tipos o triggers.

create or replace function public.reject_payment_report(
  p_report_id bigint,
  p_review_notes text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid;
  v_status payment_report_status;
  v_order_id bigint;
  v_advisor uuid;
  v_order_number text;
  v_reason text;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can reject payment reports';
  end if;

  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_reason := nullif(trim(p_review_notes), '');
  if v_reason is null then
    raise exception 'review_notes is required to reject a report';
  end if;

  select
    pr.status,
    pr.order_id,
    o.attributed_advisor_id,
    o.order_number
  into
    v_status,
    v_order_id,
    v_advisor,
    v_order_number
  from public.payment_reports pr
  join public.orders o on o.id = pr.order_id
  where pr.id = p_report_id
  for update of pr;

  if not found then
    raise exception 'Payment report not found';
  end if;

  if v_status <> 'pending' then
    raise exception 'Only pending reports can be rejected (current status: %)', v_status;
  end if;

  update public.payment_reports
  set
    status = 'rejected',
    reviewed_at = now(),
    reviewed_by_user_id = v_uid,
    review_notes = v_reason,
    confirmed_movement_id = null
  where id = p_report_id;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    v_order_id,
    'payment_rejected',
    v_uid,
    jsonb_build_object(
      'payment_report_id', p_report_id,
      'reason', v_reason,
      'review_notes', v_reason,
      'order_number', v_order_number
    )
  );

  perform public.create_notification(
    v_advisor,
    v_order_id,
    'master_info',
    'Pago rechazado: corrección requerida',
    'El pago de la orden ' || coalesce(v_order_number, '#' || v_order_id::text) ||
      ' fue rechazado. Motivo: ' || v_reason,
    jsonb_build_object(
      'kind', 'payment_rejected',
      'payment_report_id', p_report_id,
      'reason', v_reason,
      'review_notes', v_reason,
      'order_id', v_order_id
    )
  );
end;
$function$;
