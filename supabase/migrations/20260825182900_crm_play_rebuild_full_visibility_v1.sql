-- The list builder must evaluate the complete commercial history, not only
-- rows otherwise visible to the individual Master/Admin session. The function
-- already enforces auth.uid() plus is_master_or_admin(), has an empty
-- search_path and is executable only by authenticated/service roles.

alter function public.crm_rebuild_play_members_v1(bigint) security definer;
