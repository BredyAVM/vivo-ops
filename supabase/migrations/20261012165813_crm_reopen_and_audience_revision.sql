-- Controlled editing: reopen an unshared snapshot; preview/apply audience revisions
-- on shared plays without deleting tracked members or changing existing economics.
alter table public.crm_play_amendments drop constraint crm_play_amendments_type_check;
alter table public.crm_play_amendments add constraint crm_play_amendments_type_check check (
  amendment_type in ('message_updated','member_added','member_removed','advisor_excluded','criteria_corrected','design_reopened','audience_revised')
);
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
  -- Only the audited RPCs below may reopen a private cut or revise audience rules.
  if amendment_context = 'reopen_design' and old.status='frozen' and new.status='draft'
    and old.activated_at is null
    and (pg_catalog.to_jsonb(new) - array['status','snapshot_at','pricing_snapshot_at','pricing_exchange_rate_ves_per_usd','selection_summary','updated_at'])
      = (pg_catalog.to_jsonb(old) - array['status','snapshot_at','pricing_snapshot_at','pricing_exchange_rate_ves_per_usd','selection_summary','updated_at'])
  then return new; end if;
  if amendment_context = 'audience_revision' and old.status in ('active','paused') and new.status=old.status
    and (pg_catalog.to_jsonb(new) - array['rules_snapshot','updated_at'])
      = (pg_catalog.to_jsonb(old) - array['rules_snapshot','updated_at'])
  then return new; end if;
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

-- Canonical candidate query from the installed crm_rebuild_play_members_v1.
-- This read-only variant keeps member IDs and operational history intact.
create or replace function app_private.crm_revision_candidates_v1(p_play_id bigint, p_rules jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
  candidate_rows jsonb;
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
  where play.id = p_play_id;

  if play_row.id is null then
    raise exception 'CRM play does not exist'
      using errcode = 'P0002';
  end if;

  if play_row.status not in ('active', 'paused') then
    raise exception 'Solo una jugada compartida o pausada puede revisar sus filtros'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.crm_play_benefits option_row
    where option_row.play_id = p_play_id
  ) then
    raise exception 'At least one benefit option is required before generating the list'
      using errcode = '22023';
  end if;

  rules := coalesce(p_rules, '{}'::jsonb);
  if pg_catalog.jsonb_typeof(rules) <> 'object' then raise exception 'Las condiciones no son válidas'; end if;
  perform app_private.crm_offer_rest_bounds_v1(rules, play_row.starts_at);
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


  with product_matches as materialized (select * from app_private.crm_clients_with_products_v1(rules,generated_at)),
  candidates (play_id,
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
    eligibility_reasons) as (
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
      'primary_advisor_id', client_row.primary_advisor_id, 'matched_product_ids', coalesce(product_matches.matched_product_ids,'{}'::bigint[])
    ),
    array['Cumple los filtros de la jugada al momento del corte']::text[]
  from public.crm_client_metrics_v1(play_row.metric_window, generated_at) metric
  join public.clients client_row on client_row.id = metric.client_id
  join public.profiles advisor_profile on advisor_profile.id = client_row.primary_advisor_id
  left join product_matches on product_matches.client_id=metric.client_id
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
    and not app_private.crm_had_excluded_offer_v1(metric.client_id,play_row.starts_at,play_row.rules_snapshot)
    and (cardinality(app_private.crm_purchased_product_ids_v1(rules))=0 or product_matches.client_id is not null)
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
    )
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(candidate) order by candidate.client_id), '[]'::jsonb)
  into candidate_rows
  from candidates candidate
  where not app_private.crm_play_has_overlap_conflict_v1(p_play_id, candidate.client_id)
    and not exists (select 1 from public.crm_play_members removed
      where removed.play_id=p_play_id and removed.client_id=candidate.client_id and removed.workflow_status='removed');
  return candidate_rows;
end;
$function$;
revoke all on function app_private.crm_revision_candidates_v1(bigint,jsonb) from public,anon,authenticated;

