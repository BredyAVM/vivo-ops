create role anon; create role authenticated; create role service_role;
create schema app_private; create schema auth;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
create table public.user_roles(user_id uuid,role text);
create table public.profiles(id uuid primary key,full_name text,is_active boolean default true);
create table public.clients(id bigint primary key,full_name text,is_active boolean default true,primary_advisor_id uuid);
create function public.is_master_or_admin() returns boolean language sql as $$select exists(select 1 from public.user_roles where user_id=auth.uid() and role in ('admin','master'))$$;
create table public.crm_plays (
  id bigint generated always as identity primary key,
  series_key text,
  version integer default 1,
  supersedes_play_id bigint,
  name text,
  description text,
  status text default 'draft'::text,
  rules_snapshot jsonb default '{}'::jsonb,
  selection_summary jsonb default '{}'::jsonb,
  metric_window smallint default 6,
  gift_product_id bigint,
  gift_quantity numeric default 1,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  snapshot_at timestamp with time zone,
  activated_at timestamp with time zone,
  closed_at timestamp with time zone,
  created_by_user_id uuid,
  activated_by_user_id uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  planned_budget_usd numeric,
  benefit_selection_mode text default 'single'::text,
  purchase_requirement_mode text default 'none'::text,
  minimum_order_amount_usd numeric,
  copied_from_play_id bigint,
  advisor_guidance text,
  message_template text,
  overlap_policy text default 'exclusive'::text,
  benefit_stack_policy text default 'one_per_order'::text,
  evaluation_window_days smallint default 90,
  pricing_exchange_rate_ves_per_usd numeric,
  pricing_snapshot_at timestamp with time zone,
  benefit_recurrence_mode text default 'once'::text,
  benefit_fulfillment text default 'any'::text
);
create table public.crm_play_members (
  id bigint generated always as identity primary key,
  play_id bigint,
  client_id bigint,
  advisor_id_snapshot uuid,
  eligible_at timestamp with time zone,
  workflow_status text default 'pending'::text,
  benefit_status text default 'available'::text,
  first_purchase_on date,
  last_purchase_on date,
  purchase_count integer,
  net_revenue_usd numeric,
  average_ticket_usd numeric,
  cadence_days numeric,
  cadence_window smallint,
  last_advisor_id uuid,
  last_advisor_name_snapshot text,
  last_gift_on date,
  days_since_last_purchase integer,
  used_pickup boolean default false,
  used_delivery boolean default false,
  decision_snapshot jsonb default '{}'::jsonb,
  eligibility_reasons text[] default ARRAY[]::text[],
  contacted_at timestamp with time zone,
  benefit_reserved_at timestamp with time zone,
  benefit_redeemed_at timestamp with time zone,
  benefit_expired_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  last_contact_at timestamp with time zone,
  next_follow_up_at timestamp with time zone,
  responded_at timestamp with time zone,
  accepted_at timestamp with time zone,
  converted_at timestamp with time zone,
  workflow_closed_at timestamp with time zone,
  contact_attempt_count integer default 0,
  last_contact_channel text,
  last_note text,
  last_event_at timestamp with time zone,
  selected_play_benefit_id bigint,
  selected_benefit_at timestamp with time zone,
  selected_benefit_by_user_id uuid,
  play_launched_at timestamp with time zone
);
create table public.crm_play_amendments (
  id bigint generated always as identity primary key,
  play_id bigint,
  amendment_type text,
  client_id bigint,
  advisor_id_snapshot uuid,
  previous_values jsonb default '{}'::jsonb,
  new_values jsonb default '{}'::jsonb,
  reason text,
  created_by_user_id uuid,
  created_at timestamp with time zone default now()
);
create table public.crm_play_benefits (
  id bigint generated always as identity primary key,
  play_id bigint,
  product_id bigint,
  quantity numeric default 1,
  sort_order smallint,
  created_at timestamp with time zone default now(),
  unit_budget_cost_usd numeric default 0,
  unit_benefit_value_usd numeric default 0,
  unit_advisor_cost_usd numeric default 0,
  unit_company_cost_usd numeric default 0,
  product_name_snapshot text,
  source_price_currency_snapshot text,
  source_price_amount_snapshot numeric,
  catalog_price_usd_snapshot numeric
);
alter table public.crm_play_members add unique(play_id,client_id);
alter table public.crm_play_amendments add constraint crm_play_amendments_type_check check (amendment_type in ('message_updated','criteria_corrected'));
create table public.crm_play_redemptions(id bigint,play_member_id bigint,status text,order_id bigint,redeemed_at timestamptz,redeemed_by_user_id uuid);
create table public.crm_play_member_events(id bigint,play_member_id bigint,event_type text,created_at timestamptz,actor_user_id uuid);
create table public.order_items(id bigint,crm_play_member_id bigint);
create table public.orders(id bigint,status text);
CREATE OR REPLACE FUNCTION app_private.crm_play_member_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  play_status text;
  funnel_time timestamptz;
  lifecycle_context text := coalesce(
    pg_catalog.current_setting('app.crm_benefit_lifecycle_context', true),
    ''
  );
