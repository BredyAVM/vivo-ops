-- Consolidate advisor ownership and admin access into one permissive policy
-- per command. This preserves both boundaries without evaluating duplicate
-- permissive policies for every row.

drop policy if exists advisor_order_drafts_select_own on public.advisor_order_drafts;
drop policy if exists advisor_order_drafts_select_admin on public.advisor_order_drafts;
create policy advisor_order_drafts_select_access
on public.advisor_order_drafts
for select
to authenticated
using (
  advisor_user_id = (select auth.uid())
  or (select public.has_role('admin'))
);

drop policy if exists advisor_order_drafts_insert_own on public.advisor_order_drafts;
drop policy if exists advisor_order_drafts_insert_admin on public.advisor_order_drafts;
create policy advisor_order_drafts_insert_access
on public.advisor_order_drafts
for insert
to authenticated
with check (
  advisor_user_id = (select auth.uid())
  or (select public.has_role('admin'))
);

drop policy if exists advisor_order_drafts_update_own on public.advisor_order_drafts;
drop policy if exists advisor_order_drafts_update_admin on public.advisor_order_drafts;
create policy advisor_order_drafts_update_access
on public.advisor_order_drafts
for update
to authenticated
using (
  advisor_user_id = (select auth.uid())
  or (select public.has_role('admin'))
)
with check (
  advisor_user_id = (select auth.uid())
  or (select public.has_role('admin'))
);

drop policy if exists advisor_order_drafts_delete_own on public.advisor_order_drafts;
drop policy if exists advisor_order_drafts_delete_admin on public.advisor_order_drafts;
create policy advisor_order_drafts_delete_access
on public.advisor_order_drafts
for delete
to authenticated
using (
  advisor_user_id = (select auth.uid())
  or (select public.has_role('admin'))
);
