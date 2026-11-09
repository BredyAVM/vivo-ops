-- A coupon offers the authorized catalog, rather than eight independent gifts.
-- Ordinary plays keep their existing eight-option limit.
alter table public.crm_play_benefits drop constraint crm_play_benefits_sort_order_check;
alter table public.crm_play_benefits add constraint crm_play_benefits_sort_order_check
  check (sort_order between 1 and 1000);

create or replace function app_private.crm_play_benefit_guard_v2()
returns trigger language plpgsql set search_path='' as $$
declare play_status text; play_rules jsonb;
begin
  select status,rules_snapshot into play_status,play_rules from public.crm_plays
  where id=case when tg_op='DELETE' then old.play_id else new.play_id end;
  if play_status is null then raise exception 'CRM play does not exist'; end if;
  if play_status<>'draft' then raise exception 'CRM play benefit options are immutable after review begins'; end if;
  if tg_op<>'DELETE' and new.sort_order>8 and jsonb_typeof(play_rules->'coupon_draft') is distinct from 'object' then
    raise exception 'Las jugadas de obsequios permiten hasta ocho alternativas.' using errcode='22023';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
