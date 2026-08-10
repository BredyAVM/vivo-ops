-- Block 27: zero-opening catalog references must not flood the alert center.

create or replace function app_private.inventory_item_has_actionable_stock_episode_v1(
  p_inventory_item_id bigint
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when item.id is null then true
    when not item.is_active
      or item.merged_into_item_id is not null
      or item.tracking_mode = 'not_tracked' then false
    when item.current_stock_units < 0 then true
    when item.current_stock_units <> 0 then true
    when item.target_stock_units = 0 then false
    else exists (
      select 1
      from public.inventory_movements movement
      where movement.inventory_item_id = item.id
        and movement.movement_type <> 'stock_count'
        and not exists (
          select 1
          from public.inventory_movements reversal
          where reversal.reversal_of_movement_id = movement.id
        )
    )
  end
  from (select 1) seed
  left join public.inventory_items item on item.id = p_inventory_item_id;
$$;

revoke all on function app_private.inventory_item_has_actionable_stock_episode_v1(bigint)
  from public, anon, authenticated, service_role;

comment on function app_private.inventory_item_has_actionable_stock_episode_v1(bigint) is
  'True when an item has real stock, negative stock, or an operational movement beyond its opening count. Zero-opening references and target-zero on-demand stock are not actionable.';

create or replace function app_private.inventory_upsert_alert_candidate_v1(
  p_detected_at timestamptz,
  p_alert_key text,
  p_alert_category text,
  p_alert_type text,
  p_severity text,
  p_requires_action boolean,
  p_inventory_item_id bigint,
  p_order_id bigint,
  p_planned_flow_id bigint,
  p_inventory_count_id bigint,
  p_title text,
  p_message text,
  p_details jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_policy record;
  v_alert_id bigint;
begin
  if p_inventory_item_id is not null
    and p_alert_type in ('commercial_out', 'stock_out')
    and not app_private.inventory_item_has_actionable_stock_episode_v1(p_inventory_item_id)
  then
    return null;
  end if;

  select * into v_policy
  from app_private.inventory_effective_alert_policy_v1(
    p_alert_category,
    p_inventory_item_id
  );

  if not found or not v_policy.is_enabled then
    return null;
  end if;

  insert into public.inventory_alerts (
    alert_key,
    alert_category,
    alert_type,
    severity,
    requires_action,
    status,
    inventory_item_id,
    order_id,
    planned_flow_id,
    inventory_count_id,
    title,
    message,
    details,
    first_detected_at,
    last_detected_at,
    created_at,
    updated_at
  )
  values (
    p_alert_key,
    p_alert_category,
    p_alert_type,
    p_severity,
    p_requires_action,
    'open',
    p_inventory_item_id,
    p_order_id,
    p_planned_flow_id,
    p_inventory_count_id,
    p_title,
    p_message,
    coalesce(p_details, '{}'::jsonb)
      || jsonb_build_object('detection_source', 'inventory_reconciler'),
    p_detected_at,
    p_detected_at,
    p_detected_at,
    p_detected_at
  )
  on conflict (alert_key) where status in ('open', 'managed')
  do update set
    alert_category = excluded.alert_category,
    alert_type = excluded.alert_type,
    severity = excluded.severity,
    requires_action = excluded.requires_action,
    inventory_item_id = excluded.inventory_item_id,
    order_id = excluded.order_id,
    planned_flow_id = excluded.planned_flow_id,
    inventory_count_id = excluded.inventory_count_id,
    title = excluded.title,
    message = excluded.message,
    details = excluded.details,
    last_detected_at = excluded.last_detected_at,
    updated_at = excluded.updated_at
  returning id into v_alert_id;

  return v_alert_id;
end;
$$;

revoke all on function app_private.inventory_upsert_alert_candidate_v1(
  timestamptz, text, text, text, text, boolean, bigint, bigint, bigint, bigint,
  text, text, jsonb
) from public, anon, authenticated, service_role;
