-- Append only: never rebuild paid lines or reopen a dispatched order.
create or replace function app_private.master_append_zero_price_gift_v1(
  p_order_id bigint, p_product_id bigint, p_qty numeric,
  p_expected_last_modified_at timestamptz, p_operation_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_product public.products%rowtype;
  v_item public.order_items%rowtype;
  v_event record;
  v_event_id bigint;
  v_resolution jsonb;
  v_line record;
  v_inventory_status text := 'pending_dispatch';
  v_message text;
begin
  if v_actor is null or not public.is_master_or_admin() then
    raise exception 'Solo Máster o Administración pueden agregar este obsequio.' using errcode = '42501';
  end if;
  if p_operation_id is null or p_qty is null or p_qty::text in ('NaN','Infinity','-Infinity')
    or p_qty <= 0 or p_qty <> trunc(p_qty) or length(btrim(coalesce(p_reason,''))) < 4 then
    raise exception 'Indica una cantidad entera positiva y el motivo del obsequio.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('order-edit:' || p_order_id::text, 0));
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'La orden no existe.' using errcode = 'P0002'; end if;

  select payload into v_event from public.order_timeline_events
  where order_id = p_order_id and event_type = 'order_gift_appended'
    and payload ->> 'operation_id' = p_operation_id::text limit 1;
  if found then
    if (v_event.payload ->> 'product_id')::bigint is distinct from p_product_id
      or (v_event.payload ->> 'qty')::numeric is distinct from p_qty then
      raise exception 'Esta solicitud ya fue usada para otro obsequio.' using errcode = '22023';
    end if;
    return v_event.payload || jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if v_order.status::text not in ('created','queued','confirmed','in_kitchen','ready','out_for_delivery') then
    raise exception 'No se pueden agregar obsequios a una orden entregada o cancelada.' using errcode = '55000';
  end if;
  if v_order.last_modified_at is distinct from p_expected_last_modified_at then
    raise exception 'La orden cambió. Cierra el editor y vuelve a abrirlo antes de agregar el obsequio.' using errcode = '40001';
  end if;
  select * into v_product from public.products where id = p_product_id for share;
  if not found or v_product.is_active is not true or v_product.type::text <> 'gambit'
    or coalesce(v_product.extra_fields ->> 'catalog_access_scope','') not in ('advisor_gift','advisor_gift_only')
    or v_product.base_price_usd is distinct from 0::numeric
    or v_product.source_price_amount is distinct from 0::numeric
    or coalesce(v_product.is_detail_editable, false) then
    raise exception 'Selecciona un obsequio activo de precio cero y composición fija.' using errcode = '22023';
  end if;

  -- Existing CRM auto-link/guard, component snapshots and commission rules remain in force.
  insert into public.order_items(order_id, product_id, qty, sku_snapshot, product_name_snapshot,
    unit_price_usd_snapshot, line_total_usd, pricing_origin_currency, pricing_origin_amount,
    unit_price_bs_snapshot, line_total_bs_snapshot)
  values (p_order_id, p_product_id, p_qty, v_product.sku, v_product.name,
    0, 0, v_product.source_price_currency::text, 0, 0, 0)
  returning * into v_item;
  if v_item.line_total_usd is distinct from 0::numeric then
    raise exception 'La jugada exige un cobro. Agrégala desde la configuración de la jugada.' using errcode = '22023';
  end if;
  -- Legacy subtotal triggers run on INSERT: restore the exact paid header (tax/discount included).
  update public.orders set total_usd = v_order.total_usd, total_bs_snapshot = v_order.total_bs_snapshot,
    last_modified_at = clock_timestamp(), last_modified_by = v_actor where id = p_order_id;

  if v_order.status::text = 'out_for_delivery' then
    -- The item trigger can rebuild commitments. Nothing already dispatched remains reserved.
    perform app_private.inventory_close_order_commitments_v1(p_order_id, 'fulfilled', v_actor);
    begin
      if not app_private.inventory_catalog_is_ready_v1() then
        raise exception 'El centro de inventario no está listo para conciliar el obsequio.';
      end if;
      if not exists (select 1 from public.inventory_movements where order_id = p_order_id and movement_type = 'sale_out') then
        -- A previous dispatch failed: retry the canonical whole-order operation once.
        perform public.inventory_commit_order_sale_v1(
          md5('vivo.inventory.order.sale.v2:' || p_order_id::text)::uuid, p_order_id,
          'Conciliación de salida al agregar un obsequio.');
      else
        -- Source attribution selects ONLY the new line, even when another paid Dondy is present.
        v_resolution := app_private.inventory_resolve_order_sale_routes_base_v1(p_order_id);
        for v_line in
          select (line.value ->> 'inventory_item_id')::bigint item_id,
            sum((source.value ->> 'quantity_units')::numeric) quantity_units
          from jsonb_array_elements(v_resolution -> 'lines') line(value)
          cross join lateral jsonb_array_elements(line.value -> 'sources') source(value)
          where (source.value ->> 'order_item_id')::bigint = v_item.id
          group by (line.value ->> 'inventory_item_id')::bigint order by 1
        loop
          if not app_private.inventory_item_is_initialized_v1(v_line.item_id) then
            raise exception 'El ítem del obsequio necesita un conteo de apertura.';
          end if;
          perform app_private.inventory_apply_delta_v1(
            p_operation_id, v_line.item_id, 'sale_out', -v_line.quantity_units,
            'order_delivery', 'Obsequio agregado después de la salida. ' || btrim(p_reason),
            p_order_id, null, v_actor, null);
        end loop;
      end if;
      v_inventory_status := 'applied';
    exception when others then
      get stacked diagnostics v_message = message_text;
      v_inventory_status := 'review_required';
      perform app_private.inventory_record_order_issue_v1(p_order_id, 'inventory_sale_sync_failed',
        'gift_append', 'Obsequio pendiente de conciliación',
        'Se agregó el obsequio sin bloqueo. Su salida de inventario necesita revisión.', 'critical', v_actor,
        jsonb_build_object('operation_id', p_operation_id, 'order_item_id', v_item.id, 'error', v_message));
    end;
  end if;

  insert into public.order_timeline_events(order_id, order_number, event_type, event_group, title,
    message, severity, actor_user_id, payload)
  values(p_order_id, v_order.order_number, 'order_gift_appended', 'order', 'Obsequio agregado',
    format('%s × %s. Sin cambios en el pago. Motivo: %s', p_qty, v_item.product_name_snapshot, btrim(p_reason)),
    'warning', v_actor, jsonb_build_object('operation_id', p_operation_id, 'product_id', p_product_id,
      'qty', p_qty, 'order_item_id', v_item.id, 'inventory_status', v_inventory_status,
      'order_status', v_order.status, 'reason', btrim(p_reason))) returning id into v_event_id;
  insert into public.order_timeline_event_recipients(event_id, target_role, requires_action)
  values (v_event_id, 'kitchen', true);
  if v_order.attributed_advisor_id is not null then
    insert into public.order_timeline_event_recipients(event_id, target_user_id, requires_action)
    values (v_event_id, v_order.attributed_advisor_id, false);
  end if;
  return jsonb_build_object('ok', true, 'order_item_id', v_item.id, 'inventory_status', v_inventory_status);
end;
$$;
revoke all on function app_private.master_append_zero_price_gift_v1(bigint,bigint,numeric,timestamptz,uuid,text) from public, anon;
grant execute on function app_private.master_append_zero_price_gift_v1(bigint,bigint,numeric,timestamptz,uuid,text) to authenticated;

create or replace function public.master_append_zero_price_gift_v1(
  p_order_id bigint, p_product_id bigint, p_qty numeric,
  p_expected_last_modified_at timestamptz, p_operation_id uuid, p_reason text
) returns jsonb language sql security invoker set search_path = '' as $$
  select app_private.master_append_zero_price_gift_v1(p_order_id,p_product_id,p_qty,
    p_expected_last_modified_at,p_operation_id,p_reason);
$$;
revoke all on function public.master_append_zero_price_gift_v1(bigint,bigint,numeric,timestamptz,uuid,text) from public, anon;
grant execute on function public.master_append_zero_price_gift_v1(bigint,bigint,numeric,timestamptz,uuid,text) to authenticated;
