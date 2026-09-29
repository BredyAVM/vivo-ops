begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Operational current balances, not commission/settlement snapshots.
-- No writes, no new debt calculation and no implicit payment confirmation.
create or replace function app_private.admin_collections_read_v1(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_as_of timestamptz := statement_timestamp();
  v_today date := (v_as_of at time zone 'America/Caracas')::date;
  v_from date := nullif(p_filters->>'from','')::date;
  v_to date := nullif(p_filters->>'to','')::date;
  v_basis text := coalesce(p_filters->>'basis','created');
  v_status text := coalesce(p_filters->>'status','pending');
  v_source text := coalesce(p_filters->>'source','all');
  v_fulfillment text := coalesce(p_filters->>'fulfillment','all');
  v_person uuid := nullif(p_filters->>'person','')::uuid;
  v_person_basis text := coalesce(p_filters->>'personBasis','either');
  v_role text := coalesce(p_filters->>'role','all');
  v_stage text := coalesce(p_filters->>'stage','all');
  v_sort text := coalesce(p_filters->>'sort','pending');
  v_q text := btrim(coalesce(p_filters->>'q',''));
  v_page integer := coalesce((p_filters->>'page')::integer,1);
  v_result jsonb;
begin
  if v_uid is null or not exists (
    select 1 from public.user_roles r where r.user_id=v_uid and r.role='admin'
  ) then raise exception 'admin role required' using errcode='42501'; end if;
  if p_filters is null or jsonb_typeof(p_filters)<>'object'
    or v_from > v_to or v_page < 1 or v_page > 100000
    or length(v_q)>80
    or v_basis not in ('created','delivered')
    or v_status not in ('all','pending','paid','review','cancelled')
    or v_source not in ('all','advisor','master','walk_in')
    or v_fulfillment not in ('all','pickup','delivery')
    or v_person_basis not in ('either','creator','advisor')
    or v_role not in ('all','admin','master','advisor','counter')
    or v_stage not in ('all','created','queued','confirmed','in_kitchen','ready','out_for_delivery','delivered','cancelled')
    or v_sort not in ('pending','oldest','newest')
  then raise exception 'invalid collections filters' using errcode='22023'; end if;

  with deliveries as materialized (
    select e.order_id, max(e.created_at) as delivered_at
    from public.order_events e where e.event='delivered' group by e.order_id
  ), candidates as materialized (
    select o.id, o.status::text as stage, o.source::text as source,
      o.fulfillment::text as fulfillment, o.created_at,
      (d.delivered_at at time zone 'America/Caracas')::date as delivered_date,
      (o.created_at at time zone 'America/Caracas')::date as created_date,
      coalesce(nullif(c.full_name,''),'Cliente sin nombre') as client_name, c.phone as client_phone,
      o.created_by_user_id as creator_id, coalesce(nullif(creator.full_name,''),'Sin creador identificado') as creator_name,
      o.attributed_advisor_id as advisor_id, advisor.full_name as advisor_name
    from public.orders o
    left join public.clients c on c.id=o.client_id
    left join public.profiles creator on creator.id=o.created_by_user_id
    left join public.profiles advisor on advisor.id=o.attributed_advisor_id
    left join deliveries d on d.order_id=o.id
    where (v_source='all' or o.source::text=v_source)
      and (v_fulfillment='all' or o.fulfillment::text=v_fulfillment)
      and (v_stage='all' or o.status::text=v_stage)
      and (v_person is null
        or (v_person_basis in ('either','creator') and o.created_by_user_id=v_person)
        or (v_person_basis in ('either','advisor') and o.attributed_advisor_id=v_person))
      and (v_role='all' or exists (select 1 from public.user_roles r
        where r.user_id=o.created_by_user_id and r.role::text=v_role))
      and (v_from is null or (case when v_basis='created'
        then (o.created_at at time zone 'America/Caracas')::date
        else (d.delivered_at at time zone 'America/Caracas')::date end)>=v_from)
      and (v_to is null or (case when v_basis='created'
        then (o.created_at at time zone 'America/Caracas')::date
        else (d.delivered_at at time zone 'America/Caracas')::date end)<=v_to)
      and (v_q='' or strpos(lower(concat_ws(' ',o.id::text,c.full_name,c.phone,creator.full_name,advisor.full_name)),lower(v_q))>0
        or o.id::text=regexp_replace(v_q,'[^0-9]','','g'))
      and (v_status in ('all','cancelled') or o.status<>'cancelled')
  ), financial as materialized (
    select c.*, f.total_usd, f.confirmed_paid_usd,
      case when c.stage='cancelled' then 0 else f.pending_usd end as pending_usd,
      f.pending_reports_usd, f.pending_reports_count, f.payment_status
    from candidates c cross join lateral public.get_order_financial_state(c.id,v_today,null) f
  ), filtered as materialized (
    select * from financial f where
      v_status='all'
      or (v_status='pending' and f.pending_usd>0.005)
      or (v_status='paid' and f.pending_usd<=0.005 and f.pending_reports_count=0)
      or (v_status='review' and f.pending_reports_count>0)
      or (v_status='cancelled' and f.stage='cancelled')
  ), totals as (
    select count(*)::integer as orders,
      coalesce(sum(total_usd) filter(where stage<>'cancelled'),0) as total_usd,
      coalesce(sum(least(total_usd,greatest(0,confirmed_paid_usd))) filter(where stage<>'cancelled'),0) as covered_usd,
      coalesce(sum(pending_usd),0) as pending_usd,
      coalesce(sum(pending_reports_usd),0) as review_usd,
      coalesce(sum(pending_reports_count),0)::integer as review_count
    from filtered
  ), pagination as (
    select t.*, greatest(1,ceil(t.orders::numeric/30)::integer) as pages,
      least(v_page,greatest(1,ceil(t.orders::numeric/30)::integer)) as page from totals t
  ), page_rows as (
    select f.* from filtered f
    order by case when v_sort='pending' then pending_usd end desc,
      case when v_sort='oldest' then created_at end asc,
      case when v_sort='newest' then created_at end desc, id desc
    limit 30 offset (select (page-1)*30 from pagination)
  ), people as (
    select distinct p.id, coalesce(nullif(p.full_name,''),'Usuario sin nombre') as name
    from public.profiles p where exists(select 1 from public.orders o
      where o.created_by_user_id=p.id or o.attributed_advisor_id=p.id)
  )
  select jsonb_build_object(
    'version','admin-collections-v1','asOf',v_as_of,
    'balanceSource','canonical_order_financial_state','cutoffMode','current_statement',
    'page',pg.page,'pages',pg.pages,'pageSize',30,
    'totals',jsonb_build_object('orders',pg.orders,'totalUsd',pg.total_usd,
      'coveredUsd',pg.covered_usd,'pendingUsd',pg.pending_usd,'reviewUsd',pg.review_usd,'reviewCount',pg.review_count),
    'people',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name,id) from people),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'clientName',r.client_name,'clientPhone',r.client_phone,
      'creatorId',r.creator_id,'creatorName',r.creator_name,'advisorId',r.advisor_id,'advisorName',r.advisor_name,
      'createdDate',r.created_date,'deliveredDate',r.delivered_date,
      'source',r.source,'fulfillment',r.fulfillment,'stage',r.stage,
      'totalUsd',r.total_usd,'coveredUsd',least(r.total_usd,greatest(0,r.confirmed_paid_usd)),
      'pendingUsd',r.pending_usd,'reviewUsd',r.pending_reports_usd,'reviewCount',r.pending_reports_count,
      'paymentStatus',r.payment_status
    ) order by case when v_sort='pending' then r.pending_usd end desc,
      case when v_sort='oldest' then r.created_at end asc,
      case when v_sort='newest' then r.created_at end desc,r.id desc) from page_rows r),'[]'::jsonb)
  ) into v_result from pagination pg;
  return v_result;
end;
$function$;

create or replace function public.admin_collections_read_v1(p_filters jsonb default '{}'::jsonb)
returns jsonb language sql stable security invoker set search_path = ''
as $function$ select app_private.admin_collections_read_v1(p_filters); $function$;
revoke all on function app_private.admin_collections_read_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.admin_collections_read_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function app_private.admin_collections_read_v1(jsonb) to authenticated;
grant execute on function public.admin_collections_read_v1(jsonb) to authenticated;
comment on function public.admin_collections_read_v1(jsonb) is
  'Admin-only collections. Date filters select orders, balances are current. Creator roles are current roles, not historical attribution. No financial writes.';
commit;
