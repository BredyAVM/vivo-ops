-- Fix de la validación central de pagos duplicados.
-- Fecha: 2026-06-25
--
-- Contexto:
-- La función find_active_payment_duplicate fallaba con:
--   column reference "status" is ambiguous
--
-- Eso rompía tanto el reporte de pagos del asesor como la confirmación
-- de pagos del master, incluso cuando no existía duplicado real.
--
-- La corrección mantiene la misma regla de negocio:
--   cuenta + fecha de operación + moneda + monto + referencia normalizada
-- pero renombra los alias internos para evitar ambigüedad con la columna
-- de salida "status" del RETURNS TABLE.

create or replace function public.find_active_payment_duplicate(
  p_money_account_id bigint,
  p_operation_date date,
  p_currency public.currency_code,
  p_amount numeric,
  p_reference_code text,
  p_exclude_report_id bigint default null
)
returns table(
  source text,
  report_id bigint,
  movement_id bigint,
  order_id bigint,
  order_number text,
  client_name text,
  status text,
  amount numeric,
  currency_code public.currency_code,
  operation_date date,
  reference_code text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reference_key text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_reference_key := public.normalize_payment_reference_key(p_reference_code);

  if p_money_account_id is null
    or p_operation_date is null
    or p_currency is null
    or p_amount is null
    or p_amount <= 0
    or v_reference_key is null
  then
    return;
  end if;

  return query
  with report_matches as (
    select
      'payment_report'::text as match_source,
      pr.id as match_report_id,
      pr.confirmed_movement_id as match_movement_id,
      pr.order_id as match_order_id,
      o.order_number::text as match_order_number,
      c.full_name::text as match_client_name,
      pr.status::text as match_status,
      round(pr.reported_amount, 2) as match_amount,
      pr.reported_currency_code as match_currency_code,
      coalesce(pr.operation_date, pr.created_at::date) as match_operation_date,
      pr.reference_code::text as match_reference_code
    from public.payment_reports pr
    join public.orders o on o.id = pr.order_id
    left join public.clients c on c.id = o.client_id
    where pr.status in ('pending', 'confirmed')
      and o.status <> 'cancelled'
      and (p_exclude_report_id is null or pr.id <> p_exclude_report_id)
      and pr.reported_money_account_id = p_money_account_id
      and coalesce(pr.operation_date, pr.created_at::date) = p_operation_date
      and pr.reported_currency_code = p_currency
      and round(pr.reported_amount, 2) = round(p_amount, 2)
      and public.normalize_payment_reference_key(pr.reference_code) = v_reference_key
  ), movement_matches as (
    select
      'money_movement'::text as match_source,
      mm.payment_report_id as match_report_id,
      mm.id as match_movement_id,
      mm.order_id as match_order_id,
      o.order_number::text as match_order_number,
      c.full_name::text as match_client_name,
      mm.status::text as match_status,
      round(mm.amount, 2) as match_amount,
      mm.currency_code as match_currency_code,
      mm.movement_date as match_operation_date,
      mm.reference_code::text as match_reference_code
    from public.money_movements mm
    join public.orders o on o.id = mm.order_id
    left join public.clients c on c.id = o.client_id
    where mm.status = 'confirmed'
      and mm.direction = 'inflow'
      and mm.movement_type = 'order_payment'
      and o.status <> 'cancelled'
      and (p_exclude_report_id is null or mm.payment_report_id is distinct from p_exclude_report_id)
      and mm.money_account_id = p_money_account_id
      and mm.movement_date = p_operation_date
      and mm.currency_code = p_currency
      and round(mm.amount, 2) = round(p_amount, 2)
      and public.normalize_payment_reference_key(mm.reference_code) = v_reference_key
  ), combined_matches as (
    select * from report_matches
    union all
    select * from movement_matches
  )
  select
    cm.match_source,
    cm.match_report_id,
    cm.match_movement_id,
    cm.match_order_id,
    cm.match_order_number,
    cm.match_client_name,
    cm.match_status,
    cm.match_amount,
    cm.match_currency_code,
    cm.match_operation_date,
    cm.match_reference_code
  from combined_matches cm
  order by
    case when cm.match_status = 'confirmed' then 0 else 1 end,
    cm.match_operation_date desc,
    cm.match_order_id desc;
end;
$function$;
