-- One receipt, allocated through the existing per-order confirmation/void ledger.
-- Audit: payment_reports, payment_confirmation_operations and precision allocations
-- have no aggregate receipt identity. Do not repurpose their movement_group_id.
create table public.event_payment_operations (
  id uuid primary key,
  root_id bigint not null references public.advisor_order_drafts(id),
  state text not null check(state in ('pending','confirming','confirmed','rejected','voiding','voided')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  request jsonb not null check(jsonb_typeof(request)='object'),
  result jsonb not null default '{}'
);
create index event_payment_root_idx on public.event_payment_operations(root_id,created_at desc);
create unique index event_payment_one_pending_idx on public.event_payment_operations(root_id) where state='pending';
alter table public.event_payment_operations enable row level security;
revoke all on public.event_payment_operations from public,anon,authenticated,service_role;
alter table public.payment_reports add column event_payment_id uuid references public.event_payment_operations(id);
create index payment_reports_event_payment_idx on public.payment_reports(event_payment_id) where event_payment_id is not null;

-- Linked evidence can only change within the aggregate transaction. A session
-- setting or a note is NOT authority; transient states are never committed.
create function app_private.guard_event_payment_evidence_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_batch uuid; new_batch uuid; batch public.event_payment_operations%rowtype;
begin
  if tg_table_name='payment_reports' then
    if tg_op<>'INSERT' then old_batch:=old.event_payment_id; end if;
    if tg_op<>'DELETE' then new_batch:=new.event_payment_id; end if;
  else
    if tg_op<>'INSERT' then select event_payment_id into old_batch from public.payment_reports where id=old.payment_report_id; end if;
    if tg_op<>'DELETE' then select event_payment_id into new_batch from public.payment_reports where id=new.payment_report_id; end if;
  end if;
  if old_batch is null and new_batch is null then return coalesce(new,old); end if;
  select * into batch from public.event_payment_operations where id=coalesce(old_batch,new_batch);
  if tg_op='DELETE' or (tg_op='UPDATE' and old_batch is distinct from new_batch)
    or batch.state not in ('confirming','voiding') or not public.is_master_or_admin()
    or (batch.state='voiding' and not public.is_admin()) then
    raise exception 'Este pago pertenece a un evento. Revísalo o anúlalo completo desde la ficha del evento.' using errcode='42501';
  end if;
  return new;
end $$;
create trigger guard_event_payment_reports before insert or update or delete on public.payment_reports
for each row execute function app_private.guard_event_payment_evidence_v1();
create trigger guard_event_payment_money before insert or update or delete on public.money_movements
for each row execute function app_private.guard_event_payment_evidence_v1();

-- Keep the existing duplicate contract, but compare the receipt's TOTAL once.
-- Equal allocations sharing a reference are not duplicate receipts.
create or replace function public.find_active_payment_duplicate(p_money_account_id bigint,p_operation_date date,
 p_currency public.currency_code,p_amount numeric,p_reference_code text,p_exclude_report_id bigint default null)
returns table(source text,report_id bigint,movement_id bigint,order_id bigint,order_number text,client_name text,
 status text,amount numeric,currency_code public.currency_code,operation_date date,reference_code text)
language plpgsql security definer set search_path='' as $$
declare ref text; own_batch uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  ref:=public.normalize_payment_reference_key(p_reference_code);
  if p_money_account_id is null or p_operation_date is null or p_currency is null or p_amount is null or p_amount<=0 or ref is null then return; end if;
  select r.event_payment_id into own_batch from public.payment_reports r
    join public.event_payment_operations b on b.id=r.event_payment_id and b.state='confirming' where r.id=p_exclude_report_id;
  return query
  with matches as (
    select 'payment_report'::text src,r.id rid,r.confirmed_movement_id mid,r.order_id oid,o.order_number::text num,c.full_name::text client,
      r.status::text st,round(r.reported_amount,2) amt,r.reported_currency_code curr,
      coalesce(r.operation_date,r.created_at::date) dt,r.reference_code::text refcode
    from public.payment_reports r join public.orders o on o.id=r.order_id left join public.clients c on c.id=o.client_id
    where r.event_payment_id is null and r.status in ('pending','confirmed') and o.status<>'cancelled'
      and (p_exclude_report_id is null or r.id<>p_exclude_report_id)
      and r.reported_money_account_id=p_money_account_id and coalesce(r.operation_date,r.created_at::date)=p_operation_date
      and r.reported_currency_code=p_currency and round(r.reported_amount,2)=round(p_amount,2)
      and public.normalize_payment_reference_key(r.reference_code)=ref
    union all
    select 'money_movement',m.payment_report_id,m.id,m.order_id,o.order_number::text,c.full_name::text,m.status::text,
      round(m.amount,2),m.currency_code,m.movement_date,m.reference_code::text
    from public.money_movements m join public.orders o on o.id=m.order_id left join public.clients c on c.id=o.client_id
    left join public.payment_reports r on r.id=m.payment_report_id
    where r.event_payment_id is null and m.status='confirmed' and m.direction='inflow' and m.movement_type='order_payment'
      and o.status<>'cancelled' and (p_exclude_report_id is null or m.payment_report_id is distinct from p_exclude_report_id)
      and m.money_account_id=p_money_account_id and m.movement_date=p_operation_date and m.currency_code=p_currency
      and round(m.amount,2)=round(p_amount,2) and public.normalize_payment_reference_key(m.reference_code)=ref
    union all
    select 'event_payment',null::bigint,null::bigint,o.id,o.order_number::text,c.full_name::text,b.state,
      (b.request->>'amount')::numeric,(b.request->>'currency')::public.currency_code,(b.request->>'date')::date,b.request->>'reference'
    from public.event_payment_operations b join public.advisor_order_drafts d on d.id=b.root_id
    join public.orders o on o.id=d.converted_order_id left join public.clients c on c.id=o.client_id
    where b.state in ('pending','confirming','confirmed') and b.id is distinct from own_batch
      and (b.request->>'accountId')::bigint=p_money_account_id and (b.request->>'date')::date=p_operation_date
      and b.request->>'currency'=p_currency::text and (b.request->>'amount')::numeric=round(p_amount,2)
      and public.normalize_payment_reference_key(b.request->>'reference')=ref
  ) select src,rid,mid,oid,num,client,st,amt,curr,dt,refcode from matches
    order by case when st='confirmed' then 0 else 1 end,dt desc,oid desc;
end $$;

-- Server-calculated allocation in native currency, oldest order first. No price
-- edits, FX rewrites, silent credit transfers, change or overpayment conversion.
create function app_private.event_payment_preview_v1(p_root_id bigint,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope jsonb; row_data record; fin record; amount numeric; remaining numeric; take numeric; due numeric;
 currency text:=p_input->>'currency'; rate numeric:=(p_input->>'rate')::numeric; day date:=(p_input->>'date')::date;
 allocations jsonb:='[]'; client bigint;
begin
  scope:=app_private.event_workspace_read_v1(p_root_id);
  if scope#>>'{root,converted_order_id}' is null then raise exception 'Convierte primero el presupuesto inicial.'; end if;
  amount:=(p_input->>'amount')::numeric; remaining:=amount;
  if amount is null or not(amount>0 and amount<=1000000000) or amount<>round(amount,2)
    or currency is null or currency not in ('USD','VES') or day is null or not isfinite(day)
    or (currency='VES' and (rate is null or not(rate>0 and rate<=1000000000))) or (currency='USD' and rate is not null) then
    raise exception 'Revisa monto, moneda, fecha y tasa del pago.';
  end if;
  select client_id into client from public.orders where id=(scope#>>'{root,converted_order_id}')::bigint;
  for row_data in select o.id,o.client_id from public.orders o where o.id in
    (select (value->>'order_id')::bigint from jsonb_array_elements(scope->'orders')) and o.status<>'cancelled' order by o.id
  loop
    if row_data.client_id is distinct from client then raise exception 'Las órdenes del evento deben tener el mismo cliente.'; end if;
    select * into fin from public.get_order_financial_state(row_data.id,day,rate);
    if fin.pending_reports_count>0 then raise exception 'La orden #% tiene pagos pendientes. Revísalos antes de distribuir otro pago.',row_data.id; end if;
    due:=case when currency='VES' then fin.pending_bs else round(fin.pending_usd,2) end;
    take:=least(remaining,greatest(0,coalesce(due,0)));
    if take>0 then
      if currency='VES' and round(take/rate,2)<=0 then raise exception 'La distribución deja un importe demasiado pequeño en la orden #%. Revisa el pago por orden.',row_data.id; end if;
      allocations:=allocations||jsonb_build_array(jsonb_build_object('order_id',row_data.id,'amount',take));
      remaining:=remaining-take;
    end if;
  end loop;
  if remaining>0 then raise exception 'El pago supera el saldo del evento en % %. Registra el excedente o cambio desde el flujo de pagos por orden.',remaining,currency; end if;
  if jsonb_array_length(allocations)=0 then raise exception 'No hay saldo pendiente para distribuir.'; end if;
  return allocations;
end $$;

create function app_private.event_payment_command_v1(p_root_id bigint,p_action text,p_input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope jsonb; batch public.event_payment_operations%rowtype; receipt uuid; actor uuid:=auth.uid();
 allocations jsonb; part jsonb; answer jsonb; confirmations jsonb:='[]'; report bigint; event_id bigint;
 account public.money_accounts%rowtype; method text; currency public.currency_code; rate numeric; amount numeric;
 reason text; title text; base public.orders%rowtype; root public.advisor_order_drafts%rowtype;
begin
  scope:=app_private.event_workspace_read_v1(p_root_id); -- role AND event ownership
  if p_action='preview' then return jsonb_build_object('allocations',app_private.event_payment_preview_v1(p_root_id,p_input)); end if;
  if p_action not in ('report','confirm','reject','void') or p_action is null then raise exception 'Acción no válida.'; end if;
  receipt:=(p_input->>'id')::uuid;
  if receipt is null then raise exception 'Falta la identificación del pago.'; end if;
  -- Same order locks as the individual payment path; do not hold an account lock
  -- and then acquire another order lock later in the allocation loop.
  select * into root from public.advisor_order_drafts where id=p_root_id for update;
  scope:=app_private.event_workspace_read_v1(p_root_id);
  perform id from public.orders where id in(select (value->>'order_id')::bigint from jsonb_array_elements(scope->'orders')) order by id for update;
  select * into base from public.orders where id=root.converted_order_id;
  if not found then raise exception 'El evento todavía no tiene orden inicial.'; end if;
  select * into batch from public.event_payment_operations where id=receipt for update;
  if found and batch.root_id<>p_root_id then raise exception 'El pago no pertenece a este evento.' using errcode='42501'; end if;
  if p_action='report' then
    if batch.id is not null then
      if batch.created_by<>actor or batch.request<>p_input then raise exception 'Este envío ya existe con otros datos.'; end if;
      return jsonb_build_object('id',batch.id,'state',batch.state,'replayed',true);
    end if;
    if exists(select 1 from public.event_payment_operations where root_id=p_root_id and state='pending') then raise exception 'Revisa primero el pago pendiente de este evento.'; end if;
    allocations:=app_private.event_payment_preview_v1(p_root_id,p_input);
    if allocations is distinct from p_input->'allocations' then raise exception 'Los saldos cambiaron. Vuelve a calcular la distribución.'; end if;
    method:=p_input->>'method'; currency:=(p_input->>'currency')::public.currency_code;
    rate:=(p_input->>'rate')::numeric; amount:=(p_input->>'amount')::numeric;
    if method is null or method not in ('payment_mobile','transfer','zelle','wallet_usd','cash_usd','cash_ves','pos')
      or (method in ('zelle','wallet_usd','cash_usd') and currency<>'USD')
      or (method in ('payment_mobile','transfer','cash_ves','pos') and currency<>'VES') then raise exception 'Método y moneda no compatibles.'; end if;
    select * into account from public.money_accounts where id=(p_input->>'accountId')::bigint for update;
    if not found or not account.is_active or account.currency_code<>currency then raise exception 'Selecciona una cuenta activa en la moneda del pago.'; end if;
    if not public.is_master_or_admin() and (method not in ('payment_mobile','transfer','zelle','wallet_usd') or not exists(
      select 1 from public.money_account_payment_rules r join public.user_roles ur on ur.role=r.role and ur.user_id=actor
      where r.money_account_id=account.id and r.payment_method_code=method and r.can_report_payment and r.is_active)) then
      raise exception 'No puedes reportar este método en esa cuenta.' using errcode='42501';
    end if;
    if method in ('payment_mobile','transfer','zelle','wallet_usd') and nullif(btrim(p_input->>'reference'),'') is null then raise exception 'Indica la referencia de la operación.'; end if;
    if method in ('payment_mobile','transfer') and nullif(btrim(p_input->>'bank'),'') is null then raise exception 'Indica el banco.'; end if;
    if method in ('zelle','wallet_usd') and nullif(btrim(p_input->>'payer'),'') is null then raise exception 'Indica el titular del pago.'; end if;
    if exists(select 1 from public.find_active_payment_duplicate(account.id,(p_input->>'date')::date,currency,amount,p_input->>'reference')) then raise exception 'Ya existe un pago con esa cuenta, fecha, monto y referencia.'; end if;
    insert into public.event_payment_operations(id,root_id,state,created_by,request) values(receipt,p_root_id,'pending',actor,p_input);
    title:='Pago del evento pendiente de revisión';
  else
    if not public.is_master_or_admin() then raise exception 'Solo Máster o Administración revisan pagos.' using errcode='42501'; end if;
    if batch.id is null then raise exception 'No se encontró el pago del evento.'; end if;
    if p_action='confirm' then
      if batch.state='confirmed' then return batch.result||jsonb_build_object('replayed',true); end if;
      if batch.state<>'pending' then raise exception 'Este pago ya fue resuelto.'; end if;
      allocations:=app_private.event_payment_preview_v1(p_root_id,batch.request);
      if allocations is distinct from batch.request->'allocations' then raise exception 'Cambió el saldo o las órdenes. Rechaza este reporte y vuelve a distribuirlo; no se registró dinero.'; end if;
      select * into account from public.money_accounts where id=(batch.request->>'accountId')::bigint for update;
      if not found or not account.is_active then raise exception 'La cuenta ya no está activa.'; end if;
      currency:=(batch.request->>'currency')::public.currency_code; rate:=(batch.request->>'rate')::numeric;
      -- Recheck external duplicates, ignoring only this trusted receipt below.
      update public.event_payment_operations set state='confirming' where id=receipt;
      for part in select value from jsonb_array_elements(allocations) loop
        amount:=(part->>'amount')::numeric;
        insert into public.payment_reports(order_id,status,created_by_user_id,reported_currency_code,reported_amount,
          reported_exchange_rate_ves_per_usd,reported_amount_usd_equivalent,reported_money_account_id,reference_code,payer_name,notes,operation_date,event_payment_id)
        values((part->>'order_id')::bigint,'pending',batch.created_by,currency,amount,rate,round(amount/coalesce(rate,1),2),account.id,
          batch.request->>'reference',batch.request->>'payer',concat('Pago del evento ',root.title,'. Banco: ',batch.request->>'bank',E'\n',batch.request->>'notes'),(batch.request->>'date')::date,receipt)
        returning id into report;
        if exists(select 1 from public.find_active_payment_duplicate(account.id,(batch.request->>'date')::date,currency,(batch.request->>'amount')::numeric,batch.request->>'reference',report)) then
          raise exception 'Se encontró otro pago con la misma referencia e importe. No se confirmó nada.';
        end if;
        answer:=public.confirm_payment_report_atomic_v1(jsonb_build_object('reportId',report,'orderId',(part->>'order_id')::bigint,
          'accountId',account.id,'currency',currency,'amount',amount,'rate',rate,'date',batch.request->>'date',
          'reference',batch.request->>'reference','counterparty',batch.request->>'payer','description','Pago distribuido del evento: '||root.title,
          'notes',batch.request->>'notes','requireExplicitHandling',true,'changeLines','[]'::jsonb));
        confirmations:=confirmations||jsonb_build_array(jsonb_build_object('order_id',(part->>'order_id')::bigint,'amount',amount,'report_id',report,'confirmation',answer));
      end loop;
      update public.event_payment_operations set state='confirmed',result=jsonb_build_object('id',receipt,'allocations',confirmations,'reviewed_by',actor,'reviewed_at',clock_timestamp()) where id=receipt;
      title:='Pago del evento confirmado';
    elsif p_action='reject' then
      if batch.state<>'pending' then raise exception 'Solo puedes rechazar pagos pendientes.'; end if;
      reason:=nullif(btrim(p_input->>'reason'),'');
      if length(coalesce(reason,''))<6 then raise exception 'Indica un motivo claro para rechazar.'; end if;
      update public.event_payment_operations set state='rejected',result=jsonb_build_object('reason',reason,'reviewed_by',actor,'reviewed_at',clock_timestamp()) where id=receipt;
      title:='Pago del evento rechazado';
    else
      if not public.is_admin() then raise exception 'Solo Administración puede anular el pago completo.' using errcode='42501'; end if;
      if batch.state='voided' then return batch.result||jsonb_build_object('replayed',true); end if;
      if batch.state<>'confirmed' then raise exception 'Solo puedes anular pagos confirmados.'; end if;
      reason:=nullif(btrim(p_input->>'reason'),'');
      if length(coalesce(reason,''))<6 then raise exception 'Indica un motivo claro para anular.'; end if;
      perform id from public.money_accounts where id in (select m.money_account_id from public.money_movements m
        join public.payment_reports r on r.id=m.payment_report_id where r.event_payment_id=receipt) order by id for update;
      update public.event_payment_operations set state='voiding' where id=receipt;
      for part in select value from jsonb_array_elements(batch.result->'allocations') loop
        perform public.void_financial_movement_v1((part#>>'{confirmation,movementId}')::bigint,null,reason);
      end loop;
      update public.event_payment_operations set state='voided',result=result||jsonb_build_object('reason',reason,'voided_by',actor,'voided_at',clock_timestamp()) where id=receipt;
      title:='Pago del evento anulado';
    end if;
    update public.order_timeline_event_recipients r set requires_action=false,read_at=coalesce(read_at,clock_timestamp())
      from public.order_timeline_events e where e.id=r.event_id and e.payload->>'event_payment_id'=receipt::text and r.requires_action;
  end if;
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values(base.id,base.order_number,'event_payment_'||p_action,'payment',title,coalesce(reason,root.title),'info',actor,
      jsonb_build_object('event_root_id',root.id,'event_payment_id',receipt,'href','/app/events/'||root.id)) returning id into event_id;
  if p_action='report' then insert into public.order_timeline_event_recipients(event_id,target_role,requires_action) values(event_id,'master',true); end if;
  insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action) values(event_id,root.advisor_user_id,false);
  return jsonb_build_object('id',receipt,'ok',true);
end $$;

-- Integrity is checked at commit, including RPCs called directly via PostgREST.
create function app_private.check_event_payment_complete_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare batch public.event_payment_operations%rowtype; amount numeric; n int;
begin
  select * into batch from public.event_payment_operations where id=new.id;
  if batch.state in ('confirming','voiding') then raise exception 'El pago del evento quedó incompleto.'; end if;
  if batch.state='confirmed' then
    select sum(m.amount),count(*) into amount,n from public.payment_reports r join public.money_movements m on m.id=r.confirmed_movement_id
      where r.event_payment_id=batch.id and r.status='confirmed' and m.status='confirmed' and m.direction='inflow' and m.movement_type='order_payment'
        and m.order_id=r.order_id and m.currency_code=(batch.request->>'currency')::public.currency_code and m.money_account_id=(batch.request->>'accountId')::bigint;
    if amount is distinct from (batch.request->>'amount')::numeric or n<>jsonb_array_length(batch.request->'allocations') then raise exception 'El importe distribuido no coincide con el recibo del evento.'; end if;
  elsif batch.state='voided' then
    if exists(select 1 from public.payment_reports r left join public.money_movements m on m.payment_report_id=r.id
      where r.event_payment_id=batch.id and (r.status<>'rejected' or m.status is distinct from 'voided')) then raise exception 'El pago no puede anularse parcialmente.'; end if;
  end if;
  return null;
end $$;
create constraint trigger check_event_payment_complete after insert or update on public.event_payment_operations
deferrable initially deferred for each row execute function app_private.check_event_payment_complete_v1();

create function app_private.event_payment_read_v1(p_root_id bigint) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform app_private.event_workspace_read_v1(p_root_id);
  return jsonb_build_object('payments',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'state',b.state,'request',b.request,'result',b.result,'created_at',b.created_at) order by b.created_at desc)
      from public.event_payment_operations b where b.root_id=p_root_id),'[]'),
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'currency',a.currency_code,
      'methods',case when public.is_master_or_admin() then case when a.currency_code='USD' then '["cash_usd","zelle","wallet_usd"]'::jsonb else '["payment_mobile","transfer","cash_ves","pos"]'::jsonb end
        else (select jsonb_agg(distinct r.payment_method_code) from public.money_account_payment_rules r
          join public.user_roles ur on ur.role=r.role and ur.user_id=auth.uid()
          where r.money_account_id=a.id and r.is_active and r.can_report_payment and r.payment_method_code in ('payment_mobile','transfer','zelle','wallet_usd')) end) order by a.name)
      from public.money_accounts a where a.is_active and (public.is_master_or_admin() or exists(select 1 from public.money_account_payment_rules r
        join public.user_roles ur on ur.role=r.role and ur.user_id=auth.uid() where r.money_account_id=a.id and r.is_active and r.can_report_payment
        and r.payment_method_code in ('payment_mobile','transfer','zelle','wallet_usd')))),'[]'));
