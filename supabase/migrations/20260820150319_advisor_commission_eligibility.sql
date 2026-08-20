alter table public.profiles
  add column if not exists receives_commissions boolean not null default false;

comment on column public.profiles.receives_commissions is
  'Indicates whether an active user with the advisor role participates in advisor commission settlements.';

-- Existing operational advisors participate by default. Users who also administer
-- the operation keep their Advisor access but do not enter commission settlements.
update public.profiles profile
set receives_commissions = true
where profile.is_active = true
  and exists (
    select 1
    from public.user_roles advisor_role
    where advisor_role.user_id = profile.id
      and advisor_role.role = 'advisor'
  )
  and not exists (
    select 1
    from public.user_roles elevated_role
    where elevated_role.user_id = profile.id
      and elevated_role.role in ('admin', 'master')
  );
