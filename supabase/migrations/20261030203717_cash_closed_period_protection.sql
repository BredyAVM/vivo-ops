-- Applied as 20261030203717. No data repair: preserve physical counts, order debt and every existing ledger row.
-- Corrections to closed cash periods must use the existing audited closure reversal first.
create or replace function app_private.guard_cash_closed_movement_v1()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  v_row public.money_movements%rowtype;
  v_account record;
  v_closure record;
begin
  if TG_OP = 'UPDATE' and row(
    old.status,old.money_account_id,old.amount,old.amount_usd_equivalent,
    old.currency_code,old.direction,old.movement_date,old.confirmed_at,old.created_at
  ) is not distinct from row(
    new.status,new.money_account_id,new.amount,new.amount_usd_equivalent,
    new.currency_code,new.direction,new.movement_date,new.confirmed_at,new.created_at
  ) then return new; end if;

  -- Same account lock used by both closure commands. Sorted for account transfers.
  for v_account in
    select id,name from public.money_accounts
    where account_kind::text='cash' and id in (
      case when TG_OP <> 'INSERT' then old.money_account_id end,
      case when TG_OP <> 'DELETE' then new.money_account_id end
    ) order by id for update
  loop
    select id,coalesce(closure_at,created_at) as cut_at,closure_date
    into v_closure from public.money_account_closures
    where money_account_id=v_account.id and status in ('recorded','approved')
    order by coalesce(closure_at,created_at) desc,created_at desc,id desc limit 1;
    if not found then continue; end if;
    -- Check both sides: cannot move an old entry out, or a new entry into a closed period.
    for v_row in
      select old.* where TG_OP <> 'INSERT'
      union all select new.* where TG_OP <> 'DELETE'
    loop
      if v_row.money_account_id=v_account.id and v_row.status::text='confirmed'
        and (v_row.movement_date < v_closure.closure_date or (
          v_row.movement_date=v_closure.closure_date
          and coalesce(v_row.confirmed_at,v_row.created_at)<=v_closure.cut_at
        )) then
        raise exception 'El movimiento #% afecta el cierre #% de %. Administración debe revisar y anular primero los cierres afectados, desde el más reciente. No se modificó dinero ni deuda del cliente.',
          v_row.id,v_closure.id,v_account.name using errcode='23514';
      end if;
    end loop;
  end loop;
  if TG_OP='DELETE' then return old; end if;
  return new;
end;
$fn$;
revoke all on function app_private.guard_cash_closed_movement_v1() from public,anon,authenticated,service_role;
create trigger guard_cash_closed_movement_v1 before insert or update or delete
on public.money_movements for each row execute function app_private.guard_cash_closed_movement_v1();

create or replace function app_private.guard_cash_closure_v1()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_cash boolean; v_cut jsonb; v_at timestamptz;
begin
  -- Lock even a direct insert so it cannot race an ordinary cash correction.
  perform id from public.money_accounts where id in (
    case when TG_OP <> 'INSERT' then old.money_account_id end,
    case when TG_OP <> 'DELETE' then new.money_account_id end
  ) order by id for update;
  select exists(select 1 from public.money_accounts where account_kind::text='cash' and id in (
    case when TG_OP <> 'INSERT' then old.money_account_id end,
    case when TG_OP <> 'DELETE' then new.money_account_id end
  )) into v_cash;
  if not v_cash then
    if TG_OP='DELETE' then return old; end if;
    return new;
  end if;
  if TG_OP='DELETE' then
    raise exception 'No se borra un cierre de caja. Administración debe anularlo con motivo desde Cuentas.' using errcode='23514';
  end if;
  if TG_OP='UPDATE' then
    if row(old.money_account_id,old.closure_at,old.closure_date,old.created_at,
      old.counted_amount,old.expected_amount,old.difference_amount,old.currency_code,
      old.counted_amount_usd,old.expected_amount_usd,old.difference_amount_usd,old.exchange_rate_ves_per_usd)
      is distinct from row(new.money_account_id,new.closure_at,new.closure_date,new.created_at,
      new.counted_amount,new.expected_amount,new.difference_amount,new.currency_code,
      new.counted_amount_usd,new.expected_amount_usd,new.difference_amount_usd,new.exchange_rate_ves_per_usd) then
      raise exception 'El cierre de caja conserva su conteo original. Anúlalo con motivo y registra el cierre corregido; no edites sus importes.' using errcode='23514';
    end if;
    if old.status not in ('recorded','approved') and new.status in ('recorded','approved') then
      raise exception 'Un cierre anulado no se reactiva. Registra un nuevo cierre revisado.' using errcode='23514';
    end if;
    if old.status in ('recorded','approved') and new.status not in ('recorded','approved')
      and exists(select 1 from public.money_account_closures where money_account_id=old.money_account_id
        and id<>old.id and status in ('recorded','approved')
        and coalesce(closure_at,created_at)>coalesce(old.closure_at,old.created_at)) then
      raise exception 'Revisa primero el cierre de caja más reciente; hay cierres posteriores que dependen de este.' using errcode='23514';
    end if;
    return new;
  end if;
  if new.status in ('recorded','approved') then
    v_at:=coalesce(new.closure_at,new.created_at);
    if not isfinite(v_at) or v_at>clock_timestamp() or new.closure_date is distinct from (v_at at time zone 'America/Caracas')::date then
      raise exception 'Revisa la fecha y hora del cierre de caja.' using errcode='23514';
    end if;
    if exists(select 1 from public.money_account_closures where money_account_id=new.money_account_id
      and status in ('recorded','approved') and coalesce(closure_at,created_at)>=v_at) then
      raise exception 'Hay un cierre igual o posterior. Revisa primero el último cierre de caja.' using errcode='23514';
    end if;
    v_cut:=app_private.account_closure_cut_v2(new.money_account_id,v_at);
    if new.expected_amount is distinct from (v_cut->>'expectedAmount')::numeric
      or new.expected_amount_usd is distinct from (v_cut->>'expectedAmountUsd')::numeric then
      raise exception 'El saldo cambió antes de guardar el cierre. Actualiza la caja y verifica de nuevo el conteo.' using errcode='23514';
    end if;
  end if;
  return new;
