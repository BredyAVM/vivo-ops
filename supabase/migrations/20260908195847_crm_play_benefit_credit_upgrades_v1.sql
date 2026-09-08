-- CRM play benefits behave as a USD credit that can be used on the base
-- product or on one explicitly allowed upgrade. The order always contains
-- one final product line, preventing duplicate inventory deductions.

create table public.crm_play_benefit_upgrades (
  id bigint generated always as identity primary key,
  play_benefit_id bigint not null,
  play_id bigint not null references public.crm_plays(id) on delete cascade,
  target_product_id bigint not null references public.products(id) on delete restrict,
  target_quantity numeric(12,3) not null default 1,
  sort_order smallint not null,
  target_product_name_snapshot text,
  target_source_price_currency_snapshot public.currency_code,
  target_source_price_amount_snapshot numeric(18,6),
  target_catalog_price_usd_snapshot numeric(18,6),
  customer_difference_usd_snapshot numeric(18,6),
  created_at timestamptz not null default pg_catalog.now(),
  constraint crm_play_benefit_upgrades_benefit_fkey
    foreign key (play_benefit_id, play_id)
    references public.crm_play_benefits(id, play_id) on delete cascade,
  constraint crm_play_benefit_upgrades_quantity_check check (target_quantity > 0),
  constraint crm_play_benefit_upgrades_sort_order_check check (sort_order between 1 and 8),
  constraint crm_play_benefit_upgrades_target_unique unique (play_benefit_id, target_product_id),
  constraint crm_play_benefit_upgrades_sort_unique unique (play_benefit_id, sort_order),
  constraint crm_play_benefit_upgrades_not_base_check check (target_product_id > 0),
  constraint crm_play_benefit_upgrades_snapshot_nonnegative_check check (
    target_source_price_amount_snapshot is null or target_source_price_amount_snapshot >= 0
  ),
  constraint crm_play_benefit_upgrades_catalog_nonnegative_check check (
    target_catalog_price_usd_snapshot is null or target_catalog_price_usd_snapshot >= 0
  ),
  constraint crm_play_benefit_upgrades_difference_nonnegative_check check (
    customer_difference_usd_snapshot is null or customer_difference_usd_snapshot >= 0
  )
);

create index crm_play_benefit_upgrades_play_id_idx
  on public.crm_play_benefit_upgrades(play_id, play_benefit_id, sort_order);

create index crm_play_benefit_upgrades_benefit_play_idx
  on public.crm_play_benefit_upgrades(play_benefit_id, play_id);

create index crm_play_benefit_upgrades_target_product_id_idx
  on public.crm_play_benefit_upgrades(target_product_id, play_id);

alter table public.crm_play_benefit_upgrades enable row level security;

revoke all on table public.crm_play_benefit_upgrades from public, anon, authenticated;
grant select, insert, update, delete on table public.crm_play_benefit_upgrades to authenticated;
grant all on table public.crm_play_benefit_upgrades to service_role;
grant usage, select on sequence public.crm_play_benefit_upgrades_id_seq
  to authenticated, service_role;

create policy crm_play_benefit_upgrades_select_staff
on public.crm_play_benefit_upgrades
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or app_private.crm_play_is_visible_to_advisor_v1(play_id)
);

create policy crm_play_benefit_upgrades_insert_master_admin
on public.crm_play_benefit_upgrades
for insert
to authenticated
with check ((select public.is_master_or_admin()));

create policy crm_play_benefit_upgrades_update_master_admin
on public.crm_play_benefit_upgrades
for update
to authenticated
using ((select public.is_master_or_admin()))
with check ((select public.is_master_or_admin()));

create policy crm_play_benefit_upgrades_delete_master_admin
on public.crm_play_benefit_upgrades
for delete
to authenticated
using ((select public.is_master_or_admin()));

create or replace function app_private.crm_play_benefit_upgrade_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  play_status text;
  base_product_id bigint;
