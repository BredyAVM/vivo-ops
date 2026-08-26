-- CRM play definitions are tested privately before they can be frozen and
-- shared. Budget values are snapshots so later catalog changes do not alter
-- an already reviewed simulation.

alter table public.crm_plays
  add column planned_budget_usd numeric(14,2);

alter table public.crm_plays
  add constraint crm_plays_planned_budget_nonnegative_check
  check (planned_budget_usd is null or planned_budget_usd >= 0);

alter table public.crm_play_benefits
  add column unit_budget_cost_usd numeric(12,2) not null default 0;

alter table public.crm_play_benefits
  add constraint crm_play_benefits_unit_budget_cost_nonnegative_check
  check (unit_budget_cost_usd >= 0);

update public.crm_play_benefits option_row
set unit_budget_cost_usd = pg_catalog.round(
  coalesce(
    nullif(pg_catalog.btrim(product.extra_fields ->> 'advisor_gift_cost_usd'), '')::numeric,
    product.base_price_usd,
    0
  ),
  2
)
from public.products product
where product.id = option_row.product_id;

create or replace function public.crm_refresh_play_preview_summary_v1(p_play_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_status text;
  play_rules jsonb;
  existing_summary jsonb;
  excluded_ids jsonb;
  generated_at timestamptz;
  planned_budget numeric;
  minimum_cost_per_client numeric;
  maximum_cost_per_client numeric;
  preview_summary jsonb;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to refresh a CRM play preview'
      using errcode = '42501';
  end if;

  if p_play_id is null or p_play_id <= 0 then
    raise exception 'A valid CRM play is required'
      using errcode = '22023';
  end if;

  select
    play.status,
    coalesce(play.rules_snapshot, '{}'::jsonb),
    coalesce(play.selection_summary, '{}'::jsonb),
    play.planned_budget_usd
  into play_status, play_rules, existing_summary, planned_budget
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_status is null then
    raise exception 'CRM play does not exist'
      using errcode = 'P0002';
  end if;

  if play_status <> 'draft' then
    raise exception 'Only a draft CRM play can refresh its preview'
      using errcode = '55000';
  end if;

  excluded_ids := case
    when pg_catalog.jsonb_typeof(play_rules -> 'excluded_client_ids') = 'array'
      then play_rules -> 'excluded_client_ids'
    else '[]'::jsonb
  end;

  generated_at := coalesce(
    nullif(existing_summary ->> 'generated_at', '')::timestamptz,
    pg_catalog.now()
  );

  select
    coalesce(pg_catalog.min(option_row.quantity * option_row.unit_budget_cost_usd), 0),
    coalesce(pg_catalog.max(option_row.quantity * option_row.unit_budget_cost_usd), 0)
  into minimum_cost_per_client, maximum_cost_per_client
  from public.crm_play_benefits option_row
  where option_row.play_id = p_play_id;

  select pg_catalog.jsonb_build_object(
    'total', pg_catalog.count(*)::integer,
    'advisor_count', pg_catalog.count(distinct member_row.advisor_id_snapshot)::integer,
    'generated_at', generated_at,
    'excluded_count', pg_catalog.jsonb_array_length(excluded_ids),
    'gifted_client_count', pg_catalog.count(*) filter (where member_row.last_gift_on is not null),
    'benefit_count', (
      select pg_catalog.count(*)::integer
      from public.crm_play_benefits option_row
      where option_row.play_id = p_play_id
    ),
    'total_purchase_count', coalesce(pg_catalog.sum(member_row.purchase_count), 0)::bigint,
    'total_net_revenue_usd', pg_catalog.round(coalesce(pg_catalog.sum(member_row.net_revenue_usd), 0), 2),
    'cost_per_client_min_usd', pg_catalog.round(minimum_cost_per_client, 2),
    'cost_per_client_max_usd', pg_catalog.round(maximum_cost_per_client, 2),
    'projected_cost_min_usd', pg_catalog.round(pg_catalog.count(*) * minimum_cost_per_client, 2),
    'projected_cost_max_usd', pg_catalog.round(pg_catalog.count(*) * maximum_cost_per_client, 2),
    'budget_usd', planned_budget,
    'budget_balance_worst_case_usd', case
      when planned_budget is null then null
      else pg_catalog.round(planned_budget - (pg_catalog.count(*) * maximum_cost_per_client), 2)
    end,
    'budget_capacity_worst_case', case
      when planned_budget is null or maximum_cost_per_client <= 0 then null
      else pg_catalog.floor(planned_budget / maximum_cost_per_client)::bigint
    end,
    'budget_status', case
      when planned_budget is null then 'not_defined'
      when planned_budget >= pg_catalog.count(*) * maximum_cost_per_client then 'within'
      else 'exceeds'
    end,
    'by_advisor', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'advisor_id', advisor_totals.advisor_id,
          'advisor_name', advisor_totals.advisor_name,
          'count', advisor_totals.member_count
        )
        order by advisor_totals.member_count desc, advisor_totals.advisor_name
      )
      from (
        select
          grouped.advisor_id_snapshot as advisor_id,
          coalesce(advisor.full_name, 'Asesor sin nombre') as advisor_name,
          pg_catalog.count(*)::integer as member_count
        from public.crm_play_members grouped
        left join public.profiles advisor on advisor.id = grouped.advisor_id_snapshot
        where grouped.play_id = p_play_id
        group by grouped.advisor_id_snapshot, advisor.full_name
      ) advisor_totals
    ), '[]'::jsonb)
  )
  into preview_summary
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  update public.crm_plays play
  set selection_summary = preview_summary
  where play.id = p_play_id;

  return preview_summary;
end;
$$;

revoke all on function public.crm_refresh_play_preview_summary_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_refresh_play_preview_summary_v1(bigint)
  to authenticated, service_role;

comment on column public.crm_plays.planned_budget_usd is
  'Optional budget available for the privately tested CRM play definition.';

comment on column public.crm_play_benefits.unit_budget_cost_usd is
  'Frozen unit cost used to estimate the play budget independently of later catalog changes.';

comment on function public.crm_refresh_play_preview_summary_v1(bigint) is
  'Refreshes candidate, commercial and budget totals for one private draft CRM play preview.';
