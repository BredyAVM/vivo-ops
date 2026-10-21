-- One-off repair explicitly authorized by the owner on 2026-10-21.
-- NOT a schema migration. Preserve actual bank/POS receipts and their cash
-- valuation; correct only the debt coverage against the agreed original quote.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
declare
  v_order public.orders%rowtype;
  v_before public.order_payment_precision_allocations%rowtype;
  v_after public.order_payment_precision_allocations%rowtype;
  v_payment jsonb; v_report jsonb; v_quote jsonb; v_state record;
  v_applied numeric; v_rounding numeric;
  v_marker constant text := 'order_3435_agreed_quote_coverage_20261021';
begin
  select * into strict v_order from public.orders where id=3435 for update;
  perform id from public.clients where id=v_order.client_id for update;
  perform id from public.payment_reports where id=3597 for update;
  perform id from public.money_movements where id=9413 for update;
  select * into strict v_before from public.order_payment_precision_allocations
    where movement_id=9413 for update;

  if exists(select 1 from public.order_timeline_events where order_id=3435
      and payload->>'repair_key'=v_marker) then
    if v_before.order_id<>3435 or v_before.applied_usd<>95.70
      or v_before.coverage_rate<>881.88 or v_before.pending_before_bs<>84395.92 then
      raise exception 'La corrección previa cambió; requiere una nueva revisión.';
    end if;
    return; -- An exact retry must not duplicate audit events or financial credit.
  end if;

  select to_jsonb(m) into strict v_payment from public.money_movements m where id=9413;
  select to_jsonb(r) into strict v_report from public.payment_reports r where id=3597;
  select payload#>'{before,extra_fields,pricing}' into strict v_quote
    from public.order_admin_adjustments where id=903 and order_id=3435;
  if v_order.client_id is distinct from 3718 or v_order.status::text<>'delivered'
    or v_order.total_usd<>92.80 or v_order.total_bs_snapshot<>81838.46
    or (v_order.extra_fields#>>'{pricing,fx_rate}')::numeric<>881.88
    or (v_quote->>'total_usd')::numeric is distinct from 95.70
    or (v_quote->>'total_bs')::numeric is distinct from 84395.92
    or (v_quote->>'fx_rate')::numeric is distinct from 881.88
    or v_before.order_id<>3435 or v_before.currency_code::text<>'VES'
    or v_before.native_amount<>84395.92 or v_before.cash_equivalent_usd<>95.54
    or v_before.coverage_rate<>883.40 or v_before.pending_before_usd<>95.70
    or v_before.pending_before_bs<>84541.38 or v_before.rounding_usd<>0
    or abs(v_before.applied_usd-84395.92/883.40)>0.000000001
    or v_payment->>'status'<>'confirmed' or v_payment->>'direction'<>'inflow'
    or v_payment->>'movement_type'<>'order_payment' or v_payment->>'currency_code'<>'VES'
    or (v_payment->>'order_id')::bigint is distinct from 3435
    or (v_payment->>'payment_report_id')::bigint is distinct from 3597
    or (v_payment->>'money_account_id')::bigint is distinct from 10
    or (v_payment->>'amount')::numeric is distinct from 84395.92
    or (v_payment->>'amount_usd_equivalent')::numeric is distinct from 95.54
    or (v_payment->>'exchange_rate_ves_per_usd')::numeric is distinct from 883.40
    or v_report->>'status'<>'confirmed'
    or (v_report->>'order_id')::bigint is distinct from 3435
    or (v_report->>'confirmed_movement_id')::bigint is distinct from 9413
    or (v_report->>'reported_amount')::numeric is distinct from 84395.92
    or (select count(*) from public.money_movements where order_id=3435)<>1
    or exists(select 1 from public.client_fund_movements where order_id=3435)
    or exists(select 1 from public.order_change_obligations where order_id=3435)
  then raise exception 'La evidencia de la #3435 cambió. No se modificó nada.'; end if;

  select applied_usd,rounding_usd into strict v_applied,v_rounding
    from app_private.collection_payment_allocation_v1(95.70,84395.92,'VES',84395.92,881.88,883.40);
  update public.order_payment_precision_allocations
    set applied_usd=v_applied,rounding_usd=v_rounding,
      coverage_rate=881.88,pending_before_bs=84395.92
    where movement_id=9413 returning * into strict v_after;
  select * into strict v_state from public.get_order_financial_state(3435,'2026-10-21',null);
  if v_state.overpaid_usd is distinct from 2.90 or v_state.pending_usd is distinct from 0
    or v_state.confirmed_paid_usd is distinct from 95.70
    or (select to_jsonb(m) from public.money_movements m where id=9413)<>v_payment
    or (select to_jsonb(r) from public.payment_reports r where id=3597)<>v_report
    or (select to_jsonb(o) from public.orders o where id=3435)<>to_jsonb(v_order)
  then raise exception 'La comprobación financiera falló. Se revierte toda la corrección.'; end if;

  -- NULL actor is intentional: this is an owner-authorized system repair, not an
  -- action impersonating the original cashier or an arbitrary administrator.
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,actor_user_id,payload)
  values(3435,v_order.order_number,'payment_quote_coverage_corrected','payment',
    'Pago completo reconocido a tasa del presupuesto',
    'Corrección autorizada por el propietario: Bs 84.395,92 cubrieron USD 95,70 a 881,88 Bs/USD. Al retirar el delivery quedan USD 2,90 a favor. No se modificó el cobro bancario ni se entregó dinero al cliente.',
    null,jsonb_build_object('repair_key',v_marker,'authorization','Owner explicitly approved in financial audit chat on 2026-10-21',
      'before',to_jsonb(v_before),'after',to_jsonb(v_after),
      'bank_movement_unchanged',true,'payment_report_unchanged',true,
      'cash_exchange_rate_preserved',883.40,'agreed_coverage_rate',881.88,
      'amount_received_bs',84395.92,'original_quote_usd',95.70,'current_total_usd',92.80,
      'credit_pending_disposition_usd',2.90));
end $$;
commit;
