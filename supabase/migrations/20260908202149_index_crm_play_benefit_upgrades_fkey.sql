-- Follow-up for the production migration: keep deletes and composite FK checks
-- fast from the referenced crm_play_benefits side.
create index if not exists crm_play_benefit_upgrades_benefit_play_idx
  on public.crm_play_benefit_upgrades(play_benefit_id, play_id);
