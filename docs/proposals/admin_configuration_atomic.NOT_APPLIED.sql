-- NOT APPLIED: production installation requires explicit authorization.
-- No deployment or Supabase migration command should run this proposal implicitly.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create table if not exists app_private.admin_configuration_audit (
  operation_id uuid primary key,
  actor_id uuid not null,
  command text not null,
  entity_id text not null,
  request_payload jsonb not null,
  previous_value jsonb,
  next_value jsonb not null,
  created_at timestamptz not null default now()
);
revoke all on app_private.admin_configuration_audit from public,anon,authenticated,service_role;
alter table app_private.admin_configuration_audit enable row level security;

create or replace function app_private.assert_configuration_admin_v1() returns uuid
language plpgsql security invoker set search_path='' as $f$
declare v_uid uuid := (select auth.uid());
begin
 if v_uid is null or not public.has_role('admin') or not exists(select 1 from public.profiles p where p.id=v_uid and p.is_active)
 then raise exception 'Esta operación requiere un administrador activo.' using errcode='42501'; end if;
 return v_uid;
end; $f$;
revoke all on function app_private.assert_configuration_admin_v1() from public,anon,authenticated,service_role;

create or replace function public.admin_account_configuration_v1(p_input jsonb,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare
 v_uid uuid; v_id bigint; v_account public.money_accounts%rowtype; v_target public.money_accounts%rowtype;
 v_currency text; v_kind text; v_target_id bigint; v_before jsonb; v_after jsonb; v_saved app_private.admin_configuration_audit%rowtype;
begin
 v_uid:=app_private.assert_configuration_admin_v1();
 if p_operation_id is null or jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Solicitud inválida.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('config:'||p_operation_id::text,0));
 select * into v_saved from app_private.admin_configuration_audit where operation_id=p_operation_id;
 if found then
   if v_saved.actor_id<>v_uid or v_saved.command<>'account' or v_saved.request_payload<>p_input then raise exception 'La solicitud ya fue usada con otros datos.'; end if;
   return v_saved.next_value;
 end if;
 v_currency:=p_input->>'currencyCode'; v_kind:=p_input->>'accountKind';
 if coalesce(length(btrim(p_input->>'name')),0)=0 or v_currency not in ('USD','VES') or v_currency is null
    or v_kind not in ('bank','cash','fund','other','pos','wallet') or v_kind is null then raise exception 'Revisa nombre, moneda y tipo de cuenta.'; end if;
 v_id:=nullif(p_input->>'accountId','')::bigint;
 v_target_id:=nullif(p_input->>'closureDefaultTargetMoneyAccountId','')::bigint;
 if v_kind<>'pos' then v_target_id:=null; end if;
 if v_target_id is not null then
   select * into v_target from public.money_accounts where id=v_target_id;
   if not found or not v_target.is_active or v_target.account_kind::text<>'bank' or v_target.currency_code::text<>v_currency or v_target_id=v_id
   then raise exception 'El destino del cierre debe ser otro banco activo en la misma moneda.'; end if;
 end if;
 if v_id is not null then
   select * into v_account from public.money_accounts where id=v_id for update;
   if not found then raise exception 'Cuenta no encontrada.'; end if;
   if v_account.currency_code::text<>v_currency or v_account.account_kind::text<>v_kind then
     raise exception 'Se conserva la moneda y el tipo de una cuenta existente.'; end if;
   v_before:=jsonb_build_object('account',to_jsonb(v_account),'closureProfile',(select to_jsonb(p) from public.money_account_closure_profiles p where p.money_account_id=v_id));
   update public.money_accounts set name=btrim(p_input->>'name'),institution_name=nullif(btrim(p_input->>'institutionName'),''),
     owner_name=nullif(btrim(p_input->>'ownerName'),''),notes=nullif(btrim(p_input->>'notes'),''),
     is_active=coalesce((p_input->>'isActive')::boolean,false) where id=v_id returning * into v_account;
 else
   insert into public.money_accounts(name,currency_code,account_kind,institution_name,owner_name,notes,is_active,created_by_user_id)
   values(btrim(p_input->>'name'),v_currency::public.currency_code,v_kind::public.account_kind,nullif(btrim(p_input->>'institutionName'),''),
      nullif(btrim(p_input->>'ownerName'),''),nullif(btrim(p_input->>'notes'),''),coalesce((p_input->>'isActive')::boolean,false),v_uid)
   returning * into v_account;
   v_id:=v_account.id;
 end if;
 insert into public.money_account_closure_profiles(money_account_id,closure_kind,requires_zero_difference,allows_classified_difference,
   generates_transfer_on_close,default_target_money_account_id,baseline_required)
 values(v_id,case when v_kind in ('pos','cash','bank','fund') then v_kind when v_kind='wallet' and v_currency='USD' then 'wallet_usd' else 'other' end,
   v_kind in ('pos','cash'),v_kind not in ('pos','cash'),v_kind='pos',v_target_id,true)
 on conflict(money_account_id) do update set default_target_money_account_id=excluded.default_target_money_account_id,updated_at=now();
 v_after:=jsonb_build_object('account',to_jsonb(v_account),'closureProfile',(select to_jsonb(p) from public.money_account_closure_profiles p where p.money_account_id=v_id));
 insert into app_private.admin_configuration_audit(operation_id,actor_id,command,entity_id,request_payload,previous_value,next_value)
 values(p_operation_id,v_uid,'account',v_id::text,p_input,v_before,v_after);
 return v_after;
