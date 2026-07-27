-- Counter Block 6: persist the enriched dispatch result on first execution.
-- This keeps retries byte-for-byte stable even after the order changes later.

begin;

alter function public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) rename to counter_dispatch_delivery_block6_v1;

revoke all on function public.counter_dispatch_delivery_block6_v1(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) from public, anon, authenticated;

grant execute on function public.counter_dispatch_delivery_block6_v1(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
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
  v_result jsonb;
  v_state record;
  v_active_rate numeric(18,6);
  v_expected_usd numeric(12,2);
  v_cash_change_usd numeric(12,2);
  v_digital_change_usd numeric(12,2);
  v_required_change_usd numeric(12,2);
begin
  v_result := public.counter_dispatch_delivery_block6_v1(
    p_idempotency_key,
    p_order_id,
    p_eta_minutes,
    p_expected_collection_lines,
    p_cash_change_lines,
    p_digital_change_lines,
    p_notes
  );

  if v_result ? 'required_change_usd' then
    return v_result;
  end if;

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  select *
  into v_state
  from public.get_order_financial_state(
    p_order_id,
    null,
    v_active_rate
  );

  select round(coalesce(sum(public.counter_amount_usd(
    upper(btrim(line ->> 'currency_code'))::public.currency_code,
    round((line ->> 'amount')::numeric, 2),
    case
      when upper(btrim(line ->> 'currency_code')) = 'VES'
        then round((line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end
  )), 0), 2)
  into v_expected_usd
  from jsonb_array_elements(
    coalesce(p_expected_collection_lines, '[]'::jsonb)
  ) line;

  select round(coalesce(sum(public.counter_amount_usd(
    upper(btrim(line ->> 'currency_code'))::public.currency_code,
    round((line ->> 'amount')::numeric, 2),
    case
      when upper(btrim(line ->> 'currency_code')) = 'VES'
        then round((line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end
  )), 0), 2)
  into v_cash_change_usd
  from jsonb_array_elements(
    coalesce(p_cash_change_lines, '[]'::jsonb)
  ) line;

  select round(coalesce(sum(public.counter_amount_usd(
    upper(btrim(line ->> 'currency_code'))::public.currency_code,
    round((line ->> 'amount')::numeric, 2),
    case
      when upper(btrim(line ->> 'currency_code')) = 'VES'
        then round((line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end
  )), 0), 2)
  into v_digital_change_usd
  from jsonb_array_elements(
    coalesce(p_digital_change_lines, '[]'::jsonb)
  ) line;

  v_required_change_usd := round(greatest(
    v_expected_usd - coalesce(v_state.pending_usd, 0),
    0
  ), 2);

  v_result := v_result || jsonb_build_object(
    'eta_minutes', p_eta_minutes,
    'expected_collection_usd', v_expected_usd,
    'cash_change_usd', v_cash_change_usd,
    'digital_change_usd', v_digital_change_usd,
    'required_change_usd', v_required_change_usd
  );

  update public.counter_command_receipts
  set result_payload = v_result
  where actor_user_id = v_uid
    and command_type = 'dispatch_delivery'
    and idempotency_key = p_idempotency_key;

  return v_result;
end;
$function$;

revoke all on function public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) from public, anon;

grant execute on function public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) to authenticated, service_role;

commit;
