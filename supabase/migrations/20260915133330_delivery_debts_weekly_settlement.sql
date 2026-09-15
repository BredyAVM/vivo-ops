-- Weekly deductions are non-cash offsets. Only the net payout affects an account.
begin;
set local lock_timeout='5s';
set local statement_timeout='45s';

create table public.delivery_debts (
  id uuid primary key, responsible_key text not null, responsible_name text not null,
  debt_date date not null, concept text not null check(length(concept) between 3 and 200),
  kind text not null check(kind in ('loan','other','order')),
  amount_usd numeric(16,2) not null check(amount_usd>0 and amount_usd<=999999999.99),
  order_id bigint references public.orders(id), client_id bigint references public.clients(id),
  created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), request jsonb not null,
  voided_at timestamptz, voided_by uuid references auth.users(id), void_reason text,
  check((kind='order')=(order_id is not null)), check(kind<>'order' or client_id is not null)
);
create unique index delivery_debts_order_active_idx on public.delivery_debts(order_id) where voided_at is null;
create index delivery_debts_payee_date_idx on public.delivery_debts(responsible_key,debt_date);
create index delivery_debts_client_idx on public.delivery_debts(client_id);
create index delivery_debts_actor_idx on public.delivery_debts(created_by);
create index delivery_debts_void_actor_idx on public.delivery_debts(voided_by);
create table public.delivery_debt_allocations (
  payment_id uuid not null references public.delivery_service_payments(request_id),
  debt_id uuid not null references public.delivery_debts(id),
  amount_usd numeric(16,2) not null check(amount_usd>0),
  balance_before_usd numeric not null, rounding_usd numeric not null default 0,
  order_id bigint references public.orders(id), client_id bigint references public.clients(id),
  created_at timestamptz not null default now(), reversed_at timestamptz,
  primary key(payment_id,debt_id)
);
create index delivery_debt_allocations_debt_idx on public.delivery_debt_allocations(debt_id);
create index delivery_debt_allocations_order_idx on public.delivery_debt_allocations(order_id);
create index delivery_debt_allocations_client_idx on public.delivery_debt_allocations(client_id);
alter table public.delivery_debts enable row level security;
alter table public.delivery_debt_allocations enable row level security;
revoke all on public.delivery_debts,public.delivery_debt_allocations from public,anon,authenticated,service_role;
grant select on public.delivery_debts,public.delivery_debt_allocations to authenticated;
grant select on public.delivery_debt_allocations to service_role;
create policy delivery_debts_admin_read on public.delivery_debts for select to authenticated
  using(exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role='admin'));
-- Order coverage is visible to the same roles that can read that order, not other drivers' debts.
create policy delivery_debt_allocations_read on public.delivery_debt_allocations for select to authenticated
  using(exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role='admin')
    or exists(select 1 from public.orders o where o.id=delivery_debt_allocations.order_id
      and ((select public.is_master_or_admin()) or (select public.has_role('counter'))
        or ((select public.has_role('advisor')) and o.attributed_advisor_id=(select auth.uid())))));

alter table public.delivery_service_payments alter column money_movement_id drop not null;
alter table public.delivery_service_payments drop constraint delivery_service_payments_total_usd_check;
alter table public.delivery_service_payments add check(total_usd>=0);
alter table public.delivery_service_payments add check((total_usd=0)=(money_movement_id is null));