end; $f$;

create or replace function public.admin_account_rules_v1(p_account_id bigint,p_rules jsonb,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_uid uuid; v_request jsonb; v_before jsonb; v_after jsonb; v_saved app_private.admin_configuration_audit%rowtype;
begin
 v_uid:=app_private.assert_configuration_admin_v1();
 if p_operation_id is null or p_account_id is null or jsonb_typeof(p_rules) is distinct from 'array' or jsonb_array_length(p_rules)=0 or jsonb_array_length(p_rules)>48
 then raise exception 'Reglas inválidas.'; end if;
 v_request:=jsonb_build_object('accountId',p_account_id,'rules',p_rules);
 perform pg_advisory_xact_lock(hashtextextended('config:'||p_operation_id::text,0));
 select * into v_saved from app_private.admin_configuration_audit where operation_id=p_operation_id;
 if found then
   if v_saved.actor_id<>v_uid or v_saved.command<>'rules' or v_saved.request_payload<>v_request then raise exception 'La solicitud ya fue usada con otros datos.'; end if;
   return v_saved.next_value;
 end if;
 perform 1 from public.money_accounts where id=p_account_id for update;
 if not found then raise exception 'Cuenta no encontrada.'; end if;
 if exists(select 1 from jsonb_array_elements(p_rules) r where jsonb_typeof(r)<>'object'
    or coalesce(r->>'role','') not in ('admin','master','advisor','kitchen','counter','driver')
    or coalesce(r->>'payment_method_code','') not in ('payment_mobile','transfer','zelle','wallet_usd','cash_usd','cash_ves','pos','retention')
    or jsonb_typeof(r->'review_roles') is distinct from 'array')
    or exists(select 1 from jsonb_array_elements(p_rules) r cross join lateral jsonb_array_elements_text(r->'review_roles') rr
       where rr not in ('admin','master','advisor','kitchen','counter','driver'))
    or (select count(*) from jsonb_array_elements(p_rules))<>(select count(distinct (r->>'role',r->>'payment_method_code')) from jsonb_array_elements(p_rules) r)
 then raise exception 'Revisa roles, métodos y reglas duplicadas.'; end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.role,r.payment_method_code),'[]'::jsonb) into v_before
   from public.money_account_payment_rules r where r.money_account_id=p_account_id;
 update public.money_account_payment_rules set is_active=false,updated_at=now() where money_account_id=p_account_id;
 insert into public.money_account_payment_rules(money_account_id,role,payment_method_code,can_view_account,can_share_with_client,
   can_report_payment,can_confirm_payment,auto_confirms_report,review_required,review_roles,is_active,updated_at)
 select p_account_id,(r->>'role')::public.user_role,r->>'payment_method_code',
   coalesce((r->>'can_view_account')::boolean,false),coalesce((r->>'can_share_with_client')::boolean,false),
   coalesce((r->>'can_report_payment')::boolean,false),coalesce((r->>'can_confirm_payment')::boolean,false),
   coalesce((r->>'auto_confirms_report')::boolean,false),coalesce((r->>'review_required')::boolean,false),
   array(select rr::public.user_role from jsonb_array_elements_text(r->'review_roles') rr),
   coalesce((r->>'is_active')::boolean,false),now()
 from jsonb_array_elements(p_rules) r
 on conflict(money_account_id,role,payment_method_code) do update set
   can_view_account=excluded.can_view_account,can_share_with_client=excluded.can_share_with_client,
   can_report_payment=excluded.can_report_payment,can_confirm_payment=excluded.can_confirm_payment,
   auto_confirms_report=excluded.auto_confirms_report,review_required=excluded.review_required,
   review_roles=excluded.review_roles,is_active=excluded.is_active,updated_at=excluded.updated_at;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.role,r.payment_method_code),'[]'::jsonb) into v_after
   from public.money_account_payment_rules r where r.money_account_id=p_account_id;
 insert into app_private.admin_configuration_audit(operation_id,actor_id,command,entity_id,request_payload,previous_value,next_value)
 values(p_operation_id,v_uid,'rules',p_account_id::text,v_request,v_before,v_after);
 return v_after;
