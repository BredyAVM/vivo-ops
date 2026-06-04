-- Diagnostico financiero canonico - VIVO Ops
-- Fecha: 2026-06-04
-- Este script NO modifica datos. Solo detecta inconsistencias.

-- 1) Resumen general de tablas financieras.
select 'payment_reports' as area, status::text as estado, count(*) as registros
from public.payment_reports
group by status
union all
select 'money_movements' as area, status::text as estado, count(*) as registros
from public.money_movements
group by status
union all
select 'client_fund_movements' as area, movement_type::text as estado, count(*) as registros
from public.client_fund_movements
group by movement_type
order by area, estado;

-- 2) Reportes confirmados sin ningun movimiento financiero ligado.
select
  pr.id as payment_report_id,
  pr.order_id,
  pr.created_at,
  pr.reported_currency_code,
  pr.reported_amount,
  pr.reported_amount_usd_equivalent,
  pr.reported_money_account_id,
  pr.reference_code,
  pr.payer_name,
  pr.notes
from public.payment_reports pr
where pr.status = 'confirmed'
  and not exists (
    select 1
    from public.money_movements mm
    where mm.payment_report_id = pr.id
  )
order by pr.created_at desc;

-- 3) Reportes confirmados cuyo movimiento ligado NO esta confirmado.
select
  pr.id as payment_report_id,
  pr.order_id,
  pr.status as report_status,
  mm.id as money_movement_id,
  mm.status as movement_status,
  mm.voided_at,
  mm.void_reason,
  mm.amount_usd_equivalent
from public.payment_reports pr
join public.money_movements mm on mm.payment_report_id = pr.id
where pr.status = 'confirmed'
  and coalesce(mm.status::text, case when mm.confirmed_at is not null then 'confirmed' else 'pending' end) <> 'confirmed'
order by pr.created_at desc;

-- 4) Movimientos anulados cuyo reporte sigue apareciendo confirmado.
select
  mm.id as money_movement_id,
  mm.order_id,
  mm.payment_report_id,
  mm.status as movement_status,
  mm.voided_at,
  mm.void_reason,
  pr.status as report_status,
  pr.reported_amount_usd_equivalent,
  pr.reference_code
from public.money_movements mm
join public.payment_reports pr on pr.id = mm.payment_report_id
where mm.status = 'voided'
  and pr.status = 'confirmed'
order by mm.voided_at desc nulls last, mm.created_at desc;

-- 5) Movimientos confirmados sin order_id ni payment_report_id.
-- No todos son errores: puede haber ingresos/egresos generales.
-- Sirve para auditar si hay pagos de orden que quedaron sin liga.
select
  mm.id,
  mm.movement_date,
  mm.created_at,
  mm.direction,
  mm.movement_type,
  mm.money_account_id,
  mm.currency_code,
  mm.amount,
  mm.amount_usd_equivalent,
  mm.reference_code,
  mm.counterparty_name,
  mm.description,
  mm.notes
from public.money_movements mm
where mm.status = 'confirmed'
  and mm.order_id is null
  and mm.payment_report_id is null
order by mm.movement_date desc, mm.created_at desc
limit 100;

-- 6) Saldos por orden segun movimiento financiero real.
with order_money as (
  select
    o.id as order_id,
    o.order_number,
    o.status as order_status,
    o.client_id,
    coalesce(o.total_usd, 0)::numeric as order_total_usd,
    coalesce((o.extra_fields->'payment'->>'client_fund_used_usd')::numeric, 0) as client_fund_used_usd,
    coalesce(sum(
      case
        when mm.status = 'confirmed' and mm.direction = 'inflow' then coalesce(mm.amount_usd_equivalent, 0)
        when mm.status = 'confirmed' and mm.direction = 'outflow' then -coalesce(mm.amount_usd_equivalent, 0)
        else 0
      end
    ), 0) as confirmed_money_usd,
    count(*) filter (where mm.status = 'voided') as voided_movements,
    count(*) filter (where mm.status = 'pending') as pending_movements
  from public.orders o
  left join public.money_movements mm on mm.order_id = o.id
  group by o.id
)
select
  order_id,
  order_number,
  order_status,
  client_id,
  order_total_usd,
  confirmed_money_usd,
  client_fund_used_usd,
  round((order_total_usd - confirmed_money_usd - client_fund_used_usd)::numeric, 2) as pending_usd,
  voided_movements,
  pending_movements