create function app_private.delivery_debt_state_v1(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d public.delivery_debts; s record; bal numeric; precise numeric; paid numeric; history jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  select * into d from public.delivery_debts where id=p_id;
  if not found then raise exception 'Deuda no encontrada.' using errcode='22023'; end if;
  select coalesce(sum(amount_usd) filter(where reversed_at is null),0),
    coalesce(jsonb_agg(jsonb_build_object('paymentId',payment_id,'amount',amount_usd,'reversed',reversed_at is not null) order by created_at,payment_id),'[]')
  into paid,history from public.delivery_debt_allocations where debt_id=p_id;
  if d.kind='order' then
    select * into s from public.get_order_financial_state(d.order_id);
    precise:=case when s.order_status='cancelled' or d.client_id is distinct from (select client_id from public.orders where id=d.order_id)
      then 0 else greatest(0,s.pending_usd) end;
    bal:=round(precise,2);
  else bal:=greatest(0,d.amount_usd-paid); precise:=bal; end if;
  if d.voided_at is not null then bal:=0; precise:=0; end if;
  return jsonb_build_object('id',d.id,'responsibleKey',d.responsible_key,'responsible',d.responsible_name,
    'date',d.debt_date,'kind',d.kind,'concept',d.concept,'original',d.amount_usd,'balance',bal,'balancePrecise',precise,'deducted',paid,
    'orderId',d.order_id,'client',case when d.client_id is not null then (select full_name from public.clients where id=d.client_id) end,
    'voided',d.voided_at is not null,'voidReason',d.void_reason,'history',history,
    'fingerprint',md5(jsonb_build_array(d.id,d.responsible_key,d.amount_usd,d.order_id,d.client_id,bal,precise,paid,d.voided_at,history)::text));
end $$;
create function public.admin_delivery_debts_v1(p_to date) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare rows jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  if p_to is null or not isfinite(p_to) then raise exception 'Fecha inválida.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(app_private.delivery_debt_state_v1(id) order by debt_date,id),'[]') into rows
    from public.delivery_debts where debt_date<=p_to;
  if jsonb_array_length(rows)>5000 then raise exception 'Demasiadas deudas; requiere consulta paginada.'; end if;
  return jsonb_build_object('version',1,'to',p_to,'rows',rows);
end $$;

create function app_private.create_delivery_debt_v1(p_request_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); d public.delivery_debts; nm text; o public.orders; s record;
  k text:=p_input->>'responsibleKey'; dt date:=(p_input->>'date')::date; kind text:=p_input->>'kind';
  amt numeric:=(p_input->>'amount')::numeric; oid bigint:=(p_input->>'orderId')::bigint; concept text:=btrim(p_input->>'concept');
begin
  if uid is null or not exists(select 1 from public.user_roles where user_id=uid and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  if p_request_id is null or jsonb_typeof(p_input) is distinct from 'object' or dt is null or not isfinite(dt)
    or dt>(statement_timestamp() at time zone 'America/Caracas')::date or kind is null or kind not in ('loan','other','order')
    or concept is null or length(concept) not between 3 and 200 or not coalesce((p_input->>'confirmed')::boolean,false) then
    raise exception 'Revisa los datos y confirma el origen de la deuda.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('delivery-debt:'||p_request_id::text,0));
  select * into d from public.delivery_debts where id=p_request_id;
  if found then
    if d.created_by<>uid or d.request<>p_input or d.voided_at is not null then raise exception 'Solicitud ya utilizada o anulada.' using errcode='22023'; end if;
    return jsonb_build_object('id',d.id,'replayed',true);
  end if;
  if k like 'internal:%' then
    select full_name into nm from public.profiles p where 'internal:'||p.id::text=k and p.is_active
      and exists(select 1 from public.user_roles where user_id=p.id and role='driver');
  elsif k like 'external:%' then select name into nm from public.delivery_partners where 'external:'||id::text=k and is_active; end if;
  if nm is null then raise exception 'Selecciona un responsable activo.' using errcode='22023'; end if;
  if kind='order' then
    select * into o from public.orders where id=oid for update;
    if not found or o.client_id is null or o.status='cancelled' then raise exception 'Pedido no disponible para vincular.' using errcode='22023'; end if;
    select * into s from public.get_order_financial_state(oid);
    if s.pending_reports_count>0 then raise exception 'Revisa primero los pagos reportados de este pedido.' using errcode='22023'; end if;
    if amt is distinct from round(s.pending_usd,2) or amt<=0 or (p_input->>'clientId')::bigint is distinct from o.client_id then
      raise exception 'Cambió el saldo o el cliente. Consulta nuevamente el pedido.' using errcode='40001'; end if;
  elsif oid is not null then raise exception 'Usa compra vinculada para un pedido existente.' using errcode='22023'; end if;
  if amt is null or not(amt>0 and amt<=999999999.99) or round(amt,2)<>amt then raise exception 'Importe inválido.' using errcode='22023'; end if;
  insert into public.delivery_debts(id,responsible_key,responsible_name,debt_date,concept,kind,amount_usd,order_id,client_id,created_by,request)
  values(p_request_id,k,nm,dt,concept,kind,amt,oid,o.client_id,uid,p_input);
  return jsonb_build_object('id',p_request_id,'replayed',false);
end $$;
create function public.create_delivery_debt_v1(p_request_id uuid,p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select app_private.create_delivery_debt_v1(p_request_id,p_input); $$;
create function app_private.void_delivery_debt_v1(p_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.delivery_debts;
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo administración.' using errcode='42501'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 6 and 500 then raise exception 'Indica un motivo (6 a 500 caracteres).' using errcode='22023'; end if;
  select * into d from public.delivery_debts where id=p_id for update;
  if not found then raise exception 'Deuda no encontrada.' using errcode='22023'; end if;
  if exists(select 1 from public.delivery_debt_allocations where debt_id=p_id and reversed_at is null) then
    raise exception 'Anula primero las liquidaciones con descuentos de esta deuda.' using errcode='22023'; end if;
  if d.voided_at is null then update public.delivery_debts set voided_at=statement_timestamp(),voided_by=auth.uid(),void_reason=btrim(p_reason) where id=p_id; end if;
  return jsonb_build_object('voided',true);
end $$;
create function public.void_delivery_debt_v1(p_id uuid,p_reason text) returns jsonb
language sql security invoker set search_path='' as $$ select app_private.void_delivery_debt_v1(p_id,p_reason); $$;

revoke all on function app_private.delivery_debt_state_v1(uuid),public.admin_delivery_debts_v1(date),
  app_private.create_delivery_debt_v1(uuid,jsonb),public.create_delivery_debt_v1(uuid,jsonb),
  app_private.void_delivery_debt_v1(uuid,text),public.void_delivery_debt_v1(uuid,text) from public,anon,service_role;
grant execute on function app_private.delivery_debt_state_v1(uuid),public.admin_delivery_debts_v1(date),
  app_private.create_delivery_debt_v1(uuid,jsonb),public.create_delivery_debt_v1(uuid,jsonb),
  app_private.void_delivery_debt_v1(uuid,text),public.void_delivery_debt_v1(uuid,text) to authenticated;

-- Validate selected installments under locks. No automatic debt selection or hidden capping.
create function app_private.prepare_delivery_deductions_v1(p_rows jsonb,p_key text,p_to date,p_date date,p_gross numeric)
returns jsonb language plpgsql security definer set search_path='' as $$
declare x jsonb; d public.delivery_debts; state jsonb; total numeric:=0; amount numeric; evidence jsonb:='[]'; s record; basis record; rounding numeric;
begin
  if auth.uid() is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin') then raise exception 'Solo administración.' using errcode='42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>100 then raise exception 'Descuentos inválidos.' using errcode='22023'; end if;
  if (select count(distinct item->>'id') from jsonb_array_elements(p_rows)item)<>jsonb_array_length(p_rows) then raise exception 'Deudas repetidas.' using errcode='22023'; end if;
  for x in select value from jsonb_array_elements(p_rows) order by value->>'id' loop
    select * into d from public.delivery_debts where id=(x->>'id')::uuid for update;
    if not found or d.voided_at is not null or d.responsible_key<>p_key or d.debt_date>least(p_to,p_date) then
      raise exception 'Deuda anulada, de otro responsable o posterior al período/pago.' using errcode='22023'; end if;
    state:=app_private.delivery_debt_state_v1(d.id); amount:=(x->>'amount')::numeric;
    if x->>'fingerprint' is distinct from state->>'fingerprint' then raise exception 'Cambió una deuda. Actualiza y revisa los descuentos.' using errcode='40001'; end if;
    if amount is null or not(amount>0 and amount<=(state->>'balance')::numeric) or round(amount,2)<>amount then
      raise exception 'El descuento debe ser positivo y no superar el saldo de la deuda.' using errcode='22023'; end if;
    rounding:=0;
    if d.order_id is not null then
      select * into s from public.get_order_financial_state(d.order_id,p_date);
      if s.pending_reports_count>0 or s.order_status='cancelled' then raise exception 'Revisa los pagos pendientes o la cancelación del pedido antes de descontar.' using errcode='22023'; end if;
      select * into basis from public.order_collection_precision_basis_v1(d.order_id);
      if found then
        select a.rounding_usd into rounding from app_private.collection_payment_allocation_v1(s.pending_usd,s.pending_bs,'USD',amount,1,1)a;
        insert into public.order_collection_precision_enrollments(order_id,created_by) values(d.order_id,auth.uid()) on conflict do nothing;
      end if;
    end if;
    total:=total+amount;
    evidence:=evidence||jsonb_build_array(jsonb_build_object('id',d.id,'concept',d.concept,'amount',amount,
      'balanceBefore',(state->>'balance')::numeric,'balanceAfter',greatest(0,round((state->>'balancePrecise')::numeric-amount-rounding,2)),
      'kind',d.kind,'orderId',d.order_id,'clientId',d.client_id,'rounding',rounding));
  end loop;
  if total>p_gross then raise exception 'Los descuentos superan lo ganado. Reduce el descuento; la deuda restante se conserva.' using errcode='22023'; end if;
  return jsonb_build_object('total',total,'rows',evidence);
end $$;
revoke all on function app_private.prepare_delivery_deductions_v1(jsonb,text,date,date,numeric) from public,anon,authenticated,service_role;

-- A purchase is covered through a paired client-fund credit/application. Net fund
-- balance stays unchanged; this is earned compensation, never invented bank income.
create function app_private.apply_delivery_deductions_v1(p_payment uuid,p_rows jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare x jsonb; amount numeric; oid bigint; cid bigint;
begin
  for x in select value from jsonb_array_elements(p_rows) loop
    amount:=(x->>'amount')::numeric; oid:=(x->>'orderId')::bigint; cid:=(x->>'clientId')::bigint;
    insert into public.delivery_debt_allocations(payment_id,debt_id,amount_usd,balance_before_usd,rounding_usd,order_id,client_id)
    values(p_payment,(x->>'id')::uuid,amount,(x->>'balanceBefore')::numeric,(x->>'rounding')::numeric,oid,cid);
    if oid is not null then
      insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,order_id,reason_code,notes,created_by_user_id,movement_group_id)
      values(cid,'credit','USD',amount,amount,oid,'delivery_earnings_offset','Compensación de servicios de delivery; sin ingreso de efectivo',auth.uid(),p_payment),
        (cid,'debit','USD',amount,amount,oid,'order_fund_applied','Compra abonada mediante liquidación de delivery',auth.uid(),p_payment);
      insert into public.order_events(order_id,event,performed_by,meta) values(oid,'delivery_debt_offset',auth.uid(),
        jsonb_build_object('payment_id',p_payment,'amount_usd',amount,'rounding_usd',(x->>'rounding')::numeric));
    end if;
  end loop;
end $$;
revoke all on function app_private.apply_delivery_deductions_v1(uuid,jsonb) from public,anon,authenticated,service_role;

-- Amend the audited payment command in-place, keeping all cost/claim checks.
do $patch$
declare def text; anchor text;
begin
  if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='app_private.pay_delivery_services_v1(uuid,jsonb)'::regprocedure)<>'4d90aabbb4bf939e28b7e3c3b2b760a9' then raise exception 'Payment implementation changed; review migration'; end if;
  def:=pg_get_functiondef('app_private.pay_delivery_services_v1(uuid,jsonb)'::regprocedure);
  def:=replace(def,'v_order_total numeric:=0;', 'v_deductions jsonb:=coalesce(p_input->''deductions'',''[]''::jsonb); v_deduction_result jsonb; v_gross numeric; v_order_total numeric:=0;');
  anchor:='  -- Lock every order in stable order before recalculating; prevents overlapping periods paying twice.';
  def:=replace(def,anchor,$code$
  if jsonb_typeof(v_deductions) is distinct from 'array' or jsonb_array_length(v_deductions)>100 then raise exception 'Descuentos inválidos.' using errcode='22023'; end if;
  -- Purchase and delivery orders share the canonical financial lock hierarchy.
  perform id from public.orders where id in (
    select (x->>'id')::bigint from jsonb_array_elements(p_input->'items')x
    union select order_id from public.delivery_debts where id in(select (x->>'id')::uuid from jsonb_array_elements(v_deductions)x)
  ) order by id for update;
$code$||anchor);
  anchor:='  if v_existing is not null then';
  def:=replace(def,anchor,$code$
  v_gross:=v_total;
  v_deduction_result:=app_private.prepare_delivery_deductions_v1(v_deductions,v_key,v_to,v_date,v_gross);
  v_total:=v_gross-(v_deduction_result->>'total')::numeric;
  if v_total=0 then
    if v_existing is not null or p_input->>'accountId' is not null or coalesce(v_native,0)<>0 then
      raise exception 'La liquidación en cero no lleva egreso ni cuenta.' using errcode='22023'; end if;
  elsif v_existing is not null then
$code$);
  anchor:='  insert into public.delivery_service_payments(request_id';
  def:=replace(def,anchor,$code$
  v_result:=v_result||jsonb_build_object('grossUsd',v_gross,'deductionUsd',(v_deduction_result->>'total')::numeric,
    'deductions',v_deduction_result->'rows','paymentDate',coalesce(v_movement.movement_date,v_date));
$code$||anchor);
  anchor:='  insert into public.delivery_service_payment_items(order_id';
  def:=replace(def,anchor,$code$
  perform app_private.apply_delivery_deductions_v1(p_request_id,v_deduction_result->'rows');
$code$||anchor);
  execute def;

  if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='public.order_collection_precision_basis_v1(bigint)'::regprocedure)<>'72f379fe62abc68cda57f8cff21cee90' then raise exception 'Precision implementation changed; review migration'; end if;
  def:=pg_get_functiondef('public.order_collection_precision_basis_v1(bigint)'::regprocedure);
  anchor:='where a.order_id=p_order_id and m.status=''confirmed''),0)';
  if position(anchor in def)=0 then raise exception 'Precision anchor changed'; end if;
  def:=replace(def,anchor,anchor||$code$
    + coalesce((select sum(d.rounding_usd) from public.delivery_debt_allocations d where d.order_id=p_order_id and d.reversed_at is null),0)
$code$);
  execute def;

  if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='public.admin_delivery_services_v1(date,date)'::regprocedure)<>'6323637e8c786adce9a453d6235587af' then raise exception 'Delivery report changed; review migration'; end if;
  def:=pg_get_functiondef('public.admin_delivery_services_v1(date,date)'::regprocedure);
  def:=replace(def,'''date'',m.movement_date,''status'',m.status', '''date'',coalesce(m.movement_date,(pay.result->>''paymentDate'')::date),''status'',coalesce(m.status,''confirmed''::public.money_movement_status)');
  -- Resolve enum name from the real column instead of assuming it.
  def:=replace(def,'''confirmed''::public.money_movement_status', '''confirmed''');
  execute def;
end $patch$;

create function app_private.reverse_delivery_deductions_v1(p_payment uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.delivery_debt_allocations;
begin
  for a in select * from public.delivery_debt_allocations where payment_id=p_payment and reversed_at is null order by debt_id for update loop
    if a.order_id is not null then
      insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,order_id,reason_code,notes,created_by_user_id,movement_group_id)
      values(a.client_id,'credit','USD',a.amount_usd,a.amount_usd,a.order_id,'order_fund_restore','Anulación de compensación de delivery',auth.uid(),p_payment),
        (a.client_id,'debit','USD',a.amount_usd,a.amount_usd,a.order_id,'delivery_offset_reversal','Reversión de compensación; sin salida de efectivo',auth.uid(),p_payment);
      insert into public.order_events(order_id,event,performed_by,meta) values(a.order_id,'delivery_debt_offset_voided',auth.uid(),jsonb_build_object('payment_id',p_payment,'amount_usd',a.amount_usd));
    end if;
    update public.delivery_debt_allocations set reversed_at=statement_timestamp() where payment_id=a.payment_id and debt_id=a.debt_id;
  end loop;
end $$;
revoke all on function app_private.reverse_delivery_deductions_v1(uuid) from public,anon,authenticated,service_role;
do $patch$
declare def text; anchor text;
begin
  if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='app_private.void_delivery_service_payment_v1(uuid,text)'::regprocedure)<>'9e34391b47a8e920b7fd5151b32ebc99' then raise exception 'Void implementation changed; review migration'; end if;
  def:=pg_get_functiondef('app_private.void_delivery_service_payment_v1(uuid,text)'::regprocedure);
  anchor:='  -- Match the payment command lock order: orders, payment record, movement.';
  def:=replace(def,anchor,$code$
  perform id from public.orders where id in (
    select order_id from public.delivery_service_payment_items where payment_id=p_payment_id
    union select order_id from public.delivery_debt_allocations where payment_id=p_payment_id
  ) order by id for update;
$code$||anchor);
  anchor:='  select * into v_pay from public.delivery_service_payments';
  def:=replace(def,anchor,$code$
  perform id from public.delivery_debts where id in(select debt_id from public.delivery_debt_allocations where payment_id=p_payment_id) order by id for update;
$code$||anchor);
  anchor:='  -- Complete evidence stays immutable in the parent record; release only active claims.';
  def:=replace(def,anchor,'  perform app_private.reverse_delivery_deductions_v1(p_payment_id);'||chr(10)||anchor);
  execute def;
end $patch$;

-- Do not let cancellation/price changes invalidate a settled purchase's offsets.
-- Normal payments remain allowed and reduce the live balance shown in Delivery.
create function app_private.guard_delivery_offset_order_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (new.client_id,new.total_usd,new.total_bs_snapshot,new.extra_fields->'pricing',new.status='cancelled')
    is distinct from (old.client_id,old.total_usd,old.total_bs_snapshot,old.extra_fields->'pricing',old.status='cancelled')
    and exists(select 1 from public.delivery_debt_allocations where order_id=old.id and reversed_at is null) then
    raise exception 'Esta compra tiene descuentos en una liquidación de delivery. Anula esa liquidación antes de cancelar o cambiar sus importes.' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function app_private.guard_delivery_offset_order_v1() from public,anon,authenticated,service_role;
create trigger guard_delivery_offset_order before update on public.orders for each row execute function app_private.guard_delivery_offset_order_v1();

-- Shared legacy fund writers cannot edit/remove a compensation or forge another
-- credit using a settlement identifier. Corrections append the two reverse rows.
create function app_private.guard_delivery_offset_fund_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare a public.delivery_debt_allocations;
begin
  if tg_op in ('UPDATE','DELETE') and exists(select 1 from public.delivery_debt_allocations
    where payment_id=old.movement_group_id and order_id=old.order_id) then
    raise exception 'La compensación de delivery es inmutable; anula su liquidación.' using errcode='22023'; end if;
  if tg_op='DELETE' then return old; end if;
  select * into a from public.delivery_debt_allocations where payment_id=new.movement_group_id and order_id=new.order_id;
  if found then
    if new.client_id<>a.client_id or new.currency_code<>'USD' or new.amount<>a.amount_usd or new.amount_usd<>a.amount_usd
      or new.money_account_id is not null or new.payment_report_id is not null
      or new.reason_code is null or new.reason_code not in ('delivery_earnings_offset','order_fund_applied','order_fund_restore','delivery_offset_reversal')
      or new.movement_type<>(case when new.reason_code in ('delivery_earnings_offset','order_fund_restore') then 'credit' else 'debit' end)
      or exists(select 1 from public.client_fund_movements where movement_group_id=new.movement_group_id and order_id=new.order_id and reason_code=new.reason_code)
      or (new.reason_code in ('order_fund_restore','delivery_offset_reversal') and not exists(select 1 from public.delivery_service_payments where request_id=a.payment_id and voided_at is not null)) then
      raise exception 'Movimiento incompatible con la compensación de delivery.' using errcode='22023'; end if;
  elsif new.reason_code in ('delivery_earnings_offset','delivery_offset_reversal') then
    raise exception 'La compensación requiere una liquidación válida.' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function app_private.guard_delivery_offset_fund_v1() from public,anon,authenticated,service_role;
create trigger guard_delivery_offset_fund before insert or update or delete on public.client_fund_movements
  for each row execute function app_private.guard_delivery_offset_fund_v1();

commit;
