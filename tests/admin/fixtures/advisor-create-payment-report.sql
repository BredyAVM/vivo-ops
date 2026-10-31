CREATE OR REPLACE FUNCTION public.create_payment_report(p_order_id bigint, p_reported_money_account_id bigint, p_reported_currency currency_code, p_reported_amount numeric, p_reported_exchange_rate_ves_per_usd numeric DEFAULT NULL::numeric, p_reference_code text DEFAULT NULL::text, p_payer_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_ok boolean;
  v_equiv numeric(12,2);
  v_report_id bigint;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_reported_amount is null or p_reported_amount <= 0 then
    raise exception 'reported_amount must be > 0';
  end if;

  select exists (
    select 1
    from public.money_accounts account
    where account.id = p_reported_money_account_id
      and account.is_active = true
      and account.currency_code = p_reported_currency
  ) into v_ok;

  if not v_ok then
    raise exception 'Payment account is inactive, missing, or uses another currency';
  end if;

  if public.is_master_or_admin() then
    select exists (
      select 1
      from public.orders order_row
      where order_row.id = p_order_id
    ) into v_ok;

    if not v_ok then
      raise exception 'Order not found';
    end if;
  elsif public.has_role('counter') then
    select
      exists (
        select 1
        from public.orders order_row
        where order_row.id = p_order_id
      )
      and exists (
        select 1
        from public.money_account_payment_rules rule
        where rule.money_account_id = p_reported_money_account_id
          and rule.role = 'counter'
          and rule.can_report_payment = true
          and rule.is_active = true
      )
    into v_ok;

    if not v_ok then
      raise exception 'Counter cannot report payments for this order/account';
    end if;
  elsif public.has_role('advisor') then
    select exists (
      select 1
      from public.orders order_row
      where order_row.id = p_order_id
        and order_row.attributed_advisor_id = v_uid
    ) into v_ok;

    if not v_ok then
      raise exception 'Advisor cannot report payments for this order';
    end if;
  else
    raise exception 'Insufficient role to create payment report';
  end if;

  if p_reported_currency = 'USD' then
    if p_reported_exchange_rate_ves_per_usd is not null then
      raise exception 'exchange_rate must be NULL when currency=USD';
    end if;
    v_equiv := round(p_reported_amount, 2);
  else
    if p_reported_exchange_rate_ves_per_usd is null
       or p_reported_exchange_rate_ves_per_usd <= 0 then
      raise exception 'exchange_rate_ves_per_usd is required and must be > 0 when currency=VES';
    end if;
    v_equiv := round(p_reported_amount / p_reported_exchange_rate_ves_per_usd, 2);
  end if;

  insert into public.payment_reports (
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
  ) values (
    p_order_id,
    'pending',
    v_uid,
    p_reported_currency,
    round(p_reported_amount, 2),
    p_reported_exchange_rate_ves_per_usd,
    v_equiv,
    p_reported_money_account_id,
    nullif(btrim(p_reference_code), ''),
    nullif(btrim(p_payer_name), ''),
    nullif(btrim(p_notes), '')
  )
  returning id into v_report_id;

  return v_report_id;
end;
$function$

