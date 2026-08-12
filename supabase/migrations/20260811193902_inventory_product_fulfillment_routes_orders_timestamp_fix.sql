-- Follow-up for the existing orders schema: orders tracks last_modified_by
-- but does not expose a generic updated_at column.

create or replace function public.inventory_select_order_item_route_v1(
  p_order_item_id bigint,
  p_route_key text,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_order_item record;
  v_order public.orders%rowtype;
  v_route jsonb;
  v_route_key text := lower(btrim(coalesce(p_route_key, '')));
  v_selection_key text;
  v_selections jsonb;
  v_commitment jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo administración o Máster pueden seleccionar una ruta alternativa.' using errcode = '42501';
  end if;

  select order_item.id, order_item.order_id, order_item.product_id, product.name as product_name
  into v_order_item
  from public.order_items order_item
  join public.products product on product.id = order_item.product_id
  where order_item.id = p_order_item_id;
  if not found then
    raise exception 'La línea de la orden no existe.' using errcode = 'P0002';
  end if;

  select order_row.* into v_order
  from public.orders order_row
  where order_row.id = v_order_item.order_id
  for update;
  if v_order.status in ('delivered'::public.order_status, 'cancelled'::public.order_status) then
    raise exception 'Una orden cerrada no puede cambiar su ruta física.' using errcode = '22023';
  end if;

  select route.value into v_route
  from jsonb_array_elements(app_private.inventory_product_routes_v1(v_order_item.product_id)) route(value)
  where route.value ->> 'key' = v_route_key;
  if not found then
    raise exception 'La ruta seleccionada no existe para este producto.' using errcode = '22023';
  end if;
  if v_route_key <> 'primary' and v_route ->> 'mode' <> 'master_fallback' then
    raise exception 'La ruta seleccionada no admite decisión del Máster.' using errcode = '22023';
  end if;

  v_selection_key := format('%s:%s', v_order_item.id, v_order_item.product_id);
  v_selections := case
    when jsonb_typeof(v_order.extra_fields -> 'inventory_route_selections') = 'object'
      then v_order.extra_fields -> 'inventory_route_selections'
    else '{}'::jsonb
  end;
  v_selections := jsonb_set(v_selections, array[v_selection_key], to_jsonb(v_route_key), true);

  update public.orders order_row
  set extra_fields = jsonb_set(
        coalesce(order_row.extra_fields, '{}'::jsonb),
        '{inventory_route_selections}',
        v_selections,
        true
      ),
      last_modified_by = v_actor
  where order_row.id = v_order.id;

  insert into public.order_timeline_events (
    order_id, order_number, event_type, event_group, title, message,
    severity, actor_user_id, payload
  ) values (
    v_order.id, v_order.order_number, 'inventory_route_selected', 'inventory',
    'Ruta física actualizada',
    format('%s: %s.', v_order_item.product_name, v_route ->> 'name'),
    case when v_route_key = 'primary' then 'info' else 'warning' end,
    v_actor,
    jsonb_strip_nulls(jsonb_build_object(
      'order_item_id', v_order_item.id,
      'product_id', v_order_item.product_id,
      'route_key', v_route_key,
      'route_name', v_route ->> 'name',
      'note', nullif(btrim(coalesce(p_note, '')), '')
    ))
  );

  if v_order.status in (
    'queued'::public.order_status, 'confirmed'::public.order_status,
    'in_kitchen'::public.order_status, 'ready'::public.order_status,
    'out_for_delivery'::public.order_status
  ) and not coalesce(v_order.needs_reapproval, false)
    and not coalesce(v_order.queued_needs_reapproval, false)
  then
    v_commitment := app_private.inventory_materialize_order_commitment_v1(v_order.id, v_actor);
  end if;

  return jsonb_build_object(
    'status', 'selected',
    'order_id', v_order.id,
    'order_item_id', v_order_item.id,
    'product_id', v_order_item.product_id,
    'route_key', v_route_key,
    'route_name', v_route ->> 'name',
    'commitment', v_commitment,
    'orders_blocked', false
  );
end;
$$;

revoke all on function public.inventory_select_order_item_route_v1(bigint,text,text)
  from public, anon;
grant execute on function public.inventory_select_order_item_route_v1(bigint,text,text)
  to authenticated;
