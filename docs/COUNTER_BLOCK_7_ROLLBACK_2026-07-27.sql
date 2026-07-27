-- Counter Block 7 rollback.
-- This restores the Block 6 catalog and historical order-item pricing trigger.

begin;

drop function if exists public.counter_create_direct_sale(uuid, jsonb);
drop function if exists public.counter_direct_sale_item_notes(bigint, numeric, text, jsonb);

create or replace function public.trg_order_items_set_pricing()
returns trigger
language plpgsql
as $function$
declare
  v_product record;
  v_unit_price numeric;
begin
  if new.override_unit_price_usd is not null
     or new.override_reason is not null
     or new.override_approved_by is not null
     or new.override_approved_at is not null then
    if not public.is_admin() then
      raise exception 'Only ADMIN can change item pricing or set an override.';
    end if;
  end if;

  select id, sku, name, base_price_usd
  into v_product
  from public.products
  where id = new.product_id;

  if not found then
    raise exception 'Invalid product_id';
  end if;

  if tg_op = 'INSERT' then
    new.sku_snapshot := v_product.sku;
    new.product_name_snapshot := v_product.name;
    new.unit_price_usd_snapshot := v_product.base_price_usd;
  end if;

  v_unit_price := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);
  new.line_total_usd := coalesce(new.qty, 0) * coalesce(v_unit_price, 0);
  return new;
end;
$function$;

create or replace function public.counter_read_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'products',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'sku', p.sku,
            'name', coalesce(nullif(trim(p.name), ''), 'Producto'),
            'type', p.type::text,
            'sourcePriceCurrency', coalesce(p.source_price_currency::text, 'USD'),
            'sourcePriceAmount', coalesce(p.source_price_amount, 0),
            'basePriceUsd', coalesce(p.base_price_usd, 0),
            'basePriceBs', coalesce(p.base_price_bs, 0),
            'unitsPerService', coalesce(p.units_per_service, 0),
            'isDetailEditable', coalesce(p.is_detail_editable, false),
            'detailUnitsLimit', coalesce(p.detail_units_limit, 0),
            'isComboComponentSelectable', coalesce(p.is_combo_component_selectable, false)
          )
          order by p.name, p.id
        )
        from public.products p
        where p.is_active = true
      ), '[]'::jsonb),
    'components',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', pc.id,
            'parentProductId', pc.parent_product_id,
            'componentProductId', pc.component_product_id,
            'componentMode', pc.component_mode::text,
            'quantity', coalesce(pc.quantity, 0),
            'countsTowardDetailLimit', coalesce(pc.counts_toward_detail_limit, false),
            'isRequired', coalesce(pc.is_required, false),
            'sortOrder', coalesce(pc.sort_order, 0),
            'notes', pc.notes,
            'parentSku', parent.sku,
            'parentName', parent.name,
            'componentSku', component.sku,
            'componentName', coalesce(nullif(trim(component.name), ''), 'Componente'),
            'componentType', component.type::text
          )
          order by pc.parent_product_id, pc.sort_order, pc.id
        )
        from public.product_components pc
        join public.products parent
          on parent.id = pc.parent_product_id
         and parent.is_active = true
        join public.products component on component.id = pc.component_product_id
      ), '[]'::jsonb)
  )
  into v_payload;

  return v_payload;
end;
$function$;

revoke all on function public.counter_read_catalog() from public, anon;
grant execute on function public.counter_read_catalog() to authenticated, service_role;

alter table public.counter_command_receipts
  drop constraint if exists counter_command_receipts_type_ck;

alter table public.counter_command_receipts
  add constraint counter_command_receipts_type_ck
  check (
    command_type = any (
      array[
        'apply_order_payments',
        'record_manual_movement',
        'request_refund',
        'decide_authorization',
        'execute_refund',
        'dispatch_delivery',
        'record_delivery_return',
        'complete_delivery_digital_change',
        'close_money_account',
        'update_pickup_schedule',
        'change_pickup_items',
        'decide_pickup_change',
        'complete_pickup'
      ]::text[]
    )
  );

drop index if exists public.clients_normalized_phone_uk;
drop function if exists public.counter_normalize_phone(text);
drop table if exists public.order_discount_rules;

commit;