begin
  select play.status
  into play_status
  from public.crm_plays play
  where play.id = case when tg_op = 'DELETE' then old.play_id else new.play_id end;

  if play_status is null then
    raise exception 'CRM play does not exist';
  end if;


  if tg_op = 'UPDATE' and coalesce(pg_catalog.current_setting('app.crm_redemption_funnel_event',true),'') <> '' then
    if pg_catalog.pg_trigger_depth() < 2 or play_status not in ('active','closed')
      or old.benefit_status <> 'redeemed' then
      raise exception 'El seguimiento automático requiere una entrega CRM comprobada.' using errcode='42501';
    end if;
    select event.created_at into funnel_time
    from public.crm_play_member_events event
    where event.id::text = pg_catalog.current_setting('app.crm_redemption_funnel_event',true)
      and event.play_member_id = old.id and event.event_type = 'benefit_redeemed'
      and exists (
        select 1 from public.crm_play_redemptions redemption
        join public.orders order_row on order_row.id = redemption.order_id
        where redemption.play_member_id = old.id and redemption.status = 'redeemed'
          and order_row.status = 'delivered'
          and redemption.redeemed_at = event.created_at
          and redemption.redeemed_by_user_id = event.actor_user_id
      );
    if not found then
      raise exception 'El seguimiento automático requiere una entrega CRM comprobada.' using errcode='42501';
    end if;
    if (pg_catalog.to_jsonb(new) - 'updated_at') is distinct from
      ((pg_catalog.to_jsonb(old) - 'updated_at') || pg_catalog.jsonb_build_object(
        'contacted_at',coalesce(old.contacted_at,funnel_time),
        'responded_at',coalesce(old.responded_at,funnel_time),
        'play_launched_at',coalesce(old.play_launched_at,funnel_time),
        'last_contact_at',greatest(old.last_contact_at,funnel_time),
        'contact_attempt_count',greatest(old.contact_attempt_count,1),
        'last_event_at',greatest(old.last_event_at,funnel_time))) then
      raise exception 'El seguimiento automático no puede alterar la selección ni los datos congelados.' using errcode='42501';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and lifecycle_context = 'on' then
    if (
      pg_catalog.to_jsonb(new)
        - 'benefit_status'
        - 'benefit_reserved_at'
        - 'benefit_redeemed_at'
        - 'benefit_expired_at'
        - 'updated_at'
    ) is distinct from (
      pg_catalog.to_jsonb(old)
        - 'benefit_status'
        - 'benefit_reserved_at'
        - 'benefit_redeemed_at'
        - 'benefit_expired_at'
        - 'updated_at'
    ) then
      raise exception 'El contexto interno solo puede cambiar el estado del beneficio CRM.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' and play_status <> 'draft' then
    raise exception 'CRM play members can only be selected while the play is a draft';
  end if;

  if tg_op = 'DELETE' and play_status <> 'draft' then
    raise exception 'A frozen CRM play member cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    if play_status in ('frozen', 'closed', 'cancelled') then
      raise exception 'CRM play members cannot change while the play is %', play_status;
    end if;

    if play_status <> 'draft' and (
      new.play_id is distinct from old.play_id
      or new.client_id is distinct from old.client_id
      or new.advisor_id_snapshot is distinct from old.advisor_id_snapshot
      or new.eligible_at is distinct from old.eligible_at
      or new.first_purchase_on is distinct from old.first_purchase_on
      or new.last_purchase_on is distinct from old.last_purchase_on
      or new.purchase_count is distinct from old.purchase_count
      or new.net_revenue_usd is distinct from old.net_revenue_usd
      or new.average_ticket_usd is distinct from old.average_ticket_usd
      or new.cadence_days is distinct from old.cadence_days
      or new.cadence_window is distinct from old.cadence_window
      or new.last_advisor_id is distinct from old.last_advisor_id
      or new.last_advisor_name_snapshot is distinct from old.last_advisor_name_snapshot
      or new.last_gift_on is distinct from old.last_gift_on
      or new.days_since_last_purchase is distinct from old.days_since_last_purchase
      or new.used_pickup is distinct from old.used_pickup
      or new.used_delivery is distinct from old.used_delivery
      or new.decision_snapshot is distinct from old.decision_snapshot
      or new.eligibility_reasons is distinct from old.eligibility_reasons
      or new.created_at is distinct from old.created_at
    ) then
      raise exception 'Frozen CRM play member decision data is immutable';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.crm_play_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  amendment_context text := coalesce(
    pg_catalog.current_setting('app.crm_play_amendment_context', true),
    ''
  );
