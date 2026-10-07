CREATE OR REPLACE FUNCTION public.crm_add_manual_play_member_v1(p_play_id bigint, p_client_id bigint, p_advisor_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_row public.crm_plays%rowtype;
  client_row public.clients%rowtype;
  existing_member public.crm_play_members%rowtype;
  metric_row record;
  actor_id uuid;
  advisor_id uuid;
  clean_reason text := btrim(coalesce(p_reason, ''));
  amended_at timestamptz := pg_catalog.now();
  member_id bigint;
  restored boolean := false;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to amend a CRM play'
      using errcode = '42501';
  end if;
  if length(clean_reason) not between 3 and 500 then
    raise exception 'Explain the reason in 3 to 500 characters' using errcode = '22023';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status not in ('frozen', 'active', 'paused') then
    raise exception 'Only a confirmed current play can accept manual clients' using errcode = '55000';
  end if;
  if play_row.ends_at is not null and play_row.ends_at <= amended_at then
    raise exception 'An expired play cannot accept manual clients' using errcode = '55000';
  end if;

  select client.* into client_row
  from public.clients client
  where client.id = p_client_id
    and client.is_active
  for update;

  if client_row.id is null then
    raise exception 'The client does not exist or is inactive' using errcode = 'P0002';
  end if;

  advisor_id := coalesce(p_advisor_id, client_row.primary_advisor_id);
  if advisor_id is null or not exists (
    select 1
    from public.profiles profile
    where profile.id = advisor_id
      and profile.is_active
      and exists (
        select 1
        from public.user_roles role_row
        where role_row.user_id = profile.id
          and role_row.role = 'advisor'
      )
  ) then
    raise exception 'Select an active advisor for this manual inclusion' using errcode = '22023';
  end if;

  select member_row.* into existing_member
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id
    and member_row.client_id = p_client_id
  for update;

  if existing_member.id is not null and existing_member.workflow_status <> 'removed' then
    raise exception 'The client already belongs to this play' using errcode = '23505';
  end if;
  if existing_member.id is not null and (
    existing_member.benefit_status = 'redeemed'
    or exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = existing_member.id
        and redemption.status = 'redeemed'
    )
  ) then
    raise exception 'A client with an applied benefit cannot be re-added' using errcode = '55000';
  end if;
  if app_private.crm_play_has_overlap_conflict_v1(p_play_id, p_client_id) then
    raise exception 'The client already belongs to an incompatible play in the same period'
      using errcode = '23505';
  end if;

  select metric.* into metric_row
  from public.crm_client_metrics_v1(play_row.metric_window, amended_at) metric
  where metric.client_id = p_client_id;

  actor_id := coalesce(caller_id, play_row.created_by_user_id);

  if existing_member.id is null then
    perform pg_catalog.set_config('app.crm_play_amendment_context', 'member_add', true);
    insert into public.crm_play_members (
      play_id, client_id, advisor_id_snapshot, eligible_at, workflow_status,
      benefit_status, first_purchase_on, last_purchase_on, purchase_count,
      net_revenue_usd, average_ticket_usd, cadence_days, cadence_window,
      last_advisor_id, last_advisor_name_snapshot, last_gift_on,
      days_since_last_purchase, used_pickup, used_delivery, decision_snapshot,
      eligibility_reasons
    ) values (
      p_play_id,
      p_client_id,
      advisor_id,
      amended_at,
      'pending',
      'available',
      metric_row.first_purchase_on,
      metric_row.last_purchase_on,
      coalesce(metric_row.purchase_count, 0)::integer,
      coalesce(metric_row.net_revenue_usd, 0),
      metric_row.average_ticket_usd,
      metric_row.cadence_days,
      play_row.metric_window,
      metric_row.last_advisor_id,
      metric_row.last_advisor_name_snapshot,
      metric_row.last_gift_on,
      metric_row.days_since_last_purchase,
      coalesce(metric_row.used_pickup, false),
      coalesce(metric_row.used_delivery, false),
      pg_catalog.jsonb_build_object(
        'rules', coalesce(play_row.rules_snapshot, '{}'::jsonb) - 'excluded_client_ids',
        'generated_at', amended_at,
        'primary_advisor_id', client_row.primary_advisor_id,
        'manual_inclusion', true,
        'included_after_publication', true,
        'original_rules_bypassed', true
      ),
      array['Inclusión manual autorizada por administrador']::text[]
    )
    returning id into member_id;
  else
    restored := true;
    member_id := existing_member.id;
    delete from public.crm_play_member_benefit_selections selection
    where selection.play_member_id = existing_member.id;

    perform pg_catalog.set_config('app.crm_play_amendment_context', 'member_restore', true);
    update public.crm_play_members member_row
    set
      advisor_id_snapshot = advisor_id,
      eligible_at = amended_at,
      workflow_status = 'pending',
      benefit_status = 'available',
      first_purchase_on = metric_row.first_purchase_on,
      last_purchase_on = metric_row.last_purchase_on,
      purchase_count = coalesce(metric_row.purchase_count, 0)::integer,
      net_revenue_usd = coalesce(metric_row.net_revenue_usd, 0),
      average_ticket_usd = metric_row.average_ticket_usd,
      cadence_days = metric_row.cadence_days,
      cadence_window = play_row.metric_window,
      last_advisor_id = metric_row.last_advisor_id,
      last_advisor_name_snapshot = metric_row.last_advisor_name_snapshot,
      last_gift_on = metric_row.last_gift_on,
      days_since_last_purchase = metric_row.days_since_last_purchase,
      used_pickup = coalesce(metric_row.used_pickup, false),
      used_delivery = coalesce(metric_row.used_delivery, false),
      decision_snapshot = pg_catalog.jsonb_build_object(
        'rules', coalesce(play_row.rules_snapshot, '{}'::jsonb) - 'excluded_client_ids',
        'generated_at', amended_at,
        'primary_advisor_id', client_row.primary_advisor_id,
        'manual_inclusion', true,
        'included_after_publication', true,
        'original_rules_bypassed', true,
        'restored_after_removal', true
      ),
      eligibility_reasons = array['Inclusión manual autorizada por administrador']::text[],
      contacted_at = null,
      benefit_reserved_at = null,
      benefit_redeemed_at = null,
      benefit_expired_at = null,
      last_contact_at = null,
      next_follow_up_at = null,
      responded_at = null,
      accepted_at = null,
      converted_at = null,
      workflow_closed_at = null,
      contact_attempt_count = 0,
      last_contact_channel = null,
      last_note = null,
      last_event_at = null,
      selected_play_benefit_id = null,
      selected_benefit_at = null,
      selected_benefit_by_user_id = null
    where member_row.id = existing_member.id;
  end if;

  insert into public.crm_play_amendments (
    play_id, amendment_type, client_id, advisor_id_snapshot,
    previous_values, new_values, reason, created_by_user_id, created_at
  ) values (
    p_play_id,
    'member_added',
    p_client_id,
    advisor_id,
    case when restored then pg_catalog.jsonb_build_object(
      'workflow_status', existing_member.workflow_status,
      'benefit_status', existing_member.benefit_status,
      'advisor_id_snapshot', existing_member.advisor_id_snapshot
    ) else '{}'::jsonb end,
    pg_catalog.jsonb_build_object(
      'workflow_status', 'pending',
      'benefit_status', 'available',
      'advisor_id_snapshot', advisor_id,
      'manual_inclusion', true,
      'restored', restored
    ),
    clean_reason,
    actor_id,
    amended_at
  );

  perform app_private.crm_refresh_published_play_summary_v1(p_play_id);

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'play_member_id', member_id,
    'client_id', p_client_id,
    'advisor_id', advisor_id,
    'restored', restored,
    'changed_at', amended_at
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_confirm_play_v1(p_play_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.crm_rebuild_play_members_v1(p_play_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_id uuid := auth.uid();
  play_row public.crm_plays%rowtype;
  generated_at timestamptz := pg_catalog.now();
  rules jsonb;
  excluded_ids jsonb;
  included_advisor_ids jsonb;
  advisor_filter_enabled boolean;
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
  advisor_filter_enabled := rules ? 'included_advisor_ids';
  included_advisor_ids := case
    when pg_catalog.jsonb_typeof(rules -> 'included_advisor_ids') = 'array'
      then rules -> 'included_advisor_ids'
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
    and (
      not advisor_filter_enabled
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(included_advisor_ids) included_advisor(value)
        where included_advisor.value = client_row.primary_advisor_id::text
      )
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
    'advisor_filter_enabled', advisor_filter_enabled,
    'included_advisor_count', case
      when advisor_filter_enabled then pg_catalog.jsonb_array_length(included_advisor_ids)
      else null
    end,
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
$function$;
