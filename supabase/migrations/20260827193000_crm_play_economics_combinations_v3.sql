-- Play-specific benefit economics, single/combination selection and an
-- explicit order requirement. Catalog prices remain defaults only: every
-- reviewed play freezes its own USD split between advisor and company.

alter table public.crm_plays
  add column benefit_selection_mode text not null default 'single',
  add column purchase_requirement_mode text not null default 'none',
  add column minimum_order_amount_usd numeric(12,2);

alter table public.crm_plays
  add constraint crm_plays_benefit_selection_mode_check
    check (benefit_selection_mode in ('single', 'multiple')),
  add constraint crm_plays_purchase_requirement_mode_check
    check (purchase_requirement_mode in ('none', 'minimum_order')),
  add constraint crm_plays_purchase_requirement_amount_check
    check (
      (purchase_requirement_mode = 'none' and minimum_order_amount_usd is null)
      or (
        purchase_requirement_mode = 'minimum_order'
        and minimum_order_amount_usd is not null
        and minimum_order_amount_usd > 0
      )
    );

alter table public.crm_play_benefits
  add column unit_benefit_value_usd numeric(12,2) not null default 0,
  add column unit_advisor_cost_usd numeric(12,2) not null default 0,
  add column unit_company_cost_usd numeric(12,2) not null default 0;

update public.crm_play_benefits option_row
set
  unit_benefit_value_usd = pg_catalog.round(
    greatest(
      coalesce(product.base_price_usd, 0),
      coalesce(
        nullif(pg_catalog.btrim(product.extra_fields ->> 'advisor_gift_cost_usd'), '')::numeric,
        0
      ),
      option_row.unit_budget_cost_usd
    ),
    2
  ),
  unit_advisor_cost_usd = pg_catalog.round(
    least(
      greatest(
        coalesce(product.base_price_usd, 0),
        coalesce(
          nullif(pg_catalog.btrim(product.extra_fields ->> 'advisor_gift_cost_usd'), '')::numeric,
          0
        ),
        option_row.unit_budget_cost_usd
      ),
      coalesce(
        nullif(pg_catalog.btrim(product.extra_fields ->> 'advisor_gift_cost_usd'), '')::numeric,
        option_row.unit_budget_cost_usd,
        0
      )
    ),
    2
  )
from public.products product
where product.id = option_row.product_id;

update public.crm_play_benefits option_row
set
  unit_company_cost_usd = pg_catalog.round(
    greatest(option_row.unit_benefit_value_usd - option_row.unit_advisor_cost_usd, 0),
    2
  ),
  unit_budget_cost_usd = pg_catalog.round(
    greatest(option_row.unit_benefit_value_usd - option_row.unit_advisor_cost_usd, 0),
    2
  );

alter table public.crm_play_benefits
  add constraint crm_play_benefits_economics_nonnegative_check
    check (
      unit_benefit_value_usd >= 0
      and unit_advisor_cost_usd >= 0
      and unit_company_cost_usd >= 0
    ),
  add constraint crm_play_benefits_economics_split_check
    check (
      pg_catalog.abs(
        unit_benefit_value_usd - unit_advisor_cost_usd - unit_company_cost_usd
      ) <= 0.01
    ),
  add constraint crm_play_benefits_budget_company_cost_check
    check (pg_catalog.abs(unit_budget_cost_usd - unit_company_cost_usd) <= 0.01),
  add constraint crm_play_benefits_id_play_unique unique (id, play_id);

alter table public.crm_play_members
  add constraint crm_play_members_id_play_unique unique (id, play_id);

create table public.crm_play_member_benefit_selections (
  play_member_id bigint not null,
  play_benefit_id bigint not null,
  play_id bigint not null,
  selected_by_user_id uuid not null references public.profiles(id) on delete restrict,
  selected_at timestamptz not null default pg_catalog.now(),
  primary key (play_member_id, play_benefit_id),
  constraint crm_member_benefit_selection_member_fkey
    foreign key (play_member_id, play_id)
    references public.crm_play_members(id, play_id) on delete cascade,
  constraint crm_member_benefit_selection_benefit_fkey
    foreign key (play_benefit_id, play_id)
    references public.crm_play_benefits(id, play_id) on delete cascade
);

create index crm_member_benefit_selections_play_idx
  on public.crm_play_member_benefit_selections(play_id, play_member_id);

insert into public.crm_play_member_benefit_selections (
  play_member_id,
  play_benefit_id,
  play_id,
  selected_by_user_id,
  selected_at
)
select
  member_row.id,
  member_row.selected_play_benefit_id,
  member_row.play_id,
  member_row.selected_benefit_by_user_id,
  member_row.selected_benefit_at
