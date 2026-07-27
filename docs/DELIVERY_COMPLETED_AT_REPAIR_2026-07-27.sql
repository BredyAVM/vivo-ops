-- Repair canonical delivery completion timestamp handling.
-- Counter keeps dispatch/custody/liquidation only. Master/Admin owns final delivery.

create or replace function public.mark_delivered(p_order_id bigint)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  v_fulfillment public.fulfillment_type;
  v_status public.order_status;
  v_completed_at timestamptz := now();
begin
  if not public.is_master_or_admin() then
    raise exception 'Only Master/Admin can use the legacy delivery completion command';
  end if;

  select order_row.fulfillment, order_row.status
  into v_fulfillment, v_status
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment = 'delivery' and v_status <> 'out_for_delivery' then
    raise exception 'Delivery order % can only be completed from out_for_delivery', p_order_id;
  elsif v_fulfillment = 'pickup' and v_status <> 'ready' then
    raise exception 'Pickup order % can only be completed from ready', p_order_id;
  elsif v_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Unsupported fulfillment type for order %', p_order_id;
  end if;

  update public.orders
  set
    status = 'delivered',
    extra_fields = coalesce(extra_fields, '{}'::jsonb)
      || jsonb_build_object(
        'delivery',
        coalesce(
          case
            when jsonb_typeof(coalesce(extra_fields, '{}'::jsonb) -> 'delivery') = 'object'
              then coalesce(extra_fields, '{}'::jsonb) -> 'delivery'
            else '{}'::jsonb
          end,
          '{}'::jsonb
        ) || jsonb_build_object('completed_at', v_completed_at)
      )
  where id = p_order_id;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'delivered',
    (select auth.uid()),
    jsonb_build_object(
      'fulfillment', v_fulfillment,
      'delivered_by_role', 'master_or_admin',
      'completed_at', v_completed_at
    )
  );
end;
$function$;

with delivered_events as (
  select
    order_id,
    min(created_at) as completed_at
  from public.order_events
  where event = 'delivered'
  group by order_id
)
update public.orders order_row
set extra_fields = coalesce(order_row.extra_fields, '{}'::jsonb)
  || jsonb_build_object(
    'delivery',
    coalesce(
      case
        when jsonb_typeof(coalesce(order_row.extra_fields, '{}'::jsonb) -> 'delivery') = 'object'
          then coalesce(order_row.extra_fields, '{}'::jsonb) -> 'delivery'
        else '{}'::jsonb
      end,
      '{}'::jsonb
    ) || jsonb_build_object('completed_at', delivered_events.completed_at)
  )
from delivered_events
where order_row.id = delivered_events.order_id
  and order_row.status = 'delivered'
  and nullif(order_row.extra_fields -> 'delivery' ->> 'completed_at', '') is null;

-- Verification:
-- select count(*) as delivered_missing_completed_at
-- from public.orders
-- where status = 'delivered'
--   and nullif(extra_fields -> 'delivery' ->> 'completed_at', '') is null;
