-- Applied version matches Supabase migration history.
-- Shared quote, advisor ownership, and operation date present at INSERT time.
-- No migration of payments, money movements, closures, or customer debt.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter function app_private.counter_read_payment_quote_at_rate_v1(bigint,date,numeric)
  rename to read_order_payment_day_quote_v1;
do $patch$
declare d text; a text;
begin
  d:=pg_get_functiondef('app_private.read_order_payment_day_quote_v1(bigint,date,numeric)'::regprocedure);
  a:='not(public.has_role(''counter'') or public.is_master_or_admin())';
  if position(a in d)=0 then raise exception 'Quote authority changed'; end if;
  execute replace(d,a,$new$not(public.has_role('counter') or public.is_master_or_admin()
    or (public.has_role('advisor') and exists(select 1 from public.orders o
      where o.id=p_order_id and o.attributed_advisor_id=auth.uid())))$new$);

  -- Preserve every existing authorization/validation in the original writer.
  -- Unlike a follow-up UPDATE, the date is visible to rate-capture triggers.
  d:=pg_get_functiondef('public.create_payment_report(bigint,bigint,public.currency_code,numeric,numeric,text,text,text)'::regprocedure);
  d:=replace(d,'public.create_payment_report(p_order_id bigint,',
    'app_private.create_payment_report_on_date_v1(p_operation_date date, p_order_id bigint,');
  a:='  if p_reported_amount is null or p_reported_amount <= 0 then';
  if position(a in d)=0 then raise exception 'Report validation changed'; end if;
  d:=replace(d,a,$new$  if p_operation_date is null or p_operation_date>(statement_timestamp() at time zone 'America/Caracas')::date then
    raise exception 'Indica la fecha real del pago; no puede ser futura.' using errcode='22023'; end if;
  if public.has_role('advisor') and not public.is_master_or_admin() and not exists(
    select 1 from public.money_account_payment_rules r where r.role='advisor'
      and r.money_account_id=p_reported_money_account_id and r.is_active and r.can_report_payment
  ) then raise exception 'No tienes permiso para reportar pagos en esta cuenta.' using errcode='42501'; end if;
$new$||a);
  a:=E'    notes\n  ) values (';
  if position(a in d)=0 then raise exception 'Report insertion changed'; end if;
  d:=replace(d,a,E'    notes,\n    operation_date\n  ) values (');
  a:=E'    nullif(btrim(p_notes), '''')\n  )';
  if position(a in d)=0 then raise exception 'Report values changed'; end if;
  d:=replace(d,a,E'    nullif(btrim(p_notes), ''''),\n    p_operation_date\n  )');
  execute d;
end $patch$;

create function app_private.counter_read_payment_quote_at_rate_v1(p_order_id bigint,p_operation_date date,p_rate numeric)
returns jsonb language sql stable security invoker set search_path='' as $$
  select app_private.read_order_payment_day_quote_v1(p_order_id,p_operation_date,p_rate);
$$;
create function public.read_order_payment_day_quote_v1(p_order_id bigint,p_operation_date date,p_rate numeric default null)
returns jsonb language sql stable security invoker set search_path='' as $$
  select app_private.read_order_payment_day_quote_v1(p_order_id,p_operation_date,p_rate);
$$;
create function public.create_payment_report_on_date_v1(p_operation_date date,p_order_id bigint,
  p_reported_money_account_id bigint,p_reported_currency public.currency_code,p_reported_amount numeric,
  p_reported_exchange_rate_ves_per_usd numeric default null,p_reference_code text default null,
  p_payer_name text default null,p_notes text default null)
returns bigint language sql security invoker set search_path='' as $$
  select app_private.create_payment_report_on_date_v1(p_operation_date,p_order_id,p_reported_money_account_id,
    p_reported_currency,p_reported_amount,p_reported_exchange_rate_ves_per_usd,p_reference_code,p_payer_name,p_notes);
$$;
revoke all on function app_private.counter_read_payment_quote_at_rate_v1(bigint,date,numeric),
  public.read_order_payment_day_quote_v1(bigint,date,numeric),
  app_private.create_payment_report_on_date_v1(date,bigint,bigint,public.currency_code,numeric,numeric,text,text,text),
  public.create_payment_report_on_date_v1(date,bigint,bigint,public.currency_code,numeric,numeric,text,text,text)
from public,anon,service_role;
grant execute on function app_private.counter_read_payment_quote_at_rate_v1(bigint,date,numeric),
  public.read_order_payment_day_quote_v1(bigint,date,numeric),
  app_private.create_payment_report_on_date_v1(date,bigint,bigint,public.currency_code,numeric,numeric,text,text,text),
  public.create_payment_report_on_date_v1(date,bigint,bigint,public.currency_code,numeric,numeric,text,text,text)
to authenticated;
notify pgrst,'reload schema';
commit;