from public.crm_play_members member_row
where member_row.selected_play_benefit_id is not null;

alter table public.crm_play_member_benefit_selections enable row level security;

revoke all on table public.crm_play_member_benefit_selections
  from public, anon, authenticated;
grant select on table public.crm_play_member_benefit_selections to authenticated;
grant all on table public.crm_play_member_benefit_selections to service_role;

create policy crm_member_benefit_selections_select_staff
on public.crm_play_member_benefit_selections
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or exists (
    select 1
    from public.crm_play_members member_row
    where member_row.id = crm_play_member_benefit_selections.play_member_id
      and member_row.advisor_id_snapshot = (select auth.uid())
  )
);

create or replace function public.crm_set_play_benefits_v2(
  p_play_member_id bigint,
  p_play_benefit_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  member_row record;
  requested_ids bigint[];
  current_ids bigint[];
  selection_time timestamptz := pg_catalog.now();
  option_names text;
begin
  if caller_id is null then
    raise exception 'Authentication is required to select CRM benefits'
      using errcode = '42501';
  end if;

  if p_play_member_id is null or p_play_member_id <= 0 then
    raise exception 'A valid CRM play member is required'
      using errcode = '22023';
  end if;

  select
    member.id,
    member.client_id,
    member.play_id,
    member.advisor_id_snapshot,
    member.workflow_status,
    member.benefit_status,
    play.status as play_status,
    play.starts_at,
    play.ends_at,
    play.benefit_selection_mode
  into member_row
  from public.crm_play_members member
  join public.crm_plays play on play.id = member.play_id
  where member.id = p_play_member_id
  for update of member;

  if member_row.id is null then
    raise exception 'CRM play member does not exist'
      using errcode = 'P0002';
  end if;

  if not (member_row.advisor_id_snapshot = caller_id or public.is_master_or_admin()) then
    raise exception 'This CRM benefit belongs to another advisor'
      using errcode = '42501';
  end if;

  if member_row.play_status <> 'active'
    or (member_row.starts_at is not null and selection_time < member_row.starts_at)
    or (member_row.ends_at is not null and selection_time >= member_row.ends_at)
  then
    raise exception 'The CRM play is not active for benefit selection'
      using errcode = '55000';
  end if;

  if member_row.workflow_status = 'removed'
    or member_row.benefit_status not in ('available', 'reserved')
  then
    raise exception 'This CRM play member cannot select a benefit'
      using errcode = '55000';
  end if;

  select pg_catalog.array_agg(option_id order by sort_order, option_id)
  into requested_ids
  from (
    select distinct option_row.id as option_id, option_row.sort_order
    from public.crm_play_benefits option_row
    where option_row.play_id = member_row.play_id
      and option_row.id = any(coalesce(p_play_benefit_ids, '{}'::bigint[]))
  ) valid_options;

  if requested_ids is null
    or pg_catalog.cardinality(requested_ids) <> pg_catalog.cardinality(coalesce(p_play_benefit_ids, '{}'::bigint[]))
  then
    raise exception 'Every selected benefit must belong to this CRM play'
      using errcode = '22023';
  end if;

  if member_row.benefit_selection_mode = 'single'
    and pg_catalog.cardinality(requested_ids) <> 1
  then
    raise exception 'This CRM play requires exactly one benefit'
      using errcode = '22023';
  end if;

  if member_row.benefit_selection_mode = 'multiple'
    and pg_catalog.cardinality(requested_ids) < 1
  then
    raise exception 'Select at least one benefit for this CRM play'
      using errcode = '22023';
  end if;

  select pg_catalog.array_agg(selection.play_benefit_id order by option_row.sort_order, selection.play_benefit_id)
  into current_ids
  from public.crm_play_member_benefit_selections selection
  join public.crm_play_benefits option_row on option_row.id = selection.play_benefit_id
  where selection.play_member_id = p_play_member_id;

  if coalesce(current_ids, '{}'::bigint[]) is distinct from requested_ids then
    delete from public.crm_play_member_benefit_selections selection
    where selection.play_member_id = p_play_member_id;

    insert into public.crm_play_member_benefit_selections (
      play_member_id,
      play_benefit_id,
      play_id,
      selected_by_user_id,
      selected_at
    )
    select
      p_play_member_id,
      option_row.id,
      member_row.play_id,
      caller_id,
      selection_time
    from public.crm_play_benefits option_row
    where option_row.id = any(requested_ids)
    order by option_row.sort_order, option_row.id;

    update public.crm_play_members member
    set
      selected_play_benefit_id = requested_ids[1],
      selected_benefit_at = selection_time,
      selected_benefit_by_user_id = caller_id
    where member.id = p_play_member_id;

    select pg_catalog.string_agg(
      pg_catalog.concat(option_row.quantity, ' × ', product.name),
      ', '
      order by option_row.sort_order, option_row.id
    )
    into option_names
    from public.crm_play_benefits option_row
    join public.products product on product.id = option_row.product_id
    where option_row.id = any(requested_ids);

    insert into public.crm_play_member_events (
      play_member_id,
      event_type,
      from_status,
      to_status,
      note,
      actor_user_id,
      created_at
    ) values (
      p_play_member_id,
      'benefit_selected',
      member_row.workflow_status,
      member_row.workflow_status,
      pg_catalog.concat('Beneficio seleccionado: ', option_names),
      caller_id,
      selection_time
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'play_member_id', p_play_member_id,
    'play_id', member_row.play_id,
    'client_id', member_row.client_id,
    'selection_mode', member_row.benefit_selection_mode,
    'selected_play_benefit_ids', requested_ids,
    'selected_benefit_at', selection_time
  );
end;
$$;

revoke all on function public.crm_set_play_benefits_v2(bigint, bigint[])
  from public, anon, authenticated;
grant execute on function public.crm_set_play_benefits_v2(bigint, bigint[])
  to authenticated, service_role;

create or replace function public.crm_select_play_benefit_v1(
  p_play_member_id bigint,
  p_play_benefit_id bigint
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.crm_set_play_benefits_v2(p_play_member_id, array[p_play_benefit_id]);
$$;

revoke all on function public.crm_select_play_benefit_v1(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.crm_select_play_benefit_v1(bigint, bigint)
  to authenticated, service_role;

create or replace function app_private.crm_play_terms_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'draft' and (
    new.benefit_selection_mode is distinct from old.benefit_selection_mode
    or new.purchase_requirement_mode is distinct from old.purchase_requirement_mode
    or new.minimum_order_amount_usd is distinct from old.minimum_order_amount_usd
  ) then
    raise exception 'Frozen CRM play benefit terms are immutable';
  end if;

  return new;
end;
$$;

revoke all on function app_private.crm_play_terms_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_terms_guard_v1() to service_role;

create trigger crm_play_terms_guard
before update on public.crm_plays
for each row execute function app_private.crm_play_terms_guard_v1();

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
  selection_mode text;
  play_rules jsonb;
  existing_summary jsonb;
  excluded_ids jsonb;
  generated_at timestamptz;
  planned_budget numeric;
  company_min numeric := 0;
  company_max numeric := 0;
  advisor_min numeric := 0;
  advisor_max numeric := 0;
  value_min numeric := 0;
  value_max numeric := 0;
  preview_summary jsonb;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to refresh a CRM play preview'
      using errcode = '42501';
  end if;

  select
    play.status,
    play.benefit_selection_mode,
    coalesce(play.rules_snapshot, '{}'::jsonb),
    coalesce(play.selection_summary, '{}'::jsonb),
    play.planned_budget_usd
  into play_status, selection_mode, play_rules, existing_summary, planned_budget
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_status is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_status <> 'draft' then
    raise exception 'Only a draft CRM play can refresh its preview' using errcode = '55000';
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

  if selection_mode = 'multiple' then
    select
      coalesce(pg_catalog.min(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_benefit_value_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_benefit_value_usd), 0)
    into company_min, company_max, advisor_min, advisor_max, value_min, value_max
    from public.crm_play_benefits
    where play_id = p_play_id;
  else
    select
      coalesce(pg_catalog.min(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_benefit_value_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_benefit_value_usd), 0)
    into company_min, company_max, advisor_min, advisor_max, value_min, value_max
    from public.crm_play_benefits
    where play_id = p_play_id;
  end if;

  select pg_catalog.jsonb_build_object(
    'total', pg_catalog.count(*)::integer,
    'advisor_count', pg_catalog.count(distinct member_row.advisor_id_snapshot)::integer,
    'generated_at', generated_at,
    'excluded_count', pg_catalog.jsonb_array_length(excluded_ids),
    'gifted_client_count', pg_catalog.count(*) filter (where member_row.last_gift_on is not null),
    'benefit_count', (select pg_catalog.count(*)::integer from public.crm_play_benefits where play_id = p_play_id),
    'benefit_selection_mode', selection_mode,
    'total_purchase_count', coalesce(pg_catalog.sum(member_row.purchase_count), 0)::bigint,
    'total_net_revenue_usd', pg_catalog.round(coalesce(pg_catalog.sum(member_row.net_revenue_usd), 0), 2),
    'company_cost_per_client_min_usd', pg_catalog.round(company_min, 2),
    'company_cost_per_client_max_usd', pg_catalog.round(company_max, 2),
    'projected_cost_min_usd', pg_catalog.round(pg_catalog.count(*) * company_min, 2),
    'projected_cost_max_usd', pg_catalog.round(pg_catalog.count(*) * company_max, 2),
    'advisor_charge_per_client_min_usd', pg_catalog.round(advisor_min, 2),
    'advisor_charge_per_client_max_usd', pg_catalog.round(advisor_max, 2),
    'projected_advisor_charge_min_usd', pg_catalog.round(pg_catalog.count(*) * advisor_min, 2),
    'projected_advisor_charge_max_usd', pg_catalog.round(pg_catalog.count(*) * advisor_max, 2),
    'benefit_value_per_client_min_usd', pg_catalog.round(value_min, 2),
    'benefit_value_per_client_max_usd', pg_catalog.round(value_max, 2),
    'budget_usd', planned_budget,
    'budget_balance_worst_case_usd', case
      when planned_budget is null then null
      else pg_catalog.round(planned_budget - (pg_catalog.count(*) * company_max), 2)
    end,
    'budget_capacity_worst_case', case
      when planned_budget is null or company_max <= 0 then null
      else pg_catalog.floor(planned_budget / company_max)::bigint
    end,
    'budget_status', case
      when planned_budget is null then 'not_defined'
      when planned_budget >= pg_catalog.count(*) * company_max then 'within'
      else 'exceeds'
    end,
    'by_advisor', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'advisor_id', advisor_totals.advisor_id,
          'advisor_name', advisor_totals.advisor_name,
          'count', advisor_totals.member_count
        ) order by advisor_totals.member_count desc, advisor_totals.advisor_name
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

  update public.crm_plays set selection_summary = preview_summary where id = p_play_id;
  return preview_summary;
end;
$$;

revoke all on function public.crm_refresh_play_preview_summary_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_refresh_play_preview_summary_v1(bigint)
  to authenticated, service_role;

create or replace function app_private.crm_play_member_event_immutable_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and coalesce(pg_catalog.current_setting('app.crm_draft_delete', true), '') = '1'
    and (coalesce(auth.jwt() ->> 'role', '') = 'service_role' or public.is_master_or_admin())
    and exists (
      select 1
      from public.crm_play_members member_row
      join public.crm_plays play on play.id = member_row.play_id
      where member_row.id = old.play_member_id
        and play.status = 'draft'
    )
  then
    return old;
  end if;

  raise exception 'CRM play follow-up events are immutable';
end;
$$;

revoke all on function app_private.crm_play_member_event_immutable_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_member_event_immutable_v1()
  to service_role;

create or replace function public.crm_delete_draft_play_v1(p_play_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  deleted_name text;
begin
  if caller_id is null or not public.is_master_or_admin() then
    raise exception 'Master or admin access is required to delete a CRM play draft'
      using errcode = '42501';
  end if;

  select play.name into deleted_name
  from public.crm_plays play
  where play.id = p_play_id and play.status = 'draft'
  for update;

  if deleted_name is null then
    raise exception 'Only an existing draft CRM play can be deleted'
      using errcode = '55000';
  end if;

  perform pg_catalog.set_config('app.crm_draft_delete', '1', true);

  delete from public.crm_play_member_events event_row
  using public.crm_play_members member_row
  where event_row.play_member_id = member_row.id
    and member_row.play_id = p_play_id;

  delete from public.crm_play_members where play_id = p_play_id;
  delete from public.crm_play_benefits where play_id = p_play_id;
  delete from public.crm_plays where id = p_play_id and status = 'draft';

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'name', deleted_name,
    'deleted', true
  );
end;
$$;

revoke all on function public.crm_delete_draft_play_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_delete_draft_play_v1(bigint)
  to authenticated, service_role;

comment on column public.crm_plays.benefit_selection_mode is
  'Whether one benefit or one-or-more benefits may be selected for each play member.';
comment on column public.crm_plays.purchase_requirement_mode is
  'Whether redeeming the play benefit requires a qualifying current order.';
comment on column public.crm_plays.minimum_order_amount_usd is
  'Minimum current-order commercial subtotal in USD when the play is purchase-conditioned.';
comment on column public.crm_play_benefits.unit_benefit_value_usd is
  'Play-specific internal value per unit, frozen independently of the product catalog.';
comment on column public.crm_play_benefits.unit_advisor_cost_usd is
  'Play-specific advisor commission charge per unit.';
comment on column public.crm_play_benefits.unit_company_cost_usd is
  'Play-specific company contribution per unit and the amount used for campaign budgeting.';
comment on table public.crm_play_member_benefit_selections is
  'Normalized benefit choices; supports one selection or a combination according to the frozen play mode.';
