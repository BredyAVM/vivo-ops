-- A direct result exists only when a redeemed benefit remains attached to a
-- valid order. Revenue is recognized after delivery and without invoice tax.

create or replace view app_private.crm_live_purchase_facts_v1
with (security_invoker = true)
as
select
  order_row.client_id,
  'live'::text as fact_origin,
  'purchase'::text as event_kind,
  case
    when nullif(order_row.extra_fields #>> '{delivery,completed_at}', '')
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      then (order_row.extra_fields #>> '{delivery,completed_at}')::timestamptz
    when order_row.extra_fields #>> '{schedule,date}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      then ((order_row.extra_fields #>> '{schedule,date}')::date::timestamp
        + time '12:00') at time zone 'America/Caracas'
    else order_row.created_at
  end as purchased_at,
  case
    when order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
      ~ '^[0-9]+([.][0-9]+)?$'
      then pg_catalog.round(
        (order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}')::numeric,
        2
      )
    else pg_catalog.round(order_row.total_usd, 2)
  end as net_total_usd,
  order_row.created_at as recorded_at,
  order_row.id as order_id
from public.orders order_row
where order_row.status = 'delivered'
  and order_row.client_id is not null
  and case
    when order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
      ~ '^[0-9]+([.][0-9]+)?$'
      then (order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}')::numeric
    else order_row.total_usd
  end > 0;

revoke all on app_private.crm_live_purchase_facts_v1
  from public, anon, authenticated;
grant select on app_private.crm_live_purchase_facts_v1 to service_role;

do $create_monitor_v3$
declare
  function_definition text;
  previous_launch_expression text :=
    $old$min(event_row.created_at) filter (where event_row.event_type = 'contact') as launched_at$old$;
  next_launch_expression text :=
    $new$min(event_row.created_at) filter (
        where event_row.event_type in (
          'contact', 'unreachable', 'responded', 'accepted', 'converted'
        )
      ) as launched_at$new$;
  previous_direct_sales text :=
    $old$direct_sales as (
    select coalesce(sum(order_row.total_usd), 0)::numeric as direct_order_revenue_usd
    from direct_orders direct_order
    join public.orders order_row on order_row.id = direct_order.order_id
  )$old$;
  next_direct_sales text :=
    $new$direct_sales as (
    select coalesce(sum(fact.net_total_usd), 0)::numeric as direct_order_revenue_usd
    from direct_orders direct_order
    join app_private.crm_live_purchase_facts_v1 fact
      on fact.order_id = direct_order.order_id
  )$new$;
begin
  function_definition := pg_catalog.pg_get_functiondef(
    'public.crm_get_play_monitor_summary_v2(bigint)'::regprocedure
  );

  if pg_catalog.strpos(function_definition, previous_launch_expression) = 0
    or pg_catalog.strpos(function_definition, previous_direct_sales) = 0 then
    raise exception 'CRM play monitor v2 no longer matches the expected audited definition';
  end if;

  function_definition := pg_catalog.replace(
    function_definition,
    'crm_get_play_monitor_summary_v2',
    'crm_get_play_monitor_summary_v3'
  );
  function_definition := pg_catalog.replace(
    function_definition,
    previous_launch_expression,
    next_launch_expression
  );
  function_definition := pg_catalog.replace(
    function_definition,
    previous_direct_sales,
    next_direct_sales
  );
  execute function_definition;
end;
$create_monitor_v3$;

revoke all on function public.crm_get_play_monitor_summary_v3(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_get_play_monitor_summary_v3(bigint)
  to authenticated, service_role;

comment on function public.crm_get_play_monitor_summary_v3(bigint) is
  'Separates direct redemption from post-response influence and recognizes delivered net revenue without invoice tax.';

create or replace function app_private.crm_void_play_redemptions_on_order_cancel_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'cancelled' or old.status = 'cancelled' then
    return new;
  end if;

  with voided as (
    update public.crm_play_redemptions redemption
    set
      status = 'voided',
      voided_at = pg_catalog.now(),
      void_reason = pg_catalog.concat(
        'Aplicación anulada automáticamente al cancelar el pedido ',
        coalesce(new.order_number, new.id::text),
        '.'
      )
    where redemption.order_id = new.id
      and redemption.status = 'redeemed'
    returning redemption.play_member_id
  )
  update public.crm_play_members member
  set benefit_status = case
    when play.status in ('active', 'paused')
      and (play.starts_at is null or pg_catalog.now() >= play.starts_at)
      and (play.ends_at is null or pg_catalog.now() < play.ends_at)
      then 'available'
    else 'expired'
  end
  from public.crm_plays play
  where member.id in (select voided.play_member_id from voided)
    and play.id = member.play_id
    and play.status in ('active', 'paused')
    and not exists (
      select 1
      from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id
        and remaining.status = 'redeemed'
    );

  return new;
end;
$$;

revoke all on function app_private.crm_void_play_redemptions_on_order_cancel_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists orders_void_crm_play_redemptions_on_cancel on public.orders;
create trigger orders_void_crm_play_redemptions_on_cancel
after update of status on public.orders
for each row
when (new.status = 'cancelled' and old.status is distinct from new.status)
execute function app_private.crm_void_play_redemptions_on_order_cancel_v1();