begin
  select play.status into play_status
  from public.crm_plays play
  where play.id = case when tg_op = 'DELETE' then old.play_id else new.play_id end;

  if play_status is null then
    raise exception 'CRM play does not exist';
  end if;
  if play_status <> 'draft' then
    raise exception 'CRM play benefit upgrades are immutable after review begins';
  end if;

  if tg_op <> 'DELETE' then
    select benefit.product_id into base_product_id
    from public.crm_play_benefits benefit
    where benefit.id = new.play_benefit_id
      and benefit.play_id = new.play_id;

    if base_product_id is null then
      raise exception 'CRM play benefit does not exist';
    end if;
    if base_product_id = new.target_product_id then
      raise exception 'The upgrade product must differ from the base benefit';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app_private.crm_play_benefit_upgrade_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_benefit_upgrade_guard_v1()
  to service_role;

create trigger crm_play_benefit_upgrades_guard
before insert or update or delete on public.crm_play_benefit_upgrades
for each row execute function app_private.crm_play_benefit_upgrade_guard_v1();

alter table public.crm_play_redemptions
  add column play_benefit_upgrade_id bigint
    references public.crm_play_benefit_upgrades(id) on delete restrict,
  add column benefit_credit_usd numeric(14,2) not null default 0,
  add column customer_paid_difference_usd numeric(14,2) not null default 0,
  add constraint crm_play_redemptions_credit_nonnegative_check
    check (benefit_credit_usd >= 0 and customer_paid_difference_usd >= 0);

update public.crm_play_redemptions
set benefit_credit_usd = benefit_value_usd
where benefit_credit_usd = 0 and benefit_value_usd > 0;

create index crm_play_redemptions_upgrade_id_idx
  on public.crm_play_redemptions(play_benefit_upgrade_id)
  where play_benefit_upgrade_id is not null;

create or replace function public.crm_confirm_play_v1(p_play_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_row public.crm_plays%rowtype;
  member_count integer;
  benefit_count integer;
  upgrade_count integer;
  conflict_count integer;
  active_rate numeric;
  confirmed_at timestamptz := pg_catalog.now();
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to confirm a CRM play'
      using errcode = '42501';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status <> 'draft' then
    raise exception 'Only a play in design can be confirmed' using errcode = '55000';
  end if;

  select count(*)::integer into member_count
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  select count(*)::integer into benefit_count
  from public.crm_play_benefits benefit
  where benefit.play_id = p_play_id;

  select count(*)::integer into upgrade_count
  from public.crm_play_benefit_upgrades upgrade
  where upgrade.play_id = p_play_id;

  if member_count = 0 then
    raise exception 'Generate and review a client list before confirming the play';
  end if;
  if benefit_count = 0 then
    raise exception 'At least one benefit is required before confirming the play';
  end if;

  select count(*)::integer into conflict_count
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id
    and app_private.crm_play_has_overlap_conflict_v1(p_play_id, member_row.client_id);

  if conflict_count > 0 then
    raise exception '% clients now conflict with another confirmed play. Run the preview again.', conflict_count
      using errcode = '40001';
  end if;

  active_rate := public.get_active_exchange_rate();
  if active_rate is null or active_rate <= 0 then
    raise exception 'An active exchange rate is required to freeze this play';
  end if;

  update public.crm_play_benefits benefit
  set
    product_name_snapshot = product.name,
    source_price_currency_snapshot = product.source_price_currency,
    source_price_amount_snapshot = product.source_price_amount,
    catalog_price_usd_snapshot = case
      when product.source_price_currency = 'VES'
        then pg_catalog.round(coalesce(product.source_price_amount, 0) / active_rate, 6)
      else pg_catalog.round(coalesce(product.source_price_amount, product.base_price_usd, 0), 6)
    end
  from public.products product
  where benefit.play_id = p_play_id
    and product.id = benefit.product_id;

  update public.crm_play_benefit_upgrades upgrade
  set
    target_product_name_snapshot = product.name,
    target_source_price_currency_snapshot = product.source_price_currency,
    target_source_price_amount_snapshot = product.source_price_amount,
    target_catalog_price_usd_snapshot = case
      when product.source_price_currency = 'VES'
        then pg_catalog.round(coalesce(product.source_price_amount, 0) / active_rate, 6)
      else pg_catalog.round(coalesce(product.source_price_amount, product.base_price_usd, 0), 6)
    end,
    customer_difference_usd_snapshot = pg_catalog.round(greatest(
      (
        case
          when product.source_price_currency = 'VES'
            then coalesce(product.source_price_amount, 0) / active_rate
          else coalesce(product.source_price_amount, product.base_price_usd, 0)
        end
      ) * upgrade.target_quantity
      - benefit.unit_benefit_value_usd * benefit.quantity,
      0
    ), 6)
  from public.products product, public.crm_play_benefits benefit
  where upgrade.play_id = p_play_id
    and product.id = upgrade.target_product_id
    and benefit.id = upgrade.play_benefit_id
    and benefit.play_id = upgrade.play_id;

  if exists (
    select 1
    from public.crm_play_benefit_upgrades upgrade
    where upgrade.play_id = p_play_id
      and upgrade.customer_difference_usd_snapshot is null
  ) then
    raise exception 'One of the allowed upgrades could not be priced';
  end if;

  update public.crm_plays play
  set
    status = 'frozen',
    snapshot_at = confirmed_at,
    pricing_exchange_rate_ves_per_usd = active_rate,
    pricing_snapshot_at = confirmed_at
  where play.id = p_play_id;

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'member_count', member_count,
    'benefit_count', benefit_count,
    'upgrade_count', upgrade_count,
    'snapshot_at', confirmed_at,
    'exchange_rate_ves_per_usd', active_rate
  );
