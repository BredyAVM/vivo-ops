-- Public RPCs are unprivileged entry points. The narrowly authorized private
-- implementations retain their existing auth.uid / persisted role checks.
-- No table permissions or historical data are changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
alter function public.record_order_payment_quote_v1(bigint) set schema app_private;
alter function public.read_payment_rate_review_v1(bigint) set schema app_private;
alter function public.approve_payment_rate_review_v1(bigint,text,text,bigint) set schema app_private;

create function public.record_order_payment_quote_v1(p_order_id bigint) returns jsonb
language sql security invoker set search_path='' as $$
 select app_private.record_order_payment_quote_v1(p_order_id);
$$;
create function public.read_payment_rate_review_v1(p_report_id bigint) returns jsonb
language sql security invoker set search_path='' as $$
 select app_private.read_payment_rate_review_v1(p_report_id);
$$;
create function public.approve_payment_rate_review_v1(p_report_id bigint,p_decision text,p_reason text,p_quote_id bigint default null) returns jsonb
language sql security invoker set search_path='' as $$
 select app_private.approve_payment_rate_review_v1(p_report_id,p_decision,p_reason,p_quote_id);
$$;
revoke all on function public.record_order_payment_quote_v1(bigint),public.read_payment_rate_review_v1(bigint),
 public.approve_payment_rate_review_v1(bigint,text,text,bigint) from public,anon,service_role;
grant execute on function public.record_order_payment_quote_v1(bigint),public.read_payment_rate_review_v1(bigint),
 public.approve_payment_rate_review_v1(bigint,text,text,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
