-- Preserve Master authority: an Advisor-side item mutation must not approve its
-- own revised inventory commitment. Direct walk-in sales remain self-refreshing.

set lock_timeout = '5s';
set statement_timeout = '30s';

create or replace function app_private.inventory_order_item_commitment_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id bigint;
  v_order record;
  v_actor uuid;
  v_caller uuid := auth.uid();
  v_caller_can_refresh boolean := false;
begin
  v_order_id := case when tg_op = 'DELETE' then old.order_id else new.order_id end;

  select
    order_row.source::text as source,
    order_row.status::text as status,
    order_row.needs_reapproval,
    order_row.queued_needs_reapproval,
    order_row.last_modified_by,
    order_row.sent_to_kitchen_by,
    order_row.created_by_user_id
  into v_order
  from public.orders order_row
  where order_row.id = v_order_id;

  if not found then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  v_caller_can_refresh := v_order.source = 'walk_in'
    or exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = v_caller
        and role_row.role in (
          'admin'::public.user_role,
          'master'::public.user_role
        )
    );

  if v_caller_can_refresh
    and v_order.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
    and not coalesce(v_order.needs_reapproval, false)
    and not coalesce(v_order.queued_needs_reapproval, false)
  then
    v_actor := app_private.inventory_resolve_commitment_actor_v1(
      v_order_id,
      coalesce(v_caller, v_order.last_modified_by, v_order.sent_to_kitchen_by, v_order.created_by_user_id)
    );
    perform app_private.inventory_materialize_order_commitment_v1(v_order_id, v_actor);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.inventory_order_item_commitment_trigger_v1()
  from public, anon, authenticated;
