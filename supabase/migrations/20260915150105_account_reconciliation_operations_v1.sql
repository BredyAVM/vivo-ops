begin;
set local lock_timeout='5s';

create table public.account_reconciliation_resolutions (
  request_id uuid primary key,
  item_id bigint not null references public.money_account_reconciliation_items(id),
  money_account_id bigint not null references public.money_accounts(id),
  created_by_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  input jsonb not null,
  result jsonb not null,
  mode text not null check(mode in ('note_only','existing','income','expense','fee','adjustment')),
  amount numeric(18,2) not null check(amount>0),
  money_movement_id bigint references public.money_movements(id),
  movement_created boolean not null default false,
  covered_at timestamptz,
  residual_item_id bigint references public.money_account_reconciliation_items(id),
  item_snapshot jsonb not null,
  movement_snapshot jsonb,
  voided_at timestamptz,
  voided_by_user_id uuid references auth.users(id),
  void_reason text
);
create unique index account_reconciliation_active_item on public.account_reconciliation_resolutions(item_id) where voided_at is null;
create index account_reconciliation_movement on public.account_reconciliation_resolutions(money_movement_id) where voided_at is null;
alter table public.account_reconciliation_resolutions enable row level security;
revoke all on public.account_reconciliation_resolutions from public,anon,authenticated;
grant select on public.account_reconciliation_resolutions to authenticated;
create policy reconciliation_admin_read on public.account_reconciliation_resolutions for select to authenticated using (public.is_master_or_admin());