from order_money
where order_status <> 'cancelled'
order by abs(round((order_total_usd - confirmed_money_usd - client_fund_used_usd)::numeric, 2)) desc, order_id desc
limit 150;

-- 7) Diferencia entre reportes confirmados y movimientos confirmados por orden.
-- Esta consulta muestra donde las pantallas podrian dar lecturas distintas.
with report_totals as (
  select
    order_id,
    round(sum(coalesce(reported_amount_usd_equivalent, 0))::numeric, 2) as confirmed_reports_usd
  from public.payment_reports
  where status = 'confirmed'
  group by order_id
),
movement_totals as (
  select
    order_id,
    round(sum(
      case
        when direction = 'inflow' then coalesce(amount_usd_equivalent, 0)
        else -coalesce(amount_usd_equivalent, 0)
      end
    )::numeric, 2) as confirmed_movements_usd
  from public.money_movements
  where status = 'confirmed'
    and order_id is not null
  group by order_id
)
select
  o.id as order_id,
  o.order_number,
  o.status,
  coalesce(rt.confirmed_reports_usd, 0) as confirmed_reports_usd,
  coalesce(mt.confirmed_movements_usd, 0) as confirmed_movements_usd,
  round((coalesce(rt.confirmed_reports_usd, 0) - coalesce(mt.confirmed_movements_usd, 0))::numeric, 2) as diff_usd
from public.orders o
left join report_totals rt on rt.order_id = o.id
left join movement_totals mt on mt.order_id = o.id
where abs(coalesce(rt.confirmed_reports_usd, 0) - coalesce(mt.confirmed_movements_usd, 0)) > 0.01
order by abs(coalesce(rt.confirmed_reports_usd, 0) - coalesce(mt.confirmed_movements_usd, 0)) desc, o.id desc;

-- 8) Fondos de clientes: balance guardado vs ledger.
with fund_ledger as (
  select
    client_id,
    round(sum(
      case
        when movement_type = 'credit' then coalesce(amount_usd, 0)
        when movement_type = 'debit' then -coalesce(amount_usd, 0)
        else 0
      end
    )::numeric, 2) as ledger_fund_usd
  from public.client_fund_movements
  group by client_id
)
select
  c.id as client_id,
  c.full_name,
  c.phone,
  round(coalesce(c.fund_balance_usd, 0)::numeric, 2) as stored_fund_usd,
  coalesce(fl.ledger_fund_usd, 0) as ledger_fund_usd,
  round((coalesce(c.fund_balance_usd, 0) - coalesce(fl.ledger_fund_usd, 0))::numeric, 2) as diff_usd
from public.clients c
left join fund_ledger fl on fl.client_id = c.id
where abs(coalesce(c.fund_balance_usd, 0) - coalesce(fl.ledger_fund_usd, 0)) > 0.01
order by abs(coalesce(c.fund_balance_usd, 0) - coalesce(fl.ledger_fund_usd, 0)) desc, c.id;

-- 9) Retenciones pendientes o confirmadas.
select
  pr.id as payment_report_id,
  pr.order_id,
  pr.status,
  pr.created_at,
  pr.reported_currency_code,
  pr.reported_amount,
  pr.reported_amount_usd_equivalent,
  pr.reference_code as comprobante,
  pr.payer_name,
  pr.notes,
  mm.id as money_movement_id,
  mm.status as movement_status,
  mm.money_account_id,
  mm.amount_usd_equivalent as movement_usd
from public.payment_reports pr
left join public.money_movements mm on mm.payment_report_id = pr.id
where lower(coalesce(pr.notes, '')) like '%retencion%'
   or lower(coalesce(pr.notes, '')) like '%retención%'
order by pr.created_at desc;

