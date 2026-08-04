-- Counter Block 4: post-migration hardening
-- Date: 2026-07-25

begin;

-- The inner financial function remains callable by authenticated server
-- contexts used across Advisor and Master, but is not exposed to anon/Public.
revoke all on function public.get_order_financial_state_block3(
  bigint,
  date,
  numeric
) from public, anon;

grant execute on function public.get_order_financial_state_block3(
  bigint,
  date,
  numeric
) to authenticated, service_role;

-- Index every referencing FK used by lifecycle cleanup or account audits.
create index order_change_obligations_requested_by_idx
  on public.order_change_obligations(requested_by_user_id);

create index order_change_obligations_completed_by_idx
  on public.order_change_obligations(completed_by_user_id)
  where completed_by_user_id is not null;

create index order_change_obligations_completed_movement_idx
  on public.order_change_obligations(completed_movement_id)
  where completed_movement_id is not null;

commit;