create function app_private.resolve_account_reconciliation_v1(p_request_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  uid uuid:=auth.uid(); i public.money_account_reconciliation_items%rowtype;
  m public.money_movements%rowtype; prior public.account_reconciliation_resolutions%rowtype;
  item_id bigint:=(p_input->>'itemId')::bigint; mode text:=p_input->>'mode';
  amount numeric:=(p_input->>'amount')::numeric; rate numeric:=(p_input->>'rate')::numeric;
  note text:=btrim(p_input->>'note'); movement_id bigint:=(p_input->>'movementId')::bigint;
  operation_date date:=(p_input->>'movementDate')::date; cut_at timestamptz;
  residual_id bigint; remaining numeric; usd numeric; used numeric; result jsonb;
  admin boolean; snapshot jsonb; movement_created boolean:=false;
begin
  if uid is null or not public.is_master_or_admin() then raise exception 'No autorizado.' using errcode='42501'; end if;
  admin:=exists(select 1 from public.user_roles where user_id=uid and role='admin');
  if p_request_id is null or jsonb_typeof(p_input)<>'object' or item_id is null then raise exception 'Solicitud inválida.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,185));
  select * into prior from public.account_reconciliation_resolutions where request_id=p_request_id;
  if found then
    if prior.created_by_user_id<>uid or prior.input<>p_input then raise exception 'Este envío corresponde a otros datos.' using errcode='22023'; end if;
    return prior.result||jsonb_build_object('replayed',true,'voided',prior.voided_at is not null);
  end if;
  if mode is null or mode not in ('note_only','existing','income','expense','fee','adjustment')
    or note is null or length(note) not between 6 and 2000 then raise exception 'Indica el tipo y una explicación clara.' using errcode='22023'; end if;
  if mode<>'note_only' and not admin then raise exception 'Solo Administración puede registrar o vincular dinero.' using errcode='42501'; end if;
  select * into i from public.money_account_reconciliation_items where id=item_id;
  if not found then raise exception 'Diferencia no encontrada.' using errcode='22023'; end if;
  perform id from public.money_accounts where id=i.money_account_id for update;
  if movement_id is not null then select * into m from public.money_movements where id=movement_id for update; end if;
  select * into i from public.money_account_reconciliation_items where id=item_id for update;
  if i.status<>'open' then raise exception 'La diferencia ya no está abierta. Actualiza la consulta.' using errcode='22023'; end if;
  if p_input->>'fingerprint' is distinct from md5(to_jsonb(i)::text) then raise exception 'La diferencia cambió. Actualiza antes de resolver.' using errcode='22023'; end if;
  snapshot:=to_jsonb(i);
  if amount is null or amount::text in ('NaN','Infinity','-Infinity') or amount<=0 or amount>i.amount or amount<>round(amount,2) then
    raise exception 'El importe debe ser positivo, con dos decimales y no superar el pendiente.' using errcode='22023'; end if;
  if mode='note_only' and amount<>i.amount then raise exception 'Una explicación sin movimiento resuelve la partida completa.' using errcode='22023'; end if;
  if i.source_kind='closure' then
    select coalesce(c.closure_at,c.created_at) into cut_at from public.money_account_closures c
      where c.id=i.source_id and c.money_account_id=i.money_account_id and c.status in ('recorded','approved') for share;
  elsif i.source_kind='baseline' then
    select b.baseline_at into cut_at from public.money_account_closure_baselines b
      where b.id=i.source_id and b.money_account_id=i.money_account_id and b.status='active' for share;
  end if;
  if i.source_kind<>'manual' and cut_at is null then raise exception 'El origen de la diferencia no está vigente. Revisa el cierre o línea base.' using errcode='22023'; end if;
  if mode<>'note_only' then
    if cut_at is null then raise exception 'Esta partida no tiene un saldo observado verificable; documenta su resolución sin crear dinero desde aquí.' using errcode='22023'; end if;
    if p_input->>'evidenceConfirmed' is distinct from 'true' then raise exception 'Confirma que este importe ya estaba incluido en el saldo observado.' using errcode='22023'; end if;
    if mode='existing' then
      if m.id is null or m.status<>'confirmed' or m.money_account_id<>i.money_account_id or m.currency_code::text<>i.currency_code
        or m.direction::text<>(case when i.direction='surplus' then 'inflow' else 'outflow' end)
        or m.movement_date>(cut_at at time zone 'America/Caracas')::date or coalesce(m.confirmed_at,m.created_at)<=cut_at then
        raise exception 'El movimiento no corresponde a esta cuenta, signo, fecha o registro tardío confirmado.' using errcode='22023'; end if;
      select coalesce(sum(r.amount),0) into used from public.account_reconciliation_resolutions r where r.money_movement_id=m.id and r.voided_at is null;
      if amount>m.amount-used then raise exception 'Ese importe del movimiento ya fue conciliado o supera su monto.' using errcode='22023'; end if;
      if p_input->>'movementFingerprint' is distinct from md5(to_jsonb(m)::text) then raise exception 'El movimiento cambió. Vuelve a consultarlo.' using errcode='22023'; end if;
    else
      if not exists(select 1 from public.money_accounts where id=i.money_account_id and is_active) then raise exception 'La cuenta está inactiva.' using errcode='22023'; end if;
      if movement_id is not null then raise exception 'No combines un movimiento existente con uno nuevo.' using errcode='22023'; end if;
      if exists(select 1 from public.money_movements where movement_group_id=p_request_id) then raise exception 'El identificador ya pertenece a otro movimiento.' using errcode='22023'; end if;
      if (mode='income' and i.direction<>'surplus') or (mode in ('expense','fee') and i.direction<>'shortage') then raise exception 'El tipo de movimiento no corresponde al signo de la diferencia.' using errcode='22023'; end if;
      if operation_date is null or operation_date>(cut_at at time zone 'America/Caracas')::date then raise exception 'Usa la fecha bancaria real, anterior o igual al saldo observado.' using errcode='22023'; end if;
      if i.currency_code='VES' and (rate is null or rate<=0 or rate>1e9 or rate::text='NaN') then raise exception 'Indica una tasa válida.' using errcode='22023'; end if;
      usd:=case when i.currency_code='USD' then amount else round(amount/rate,2) end;
      insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
        direction,movement_type,amount,amount_usd_equivalent,exchange_rate_ves_per_usd,reference_code,description,notes,movement_group_id,status)
      values(i.money_account_id,i.currency_code::public.currency_code,operation_date,uid,clock_timestamp(),uid,
        (case when i.direction='surplus' then 'inflow' else 'outflow' end)::public.movement_direction,
        (case mode when 'income' then 'other_income' when 'expense' then 'expense_payment' when 'fee' then 'fee_charge' else 'adjustment' end)::public.movement_type,
        amount,usd,case when i.currency_code='VES' then rate end,nullif(btrim(p_input->>'reference'),''),
        'Conciliación #'||i.id,note,p_request_id,'confirmed') returning * into m;
      movement_created:=true;
    end if;
  else
    if movement_id is not null then raise exception 'No vincules dinero en el modo solo explicación.' using errcode='22023'; end if;
  end if;
  remaining:=i.amount-amount;
  if remaining>0 then
    insert into public.money_account_reconciliation_items(money_account_id,source_kind,source_id,item_type,direction,currency_code,
      amount,amount_usd_equivalent,operation_date,reference_code,counterparty_name,description,status,created_by_user_id)
    values(i.money_account_id,i.source_kind,i.source_id,i.item_type,i.direction,i.currency_code,remaining,
      round(i.amount_usd_equivalent*remaining/i.amount,2),i.operation_date,i.reference_code,i.counterparty_name,
      'Saldo restante de conciliación #'||i.id||': '||i.description,'open',uid) returning id into residual_id;
  end if;
  update public.money_account_reconciliation_items set status='resolved',resolved_by_user_id=uid,resolved_at=clock_timestamp(),resolution_notes=note where id=i.id;
  result:=jsonb_build_object('requestId',p_request_id,'itemId',i.id,'accountId',i.money_account_id,'amount',amount,'currency',i.currency_code,
    'remaining',remaining,'residualItemId',residual_id,'movementId',m.id,'movementCreated',movement_created,'replayed',false);
  insert into public.account_reconciliation_resolutions(request_id,item_id,money_account_id,created_by_user_id,input,result,mode,amount,
    money_movement_id,movement_created,covered_at,residual_item_id,item_snapshot,movement_snapshot)
  values(p_request_id,i.id,i.money_account_id,uid,p_input,result,mode,amount,m.id,movement_created,cut_at,residual_id,snapshot,case when m.id is not null then to_jsonb(m) end);
  return result;
