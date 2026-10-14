-- Debt use is a non-cash settlement adjustment, never a treasury payment.
-- Applied version recorded by the project migration service.
create function public.reward_debt_options_v1(p_advisor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.advisor_commission_closures%rowtype; state jsonb;
begin
  perform app_private.reward_require_actor_v1();
  if auth.uid() is null or not (public.is_admin() or (public.has_role('advisor') and auth.uid()=p_advisor)) then
    raise exception 'No puedes consultar esta deuda.' using errcode='42501'; end if;
  select closure.* into c from public.advisor_commission_closures closure join public.advisor_commission_periods period on period.id=closure.period_id
    where closure.advisor_user_id=p_advisor and closure.status='preliminary' and period.status='open'
    order by period.date_to desc,closure.id desc limit 1;
  if c.id is null then return '[]'::jsonb; end if;
  state:=app_private.commission_collection_state_v1(c.id);
  if not coalesce((state->>'supported')::boolean,false) or state->>'transferredToClosureId' is not null then return '[]'::jsonb; end if;
  return jsonb_build_array(jsonb_build_object('closureId',c.id,'debtUsd',(state->>'advisorDebtUsd')::numeric));
end; $$;

create function app_private.reward_closure_adjustment_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare funded numeric; carry numeric; debt numeric; positive numeric; negative numeric; credit numeric; requested numeric; retained numeric; settlement jsonb; live jsonb;
begin
  select coalesce(sum(amount),0) into funded from public.advisor_reward_uses where commission_closure_id=new.id and purpose='advisor_debt' and status='used';
  if funded=0 then return new; end if;
  if new.advisor_user_id is distinct from old.advisor_user_id or new.period_id is distinct from old.period_id then raise exception 'El cierre financiado por premios no puede trasladarse a otro asesor o período.'; end if;
  if old.status<>'preliminary' then return new; end if;
  live:=app_private.commission_collection_state_v1(old.id);
  if not coalesce((live->>'supported')::boolean,false) or live->>'transferredToClosureId' is not null then raise exception 'No se puede actualizar un cierre cuyo arrastre ya fue transferido.'; end if;
  settlement:=coalesce(new.snapshot->'settlement','{}');
  if exists(select 1 from public.advisor_commission_carry_transfers where destination_closure_id=new.id)
    and (coalesce((new.snapshot#>>'{commissionBootstrap,commissionCarryUsd}')::numeric,0)<>0 or coalesce((new.snapshot#>>'{commissionBootstrap,advisorDebtCarryUsd}')::numeric,0)<>0) then
    raise exception 'El arrastre vinculado no puede duplicarse con un saldo inicial manual.'; end if;
  select coalesce(sum(credit_usd),0)+coalesce((new.snapshot#>>'{commissionBootstrap,commissionCarryUsd}')::numeric,0),
    coalesce(sum(advisor_debt_usd),0)+coalesce((new.snapshot#>>'{commissionBootstrap,advisorDebtCarryUsd}')::numeric,0) into carry,debt
    from public.advisor_commission_carry_transfers where destination_closure_id=new.id;
  -- Keep ordinary positive adjustments separate from the certified wallet journal.
  positive:=greatest(0,coalesce((settlement->>'positiveAdjustmentsUsd')::numeric,0)-coalesce((settlement->>'rewardDebtCreditUsd')::numeric,0))+funded;
  negative:=coalesce((settlement->>'negativeAdjustmentsUsd')::numeric,0);
  credit:=round(carry+new.gross_commission_usd+positive,2);
  requested:=round(debt+new.gift_deductions_usd+new.manual_deductions_usd+negative,2);
  retained:=least(greatest(0,credit-requested),(live->>'customerDebtUsd')::numeric);
  new.payable_usd:=greatest(0,credit-requested-retained);
  new.snapshot:=jsonb_set(coalesce(new.snapshot,'{}'),'{settlement}',settlement||jsonb_build_object(
    'formulaVersion','advisor-settlement-v1','carriedCommissionUsd',carry,'priorAdvisorDebtUsd',debt,
    'positiveAdjustmentsUsd',positive,'rewardDebtCreditUsd',funded,'negativeAdjustmentsUsd',negative,
    'retainedCommissionUsd',retained,'advisorDebtOutUsd',greatest(0,requested-credit),
    'uncoveredCustomerDebtUsd',greatest(0,(live->>'customerDebtUsd')::numeric-retained)),true);
  new.snapshot:=jsonb_set(new.snapshot,'{totals}',coalesce(new.snapshot->'totals','{}')||jsonb_build_object('payableUsd',new.payable_usd),true);
  return new;
end; $$;
create trigger reward_closure_adjustment before update on public.advisor_commission_closures for each row
  execute function app_private.reward_closure_adjustment_v1();

create function public.reward_apply_debt_v1(p_grant bigint,p_closure bigint,p_amount numeric,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.advisor_reward_grants%rowtype; c public.advisor_commission_closures%rowtype; use_row public.advisor_reward_uses%rowtype; options jsonb; debt numeric;
begin
  perform app_private.reward_require_actor_v1();
  if auth.uid() is null or not (public.is_admin() or public.has_role('advisor')) then raise exception 'No puedes usar este premio.' using errcode='42501'; end if;
  if p_token is null or p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) or p_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Indica un monto positivo en dólares.'; end if;
  select * into c from public.advisor_commission_closures where id=p_closure for update;
  select * into g from public.advisor_reward_grants where id=p_grant for update;
  if c.id is null or g.id is null or g.advisor_id is distinct from c.advisor_user_id
    or not(public.is_admin() or auth.uid()=g.advisor_id) then raise exception 'El premio y la deuda deben pertenecer al mismo asesor.' using errcode='42501'; end if;
  select * into use_row from public.advisor_reward_uses where request_token=p_token;
  if found then
    if use_row.grant_id<>g.id or use_row.commission_closure_id<>c.id or use_row.amount<>p_amount or use_row.created_by<>auth.uid() then raise exception 'Esta solicitud ya corresponde a otro movimiento.'; end if;
    return jsonb_build_object('useId',use_row.id,'replayed',true);
  end if;
  if g.status<>'active' or g.kind<>'credit' or not (g.terms_snapshot->'purposes') ? 'advisor_debt'
    or (g.expires_on is not null and g.expires_on<(statement_timestamp() at time zone 'America/Caracas')::date) then raise exception 'Este premio no permite amortizar deuda o está vencido.'; end if;
  options:=public.reward_debt_options_v1(g.advisor_id);
  if jsonb_array_length(options)<>1 or (options->0->>'closureId')::bigint<>c.id or c.status<>'preliminary' then raise exception 'Solo se amortiza la deuda actual de un cierre preliminar abierto, sin modificar acuerdos cerrados.'; end if;
  debt:=(options->0->>'debtUsd')::numeric;
  if p_amount>debt then raise exception 'El crédito supera la deuda actual del asesor. No puede convertirse en un pago en efectivo.'; end if;
  if p_amount>g.amount-g.reserved_amount-g.used_amount then raise exception 'El monedero no tiene saldo suficiente.' using errcode='40001'; end if;
  perform set_config('app.reward_use_command','lifecycle',true);
  insert into public.advisor_reward_uses(grant_id,advisor_id,purpose,commission_closure_id,request_token,amount,funded_usd,status,created_by)
    values(g.id,g.advisor_id,'advisor_debt',c.id,p_token,p_amount,p_amount,'used',auth.uid()) returning * into use_row;
  insert into public.advisor_reward_use_events(use_id,advisor_id,actor_id,event_type,amount,reason)
    values(use_row.id,g.advisor_id,auth.uid(),'used',p_amount,'Crédito no monetario aplicado a la deuda del asesor en el cierre #'||c.id||'. No es un pago de caja.');
  perform app_private.reward_refresh_balance_v1(g.id);
  update public.advisor_commission_closures set updated_at=statement_timestamp() where id=c.id;
  return jsonb_build_object('useId',use_row.id,'replayed',false);
end; $$;

create function public.reward_order_funding_v1(p_order bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ord public.orders%rowtype;
begin
  perform app_private.reward_require_actor_v1();
  select * into ord from public.orders where id=p_order;
  if auth.uid() is null or ord.id is null or not(public.is_master_or_admin() or ord.attributed_advisor_id=auth.uid()) then raise exception 'No puedes consultar los premios de este pedido.' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('orderItemId',u.order_item_id,'title',g.terms_snapshot->>'title',
    'status',u.status,'purpose',u.purpose,'fundedUsd',u.funded_usd) order by u.id)
    from public.advisor_reward_uses u join public.advisor_reward_grants g on g.id=u.grant_id
    where u.order_id=ord.id and u.status in ('reserved','used')),'[]'::jsonb);
end; $$;

-- A delivered wallet-financed customer gift participates in last-gift CRM metrics.
do $$ declare definition text; anchor text:='gift_product.type::text = ''gambit''::text'; begin
  definition:=pg_get_viewdef('public.commercial_order_facts'::regclass,true);
  if strpos(definition,anchor)=0 then raise exception 'El modelo comercial cambió. Revisa el reconocimiento de obsequios.'; end if;
  definition:=replace(definition,anchor,anchor||' OR (gift_item.reward_grant_id IS NOT NULL AND gift_item.reward_purpose = ''customer_gift'' AND EXISTS (SELECT 1 FROM public.advisor_reward_uses wallet_use WHERE wallet_use.order_item_id=gift_item.id AND wallet_use.status=''used''))');
  execute 'create or replace view public.commercial_order_facts as '||definition;
end; $$;

revoke all on function app_private.reward_closure_adjustment_v1() from public,anon,authenticated;
revoke all on function public.reward_debt_options_v1(uuid),public.reward_apply_debt_v1(bigint,bigint,numeric,uuid),public.reward_order_funding_v1(bigint) from public,anon;
grant execute on function public.reward_debt_options_v1(uuid),public.reward_apply_debt_v1(bigint,bigint,numeric,uuid),public.reward_order_funding_v1(bigint) to authenticated;
notify pgrst,'reload schema';
