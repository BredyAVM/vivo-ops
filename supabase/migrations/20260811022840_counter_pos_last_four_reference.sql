-- Counter POS traceability: every point-of-sale collection stores the
-- four receipt digits in the existing reference_code ledger field.

begin;

create or replace function public.counter_apply_order_payments(
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
  v_method text;
  v_reference text;
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
    v_method := lower(btrim(v_line ->> 'payment_method'));
    v_reference := nullif(btrim(v_line ->> 'reference_code'), '');

    if v_method = 'pos' and coalesce(v_reference, '') !~ '^[0-9]{4}$' then
      raise exception 'Cada pago por punto requiere los ultimos cuatro digitos de la referencia.';
    end if;

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
is 'Operacion atomica Counter: exige referencia POS de cuatro digitos y normaliza cada pago VES con la tasa canonica del servidor.';

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