end $fn$;
create function public.resolve_account_reconciliation_v1(p_request_id uuid,p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $fn$ select app_private.resolve_account_reconciliation_v1(p_request_id,p_input); $fn$;

create function app_private.undo_account_reconciliation_v1(p_request_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare uid uuid:=auth.uid(); r public.account_reconciliation_resolutions%rowtype; child public.money_account_reconciliation_items%rowtype;
begin
  if uid is null or not exists(select 1 from public.user_roles where user_id=uid and role='admin') then raise exception 'Solo Administración puede deshacer una resolución.' using errcode='42501'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 6 and 1000 then raise exception 'Indica el motivo de la reversión.' using errcode='22023'; end if;
  select * into r from public.account_reconciliation_resolutions where request_id=p_request_id;
  if not found then raise exception 'Resolución no encontrada.' using errcode='22023'; end if;
  perform id from public.money_accounts where id=r.money_account_id for update;
  perform id from public.money_movements where id=r.money_movement_id for update;
  perform id from public.money_account_reconciliation_items where id in (r.item_id,r.residual_item_id) order by id for update;
  select * into r from public.account_reconciliation_resolutions where request_id=p_request_id for update;
  if r.voided_at is not null then return jsonb_build_object('replayed',true); end if;
  if r.residual_item_id is not null then
    select * into child from public.money_account_reconciliation_items where id=r.residual_item_id;
    if child.status<>'open' or child.amount<>(r.result->>'remaining')::numeric then raise exception 'El saldo restante ya fue tratado. Deshaz primero su resolución.' using errcode='22023'; end if;
  end if;
  -- A newly created movement must not have been reused by another resolution.
  if r.movement_created and exists(select 1 from public.account_reconciliation_resolutions x where x.money_movement_id=r.money_movement_id and x.request_id<>r.request_id and x.voided_at is null) then
    raise exception 'El movimiento tiene otras conciliaciones. Reviértelas primero.' using errcode='22023'; end if;
  update public.account_reconciliation_resolutions set voided_at=clock_timestamp(),voided_by_user_id=uid,void_reason=p_reason where request_id=r.request_id;
  if r.movement_created then
    update public.money_movements set status='voided',voided_at=clock_timestamp(),voided_by_user_id=uid,void_reason=p_reason where id=r.money_movement_id;
  end if;
  update public.money_account_reconciliation_items set status='voided',voided_at=clock_timestamp(),voided_by_user_id=uid,void_reason=p_reason where id=r.residual_item_id;
  update public.money_account_reconciliation_items set status='open',resolved_at=null,resolved_by_user_id=null,resolution_notes=null where id=r.item_id;
  return jsonb_build_object('replayed',false,'itemId',r.item_id,'movementVoided',r.movement_created);
end $fn$;
create function public.undo_account_reconciliation_v1(p_request_id uuid,p_reason text) returns jsonb
language sql security invoker set search_path='' as $fn$ select app_private.undo_account_reconciliation_v1(p_request_id,p_reason); $fn$;

create function app_private.guard_reconciliation_money_v1() returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if exists(select 1 from public.account_reconciliation_resolutions where money_movement_id=old.id and voided_at is null)
    and (tg_op='DELETE' or to_jsonb(new) is distinct from to_jsonb(old)) then
    raise exception 'Deshaz primero la conciliación vinculada a este movimiento.' using errcode='22023'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end $fn$;
create trigger guard_reconciliation_money before update or delete on public.money_movements for each row execute function app_private.guard_reconciliation_money_v1();

-- Only the amount explicitly proved to be in an observed balance is excluded.
-- The ledger and old closure snapshots remain unchanged. No invented cash.
create function app_private.reconciled_observed_amount_v1(p_id bigint,p_amount numeric,p_anchor timestamptz,p_cut timestamptz,p_usd boolean default false)
returns numeric language sql stable security invoker set search_path='' as $fn$
 select p_amount-coalesce((select sum(case when p_usd then r.amount * (r.movement_snapshot->>'amount_usd_equivalent')::numeric / (r.movement_snapshot->>'amount')::numeric else r.amount end)
   from public.account_reconciliation_resolutions r where r.money_movement_id=p_id and r.covered_at<=p_anchor and r.created_at<=p_cut
     and (r.voided_at is null or r.voided_at>p_cut)),0);
$fn$;
do $patch$
declare src text; next_src text; fn regprocedure;
begin
  fn:='app_private.account_closure_cut_v2(bigint,timestamptz)'::regprocedure;
  src:=pg_get_functiondef(fn);
  if md5(src)<>'9dd23d3dac902f169566be3d0ba0b50c' then raise exception 'La función de corte cambió desde la revisión.'; end if;
  next_src:=replace(src,'then m.amount else -m.amount end','then app_private.reconciled_observed_amount_v1(m.id,m.amount,anchor_at,p_at) else -app_private.reconciled_observed_amount_v1(m.id,m.amount,anchor_at,p_at) end');
  next_src:=replace(next_src,'then m.amount_usd_equivalent else -m.amount_usd_equivalent end','then app_private.reconciled_observed_amount_v1(m.id,m.amount_usd_equivalent,anchor_at,p_at,true) else -app_private.reconciled_observed_amount_v1(m.id,m.amount_usd_equivalent,anchor_at,p_at,true) end');
  if next_src=src then raise exception 'La proyección de cierre cambió; revisar antes de aplicar.'; end if; execute next_src;
  fn:='app_private.admin_finance_account_snapshots_v2(timestamptz)'::regprocedure;
  src:=pg_get_functiondef(fn);
  if md5(src)<>'bd5516184f584700b571f1f8dd362bf3' then raise exception 'La proyección de cuentas cambió desde la revisión.'; end if;
  next_src:=replace(src,'then movement.amount_usd_equivalent','then app_private.reconciled_observed_amount_v1(movement.id,movement.amount_usd_equivalent,account.anchor_at,cutoff.as_of,true)');
  next_src:=replace(next_src,'then -movement.amount_usd_equivalent','then -app_private.reconciled_observed_amount_v1(movement.id,movement.amount_usd_equivalent,account.anchor_at,cutoff.as_of,true)');
  next_src:=replace(next_src,'then movement.amount','then app_private.reconciled_observed_amount_v1(movement.id,movement.amount,account.anchor_at,cutoff.as_of)');
  next_src:=replace(next_src,'then -movement.amount','then -app_private.reconciled_observed_amount_v1(movement.id,movement.amount,account.anchor_at,cutoff.as_of)');
  if next_src=src then raise exception 'La posición de cuentas cambió; revisar antes de aplicar.'; end if; execute next_src;
end $patch$;

create function public.admin_account_reconciliation_detail_v1(p_item_id bigint,p_query text default '') returns jsonb
language plpgsql stable security invoker set search_path='' as $fn$
declare i public.money_account_reconciliation_items%rowtype; candidates jsonb; history jsonb; cut_at timestamptz;
begin
  if auth.uid() is null or not public.is_master_or_admin() then raise exception 'No autorizado.' using errcode='42501'; end if;
  select * into i from public.money_account_reconciliation_items where id=p_item_id;
  if not found then return null; end if;
  if i.source_kind='closure' then select coalesce(closure_at,created_at) into cut_at from public.money_account_closures where id=i.source_id and money_account_id=i.money_account_id and status in ('recorded','approved');
  elsif i.source_kind='baseline' then select baseline_at into cut_at from public.money_account_closure_baselines where id=i.source_id and money_account_id=i.money_account_id and status='active'; end if;
  select coalesce(jsonb_agg(x),'[]') into candidates from (
    select m.id,m.movement_date,m.amount,m.reference_code,m.description,m.counterparty_name,m.order_id,
      m.amount-coalesce((select sum(r.amount) from public.account_reconciliation_resolutions r where r.money_movement_id=m.id and r.voided_at is null),0) available,
      md5(to_jsonb(m)::text) fingerprint
    from public.money_movements m where m.money_account_id=i.money_account_id and m.currency_code::text=i.currency_code and m.status='confirmed'
      and m.direction::text=(case when i.direction='surplus' then 'inflow' else 'outflow' end)
      and m.movement_date<=(cut_at at time zone 'America/Caracas')::date and coalesce(m.confirmed_at,m.created_at)>cut_at
      and (coalesce(p_query,'')='' or m.reference_code ilike '%'||left(p_query,120)||'%' or m.description ilike '%'||left(p_query,120)||'%'
        or m.counterparty_name ilike '%'||left(p_query,120)||'%' or m.id::text=p_query or m.order_id::text=replace(p_query,'-',''))
    order by m.movement_date desc,m.id desc limit 51
  ) x;
  select coalesce(jsonb_agg((to_jsonb(r)-'input'-'item_snapshot'-'movement_snapshot')||jsonb_build_object('actor_name',(select full_name from public.profiles where id=r.created_by_user_id),'void_actor_name',(select full_name from public.profiles where id=r.voided_by_user_id)) order by r.created_at desc),'[]') into history
    from public.account_reconciliation_resolutions r where r.item_id=i.id;
  return jsonb_build_object('item',to_jsonb(i),'fingerprint',md5(to_jsonb(i)::text),'coveredAt',cut_at,'candidates',candidates,'history',history);
end $fn$;

create function app_private.guard_reconciliation_item_v1() returns trigger language plpgsql security invoker set search_path='' as $fn$
begin
  if current_user in ('authenticated','anon') and
    ((tg_op='UPDATE' and new.status='resolved') or exists(select 1 from public.account_reconciliation_resolutions r where r.item_id=old.id or r.residual_item_id=old.id)) then
    raise exception 'Usa el recorrido protegido de conciliación para modificar esta partida.' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end $fn$;
create trigger guard_reconciliation_item before update or delete on public.money_account_reconciliation_items for each row execute function app_private.guard_reconciliation_item_v1();

revoke all on function public.admin_account_reconciliation_detail_v1(bigint,text),app_private.guard_reconciliation_item_v1() from public,anon,authenticated;
grant execute on function public.admin_account_reconciliation_detail_v1(bigint,text) to authenticated;
revoke all on function app_private.resolve_account_reconciliation_v1(uuid,jsonb),public.resolve_account_reconciliation_v1(uuid,jsonb),
  app_private.undo_account_reconciliation_v1(uuid,text),public.undo_account_reconciliation_v1(uuid,text),
  app_private.guard_reconciliation_money_v1(),app_private.reconciled_observed_amount_v1(bigint,numeric,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function app_private.resolve_account_reconciliation_v1(uuid,jsonb),public.resolve_account_reconciliation_v1(uuid,jsonb),
  app_private.undo_account_reconciliation_v1(uuid,text),public.undo_account_reconciliation_v1(uuid,text) to authenticated;
create table public.account_cash_operations (
  request_id uuid primary key, created_by_user_id uuid not null references auth.users(id), created_at timestamptz not null default clock_timestamp(),
  input jsonb not null, result jsonb not null, money_movement_id bigint not null unique references public.money_movements(id)
);
alter table public.account_cash_operations enable row level security;
revoke all on public.account_cash_operations from public,anon,authenticated;
grant select on public.account_cash_operations to authenticated;
create policy account_cash_admin_read on public.account_cash_operations for select to authenticated using(exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role='admin'));
create function app_private.create_admin_cash_operation_v1(p_request_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare uid uuid:=auth.uid(); a public.money_accounts%rowtype; prior public.account_cash_operations%rowtype;
  amount numeric:=(p_input->>'amount')::numeric; fee numeric:=coalesce((p_input->>'feeAmount')::numeric,0); rate numeric:=(p_input->>'exchangeRateVesPerUsd')::numeric;
  movement_date date:=(p_input->>'movementDate')::date; direction text:=p_input->>'direction'; description text:=btrim(p_input->>'description');
  usd numeric; fee_usd numeric; movement_id bigint; fee_id bigint; result jsonb; recorded timestamptz:=clock_timestamp();
begin
  if uid is null or not exists(select 1 from public.user_roles where user_id=uid and role='admin') then raise exception 'Solo Administración puede registrar este movimiento.' using errcode='42501'; end if;
  if p_request_id is null or jsonb_typeof(p_input)<>'object' then raise exception 'Envío inválido.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,186));
  select * into prior from public.account_cash_operations where request_id=p_request_id;
  if found then
    if prior.created_by_user_id<>uid or prior.input<>p_input then raise exception 'El envío corresponde a otros datos.' using errcode='22023'; end if;
    return prior.result||jsonb_build_object('replayed',true,'currentStatus',(select status from public.money_movements where id=prior.money_movement_id));
  end if;
  if direction is null or direction not in ('inflow','outflow') or movement_date is null or not isfinite(movement_date)
    or amount is null or amount::text='NaN' or amount<=0 or amount>1e9 or amount<>round(amount,2)
    or fee::text='NaN' or fee<0 or fee>1e9 or fee<>round(fee,2) or (direction='inflow' and fee<>0)
    or description is null or length(description) not between 1 and 240
    or length(coalesce(p_input->>'notes',''))>800 or length(coalesce(p_input->>'referenceCode',''))>120 or length(coalesce(p_input->>'counterpartyName',''))>160 then
    raise exception 'Revisa fecha, motivo e importes (máximo dos decimales).' using errcode='22023'; end if;
  select * into a from public.money_accounts where id=(p_input->>'moneyAccountId')::bigint for update;
  if not found or not a.is_active or a.currency_code::text not in ('USD','VES') then raise exception 'Cuenta no disponible.' using errcode='22023'; end if;
  if exists(select 1 from public.money_movements where movement_group_id=p_request_id) then raise exception 'El identificador ya pertenece a otro movimiento.' using errcode='22023'; end if;
  if a.currency_code='VES' and (rate is null or rate::text='NaN' or rate<=0 or rate>1e9) then raise exception 'Indica una tasa válida.' using errcode='22023'; end if;
  usd:=case when a.currency_code='USD' then amount else round(amount/rate,2) end;
  fee_usd:=case when a.currency_code='USD' then fee else round(fee/rate,2) end;
  insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,direction,movement_type,
    amount,amount_usd_equivalent,exchange_rate_ves_per_usd,reference_code,counterparty_name,description,notes,movement_group_id,status)
  values(a.id,a.currency_code,movement_date,uid,recorded,uid,direction::public.movement_direction,
    (case when direction='inflow' then 'other_income' else 'expense_payment' end)::public.movement_type,amount,usd,
    case when a.currency_code='VES' then rate end,nullif(btrim(p_input->>'referenceCode'),''),nullif(btrim(p_input->>'counterpartyName'),''),description,nullif(btrim(p_input->>'notes'),''),p_request_id,'confirmed') returning id into movement_id;
  if fee>0 then
    insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,direction,movement_type,
      amount,amount_usd_equivalent,exchange_rate_ves_per_usd,reference_code,counterparty_name,description,notes,movement_group_id,status)
    values(a.id,a.currency_code,movement_date,uid,recorded,uid,'outflow','fee_charge',fee,fee_usd,case when a.currency_code='VES' then rate end,
      nullif(btrim(p_input->>'referenceCode'),''),nullif(btrim(p_input->>'counterpartyName'),''),'Comisión · '||description,nullif(btrim(p_input->>'notes'),''),p_request_id,'confirmed') returning id into fee_id;
  end if;
  result:=jsonb_build_object('requestId',p_request_id,'movementId',movement_id,'feeMovementId',fee_id,'accountId',a.id,'amount',amount,'feeAmount',fee,
    'currency',a.currency_code,'totalUsd',usd+fee_usd,'replayed',false,'currentStatus','confirmed');
  insert into public.account_cash_operations(request_id,created_by_user_id,input,result,money_movement_id) values(p_request_id,uid,p_input,result,movement_id);
  return result;
end $fn$;
create function public.create_admin_cash_operation_v1(p_request_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $fn$
  select app_private.create_admin_cash_operation_v1(p_request_id,p_input);
$fn$;
revoke all on function app_private.create_admin_cash_operation_v1(uuid,jsonb),public.create_admin_cash_operation_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function app_private.create_admin_cash_operation_v1(uuid,jsonb),public.create_admin_cash_operation_v1(uuid,jsonb) to authenticated;
do $patch$ declare src text; updated text; begin
  src:=pg_get_functiondef('public.admin_finance_account_detail_v2(bigint,text,date,date,text,integer,integer)'::regprocedure);
  if md5(src)<>'373a5b33c59a6754ecd17c7244b58341' then raise exception 'El detalle de cuentas cambió desde la revisión.'; end if;
  updated:=replace(src,E'  select *\n  into v_account', $inject$
  if v_section='movements' then
    v_result:=jsonb_set(v_result,'{rows}',(select coalesce(jsonb_agg(x.value||jsonb_build_object('operationRequestId',op.request_id) order by x.ordinality),'[]')
      from jsonb_array_elements(v_result->'rows') with ordinality x(value,ordinality)
      left join public.money_movements m on m.id=(x.value->>'id')::bigint
      left join public.account_cash_operations op on op.request_id=m.movement_group_id));
  end if;
  select *
  into v_account$inject$);
  if updated=src then raise exception 'No se encontró el contrato de movimiento esperado.'; end if; execute updated;
end $patch$;
commit;
