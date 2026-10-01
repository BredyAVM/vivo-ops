-- User-requested September 2026 correction. Match business identities, not generated IDs.
-- Version matches the migration applied by the managed database service.
-- No orders, selections, redemptions, prices or historical delivery evidence are rewritten.
create table app_private.crm_play_period_corrections (
  id bigint generated always as identity primary key,
  play_id bigint not null references public.crm_plays(id),
  previous_values jsonb not null,
  corrected_values jsonb not null,
  reason text not null,
  performed_by text not null default current_user,
  recorded_at timestamptz not null default now()
);
alter table app_private.crm_play_period_corrections enable row level security;
revoke all on app_private.crm_play_period_corrections from public,anon,authenticated,service_role;

do $repair$
declare
  original_guard text;
  end_predicate text := '    or new.ends_at is distinct from old.ends_at';
  target_ids bigint[];
  target_end timestamptz := '2026-09-30T23:59:59.999-04:00';
  affected integer;
begin
  -- Serialize the temporary maintenance-only guard adjustment. Restore it before
  -- the transaction commits; no relaxed guard is ever published to normal writers.
  lock table public.crm_plays in share row exclusive mode;
  select array_agg(p.id order by p.id) into target_ids
  from public.crm_plays p
  join (values
    ('Aniversario · septiembre de 2026','2026-10-01T23:59:59.999-04:00'::timestamptz),
    ('Loyal · septiembre de 2026','2026-10-04T23:59:59.999-04:00'::timestamptz),
    ('LC · clientes perdidos · septiembre de 2026','2026-10-01T23:59:59.999-04:00'::timestamptz)
  ) expected(name,ends_at) on p.name=expected.name and p.ends_at=expected.ends_at
  where p.status='active' and p.starts_at>= '2026-09-01T00:00:00-04:00'::timestamptz and p.starts_at<target_end;
  if coalesce(cardinality(target_ids),0)<>3 then
    raise exception 'September campaigns changed since audit; review before correction';
  end if;
  if (select count(*) from public.crm_plays where name='NC · clientes nuevos · septiembre de 2026'
    and status='closed' and ends_at=target_end)<>1 then
    raise exception 'NC closure differs from audited state; review before correction';
  end if;
  insert into app_private.crm_play_period_corrections(play_id,previous_values,corrected_values,reason)
  select id,jsonb_build_object('name',name,'starts_at',starts_at,'ends_at',ends_at,'status',status,'closed_at',closed_at),
    jsonb_build_object('ends_at',target_end,'status','closed','closed_at',now()),
    'Corrección solicitada por el usuario: todas las jugadas de septiembre terminan el 30/09/2026 en Venezuela. El formulario truncaba la fecha UTC al editar.'
  from public.crm_plays where id=any(target_ids);

  select pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure) into original_guard;
  if strpos(original_guard,end_predicate)=0 then raise exception 'Campaign guard changed; abort repair'; end if;
  execute replace(original_guard,end_predicate,'');
  update public.crm_plays set ends_at=target_end where id=any(target_ids);
  get diagnostics affected = row_count;
  if affected<>3 then raise exception 'Unexpected campaign correction count'; end if;
  execute original_guard;
  if pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure) is distinct from original_guard then
    raise exception 'Campaign immutability guard was not restored';
  end if;

  -- Follow the normal expiry order: expire unused memberships while campaigns
  -- are active, then close campaigns. Redeemed benefits remain untouched.
  update public.crm_play_members set benefit_status='expired',benefit_expired_at=coalesce(benefit_expired_at,now())
    where play_id=any(target_ids) and benefit_status in ('available','reserved');
  update public.crm_plays set status='closed',closed_at=now() where id=any(target_ids);
end;
$repair$;
