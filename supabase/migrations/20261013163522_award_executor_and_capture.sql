-- Read-only monthly preview. No official result, reward or financial write.
create or replace function app_private.award_facts_capture_v2(
  p_month date, p_advisor uuid default null, p_category text default null, p_offset integer default 0, p_full boolean default false
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb; v_next date; v_cohort date; v_previous date; v_base date;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Solo el administrador puede evaluar los reconocimientos.' using errcode='42501';
  end if;
  if p_month is null or p_month <> date_trunc('month',p_month)::date
     or p_month < date '2026-01-01'
     or p_month > date_trunc('month',now() at time zone 'America/Caracas')::date
     or p_offset is null or p_offset < 0 or p_offset > 100000
     or (p_category is not null and p_category not in ('alchemist','influential','strategic'))
     or (p_advisor is null) <> (p_category is null) then
    raise exception 'Período o consulta de detalle inválidos.' using errcode='22023';
  end if;
  v_next := (p_month + interval '1 month')::date;
  v_previous := (p_month - interval '1 month')::date;
  v_cohort := (p_month - interval '2 months')::date;
  v_base := (p_month - interval '3 months')::date;
  with advisors as materialized (
    -- Same population as the calibration. Current eligibility is NOT historical staffing.
    select id,full_name from public.profiles where is_active and receives_commissions
  ), ordinary_advisors as materialized (
    select distinct r.user_id from public.user_roles r where r.role::text='advisor'
    and not exists(select 1 from public.user_roles mr where mr.user_id=r.user_id and mr.role::text='master')
  ), company_profiles as materialized (
    select distinct r.user_id from public.user_roles r join public.profiles p on p.id=r.user_id
    where r.role::text in ('master','counter') and not p.receives_commissions
  ), facts as materialized (
    select f.fact_key,f.fact_origin,f.source_record_id,f.source_control,f.client_id,f.purchased_at,
      f.attributed_advisor_id,f.advisor_name_snapshot,f.net_total_usd,
      (f.purchased_at at time zone 'America/Caracas')::date as purchased_on
    from public.commercial_order_facts f
    where f.event_kind='purchase' and f.net_total_usd>0
      and f.purchased_at < (v_next::timestamp at time zone 'America/Caracas')
  ), firsts as materialized (
    select distinct on(client_id) * from facts order by client_id,purchased_at,fact_key
  ), company_firsts as materialized (
    select f.* from firsts f left join public.orders o on f.fact_origin='live' and o.id=f.source_record_id
    left join company_profiles cp on cp.user_id=f.attributed_advisor_id
    where o.extra_fields#>>'{counter,attribution}'='counter' or cp.user_id is not null
      or (f.fact_origin='historical' and upper(trim(f.advisor_name_snapshot)) in ('MASTER','WALK-IN','WALK IN','WALKIN','MOSTRADOR','COUNTER'))
  ), advisor_purchases as materialized (
    select f.* from facts f left join ordinary_advisors a on a.user_id=f.attributed_advisor_id
    where a.user_id is not null or (f.fact_origin='historical' and nullif(trim(f.advisor_name_snapshot),'') is not null
      and upper(trim(f.advisor_name_snapshot)) not in ('MASTER','WALK-IN','WALK IN','WALKIN','MOSTRADOR','COUNTER'))
  ), transitions as materialized (
    select distinct on(c.client_id) c.client_id,f.fact_key,f.purchased_at,f.purchased_on,f.attributed_advisor_id
    from company_firsts c join advisor_purchases f on f.client_id=c.client_id and f.purchased_at>c.purchased_at
    order by c.client_id,f.purchased_at,f.fact_key
  ), ambiguous as materialized (
    select i.client_id from firsts i join facts f on f.client_id=i.client_id and f.purchased_at=i.purchased_at
    group by i.client_id having count(distinct f.attributed_advisor_id)>1
    union
    select t.client_id from transitions t join advisor_purchases f on f.client_id=t.client_id and f.purchased_at=t.purchased_at
    group by t.client_id having count(distinct f.attributed_advisor_id)>1
  ), cohorts as materialized (
    select c.id as client_id,c.full_name as client_name,
      case when c.client_type='assigned' then 'alchemist' else 'influential' end as category,
      case when c.client_type='assigned' then 'direct_assigned' else 'own' end as origin,
      f.fact_key as first_fact_key,f.purchased_at as activation_at,f.purchased_on as first_purchase_on,f.attributed_advisor_id as advisor_id
    from firsts f join public.clients c on c.id=f.client_id join advisors a on a.id=f.attributed_advisor_id
    where c.client_type in ('assigned','own')
      and not exists(select 1 from company_firsts cf where cf.client_id=c.id)
      and not exists(select 1 from ambiguous x where x.client_id=c.id)
    union all
    select c.id,c.full_name,'alchemist','company_to_advisor_inferred',t.fact_key,t.purchased_at,t.purchased_on,t.attributed_advisor_id
    from transitions t join public.clients c on c.id=t.client_id join advisors a on a.id=t.attributed_advisor_id
    where not exists(select 1 from ambiguous x where x.client_id=c.id)
  ), cohort_clients as materialized (
    select c.*,
      count(f.fact_key) filter(where f.purchased_on>=p_month) as period_orders,
      count(f.fact_key) filter(where f.purchased_on>=p_month and f.fact_key<>c.first_fact_key) as period_repeat_orders,
      coalesce(sum(f.net_total_usd) filter(where f.purchased_on>=p_month),0) as period_revenue,
      count(f.fact_key) filter(where f.purchased_on>=v_previous and f.purchased_on<p_month) as previous_month_orders
    from cohorts c left join facts f on f.client_id=c.client_id and f.attributed_advisor_id=c.advisor_id
      and f.purchased_at>=c.activation_at and f.purchased_on>=v_cohort
    where c.first_purchase_on>=v_cohort and c.first_purchase_on<v_next
    group by c.client_id,c.client_name,c.category,c.origin,c.first_fact_key,c.activation_at,c.first_purchase_on,c.advisor_id
  ), cohort_metrics as materialized (
    select a.id as advisor_id,a.full_name as advisor_name,k.category,
      count(c.client_id) filter(where c.first_purchase_on>=p_month) as incorporation,
      count(c.client_id) filter(where c.first_purchase_on>=p_month and c.origin='company_to_advisor_inferred') as inferred_new,
      count(c.client_id) filter(where c.first_purchase_on<p_month) as older_pool,
      count(c.client_id) filter(where c.first_purchase_on<p_month and c.period_orders>0) as older_returned,
      100.0*count(c.client_id) filter(where c.first_purchase_on<p_month and c.period_orders>0)
        /nullif(count(c.client_id) filter(where c.first_purchase_on<p_month),0) as return_pct,
      100.0*avg(case when c.first_purchase_on<v_previous then ((previous_month_orders>0)::int+(period_orders>0)::int)::numeric/2
        when c.first_purchase_on<p_month then (period_orders>0)::int::numeric else null end) as regularity_pct,
      coalesce(sum(c.period_repeat_orders),0) as repeat_orders,coalesce(sum(c.period_revenue),0) as revenue
    from advisors a cross join (values ('alchemist'),('influential')) k(category)
    left join cohort_clients c on c.advisor_id=a.id and c.category=k.category
    group by a.id,a.full_name,k.category
  ), owners as materialized (
    select distinct on(f.client_id) f.client_id,f.attributed_advisor_id as advisor_id
    from facts f join advisors a on a.id=f.attributed_advisor_id join firsts i on i.client_id=f.client_id
    where f.purchased_on<p_month and i.purchased_on<v_base
      and not exists(select 1 from ambiguous x where x.client_id=f.client_id)
    order by f.client_id,f.purchased_at desc,f.fact_key desc
  ), portfolio_clients as materialized (
    select o.client_id,c.full_name as client_name,o.advisor_id,
      max(f.purchased_on) filter(where f.purchased_on<p_month) as last_purchase_on,
      count(f.fact_key) filter(where f.attributed_advisor_id=o.advisor_id and f.purchased_on>=p_month) as current_orders,
      coalesce(sum(f.net_total_usd) filter(where f.attributed_advisor_id=o.advisor_id and f.purchased_on>=p_month),0) as current_revenue,
      coalesce(sum(f.net_total_usd) filter(where f.attributed_advisor_id=o.advisor_id and f.purchased_on>=v_previous and f.purchased_on<p_month),0) as prior_revenue,
      count(distinct f.purchased_on) filter(where f.attributed_advisor_id=o.advisor_id and f.purchased_on>=p_month) as current_buy_days,
      count(f.fact_key) filter(where f.attributed_advisor_id=o.advisor_id and f.purchased_on>=v_previous and f.purchased_on<p_month) as prior_orders
    from owners o join public.clients c on c.id=o.client_id join facts f on f.client_id=o.client_id
    group by o.client_id,c.full_name,o.advisor_id
  ), strategic_metrics as materialized (
    select a.id as advisor_id,a.full_name as advisor_name,
      count(c.client_id) as mature_portfolio,
      count(c.client_id) filter(where c.current_orders>0) as current_active,
      count(c.client_id) filter(where c.prior_orders>0) as prior_active,
      count(c.client_id) filter(where c.prior_orders>0 and c.current_orders>0) as retained,
      100.0*count(c.client_id) filter(where c.prior_orders>0 and c.current_orders>0)/nullif(count(c.client_id) filter(where c.prior_orders>0),0) as continuity_pct,
      count(c.client_id) filter(where p_month-c.last_purchase_on between 60 and 180) as dormant_60_180,
      count(c.client_id) filter(where p_month-c.last_purchase_on between 60 and 180 and c.current_orders>0) as reactivated_60_180,
      100.0*count(c.client_id) filter(where p_month-c.last_purchase_on between 60 and 180 and c.current_orders>0)
        /nullif(count(c.client_id) filter(where p_month-c.last_purchase_on between 60 and 180),0) as reactivation_pct,
      coalesce(sum(c.current_orders),0) as current_orders,coalesce(sum(c.prior_orders),0) as prior_orders,
      coalesce(sum(c.prior_revenue),0) as prior_revenue,coalesce(sum(c.current_revenue),0) as current_revenue,
      count(c.client_id) filter(where c.current_buy_days>=2) as multi_day_buyers,
      100.0*count(c.client_id) filter(where c.current_buy_days>=2)/nullif(count(c.client_id) filter(where c.current_orders>0),0) as multi_day_buyers_pct
    from advisors a left join portfolio_clients c on c.advisor_id=a.id group by a.id,a.full_name
  ), monthly as materialized (
    select date_trunc('month',f.purchased_at at time zone 'America/Caracas')::date as month_start,f.attributed_advisor_id as advisor_id,
      count(*) as orders,count(distinct f.client_id) as active_clients,sum(f.net_total_usd) as revenue
    from facts f join advisors a on a.id=f.attributed_advisor_id
    where extract(year from f.purchased_on)<extract(year from p_month) group by 1,2
  ), seasonal_samples as materialized (
    select extract(year from h.month_start)::int as year,h.advisor_id,
      p.orders as previous_orders,h.orders as current_orders,p.active_clients as previous_active,h.active_clients as current_active,
      p.revenue as previous_revenue,h.revenue as current_revenue
    from monthly h join monthly p on p.advisor_id=h.advisor_id and p.month_start=(h.month_start-interval '1 month')::date
    where extract(month from h.month_start)=extract(month from p_month) and p.orders>0 and p.revenue>0
  ), evidence as materialized (
    select c.client_id,c.client_name,c.advisor_id,c.category,to_jsonb(c) as metrics from cohort_clients c
    union all
    select c.client_id,c.client_name,c.advisor_id,'strategic',to_jsonb(c) from portfolio_clients c
  ), selected_evidence as materialized (
    select e.* from evidence e where p_full or (e.advisor_id=p_advisor and e.category=p_category)
  ), order_rows as (
    select e.category,e.advisor_id,e.client_id,f.fact_origin,f.source_record_id,f.source_control,f.purchased_on,f.net_total_usd,
      row_number() over(partition by e.category,e.advisor_id,e.client_id order by f.purchased_at,f.fact_key) as rn
    from selected_evidence e join facts f on f.client_id=e.client_id and f.attributed_advisor_id=e.advisor_id
      and f.purchased_on>=case when e.category='strategic' then v_previous else v_cohort end
  ), order_groups as (
    select category,advisor_id,client_id,jsonb_agg(to_jsonb(o)-'category'-'advisor_id'-'client_id'-'rn' order by rn) as orders
    from order_rows o where rn<=21 group by category,advisor_id,client_id
  ), evidence_page as (
    select e.*,coalesce(o.orders,'[]'::jsonb) as orders from selected_evidence e
    left join order_groups o using(category,advisor_id,client_id)
    order by e.client_name,e.client_id limit case when p_full then null else 50 end offset p_offset
  )
  select jsonb_build_object('period',p_month,'calculated_at',statement_timestamp(),'rule_version','awards-v2',
    'cohort_metrics',coalesce((select jsonb_agg(c order by advisor_name,category) from cohort_metrics c),'[]'::jsonb),
    'strategic_metrics',coalesce((select jsonb_agg(c order by advisor_name) from strategic_metrics c),'[]'::jsonb),
    'seasonal_samples',coalesce((select jsonb_agg(s order by year,advisor_id) from seasonal_samples s),'[]'::jsonb),
    'ambiguous_clients',(select count(*) from ambiguous),
    'evidence_total',(select count(*) from selected_evidence),
    'evidence',coalesce((select jsonb_agg(e order by client_name,client_id) from evidence_page e),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function app_private.award_facts_capture_v2(date,uuid,text,integer,boolean) from public,anon,authenticated;

create or replace function app_private.award_executor_capture_v2(p_month date,p_full boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; v_from timestamptz; v_until timestamptz;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo el administrador.' using errcode='42501'; end if;
  v_from:=p_month::timestamp at time zone 'America/Caracas';
  v_until:=least((p_month+interval '1 month')::timestamp at time zone 'America/Caracas',statement_timestamp());
  with plays as materialized (
    -- A campaign belongs to its publication month, not every month it overlaps.
    select p.id,p.name,p.activated_at,p.ends_at,
      greatest(0,((least(p.ends_at,v_until) at time zone 'America/Caracas')::date-(p.activated_at at time zone 'America/Caracas')::date)+1) as available_days
    from public.crm_plays p where p.activated_at>=v_from and p.activated_at<v_until
  ), delivered as materialized (
    select r.play_member_id,count(*) as deliveries,sum(r.advisor_charge_usd) as advisor_investment,sum(r.company_cost_usd) as company_investment,
      count(*) filter(where r.advisor_charge_usd is null or r.company_cost_usd is null) as missing_cost_records,
      jsonb_agg(jsonb_build_object('order_id',r.order_id,'delivered_at',r.redeemed_at,'advisor_cost',r.advisor_charge_usd,'company_cost',r.company_cost_usd) order by r.redeemed_at,r.id) as orders
    from public.crm_play_redemptions r join public.crm_play_members m on m.id=r.play_member_id
    join plays p on p.id=m.play_id join public.orders o on o.id=r.order_id
    join public.order_items i on i.id=r.order_item_id and i.product_id=r.product_id and i.qty>0
      and (i.crm_play_member_id=r.play_member_id or i.crm_play_member_id is null)
    where r.status='redeemed' and o.status::text='delivered' and o.client_id=m.client_id
      and r.redeemed_at>=v_from and r.redeemed_at<v_until
    group by r.play_member_id
  ), events as materialized (
    select e.play_member_id,
      bool_or(e.event_type::text='contact' and coalesce(e.note,'') not ilike '%inferid%') as direct_contact,
      bool_or(e.event_type::text='responded' and coalesce(e.note,'') not ilike '%inferid%') as direct_response,
      bool_or(e.event_type::text='launched' and coalesce(e.note,'') not ilike '%inferid%') as direct_proposal
    from public.crm_play_member_events e join public.crm_play_members m on m.id=e.play_member_id join plays p on p.id=m.play_id
    where e.created_at>=v_from and e.created_at<v_until group by e.play_member_id
  ), members as materialized (
    select m.id as member_id,m.play_id,m.client_id,c.full_name as client_name,m.advisor_id_snapshot as advisor_id,a.full_name as advisor_name,
      coalesce(d.deliveries,0)>0 as delivered,
      (coalesce(d.deliveries,0)>0 or m.contacted_at>=v_from and m.contacted_at<v_until) as contact,
      (coalesce(d.deliveries,0)>0 or m.responded_at>=v_from and m.responded_at<v_until) as response,
      (coalesce(d.deliveries,0)>0 or m.play_launched_at>=v_from and m.play_launched_at<v_until) as proposal,
      coalesce(e.direct_contact,false) as direct_contact,coalesce(e.direct_response,false) as direct_response,coalesce(e.direct_proposal,false) as direct_proposal,
      coalesce(d.advisor_investment,0) as advisor_investment,coalesce(d.company_investment,0) as company_investment,
      coalesce(d.missing_cost_records,0) as missing_cost_records,
      coalesce(d.orders,'[]'::jsonb) as delivery_orders,
      case when coalesce(d.deliveries,0)>0 then false else
        exists(select 1 from public.crm_play_no_apply_requests q where q.play_member_id=m.id and q.status='approved' and q.reviewed_at<v_until)
        or coalesce((select am.amendment_type='member_removed' from public.crm_play_amendments am
          where am.play_id=m.play_id and am.client_id=m.client_id and am.created_at<v_until
            and am.amendment_type in ('member_removed','member_added') order by am.created_at desc,am.id desc limit 1),false)
        or (m.workflow_status::text='removed' and m.updated_at<v_until)
      end as excluded,
      coalesce((select 'No aplica aprobado: '||coalesce(q.review_note,q.justification,'') from public.crm_play_no_apply_requests q
        where q.play_member_id=m.id and q.status='approved' and q.reviewed_at<v_until order by q.reviewed_at desc limit 1),
        (select am.reason from public.crm_play_amendments am where am.play_id=m.play_id and am.client_id=m.client_id
          and am.amendment_type='member_removed' and am.created_at<v_until order by am.created_at desc,am.id desc limit 1),
        'Retiro administrativo previo al corte.') as exclusion_reason,
      exists(select 1 from public.crm_play_no_apply_requests q where q.play_member_id=m.id and q.requested_at<v_until and (q.status='pending' or q.reviewed_at>=v_until)) as pending_no_apply
    from public.crm_play_members m join plays p on p.id=m.play_id join public.profiles a on a.id=m.advisor_id_snapshot
    join public.clients c on c.id=m.client_id left join delivered d on d.play_member_id=m.id left join events e on e.play_member_id=m.id
    where a.is_active and a.receives_commissions and m.created_at<v_until
  ), counts as (
    select advisor_id,advisor_name,play_id,
      count(*) filter(where not excluded) as assigned,
      count(*) filter(where not excluded and contact) as contact,
      count(*) filter(where not excluded and response) as response,
      count(*) filter(where not excluded and proposal) as proposal,
      count(*) filter(where not excluded and delivered) as delivered,
      count(*) filter(where not excluded and direct_contact) as direct_contact,
      count(*) filter(where not excluded and direct_response) as direct_response,
      count(*) filter(where not excluded and direct_proposal) as direct_proposal,
      count(*) filter(where excluded) as excluded,
      count(*) filter(where pending_no_apply and not excluded) as pending_no_apply,
      coalesce(sum(advisor_investment) filter(where not excluded),0) as advisor_investment,
      coalesce(sum(company_investment) filter(where not excluded),0) as company_investment
      ,coalesce(sum(missing_cost_records) filter(where not excluded),0) as missing_cost_records
    from members group by advisor_id,advisor_name,play_id
  ), volume as (
    select advisor_id,count(distinct client_id) filter(where not excluded and proposal) as proposal_clients from members group by advisor_id
  )
  select jsonb_build_object('plays',coalesce((select jsonb_agg(p order by activated_at,id) from plays p),'[]'::jsonb),
    'counts',coalesce((select jsonb_agg(c order by advisor_name,play_id) from counts c),'[]'::jsonb),
    'volume',coalesce((select jsonb_agg(v order by advisor_id) from volume v),'[]'::jsonb),
    'evidence',case when p_full then coalesce((select jsonb_agg(m order by advisor_id,client_name,member_id) from members m),'[]'::jsonb) else '[]'::jsonb end)
  into v_result;
  return v_result;
end; $$;
revoke all on function app_private.award_executor_capture_v2(date,boolean) from public,anon,authenticated;

create or replace function public.admin_award_evaluation_preview_v2(p_month date,p_advisor uuid default null,p_category text default null,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_facts jsonb; v_execution jsonb;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo el administrador.' using errcode='42501'; end if;
  if p_category='executor' then
    v_facts:=app_private.award_facts_capture_v2(p_month);
    v_execution:=app_private.award_executor_capture_v2(p_month,true);
    v_facts:=v_facts || jsonb_build_object('evidence_total',(select count(*) from jsonb_array_elements(v_execution->'evidence') x where x->>'advisor_id'=p_advisor::text),
      'executor_evidence',coalesce((select jsonb_agg(x) from(select x from jsonb_array_elements(v_execution->'evidence') x where x->>'advisor_id'=p_advisor::text order by x->>'client_name',x->>'member_id' limit 50 offset p_offset)q),'[]'::jsonb));
  else
    v_facts:=app_private.award_facts_capture_v2(p_month,p_advisor,p_category,p_offset,false);
    v_execution:=app_private.award_executor_capture_v2(p_month,false);
  end if;
  if p_offset is null or p_offset<0 or p_offset>100000 or (p_category='executor' and p_advisor is null) then raise exception 'Detalle inválido.'; end if;
  return v_facts||jsonb_build_object('execution',v_execution-'evidence');
end; $$;
revoke all on function public.admin_award_evaluation_preview_v2(date,uuid,text,integer) from public,anon;
grant execute on function public.admin_award_evaluation_preview_v2(date,uuid,text,integer) to authenticated;
notify pgrst,'reload schema';
