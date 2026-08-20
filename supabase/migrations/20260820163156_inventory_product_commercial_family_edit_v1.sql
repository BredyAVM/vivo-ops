-- Canonical commercial-family editing for existing inventory products.
-- Reuses products.type and keeps physical inventory topology untouched.

create or replace function public.inventory_update_product_identity_v1(
  p_configuration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_product public.products%rowtype;
  v_product_id bigint;
  v_product_type text;
  v_name text;
  v_sku text;
  v_units_per_service integer;
  v_allows_half_service boolean;
  v_is_temporary boolean;
  v_detail_units_limit integer;
  v_source_price_amount numeric;
  v_source_price_currency text;
  v_commission_mode text;
  v_commission_value numeric;
  v_commission_notes text;
  v_advisor_gift_cost_usd numeric;
  v_advisor_gift_cost_provided boolean := false;
  v_internal_rider_pay_usd numeric;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede modificar productos.' using errcode = '42501';
  end if;
  if p_configuration is null or pg_catalog.jsonb_typeof(p_configuration) <> 'object' then
    raise exception 'La configuración del producto debe ser un objeto.' using errcode = '22023';
  end if;
  if pg_column_size(p_configuration) > 32768 then
    raise exception 'La configuración supera el tamaño permitido.' using errcode = '22023';
  end if;

  v_product_id := nullif(pg_catalog.btrim(coalesce(p_configuration ->> 'product_id', '')), '')::bigint;
  if v_product_id is null then
    raise exception 'product_id es obligatorio.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-product:' || v_product_id::text, 0)
  );

  select product.*
  into v_product
  from public.products product
  where product.id = v_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado.' using errcode = 'P0002';
  end if;
  if not v_product.is_active then
    raise exception 'Este formulario solo modifica productos activos. Los borradores se editan antes de activarlos.'
      using errcode = '22023';
  end if;

  v_product_type := case
    when p_configuration ? 'product_type'
      then pg_catalog.lower(pg_catalog.btrim(coalesce(p_configuration ->> 'product_type', '')))
    else v_product.type::text
  end;
  v_name := pg_catalog.btrim(coalesce(p_configuration ->> 'name', ''));
  v_sku := pg_catalog.upper(pg_catalog.btrim(coalesce(p_configuration ->> 'sku', '')));
  v_units_per_service := nullif(
    pg_catalog.btrim(coalesce(p_configuration ->> 'units_per_service', '')),
    ''
  )::integer;
  v_allows_half_service := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_configuration ->> 'allows_half_service', '')), '')::boolean,
    false
  );
  v_is_temporary := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_configuration ->> 'is_temporary', '')), '')::boolean,
    false
  );
  v_detail_units_limit := nullif(
    pg_catalog.btrim(coalesce(p_configuration ->> 'detail_units_limit', '')),
    ''
  )::integer;
  v_source_price_amount := case
    when p_configuration ? 'source_price_amount'
      then nullif(pg_catalog.btrim(coalesce(p_configuration ->> 'source_price_amount', '')), '')::numeric
    else v_product.source_price_amount
  end;
  v_source_price_currency := case
    when p_configuration ? 'source_price_currency'
      then pg_catalog.upper(pg_catalog.btrim(coalesce(p_configuration ->> 'source_price_currency', '')))
    else v_product.source_price_currency::text
  end;
  v_commission_mode := case
    when p_configuration ? 'commission_mode'
      then pg_catalog.lower(pg_catalog.btrim(coalesce(p_configuration ->> 'commission_mode', '')))
    else v_product.commission_mode
  end;
  v_commission_value := case
    when p_configuration ? 'commission_value'
      then nullif(pg_catalog.btrim(coalesce(p_configuration ->> 'commission_value', '')), '')::numeric
    else v_product.commission_value
  end;
  v_commission_notes := case
    when p_configuration ? 'commission_notes'
      then nullif(pg_catalog.btrim(coalesce(p_configuration ->> 'commission_notes', '')), '')
    else v_product.commission_notes
  end;
  v_advisor_gift_cost_provided := p_configuration ? 'advisor_gift_cost_usd';
  if v_advisor_gift_cost_provided then
    v_advisor_gift_cost_usd := nullif(
      pg_catalog.btrim(coalesce(p_configuration ->> 'advisor_gift_cost_usd', '')),
      ''
    )::numeric;
  end if;
  v_internal_rider_pay_usd := case
    when p_configuration ? 'internal_rider_pay_usd'
      then nullif(pg_catalog.btrim(coalesce(p_configuration ->> 'internal_rider_pay_usd', '')), '')::numeric
    else v_product.internal_rider_pay_usd
  end;

  if v_product_type not in ('product', 'combo', 'service', 'promo', 'gambit') then
    raise exception 'La familia comercial no es válida.' using errcode = '22023';
  end if;
  if v_name = '' or char_length(v_name) > 160 then
    raise exception 'El nombre es obligatorio y admite hasta 160 caracteres.' using errcode = '22023';
  end if;
  if v_sku = '' or char_length(v_sku) > 64 or v_sku !~ '^[A-Z0-9][A-Z0-9._-]*$' then
    raise exception 'El SKU solo admite letras, números, punto, guion y guion bajo.' using errcode = '22023';
  end if;
  if v_units_per_service is null or v_units_per_service < 0 then
    raise exception 'Las unidades por servicio deben ser un entero mayor o igual a cero.' using errcode = '22023';
  end if;
  if v_detail_units_limit is null or v_detail_units_limit < 0 then
    raise exception 'El límite seleccionable debe ser un entero mayor o igual a cero.' using errcode = '22023';
  end if;
  if v_source_price_amount is null or v_source_price_amount < 0
    or v_source_price_currency not in ('USD', 'VES')
  then
    raise exception 'El precio fuente no es válido.' using errcode = '22023';
  end if;
  if v_commission_mode not in ('default', 'fixed_item', 'fixed_order') then
    raise exception 'La modalidad de comisión no es válida.' using errcode = '22023';
  end if;
  if v_commission_mode = 'default' then
    v_commission_value := null;
  elsif v_commission_value is null
    or v_commission_value < 0
    or v_commission_value > 100
  then
    raise exception 'La comisión específica debe ser un porcentaje entre 0 y 100.'
      using errcode = '22023';
  end if;
  if v_commission_notes is not null and char_length(v_commission_notes) > 1000 then
    raise exception 'La nota de comisión admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;
  if v_advisor_gift_cost_usd is not null and v_advisor_gift_cost_usd < 0 then
    raise exception 'El costo para el asesor no puede ser negativo.' using errcode = '22023';
  end if;
  if v_internal_rider_pay_usd is not null and v_internal_rider_pay_usd < 0 then
    raise exception 'El pago interno de delivery no puede ser negativo.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.products product
    where product.sku = v_sku
      and product.id <> v_product_id
  ) then
    raise exception 'Ya existe otro producto con ese SKU.' using errcode = '23505';
  end if;

  update public.products
  set type = v_product_type::public.product_type,
      is_combo = (v_product_type = 'combo'),
      name = v_name,
      sku = v_sku,
      units_per_service = v_units_per_service,
      allows_half_service = v_allows_half_service,
      is_temporary = v_is_temporary,
      detail_units_limit = v_detail_units_limit,
      source_price_amount = v_source_price_amount,
      source_price_currency = v_source_price_currency::public.currency_code,
      commission_mode = v_commission_mode,
      commission_value = v_commission_value,
      commission_notes = v_commission_notes,
      extra_fields = case
        when not v_advisor_gift_cost_provided then coalesce(extra_fields, '{}'::jsonb)
        when v_advisor_gift_cost_usd is null
          then coalesce(extra_fields, '{}'::jsonb) - 'advisor_gift_cost_usd'
        else pg_catalog.jsonb_set(
          coalesce(extra_fields, '{}'::jsonb),
          '{advisor_gift_cost_usd}',
          pg_catalog.to_jsonb(v_advisor_gift_cost_usd),
          true
        )
      end,
      internal_rider_pay_usd = v_internal_rider_pay_usd
  where id = v_product_id;

  return pg_catalog.jsonb_build_object(
    'status', 'updated',
    'product_id', v_product_id,
    'product_name', v_name,
    'previous_product_type', v_product.type::text,
    'product_type', v_product_type,
    'previous_source_price_amount', v_product.source_price_amount,
    'previous_source_price_currency', v_product.source_price_currency,
    'source_price_amount', v_source_price_amount,
    'source_price_currency', v_source_price_currency,
    'historical_order_names_preserved', true,
    'inventory_topology_changed', false
  );
end;
$$;

revoke all on function public.inventory_update_product_identity_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_update_product_identity_v1(jsonb)
  to authenticated, service_role;

comment on function public.inventory_update_product_identity_v1(jsonb) is
  'Admin-only integrated edit of an active product identity, commercial family, and commercial terms. It never changes components, inventory policy, links, stock, or historical order snapshots.';

do $$
declare
  v_product_id bigint;
  v_link_count integer;
  v_link_quantity numeric;
begin
  select product.id
  into v_product_id
  from public.products product
  where product.sku = 'DEGUSTPF_8'
  for update;

  if v_product_id is null then
    raise exception 'No se encontró DEGUSTPF_8 para corregir su familia comercial.';
  end if;

  select count(*)::integer, coalesce(sum(link.quantity_units), 0)
  into v_link_count, v_link_quantity
  from public.product_inventory_links link
  where link.product_id = v_product_id
    and link.configuration_version = 1;

  if v_link_count <> 5 or v_link_quantity <> 8 then
    raise exception 'La topología física de DEGUSTPF_8 no coincide con las 8 UND crudas verificadas.';
  end if;

  update public.products
  set type = 'gambit'::public.product_type,
      is_combo = false
  where id = v_product_id;
end;
$$;