end; $f$;

create or replace function public.admin_account_baseline_v1(p_input jsonb,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_uid uuid; v_account public.money_accounts%rowtype; v_saved app_private.admin_configuration_audit%rowtype;
 v_id bigint; v_date date; v_counted numeric; v_rate numeric; v_expected numeric; v_expected_usd numeric; v_counted_usd numeric; v_result jsonb;
begin
 v_uid:=(select auth.uid());
 if v_uid is null or not(public.has_role('admin') or public.has_role('master')) or not exists(select 1 from public.profiles p where p.id=v_uid and p.is_active)
 then raise exception 'Esta operación requiere un administrador o master activo.' using errcode='42501'; end if;
 if p_operation_id is null or jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Solicitud inválida.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('config:'||p_operation_id::text,0));
 select * into v_saved from app_private.admin_configuration_audit where operation_id=p_operation_id;
 if found then
   if v_saved.actor_id<>v_uid or v_saved.command<>'baseline' or v_saved.request_payload<>p_input then raise exception 'La solicitud ya fue usada con otros datos.'; end if;
   return v_saved.next_value;
 end if;
 v_id:=(p_input->>'moneyAccountId')::bigint; v_date:=(p_input->>'baselineDate')::date;
 v_counted:=round((p_input->>'countedAmount')::numeric,2); v_rate:=(p_input->>'exchangeRateVesPerUsd')::numeric;
 if v_date is null or v_date>(now() at time zone 'America/Caracas')::date or v_counted is null or v_counted<0 or v_counted::text in ('NaN','Infinity','-Infinity')
 then raise exception 'Revisa la fecha y el saldo inicial contado.'; end if;
 select * into v_account from public.money_accounts where id=v_id for update;
 if not found then raise exception 'Cuenta no encontrada.'; end if;
 if exists(select 1 from public.money_account_closure_baselines where money_account_id=v_id and status='active') then raise exception 'La cuenta ya tiene línea base activa.'; end if;
 if v_account.currency_code::text='VES' and (v_rate is null or v_rate<=0 or v_rate::text in ('NaN','Infinity','-Infinity')) then raise exception 'La tasa es obligatoria para una cuenta en Bs.'; end if;
 select round(coalesce(sum(case when direction='inflow' then amount else -amount end),0),2),
   round(coalesce(sum(case when direction='inflow' then amount_usd_equivalent else -amount_usd_equivalent end),0),2)
 into v_expected,v_expected_usd from public.money_movements where money_account_id=v_id and status='confirmed' and movement_date<=v_date;
 v_counted_usd:=case when v_account.currency_code::text='USD' then v_counted else round(v_counted/v_rate,2) end;
 insert into public.money_account_closure_baselines as baseline(money_account_id,baseline_date,baseline_at,currency_code,exchange_rate_ves_per_usd,
 expected_amount,counted_amount,difference_amount,expected_amount_usd,counted_amount_usd,difference_amount_usd,reason,notes,created_by_user_id)
 values(v_id,v_date,((v_date+time '23:59:59') at time zone 'America/Caracas'),v_account.currency_code::text,
 case when v_account.currency_code::text='VES' then v_rate else null end,v_expected,v_counted,v_counted-v_expected,
 v_expected_usd,v_counted_usd,v_counted_usd-v_expected_usd,nullif(btrim(p_input->>'reason'),''),nullif(btrim(p_input->>'notes'),''),v_uid)
 returning to_jsonb(baseline.*) into v_result;
 insert into app_private.admin_configuration_audit(operation_id,actor_id,command,entity_id,request_payload,next_value)
 values(p_operation_id,v_uid,'baseline',v_id::text,p_input,v_result);
 return v_result;
end; $f$;

