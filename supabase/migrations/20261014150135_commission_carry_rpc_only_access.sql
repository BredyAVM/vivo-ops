-- Filename aligned with the applied Supabase migration history.
begin;
-- Collection reads already enforce the caller's closure ownership through
-- private commands. No direct Data API / GraphQL table discovery is needed.
revoke all on public.advisor_commission_carry_transfers from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
