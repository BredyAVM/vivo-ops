-- Advisor commission notifications reuse the existing notification ledger.
-- The legacy enum value remains unchanged; the domain and kind live in meta so
-- we do not add another table or duplicate the existing notification columns.

create unique index if not exists notifications_advisor_commission_dedupe_idx
  on public.notifications (recipient_user_id, ((meta ->> 'dedupe_key')))
  where (meta ->> 'domain') = 'advisor_commissions'
    and coalesce(meta ->> 'dedupe_key', '') <> '';

-- Notification reads are private to their recipient. Existing writers keep
-- their current policy because order workflows create cross-user notices.
drop policy if exists notifications_select_authenticated on public.notifications;
create policy notifications_select_authenticated
  on public.notifications
  for select
  to authenticated
  using (
    (select auth.uid()) = recipient_user_id
    or (select public.has_role('admin'))
    or (select public.has_role('master'))
  );

drop policy if exists notifications_update_authenticated on public.notifications;
create policy notifications_update_authenticated
  on public.notifications
  for update
  to authenticated
  using (
    (select auth.uid()) = recipient_user_id
    or (select public.has_role('admin'))
    or (select public.has_role('master'))
  )
  with check (
    (select auth.uid()) = recipient_user_id
    or (select public.has_role('admin'))
    or (select public.has_role('master'))
  );

-- Keep the advisor badge current without polling. Postgres Changes still
-- enforces the recipient RLS policy above.
do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;

-- Seed only the latest period currently under review. Older audit periods stay
-- silent so enabling this feature does not flood advisors with historical work.
with latest_period as (
  select id, name
  from public.advisor_commission_periods
  order by date_to desc, id desc
  limit 1
)
insert into public.notifications (
  recipient_user_id,
  order_id,
  type,
  status,
  title,
  body,
  created_at,
  read_at,
  meta
)
select
  closure.advisor_user_id,
  null,
  'master_info'::public.notification_type,
  'unread'::public.notification_status,
  'Tu liquidación está lista para revisar',
  format(
    'La liquidación de %s tiene un monto calculado de $%s. Revisa el detalle antes de dar tu conformidad.',
    period.name,
    to_char(coalesce(closure.payable_usd, 0), 'FM999999990.00')
  ),
  now(),
  null,
  jsonb_build_object(
    'domain', 'advisor_commissions',
    'kind', 'advisor_commission_review_ready',
    'dedupe_key', 'commission-review:' || closure.id::text,
    'fingerprint', 'seed:' || closure.id::text || ':' || closure.updated_at::text,
    'requires_action', true,
    'closure_id', closure.id,
    'period_id', period.id,
    'period_name', period.name,
    'href', '/app/advisor/commissions?period=' || period.id::text
  )
from latest_period period
join public.advisor_commission_closures closure
  on closure.period_id = period.id
join public.profiles profile
  on profile.id = closure.advisor_user_id
where closure.status = 'preliminary'
  and profile.receives_commissions is true
  and not exists (
    select 1
    from public.notifications existing
    where existing.recipient_user_id = closure.advisor_user_id
      and existing.meta ->> 'domain' = 'advisor_commissions'
      and existing.meta ->> 'dedupe_key' = 'commission-review:' || closure.id::text
  );
