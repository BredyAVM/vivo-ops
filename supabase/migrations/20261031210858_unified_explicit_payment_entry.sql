-- Prospective explicit selection, shared by every customer-payment writer.
-- Existing receipts/allocations are never migrated or revalued.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $patch$
declare d text; a text;
begin
  d:=pg_get_functiondef('app_private.prepare_payment_day_coverage_v1(bigint,date,numeric,numeric)'::regprocedure);
  a:='  if valid_rate then';
  if position(a in d)=0 then raise exception 'Daily coverage helper changed'; end if;
  execute replace(d,a,$new$  if valid_rate and position('[Tasa del día seleccionada]' in coalesce(r.notes,''))=0 then$new$);
  d:=pg_get_functiondef('app_private.create_payment_report_on_date_v1(date,bigint,bigint,public.currency_code,numeric,numeric,text,text,text)'::regprocedure);
  a:='  insert into public.payment_reports (';
  if position(a in d)=0 then raise exception 'Shared report writer changed'; end if;
  execute replace(d,a,$new$  if p_reported_currency::text='VES' then
    if exists(select 1 from app_private.payment_operation_day_rates_v1(p_operation_date) d
      where d.rate=p_reported_exchange_rate_ves_per_usd) then
      p_notes:=concat_ws(E'\n','[Tasa del día seleccionada]',nullif(btrim(p_notes),''));
    elsif position('[Revisar tasa acordada]' in coalesce(p_notes,''))=0 then
      raise exception 'Selecciona una tasa vigente en la fecha real del pago.' using errcode='22023';
    end if;
  end if;
$new$||a);
end $patch$;

-- Preserve the explicit line rate; never replace it with the last daily rate.
create or replace function public.counter_apply_order_payments(p_idempotency_key uuid,p_order_id bigint,
  p_payment_lines jsonb,p_overpayment_handling text default null,p_change_lines jsonb default '[]'::jsonb,p_notes text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare line jsonb; lines jsonb:='[]'::jsonb; method text; ref text; opdate date; v_selected_rate numeric;
begin
  if auth.uid() is null or not(public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'No autorizado para registrar cobros de mostrador.' using errcode='42501'; end if;
  if jsonb_typeof(coalesce(p_payment_lines,'[]'::jsonb))<>'array' then
    raise exception 'Revisa las líneas de pago.' using errcode='22023'; end if;
  for line in select value from jsonb_array_elements(coalesce(p_payment_lines,'[]'::jsonb)) loop
    method:=lower(btrim(line->>'payment_method')); ref:=btrim(line->>'reference_code');
    if method='pos' and coalesce(ref,'')!~'^[0-9]{4}$' then
      raise exception 'Cada pago por punto requiere los últimos cuatro dígitos de la referencia.'; end if;
    if upper(btrim(line->>'currency_code'))='VES' then
      if coalesce(line->>'operation_date','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'Indica la fecha real del pago.'; end if;
      opdate:=(line->>'operation_date')::date;
      if opdate>(statement_timestamp() at time zone 'America/Caracas')::date then
        raise exception 'La fecha real del pago no puede ser futura.'; end if;
      v_selected_rate:=(line->>'exchange_rate_ves_per_usd')::numeric;
      if not exists(select 1 from app_private.payment_operation_day_rates_v1(opdate) d where d.rate=v_selected_rate) then
        raise exception 'Selecciona una tasa vigente en la fecha real del pago.' using errcode='22023'; end if;
      line:=jsonb_set(line,'{notes}',to_jsonb(concat_ws(E'\n','[Tasa del día seleccionada]',nullif(btrim(line->>'notes'),''))),true);
    end if;
    lines:=lines||jsonb_build_array(line);
  end loop;
  return public.counter_apply_order_payments_block4(p_idempotency_key,p_order_id,lines,p_overpayment_handling,p_change_lines,p_notes);
end $$;
notify pgrst,'reload schema';
commit;
