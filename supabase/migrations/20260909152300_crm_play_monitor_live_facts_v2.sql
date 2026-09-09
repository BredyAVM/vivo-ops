-- Outcome evaluation only needs live delivered purchases. This private read
-- model avoids expanding gift detection and the historical union on every
-- dashboard visit.

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
  end as net_total_usd
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

comment on view app_private.crm_live_purchase_facts_v1 is
  'Minimal live delivered-purchase source used only for CRM outcome evaluation.';

do $optimize$
declare
  function_definition text;
begin
  function_definition := pg_catalog.pg_get_functiondef(
    'public.crm_get_play_monitor_summary_v2(bigint)'::regprocedure
  );
  function_definition := pg_catalog.replace(
    function_definition,
    'public.commercial_order_facts fact',
    'app_private.crm_live_purchase_facts_v1 fact'
  );
  execute function_definition;
end;
$optimize$;
