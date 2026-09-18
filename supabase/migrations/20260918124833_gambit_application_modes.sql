-- Configurable discretionary / CRM application using existing products.extra_fields.
-- advisor_gift = BOTH (legacy semantics), advisor_gift_only = discretionary only,
-- crm_only = CRM only, gambit_disabled = neither. No catalog rows are changed.
-- Existing CRM redemption validation, inventory links and commission terms are preserved.
set local lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.inventory_update_product_identity_v1(p_configuration jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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


  if p_configuration ? 'catalog_access_scope' then
    if v_product_type <> 'gambit'
      or coalesce(p_configuration ->> 'catalog_access_scope', '') not in ('advisor_gift', 'advisor_gift_only', 'crm_only', 'gambit_disabled')
      or coalesce(v_product.extra_fields ->> 'catalog_access_scope', '') = 'admin_internal'
    then
      raise exception 'La forma de aplicar la jugada no es válida.' using errcode = '22023';
    end if;
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
      extra_fields = (case
        when not v_advisor_gift_cost_provided then coalesce(extra_fields, '{}'::jsonb)
        when v_advisor_gift_cost_usd is null
          then coalesce(extra_fields, '{}'::jsonb) - 'advisor_gift_cost_usd'
        else pg_catalog.jsonb_set(
          coalesce(extra_fields, '{}'::jsonb),
          '{advisor_gift_cost_usd}',
          pg_catalog.to_jsonb(v_advisor_gift_cost_usd),
          true
        )
      end) || case when p_configuration ? 'catalog_access_scope'
        then pg_catalog.jsonb_build_object('catalog_access_scope', p_configuration ->> 'catalog_access_scope')
        else '{}'::jsonb end,
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
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_save_catalog_draft_v1(p_configuration jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_product jsonb;
  v_product_id bigint;
  v_current public.products%rowtype;
  v_routes jsonb;
  v_commission_mode text;
  v_commission_value numeric;
  v_commission_notes text;
  v_advisor_gift_cost_usd numeric;
  v_advisor_gift_cost_provided boolean := false;
  v_internal_rider_pay_usd numeric;
begin
  v_result := app_private.inventory_save_catalog_draft_core_v1(p_configuration);
  if coalesce(v_result ->> 'entry_kind', '') <> 'product' then
    return v_result;
  end if;

  v_product_id := nullif(v_result ->> 'product_id', '')::bigint;
  v_product := p_configuration -> 'product';
  select product.* into v_current
  from public.products product
  where product.id = v_product_id
  for update;
  if not found then
    raise exception 'Supabase no devolvió el producto configurado.' using errcode = 'P0002';
  end if;

  if v_current.inventory_policy in ('self', 'direct') then
    v_routes := app_private.inventory_normalize_product_routes_v1(
      v_current.id,
      v_current.inventory_policy,
      v_current.allows_half_service,
      case
        when jsonb_typeof(p_configuration -> 'routes') = 'array'
          then p_configuration -> 'routes'
        else app_private.inventory_default_product_routes_v1(v_current.id)
      end,
      false
    );
    update public.products product
    set extra_fields = jsonb_set(
      coalesce(product.extra_fields, '{}'::jsonb),
      '{inventory_routes_v1}',
      v_routes,
      true
    )
    where product.id = v_current.id;
  else
    update public.products product
    set extra_fields = coalesce(product.extra_fields, '{}'::jsonb) - 'inventory_routes_v1'
    where product.id = v_current.id;
    v_routes := '[]'::jsonb;
  end if;

  v_commission_mode := case
    when v_product ? 'commission_mode' then lower(btrim(coalesce(v_product ->> 'commission_mode', '')))
    else v_current.commission_mode
  end;
  v_commission_value := case
    when v_product ? 'commission_value' then nullif(btrim(coalesce(v_product ->> 'commission_value', '')), '')::numeric
    else v_current.commission_value
  end;
  v_commission_notes := case
    when v_product ? 'commission_notes' then nullif(btrim(coalesce(v_product ->> 'commission_notes', '')), '')
    else v_current.commission_notes
  end;
  v_advisor_gift_cost_provided := v_product ? 'advisor_gift_cost_usd';
  if v_advisor_gift_cost_provided then
    v_advisor_gift_cost_usd := nullif(btrim(coalesce(v_product ->> 'advisor_gift_cost_usd', '')), '')::numeric;
  end if;
  v_internal_rider_pay_usd := case
    when v_product ? 'internal_rider_pay_usd' then nullif(btrim(coalesce(v_product ->> 'internal_rider_pay_usd', '')), '')::numeric
    else v_current.internal_rider_pay_usd
  end;

  if v_commission_mode not in ('default', 'fixed_item', 'fixed_order') then
    raise exception 'La modalidad de comisión no es válida.' using errcode = '22023';
  end if;
  if v_commission_mode = 'default' then
    v_commission_value := null;
  elsif v_commission_value is null or v_commission_value < 0 or v_commission_value > 100 then
    raise exception 'La comisión específica debe ser un porcentaje entre 0 y 100.' using errcode = '22023';
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


  if v_product ? 'catalog_access_scope' then
    if v_current.type::text <> 'gambit'
      or coalesce(v_product ->> 'catalog_access_scope', '') not in ('advisor_gift', 'advisor_gift_only', 'crm_only', 'gambit_disabled')
      or coalesce(v_current.extra_fields ->> 'catalog_access_scope', '') = 'admin_internal'
    then
      raise exception 'La forma de aplicar la jugada no es válida.' using errcode = '22023';
    end if;
  end if;

  update public.products product
  set commission_mode = v_commission_mode,
      commission_value = v_commission_value,
      commission_notes = v_commission_notes,
      extra_fields = (case
        when not v_advisor_gift_cost_provided then coalesce(product.extra_fields, '{}'::jsonb)
        when v_advisor_gift_cost_usd is null then coalesce(product.extra_fields, '{}'::jsonb) - 'advisor_gift_cost_usd'
        else jsonb_set(coalesce(product.extra_fields, '{}'::jsonb), '{advisor_gift_cost_usd}', to_jsonb(v_advisor_gift_cost_usd), true)
      end) || case when v_product ? 'catalog_access_scope'
        then pg_catalog.jsonb_build_object('catalog_access_scope', v_product ->> 'catalog_access_scope')
        else '{}'::jsonb end,
      internal_rider_pay_usd = v_internal_rider_pay_usd
  where product.id = v_product_id;

  return v_result || jsonb_build_object(
    'commission_mode', v_commission_mode,
    'commission_value', v_commission_value,
    'advisor_gift_cost_usd', v_advisor_gift_cost_usd,
    'internal_rider_pay_usd', v_internal_rider_pay_usd,
    'route_count', jsonb_array_length(v_routes)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_order_item_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  product_row record;
  order_row record;
  member_row record;
  benefit_row record;
  upgrade_row record;
  expected_product_id bigint;
  expected_quantity numeric;
  expected_line_total_usd numeric := 0;
  expected_unit_price_usd numeric := 0;
  is_crm_item boolean;
  is_existing_redemption boolean := false;
begin
  select
    product.id,
    product.type::text as product_type,
    product.extra_fields,
    product.base_price_usd,
    product.source_price_amount,
    product.is_active
  into product_row
  from public.products product
  where product.id = new.product_id;

  if product_row.id is null or not coalesce(product_row.is_active, false) then
    raise exception 'El producto ya no está disponible en el catálogo.' using errcode = '22023';
  end if;

  select
    order_data.id,
    order_data.client_id,
    order_data.attributed_advisor_id,
    order_data.source::text as source,
    nullif(order_data.extra_fields #>> '{pricing,fx_rate}', '')::numeric as fx_rate
  into order_row
  from public.orders order_data
  where order_data.id = new.order_id;

  if order_row.id is null then
    raise exception 'La orden no existe.' using errcode = 'P0002';
  end if;

  is_crm_item := new.crm_play_member_id is not null
    or new.crm_play_benefit_id is not null
    or new.crm_play_benefit_upgrade_id is not null;

  if not is_crm_item then
    if coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') in ('advisor_gift', 'advisor_gift_only') then
      -- Discretionary client gifts are not CRM redemptions. Catalog metadata is
      -- administration-owned; membership and first-purchase gates do not apply.
      if caller_role <> 'service_role' and (
        caller_id is null
        or not (
          public.is_master_or_admin()
          or (public.has_role('counter') and order_row.source = 'walk_in')
          or (public.has_role('advisor') and caller_id is not distinct from order_row.attributed_advisor_id)
        )
      ) then
        raise exception 'Solo el asesor adjudicado, master o administrador pueden aplicar este obsequio.'
          using errcode = '42501';
      end if;

      -- Paid strategies retain canonical catalog pricing. Zero-price gifts stay zero.
      if coalesce(product_row.source_price_amount, product_row.base_price_usd, 0) = 0 then
      if coalesce(new.admin_price_override_usd, 0) <> 0
        or coalesce(new.override_unit_price_usd, 0) <> 0
      then
        raise exception 'El obsequio debe conservar precio cero; use el producto de venta para cobrarlo.'
          using errcode = '22023';
      end if;
      if coalesce(new.qty, 0) <= 0 then
        raise exception 'La cantidad del obsequio debe ser mayor que cero.' using errcode = '22023';
      end if;

      new.pricing_origin_currency := 'USD';
      new.pricing_origin_amount := 0;
      new.unit_price_usd_snapshot := 0;
      new.line_total_usd := 0;
      new.unit_price_bs_snapshot := 0;
      new.line_total_bs_snapshot := 0;
      end if;
    elsif (
        product_row.product_type = 'gambit'
        or coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') in ('crm_only', 'gambit_disabled')
      )
    then
      raise exception 'Este beneficio solo puede cargarse desde una jugada activa del cliente.'
        using errcode = '42501';
    end if;
  else
    if new.crm_play_member_id is null or new.crm_play_benefit_id is null then
      raise exception 'La vinculación CRM del producto está incompleta.' using errcode = '22023';
    end if;

    select
      member.id,
      member.play_id,
      member.client_id,
      member.advisor_id_snapshot,
      member.benefit_status,
      play.status as play_status,
      play.starts_at,
      play.ends_at
    into member_row
    from public.crm_play_members member
    join public.crm_plays play on play.id = member.play_id
    where member.id = new.crm_play_member_id;

    if member_row.id is null
      or member_row.client_id is distinct from order_row.client_id
      or member_row.advisor_id_snapshot is distinct from order_row.attributed_advisor_id
    then
      raise exception 'La jugada no corresponde al cliente y asesor de esta orden.' using errcode = '42501';
    end if;

    if caller_id is not null
      and caller_role <> 'service_role'
      and caller_id is distinct from order_row.attributed_advisor_id
      and not public.is_master_or_admin()
    then
      raise exception 'Solo el asesor adjudicado, master o administrador pueden aplicar este beneficio.' using errcode = '42501';
    end if;

    select
      benefit.id,
      benefit.product_id,
      benefit.quantity
    into benefit_row
    from public.crm_play_benefits benefit
    join public.crm_play_member_benefit_selections selection
      on selection.play_member_id = member_row.id
     and selection.play_benefit_id = benefit.id
     and selection.play_id = benefit.play_id
    where benefit.id = new.crm_play_benefit_id
      and benefit.play_id = member_row.play_id;

    if benefit_row.id is null then
      raise exception 'El beneficio no está seleccionado para este cliente.' using errcode = '42501';
    end if;

    expected_product_id := benefit_row.product_id;
    expected_quantity := benefit_row.quantity;
    expected_line_total_usd := 0;

    if new.crm_play_benefit_upgrade_id is not null then
      select
        upgrade.id,
        upgrade.target_product_id,
        upgrade.target_quantity,
        upgrade.customer_difference_usd_snapshot
      into upgrade_row
      from public.crm_play_benefit_upgrades upgrade
      where upgrade.id = new.crm_play_benefit_upgrade_id
        and upgrade.play_benefit_id = benefit_row.id
        and upgrade.play_id = member_row.play_id;

      if upgrade_row.id is null then
        raise exception 'La ampliación no pertenece al beneficio seleccionado.' using errcode = '42501';
      end if;

      expected_product_id := upgrade_row.target_product_id;
      expected_quantity := upgrade_row.target_quantity;
      expected_line_total_usd := coalesce(upgrade_row.customer_difference_usd_snapshot, 0);
    end if;

    if new.product_id is distinct from expected_product_id
      or pg_catalog.abs(coalesce(new.qty, 0) - expected_quantity) > 0.001
    then
      raise exception 'El producto final no corresponde al beneficio o ampliación seleccionada.'
        using errcode = '22023';
    end if;

    select exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = member_row.id
        and redemption.play_benefit_id = benefit_row.id
        and redemption.order_id = new.order_id
        and redemption.status = 'redeemed'
    ) into is_existing_redemption;

    if not is_existing_redemption then
      if coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') in ('advisor_gift_only', 'gambit_disabled', 'admin_internal') then
        raise exception 'El producto no permite uso mediante una jugada del CRM.' using errcode = '42501';
      end if;
      if member_row.play_status <> 'active'
        or (member_row.starts_at is not null and pg_catalog.now() < member_row.starts_at)
        or (member_row.ends_at is not null and pg_catalog.now() >= member_row.ends_at)
        or member_row.benefit_status not in ('available', 'reserved')
      then
        raise exception 'El beneficio de esta jugada ya no está disponible.' using errcode = '55000';
      end if;
    end if;

    expected_line_total_usd := pg_catalog.round(greatest(0, expected_line_total_usd), 2);
    expected_unit_price_usd := case
      when expected_quantity > 0 then pg_catalog.round(expected_line_total_usd / expected_quantity, 2)
      else 0
    end;

    new.pricing_origin_currency := 'USD';
    new.pricing_origin_amount := expected_unit_price_usd;
    new.unit_price_usd_snapshot := expected_unit_price_usd;
    new.line_total_usd := expected_line_total_usd;

    if order_row.fx_rate is not null and order_row.fx_rate > 0 then
      new.unit_price_bs_snapshot := pg_catalog.round(expected_unit_price_usd * order_row.fx_rate, 2);
      new.line_total_bs_snapshot := pg_catalog.round(expected_line_total_usd * order_row.fx_rate, 2);
    end if;
  end if;

  select nullif(pg_catalog.string_agg(clean_line, E'\n' order by line_number), '')
  into new.notes
  from (
    select pg_catalog.btrim(part.line) as clean_line, part.line_number
    from pg_catalog.regexp_split_to_table(coalesce(new.notes, ''), E'\\r?\\n')
      with ordinality as part(line, line_number)
    where pg_catalog.btrim(part.line) <> ''
      and pg_catalog.lower(pg_catalog.btrim(part.line)) not like '@crm|%'
  ) visible_lines;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.counter_read_catalog()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          and coalesce(p.extra_fields ->> 'catalog_access_scope', '') not in ('admin_internal', 'crm_only', 'gambit_disabled')
          and (p.type::text <> 'gambit' or coalesce(p.extra_fields ->> 'catalog_access_scope', '') in ('advisor_gift', 'advisor_gift_only'))
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
        join public.products component
          on component.id = pc.component_product_id
         and (
           component.is_active = true
           or coalesce(component.extra_fields ->> 'inventory_component_only', 'false') = 'true'
           or (pc.component_mode = 'fixed' and pc.is_required = true)
         )
      ), '[]'::jsonb),
    'discountRules',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', rule.id,
            'code', rule.code,
            'name', rule.name,
            'description', rule.description,
            'discountPct', rule.discount_pct,
            'paymentMethodCodes', to_jsonb(rule.payment_method_codes),
            'paymentCurrencies', to_jsonb(rule.payment_currencies),
            'fulfillments', to_jsonb(rule.fulfillments),
            'startsAt', rule.starts_at,
            'endsAt', rule.ends_at
          )
          order by rule.discount_pct, rule.name, rule.id
        )
        from public.order_discount_rules rule
        where rule.is_active = true
          and 'counter'::public.user_role = any(rule.eligible_roles)
          and (rule.starts_at is null or rule.starts_at <= now())
          and (rule.ends_at is null or rule.ends_at > now())
      ), '[]'::jsonb)
  )
  into v_payload;

  return v_payload;
end;
$function$
;
