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
$function$
