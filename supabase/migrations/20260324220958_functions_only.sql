set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.admin_list_user_roles()
 RETURNS TABLE(user_id uuid, role public.user_role)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can list user roles';
  end if;

  return query
  select ur.user_id, ur.role
  from public.user_roles ur;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apply_current_prices(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can apply current prices.';
  end if;

  -- Activamos bypass de lock SOLO durante este bloque
  perform set_config('app.bypass_lock', 'true', true);

  -- Actualiza snapshots con precio vigente del catálogo
  update public.order_items oi
  set
    unit_price_usd_snapshot = p.base_price_usd,
    line_total_usd = round((oi.qty * p.base_price_usd)::numeric, 2),
    product_name_snapshot = p.name,
    sku_snapshot = p.sku
  from public.products p
  where oi.order_id = p_order_id
    and oi.product_id = p.id;

  -- Recalcula total del pedido (ya tienes recalc_order_total)
  perform public.recalc_order_total(p_order_id);

  -- Apaga bypass
  perform set_config('app.bypass_lock', '', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.approve_order(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_advisor uuid;
  v_order_number text;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can approve orders';
  end if;

  update public.orders o
  set
    status = 'queued',
    needs_reapproval = false,
    review_notes = null
  where o.id = p_order_id
    and o.status = 'created'
  returning o.attributed_advisor_id, o.order_number
  into v_advisor, v_order_number;

  if not found then
    raise exception 'Order % cannot be approved from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'approved',
    auth.uid(),
    jsonb_build_object('order_number', v_order_number)
  );

  -- optional: notify advisor that order is approved (only if you want)
  -- perform public.create_notification(
  --   v_advisor,
  --   p_order_id,
  --   'master_info',
  --   'Pedido aprobado',
  --   'Tu pedido ' || v_order_number || ' fue aprobado y entró en cola.',
  --   '{}'::jsonb
  -- );
end;
$function$;

CREATE OR REPLACE FUNCTION public.assign_external_partner(p_order_id bigint, p_partner_id bigint, p_reference text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_fulfillment public.fulfillment_type;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can assign an external partner';
  end if;

  -- Validar existencia y tipo de fulfillment
  select o.fulfillment
    into v_fulfillment
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment <> 'delivery' then
    raise exception 'Order % is not a delivery order', p_order_id;
  end if;

  -- Asignar partner externo en estados operativos válidos
  update public.orders
  set
    delivery_mode = 'external',
    external_partner_id = p_partner_id,
    external_reference = p_reference,
    -- limpiamos asignación interna para evitar conflictos
    internal_driver_user_id = null
  where id = p_order_id
    and status in ('confirmed', 'in_kitchen', 'ready');

  if not found then
    raise exception 'Order % cannot assign external partner from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'driver_assigned_external',
    auth.uid(),
    jsonb_build_object('external_partner_id', p_partner_id, 'reference', p_reference)
  );

  perform public.close_assign_driver_tasks(p_order_id, auth.uid());
end;
$function$;

CREATE OR REPLACE FUNCTION public.assign_internal_driver(p_order_id bigint, p_driver_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_fulfillment public.fulfillment_type;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can assign an internal driver';
  end if;

  -- Validar existencia y tipo de fulfillment
  select o.fulfillment
    into v_fulfillment
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment <> 'delivery' then
    raise exception 'Order % is not a delivery order', p_order_id;
  end if;

  -- Asignar driver interno en estados operativos válidos
  update public.orders
  set
    delivery_mode = 'internal',
    internal_driver_user_id = p_driver_user_id,
    -- limpiamos asignación externa para evitar conflictos
    external_partner_id = null,
    external_driver_name = null,
    external_driver_phone = null,
    external_reference = null
  where id = p_order_id
    and status in ('confirmed', 'in_kitchen', 'ready');

  if not found then
    raise exception 'Order % cannot assign internal driver from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'driver_assigned_internal',
    auth.uid(),
    jsonb_build_object('driver_user_id', p_driver_user_id)
  );

  perform public.close_assign_driver_tasks(p_order_id, auth.uid());
end;
$function$;

CREATE OR REPLACE FUNCTION public.clear_delivery_assignment(p_order_id bigint, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can clear delivery assignment';
  end if;

  update public.orders
  set
    internal_driver_user_id = null,
    external_partner_id = null,
    external_driver_name = null,
    external_driver_phone = null,
    external_reference = null,
    last_modified_at = now(),
    last_modified_by = auth.uid(),
    review_notes = case
      when p_notes is null or trim(p_notes) = '' then review_notes
      else trim(p_notes)
    end
  where id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.close_assign_driver_tasks(p_order_id bigint, p_done_by uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  update public.tasks
  set
    status = 'done',
    done_at = now()
  where order_id = p_order_id
    and task_type = 'assign_driver'
    and status = 'open';

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'assign_driver_task_closed',
    p_done_by,
    jsonb_build_object('closed', true)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_payment_report(p_report_id bigint, p_confirmed_money_account_id bigint, p_confirmed_currency public.currency_code, p_confirmed_amount numeric, p_movement_date date, p_confirmed_exchange_rate_ves_per_usd numeric DEFAULT NULL::numeric, p_review_notes text DEFAULT NULL::text, p_reference_code text DEFAULT NULL::text, p_counterparty_name text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID;
  v_equiv NUMERIC(12,2);
  v_order_id BIGINT;
  v_status payment_report_status;
  v_movement_id BIGINT;
BEGIN
  IF NOT public.is_master_or_admin() THEN
    RAISE EXCEPTION 'Only master/admin can confirm payment reports';
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_movement_date IS NULL THEN
    RAISE EXCEPTION 'movement_date is required';
  END IF;

  IF p_confirmed_amount IS NULL OR p_confirmed_amount <= 0 THEN
    RAISE EXCEPTION 'confirmed_amount must be > 0';
  END IF;

  -- Lock report to prevent double confirm
  SELECT pr.order_id, pr.status
    INTO v_order_id, v_status
  FROM public.payment_reports pr
  WHERE pr.id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment report not found';
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending reports can be confirmed (current status: %)', v_status;
  END IF;

  -- Confirmed currency/rate/equivalent
  IF p_confirmed_currency = 'USD' THEN
    IF p_confirmed_exchange_rate_ves_per_usd IS NOT NULL THEN
      RAISE EXCEPTION 'exchange_rate must be NULL when currency=USD';
    END IF;
    v_equiv := ROUND(p_confirmed_amount, 2);
  ELSE
    IF p_confirmed_exchange_rate_ves_per_usd IS NULL OR p_confirmed_exchange_rate_ves_per_usd <= 0 THEN
      RAISE EXCEPTION 'exchange_rate_ves_per_usd is required and must be > 0 when currency=VES';
    END IF;
    v_equiv := ROUND(p_confirmed_amount / p_confirmed_exchange_rate_ves_per_usd, 2);
  END IF;

  -- Create confirmed money movement (inflow)
  INSERT INTO public.money_movements (
    movement_date,
    created_by_user_id,
    confirmed_at,
    confirmed_by_user_id,
    direction,
    movement_type,
    money_account_id,
    currency_code,
    amount,
    exchange_rate_ves_per_usd,
    amount_usd_equivalent,
    reference_code,
    counterparty_name,
    description,
    payment_report_id,
    order_id
  ) VALUES (
    p_movement_date,
    v_uid,
    now(),
    v_uid,
    'inflow',
    'order_payment',
    p_confirmed_money_account_id,
    p_confirmed_currency,
    ROUND(p_confirmed_amount, 2),
    p_confirmed_exchange_rate_ves_per_usd,
    v_equiv,
    p_reference_code,
    p_counterparty_name,
    p_description,
    p_report_id,
    v_order_id
  )
  RETURNING id INTO v_movement_id;

  -- Mark report as confirmed + reviewer info + link to movement
  UPDATE public.payment_reports
  SET
    status = 'confirmed',
    reviewed_at = now(),
    reviewed_by_user_id = v_uid,
    review_notes = p_review_notes,
    confirmed_movement_id = v_movement_id
  WHERE id = p_report_id;

  RETURN v_movement_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_payment_report_as_user(p_actor_user_id uuid, p_report_id bigint, p_confirmed_money_account_id bigint, p_confirmed_currency public.currency_code, p_confirmed_amount numeric, p_movement_date date, p_confirmed_exchange_rate_ves_per_usd numeric DEFAULT NULL::numeric, p_review_notes text DEFAULT NULL::text, p_reference_code text DEFAULT NULL::text, p_counterparty_name text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID;
  v_equiv NUMERIC(12,2);
  v_order_id BIGINT;
  v_status payment_report_status;
  v_movement_id BIGINT;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'confirm_payment_report_as_user is Studio-only';
  END IF;

  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;

  v_uid := p_actor_user_id;

  IF p_movement_date IS NULL THEN
    RAISE EXCEPTION 'movement_date is required';
  END IF;

  IF p_confirmed_amount IS NULL OR p_confirmed_amount <= 0 THEN
    RAISE EXCEPTION 'confirmed_amount must be > 0';
  END IF;

  SELECT pr.order_id, pr.status
    INTO v_order_id, v_status
  FROM public.payment_reports pr
  WHERE pr.id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment report not found';
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending reports can be confirmed (current status: %)', v_status;
  END IF;

  IF p_confirmed_currency = 'USD' THEN
    IF p_confirmed_exchange_rate_ves_per_usd IS NOT NULL THEN
      RAISE EXCEPTION 'exchange_rate must be NULL when currency=USD';
    END IF;
    v_equiv := ROUND(p_confirmed_amount, 2);
  ELSE
    IF p_confirmed_exchange_rate_ves_per_usd IS NULL OR p_confirmed_exchange_rate_ves_per_usd <= 0 THEN
      RAISE EXCEPTION 'exchange_rate_ves_per_usd is required and must be > 0 when currency=VES';
    END IF;
    v_equiv := ROUND(p_confirmed_amount / p_confirmed_exchange_rate_ves_per_usd, 2);
  END IF;

  INSERT INTO public.money_movements (
    movement_date,
    created_by_user_id,
    confirmed_at,
    confirmed_by_user_id,
    direction,
    movement_type,
    money_account_id,
    currency_code,
    amount,
    exchange_rate_ves_per_usd,
    amount_usd_equivalent,
    reference_code,
    counterparty_name,
    description,
    payment_report_id,
    order_id
  ) VALUES (
    p_movement_date,
    v_uid,
    now(),
    v_uid,
    'inflow',
    'order_payment',
    p_confirmed_money_account_id,
    p_confirmed_currency,
    ROUND(p_confirmed_amount, 2),
    p_confirmed_exchange_rate_ves_per_usd,
    v_equiv,
    p_reference_code,
    p_counterparty_name,
    p_description,
    p_report_id,
    v_order_id
  )
  RETURNING id INTO v_movement_id;

  UPDATE public.payment_reports
  SET
    status = 'confirmed',
    reviewed_at = now(),
    reviewed_by_user_id = v_uid,
    review_notes = p_review_notes,
    confirmed_movement_id = v_movement_id
  WHERE id = p_report_id;

  RETURN v_movement_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_assign_driver_task(p_order_id bigint, p_eta_minutes integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  insert into public.tasks (task_type, order_id, title, body, due_at)
  values (
    'assign_driver',
    p_order_id,
    'Assign driver for order',
    case
      when p_eta_minutes is null then 'Order is in kitchen. Assign driver (internal/external).'
      else 'Order is in kitchen. ETA ' || p_eta_minutes || ' min. Assign driver (internal/external).'
    end,
    case
      when p_eta_minutes is null then now()
      else now() + (greatest(p_eta_minutes - 5, 0) || ' minutes')::interval
    end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_notification(p_recipient uuid, p_order_id bigint, p_type public.notification_type, p_title text, p_body text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  if p_recipient is null then
    return;
  end if;

  insert into public.notifications (recipient_user_id, order_id, type, title, body, meta)
  values (p_recipient, p_order_id, p_type, p_title, p_body, coalesce(p_meta, '{}'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_payment_report(p_order_id bigint, p_reported_money_account_id bigint, p_reported_currency public.currency_code, p_reported_amount numeric, p_reported_exchange_rate_ves_per_usd numeric DEFAULT NULL::numeric, p_reference_code text DEFAULT NULL::text, p_payer_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID;
  v_ok  BOOLEAN;
  v_equiv NUMERIC(12,2);
  v_report_id BIGINT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_reported_amount IS NULL OR p_reported_amount <= 0 THEN
    RAISE EXCEPTION 'reported_amount must be > 0';
  END IF;

  -- Authorization:
  -- master/admin: can create for any order
  -- advisor: only for own attributed orders
  IF public.is_master_or_admin() THEN
    SELECT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p_order_id)
      INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'Order not found';
    END IF;

  ELSIF public.has_role('advisor') THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = p_order_id
        AND o.attributed_advisor_id = v_uid
    ) INTO v_ok;

    IF NOT v_ok THEN
      RAISE EXCEPTION 'Advisor cannot report payments for this order';
    END IF;

  ELSE
    RAISE EXCEPTION 'Insufficient role to create payment report';
  END IF;

  -- Currency / rate / USD equivalent snapshot
  IF p_reported_currency = 'USD' THEN
    IF p_reported_exchange_rate_ves_per_usd IS NOT NULL THEN
      RAISE EXCEPTION 'exchange_rate must be NULL when currency=USD';
    END IF;
    v_equiv := ROUND(p_reported_amount, 2);
  ELSE
    IF p_reported_exchange_rate_ves_per_usd IS NULL OR p_reported_exchange_rate_ves_per_usd <= 0 THEN
      RAISE EXCEPTION 'exchange_rate_ves_per_usd is required and must be > 0 when currency=VES';
    END IF;
    v_equiv := ROUND(p_reported_amount / p_reported_exchange_rate_ves_per_usd, 2);
  END IF;

  INSERT INTO public.payment_reports (
    order_id,
    status,
    created_by_user_id,
    reported_currency_code,
    reported_amount,
    reported_exchange_rate_ves_per_usd,
    reported_amount_usd_equivalent,
    reported_money_account_id,
    reference_code,
    payer_name,
    notes
  ) VALUES (
    p_order_id,
    'pending',
    v_uid,
    p_reported_currency,
    ROUND(p_reported_amount, 2),
    p_reported_exchange_rate_ves_per_usd,
    v_equiv,
    p_reported_money_account_id,
    p_reference_code,
    p_payer_name,
    p_notes
  )
  RETURNING id INTO v_report_id;

  RETURN v_report_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_active_exchange_rate()
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  select rate_bs_per_usd
  from public.exchange_rates
  where is_active = true
  order by effective_at desc, id desc
  limit 1
$function$;

CREATE OR REPLACE FUNCTION public.get_advisor_profiles()
 RETURNS TABLE(user_id uuid, full_name text, is_active boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    p.id as user_id,
    p.full_name,
    coalesce(p.is_active, true) as is_active
  from public.user_roles ur
  join public.profiles p
    on p.id = ur.user_id
  where ur.role = 'advisor'
  order by p.full_name asc;
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_profiles()
 RETURNS TABLE(user_id uuid, full_name text, is_active boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    p.id as user_id,
    p.full_name,
    coalesce(p.is_active, true) as is_active
  from public.user_roles ur
  join public.profiles p
    on p.id = ur.user_id
  where ur.role = 'driver'
  order by p.full_name asc;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_roles()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select coalesce(array_agg(ur.role::text order by ur.role::text), '{}'::text[])
  from public.user_roles ur
  where ur.user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.has_role(p_role text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role::text = p_role
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.has_role('admin');
$function$;

CREATE OR REPLACE FUNCTION public.is_master()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.has_role('master');
$function$;

CREATE OR REPLACE FUNCTION public.is_master_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select
    -- En la app real (con auth), usamos auth.uid()
    (
      exists (
        select 1
        from public.user_roles ur
        where ur.user_id = auth.uid()
          and ur.role in ('master','admin')
      )
    )
    -- En Supabase Studio normalmente eres postgres/superadmin (permitimos para desarrollo)
    OR current_user in ('postgres', 'supabase_admin');
$function$;

CREATE OR REPLACE FUNCTION public.kitchen_take(p_order_id bigint, p_eta_minutes integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  -- Permite kitchen o master/admin
  if not (
    public.is_master_or_admin()
    or exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.role = 'kitchen'
    )
  ) then
    raise exception 'Only kitchen or master/admin can take an order';
  end if;

  if p_eta_minutes is not null and p_eta_minutes < 0 then
    raise exception 'eta_minutes must be >= 0';
  end if;

  -- Solo debería tomarse cuando ya fue enviado a cocina (confirmed)
  update public.orders
  set
    status = 'in_kitchen',
    eta_minutes = p_eta_minutes,
    kitchen_started_at = now(),
    kitchen_operator_id = coalesce(kitchen_operator_id, auth.uid())
  where id = p_order_id
    and status = 'confirmed';

  if not found then
    raise exception 'Order % cannot be taken by kitchen from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'kitchen_started',
    auth.uid(),
    jsonb_build_object('eta_minutes', p_eta_minutes)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_delivered(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_fulfillment public.fulfillment_type;
  v_status public.order_status;
  v_internal_driver_user_id uuid;
  v_is_kitchen boolean;
  v_is_driver boolean;
begin
  -- Roles del usuario actual
  v_is_kitchen := exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = 'kitchen'
  );

  v_is_driver := exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = 'driver'
  );

  -- Leer orden
  select
    o.fulfillment,
    o.status,
    o.internal_driver_user_id
  into
    v_fulfillment,
    v_status,
    v_internal_driver_user_id
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  -- Permisos por tipo de fulfillment
  if v_fulfillment = 'delivery' then
    -- Delivery: master/admin o driver
    if not (public.is_master_or_admin() or v_is_driver) then
      raise exception 'Only driver or master/admin can mark delivery orders as delivered';
    end if;

    -- Si quieres ser más estricto con driver interno, valida que sea el asignado:
    -- (Para partners externos no hay auth user local necesariamente)
    if v_is_driver and not public.is_master_or_admin() then
      if v_internal_driver_user_id is not null and v_internal_driver_user_id <> auth.uid() then
        raise exception 'This driver is not assigned to order %', p_order_id;
      end if;
    end if;

    -- Estado válido para delivery entregado
    if v_status <> 'out_for_delivery' then
      raise exception 'Delivery order % can only be marked delivered from out_for_delivery', p_order_id;
    end if;

  elsif v_fulfillment = 'pickup' then
    -- Pickup: kitchen o master/admin
    if not (public.is_master_or_admin() or v_is_kitchen) then
      raise exception 'Only kitchen or master/admin can mark pickup orders as delivered (picked up)';
    end if;

    -- Estado válido para pickup retirado
    if v_status <> 'ready' then
      raise exception 'Pickup order % can only be marked delivered from ready', p_order_id;
    end if;

  else
    raise exception 'Unsupported fulfillment type for order %', p_order_id;
  end if;

  -- Marcar entregado / retirado
  update public.orders
  set status = 'delivered'
  where id = p_order_id;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'delivered',
    auth.uid(),
    jsonb_build_object(
      'fulfillment', v_fulfillment,
      'delivered_by_role',
      case
        when public.is_master_or_admin() then 'master_or_admin'
        when v_is_driver then 'driver'
        when v_is_kitchen then 'kitchen'
        else 'unknown'
      end
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_notification_read(p_notification_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  update public.notifications
  set status = 'read',
      read_at = now()
  where id = p_notification_id
    and recipient_user_id = auth.uid();  -- solo el dueño puede marcarla
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_order_modified(p_order_id bigint, p_summary text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status public.order_status;
  v_advisor uuid;
  v_order_number text;
  v_master_recipient uuid;
begin
  -- who can call:
  -- advisor owner OR master/admin
  if not (
    public.is_master_or_admin()
    or exists (
      select 1
      from public.orders o
      where o.id = p_order_id
        and o.attributed_advisor_id = auth.uid()
    )
  ) then
    raise exception 'Not allowed to mark this order as modified';
  end if;

  select o.status, o.attributed_advisor_id, o.order_number, o.sent_to_kitchen_by
  into v_status, v_advisor, v_order_number, v_master_recipient
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  -- Only queued orders can enter "needs_reapproval" cycle
  if v_status <> 'queued' then
    raise exception 'Order % can only be modified-for-review in status queued', p_order_id;
  end if;

  update public.orders
  set
    needs_reapproval = true,
    last_modified_at = now(),
    last_modified_by = auth.uid()
  where id = p_order_id;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'modified',
    auth.uid(),
    jsonb_build_object('summary', coalesce(p_summary, ''), 'order_number', v_order_number)
  );

  -- Notify master/admin: we send to sent_to_kitchen_by if present; otherwise skip.
  -- In your flow, the master that approved is the one to review.
  if v_master_recipient is not null then
    perform public.create_notification(
      v_master_recipient,
      p_order_id,
      'master_info',
      'Pedido modificado (requiere revisión)',
      'El pedido ' || v_order_number || ' fue modificado y requiere aprobación del master.',
      jsonb_build_object('order_id', p_order_id, 'flow', 'reapproval', 'summary', coalesce(p_summary,''))
    );
  end if;

  -- Also optional: notify advisor that it's under review (if you want)
  -- perform public.create_notification(
  --   v_advisor,
  --   p_order_id,
  --   'master_info',
  --   'Pedido en revisión',
  --   'Tus cambios del pedido ' || v_order_number || ' están pendientes de aprobación del master.',
  --   jsonb_build_object('flow','reapproval')
  -- );
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_ready(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_fulfillment public.fulfillment_type;
  v_attributed_advisor_id uuid;
  v_master_recipient uuid;
begin
  if not (
    public.is_master_or_admin()
    or exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.role = 'kitchen'
    )
  ) then
    raise exception 'Only kitchen or master/admin can mark ready';
  end if;

  -- Actualiza solo desde estados válidos y captura datos para notificación
  update public.orders o
  set
    status = 'ready',
    ready_at = now()
  where o.id = p_order_id
    and o.status in ('confirmed', 'in_kitchen')
  returning
    o.fulfillment,
    o.attributed_advisor_id,
    o.sent_to_kitchen_by
  into
    v_fulfillment,
    v_attributed_advisor_id,
    v_master_recipient;

  if not found then
    raise exception 'Order % cannot be marked ready from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (p_order_id, 'ready', auth.uid(), '{}'::jsonb);

  -- Si es pickup, notificar automáticamente a advisor + master
  if v_fulfillment = 'pickup' then
    perform public.create_notification(
      v_attributed_advisor_id,
      p_order_id,
      'advisor_ready',
      'Pedido listo para retiro',
      'Tu pedido pick-up está listo y fue pasado al área de espera/calientador.',
      jsonb_build_object('order_id', p_order_id, 'flow', 'pickup')
    );

    perform public.create_notification(
      v_master_recipient,
      p_order_id,
      'master_info',
      'Pick-up listo',
      'El pedido pick-up fue marcado como listo. Notificar al asesor/cliente para retiro.',
      jsonb_build_object('order_id', p_order_id, 'flow', 'pickup')
    );
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.out_for_delivery(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_fulfillment public.fulfillment_type;
  v_delivery_mode text;
  v_internal_driver_user_id uuid;
  v_external_partner_id bigint;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can set out_for_delivery';
  end if;

  -- Leer y validar orden
  select
    o.fulfillment,
    o.delivery_mode::text,
    o.internal_driver_user_id,
    o.external_partner_id
  into
    v_fulfillment,
    v_delivery_mode,
    v_internal_driver_user_id,
    v_external_partner_id
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_fulfillment <> 'delivery' then
    raise exception 'Order % is not a delivery order', p_order_id;
  end if;

  -- Debe tener asignación válida antes de salir
  if v_delivery_mode = 'internal' and v_internal_driver_user_id is null then
    raise exception 'Order % has delivery_mode=internal but no internal driver assigned', p_order_id;
  end if;

  if v_delivery_mode = 'external' and v_external_partner_id is null then
    raise exception 'Order % has delivery_mode=external but no external partner assigned', p_order_id;
  end if;

  if v_delivery_mode is null then
    raise exception 'Order % has no delivery assignment (delivery_mode is null)', p_order_id;
  end if;

  -- Solo se puede salir a delivery desde READY
  update public.orders
  set status = 'out_for_delivery'
  where id = p_order_id
    and status = 'ready';

  if not found then
    raise exception 'Order % cannot be set out_for_delivery from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'out_for_delivery',
    auth.uid(),
    jsonb_build_object(
      'delivery_mode', v_delivery_mode,
      'internal_driver_user_id', v_internal_driver_user_id,
      'external_partner_id', v_external_partner_id
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.reapprove_queued_order(p_order_id bigint, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can re-approve queued orders';
  end if;

  update public.orders
  set
    queued_needs_reapproval = false,
    -- opcional: guardar nota en orders.notes (si quieres)
    notes = case
      when p_notes is null or trim(p_notes) = '' then notes
      else coalesce(notes,'') || case when notes is null or notes = '' then '' else ' | ' end || 'master_reapprove=' || trim(p_notes)
    end
  where id = p_order_id
    and status = 'queued';

  if not found then
    raise exception 'Order % not found or not in queued status', p_order_id;
  end if;

  insert into public.order_events(order_id, event, performed_by, meta)
  values (
    p_order_id,
    'queued_reapproved',
    auth.uid(),
    jsonb_build_object('notes', p_notes)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.recalc_order_total(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  update public.orders o
  set total_usd = coalesce((
    select sum(oi.line_total_usd)
    from public.order_items oi
    where oi.order_id = p_order_id
  ), 0)
  where o.id = p_order_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.recalc_order_total_usd(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  update public.orders o
  set total_usd = (
    select coalesce(sum(coalesce(oi.line_total_usd, 0)), 0)
    from public.order_items oi
    where oi.order_id = p_order_id
  )
  where o.id = p_order_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reject_payment_report(p_report_id bigint, p_review_notes text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID;
  v_status payment_report_status;
BEGIN
  IF NOT public.is_master_or_admin() THEN
    RAISE EXCEPTION 'Only master/admin can reject payment reports';
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_review_notes IS NULL OR length(trim(p_review_notes)) = 0 THEN
    RAISE EXCEPTION 'review_notes is required to reject a report';
  END IF;

  -- Lock row to avoid races
  SELECT pr.status INTO v_status
  FROM public.payment_reports pr
  WHERE pr.id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment report not found';
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending reports can be rejected (current status: %)', v_status;
  END IF;

  UPDATE public.payment_reports
  SET
    status = 'rejected',
    reviewed_at = now(),
    reviewed_by_user_id = v_uid,
    review_notes = p_review_notes,
    confirmed_movement_id = NULL
  WHERE id = p_report_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_payment_report_as_user(p_actor_user_id uuid, p_report_id bigint, p_review_notes text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID;
  v_status payment_report_status;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'reject_payment_report_as_user is Studio-only';
  END IF;

  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;

  v_uid := p_actor_user_id;

  IF p_review_notes IS NULL OR length(trim(p_review_notes)) = 0 THEN
    RAISE EXCEPTION 'review_notes is required to reject a report';
  END IF;

  SELECT pr.status INTO v_status
  FROM public.payment_reports pr
  WHERE pr.id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment report not found';
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending reports can be rejected (current status: %)', v_status;
  END IF;

  UPDATE public.payment_reports
  SET
    status = 'rejected',
    reviewed_at = now(),
    reviewed_by_user_id = v_uid,
    review_notes = p_review_notes,
    confirmed_movement_id = NULL
  WHERE id = p_report_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.return_to_created(p_order_id bigint, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_status public.order_status;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can return orders to created';
  end if;

  select o.status into v_status
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_status <> 'queued' then
    raise exception 'Order % can only be returned to created from queued. Current status=%', p_order_id, v_status;
  end if;

  update public.orders
  set
    status = 'created',
    queued_needs_reapproval = false,
    queued_last_modified_at = null,
    queued_last_modified_by = null,
    notes = case
      when p_reason is null or trim(p_reason) = '' then notes
      else coalesce(notes,'') ||
        case when notes is null or notes = '' then '' else ' | ' end ||
        'returned_to_created=' || trim(p_reason)
    end
  where id = p_order_id
    and status = 'queued';

  if not found then
    raise exception 'Order % could not be returned to created (status changed)', p_order_id;
  end if;

  insert into public.order_events(order_id, event, performed_by, meta)
  values (
    p_order_id,
    'returned_to_created',
    auth.uid(),
    jsonb_build_object('reason', p_reason)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.review_order_changes(p_order_id bigint, p_approved boolean, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status public.order_status;
  v_needs boolean;
  v_advisor uuid;
  v_order_number text;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can review order changes';
  end if;

  select o.status, o.needs_reapproval, o.attributed_advisor_id, o.order_number
  into v_status, v_needs, v_advisor, v_order_number
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_status <> 'queued' then
    raise exception 'Order % can only be reviewed in status queued', p_order_id;
  end if;

  if v_needs is distinct from true then
    raise exception 'Order % does not require reapproval', p_order_id;
  end if;

  if p_approved then
    update public.orders
    set
      needs_reapproval = false,
      review_notes = null
    where id = p_order_id;

    insert into public.order_events (order_id, event, performed_by, meta)
    values (
      p_order_id,
      'reapproved',
      auth.uid(),
      jsonb_build_object('order_number', v_order_number)
    );

  else
    -- returned to advisor for adjustment (NOT cancelled)
    update public.orders
    set
      needs_reapproval = true,
      review_notes = coalesce(nullif(trim(p_notes),''), 'Devuelto por el master. Ajustar y reenviar.')
    where id = p_order_id;

    insert into public.order_events (order_id, event, performed_by, meta)
    values (
      p_order_id,
      'returned',
      auth.uid(),
      jsonb_build_object('order_number', v_order_number, 'reason', coalesce(p_notes,''))
    );

    -- notify advisor with reason
    perform public.create_notification(
      v_advisor,
      p_order_id,
      'master_info',
      'Pedido devuelto para ajuste',
      'El pedido ' || v_order_number || ' fue devuelto por el master: ' || coalesce(nullif(trim(p_notes),''), 'Ajustar y reenviar.'),
      jsonb_build_object('flow','reapproval','reason',coalesce(p_notes,''))
    );
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.send_to_kitchen(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_fulfillment public.fulfillment_type;
  v_needs boolean;
  v_status public.order_status;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can send to kitchen';
  end if;

  select o.fulfillment, o.queued_needs_reapproval, o.status
    into v_fulfillment, v_needs, v_status
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  -- ✅ BLOQUEO #1: la orden DEBE estar aprobada (queued) antes de cocina
  if v_status <> 'queued' then
    raise exception 'Order % must be in queued (approved) before sending to kitchen. Current status=%', p_order_id, v_status;
  end if;

  -- ✅ BLOQUEO #2: si fue modificada por advisor, requiere re-aprobación
  if v_needs = true then
    raise exception 'Order % requires re-approval before sending to kitchen', p_order_id;
  end if;

  update public.orders
  set
    status = 'confirmed', -- confirmed = enviado a cocina
    sent_to_kitchen_at = now(),
    sent_to_kitchen_by = auth.uid()
  where id = p_order_id
    and status = 'queued';

  if not found then
    raise exception 'Order % cannot be sent to kitchen from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (p_order_id, 'sent_to_kitchen', auth.uid(), '{}'::jsonb);

  -- Si es delivery, crea tarea para asignar driver
  if v_fulfillment = 'delivery' then
    insert into public.tasks (task_type, order_id, title, body, due_at, created_by)
    values (
      'assign_driver',
      p_order_id,
      'Assign driver',
      'Order sent to kitchen. Assign internal/external driver.',
      now(),
      auth.uid()
    );
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_active_exchange_rate(p_rate_bs_per_usd numeric)
 RETURNS public.exchange_rates
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_row public.exchange_rates;
begin
  if p_rate_bs_per_usd is null or p_rate_bs_per_usd <= 0 then
    raise exception 'Rate must be greater than 0';
  end if;

  update public.exchange_rates
  set is_active = false
  where is_active = true;

  insert into public.exchange_rates (
    rate_bs_per_usd,
    is_active
  )
  values (
    p_rate_bs_per_usd,
    true
  )
  returning * into v_row;

  update public.products
  set source_price_amount = source_price_amount
  where id > 0;

  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sync_product_derived_prices()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_rate numeric;
begin
  v_rate := public.get_active_exchange_rate();

  if v_rate is null or v_rate <= 0 then
    raise exception 'No active exchange rate found';
  end if;

  if new.source_price_currency = 'VES' then
    new.base_price_bs := new.source_price_amount;
    new.base_price_usd := round((new.source_price_amount / v_rate)::numeric, 6);
  elsif new.source_price_currency = 'USD' then
    new.base_price_usd := new.source_price_amount;
    new.base_price_bs := round((new.source_price_amount * v_rate)::numeric, 6);
  else
    raise exception 'Unsupported currency';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.tg_order_items_recalc_order_total()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- INSERT
  if (tg_op = 'INSERT') then
    perform public.recalc_order_total_usd(new.order_id);
    return new;
  end if;

  -- DELETE
  if (tg_op = 'DELETE') then
    perform public.recalc_order_total_usd(old.order_id);
    return old;
  end if;

  -- UPDATE
  if (tg_op = 'UPDATE') then
    -- si cambió de order_id (raro, pero posible), recalcula ambos
    if (new.order_id is distinct from old.order_id) then
      perform public.recalc_order_total_usd(old.order_id);
      perform public.recalc_order_total_usd(new.order_id);
    else
      perform public.recalc_order_total_usd(new.order_id);
    end if;

    return new;
  end if;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_delivery_trips_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.delivery_mode = 'internal' then
    if new.internal_driver_user_id is null then
      raise exception 'delivery_trips: internal requires internal_driver_user_id';
    end if;
    new.external_partner_id := null;

  elsif new.delivery_mode = 'external' then
    if new.external_partner_id is null then
      raise exception 'delivery_trips: external requires external_partner_id';
    end if;
    new.internal_driver_user_id := null;

  else
    raise exception 'delivery_trips: invalid delivery_mode';
  end if;

  if new.fee_ves is not null and new.exchange_rate_ves_per_usd is null then
    raise exception 'delivery_trips: fee_ves requires exchange_rate_ves_per_usd';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_order_events_to_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_advisor uuid;
  v_driver uuid;
  v_delivery_mode public.delivery_mode;
  v_eta int;
  v_order_number text;
begin
  -- Traemos info de la orden
  select
    o.attributed_advisor_id,
    o.internal_driver_user_id,  -- ✅ FIX: antes era o.driver_id
    o.delivery_mode,
    o.eta_minutes,
    o.order_number
  into
    v_advisor,
    v_driver,
    v_delivery_mode,
    v_eta,
    v_order_number
  from public.orders o
  where o.id = new.order_id;

  -- 1) Cocina empezó / tomó el pedido -> notifica al asesor (si existe)
  if new.event = 'kitchen_started' then
    perform public.create_notification(
      v_advisor,
      new.order_id,
      'advisor_kitchen_started',
      'Pedido en preparación',
      case
        when v_eta is null then 'Tu pedido ' || v_order_number || ' ya está en cocina.'
        else 'Tu pedido ' || v_order_number || ' ya está en cocina. ETA: ' || v_eta || ' min.'
      end,
      jsonb_build_object('eta_minutes', v_eta)
    );
  end if;

  -- 2) Pedido listo -> notifica asesor + driver interno (si aplica)
  if new.event = 'ready' then
    perform public.create_notification(
      v_advisor,
      new.order_id,
      'advisor_ready',
      'Pedido listo',
      'Tu pedido ' || v_order_number || ' está listo para retirar/coordinar.',
      '{}'::jsonb
    );

    -- Si el delivery es interno y ya hay driver asignado, le notificamos al driver
    if v_delivery_mode = 'internal' then
      perform public.create_notification(
        v_driver,
        new.order_id,
        'driver_ready_pickup',
        'Pedido listo para retirar',
        'Pedido ' || v_order_number || ' está listo. Pasa a retirar en cocina.',
        '{}'::jsonb
      );
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_order_items_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_locked boolean;
  v_product record;
  v_effective_unit numeric;
begin
  -- Find parent order lock state
  select o.is_price_locked
    into v_locked
  from public.orders o
  where o.id = coalesce(new.order_id, old.order_id);

  -- (A) If order is locked -> only master/admin can INSERT/UPDATE/DELETE items
  if v_locked is true then
    if not (public.is_admin() or public.is_master()) then
      raise exception 'Order is price-locked. Only master/admin can edit items.';
    end if;
  end if;

  -- (B) Pricing override ONLY admin (insert or update)
  if tg_op in ('INSERT','UPDATE') then
    if new.override_unit_price_usd is not null
       or new.override_reason is not null
       or new.override_approved_by is not null
       or new.override_approved_at is not null then

      if not public.is_admin() then
        raise exception 'Only ADMIN can change item pricing or set an override.';
      end if;

      -- If admin sets override price, stamp approval if not provided
      if new.override_unit_price_usd is not null then
        if new.override_approved_by is null then
          new.override_approved_by := auth.uid();
        end if;
        if new.override_approved_at is null then
          new.override_approved_at := now();
        end if;
      end if;
    end if;
  end if;

  -- (C) Prevent NON-admin from changing snapshot pricing fields on UPDATE
  if tg_op = 'UPDATE' then
    if not public.is_admin() then
      if new.unit_price_usd_snapshot is distinct from old.unit_price_usd_snapshot
         or new.line_total_usd is distinct from old.line_total_usd then
        raise exception 'Only ADMIN can change item pricing or set an override.';
      end if;
    end if;
  end if;

  -- (D) Fill snapshots + calculate line_total automatically (insert/update)
  if tg_op in ('INSERT','UPDATE') then
    select p.id, p.sku, p.name, p.base_price_usd
      into v_product
    from public.products p
    where p.id = new.product_id;

    if new.sku_snapshot is null then
      new.sku_snapshot := v_product.sku;
    end if;

    if new.product_name_snapshot is null then
      new.product_name_snapshot := v_product.name;
    end if;

    -- If snapshot unit price is null, take current product base_price_usd
    if new.unit_price_usd_snapshot is null then
      new.unit_price_usd_snapshot := v_product.base_price_usd;
    end if;

    -- Effective unit price: override if present (admin-only), else snapshot
    v_effective_unit := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);
    new.line_total_usd := coalesce(new.qty, 0) * coalesce(v_effective_unit, 0);
  end if;

  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_order_items_lock_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_order_id bigint;
  v_locked boolean;
  v_bypass text;
begin
  -- Bypass controlado (para función de recalcular precios)
  v_bypass := current_setting('app.bypass_lock', true);
  if v_bypass = 'true' then
    return coalesce(new, old);
  end if;

  v_order_id := coalesce(new.order_id, old.order_id);

  select o.is_price_locked into v_locked
  from public.orders o
  where o.id = v_order_id;

  if v_locked then
    -- Solo master/admin puede tocar items si está locked
    if not public.is_master_or_admin() then
      raise exception 'Order is price-locked. Only master/admin can edit items.';
    end if;

    -- Aún siendo master/admin: si quieres, puedes permitir todo.
    -- Pero por seguridad, mantenemos el criterio: cambios estructurales requieren intención.
    -- (Si prefieres permitir todo a master/admin, dime y lo abrimos.)
  end if;

  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_order_items_pricing_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_effective_price numeric(12,2);
  v_price_fields_changed boolean;
  v_product_price numeric(12,2);
begin
  -- 1) En INSERT: si NO es admin, el precio snapshot lo define el sistema
  if tg_op = 'INSERT' then
    if not public.is_admin() then
      -- Tomar el precio desde products
      select round(coalesce(p.base_price_usd, 0)::numeric, 2)
        into v_product_price
      from public.products p
      where p.id = new.product_id;

      if not found then
        raise exception 'Product % not found for order item insert', new.product_id;
      end if;

      -- Forzamos snapshot (ignoramos cualquier valor que venga del frontend)
      new.unit_price_usd_snapshot := v_product_price;

      -- No-admin NO puede insertar overrides
      new.override_unit_price_usd := null;
      new.override_reason := null;
      new.override_approved_by := null;
      new.override_approved_at := null;
    else
      -- Admin: puede insertar snapshot manual si quiere
      -- (si viene null, intentamos rellenarlo desde products)
      if new.unit_price_usd_snapshot is null then
        select round(coalesce(p.base_price_usd, 0)::numeric, 2)
          into v_product_price
        from public.products p
        where p.id = new.product_id;

        if not found then
          raise exception 'Product % not found for order item insert', new.product_id;
        end if;

        new.unit_price_usd_snapshot := v_product_price;
      end if;
    end if;
  end if;

  -- 2) En UPDATE: detectar si intentan tocar pricing (snapshot u override)
  if tg_op = 'UPDATE' then
    v_price_fields_changed :=
      (new.unit_price_usd_snapshot is distinct from old.unit_price_usd_snapshot)
      or (new.override_unit_price_usd is distinct from old.override_unit_price_usd)
      or (new.override_reason is distinct from old.override_reason);

    if v_price_fields_changed and not public.is_admin() then
      raise exception 'Only ADMIN can change item pricing or set an override.';
    end if;
  end if;

  -- 3) Reglas de override (si hay override debe haber motivo) -> solo aplica si override está seteado
  if new.override_unit_price_usd is not null then
    if coalesce(nullif(trim(new.override_reason), ''), '') = '' then
      raise exception 'override_reason is required when override_unit_price_usd is set.';
    end if;

    -- Sella aprobación cuando override cambia o se crea
    if (tg_op = 'INSERT')
       or (tg_op = 'UPDATE' and (
            new.override_unit_price_usd is distinct from old.override_unit_price_usd
         or new.override_reason is distinct from old.override_reason
       ))
    then
      new.override_approved_by := coalesce(auth.uid(), new.override_approved_by);
      new.override_approved_at := now();
    end if;
  else
    -- Si no hay override, limpiamos auditoría
    new.override_reason := null;
    new.override_approved_by := null;
    new.override_approved_at := null;
  end if;

  -- 4) Precio efectivo: override si existe, si no snapshot
  v_effective_price := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);

  -- 5) Cálculo automático del total de línea SIEMPRE
  new.line_total_usd := round((new.qty * v_effective_price)::numeric, 2);

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_order_items_recalc_order_total()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order_id bigint;
  v_total numeric;
begin
  v_order_id := coalesce(new.order_id, old.order_id);

  select coalesce(sum(oi.line_total_usd), 0)
    into v_total
  from public.order_items oi
  where oi.order_id = v_order_id;

  update public.orders
     set total_usd = v_total
   where id = v_order_id;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_order_items_recalc_total()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if (tg_op = 'DELETE') then
    perform public.recalc_order_total(old.order_id);
    return old;
  else
    perform public.recalc_order_total(new.order_id);
    return new;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_order_items_set_pricing()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_product record;
  v_unit_price numeric;
begin
  -- Si están intentando override => solo admin
  if new.override_unit_price_usd is not null
     or new.override_reason is not null
     or new.override_approved_by is not null
     or new.override_approved_at is not null then
    if not public.is_admin() then
      raise exception 'Only ADMIN can change item pricing or set an override.';
    end if;
  end if;

  -- Traer producto
  select id, sku, name, base_price_usd
  into v_product
  from public.products
  where id = new.product_id;

  if not found then
    raise exception 'Invalid product_id';
  end if;

  -- En INSERT: congelar snapshots desde products
  if tg_op = 'INSERT' then
    new.sku_snapshot := v_product.sku;
    new.product_name_snapshot := v_product.name;
    new.unit_price_usd_snapshot := v_product.base_price_usd;
  end if;

  -- Precio efectivo: override (solo admin) o snapshot
  v_unit_price := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);

  -- Line total siempre se recalcula
  new.line_total_usd := coalesce(new.qty, 0) * coalesce(v_unit_price, 0);

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_orders_delivery_mode_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Solo aplica a órdenes delivery
  if new.fulfillment = 'delivery' then

    -- ✅ Regla correcta:
    -- delivery_mode SOLO es obligatorio cuando la orden va a salir a ruta (out_for_delivery)
    -- (y opcionalmente cuando ya está delivered, para consistencia).
    if new.status in ('out_for_delivery', 'delivered') then
      if new.delivery_mode is null then
        raise exception 'Delivery orders require delivery_mode (internal/external) before out_for_delivery.';
      end if;

      -- Si es internal, debe haber driver interno asignado
      if new.delivery_mode::text = 'internal' and new.internal_driver_user_id is null then
        raise exception 'Delivery orders with delivery_mode=internal require internal_driver_user_id before out_for_delivery.';
      end if;

      -- Si es external, debe haber partner externo asignado
      if new.delivery_mode::text = 'external' and new.external_partner_id is null then
        raise exception 'Delivery orders with delivery_mode=external require external_partner_id before out_for_delivery.';
      end if;
    end if;

  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_orders_external_partner_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.external_partner_id is not null then
    if new.fulfillment::text <> 'delivery' then
      raise exception
        using message = 'external_partner_id is only allowed when fulfillment = delivery.';
    end if;

    if new.delivery_mode is null or new.delivery_mode::text <> 'external' then
      raise exception
        using message = 'external_partner_id requires delivery_mode = external.';
    end if;

    if new.internal_driver_user_id is not null then
      raise exception
        using message = 'External partner orders must not have internal_driver_user_id.';
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_orders_lock_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Si alguien intenta cambiar el lock
  if new.is_price_locked is distinct from old.is_price_locked then
    if not public.is_master_or_admin() then
      raise exception 'Only master/admin can change is_price_locked';
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_orders_queue_reapproval_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_is_advisor boolean;
begin
  -- Solo en UPDATE
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  -- Solo nos interesa si el status sigue siendo queued (o sea, estamos editando el pedido en cola)
  if new.status <> 'queued' then
    return new;
  end if;

  -- Master/Admin NO generan re-aprobación (ellos están aprobando/operando)
  if public.is_master_or_admin() then
    return new;
  end if;

  -- Verifica si el actor actual tiene rol advisor
  v_is_advisor := public.has_role('advisor');

  if v_is_advisor then
    new.queued_needs_reapproval := true;
    new.queued_last_modified_at := now();
    new.queued_last_modified_by := auth.uid();
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_orders_role_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_is_admin boolean;
  v_is_master boolean;
  v_is_advisor boolean;
  v_is_kitchen boolean;
  v_is_driver boolean;
begin
  -- Solo aplica en UPDATE
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  v_is_admin   := public.is_admin();
  v_is_master  := public.is_master();
  v_is_advisor := public.has_role('advisor');
  v_is_kitchen := public.has_role('kitchen');
  v_is_driver  := public.has_role('driver');

  -- Master/Admin: permitimos (las reglas finas viven en funciones + triggers de items/precio)
  if v_is_admin or v_is_master then
    return new;
  end if;

  -- ADVISOR: no puede tocar columnas operativas/sensibles
  if v_is_advisor then
    if
      new.status is distinct from old.status
      or new.delivery_mode is distinct from old.delivery_mode
      or new.internal_driver_user_id is distinct from old.internal_driver_user_id
      or new.external_partner_id is distinct from old.external_partner_id
      or new.external_driver_name is distinct from old.external_driver_name
      or new.external_driver_phone is distinct from old.external_driver_phone
      or new.external_reference is distinct from old.external_reference
      or new.is_price_locked is distinct from old.is_price_locked
      or new.sent_to_kitchen_at is distinct from old.sent_to_kitchen_at
      or new.sent_to_kitchen_by is distinct from old.sent_to_kitchen_by
      or new.eta_minutes is distinct from old.eta_minutes
      or new.kitchen_started_at is distinct from old.kitchen_started_at
      or new.kitchen_operator_id is distinct from old.kitchen_operator_id
      or new.ready_at is distinct from old.ready_at
    then
      raise exception 'Advisor cannot modify operational/logistics fields in orders';
    end if;

    return new;
  end if;

  -- KITCHEN: solo cambios de cocina (status/eta/timestamps de cocina/ready)
  if v_is_kitchen then
    if
      new.order_number is distinct from old.order_number
      or new.client_id is distinct from old.client_id
      or new.created_by_user_id is distinct from old.created_by_user_id
      or new.source is distinct from old.source
      or new.attributed_advisor_id is distinct from old.attributed_advisor_id
      or new.fulfillment is distinct from old.fulfillment
      or new.delivery_address is distinct from old.delivery_address
      or new.receiver_name is distinct from old.receiver_name
      or new.receiver_phone is distinct from old.receiver_phone
      or new.total_usd is distinct from old.total_usd
      or new.notes is distinct from old.notes
      or new.extra_fields is distinct from old.extra_fields
      or new.is_price_locked is distinct from old.is_price_locked
      or new.delivery_mode is distinct from old.delivery_mode
      or new.external_driver_name is distinct from old.external_driver_name
      or new.external_driver_phone is distinct from old.external_driver_phone
      or new.external_partner_id is distinct from old.external_partner_id
      or new.external_reference is distinct from old.external_reference
      or new.internal_driver_user_id is distinct from old.internal_driver_user_id
      or new.sent_to_kitchen_at is distinct from old.sent_to_kitchen_at
      or new.sent_to_kitchen_by is distinct from old.sent_to_kitchen_by
    then
      raise exception 'Kitchen can only update kitchen workflow fields in orders';
    end if;

    return new;
  end if;

  -- DRIVER: por ahora solo permitimos cambio de status (ej: delivered)
  if v_is_driver then
    if
      new.status is distinct from old.status
      and (
        new.order_number is distinct from old.order_number
        or new.client_id is distinct from old.client_id
        or new.created_by_user_id is distinct from old.created_by_user_id
        or new.source is distinct from old.source
        or new.attributed_advisor_id is distinct from old.attributed_advisor_id
        or new.fulfillment is distinct from old.fulfillment
        or new.delivery_address is distinct from old.delivery_address
        or new.receiver_name is distinct from old.receiver_name
        or new.receiver_phone is distinct from old.receiver_phone
        or new.total_usd is distinct from old.total_usd
        or new.notes is distinct from old.notes
        or new.extra_fields is distinct from old.extra_fields
        or new.is_price_locked is distinct from old.is_price_locked
        or new.delivery_mode is distinct from old.delivery_mode
        or new.external_driver_name is distinct from old.external_driver_name
        or new.external_driver_phone is distinct from old.external_driver_phone
        or new.external_partner_id is distinct from old.external_partner_id
        or new.external_reference is distinct from old.external_reference
        or new.internal_driver_user_id is distinct from old.internal_driver_user_id
        or new.sent_to_kitchen_at is distinct from old.sent_to_kitchen_at
        or new.sent_to_kitchen_by is distinct from old.sent_to_kitchen_by
        or new.eta_minutes is distinct from old.eta_minutes
        or new.kitchen_started_at is distinct from old.kitchen_started_at
        or new.kitchen_operator_id is distinct from old.kitchen_operator_id
        or new.ready_at is distinct from old.ready_at
      )
    then
      raise exception 'Driver can only update delivery-status related fields in orders';
    end if;

    -- Si cambió algo distinto a status, también bloquea
    if
      new.order_number is distinct from old.order_number
      or new.client_id is distinct from old.client_id
      or new.created_by_user_id is distinct from old.created_by_user_id
      or new.source is distinct from old.source
      or new.attributed_advisor_id is distinct from old.attributed_advisor_id
      or new.fulfillment is distinct from old.fulfillment
      or new.delivery_address is distinct from old.delivery_address
      or new.receiver_name is distinct from old.receiver_name
      or new.receiver_phone is distinct from old.receiver_phone
      or new.total_usd is distinct from old.total_usd
      or new.notes is distinct from old.notes
      or new.extra_fields is distinct from old.extra_fields
      or new.is_price_locked is distinct from old.is_price_locked
      or new.delivery_mode is distinct from old.delivery_mode
      or new.external_driver_name is distinct from old.external_driver_name
      or new.external_driver_phone is distinct from old.external_driver_phone
      or new.external_partner_id is distinct from old.external_partner_id
      or new.external_reference is distinct from old.external_reference
      or new.internal_driver_user_id is distinct from old.internal_driver_user_id
      or new.sent_to_kitchen_at is distinct from old.sent_to_kitchen_at
      or new.sent_to_kitchen_by is distinct from old.sent_to_kitchen_by
      or new.eta_minutes is distinct from old.eta_minutes
      or new.kitchen_started_at is distinct from old.kitchen_started_at
      or new.kitchen_operator_id is distinct from old.kitchen_operator_id
      or new.ready_at is distinct from old.ready_at
    then
      raise exception 'Driver cannot modify order fields other than status';
    end if;

    return new;
  end if;

  -- Cualquier otro rol autenticado: bloqueado
  raise exception 'This role is not allowed to update orders directly';
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_recalc_order_total()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- INSERT / UPDATE: usar NEW.order_id
  if (tg_op = 'INSERT' or tg_op = 'UPDATE') then
    perform public.recalc_order_total(new.order_id);
    return new;
  end if;

  -- DELETE: usar OLD.order_id
  if (tg_op = 'DELETE') then
    perform public.recalc_order_total(old.order_id);
    return old;
  end if;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.vivo_current_role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT NULLIF(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'user_role'),
    ''
  );
$function$;

CREATE OR REPLACE FUNCTION public.vivo_require_role(allowed_roles text[])
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  r TEXT;
BEGIN
  r := public.vivo_current_role();

  IF r IS NULL THEN
    RAISE EXCEPTION 'Missing user_role in JWT claims';
  END IF;

  IF NOT (r = ANY(allowed_roles)) THEN
    RAISE EXCEPTION 'Insufficient role. Required: %, got: %', allowed_roles, r;
  END IF;
END;
$function$;

grant delete on table "public"."clients" to "postgres";

grant insert on table "public"."clients" to "postgres";

grant references on table "public"."clients" to "postgres";

grant select on table "public"."clients" to "postgres";

grant trigger on table "public"."clients" to "postgres";

grant truncate on table "public"."clients" to "postgres";

grant update on table "public"."clients" to "postgres";

grant delete on table "public"."delivery_partners" to "postgres";

grant insert on table "public"."delivery_partners" to "postgres";

grant references on table "public"."delivery_partners" to "postgres";

grant select on table "public"."delivery_partners" to "postgres";

grant trigger on table "public"."delivery_partners" to "postgres";

grant truncate on table "public"."delivery_partners" to "postgres";

grant update on table "public"."delivery_partners" to "postgres";

grant delete on table "public"."delivery_trips" to "postgres";

grant insert on table "public"."delivery_trips" to "postgres";

grant references on table "public"."delivery_trips" to "postgres";

grant select on table "public"."delivery_trips" to "postgres";

grant trigger on table "public"."delivery_trips" to "postgres";

grant truncate on table "public"."delivery_trips" to "postgres";

grant update on table "public"."delivery_trips" to "postgres";

grant delete on table "public"."exchange_rates" to "postgres";

grant insert on table "public"."exchange_rates" to "postgres";

grant references on table "public"."exchange_rates" to "postgres";

grant select on table "public"."exchange_rates" to "postgres";

grant trigger on table "public"."exchange_rates" to "postgres";

grant truncate on table "public"."exchange_rates" to "postgres";

grant update on table "public"."exchange_rates" to "postgres";

grant delete on table "public"."external_partners" to "postgres";

grant insert on table "public"."external_partners" to "postgres";

grant references on table "public"."external_partners" to "postgres";

grant select on table "public"."external_partners" to "postgres";

grant trigger on table "public"."external_partners" to "postgres";

grant truncate on table "public"."external_partners" to "postgres";

grant update on table "public"."external_partners" to "postgres";

grant delete on table "public"."money_accounts" to "postgres";

grant insert on table "public"."money_accounts" to "postgres";

grant references on table "public"."money_accounts" to "postgres";

grant select on table "public"."money_accounts" to "postgres";

grant trigger on table "public"."money_accounts" to "postgres";

grant truncate on table "public"."money_accounts" to "postgres";

grant update on table "public"."money_accounts" to "postgres";

grant delete on table "public"."money_movements" to "postgres";

grant insert on table "public"."money_movements" to "postgres";

grant references on table "public"."money_movements" to "postgres";

grant select on table "public"."money_movements" to "postgres";

grant trigger on table "public"."money_movements" to "postgres";

grant truncate on table "public"."money_movements" to "postgres";

grant update on table "public"."money_movements" to "postgres";

grant delete on table "public"."notifications" to "postgres";

grant insert on table "public"."notifications" to "postgres";

grant references on table "public"."notifications" to "postgres";

grant select on table "public"."notifications" to "postgres";

grant trigger on table "public"."notifications" to "postgres";

grant truncate on table "public"."notifications" to "postgres";

grant update on table "public"."notifications" to "postgres";

grant delete on table "public"."order_events" to "postgres";

grant insert on table "public"."order_events" to "postgres";

grant references on table "public"."order_events" to "postgres";

grant select on table "public"."order_events" to "postgres";

grant trigger on table "public"."order_events" to "postgres";

grant truncate on table "public"."order_events" to "postgres";

grant update on table "public"."order_events" to "postgres";

grant delete on table "public"."order_item_components" to "postgres";

grant insert on table "public"."order_item_components" to "postgres";

grant references on table "public"."order_item_components" to "postgres";

grant select on table "public"."order_item_components" to "postgres";

grant trigger on table "public"."order_item_components" to "postgres";

grant truncate on table "public"."order_item_components" to "postgres";

grant update on table "public"."order_item_components" to "postgres";

grant delete on table "public"."order_items" to "postgres";

grant insert on table "public"."order_items" to "postgres";

grant references on table "public"."order_items" to "postgres";

grant select on table "public"."order_items" to "postgres";

grant trigger on table "public"."order_items" to "postgres";

grant truncate on table "public"."order_items" to "postgres";

grant update on table "public"."order_items" to "postgres";

grant delete on table "public"."orders" to "postgres";

grant insert on table "public"."orders" to "postgres";

grant references on table "public"."orders" to "postgres";

grant select on table "public"."orders" to "postgres";

grant trigger on table "public"."orders" to "postgres";

grant truncate on table "public"."orders" to "postgres";

grant update on table "public"."orders" to "postgres";

grant delete on table "public"."payment_reports" to "postgres";

grant insert on table "public"."payment_reports" to "postgres";

grant references on table "public"."payment_reports" to "postgres";

grant select on table "public"."payment_reports" to "postgres";

grant trigger on table "public"."payment_reports" to "postgres";

grant truncate on table "public"."payment_reports" to "postgres";

grant update on table "public"."payment_reports" to "postgres";

grant delete on table "public"."product_components" to "postgres";

grant insert on table "public"."product_components" to "postgres";

grant references on table "public"."product_components" to "postgres";

grant select on table "public"."product_components" to "postgres";

grant trigger on table "public"."product_components" to "postgres";

grant truncate on table "public"."product_components" to "postgres";

grant update on table "public"."product_components" to "postgres";

grant delete on table "public"."products" to "postgres";

grant insert on table "public"."products" to "postgres";

grant references on table "public"."products" to "postgres";

grant select on table "public"."products" to "postgres";

grant trigger on table "public"."products" to "postgres";

grant truncate on table "public"."products" to "postgres";

grant update on table "public"."products" to "postgres";

grant delete on table "public"."profiles" to "postgres";

grant insert on table "public"."profiles" to "postgres";

grant references on table "public"."profiles" to "postgres";

grant select on table "public"."profiles" to "postgres";

grant trigger on table "public"."profiles" to "postgres";

grant truncate on table "public"."profiles" to "postgres";

grant update on table "public"."profiles" to "postgres";

grant delete on table "public"."tasks" to "postgres";

grant insert on table "public"."tasks" to "postgres";

grant references on table "public"."tasks" to "postgres";

grant select on table "public"."tasks" to "postgres";

grant trigger on table "public"."tasks" to "postgres";

grant truncate on table "public"."tasks" to "postgres";

grant update on table "public"."tasks" to "postgres";

grant delete on table "public"."user_roles" to "postgres";

grant insert on table "public"."user_roles" to "postgres";

grant references on table "public"."user_roles" to "postgres";

grant select on table "public"."user_roles" to "postgres";

grant trigger on table "public"."user_roles" to "postgres";

grant truncate on table "public"."user_roles" to "postgres";

grant update on table "public"."user_roles" to "postgres";
