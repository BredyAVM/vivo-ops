-- Metadata-only amendment: reuses the existing commission adjustment ledger.
-- No delivery reversal, price mutation, payment mutation or inventory movement.
create or replace function public.save_delivered_order_commissions_v1(
  p_order_id bigint,
  p_expected_last_modified_at timestamptz,
  p_changes jsonb,
  p_reason text
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_date date;
  v_period record;
  v_closure record;
  v_change jsonb;
  v_item record;
  v_previous jsonb;
  v_admin jsonb;
  v_event jsonb;
  v_schedule jsonb;
  v_terms jsonb;
  v_fixed numeric;
  v_seen bigint[] := '{}';
  v_closures jsonb := '[]';
  v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not public.has_role('admin') then
    raise exception 'Esta acción requiere permisos de administración.';
  end if;
  if nullif(btrim(p_reason), '') is null or length(btrim(p_reason)) > 500 then
    raise exception 'Indica un motivo de hasta 500 caracteres.';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'Los ajustes deben ser una lista de productos.';
  end if;
  if jsonb_array_length(p_changes) not between 1 and 200 then
    raise exception 'Selecciona entre 1 y 200 productos para ajustar.';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.status::text <> 'delivered' then
    raise exception 'Este ajuste solo está disponible para pedidos entregados.';
  end if;
  if v_order.last_modified_at is distinct from p_expected_last_modified_at then
    raise exception 'El pedido cambió. Recarga sus comisiones antes de guardar.';
  end if;
  select f.delivery_reference_date into v_date
    from public.get_order_financial_state(p_order_id, null, null) f;
  v_date := coalesce(v_date, (v_order.created_at at time zone 'America/Caracas')::date);

  -- Lock the containing periods and closure rows while validating and appending.
  -- Snapshot membership also protects orders later reassigned to another advisor.
  for v_period in
    select p.id, p.status from public.advisor_commission_periods p
    where v_date between p.date_from and p.date_to
       or exists (select 1 from public.advisor_commission_closures c
          where c.period_id = p.id and c.snapshot->'orders' @> jsonb_build_array(jsonb_build_object('orderId', p_order_id)))
    order by p.id for update
  loop
    if v_period.status <> 'open' then
      raise exception 'El período está cerrado. Rectifica la liquidación antes de ajustar esta comisión.';
    end if;
    for v_closure in
      select c.* from public.advisor_commission_closures c
      where c.period_id = v_period.id and
        (c.advisor_user_id = v_order.attributed_advisor_id
          or c.snapshot->'orders' @> jsonb_build_array(jsonb_build_object('orderId', p_order_id)))
      order by c.id for update
    loop
      if v_closure.status <> 'preliminary' or v_closure.closed_at is not null or v_closure.paid_at is not null
         or v_closure.snapshot #>> '{commissionWorkflow,conformity,status}' = 'confirmed'
         or exists (select 1 from public.money_movements m where m.status = 'confirmed'
           and m.direction = 'outflow' and m.movement_type = 'expense_payment'
           and m.description like 'Liquidación de comisión · Cierre ' || v_closure.id || ' ·%') then
        raise exception 'La liquidación está confirmada o tiene pagos. Rectifícala antes de ajustar esta comisión.';
      end if;
      v_closures := v_closures || jsonb_build_array(jsonb_build_object('id', v_closure.id, 'periodId', v_period.id));
    end loop;
  end loop;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    if jsonb_typeof(v_change->'itemId') is distinct from 'number'
       or (v_change->>'itemId') !~ '^[1-9][0-9]*$' then
      raise exception 'El producto del ajuste no es válido.';
    end if;
    select id, product_id, product_name_snapshot into v_item
      from public.order_items where id = (v_change->>'itemId')::bigint and order_id = p_order_id;
    if not found or v_item.id = any(v_seen) then
      raise exception 'El producto no pertenece al pedido o está repetido.';
    end if;
    v_seen := array_append(v_seen, v_item.id);
    if coalesce(v_change->>'action', '') not in ('set', 'clear') then
      raise exception 'La acción de comisión no es válida.';
    end if;
    if v_change->>'action' = 'set' then
      if coalesce(v_change->>'mode', '') not in ('default', 'fixed_item', 'fixed_order', 'none') then
        raise exception 'El tipo de comisión especial no es válido.';
      end if;
      if v_change->>'mode' in ('fixed_item', 'fixed_order') then
        if jsonb_typeof(v_change->'value') is distinct from 'number' then
          raise exception 'El porcentaje de comisión es obligatorio.';
        end if;
        if (v_change->>'value')::numeric not between 0 and 100 then
          raise exception 'El porcentaje de comisión debe estar entre 0 y 100.';
        end if;
      end if;
    end if;
    select jsonb_build_object('id', a.id, 'action', a.payload->>'action',
      'commission_mode', a.payload->>'commission_mode', 'commission_value', a.payload->'commission_value')
      into v_previous from public.order_admin_adjustments a
      where a.order_id = p_order_id and a.order_item_id = v_item.id and a.adjustment_type = 'other'
        and a.payload->>'kind' = 'order_commission_terms'
      order by a.created_at desc, a.id desc limit 1;
    insert into public.order_admin_adjustments
      (order_id, order_item_id, adjustment_type, reason, payload, created_by_user_id, created_at)
    values (p_order_id, v_item.id, 'other', btrim(p_reason), jsonb_build_object(
      'kind', 'order_commission_terms', 'schema_version', 1, 'source', 'admin_delivered_order_editor',
      'action', v_change->>'action', 'product_id', v_item.product_id, 'product_name', v_item.product_name_snapshot,
      'commission_mode', case when v_change->>'action' = 'set' then v_change->>'mode' else null end,
      'commission_value', case when v_change->>'action' = 'set' and v_change->>'mode' in ('fixed_item', 'fixed_order') then v_change->'value' else 'null'::jsonb end,
      'previous_admin_adjustment', v_previous
    ), auth.uid(), v_now);
  end loop;

  -- Check resulting effective terms, including existing event and dated catalog
  -- rules. Two conflicting whole-order rates would produce ambiguous payouts.
  for v_item in
    select i.id, p.commission_mode, p.commission_value, p.extra_fields
    from public.order_items i left join public.products p on p.id = i.product_id where i.order_id = p_order_id
  loop
    select a.payload into v_admin from public.order_admin_adjustments a
      where a.order_id = p_order_id and a.order_item_id = v_item.id and a.adjustment_type = 'other'
        and a.payload->>'kind' = 'order_commission_terms'
      order by a.created_at desc, a.id desc limit 1;
    select a.payload into v_event from public.order_admin_adjustments a
      where a.order_id = p_order_id and a.order_item_id = v_item.id and a.adjustment_type = 'other'
        and a.payload->>'kind' = 'event_commercial_terms'
      order by a.created_at desc, a.id desc limit 1;
    select s.value into v_schedule from jsonb_array_elements(
      case when jsonb_typeof(v_item.extra_fields->'commission_schedule_v1') = 'array'
        then v_item.extra_fields->'commission_schedule_v1' else '[]'::jsonb end) s
      where coalesce(s.value->>'effective_from', s.value->>'effectiveFrom') <= v_date::text
      order by coalesce(s.value->>'effective_from', s.value->>'effectiveFrom') desc limit 1;
    v_terms := case when v_admin is not null and coalesce(v_admin->>'action', 'set') <> 'clear' then v_admin
      when v_event is not null then v_event
      else jsonb_build_object('commission_mode', coalesce(v_schedule->>'mode', v_item.commission_mode),
        'commission_value', coalesce(v_schedule->'value', to_jsonb(v_item.commission_value))) end;
    if v_terms->>'commission_mode' = 'fixed_order' then
      if v_fixed is not null and v_fixed <> (v_terms->>'commission_value')::numeric then
        raise exception 'Una orden no puede tener dos porcentajes distintos sobre toda la orden.';
      end if;
      v_fixed := (v_terms->>'commission_value')::numeric;
    end if;
  end loop;
  update public.orders set last_modified_at = v_now, last_modified_by = auth.uid() where id = p_order_id;
  return jsonb_build_object('orderId', p_order_id, 'updated', cardinality(v_seen), 'closures', v_closures);
end;
$$;
revoke all on function public.save_delivered_order_commissions_v1(bigint, timestamptz, jsonb, text) from public, anon;
grant execute on function public.save_delivered_order_commissions_v1(bigint, timestamptz, jsonb, text) to authenticated;
