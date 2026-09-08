-- A give-change command must calculate its receipt after the command receipt is
-- marked completed. The canonical financial state recognizes the fund-backed
-- portion only at that point.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.counter_complete_command(
  p_receipt_id bigint,
  p_result_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_receipt record;
  v_result jsonb := p_result_payload;
  v_pending_usd numeric(12,2);
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesion para completar esta operacion';
  end if;

  if p_result_payload is null then
    raise exception 'El comprobante de la operacion es obligatorio';
  end if;

  update public.counter_command_receipts receipt
  set
    status = 'completed',
    result_payload = p_result_payload,
    completed_at = now()
  where receipt.id = p_receipt_id
    and receipt.actor_user_id = v_uid
    and receipt.status = 'started'
  returning receipt.command_type, receipt.order_id
  into v_receipt;

  if not found then
    raise exception 'La operacion ya no esta disponible para completarse';
  end if;

  if v_receipt.command_type = 'give_order_change'
     and v_receipt.order_id is not null then
    select round(state.pending_usd, 2)
    into v_pending_usd
    from public.get_order_financial_state(
      v_receipt.order_id,
      (now() at time zone 'America/Caracas')::date,
      null
    ) state;

    v_result := p_result_payload || jsonb_build_object(
      'pending_usd', coalesce(v_pending_usd, 0)
    );

    update public.counter_command_receipts
    set result_payload = v_result
    where id = p_receipt_id;
  end if;

  return v_result;
end;
$function$;

comment on function public.counter_complete_command(bigint, jsonb)
is 'Completa comandos idempotentes de Counter. Para cambio, recalcula el pendiente despues de cerrar el recibo para incluir solo la porcion respaldada por fondo.';

revoke all on function public.counter_complete_command(bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.counter_complete_command(bigint, jsonb)
  to service_role;

commit;
