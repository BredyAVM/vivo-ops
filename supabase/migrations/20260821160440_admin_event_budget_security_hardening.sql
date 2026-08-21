alter function public.set_advisor_order_drafts_updated_at()
  set search_path = '';

revoke all privileges
  on table public.advisor_order_drafts
  from anon;

comment on function public.set_advisor_order_drafts_updated_at()
  is 'Maintains advisor_order_drafts.updated_at with a fixed empty search_path.';
