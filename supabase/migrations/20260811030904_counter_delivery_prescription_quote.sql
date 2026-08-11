-- Delivery dispatch keeps unpaid orders movable, but only opens custody when
-- the order prescribes cash/change. VES custody uses the canonical order quote.

begin;

create or replace function public.counter_normalize_delivery_ves_lines(
  p_lines jsonb,
  p_exchange_rate numeric
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case
    when jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array'
      then coalesce(p_lines, '[]'::jsonb)
    else coalesce((
      select jsonb_agg(
        case
          when upper(btrim(line ->> 'currency_code')) = 'VES'
            then jsonb_set(
              line,
              '{exchange_rate_ves_per_usd}',
              to_jsonb(round(p_exchange_rate, 6)),
              true
            )
          else line
        end
        order by ordinality
      )
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
        with ordinality entry(line, ordinality)
    ), '[]'::jsonb)
  end;
$function$;

revoke all on function public.counter_normalize_delivery_ves_lines(jsonb, numeric)
  from public, anon, authenticated;
grant execute on function public.counter_normalize_delivery_ves_lines(jsonb, numeric)
  to service_role;

alter function public.counter_dispatch_delivery(
  uuid, bigint, integer, jsonb, jsonb, jsonb, text
) rename to counter_dispatch_delivery_block8_v1;

revoke all on function public.counter_dispatch_delivery_block8_v1(
  uuid, bigint, integer, jsonb, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.counter_dispatch_delivery_block8_v1(
  uuid, bigint, integer, jsonb, jsonb, jsonb, text
) to service_role;

create function public.counter_dispatch_delivery(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_eta_minutes integer,
  p_expected_collection_lines jsonb default '[]'::jsonb,
  p_cash_change_lines jsonb default '[]'::jsonb,
  p_digital_change_lines jsonb default '[]'::jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_payment jsonb;
  v_payment_method text;
  v_requires_change boolean;
  v_active_rate numeric(18,6);
  v_settlement_rate numeric(18,6);
  v_state record;
  v_requires_money boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.has_role('counter')
    or public.is_master_or_admin()
  ) then
    raise exception 'Only Counter or Master/Admin can dispatch a delivery';
  end if;

  select order_row.*
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'Order not found';
  end if;

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.effective_at < (
    (((now() at time zone 'America/Caracas')::date + 1)::timestamp)
      at time zone 'America/Caracas'
  )
  order by rate.effective_at desc, rate.id desc
  limit 1;

  select *
  into v_state
  from public.get_order_financial_state(
    p_order_id,
    (now() at time zone 'America/Caracas')::date,
    v_active_rate
  );

  v_payment := case
    when jsonb_typeof(v_order.extra_fields -> 'payment') = 'object'
      then v_order.extra_fields -> 'payment'
    else '{}'::jsonb
  end;
  v_payment_method := lower(btrim(coalesce(v_payment ->> 'method', '')));
  v_requires_change := lower(btrim(coalesce(v_payment ->> 'requires_change', 'false')))
    in ('true', '1', 'yes');
  v_requires_money := coalesce(v_state.pending_usd, 0) > 0.005
    and (
      v_requires_change
      or v_payment_method in ('cash_usd', 'cash_ves')
    );

  p_expected_collection_lines := coalesce(p_expected_collection_lines, '[]'::jsonb);
  p_cash_change_lines := coalesce(p_cash_change_lines, '[]'::jsonb);
  p_digital_change_lines := coalesce(p_digital_change_lines, '[]'::jsonb);

  if v_requires_money
     and jsonb_typeof(p_expected_collection_lines) = 'array'
     and jsonb_array_length(p_expected_collection_lines) = 0 then
    raise exception 'counter_delivery_expected_collection_required';
  end if;

  v_settlement_rate := case
    when v_state.collection_mode = 'snapshot_quote'
      and coalesce(v_state.pending_usd, 0) > 0.005
      and coalesce(v_state.pending_bs, 0) > 0.005
      then round(v_state.pending_bs / v_state.pending_usd, 6)
    else v_active_rate
  end;

  if exists (
    select 1
    from (
      select value as line from jsonb_array_elements(
        case when jsonb_typeof(p_expected_collection_lines) = 'array'
          then p_expected_collection_lines else '[]'::jsonb end
      )
      union all
      select value as line from jsonb_array_elements(
        case when jsonb_typeof(p_cash_change_lines) = 'array'
          then p_cash_change_lines else '[]'::jsonb end
      )
      union all
      select value as line from jsonb_array_elements(
        case when jsonb_typeof(p_digital_change_lines) = 'array'
          then p_digital_change_lines else '[]'::jsonb end
      )
    ) combined
    where upper(btrim(combined.line ->> 'currency_code')) = 'VES'
  ) and coalesce(v_settlement_rate, 0) <= 0 then
    raise exception 'counter_operation_rate_not_found';
  end if;

  p_expected_collection_lines := public.counter_normalize_delivery_ves_lines(
    p_expected_collection_lines,
    v_settlement_rate
  );
  p_cash_change_lines := public.counter_normalize_delivery_ves_lines(
    p_cash_change_lines,
    v_settlement_rate
  );
  p_digital_change_lines := public.counter_normalize_delivery_ves_lines(
    p_digital_change_lines,
    v_settlement_rate
  );

  return public.counter_dispatch_delivery_block8_v1(
    p_idempotency_key,
    p_order_id,
    p_eta_minutes,
    p_expected_collection_lines,
    p_cash_change_lines,
    p_digital_change_lines,
    p_notes
  );
end;
$function$;

comment on function public.counter_dispatch_delivery(
  uuid, bigint, integer, jsonb, jsonb, jsonb, text
) is
'Despacha deliveries sin exigir pago previo; exige custodia solo para efectivo/cambio prescrito y normaliza VES a la cotizacion canonica.';

revoke all on function public.counter_dispatch_delivery(
  uuid, bigint, integer, jsonb, jsonb, jsonb, text
) from public, anon;
grant execute on function public.counter_dispatch_delivery(
  uuid, bigint, integer, jsonb, jsonb, jsonb, text
) to authenticated, service_role;

commit;
