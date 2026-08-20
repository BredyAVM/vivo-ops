-- Preserve automatic issue reconciliation from the latest order-sync trigger
-- while keeping the new physical exit milestone introduced by the previous
-- migration.

create or replace function app_private.inventory_order_sale_cutover_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_operation_id uuid;
  v_sqlstate text;
  v_message text;
  v_detail text;
  v_is_physical_exit boolean;
begin
  v_is_physical_exit := old.status is distinct from new.status
    and (
      (
        new.fulfillment::text = 'delivery'
        and new.status::text in ('out_for_delivery', 'delivered')
      )
      or (
        new.fulfillment::text <> 'delivery'
        and new.status::text = 'delivered'
      )
    );

  if v_is_physical_exit then
    v_actor := coalesce(
      auth.uid(),
      new.last_modified_by,
      new.sent_to_kitchen_by,
      new.created_by_user_id
    );
    v_operation_id := pg_catalog.md5(
      'vivo.inventory.order.sale.v2:' || new.id::text
    )::uuid;

    begin
      if app_private.inventory_catalog_is_ready_v1() then
        perform public.inventory_commit_order_sale_v1(
          v_operation_id,
          new.id,
          case
            when new.fulfillment::text = 'delivery'
              and new.status::text = 'out_for_delivery'
              then pg_catalog.format('Consumo automático al entregar la orden %s al motorizado.', new.id)
            when new.fulfillment::text = 'delivery'
              then pg_catalog.format('Reintento de consumo al confirmar la entrega de la orden %s.', new.id)
            else pg_catalog.format('Consumo automático al retirar la orden %s.', new.id)
          end
        );

        perform app_private.inventory_resolve_order_issue_v1(
          new.id,
          'inventory_sale_sync_failed',
          null,
          null,
          'order_sale_applied'
        );
      end if;
    exception when others then
      get stacked diagnostics
        v_sqlstate = returned_sqlstate,
        v_message = message_text,
        v_detail = pg_exception_detail;

      perform app_private.inventory_record_order_issue_v1(
        new.id,
        'inventory_sale_sync_failed',
        'order_delivery',
        'Salida sin conciliación de inventario',
        'La orden continuó sin bloqueo, pero su salida física requiere conciliación de inventario.',
        'critical',
        v_actor,
        pg_catalog.jsonb_build_object(
          'operation_id', v_operation_id,
          'order_status', new.status::text,
          'fulfillment', new.fulfillment::text,
          'sqlstate', v_sqlstate,
          'error', v_message,
          'detail', nullif(v_detail, '')
        )
      );
    end;
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_sale_cutover_trigger_v1()
  from public, anon, authenticated, service_role;

comment on function app_private.inventory_order_sale_cutover_trigger_v1() is
  'Non-blocking physical-exit trigger. Delivery consumes when handed to the driver, retries at delivered, and resolves prior sale-sync issues after success; pickup consumes at customer collection.';
