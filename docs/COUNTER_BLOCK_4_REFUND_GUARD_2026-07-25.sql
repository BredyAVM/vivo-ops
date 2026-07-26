-- Counter Block 4: canonical refund availability guard
-- Date: 2026-07-25

begin;

alter function public.counter_request_refund(
  uuid,
  bigint,
  jsonb,
  text
) rename to counter_request_refund_block2;

revoke all on function public.counter_request_refund_block2(
  uuid,
  bigint,
  jsonb,
  text
) from public, anon, authenticated;

grant execute on function public.counter_request_refund_block2(
  uuid,
  bigint,
  jsonb,
  text
) to service_role;

create function public.counter_request_refund(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_refund_lines jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_existing public.counter_command_receipts%rowtype;
  v_request_payload jsonb;
  v_line jsonb;
  v_currency public.currency_code;
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_requested_usd numeric(12,2) := 0;
  v_overpaid_usd numeric(12,2) := 0;
  v_digital_reserved_usd numeric(12,2) := 0;
  v_refund_reserved_usd numeric(12,2) := 0;
  v_available_usd numeric(12,2) := 0;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_master_or_admin()
    or public.has_role('counter')
  ) then
    raise exception 'Only Counter or Master/Admin can request a refund';
  end if;

  p_refund_lines := coalesce(p_refund_lines, '[]'::jsonb);
  if jsonb_typeof(p_refund_lines) <> 'array'
     or jsonb_array_length(p_refund_lines) < 1
     or jsonb_array_length(p_refund_lines) > 12 then
    raise exception 'refund_lines must contain between 1 and 12 lines';
  end if;

  if nullif(btrim(p_reason), '') is null then
    raise exception 'Refund reason is required';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'refund_lines', p_refund_lines,
    'reason', p_reason
  );

  select receipt.*
  into v_existing
  from public.counter_command_receipts receipt
  where receipt.actor_user_id = v_uid
    and receipt.command_type = 'request_refund'
    and receipt.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_payload is distinct from v_request_payload then
      raise exception 'Idempotency key was already used with another payload';
    end if;
    if v_existing.status <> 'completed' then
      raise exception 'Counter command is already in progress';
    end if;
    return v_existing.result_payload;
  end if;

  perform order_row.id
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if exists (
    select 1
    from (
      select nullif(btrim(line ->> 'line_key'), '') as line_key, count(*) as uses
      from jsonb_array_elements(p_refund_lines) line
      group by nullif(btrim(line ->> 'line_key'), '')
    ) keys
    where keys.line_key is null or keys.uses > 1
  ) then
    raise exception 'Every refund line requires a unique non-empty line_key';
  end if;

  for v_line in
    select line
    from jsonb_array_elements(p_refund_lines) line
  loop
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_requested_usd := round(
      v_requested_usd + public.counter_amount_usd(v_currency, v_amount, v_rate),
      2
    );
  end loop;

  select round(coalesce(state.overpaid_usd, 0), 2)
  into v_overpaid_usd
  from public.get_order_financial_state(p_order_id, null, null) state;

  select round(coalesce(sum(obligation.amount_usd_equivalent), 0), 2)
  into v_digital_reserved_usd
  from public.order_change_obligations obligation
  where obligation.order_id = p_order_id
    and obligation.status = 'pending';

  select round(coalesce(sum(movement.amount_usd_equivalent), 0), 2)
  into v_refund_reserved_usd
  from public.money_movements movement
  where movement.order_id = p_order_id
    and movement.direction = 'outflow'
    and movement.movement_type = 'withdrawal'
    and movement.status = 'pending'
    and exists (
      select 1
      from public.counter_command_receipts receipt
      where receipt.command_type = 'request_refund'
        and receipt.order_id = p_order_id
        and receipt.idempotency_key = movement.movement_group_id
    );

  v_available_usd := greatest(
    0,
    round(v_overpaid_usd - v_digital_reserved_usd - v_refund_reserved_usd, 2)
  );

  if v_requested_usd > v_available_usd + 0.01 then
    raise exception
      'Refund request exceeds the available order credit (USD %)',
      v_available_usd;
  end if;

  return public.counter_request_refund_block2(
    p_idempotency_key,
    p_order_id,
    p_refund_lines,
    p_reason
  );
end;
$function$;

revoke all on function public.counter_request_refund(
  uuid,
  bigint,
  jsonb,
  text
) from public, anon;

grant execute on function public.counter_request_refund(
  uuid,
  bigint,
  jsonb,
  text
) to authenticated, service_role;

commit;
