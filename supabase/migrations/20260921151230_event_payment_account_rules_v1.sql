-- Account/method capabilities are already configured. Reuse them for ALL roles;
-- never label a bank account as cash, or a retention account as a transfer.
do $$ declare definition text; before_text text; after_text text; begin
  definition:=pg_get_functiondef('app_private.event_payment_command_v1(bigint,text,jsonb)'::regprocedure);
  before_text:=$old$if not public.is_master_or_admin() and (method not in ('payment_mobile','transfer','zelle','wallet_usd') or not exists($old$;
  after_text:=$new$if (not public.is_master_or_admin() and method not in ('payment_mobile','transfer','zelle','wallet_usd')) or (not exists($new$;
  if strpos(definition,before_text)=0 then raise exception 'Event account permission contract changed'; end if;
  execute replace(definition,before_text,after_text);
end $$;

create or replace function app_private.event_payment_read_v1(p_root_id bigint) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform app_private.event_workspace_read_v1(p_root_id);
  return jsonb_build_object('payments',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'state',b.state,'request',b.request,'result',b.result,'created_at',b.created_at) order by b.created_at desc)
      from public.event_payment_operations b where b.root_id=p_root_id),'[]'),
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'currency',a.currency_code,'methods',methods.values) order by a.name)
      from public.money_accounts a cross join lateral (
        select jsonb_agg(distinct r.payment_method_code) values from public.money_account_payment_rules r
        join public.user_roles ur on ur.role=r.role and ur.user_id=auth.uid()
        where r.money_account_id=a.id and r.is_active and r.can_report_payment
          and r.payment_method_code in ('payment_mobile','transfer','zelle','wallet_usd','cash_usd','cash_ves','pos')
          and (public.is_master_or_admin() or r.payment_method_code in ('payment_mobile','transfer','zelle','wallet_usd'))
          and ((a.currency_code='USD' and r.payment_method_code in ('zelle','wallet_usd','cash_usd'))
            or (a.currency_code='VES' and r.payment_method_code in ('payment_mobile','transfer','cash_ves','pos')))
      ) methods where a.is_active and methods.values is not null),'[]'));
end $$;
