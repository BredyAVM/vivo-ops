begin;
set local lock_timeout = '5s';
-- Read-only administrative projection. Costs are stored snapshots, never current tariffs.
create or replace function public.admin_delivery_overview_v1(
  p_from date, p_to date, p_mode text default 'all', p_query text default '',
  p_offset integer default 0, p_settlement_before timestamptz default null, p_settlement_id bigint default null
)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $function$
declare v_result jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.user_roles r where r.user_id = (select auth.uid()) and r.role = 'admin'
  ) then raise exception 'admin role required' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366
    or p_mode is null or p_mode not in ('all','internal','external','unassigned')
    or p_query is null or length(p_query) > 80
    or p_offset is null or p_offset < 0 or p_offset > 30000
    or ((p_settlement_before is null) <> (p_settlement_id is null)) or p_settlement_id <= 0
  then raise exception 'invalid delivery filters' using errcode = '22023'; end if;
  with delivered as materialized (
    select o.id, coalesce(nullif(o.order_number,''), o.id::text) as "orderNumber",
      coalesce(nullif(c.full_name,''),'Cliente') as "clientName",
      e.delivered_at as "deliveredAt",
      case when o.external_partner_id is not null then 'external'
        when o.internal_driver_user_id is not null then 'internal' else 'unassigned' end as mode,
      coalesce(nullif(dp.name,''), nullif(p.full_name,''), 'Sin asignar') as responsible,
      case when jsonb_typeof(o.extra_fields #> '{delivery,cost_usd}') in ('number','string')
        and o.extra_fields #>> '{delivery,cost_usd}' ~ '^[0-9]+([.][0-9]+)?$'
        and length(o.extra_fields #>> '{delivery,cost_usd}') <= 24
        then round((o.extra_fields #>> '{delivery,cost_usd}')::numeric,2) else null end as "costUsd",
      nullif(o.extra_fields #>> '{delivery,cost_source}','') as "costSource"
    from public.orders o
    left join public.clients c on c.id=o.client_id
    left join public.delivery_partners dp on dp.id=o.external_partner_id
    left join public.profiles p on p.id=o.internal_driver_user_id
    left join lateral (
      select max(ev.created_at) as delivered_at from public.order_events ev
      where ev.order_id=o.id and ev.event='delivered' and ev.created_at<=statement_timestamp()
    ) e on true
    where o.fulfillment='delivery' and o.status='delivered'
  ), filtered as materialized (
    select * from delivered d
    where d."deliveredAt" >= p_from::timestamp at time zone 'America/Caracas'
      and d."deliveredAt" < (p_to+1)::timestamp at time zone 'America/Caracas'
      and (p_mode='all' or d.mode=p_mode)
      and (p_query='' or position(lower(p_query) in lower(d."orderNumber"||' '||d."clientName"||' '||d.responsible||' '||d.id::text))>0)
  ), pending as materialized (
    -- Reuse the authorized operational read; underlying tables stay private.
    select public.counter_read_pending_settlements(p_settlement_before,p_settlement_id,30) as payload
  )
  select jsonb_build_object(
    'definitionVersion','admin-delivery-v1','asOf',statement_timestamp(),
    'from',p_from,'to',p_to,'mode',p_mode,'query',p_query,'offset',p_offset,'pageSize',30,
    'summary',(select jsonb_build_object('deliveries',count(*),'costed',count("costUsd"),
      'knownCostUsd',coalesce(sum("costUsd"),0),'internal',count(*) filter(where mode='internal'),
      'external',count(*) filter(where mode='external'),'unassigned',count(*) filter(where mode='unassigned')) from filtered),
    'undatedDeliveries',(select count(*) from delivered where "deliveredAt" is null),
    'rows',coalesce((select jsonb_agg(to_jsonb(d) order by d."deliveredAt" desc,d.id desc)
      from (select * from filtered order by "deliveredAt" desc,id desc limit 30 offset p_offset)d),'[]'::jsonb),
    'pending',(select payload from pending)
  ) into v_result;
  return v_result;
end;
$function$;
revoke all on function public.admin_delivery_overview_v1(date,date,text,text,integer,timestamptz,bigint) from public,anon,authenticated,service_role;
grant execute on function public.admin_delivery_overview_v1(date,date,text,text,integer,timestamptz,bigint) to authenticated;
commit;
