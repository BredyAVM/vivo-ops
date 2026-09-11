-- Keep Counter aligned with the commercial suspensions declared by Master.
-- Existing order quantities remain valid, but new sales, added products and
-- quantity increases cannot commit while their product is suspended.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function app_private.counter_assert_commercial_products_sellable_v1(
  p_target_at timestamptz,
  p_product_ids bigint[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_product_ids bigint[];
  v_availability jsonb;
  v_suspended_product text;
begin
  select array_agg(distinct requested.product_id order by requested.product_id)
  into v_product_ids
  from unnest(coalesce(p_product_ids, array[]::bigint[])) requested(product_id)
  where requested.product_id > 0;

  if coalesce(cardinality(v_product_ids), 0) = 0 then
    return;
  end if;
  if cardinality(v_product_ids) > 200 then
    raise exception 'counter_items_count_invalid' using errcode = '22023';
  end if;

  -- Product suspensions lock products; physical-item suspensions lock items.
  -- Taking matching share locks closes the gap between the final check and
  -- the order commit without introducing another inventory table or flag.
  perform product.id
  from public.products product
  where product.id in (
    with recursive nodes(product_id, depth, path) as (
      select requested.product_id, 0, array[requested.product_id]::bigint[]
      from unnest(v_product_ids) requested(product_id)
      union all
      select component.component_product_id,
             node.depth + 1,
             node.path || component.component_product_id
      from nodes node
      join public.product_components component
        on component.parent_product_id = node.product_id
       and component.component_mode = 'fixed'::public.product_component_mode
       and component.is_required
      where node.depth < 16
        and not component.component_product_id = any(node.path)
    )
    select distinct node.product_id from nodes node
  )
  order by product.id
  for share;

  perform item.id
  from public.inventory_items item
  where item.id in (
    with recursive nodes(product_id, depth, path) as (
      select requested.product_id, 0, array[requested.product_id]::bigint[]
      from unnest(v_product_ids) requested(product_id)
      union all
      select component.component_product_id,
             node.depth + 1,
             node.path || component.component_product_id
      from nodes node
      join public.product_components component
        on component.parent_product_id = node.product_id
       and component.component_mode = 'fixed'::public.product_component_mode
       and component.is_required
      where node.depth < 16
        and not component.component_product_id = any(node.path)
    )
    select distinct link.inventory_item_id
    from nodes node
    join public.products product on product.id = node.product_id
    join public.product_inventory_links link
      on link.product_id = product.id
     and link.configuration_version = 1
    where product.inventory_policy in ('self', 'direct')
  )
  order by item.id
  for share;

  v_availability := public.inventory_catalog_availability_v1(
    greatest(coalesce(p_target_at, now()), now()),
    v_product_ids,
    'counter_inventory'
  );

  select coalesce(
    nullif(entry.value ->> 'product_name', ''),
    nullif(entry.value ->> 'name', ''),
    format('ID %s', entry.value ->> 'product_id')
  )
  into v_suspended_product
  from jsonb_array_elements(coalesce(v_availability -> 'products', '[]'::jsonb)) entry(value)
  where coalesce((entry.value ->> 'is_commercially_suspended')::boolean, false)
     or entry.value ->> 'availability_state' = 'declared_unavailable'
  order by (entry.value ->> 'product_id')::bigint
  limit 1;

  if v_suspended_product is not null then
    raise exception 'counter_product_suspended: %', v_suspended_product using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function app_private.counter_assert_commercial_products_sellable_v1(
  timestamptz,
  bigint[]
) from public, anon, authenticated, service_role;

comment on function app_private.counter_assert_commercial_products_sellable_v1(
  timestamptz,
  bigint[]
) is
'Atomic Counter guard that reuses canonical inventory availability and serializes against Master product/item suspensions.';

alter function public.counter_create_direct_sale(uuid, jsonb)
  rename to counter_create_direct_sale_without_commercial_guard_v1;

revoke all on function public.counter_create_direct_sale_without_commercial_guard_v1(uuid, jsonb)
  from public, anon, authenticated, service_role;

comment on function public.counter_create_direct_sale_without_commercial_guard_v1(uuid, jsonb) is
'Internal legacy implementation. Call counter_create_direct_sale so commercial suspension is checked atomically.';

create function public.counter_create_direct_sale(
  p_idempotency_key uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_order_id bigint;
  v_product_ids bigint[];
begin
  if v_uid is null
     or not (public.has_role('counter') or public.is_master_or_admin())
  then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  -- Preserve exact idempotent replay semantics even if the catalog changed
  -- after the original successful sale.
  if exists (
    select 1
    from public.counter_command_receipts receipt
    where receipt.actor_user_id = v_uid
      and receipt.command_type = 'create_direct_sale'
      and receipt.idempotency_key = p_idempotency_key
      and receipt.status = 'completed'
      and receipt.result_payload is not null
  ) then
    return public.counter_create_direct_sale_without_commercial_guard_v1(
      p_idempotency_key,
      p_payload
    );
  end if;

  v_result := public.counter_create_direct_sale_without_commercial_guard_v1(
    p_idempotency_key,
    p_payload
  );
  v_order_id := nullif(v_result ->> 'id', '')::bigint;

  select array_agg(distinct candidate.product_id order by candidate.product_id)
  into v_product_ids
  from (
    select item.product_id
    from public.order_items item
    where item.order_id = v_order_id

    union

    select (selected.match)[1]::bigint
    from public.order_items item
    cross join lateral regexp_matches(
      coalesce(item.notes, ''),
      E'@sel\\|([1-9][0-9]*)\\|',
      'g'
    ) selected(match)
    where item.order_id = v_order_id
  ) candidate;

  perform app_private.counter_assert_commercial_products_sellable_v1(
    app_private.inventory_order_effective_at_v1(v_order_id),
    v_product_ids
  );

  return v_result;
end;
$$;

revoke all on function public.counter_create_direct_sale(uuid, jsonb)
  from public, anon;
grant execute on function public.counter_create_direct_sale(uuid, jsonb)
  to authenticated, service_role;

comment on function public.counter_create_direct_sale(uuid, jsonb) is
'Creates a Counter sale and atomically rejects products commercially suspended by Master for the requested date.';

alter function public.counter_change_pickup_items(uuid, bigint, jsonb, jsonb, text)
  rename to counter_change_pickup_items_without_commercial_guard_v1;

revoke all on function public.counter_change_pickup_items_without_commercial_guard_v1(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) from public, anon, authenticated, service_role;

comment on function public.counter_change_pickup_items_without_commercial_guard_v1(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) is
'Internal legacy implementation. Call counter_change_pickup_items so additions and increases honor commercial suspension.';

create function public.counter_change_pickup_items(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_existing_items jsonb,
  p_added_items jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_product_ids bigint[];
begin
  if v_uid is null
     or not (public.has_role('counter') or public.is_master_or_admin())
  then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  -- A retry of an already completed edit must return its original result.
  if exists (
    select 1
    from public.counter_command_receipts receipt
    where receipt.actor_user_id = v_uid
      and receipt.command_type = 'change_pickup_items'
      and receipt.idempotency_key = p_idempotency_key
      and receipt.status = 'completed'
      and receipt.result_payload is not null
  ) then
    return public.counter_change_pickup_items_without_commercial_guard_v1(
      p_idempotency_key,
      p_order_id,
      p_existing_items,
      p_added_items,
      p_reason
    );
  end if;

  select array_agg(distinct candidate.product_id order by candidate.product_id)
  into v_product_ids
  from (
    select (added.value ->> 'product_id')::bigint as product_id
    from jsonb_array_elements(coalesce(p_added_items, '[]'::jsonb)) added(value)
    where added.value ->> 'product_id' ~ '^[1-9][0-9]*$'

    union

    select (selected.match)[1]::bigint
    from jsonb_array_elements(coalesce(p_added_items, '[]'::jsonb)) added(value)
    cross join lateral regexp_matches(
      coalesce(added.value ->> 'notes', ''),
      E'@sel\\|([1-9][0-9]*)\\|',
      'g'
    ) selected(match)

    union

    select item.product_id
    from jsonb_array_elements(coalesce(p_existing_items, '[]'::jsonb)) submitted(value)
    join public.order_items item
      on item.id = case
        when submitted.value ->> 'item_id' ~ '^[1-9][0-9]*$'
          then (submitted.value ->> 'item_id')::bigint
        else null
      end
     and item.order_id = p_order_id
    where case
      when submitted.value ->> 'qty' ~ '^[0-9]+([.][0-9]+)?$'
        then (submitted.value ->> 'qty')::numeric
      else null
    end > item.qty
  ) candidate;

  if coalesce(cardinality(v_product_ids), 0) > 0 then
    perform app_private.counter_assert_commercial_products_sellable_v1(
      app_private.inventory_order_effective_at_v1(p_order_id),
      v_product_ids
    );
  end if;

  return public.counter_change_pickup_items_without_commercial_guard_v1(
    p_idempotency_key,
    p_order_id,
    p_existing_items,
    p_added_items,
    p_reason
  );
end;
$$;

revoke all on function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) from public, anon;
grant execute on function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) to authenticated, service_role;

comment on function public.counter_change_pickup_items(
  uuid,
  bigint,
  jsonb,
  jsonb,
  text
) is
'Changes a pickup while atomically rejecting newly added or increased products suspended by Master; existing quantities may still be reduced.';