create or replace function public.crm_reopen_unshared_play_v1(p_play_id bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  play_row public.crm_plays%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo el administrador puede volver una jugada al diseño' using errcode='42501';
  end if;
  if length(btrim(coalesce(p_reason,''))) not between 3 and 500 then raise exception 'Indica el motivo del ajuste'; end if;
  select * into play_row from public.crm_plays where id=p_play_id for update;
  if play_row.id is null or play_row.status <> 'frozen' or play_row.activated_at is not null then
    raise exception 'Solo una lista confirmada y aún no compartida puede volver al diseño' using errcode='55000';
  end if;
  -- Never route a previously used play through the draft's destructive rebuild.
  if exists (select 1 from public.crm_play_members m where m.play_id=p_play_id and (
    m.workflow_status not in ('pending','removed') or m.benefit_status not in ('available','cancelled')
    or m.contacted_at is not null or m.play_launched_at is not null
    or exists (select 1 from public.crm_play_redemptions r where r.play_member_id=m.id)
    or exists (select 1 from public.order_items i where i.crm_play_member_id=m.id)
    or exists (select 1 from public.crm_play_member_events e where e.play_member_id=m.id)
  )) then raise exception 'Esta lista ya tiene actividad; debe conservarse su historial'; end if;
  insert into public.crm_play_amendments(play_id,amendment_type,previous_values,new_values,reason,created_by_user_id)
  values (p_play_id,'design_reopened',pg_catalog.to_jsonb(play_row) || pg_catalog.jsonb_build_object(
    'members',(select coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb) from public.crm_play_members m where m.play_id=p_play_id)),
    '{"status":"draft"}'::jsonb,btrim(p_reason),auth.uid());
  perform pg_catalog.set_config('app.crm_play_amendment_context','reopen_design',true);
  update public.crm_plays set status='draft',snapshot_at=null,pricing_snapshot_at=null,
    pricing_exchange_rate_ves_per_usd=null,selection_summary='{}'::jsonb where id=p_play_id;
  perform pg_catalog.set_config('app.crm_play_amendment_context','',true);
  return jsonb_build_object('play_id',p_play_id,'status','draft');
end;
$$;

-- Preview and apply share this transaction and the same eligibility query.
-- Preview writes nothing. Apply verifies the exact decision token shown to the admin.
create or replace function public.crm_revise_play_audience_v1(
  p_play_id bigint, p_rules jsonb, p_apply boolean default false,
  p_token text default null, p_reason text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  play_row public.crm_plays%rowtype;
  rules jsonb;
  candidates jsonb;
  decisions jsonb;
  current_members jsonb;
  token text;
  result jsonb;
  candidate jsonb;
  inserted_count integer := 0;
  removed_count integer := 0;
  old_context text;
begin
  if auth.uid() is null or not exists (select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo el administrador puede revisar los filtros publicados' using errcode='42501';
  end if;
  -- Serialize revisions and lock current plays in deterministic order.
  if p_apply then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm_audience_revision',0));
    perform 1 from public.crm_plays where status in ('draft','frozen','active','paused') order by id for update;
  end if;
  select * into play_row from public.crm_plays where id=p_play_id;
  if play_row.id is null or play_row.status not in ('active','paused') then
    raise exception 'Selecciona una jugada compartida o pausada' using errcode='55000';
  end if;
  if play_row.ends_at <= now() then raise exception 'Una jugada vencida conserva su historial; copia una nueva'; end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'object' then raise exception 'Las condiciones no son válidas'; end if;
  -- Manual removals survive any filter change. Campaign identity is not editable here.
  rules := p_rules || jsonb_build_object('excluded_client_ids',coalesce(play_row.rules_snapshot->'excluded_client_ids','[]'::jsonb),
    'play_type',play_row.rules_snapshot->'play_type');
  if p_apply then
    if length(btrim(coalesce(p_reason,''))) not between 3 and 500 then raise exception 'Indica el motivo del ajuste'; end if;
    perform 1 from public.crm_play_members where play_id=p_play_id order by id for update;
  end if;
  candidates := app_private.crm_revision_candidates_v1(p_play_id,rules);
  -- Existing decisions remain frozen. Reservations, deliveries and actual order
  -- references are protected even when the new filters would exclude the client.
  with candidate_rows as (select value from jsonb_array_elements(candidates)),
  protected as (
    select m.client_id from public.crm_play_members m where m.play_id=p_play_id and m.workflow_status<>'removed' and (
      m.benefit_status in ('reserved','redeemed')
      or exists (select 1 from public.crm_play_redemptions r where r.play_member_id=m.id and r.status in ('reserved','redeemed'))
      or exists (select 1 from public.order_items i where i.crm_play_member_id=m.id)
    )
  ), ids as (
    select (value->>'client_id')::bigint client_id from candidate_rows
    union select client_id from public.crm_play_members where play_id=p_play_id and workflow_status<>'removed'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'client_id',ids.client_id,'name',c.full_name,
    'advisor',a.full_name,
    'action',case when p.client_id is not null then 'protected'
      when n.value is null then 'remove'
      when m.id is null then 'add' else 'keep' end
  ) order by ids.client_id),'[]'::jsonb) into decisions
  from ids join public.clients c on c.id=ids.client_id
  left join candidate_rows n on (n.value->>'client_id')::bigint=ids.client_id
  left join public.crm_play_members m on m.play_id=p_play_id and m.client_id=ids.client_id and m.workflow_status<>'removed'
  left join protected p on p.client_id=ids.client_id
  left join public.profiles a on a.id=coalesce(m.advisor_id_snapshot,(n.value->>'advisor_id_snapshot')::uuid);
  select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) into current_members
    from public.crm_play_members m where m.play_id=p_play_id;
  token := pg_catalog.md5(jsonb_build_object('play',to_jsonb(play_row),'rules',rules,'members',current_members,
    'decisions',decisions)::text);
  result := jsonb_build_object('token',token,'clients',decisions,
    'added',(select count(*) from jsonb_array_elements(decisions) d where d->>'action'='add'),
    'removed',(select count(*) from jsonb_array_elements(decisions) d where d->>'action'='remove'),
    'protected',(select count(*) from jsonb_array_elements(decisions) d where d->>'action'='protected'),
    'total',(select count(*) from jsonb_array_elements(decisions) d where d->>'action'<>'remove'));
  if not p_apply then return result; end if;
  if p_token is distinct from token then raise exception 'La lista o su seguimiento cambiaron. Vuelve a probar antes de aplicar.' using errcode='40001'; end if;
  old_context := coalesce(current_setting('app.crm_play_amendment_context',true),'');
  perform set_config('app.crm_play_amendment_context','audience_revision',true);
  update public.crm_plays set rules_snapshot=rules where id=p_play_id;
  perform set_config('app.crm_play_amendment_context','member_remove',true);
  -- Do not clear contact/response timestamps, selections or event history.
  update public.crm_play_members m set workflow_status='removed',benefit_status='cancelled',
    workflow_closed_at=now(),last_note=btrim(p_reason),last_event_at=now()
  where m.play_id=p_play_id and exists (select 1 from jsonb_array_elements(decisions) d
    where (d->>'client_id')::bigint=m.client_id and d->>'action'='remove');
  get diagnostics removed_count = row_count;
  perform set_config('app.crm_play_amendment_context','audience_revision_add',true);
  for candidate in select value from jsonb_array_elements(candidates) loop
    if exists (select 1 from jsonb_array_elements(decisions) d where d->>'client_id'=candidate->>'client_id' and d->>'action'='add') then
      insert into public.crm_play_members (
        play_id,client_id,advisor_id_snapshot,eligible_at,first_purchase_on,last_purchase_on,purchase_count,
        net_revenue_usd,average_ticket_usd,cadence_days,cadence_window,last_advisor_id,last_advisor_name_snapshot,
        last_gift_on,days_since_last_purchase,used_pickup,used_delivery,decision_snapshot,eligibility_reasons
      ) select p_play_id,m.client_id,m.advisor_id_snapshot,m.eligible_at,m.first_purchase_on,m.last_purchase_on,m.purchase_count,
        m.net_revenue_usd,m.average_ticket_usd,m.cadence_days,m.cadence_window,m.last_advisor_id,m.last_advisor_name_snapshot,
        m.last_gift_on,m.days_since_last_purchase,m.used_pickup,m.used_delivery,m.decision_snapshot,m.eligibility_reasons
      from jsonb_populate_record(null::public.crm_play_members,candidate) m;
      inserted_count := inserted_count+1;
    end if;
  end loop;
  insert into public.crm_play_amendments(play_id,amendment_type,previous_values,new_values,reason,created_by_user_id)
  values (p_play_id,'audience_revised',jsonb_build_object('rules',play_row.rules_snapshot,'members',current_members),
    jsonb_build_object('rules',rules,'decisions',decisions,'added',inserted_count,'removed',removed_count),btrim(p_reason),auth.uid());
  perform app_private.crm_refresh_published_play_summary_v1(p_play_id);
  perform set_config('app.crm_play_amendment_context',old_context,true);
  return result || jsonb_build_object('applied',true);
