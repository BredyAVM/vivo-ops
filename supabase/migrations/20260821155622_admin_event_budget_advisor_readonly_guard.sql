-- Assigned advisors may read administrative event quotes, but ownership of a
-- draft must not let them rewrite, convert or archive its frozen proposal.

drop policy if exists advisor_order_drafts_insert_access on public.advisor_order_drafts;
create policy advisor_order_drafts_insert_access
on public.advisor_order_drafts
for insert
to authenticated
with check (
  (select public.has_role('admin'))
  or (
    advisor_user_id = (select auth.uid())
    and coalesce(payload #>> '{event_budget,kind}', '') <> 'admin_event_budget'
  )
);

drop policy if exists advisor_order_drafts_update_access on public.advisor_order_drafts;
create policy advisor_order_drafts_update_access
on public.advisor_order_drafts
for update
to authenticated
using (
  (select public.has_role('admin'))
  or (
    advisor_user_id = (select auth.uid())
    and coalesce(payload #>> '{event_budget,kind}', '') <> 'admin_event_budget'
  )
)
with check (
  (select public.has_role('admin'))
  or (
    advisor_user_id = (select auth.uid())
    and coalesce(payload #>> '{event_budget,kind}', '') <> 'admin_event_budget'
  )
);

drop policy if exists advisor_order_drafts_delete_access on public.advisor_order_drafts;
create policy advisor_order_drafts_delete_access
on public.advisor_order_drafts
for delete
to authenticated
using (
  (select public.has_role('admin'))
  or (
    advisor_user_id = (select auth.uid())
    and coalesce(payload #>> '{event_budget,kind}', '') <> 'admin_event_budget'
  )
);