begin
  if old.status <> 'draft' and (
    new.series_key is distinct from old.series_key
    or new.version is distinct from old.version
    or new.supersedes_play_id is distinct from old.supersedes_play_id
    or new.copied_from_play_id is distinct from old.copied_from_play_id
    or new.name is distinct from old.name
    or new.description is distinct from old.description
    or new.rules_snapshot is distinct from old.rules_snapshot
    or new.metric_window is distinct from old.metric_window
    or new.gift_product_id is distinct from old.gift_product_id
    or new.gift_quantity is distinct from old.gift_quantity
    or new.planned_budget_usd is distinct from old.planned_budget_usd
    or new.benefit_recurrence_mode is distinct from old.benefit_recurrence_mode or new.benefit_fulfillment is distinct from old.benefit_fulfillment or new.benefit_selection_mode is distinct from old.benefit_selection_mode
    or new.purchase_requirement_mode is distinct from old.purchase_requirement_mode
    or new.minimum_order_amount_usd is distinct from old.minimum_order_amount_usd
    or new.overlap_policy is distinct from old.overlap_policy
    or new.benefit_stack_policy is distinct from old.benefit_stack_policy
    or new.evaluation_window_days is distinct from old.evaluation_window_days
    or new.pricing_exchange_rate_ves_per_usd is distinct from old.pricing_exchange_rate_ves_per_usd
    or new.pricing_snapshot_at is distinct from old.pricing_snapshot_at
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.snapshot_at is distinct from old.snapshot_at
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'A frozen CRM play definition is immutable';
  end if;

  if old.status <> 'draft'
    and new.selection_summary is distinct from old.selection_summary
    and amendment_context <> 'published_summary'
  then
    raise exception 'A published CRM play summary can only change through an audited amendment';
  end if;

  if old.status <> 'draft'
    and (
      new.advisor_guidance is distinct from old.advisor_guidance
      or new.message_template is distinct from old.message_template
    )
    and amendment_context <> 'message'
  then
    raise exception 'Published CRM play copy can only change through an audited amendment';
  end if;

  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status in ('frozen', 'cancelled'))
    or (old.status = 'frozen' and new.status in ('active', 'cancelled'))
    or (old.status = 'active' and new.status in ('paused', 'closed', 'cancelled'))
    or (old.status = 'paused' and new.status in ('active', 'closed', 'cancelled'))
  ) then
    raise exception 'Invalid CRM play status transition: % -> %', old.status, new.status;
  end if;

  if new.status is not distinct from old.status
    and old.status <> 'draft'
    and (
      new.activated_at is distinct from old.activated_at
      or new.activated_by_user_id is distinct from old.activated_by_user_id
      or new.closed_at is distinct from old.closed_at
    )
  then
    raise exception 'CRM play lifecycle timestamps can only change with a status transition';
  end if;

  if new.status = 'frozen' and (
    new.activated_at is not null
    or new.activated_by_user_id is not null
    or new.closed_at is not null
  ) then
    raise exception 'A frozen CRM play cannot contain activation or closure timestamps';
  end if;

  if new.status = 'active' and old.status = 'frozen' and (
    new.activated_at is null or new.activated_by_user_id is null
  ) then
    raise exception 'CRM play activation requires actor and timestamp';
  end if;

  if new.status = 'closed' and new.closed_at is null then
    raise exception 'Closing a CRM play requires closed_at';
  end if;

  return new;
end;
$function$;

create trigger crm_play_guard before update on public.crm_plays for each row execute function app_private.crm_play_guard_v1();
create trigger crm_member_guard before insert or update or delete on public.crm_play_members for each row execute function app_private.crm_play_member_guard_v1();

