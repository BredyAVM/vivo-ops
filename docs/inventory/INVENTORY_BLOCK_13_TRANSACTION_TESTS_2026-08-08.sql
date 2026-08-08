-- Block 13: run manually in Supabase SQL Editor. Every mutation is rolled back.

begin;

do $$
declare
  v_global_policies integer;
  v_refresh_triggers integer;
begin
  select count(*) into v_global_policies
  from public.inventory_alert_policies
  where inventory_item_id is null;

  if v_global_policies <> 6 then
    raise exception 'Expected 6 global policies, found %', v_global_policies;
  end if;

  select count(*) into v_refresh_triggers
  from pg_trigger
  where not tgisinternal
    and tgname like '%alert_refresh%';

  if v_refresh_triggers <> 0 then
    raise exception 'Inventory alerts must not add refresh triggers';
  end if;
end;
$$;

select app_private.inventory_refresh_alerts_core_v1() as refresh_result;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (
      select user_id::text
      from public.user_roles
      where role = 'admin'
      order by user_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);
set local role authenticated;

do $$
declare
  v_workspace jsonb;
begin
  v_workspace := public.inventory_alert_workspace_v1('inventory_center', true);
  if (v_workspace #>> '{configuration,can_configure}')::boolean is not true then
    raise exception 'Admin must receive alert configuration';
  end if;
  if jsonb_array_length(v_workspace -> 'configuration' -> 'policies') < 6 then
    raise exception 'Admin workspace is missing policies';
  end if;
end;
$$;

select public.inventory_save_alert_policy_v1(
  'availability',
  null,
  true,
  '[
    {"target_role":"admin","surface":"inventory_center"},
    {"target_role":"master","surface":"inventory_center"},
    {"target_role":"advisor","surface":"advisor_availability"}
  ]'::jsonb
) as policy_command_result;

rollback;
