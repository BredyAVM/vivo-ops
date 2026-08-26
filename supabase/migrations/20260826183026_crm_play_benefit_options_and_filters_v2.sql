-- Multiple alternative benefits per CRM play plus clearer eligibility filters.
-- A play may expose up to eight alternatives, while each member stores at most
-- one selected option. Existing single-benefit fields remain as a compatibility
-- anchor for the rest of the ordering system.

create table public.crm_play_benefits (
  id bigint generated always as identity primary key,
  play_id bigint not null references public.crm_plays(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete restrict,
  quantity numeric(12,3) not null default 1,
  sort_order smallint not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint crm_play_benefits_quantity_check check (quantity > 0),
  constraint crm_play_benefits_sort_order_check check (sort_order between 1 and 8),
  constraint crm_play_benefits_play_product_unique unique (play_id, product_id),
  constraint crm_play_benefits_play_sort_unique unique (play_id, sort_order)
);

insert into public.crm_play_benefits (play_id, product_id, quantity, sort_order)
select play.id, play.gift_product_id, play.gift_quantity, 1
from public.crm_plays play
on conflict (play_id, product_id) do nothing;

alter table public.crm_play_members
  add column selected_play_benefit_id bigint
    references public.crm_play_benefits(id) on delete restrict,
  add column selected_benefit_at timestamptz,
  add column selected_benefit_by_user_id uuid
    references public.profiles(id) on delete restrict,
  add constraint crm_play_members_selected_benefit_state_check
    check (
      (
        selected_play_benefit_id is null
        and selected_benefit_at is null
        and selected_benefit_by_user_id is null
      )
      or (
        selected_play_benefit_id is not null
        and selected_benefit_at is not null
        and selected_benefit_by_user_id is not null
      )
    );

create index crm_play_benefits_play_id_idx
  on public.crm_play_benefits(play_id, sort_order, id);

create index crm_play_benefits_product_id_idx
  on public.crm_play_benefits(product_id, play_id);

create index crm_play_members_selected_benefit_id_idx
  on public.crm_play_members(selected_play_benefit_id)
  where selected_play_benefit_id is not null;

alter table public.crm_play_member_events
  drop constraint crm_play_member_events_type_check;

alter table public.crm_play_member_events
  add constraint crm_play_member_events_type_check
    check (
      event_type in (
        'contact',
        'follow_up',
        'responded',
        'accepted',
        'converted',
        'not_interested',
        'unreachable',
        'not_applicable',
        'closed',
        'note',
        'benefit_selected'
      )
    );

create or replace function app_private.crm_play_benefit_guard_v2()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  play_status text;
begin
  select play.status
    into play_status
  from public.crm_plays play
  where play.id = case when tg_op = 'DELETE' then old.play_id else new.play_id end;

  if play_status is null then
    raise exception 'CRM play does not exist';
  end if;

  if play_status <> 'draft' then
    raise exception 'CRM play benefit options are immutable after review begins';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app_private.crm_play_benefit_guard_v2()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_benefit_guard_v2()
  to service_role;

create trigger crm_play_benefits_guard
before insert or update or delete on public.crm_play_benefits
for each row execute function app_private.crm_play_benefit_guard_v2();

alter table public.crm_play_benefits enable row level security;

revoke all on table public.crm_play_benefits from public, anon, authenticated;
grant select, insert, update, delete on table public.crm_play_benefits to authenticated;
grant all on table public.crm_play_benefits to service_role;
grant usage, select on sequence public.crm_play_benefits_id_seq
  to authenticated, service_role;

create policy crm_play_benefits_select_staff
on public.crm_play_benefits
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or app_private.crm_play_is_visible_to_advisor_v1(play_id)
);

create policy crm_play_benefits_insert_master_admin
on public.crm_play_benefits
for insert
to authenticated
with check ((select public.is_master_or_admin()));

create policy crm_play_benefits_update_master_admin
on public.crm_play_benefits
for update
to authenticated
using ((select public.is_master_or_admin()))
with check ((select public.is_master_or_admin()));

create policy crm_play_benefits_delete_master_admin
on public.crm_play_benefits
for delete
to authenticated
using ((select public.is_master_or_admin()));