end;
$$;

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

  if tg_op = 'INSERT' and play_status <> 'draft' and not (
    play_status in ('active','paused')
    and coalesce(pg_catalog.current_setting('app.crm_play_amendment_context',true),'')='audience_revision_add'
    and exists (select 1 from public.user_roles where user_id=auth.uid() and role='admin')
  ) then
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


revoke all on function public.crm_reopen_unshared_play_v1(bigint,text) from public,anon,authenticated;
revoke all on function public.crm_revise_play_audience_v1(bigint,jsonb,boolean,text,text) from public,anon,authenticated;
grant execute on function public.crm_reopen_unshared_play_v1(bigint,text) to authenticated;
grant execute on function public.crm_revise_play_audience_v1(bigint,jsonb,boolean,text,text) to authenticated;
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

  if nullif(play_row.selection_summary ->> 'generated_at','') is null then
    raise exception 'Vuelve a probar la lista antes de confirmar el snapshot' using errcode='55000';
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


  if exists (
    select 1 from public.crm_play_members member_row
    where member_row.play_id=p_play_id and member_row.workflow_status<>'removed'
      and app_private.crm_had_excluded_offer_v1(member_row.client_id,play_row.starts_at,play_row.rules_snapshot)
  ) then
    raise exception 'Hay clientes con una jugada lanzada durante el período de descanso seleccionado. Vuelve a probar la lista antes de confirmar.' using errcode='40001';
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

notify pgrst,'reload schema';

