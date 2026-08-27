-- Freeze the play-specific economics at redemption time. This is the bridge
-- used by commission snapshots and company campaign-spend reporting.

drop index if exists public.crm_play_redemptions_active_member_unique;

alter table public.crm_play_redemptions
  add column play_benefit_id bigint references public.crm_play_benefits(id) on delete restrict,
  add column play_name_snapshot text,
  add column unit_benefit_value_usd numeric(12,2) not null default 0,
  add column unit_advisor_cost_usd numeric(12,2) not null default 0,
  add column unit_company_cost_usd numeric(12,2) not null default 0,
  add column benefit_value_usd numeric(14,2) not null default 0,
  add column advisor_charge_usd numeric(14,2) not null default 0,
  add column company_cost_usd numeric(14,2) not null default 0;

alter table public.crm_play_redemptions
  add constraint crm_play_redemptions_economics_nonnegative_check
    check (
      unit_benefit_value_usd >= 0
      and unit_advisor_cost_usd >= 0
      and unit_company_cost_usd >= 0
      and benefit_value_usd >= 0
      and advisor_charge_usd >= 0
      and company_cost_usd >= 0
    ),
  add constraint crm_play_redemptions_economics_split_check
    check (
      pg_catalog.abs(benefit_value_usd - advisor_charge_usd - company_cost_usd) <= 0.01
    );

create unique index crm_play_redemptions_active_member_benefit_unique
  on public.crm_play_redemptions(play_member_id, play_benefit_id)
  where status = 'redeemed' and play_benefit_id is not null;

create index crm_play_redemptions_play_benefit_id_idx
  on public.crm_play_redemptions(play_benefit_id)
  where play_benefit_id is not null;

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
        'benefit_selected',
        'benefit_redeemed'
      )
    );

create or replace function app_private.crm_play_redemption_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  play_row record;
  member_row record;
  option_row record;
  order_row record;
  redemption_time timestamptz;
  commercial_subtotal numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'CRM play redemptions cannot be deleted; void them instead';
  end if;

  if tg_op = 'UPDATE' then
    if new.play_member_id is distinct from old.play_member_id
      or new.play_benefit_id is distinct from old.play_benefit_id
      or new.order_id is distinct from old.order_id
      or new.order_item_id is distinct from old.order_item_id
      or new.product_id is distinct from old.product_id
      or new.quantity is distinct from old.quantity
      or new.play_name_snapshot is distinct from old.play_name_snapshot
      or new.unit_benefit_value_usd is distinct from old.unit_benefit_value_usd
      or new.unit_advisor_cost_usd is distinct from old.unit_advisor_cost_usd
      or new.unit_company_cost_usd is distinct from old.unit_company_cost_usd
      or new.benefit_value_usd is distinct from old.benefit_value_usd
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
    and (new.play_benefit_id is null or option.id = new.play_benefit_id)
    and option.product_id = new.product_id
  order by option.sort_order, option.id
  limit 1;

  if option_row.id is null then
    raise exception 'The redemption is not one of the benefits selected for this client';
  end if;

  if pg_catalog.abs(new.quantity - option_row.quantity) > 0.001 then
    raise exception 'The redemption quantity does not match the selected CRM benefit';
  end if;

  select
    order_data.id,
    order_data.client_id,
    order_data.attributed_advisor_id,
    order_data.total_usd,
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
      and order_item.product_id = new.product_id
      and pg_catalog.abs(order_item.qty - new.quantity) <= 0.001
      and pg_catalog.abs(coalesce(order_item.line_total_usd, 0)) <= 0.01
  ) then
    raise exception 'The redemption requires an exact zero-price order item for the selected benefit';
  end if;

  commercial_subtotal := coalesce(
    nullif(order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}', '')::numeric,
    order_row.total_usd,
    0
  );

  if member_row.purchase_requirement_mode = 'minimum_order'
    and commercial_subtotal + 0.005 < member_row.minimum_order_amount_usd
  then
    raise exception 'The order does not reach the minimum purchase required by this CRM play';
  end if;

  new.play_benefit_id := option_row.id;
  new.play_name_snapshot := member_row.play_name;
  new.unit_benefit_value_usd := option_row.unit_benefit_value_usd;
  new.unit_advisor_cost_usd := option_row.unit_advisor_cost_usd;
  new.unit_company_cost_usd := option_row.unit_company_cost_usd;
  new.benefit_value_usd := pg_catalog.round(option_row.unit_benefit_value_usd * new.quantity, 2);
  new.advisor_charge_usd := pg_catalog.round(option_row.unit_advisor_cost_usd * new.quantity, 2);
  new.company_cost_usd := pg_catalog.round(option_row.unit_company_cost_usd * new.quantity, 2);
  return new;
