-- Table privileges are the outer gate; row-level policies still restrict writes
-- to authenticated Master/Admin users and the draft-only lifecycle trigger.

grant insert, update, delete on table public.crm_play_members to authenticated;
grant usage, select on sequence public.crm_play_members_id_seq to authenticated;