end;
$$;

create or replace function public.crm_clone_play_v2(
  p_source_play_id bigint,
  p_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clone_result jsonb;
  cloned_play_id bigint;
begin
  clone_result := public.crm_clone_play_v1(p_source_play_id, p_name);
  cloned_play_id := (clone_result ->> 'play_id')::bigint;

  insert into public.crm_play_benefit_upgrades (
    play_benefit_id,
    play_id,
    target_product_id,
    target_quantity,
    sort_order
  )
  select
    cloned_benefit.id,
    cloned_play_id,
    source_upgrade.target_product_id,
    source_upgrade.target_quantity,
    source_upgrade.sort_order
  from public.crm_play_benefit_upgrades source_upgrade
  join public.crm_play_benefits source_benefit
    on source_benefit.id = source_upgrade.play_benefit_id
   and source_benefit.play_id = p_source_play_id
  join public.crm_play_benefits cloned_benefit
    on cloned_benefit.play_id = cloned_play_id
   and cloned_benefit.product_id = source_benefit.product_id
  order by cloned_benefit.sort_order, source_upgrade.sort_order;

  return clone_result || pg_catalog.jsonb_build_object(
    'upgrade_count', (
      select count(*)
      from public.crm_play_benefit_upgrades upgrade
      where upgrade.play_id = cloned_play_id
    )
  );
end;
$$;

revoke all on function public.crm_clone_play_v2(bigint, text)
  from public, anon, authenticated;
grant execute on function public.crm_clone_play_v2(bigint, text)
  to authenticated, service_role;

create or replace function app_private.crm_play_redemption_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  member_row record;
  option_row record;
  upgrade_row record;
  order_row record;
  redemption_time timestamptz;
  commercial_subtotal numeric;
  order_discount_pct numeric;
  expected_product_id bigint;
  expected_quantity numeric;
  expected_line_total numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'CRM play redemptions cannot be deleted; void them instead';
  end if;

  if tg_op = 'UPDATE' then
    if new.play_member_id is distinct from old.play_member_id
      or new.play_benefit_id is distinct from old.play_benefit_id
      or new.play_benefit_upgrade_id is distinct from old.play_benefit_upgrade_id
      or new.order_id is distinct from old.order_id
      or new.order_item_id is distinct from old.order_item_id
      or new.product_id is distinct from old.product_id
      or new.quantity is distinct from old.quantity
      or new.play_name_snapshot is distinct from old.play_name_snapshot
      or new.unit_benefit_value_usd is distinct from old.unit_benefit_value_usd
      or new.unit_advisor_cost_usd is distinct from old.unit_advisor_cost_usd
      or new.unit_company_cost_usd is distinct from old.unit_company_cost_usd
      or new.benefit_value_usd is distinct from old.benefit_value_usd
      or new.benefit_credit_usd is distinct from old.benefit_credit_usd
      or new.customer_paid_difference_usd is distinct from old.customer_paid_difference_usd
      or new.advisor_charge_usd is distinct from old.advisor_charge_usd
      or new.company_cost_usd is distinct from old.company_cost_usd
      or new.redeemed_by_user_id is distinct from old.redeemed_by_user_id
      or new.redeemed_at is distinct from old.redeemed_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'A CRM play redemption identity and economics are immutable';
    end if;

    if old.status <> 'redeemed' or new.status <> 'voided' then
      raise exception 'The only allowed redemption transition is redeemed -> voided';
    end if;
    return new;
  end if;

  select
    member.id,
    member.client_id,
    member.play_id,
    member.advisor_id_snapshot,
    member.benefit_status,
    play.name as play_name,
    play.status as play_status,
    play.starts_at,
    play.ends_at,
    play.purchase_requirement_mode,
    play.minimum_order_amount_usd
  into member_row
  from public.crm_play_members member
  join public.crm_plays play on play.id = member.play_id
  where member.id = new.play_member_id;

  if member_row.id is null then
    raise exception 'CRM play membership does not exist';
  end if;

  redemption_time := coalesce(new.redeemed_at, pg_catalog.now());
  if member_row.play_status <> 'active'
    or (member_row.starts_at is not null and redemption_time < member_row.starts_at)
    or (member_row.ends_at is not null and redemption_time >= member_row.ends_at)
  then
    raise exception 'The CRM play is not active for this redemption';
  end if;

  if member_row.benefit_status not in ('available', 'reserved', 'redeemed') then
    raise exception 'The CRM play member benefit is not redeemable';
  end if;

  select
    option.id,
    option.product_id,
    option.quantity,
    option.unit_benefit_value_usd,
    option.unit_advisor_cost_usd,
    option.unit_company_cost_usd
  into option_row
  from public.crm_play_benefits option
  join public.crm_play_member_benefit_selections selection
    on selection.play_benefit_id = option.id
   and selection.play_member_id = new.play_member_id
  where option.play_id = member_row.play_id
    and option.id = new.play_benefit_id
  limit 1;

  if option_row.id is null then
    raise exception 'The redemption is not one of the benefits selected for this client';
  end if;

  expected_product_id := option_row.product_id;
  expected_quantity := option_row.quantity;
  expected_line_total := 0;

  if new.play_benefit_upgrade_id is not null then
    select
      upgrade.id,
      upgrade.target_product_id,
      upgrade.target_quantity,
      upgrade.customer_difference_usd_snapshot
    into upgrade_row
    from public.crm_play_benefit_upgrades upgrade
    where upgrade.id = new.play_benefit_upgrade_id
      and upgrade.play_benefit_id = option_row.id
      and upgrade.play_id = member_row.play_id;

    if upgrade_row.id is null then
      raise exception 'The selected upgrade is not allowed for this CRM benefit';
    end if;

    expected_product_id := upgrade_row.target_product_id;
    expected_quantity := upgrade_row.target_quantity;
    expected_line_total := upgrade_row.customer_difference_usd_snapshot;
  end if;

  if new.product_id is distinct from expected_product_id
    or pg_catalog.abs(new.quantity - expected_quantity) > 0.001 then
    raise exception 'The final product does not match the selected CRM benefit';
  end if;

  select
    order_data.id,
    order_data.client_id,
    order_data.attributed_advisor_id,
    order_data.extra_fields
  into order_row
  from public.orders order_data
  where order_data.id = new.order_id;

  if order_row.id is null or order_row.client_id is distinct from member_row.client_id then
    raise exception 'The order client does not match the CRM play member';
  end if;

  if new.order_item_id is null or not exists (
    select 1
    from public.order_items order_item
    where order_item.id = new.order_item_id
      and order_item.order_id = new.order_id
      and order_item.product_id = expected_product_id
      and pg_catalog.abs(order_item.qty - expected_quantity) <= 0.001
      and pg_catalog.abs(coalesce(order_item.line_total_usd, 0) - expected_line_total) <= 0.02
  ) then
    raise exception 'The order does not contain the exact final CRM benefit item';
  end if;

  order_discount_pct := greatest(0, least(100, coalesce(
    nullif(order_row.extra_fields #>> '{pricing,discount_pct}', '')::numeric,
    0
  )));

  select pg_catalog.round(
    coalesce(sum(coalesce(order_item.line_total_usd, 0)), 0)
      * (1 - order_discount_pct / 100),
    2
  )
  into commercial_subtotal
  from public.order_items order_item
  where order_item.order_id = new.order_id
    and not exists (
      select 1
      from public.crm_play_member_benefit_selections selected
      join public.crm_play_benefits selected_benefit
        on selected_benefit.id = selected.play_benefit_id
       and selected_benefit.play_id = selected.play_id
      left join public.crm_play_benefit_upgrades selected_upgrade
        on selected_upgrade.play_benefit_id = selected_benefit.id
       and selected_upgrade.play_id = selected_benefit.play_id
       and selected_upgrade.target_product_id = order_item.product_id
       and pg_catalog.abs(selected_upgrade.target_quantity - order_item.qty) <= 0.001
       and pg_catalog.abs(
         coalesce(selected_upgrade.customer_difference_usd_snapshot, 0)
         - coalesce(order_item.line_total_usd, 0)
       ) <= 0.02
      where selected.play_member_id = new.play_member_id
        and (
          (
            order_item.product_id = selected_benefit.product_id
            and pg_catalog.abs(order_item.qty - selected_benefit.quantity) <= 0.001
            and pg_catalog.abs(coalesce(order_item.line_total_usd, 0)) <= 0.02
          )
          or selected_upgrade.id is not null
        )
    );

  if member_row.purchase_requirement_mode = 'minimum_order'
    and commercial_subtotal + 0.005 < member_row.minimum_order_amount_usd
  then
    raise exception 'The commercial purchase does not reach the minimum required by this CRM play';
  end if;

  new.play_name_snapshot := member_row.play_name;
  new.unit_benefit_value_usd := option_row.unit_benefit_value_usd;
  new.unit_advisor_cost_usd := option_row.unit_advisor_cost_usd;
  new.unit_company_cost_usd := option_row.unit_company_cost_usd;
  new.benefit_value_usd := pg_catalog.round(option_row.unit_benefit_value_usd * option_row.quantity, 2);
  new.benefit_credit_usd := new.benefit_value_usd;
  new.customer_paid_difference_usd := pg_catalog.round(expected_line_total, 2);
  new.advisor_charge_usd := pg_catalog.round(option_row.unit_advisor_cost_usd * option_row.quantity, 2);
  new.company_cost_usd := pg_catalog.round(option_row.unit_company_cost_usd * option_row.quantity, 2);
  return new;
end;
$$;

revoke all on function app_private.crm_play_redemption_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_redemption_guard_v1() to service_role;

create or replace function public.crm_redeem_play_benefits_v3(
  p_play_member_id bigint,
  p_order_id bigint,
  p_fulfillments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  member_row record;
  order_row record;
  selected_count integer;
  requested_count integer;
  requested_distinct_count integer;
  fulfillment_row record;
  matching_order_item_id bigint;
  redeemed_count integer := 0;
  advisor_charge_total numeric := 0;
  company_cost_total numeric := 0;
  customer_difference_total numeric := 0;
begin
  if caller_id is null then
    raise exception 'Authentication is required to redeem CRM benefits' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_fulfillments) <> 'array' then
    raise exception 'CRM benefit fulfillments must be an array' using errcode = '22023';
  end if;

  select
    member.id,
    member.client_id,
    member.play_id,
    member.advisor_id_snapshot,
    member.workflow_status,
    member.benefit_status,
    play.status as play_status,
    play.benefit_selection_mode
  into member_row
  from public.crm_play_members member
  join public.crm_plays play on play.id = member.play_id
  where member.id = p_play_member_id
  for update of member;

  if member_row.id is null then
    raise exception 'CRM play member does not exist' using errcode = 'P0002';
  end if;
  if not (member_row.advisor_id_snapshot = caller_id or public.is_master_or_admin()) then
    raise exception 'This CRM play member belongs to another advisor' using errcode = '42501';
  end if;

  select id, client_id, attributed_advisor_id
  into order_row
  from public.orders
  where id = p_order_id;

  if order_row.id is null or order_row.client_id is distinct from member_row.client_id then
    raise exception 'The selected order does not belong to this CRM client' using errcode = '22023';
  end if;
  if not (order_row.attributed_advisor_id = caller_id or public.is_master_or_admin()) then
    raise exception 'The selected order belongs to another advisor' using errcode = '42501';
  end if;

  select count(*)::integer into selected_count
  from public.crm_play_member_benefit_selections selection
  where selection.play_member_id = p_play_member_id;

  select count(*)::integer, count(distinct (entry.value ->> 'play_benefit_id'))::integer
  into requested_count, requested_distinct_count
  from pg_catalog.jsonb_array_elements(p_fulfillments) entry(value);

  if selected_count = 0 or requested_count <> selected_count
    or requested_distinct_count <> requested_count then
    raise exception 'The order must resolve every selected CRM benefit exactly once' using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_fulfillments) entry(value)
    left join public.crm_play_member_benefit_selections selection
      on selection.play_member_id = p_play_member_id
     and selection.play_benefit_id = (entry.value ->> 'play_benefit_id')::bigint
    where selection.play_benefit_id is null
  ) then
    raise exception 'The order contains a benefit that was not selected for this client' using errcode = '22023';
  end if;

  for fulfillment_row in
    select
      option.id as play_benefit_id,
      option.product_id as base_product_id,
      option.quantity as base_quantity,
      option.unit_advisor_cost_usd,
      option.unit_company_cost_usd,
      case
        when nullif(entry.value ->> 'play_benefit_upgrade_id', '') is null then null
        else (entry.value ->> 'play_benefit_upgrade_id')::bigint
      end as play_benefit_upgrade_id,
      upgrade.target_product_id,
      upgrade.target_quantity,
      upgrade.customer_difference_usd_snapshot
    from pg_catalog.jsonb_array_elements(p_fulfillments) entry(value)
    join public.crm_play_benefits option
      on option.id = (entry.value ->> 'play_benefit_id')::bigint
     and option.play_id = member_row.play_id
    left join public.crm_play_benefit_upgrades upgrade
      on upgrade.id = case
        when nullif(entry.value ->> 'play_benefit_upgrade_id', '') is null then null
        else (entry.value ->> 'play_benefit_upgrade_id')::bigint
      end
     and upgrade.play_benefit_id = option.id
     and upgrade.play_id = option.play_id
    order by option.sort_order, option.id
  loop
    if fulfillment_row.play_benefit_upgrade_id is not null
      and fulfillment_row.target_product_id is null then
      raise exception 'One of the selected upgrades is not allowed for this benefit';
    end if;

    select item.id into matching_order_item_id
    from public.order_items item
    where item.order_id = p_order_id
      and item.product_id = coalesce(fulfillment_row.target_product_id, fulfillment_row.base_product_id)
      and pg_catalog.abs(item.qty - coalesce(fulfillment_row.target_quantity, fulfillment_row.base_quantity)) <= 0.001
      and pg_catalog.abs(
        coalesce(item.line_total_usd, 0)
        - coalesce(fulfillment_row.customer_difference_usd_snapshot, 0)
      ) <= 0.02
      and not exists (
        select 1
        from public.crm_play_redemptions used_redemption
        where used_redemption.order_item_id = item.id
          and used_redemption.status = 'redeemed'
      )
    order by item.id
    limit 1;

    if matching_order_item_id is null then
      raise exception 'The order is missing one exact final item for the CRM benefit';
    end if;

    if not exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = p_play_member_id
        and redemption.play_benefit_id = fulfillment_row.play_benefit_id
        and redemption.status = 'redeemed'
    ) then
      insert into public.crm_play_redemptions (
        play_member_id,
        play_benefit_id,
        play_benefit_upgrade_id,
        order_id,
        order_item_id,
        product_id,
        quantity,
        redeemed_by_user_id,
        redeemed_at
      ) values (
        p_play_member_id,
        fulfillment_row.play_benefit_id,
        fulfillment_row.play_benefit_upgrade_id,
        p_order_id,
        matching_order_item_id,
        coalesce(fulfillment_row.target_product_id, fulfillment_row.base_product_id),
        coalesce(fulfillment_row.target_quantity, fulfillment_row.base_quantity),
        caller_id,
        pg_catalog.now()
      );
      redeemed_count := redeemed_count + 1;
      advisor_charge_total := advisor_charge_total
        + fulfillment_row.unit_advisor_cost_usd * fulfillment_row.base_quantity;
      company_cost_total := company_cost_total
        + fulfillment_row.unit_company_cost_usd * fulfillment_row.base_quantity;
      customer_difference_total := customer_difference_total
        + coalesce(fulfillment_row.customer_difference_usd_snapshot, 0);
    end if;
  end loop;

  update public.crm_play_members
  set benefit_status = 'redeemed'
  where id = p_play_member_id;

  if redeemed_count > 0 then
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
      'benefit_redeemed',
      member_row.workflow_status,
      member_row.workflow_status,
      pg_catalog.concat('Beneficios aplicados en la orden ', p_order_id),
      caller_id,
      pg_catalog.now()
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'play_member_id', p_play_member_id,
    'order_id', p_order_id,
    'redeemed_count', redeemed_count,
    'advisor_charge_usd', pg_catalog.round(advisor_charge_total, 2),
    'company_cost_usd', pg_catalog.round(company_cost_total, 2),
    'customer_paid_difference_usd', pg_catalog.round(customer_difference_total, 2)
  );
end;
$$;

revoke all on function public.crm_redeem_play_benefits_v3(bigint, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.crm_redeem_play_benefits_v3(bigint, bigint, jsonb)
  to authenticated, service_role;

comment on table public.crm_play_benefit_upgrades is
  'Allowed final products that can consume a play benefit credit without adding the base product separately.';
comment on column public.crm_play_benefit_upgrades.customer_difference_usd_snapshot is
  'Frozen amount charged to the client for the upgrade at play confirmation.';
comment on column public.crm_play_redemptions.benefit_credit_usd is
  'Frozen USD credit granted by the play, independent from the final product selected.';
comment on column public.crm_play_redemptions.customer_paid_difference_usd is
  'Frozen commissionable difference paid by the client when choosing an allowed upgrade.';
comment on function public.crm_redeem_play_benefits_v3(bigint, bigint, jsonb) is
  'Redeems selected benefits as one final base or upgrade item and freezes credit, split and paid difference.';