end;
$$;

revoke all on function app_private.crm_play_redemption_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_redemption_guard_v1() to service_role;

create or replace function public.crm_redeem_play_benefits_v2(
  p_play_member_id bigint,
  p_order_id bigint
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
  selection_row record;
  matching_order_item_id bigint;
  redeemed_count integer := 0;
  advisor_charge_total numeric := 0;
  company_cost_total numeric := 0;
begin
  if caller_id is null then
    raise exception 'Authentication is required to redeem CRM benefits' using errcode = '42501';
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

  select pg_catalog.count(*)::integer
  into selected_count
  from public.crm_play_member_benefit_selections
  where play_member_id = p_play_member_id;

  if selected_count = 0 then
    raise exception 'Select the CRM benefit before creating its order' using errcode = '55000';
  end if;

  for selection_row in
    select
      selection.play_benefit_id,
      option.product_id,
      option.quantity,
      option.unit_advisor_cost_usd,
      option.unit_company_cost_usd
    from public.crm_play_member_benefit_selections selection
    join public.crm_play_benefits option on option.id = selection.play_benefit_id
    where selection.play_member_id = p_play_member_id
    order by option.sort_order, option.id
  loop
    select item.id
    into matching_order_item_id
    from public.order_items item
    where item.order_id = p_order_id
      and item.product_id = selection_row.product_id
      and pg_catalog.abs(item.qty - selection_row.quantity) <= 0.001
      and pg_catalog.abs(coalesce(item.line_total_usd, 0)) <= 0.01
    order by item.id
    limit 1;

    if matching_order_item_id is null then
      raise exception 'The order is missing one exact zero-price item selected by the CRM play';
    end if;

    if not exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = p_play_member_id
        and redemption.play_benefit_id = selection_row.play_benefit_id
        and redemption.status = 'redeemed'
    ) then
      insert into public.crm_play_redemptions (
        play_member_id,
        play_benefit_id,
        order_id,
        order_item_id,
        product_id,
        quantity,
        redeemed_by_user_id,
        redeemed_at
      ) values (
        p_play_member_id,
        selection_row.play_benefit_id,
        p_order_id,
        matching_order_item_id,
        selection_row.product_id,
        selection_row.quantity,
        caller_id,
        pg_catalog.now()
      );
      redeemed_count := redeemed_count + 1;
      advisor_charge_total := advisor_charge_total + selection_row.unit_advisor_cost_usd * selection_row.quantity;
      company_cost_total := company_cost_total + selection_row.unit_company_cost_usd * selection_row.quantity;
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
    'company_cost_usd', pg_catalog.round(company_cost_total, 2)
  );
end;
$$;

revoke all on function public.crm_redeem_play_benefits_v2(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.crm_redeem_play_benefits_v2(bigint, bigint)
  to authenticated, service_role;

comment on column public.crm_play_redemptions.advisor_charge_usd is
  'Frozen total deducted from the advisor commission for this play redemption.';
comment on column public.crm_play_redemptions.company_cost_usd is
  'Frozen total company contribution used for campaign-spend reporting.';
comment on function public.crm_redeem_play_benefits_v2(bigint, bigint) is
  'Links the selected zero-price benefit items to a CRM play and freezes its advisor/company economics.';