create or replace function public.crm_select_play_benefit_v1(
  p_play_member_id bigint,
  p_play_benefit_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  member_advisor_id uuid;
  member_play_id bigint;
  member_workflow_status text;
  member_benefit_status text;
  current_benefit_id bigint;
  play_status text;
  play_starts_at timestamptz;
  play_ends_at timestamptz;
  benefit_product_id bigint;
  benefit_product_name text;
  benefit_quantity numeric;
  selected_at timestamptz := pg_catalog.now();
  result jsonb;
begin
  if caller_id is null then
    raise exception 'Authentication is required to select a CRM benefit'
      using errcode = '42501';
  end if;

  if p_play_member_id is null or p_play_member_id <= 0
    or p_play_benefit_id is null or p_play_benefit_id <= 0
  then
    raise exception 'A valid CRM play member and benefit are required'
      using errcode = '22023';
  end if;

  select
    member_row.advisor_id_snapshot,
    member_row.play_id,
    member_row.workflow_status,
    member_row.benefit_status,
    member_row.selected_play_benefit_id,
    play.status,
    play.starts_at,
    play.ends_at
  into
    member_advisor_id,
    member_play_id,
    member_workflow_status,
    member_benefit_status,
    current_benefit_id,
    play_status,
    play_starts_at,
    play_ends_at
  from public.crm_play_members member_row
  join public.crm_plays play on play.id = member_row.play_id
  where member_row.id = p_play_member_id
  for update of member_row;

  if member_play_id is null then
    raise exception 'CRM play member does not exist'
      using errcode = 'P0002';
  end if;

  if not (member_advisor_id = caller_id or public.is_master_or_admin()) then
    raise exception 'This CRM benefit belongs to another advisor'
      using errcode = '42501';
  end if;

  if play_status <> 'active'
    or (play_starts_at is not null and selected_at < play_starts_at)
    or (play_ends_at is not null and selected_at >= play_ends_at)
  then
    raise exception 'The CRM play is not active for benefit selection'
      using errcode = '55000';
  end if;

  if member_workflow_status = 'removed'
    or member_benefit_status not in ('available', 'reserved')
  then
    raise exception 'This CRM play member cannot select a benefit'
      using errcode = '55000';
  end if;

  select option_row.product_id, product.name, option_row.quantity
    into benefit_product_id, benefit_product_name, benefit_quantity
  from public.crm_play_benefits option_row
  join public.products product on product.id = option_row.product_id
  where option_row.id = p_play_benefit_id
    and option_row.play_id = member_play_id;

  if benefit_product_id is null then
    raise exception 'The selected benefit is not available in this CRM play'
      using errcode = '22023';
  end if;

  if current_benefit_id is distinct from p_play_benefit_id then
    update public.crm_play_members member_row
    set
      selected_play_benefit_id = p_play_benefit_id,
      selected_benefit_at = selected_at,
      selected_benefit_by_user_id = caller_id
    where member_row.id = p_play_member_id;

    insert into public.crm_play_member_events (
      play_member_id,
      event_type,
      from_status,
      to_status,
      channel,
      note,
      follow_up_at,
      actor_user_id,
      created_at
    ) values (
      p_play_member_id,
      'benefit_selected',
      member_workflow_status,
      member_workflow_status,
      null,
      pg_catalog.concat(
        'Beneficio seleccionado: ',
        benefit_product_name,
        ' × ',
        benefit_quantity
      ),
      null,
      caller_id,
      selected_at
    );
  end if;

  select pg_catalog.jsonb_build_object(
    'play_member_id', member_row.id,
    'play_id', member_row.play_id,
    'client_id', member_row.client_id,
    'selected_play_benefit_id', member_row.selected_play_benefit_id,
    'selected_benefit_at', member_row.selected_benefit_at,
    'product_id', benefit_product_id,
    'product_name', benefit_product_name,
    'quantity', benefit_quantity
  )
  into result
  from public.crm_play_members member_row
  where member_row.id = p_play_member_id;

  return result;
end;
$$;

revoke all on function public.crm_select_play_benefit_v1(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.crm_select_play_benefit_v1(bigint, bigint)
  to authenticated, service_role;

create or replace function app_private.crm_play_redemption_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  play_status text;
  legacy_product_id bigint;
  legacy_quantity numeric;
  play_starts_at timestamptz;
  play_ends_at timestamptz;
  member_client_id bigint;
  member_benefit_status text;
  selected_benefit_id bigint;
  option_count integer;
  allowed_benefit_id bigint;
  allowed_product_id bigint;
  allowed_quantity numeric;
  order_client_id bigint;
  redemption_time timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'CRM play redemptions cannot be deleted; void them instead';
  end if;

  if tg_op = 'UPDATE' then
    if new.play_member_id is distinct from old.play_member_id
      or new.order_id is distinct from old.order_id
      or new.order_item_id is distinct from old.order_item_id
      or new.product_id is distinct from old.product_id
      or new.quantity is distinct from old.quantity
      or new.redeemed_by_user_id is distinct from old.redeemed_by_user_id
      or new.redeemed_at is distinct from old.redeemed_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'A CRM play redemption identity is immutable';
    end if;

    if old.status <> 'redeemed' or new.status <> 'voided' then
      raise exception 'The only allowed redemption transition is redeemed -> voided';
    end if;

    return new;
  end if;

  select
    play.status,
    play.gift_product_id,
    play.gift_quantity,
    play.starts_at,
    play.ends_at,
    member_row.client_id,
    member_row.benefit_status,
    member_row.selected_play_benefit_id
  into
    play_status,
    legacy_product_id,
    legacy_quantity,
    play_starts_at,
    play_ends_at,
    member_client_id,
    member_benefit_status,
    selected_benefit_id
  from public.crm_play_members member_row
  join public.crm_plays play on play.id = member_row.play_id
  where member_row.id = new.play_member_id;

  if play_status is null then
    raise exception 'CRM play membership does not exist';
  end if;

  redemption_time := coalesce(new.redeemed_at, pg_catalog.now());

  if play_status <> 'active'
    or (play_starts_at is not null and redemption_time < play_starts_at)
    or (play_ends_at is not null and redemption_time >= play_ends_at)
  then
    raise exception 'The CRM play is not active for this redemption';
  end if;

  if member_benefit_status not in ('available', 'reserved') then
    raise exception 'The CRM play member benefit is not redeemable';
  end if;

  select count(*)::integer
    into option_count
  from public.crm_play_benefits option_row
  join public.crm_play_members member_row on member_row.play_id = option_row.play_id
  where member_row.id = new.play_member_id;

  if selected_benefit_id is not null then
    select option_row.id, option_row.product_id, option_row.quantity
      into allowed_benefit_id, allowed_product_id, allowed_quantity
    from public.crm_play_benefits option_row
    join public.crm_play_members member_row on member_row.play_id = option_row.play_id
    where member_row.id = new.play_member_id
      and option_row.id = selected_benefit_id;

    if allowed_benefit_id is null then
      raise exception 'The selected CRM play benefit is not valid for this member';
    end if;
  elsif option_count = 1 then
    select option_row.id, option_row.product_id, option_row.quantity
      into allowed_benefit_id, allowed_product_id, allowed_quantity
    from public.crm_play_benefits option_row
    join public.crm_play_members member_row on member_row.play_id = option_row.play_id
    where member_row.id = new.play_member_id;
  elsif option_count > 1 then
    raise exception 'Select one CRM play benefit before redemption';
  else
    allowed_product_id := legacy_product_id;
    allowed_quantity := legacy_quantity;
  end if;

  if new.product_id is distinct from allowed_product_id
    or new.quantity > allowed_quantity
  then
    raise exception 'The redemption does not match the selected CRM play benefit';
  end if;

  if selected_benefit_id is null and allowed_benefit_id is not null then
    update public.crm_play_members member_row
    set
      selected_play_benefit_id = allowed_benefit_id,
      selected_benefit_at = redemption_time,
      selected_benefit_by_user_id = new.redeemed_by_user_id
    where member_row.id = new.play_member_id;
  end if;

  select order_row.client_id
    into order_client_id
  from public.orders order_row
  where order_row.id = new.order_id;

  if order_client_id is distinct from member_client_id then
    raise exception 'The order client does not match the CRM play member';
  end if;

  if new.order_item_id is not null and not exists (
    select 1
    from public.order_items order_item
    where order_item.id = new.order_item_id
      and order_item.order_id = new.order_id
      and order_item.product_id = new.product_id
  ) then
    raise exception 'The redemption order item does not match the benefit';
  end if;

  return new;
end;
$$;

revoke all on function app_private.crm_play_redemption_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_redemption_guard_v1()
  to service_role;

create or replace function public.crm_rebuild_play_members_v1(p_play_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  play_row public.crm_plays%rowtype;
  generated_at timestamptz := pg_catalog.now();
  rules jsonb;
  excluded_ids jsonb;
  minimum_purchases integer;
  maximum_purchases integer;
  minimum_revenue numeric;
  minimum_days integer;
  maximum_days integer;
  first_from date;
  first_to date;
  last_from date;
  last_to date;
  anniversary_month integer;
  anniversary_mode text;
  last_gift_from date;
  last_gift_to date;
  include_never_gifted boolean;
  fulfillment_filter text;
  v_selection_summary jsonb;
begin
  if caller_id is null or not public.is_master_or_admin() then
    raise exception 'Master or admin access is required to generate a CRM play list'
      using errcode = '42501';
  end if;

  if p_play_id is null or p_play_id <= 0 then
    raise exception 'A valid CRM play is required'
      using errcode = '22023';
  end if;

  select play.*
    into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist'
      using errcode = 'P0002';
  end if;

  if play_row.status <> 'draft' then
    raise exception 'Only a draft CRM play can rebuild its client list'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.crm_play_benefits option_row
    where option_row.play_id = p_play_id
  ) then
    raise exception 'At least one benefit option is required before generating the list'
      using errcode = '22023';
  end if;

  rules := coalesce(play_row.rules_snapshot, '{}'::jsonb);
  excluded_ids := case
    when pg_catalog.jsonb_typeof(rules -> 'excluded_client_ids') = 'array'
      then rules -> 'excluded_client_ids'
    else '[]'::jsonb
  end;
  minimum_purchases := greatest(0, coalesce((rules ->> 'min_purchase_count')::integer, 0));
  maximum_purchases := nullif(rules ->> 'max_purchase_count', '')::integer;
  minimum_revenue := greatest(0, coalesce((rules ->> 'min_net_revenue_usd')::numeric, 0));
  minimum_days := nullif(rules ->> 'min_days_since_purchase', '')::integer;
  maximum_days := nullif(rules ->> 'max_days_since_purchase', '')::integer;
  first_from := nullif(rules ->> 'first_purchase_from', '')::date;
  first_to := nullif(rules ->> 'first_purchase_to', '')::date;
  last_from := nullif(rules ->> 'last_purchase_from', '')::date;
  last_to := nullif(rules ->> 'last_purchase_to', '')::date;
  anniversary_month := nullif(rules ->> 'anniversary_month', '')::integer;
  anniversary_mode := coalesce(
    nullif(rules ->> 'anniversary_mode', ''),
    case when anniversary_month is null then 'any' else 'include' end
  );
  last_gift_from := nullif(rules ->> 'last_gift_from', '')::date;
  last_gift_to := nullif(rules ->> 'last_gift_to', '')::date;
  include_never_gifted := coalesce((rules ->> 'include_never_gifted')::boolean, true);
  fulfillment_filter := coalesce(nullif(rules ->> 'fulfillment', ''), 'any');

  if maximum_purchases is not null and maximum_purchases < minimum_purchases then
    raise exception 'Maximum purchases cannot be below minimum purchases'
      using errcode = '22023';
  end if;

  if maximum_days is not null and minimum_days is not null and maximum_days < minimum_days then
    raise exception 'Maximum inactive days cannot be below minimum inactive days'
      using errcode = '22023';
  end if;

  if first_from is not null and first_to is not null and first_to < first_from then
    raise exception 'First purchase date range is invalid'
      using errcode = '22023';
  end if;

  if last_from is not null and last_to is not null and last_to < last_from then
    raise exception 'Last purchase date range is invalid'
      using errcode = '22023';
  end if;

  if last_gift_from is not null and last_gift_to is not null and last_gift_to < last_gift_from then
    raise exception 'Last gift date range is invalid'
      using errcode = '22023';
  end if;

  if anniversary_month is not null and anniversary_month not between 1 and 12 then
    raise exception 'Anniversary month must be between 1 and 12'
      using errcode = '22023';
  end if;

  if anniversary_mode not in ('any', 'include', 'exclude') then
    raise exception 'Unsupported anniversary filter mode'
      using errcode = '22023';
  end if;

  if anniversary_mode <> 'any' and anniversary_month is null then
    raise exception 'An anniversary month is required for this filter'
      using errcode = '22023';
  end if;

  if fulfillment_filter not in ('any', 'pickup', 'delivery') then
    raise exception 'Unsupported fulfillment filter'
      using errcode = '22023';
  end if;

  delete from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  insert into public.crm_play_members (
    play_id,
    client_id,
    advisor_id_snapshot,
    eligible_at,
    first_purchase_on,
    last_purchase_on,
    purchase_count,
    net_revenue_usd,
    average_ticket_usd,
    cadence_days,
    cadence_window,
    last_advisor_id,
    last_advisor_name_snapshot,
    last_gift_on,
    days_since_last_purchase,
    used_pickup,
    used_delivery,
    decision_snapshot,
    eligibility_reasons
  )
  select
    p_play_id,
    metric.client_id,
    client_row.primary_advisor_id,
    generated_at,
    metric.first_purchase_on,
    metric.last_purchase_on,
    metric.purchase_count::integer,
    metric.net_revenue_usd,
    metric.average_ticket_usd,
    metric.cadence_days,
    metric.cadence_window_used,
    metric.last_advisor_id,
    metric.last_advisor_name_snapshot,
    metric.last_gift_on,
    metric.days_since_last_purchase,
    coalesce(metric.used_pickup, false),
    coalesce(metric.used_delivery, false),
    pg_catalog.jsonb_build_object(
      'rules', rules - 'excluded_client_ids',
      'generated_at', generated_at,
      'primary_advisor_id', client_row.primary_advisor_id
    ),
    array['Cumple los filtros de la jugada al momento del corte']::text[]
  from public.crm_client_metrics_v1(play_row.metric_window, generated_at) metric
  join public.clients client_row on client_row.id = metric.client_id
  join public.profiles advisor_profile on advisor_profile.id = client_row.primary_advisor_id
  where client_row.is_active
    and advisor_profile.is_active
    and exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = client_row.primary_advisor_id
        and role_row.role = 'advisor'
    )
    and metric.purchase_count >= minimum_purchases
    and (maximum_purchases is null or metric.purchase_count <= maximum_purchases)
    and metric.net_revenue_usd >= minimum_revenue
    and (minimum_days is null or metric.days_since_last_purchase >= minimum_days)
    and (maximum_days is null or metric.days_since_last_purchase <= maximum_days)
    and (first_from is null or metric.first_purchase_on >= first_from)
    and (first_to is null or metric.first_purchase_on <= first_to)
    and (last_from is null or metric.last_purchase_on >= last_from)
    and (last_to is null or metric.last_purchase_on <= last_to)
    and (
      anniversary_mode = 'any'
      or (
        anniversary_mode = 'include'
        and extract(month from metric.first_purchase_on)::integer = anniversary_month
      )
      or (
        anniversary_mode = 'exclude'
        and extract(month from metric.first_purchase_on)::integer <> anniversary_month
      )
    )
    and (
      (
        metric.last_gift_on is null
        and include_never_gifted
      )
      or (
        metric.last_gift_on is not null
        and (last_gift_from is null or metric.last_gift_on >= last_gift_from)
        and (last_gift_to is null or metric.last_gift_on <= last_gift_to)
      )
    )
    and (
      fulfillment_filter = 'any'
      or (fulfillment_filter = 'pickup' and metric.used_pickup)
      or (fulfillment_filter = 'delivery' and metric.used_delivery)
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(excluded_ids) excluded(value)
      where excluded.value ~ '^[0-9]+$'
        and excluded.value::bigint = metric.client_id
    );

  select pg_catalog.jsonb_build_object(
    'total', count(*)::integer,
    'advisor_count', count(distinct member_row.advisor_id_snapshot)::integer,
    'generated_at', generated_at,
    'excluded_count', pg_catalog.jsonb_array_length(excluded_ids),
    'gifted_client_count', count(*) filter (where member_row.last_gift_on is not null),
    'benefit_count', (
      select count(*)::integer
      from public.crm_play_benefits option_row
      where option_row.play_id = p_play_id
    ),
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
          count(*)::integer as member_count
        from public.crm_play_members grouped
        left join public.profiles advisor on advisor.id = grouped.advisor_id_snapshot
        where grouped.play_id = p_play_id
        group by grouped.advisor_id_snapshot, advisor.full_name
      ) advisor_totals
    ), '[]'::jsonb)
  )
  into v_selection_summary
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  update public.crm_plays play
  set selection_summary = v_selection_summary
  where play.id = p_play_id;

  return v_selection_summary;
end;
$$;

revoke all on function public.crm_rebuild_play_members_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_rebuild_play_members_v1(bigint)
  to authenticated, service_role;

comment on table public.crm_play_benefits is
  'Frozen alternatives that a client may receive in a CRM play; one member can select at most one option.';

comment on function public.crm_select_play_benefit_v1(bigint, bigint) is
  'Records the single benefit option selected for one active CRM play member and appends an immutable audit event.';
