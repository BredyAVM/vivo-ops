-- Counter Block 4: Supabase advisor follow-up
-- Date: 2026-07-25

begin;

alter function public.get_order_financial_state_block3(
  bigint,
  date,
  numeric
) set search_path = '';

commit;