end;
$fn$;
revoke all on function app_private.guard_cash_closure_v1() from public,anon,authenticated,service_role;
create trigger guard_cash_closure_v1 before insert or update or delete
on public.money_account_closures for each row execute function app_private.guard_cash_closure_v1();

-- The existing void command writes its reversal evidence later in the same transaction.
create or replace function app_private.check_cash_closure_reversal_v1()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  if old.status in ('recorded','approved') and new.status not in ('recorded','approved')
    and exists(select 1 from public.money_accounts where id=old.money_account_id and account_kind::text='cash')
    and not exists(select 1 from public.account_closure_reversals where closure_id=old.id) then
    raise exception 'La anulación del cierre requiere la auditoría de Administración. Usa Anular cierre desde Cuentas.' using errcode='23514';
  end if;
  return null;
end;
$fn$;
revoke all on function app_private.check_cash_closure_reversal_v1() from public,anon,authenticated,service_role;
create constraint trigger check_cash_closure_reversal_v1 after update on public.money_account_closures
deferrable initially deferred for each row execute function app_private.check_cash_closure_reversal_v1();

-- Use the existing canonical cut, not a second Counter formula. Keep permissions,
-- command receipts and POS semantics. Fail the migration if source drifted.
do $patch$
declare v_src text; v_next text; v_start int; v_end int;
begin
  v_src:=pg_get_functiondef('public.counter_close_money_account(uuid,bigint,timestamptz,numeric,numeric,text,text)'::regprocedure);
  v_start:=strpos(v_src,E'  select\n    round(\n      v_expected_amount');
  v_end:=strpos(v_src,'  v_difference_amount :=');
  if v_start=0 or v_end<=v_start then raise exception 'Unexpected Counter closure source'; end if;
  v_next:=left(v_src,v_start-1)||$replacement$
  select (cut->>'expectedAmount')::numeric,(cut->>'expectedAmountUsd')::numeric
  into v_expected_amount,v_expected_usd
  from (select app_private.account_closure_cut_v2(p_money_account_id,p_closure_at) as cut) canonical_cut;

$replacement$||substr(v_src,v_end);
  execute v_next;

  v_src:=pg_get_functiondef('public.counter_read_cash_snapshot(integer)'::regprocedure);
  v_start:=strpos(v_src,E'     and (\n       case\n         when anchor.closure_id');
  v_end:=strpos(v_src,'    left join public.money_account_closures settled_closure');
  if v_start=0 or v_end<=v_start then raise exception 'Unexpected Counter cash read source'; end if;
  v_next:=left(v_src,v_start-1)||$replacement$
     and app_private.account_movement_in_observed_cut_v2(
       movement.movement_date,coalesce(movement.confirmed_at,movement.created_at),
       coalesce(anchor.closure_at,anchor.baseline_at),statement_timestamp())
$replacement$||substr(v_src,v_end);
  v_next:=replace(v_next,'then movement.amount','then app_private.reconciled_observed_amount_v1(movement.id,movement.amount,coalesce(anchor.closure_at,anchor.baseline_at),statement_timestamp())');
  v_next:=replace(v_next,'else -movement.amount','else -app_private.reconciled_observed_amount_v1(movement.id,movement.amount,coalesce(anchor.closure_at,anchor.baseline_at),statement_timestamp())');
  execute v_next;

  -- A closure reversal is atomic. Remove its anchor before reversing any linked
  -- legacy transfer; deferred evidence verification still runs at commit.
  v_src:=pg_get_functiondef('app_private.void_account_closure_v1(bigint,text)'::regprocedure);
  v_start:=strpos(v_src,'  update public.money_account_closures set status=');
  v_end:=strpos(v_src,'  insert into public.account_closure_reversals');
  if v_start=0 or v_end<=v_start or strpos(v_src,'  -- Legacy close transfers')=0 then
    raise exception 'Unexpected closure reversal source';
  end if;
  v_next:=substr(v_src,v_start,v_end-v_start);
  v_src:=left(v_src,v_start-1)||substr(v_src,v_end);
  v_src:=replace(v_src,'  -- Legacy close transfers',v_next||E'\n  -- Legacy close transfers');
  execute v_src;
end;
$patch$;