end $$;
create function public.event_payment_command_v1(p_root_id bigint,p_action text,p_input jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$select app_private.event_payment_command_v1(p_root_id,p_action,p_input)$$;
create function public.event_payment_read_v1(p_root_id bigint) returns jsonb
language sql stable security invoker set search_path='' as $$select app_private.event_payment_read_v1(p_root_id)$$;
revoke all on function app_private.event_payment_preview_v1(bigint,jsonb),app_private.guard_event_payment_evidence_v1(),app_private.check_event_payment_complete_v1() from public,anon,authenticated;
revoke all on function app_private.event_payment_command_v1(bigint,text,jsonb),public.event_payment_command_v1(bigint,text,jsonb),app_private.event_payment_read_v1(bigint),public.event_payment_read_v1(bigint) from public,anon;
grant execute on function app_private.event_payment_command_v1(bigint,text,jsonb),public.event_payment_command_v1(bigint,text,jsonb),app_private.event_payment_read_v1(bigint),public.event_payment_read_v1(bigint) to authenticated;

-- Extend the existing scoped list, not a new general-access draft endpoint.
do $$ declare definition text; marker text:='in (''requested'',''priced'')) pending'; begin
  definition:=pg_get_functiondef('app_private.event_workspace_read_v1(bigint)'::regprocedure);
  if strpos(definition,marker)=0 then raise exception 'Event workspace read contract changed; audit before migrating.'; end if;
  execute replace(definition,marker,marker||', (select count(*) from public.event_payment_operations ep where ep.root_id=d.id and ep.state=''pending'') payment_pending');
end $$;
