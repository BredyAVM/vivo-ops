-- Counter: canonical payment quotes by operation date and server-owned rate.
--
-- The customer-facing VES amount must always come from the canonical
-- financial state. A Counter client may report a payment, but it must not
-- choose the rate used to value a VES line.

begin;

create or replace function public.counter_read_payment_quote(
  p_order_id bigint,
  p_operation_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_operation_date date := coalesce(
    p_operation_date,
    (now() at time zone 'America/Caracas')::date
  );
  v_rate numeric(18,6);
  v_state record;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'counter_order_invalid';
  end if;

  perform order_row.id
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'counter_order_not_found';
  end if;

  -- The applicable VES rate is the latest recorded rate for the operation
  -- date in Caracas, not a value supplied by the browser.
  select rate.rate_bs_per_usd
  into v_rate
  from public.exchange_rates rate
  where rate.effective_at < ((v_operation_date + 1)::timestamp at time zone 'America/Caracas')
  order by rate.effective_at desc, rate.id desc
  limit 1;

  select *
  into v_state
  from public.get_order_financial_state(
    p_order_id,
    v_operation_date,
    v_rate
  );

  if v_state.collection_mode = 'post_delivery_usd'
     and coalesce(v_rate, 0) <= 0 then
    raise exception 'counter_operation_rate_not_found';
  end if;

  return jsonb_build_object(
    'operationDate', v_operation_date,
    'pendingUsd', coalesce(v_state.pending_usd, 0),
    'pendingBs', coalesce(v_state.pending_bs, 0),
    'exchangeRate', coalesce(v_rate, 0),
    'collectionMode', coalesce(v_state.collection_mode, 'closed'),
    'snapshotRate', coalesce(v_state.snapshot_rate_bs_per_usd, 0)
  );
end;
$function$;

comment on function public.counter_read_payment_quote(bigint, date)
is 'Cotizacion financiera canonica para Counter: conserva snapshot VES antes o el dia de entrega y usa la tasa de la fecha de operacion despues.';

revoke all on function public.counter_read_payment_quote(bigint, date)
  from public, anon;
grant execute on function public.counter_read_payment_quote(bigint, date)
  to authenticated, service_role;

-- Keep Block 4 as the tested ledger primitive and place a narrow server-side
-- normalization boundary in front of it. This preserves its idempotency,
-- account locks, payment reports and money movements unchanged.
alter function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) rename to counter_apply_order_payments_block4;

revoke all on function public.counter_apply_order_payments_block4(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.counter_apply_order_payments_block4(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) to service_role;

create function public.counter_apply_order_payments(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_payment_lines jsonb,
  p_overpayment_handling text default null,
  p_change_lines jsonb default '[]'::jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_line jsonb;
  v_normalized_lines jsonb := '[]'::jsonb;
  v_currency text;
  v_operation_date_raw text;
  v_operation_date date;
  v_rate numeric(18,6);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_master_or_admin()
    or public.has_role('counter')
  ) then
    raise exception 'Only Counter or Master/Admin can apply a Counter payment operation';
  end if;

  p_payment_lines := coalesce(p_payment_lines, '[]'::jsonb);
  if jsonb_typeof(p_payment_lines) <> 'array' then
    return public.counter_apply_order_payments_block4(
      p_idempotency_key,
      p_order_id,
      p_payment_lines,
      p_overpayment_handling,
      p_change_lines,
      p_notes
    );
  end if;

  for v_line in
    select line
    from jsonb_array_elements(p_payment_lines) line
  loop
    v_currency := upper(btrim(v_line ->> 'currency_code'));

    if v_currency <> 'VES' then
      v_normalized_lines := v_normalized_lines || jsonb_build_array(v_line);
      continue;
    end if;

    v_operation_date_raw := nullif(btrim(v_line ->> 'operation_date'), '');
    if v_operation_date_raw is null then
      v_operation_date := (now() at time zone 'America/Caracas')::date;
    elsif v_operation_date_raw ~ '^\d{4}-\d{2}-\d{2}$' then
      v_operation_date := v_operation_date_raw::date;
    else
      raise exception 'Indica una fecha de operacion valida en cada pago VES.';
    end if;

    select rate.rate_bs_per_usd
    into v_rate
    from public.exchange_rates rate
    where rate.effective_at < ((v_operation_date + 1)::timestamp at time zone 'America/Caracas')
    order by rate.effective_at desc, rate.id desc
    limit 1;

    if coalesce(v_rate, 0) <= 0 then
      raise exception 'No existe una tasa canonica para la fecha de operacion indicada.';
    end if;

    v_normalized_lines := v_normalized_lines || jsonb_build_array(
      jsonb_set(
        v_line,
        '{exchange_rate_ves_per_usd}',
        to_jsonb(round(v_rate, 6)),
        true
      )
    );
  end loop;

  return public.counter_apply_order_payments_block4(
    p_idempotency_key,
    p_order_id,
    v_normalized_lines,
    p_overpayment_handling,
    p_change_lines,
    p_notes
  );
end;
$function$;

comment on function public.counter_apply_order_payments(uuid, bigint, jsonb, text, jsonb, text)
is 'Operacion atomica Counter que normaliza cada pago VES a la tasa canonica de su fecha antes de delegar al ledger Block 4.';

revoke all on function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) from public, anon;
grant execute on function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) to authenticated, service_role;

commit;
