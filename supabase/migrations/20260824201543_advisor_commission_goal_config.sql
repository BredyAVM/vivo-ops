alter table public.advisor_commission_periods
  add column if not exists goal_config jsonb not null default '{}'::jsonb;

alter table public.advisor_commission_periods
  drop constraint if exists advisor_commission_periods_goal_config_object_check;

alter table public.advisor_commission_periods
  add constraint advisor_commission_periods_goal_config_object_check
  check (jsonb_typeof(goal_config) = 'object');

comment on column public.advisor_commission_periods.goal_config is
  'Versioned administrative configuration for advisor goals. Individual publications remain inside advisor_commission_closures.snapshot.advisorGoal to reuse the existing period/advisor boundary.';
