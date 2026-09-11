set lock_timeout = '5s';
set statement_timeout = '30s';

begin;

-- The public command keeps the authenticated-only boundary while executing as
-- its owner so it can reach the non-public implementation. Authorization for
-- the concrete order remains enforced inside the private function with auth.uid().
create or replace function public.update_order_core_atomic_v1(
  p_order_id bigint,
  p_expected_last_modified_at timestamptz,
  p_order_patch jsonb,
  p_items jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app_private.update_order_core_atomic_v1(
    p_order_id,
    p_expected_last_modified_at,
    p_order_patch,
    p_items
  )
$$;

revoke all on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb)
  from public, anon, service_role;
grant execute on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb)
  to authenticated;

comment on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb) is
  'Authenticated order-edit command. Its private implementation enforces actor, status, pricing and CRM invariants atomically.';

commit;