create or replace function public.admin_user_configuration_v1(p_input jsonb)
returns void language plpgsql security definer set search_path='' as $f$
declare v_uid uuid; v_id uuid; v_roles public.user_role[]; v_profile public.profiles%rowtype; v_before jsonb;
begin
 v_uid:=app_private.assert_configuration_admin_v1();
 perform pg_advisory_xact_lock(20261001,1);
 v_uid:=app_private.assert_configuration_admin_v1();
 if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(p_input->'roles') is distinct from 'array'
   or jsonb_array_length(p_input->'roles')=0 or jsonb_array_length(p_input->'roles')>6
 then raise exception 'Selecciona al menos un rol.'; end if;
 v_id:=(p_input->>'userId')::uuid;
 select array_agg(distinct r::public.user_role) into v_roles from jsonb_array_elements_text(p_input->'roles') r;
 if coalesce(length(btrim(p_input->>'fullName')),0)=0 then raise exception 'El nombre es obligatorio.'; end if;
 if v_id=v_uid and (not ('admin'::public.user_role=any(v_roles)) or not coalesce((p_input->>'isActive')::boolean,false))
 then raise exception 'Conserva tu propio acceso de administrador activo.'; end if;
 select * into v_profile from public.profiles where id=v_id for update;
 if not found then raise exception 'Usuario no encontrado.'; end if;
 v_before:=jsonb_build_object('profile',to_jsonb(v_profile),'roles',(select jsonb_agg(role order by role) from public.user_roles where user_id=v_id));
 update public.profiles set full_name=btrim(p_input->>'fullName'),is_active=coalesce((p_input->>'isActive')::boolean,false),
   receives_commissions=('advisor'::public.user_role=any(v_roles)) and coalesce((p_input->>'receivesCommissions')::boolean,false) where id=v_id;
 delete from public.user_roles where user_id=v_id and not(role=any(v_roles));
 insert into public.user_roles(user_id,role) select v_id,unnest(v_roles) on conflict(user_id,role) do nothing;
 insert into app_private.admin_configuration_audit(operation_id,actor_id,command,entity_id,request_payload,previous_value,next_value)
 values(gen_random_uuid(),v_uid,'user',v_id::text,p_input,v_before,p_input);
end; $f$;

revoke all on function public.admin_account_configuration_v1(jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.admin_account_rules_v1(bigint,jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.admin_account_baseline_v1(jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.admin_user_configuration_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admin_account_configuration_v1(jsonb,uuid) to authenticated;
grant execute on function public.admin_account_rules_v1(bigint,jsonb,uuid) to authenticated;
grant execute on function public.admin_account_baseline_v1(jsonb,uuid) to authenticated;
grant execute on function public.admin_user_configuration_v1(jsonb) to authenticated;
create or replace function public.admin_configuration_history_v1(p_page integer default 1,p_command text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare v_uid uuid; v_rows jsonb;
begin
 v_uid:=app_private.assert_configuration_admin_v1();
 if p_page is null or p_page<1 or p_page>10000 or (p_command is not null and p_command not in ('account','rules','baseline','user')) then raise exception 'Filtro inválido.'; end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.operation_id),'[]'::jsonb) into v_rows
 from (select a.operation_id,a.command,a.entity_id,a.previous_value,a.next_value,a.created_at,
    coalesce(p.full_name,'Usuario') as actor_name,
    case when a.command='user' then (select u.full_name from public.profiles u where u.id::text=a.entity_id)
      else (select m.name from public.money_accounts m where m.id::text=a.entity_id) end as entity_name
  from app_private.admin_configuration_audit a left join public.profiles p on p.id=a.actor_id
  where p_command is null or a.command=p_command
  order by a.created_at desc,a.operation_id offset (p_page-1)*25 limit 26) r;
 return v_rows;
end; $f$;
revoke all on function public.admin_configuration_history_v1(integer,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_configuration_history_v1(integer,text) to authenticated;


-- Read-only readiness handshake; never enables forms when the migration is absent.
create or replace function public.admin_configuration_capabilities_v1()
returns jsonb language plpgsql stable security definer set search_path=''
as $
begin
  perform app_private.assert_configuration_admin_v1();
  return jsonb_build_object('version','admin-configuration-v1','atomic',true);
end;
$;
revoke all on function public.admin_configuration_capabilities_v1() from public,anon,authenticated,service_role;
grant execute on function public.admin_configuration_capabilities_v1() to authenticated;

commit;
