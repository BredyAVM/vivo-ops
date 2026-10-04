-- Operational edits preserve unit terms; payment protection is not an item lock.
-- Version matches the migration applied to the linked project.
-- No historical order, payment or inventory data is repaired by this migration.
begin;
set local lock_timeout = '5s';

create or replace function app_private.order_item_operational_quantity_v1(p_old jsonb, p_new jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (p_new - array['qty','line_total_usd','line_total_bs_snapshot','notes'])
      = (p_old - array['qty','line_total_usd','line_total_bs_snapshot','notes'])
    and p_old->>'crm_play_member_id' is null
    and p_old->>'crm_play_benefit_id' is null
    and p_old->>'crm_play_benefit_upgrade_id' is null
    and (p_old->>'qty')::numeric > 0
    and (p_new->>'qty')::numeric > 0
    and (p_new->>'qty')::numeric <= 9999
    and (p_new->>'line_total_usd')::numeric in (
      (p_old->>'line_total_usd')::numeric,
      round(case when p_old->>'admin_price_override_usd' is null then (p_old->>'unit_price_usd_snapshot')::numeric
        else (p_old->>'line_total_usd')::numeric / (p_old->>'qty')::numeric end * (p_new->>'qty')::numeric,2))
    and (p_new->>'line_total_bs_snapshot')::numeric in (
      (p_old->>'line_total_bs_snapshot')::numeric,
      round((p_old->>'unit_price_bs_snapshot')::numeric * (p_new->>'qty')::numeric,2))
    and (p_old->>'admin_price_override_usd' is null or p_new->>'notes' is not distinct from p_old->>'notes');
$$;
revoke all on function app_private.order_item_operational_quantity_v1(jsonb,jsonb) from public,anon,authenticated;
grant execute on function app_private.order_item_operational_quantity_v1(jsonb,jsonb) to authenticated;

-- Narrow trigger permission: same product and immutable price/approval evidence,
-- authorized operator, and a parent that has not left the premises.
do $migration$
declare definition text; anchor text; name text;
  prefix text := $prefix$
  if tg_op = 'UPDATE' and auth.uid() is not null
    and (public.is_master_or_admin() or public.has_role('counter'))
    and app_private.order_item_operational_quantity_v1(to_jsonb(old),to_jsonb(new))
    and exists (select 1 from public.orders o where o.id=old.order_id
      and o.status::text in ('created','queued','confirmed','in_kitchen','ready')
      and (public.is_master_or_admin() or o.fulfillment::text='pickup')) then
    if new.qty is distinct from old.qty then
      new.line_total_usd := round(case when old.admin_price_override_usd is null then old.unit_price_usd_snapshot
        else old.line_total_usd / old.qty end * new.qty,2);
      new.line_total_bs_snapshot := round(old.unit_price_bs_snapshot * new.qty,2);
    end if;
    return new;
  end if;
  $prefix$;
begin
  foreach name in array array['trg_order_items_guard','trg_order_items_pricing_guard','trg_order_items_set_pricing'] loop
    definition := replace(pg_get_functiondef(('public.'||name||'()')::regprocedure),chr(13),'');
    if position('order_item_operational_quantity_v1' in definition)>0 then raise exception 'Operational quantity guard already installed'; end if;
    anchor := E'begin\n';
    if position(anchor in definition)=0 then raise exception 'Item guard changed: %',name; end if;
    definition := replace(definition,anchor,anchor||prefix);
    execute definition;
  end loop;
  -- Counter's existing pickup command must also work on manually locked orders.
  foreach name in array array['trg_order_items_guard','trg_order_items_lock_guard'] loop
    definition := replace(pg_get_functiondef(('public.'||name||'()')::regprocedure),chr(13),'');
    anchor := case name when 'trg_order_items_guard'
      then 'if not (public.is_admin() or public.is_master()) then'
      else 'if not public.is_master_or_admin() then' end;
    if position(anchor in definition)=0 then raise exception 'Item lock guard changed: %',name; end if;
    definition := replace(definition,anchor,
      'if not (public.is_master_or_admin() or (auth.uid() is not null and public.has_role(''counter'') and exists (select 1 from public.orders o where o.id=coalesce(new.order_id,old.order_id) and o.fulfillment::text=''pickup'' and o.status::text in (''created'',''queued'',''confirmed'',''in_kitchen'',''ready'')))) then');
    execute definition;
  end loop;
end;
$migration$;

-- An inactive historical product may be reduced, never sold again/increased.
-- CRM identities, product and all unit terms remain immutable on this path.
do $migration$
declare definition text := replace(pg_get_functiondef('app_private.crm_order_item_guard_v1()'::regprocedure),chr(13),'');
  anchor text := E'begin\n';
begin
  if position(anchor in definition)=0 or position('order_item_operational_quantity_v1' in definition)>0 then
    raise exception 'CRM item guard changed';
  end if;
  definition := replace(definition,anchor,anchor||$addition$
  if tg_op='UPDATE' and auth.uid() is not null
    and (public.is_master_or_admin() or public.has_role('counter'))
    and new.qty<=old.qty
    and app_private.order_item_operational_quantity_v1(to_jsonb(old),to_jsonb(new))
    and exists(select 1 from public.products p where p.id=old.product_id and not p.is_active)
    and exists(select 1 from public.orders o where o.id=old.order_id
      and o.status::text in ('created','queued','confirmed','in_kitchen','ready')
      and (public.is_master_or_admin() or o.fulfillment::text='pickup')) then
    return new;
  end if;
$addition$);
  execute definition;
end;
$migration$;

do $migration$
declare definition text := replace(pg_get_functiondef('app_private.update_order_core_atomic_v1(bigint,timestamptz,jsonb,jsonb)'::regprocedure),chr(13),'');
  section text; updated text; anchor text;
begin
  if position('Operational retained rows' in definition)>0 then raise exception 'Operational retention already installed'; end if;
  -- Existing approvals may be removed or have quantity changed, never transferred
  -- to a different product/client or assigned new economic terms.
  section := substring(definition from position('  -- Identity, context and complete economic evidence' in definition)
    for position('  -- All other ordinary rows' in definition)-position('  -- Identity, context and complete economic evidence' in definition));
  if section is null or length(section)<100 then raise exception 'Approved retention anchor changed'; end if;
  updated := replace(section,'and item.qty = (incoming.value ->> ''qty'')::numeric',
    'and (incoming.value ->> ''qty'')::numeric > 0');
  updated := replace(updated,'and item.line_total_usd = (incoming.value ->> ''line_total_usd'')::numeric',
    'and (incoming.value ->> ''line_total_usd'')::numeric = case when item.qty=(incoming.value ->> ''qty'')::numeric then item.line_total_usd else round(item.line_total_usd/item.qty*(incoming.value ->> ''qty'')::numeric,2) end');
  updated := replace(updated,'and item.line_total_bs_snapshot = (incoming.value ->> ''line_total_bs_snapshot'')::numeric',
    'and (incoming.value ->> ''line_total_bs_snapshot'')::numeric = case when item.qty=(incoming.value ->> ''qty'')::numeric then item.line_total_bs_snapshot else round(item.unit_price_bs_snapshot*(incoming.value ->> ''qty'')::numeric,2) end');
  updated := replace(updated,'and not (item.id = any(v_preserved_approved_ids))',
    'and not (item.id = any(v_preserved_approved_ids)) and (not v_is_master or exists (select 1 from jsonb_array_elements(p_items) submitted(value) where nullif(submitted.value ->> ''order_item_id'','''')::bigint=item.id))');
  if updated=section then raise exception 'Approved retention replacements failed'; end if;
  definition := replace(definition,section,updated);
  anchor := '  -- All other ordinary rows follow the original atomic rebuild and CRM guard.';
  definition := replace(definition,anchor,$addition$
  -- Operational retained rows: preserve the unit snapshots and item identity.
  if v_is_master and not v_is_admin then
    v_preserved_legacy_ids := v_preserved_legacy_ids || array(
      select item.id from public.order_items item
      join jsonb_array_elements(p_items) incoming(value)
        on nullif(incoming.value->>'order_item_id','')::bigint=item.id
      where item.order_id=p_order_id and item.admin_price_override_usd is null
        and item.crm_play_member_id is null
        and app_private.order_item_operational_quantity_v1(to_jsonb(item),
          to_jsonb(jsonb_populate_record(item,incoming.value-array['order_item_id','admin_price_override_by_user_id','admin_price_override_at']))));
  end if;
$addition$ || anchor);
  anchor := '    if nullif(v_item ->> ''order_item_id'', '''')::bigint = any(v_preserved_legacy_ids) then';
  if position(anchor in definition)=0 then raise exception 'Retained loop changed'; end if;
  definition := replace(definition,anchor,anchor||$addition$
      update public.order_items item set qty=(v_item->>'qty')::numeric,
        line_total_usd=(v_item->>'line_total_usd')::numeric,
        line_total_bs_snapshot=(v_item->>'line_total_bs_snapshot')::numeric,
        notes=nullif(btrim(v_item->>'notes'),'')
      where item.id=(v_item->>'order_item_id')::bigint and item.crm_play_member_id is null
        and (item.qty is distinct from (v_item->>'qty')::numeric
          or item.notes is distinct from nullif(btrim(v_item->>'notes'),''));
$addition$);
  execute definition;
end;
$migration$;

-- A beverage is not a newly requested kitchen preparation. Keep reductions
-- informative and return ready pickups only when a kitchen item is increased.
do $migration$
declare definition text := replace(pg_get_functiondef('public.counter_build_pickup_item_plan(bigint,jsonb,jsonb)'::regprocedure),chr(13),'');
  anchor text := 'v_had_existing_increase or jsonb_array_length(v_added_plan) > 0';
begin
  if position(anchor in definition)=0 then raise exception 'Counter kitchen decision changed'; end if;
  definition := replace(definition,anchor,$addition$
      exists (select 1 from jsonb_array_elements(v_existing_plan) planned(value)
        join public.products product on product.id=(planned.value->>'productId')::bigint
        where (planned.value->>'qty')::numeric>(planned.value->>'previousQty')::numeric
          and coalesce(product.inventory_group,'')<>'beverages')
      or exists (select 1 from jsonb_array_elements(v_added_plan) planned(value)
        join public.products product on product.id=(planned.value->>'productId')::bigint
        where coalesce(product.inventory_group,'')<>'beverages')
$addition$);
  execute definition;
end;
$migration$;

-- Explicit decision, not automatic financial side effects during an edit.
-- The canonical state is re-read under the order lock, so repeated/concurrent
-- requests cannot credit the same surplus twice. Existing payout command follows.
create or replace function public.store_operational_order_excess_v1(p_order_id bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_state record; v_excess numeric; v_id bigint;
  v_payment record; v_remaining numeric; v_credit numeric; v_ids jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Solo Máster o Administración puede resolver este excedente.' using errcode='42501';
  end if;
  if length(btrim(coalesce(p_reason,'')))<4 then raise exception 'Indica el motivo del saldo a favor.'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.client_id is null or v_order.status::text not in ('created','queued','confirmed','in_kitchen','ready') then
    raise exception 'La orden ya no admite esta resolución operativa.';
  end if;
  perform id from public.clients where id=v_order.client_id for update;
  select * into v_state from public.get_order_financial_state(p_order_id,null,null);
  v_excess := greatest(0,round(coalesce(v_state.overpaid_usd,0)-coalesce((select sum(amount_usd_equivalent)
    from public.order_change_obligations where order_id=p_order_id and status='pending'),0)
    -coalesce((select sum(amount_usd_equivalent) from public.money_movements where order_id=p_order_id
      and direction='outflow' and movement_type='withdrawal' and status='pending'),0),2));
  if v_excess<=0 then return jsonb_build_object('ok',true,'amountUsd',0); end if;
  -- Preserve exact report ownership so the canonical payment-void operation can
  -- reverse these credits, or refuse the void if the customer already spent them.
  v_remaining := v_excess;
  for v_payment in
    select m.payment_report_id,
      greatest(0,round(sum(case when m.direction='inflow' then m.amount_usd_equivalent else -m.amount_usd_equivalent end)
        -coalesce((select sum(case when f.movement_type='credit' then f.amount_usd else -f.amount_usd end)
          from public.client_fund_movements f where f.order_id=p_order_id and f.payment_report_id=m.payment_report_id
          and f.reason_code in ('payment_overage_stored','retention_overage_stored','payment_void_fund_reversal')),0),2)) as available_usd
    from public.money_movements m where m.order_id=p_order_id and m.status='confirmed'
      and m.payment_report_id is not null and m.movement_type in ('order_payment','change_given')
    group by m.payment_report_id order by m.payment_report_id desc
  loop
    v_credit := least(v_remaining,v_payment.available_usd);
    if v_credit<=0 then continue; end if;
    insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,
      order_id,payment_report_id,reason_code,notes,created_by_user_id)
    values(v_order.client_id,'credit','USD',v_credit,v_credit,p_order_id,v_payment.payment_report_id,
      'payment_overage_stored',btrim(p_reason),auth.uid()) returning id into v_id;
    v_ids := v_ids || jsonb_build_array(v_id);
    v_remaining := round(v_remaining-v_credit,2);
    exit when v_remaining<=0;
  end loop;
  if v_remaining>0 then
    raise exception 'El excedente no tiene reportes de pago suficientes para conciliarlo. No se guardó nada; revisa sus pagos.' using errcode='22023';
  end if;
  update public.clients set fund_balance_usd=round(coalesce(fund_balance_usd,0)+v_excess,2) where id=v_order.client_id;
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,actor_user_id,payload)
  values(p_order_id,v_order.order_number,'order_edit_excess_stored','payment','Saldo a favor guardado en fondo',btrim(p_reason),auth.uid(),
    jsonb_build_object('amount_usd',v_excess,'fund_movement_ids',v_ids));
  return jsonb_build_object('ok',true,'amountUsd',v_excess,'fundMovementIds',v_ids);
end;
$$;
revoke all on function public.store_operational_order_excess_v1(bigint,text) from public,anon;
grant execute on function public.store_operational_order_excess_v1(bigint,text) to authenticated;
commit;
