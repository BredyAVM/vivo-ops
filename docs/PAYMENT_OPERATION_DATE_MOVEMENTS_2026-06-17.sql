-- Payment operation date alignment - VIVO Ops
-- Date: 2026-06-17
--
-- Purpose:
-- Use the real bank/payment operation date for account reconciliation filters.
-- The app stores future reports in payment_reports.operation_date and confirms
-- linked money_movements with that date. This script repairs existing data.

begin;

alter table public.payment_reports
  add column if not exists operation_date date null;

create index if not exists idx_payment_reports_operation_date
  on public.payment_reports (operation_date);

create index if not exists idx_money_movements_payment_report_date
  on public.money_movements (payment_report_id, movement_date);

-- Backfill operation_date from old notes like:
-- Fecha operacion: 2026-06-10 / Fecha operacion: 2026-06-10
-- The regex intentionally takes the first ISO date found in notes.
with parsed as (
  select
    id,
    ((regexp_match(notes, '(\d{4}-\d{2}-\d{2})'))[1])::date as parsed_operation_date
  from public.payment_reports
  where operation_date is null
    and notes ~ '\d{4}-\d{2}-\d{2}'
)
update public.payment_reports pr
set operation_date = parsed.parsed_operation_date
from parsed
where pr.id = parsed.id
  and parsed.parsed_operation_date is not null;

-- Historical confirmed movements linked to reports should reconcile by the
-- bank operation date, not the date when Master confirmed or registered them.
update public.money_movements mm
set movement_date = pr.operation_date
from public.payment_reports pr
where mm.payment_report_id = pr.id
  and pr.operation_date is not null
  and mm.movement_date is distinct from pr.operation_date
  and coalesce(mm.status::text, case when mm.confirmed_at is not null then 'confirmed' else 'pending' end) <> 'voided';

commit;

-- Verification: rows still missing operation_date and linked movement mismatches.
select
  count(*) filter (where pr.operation_date is null) as reports_without_operation_date,
  count(*) filter (
    where pr.operation_date is not null
      and mm.id is not null
      and mm.movement_date is distinct from pr.operation_date
  ) as linked_movements_still_mismatched
from public.payment_reports pr
left join public.money_movements mm on mm.payment_report_id = pr.id;

