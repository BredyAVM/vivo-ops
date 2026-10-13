-- Award issuance only. No order price changes, payments, debt offsets or redemptions.
-- Issued terms are immutable; execution in orders is a separately verified block.
alter table public.advisor_reward_drafts drop constraint advisor_reward_drafts_status_check;
alter table public.advisor_reward_drafts add constraint advisor_reward_drafts_status_check check(status in ('draft','cancelled','issued'));

create table public.advisor_reward_grants (
  id bigint generated always as identity primary key,
  source_draft_id bigint not null unique references public.advisor_reward_drafts(id),
  source_version integer not null check(source_version>0),
  advisor_id uuid not null references public.profiles(id),
  advisor_name_snapshot text not null,
  amount numeric(12,2) not null check(amount>0 and amount<=100000),
  kind text not null check(kind in ('credit','product_units')),
  period date not null check(extract(day from period)=1),
  terms_snapshot jsonb not null check(jsonb_typeof(terms_snapshot)='object'),
  status text not null default 'active' check(status in ('active','revoked')),
  issued_by uuid not null references public.profiles(id),
  issued_at timestamptz not null default statement_timestamp(),
  issue_reason text not null check(length(btrim(issue_reason)) between 10 and 500),
  expires_on date,
  revoked_by uuid references public.profiles(id),
  revoked_at timestamptz,
  revoke_reason text,
  check((status='active' and revoked_by is null and revoked_at is null and revoke_reason is null)
    or (status='revoked' and revoked_by is not null and revoked_at is not null and length(btrim(revoke_reason)) between 10 and 500)),
  check(kind<>'product_units' or amount=trunc(amount))
);
create index advisor_reward_grants_owner_idx on public.advisor_reward_grants(advisor_id,id desc);
create index advisor_reward_grants_period_idx on public.advisor_reward_grants(period,id desc);
create index advisor_reward_grants_issuer_idx on public.advisor_reward_grants(issued_by);
create index advisor_reward_grants_revoker_idx on public.advisor_reward_grants(revoked_by) where revoked_by is not null;
create table public.advisor_reward_events (
  id bigint generated always as identity primary key,
  grant_id bigint not null references public.advisor_reward_grants(id),
  advisor_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  event_type text not null check(event_type in ('issued','revoked')),
  amount numeric(12,2) not null check(amount>0),
  reason text not null check(length(btrim(reason)) between 10 and 500),
  created_at timestamptz not null default statement_timestamp(),
  unique(grant_id,event_type)
);
create index advisor_reward_events_owner_idx on public.advisor_reward_events(advisor_id,id desc);
create index advisor_reward_events_actor_idx on public.advisor_reward_events(actor_id);
alter table public.advisor_reward_grants enable row level security;
alter table public.advisor_reward_events enable row level security;
create policy reward_grants_own_or_admin on public.advisor_reward_grants for select to authenticated
using(advisor_id=(select auth.uid()) or (select public.is_admin()));
create policy reward_events_own_or_admin on public.advisor_reward_events for select to authenticated
using(advisor_id=(select auth.uid()) or (select public.is_admin()));
revoke all on public.advisor_reward_grants,public.advisor_reward_events from public,anon,authenticated;
grant select on public.advisor_reward_grants,public.advisor_reward_events to authenticated;
grant all on public.advisor_reward_grants,public.advisor_reward_events to service_role;
revoke all on sequence public.advisor_reward_grants_id_seq,public.advisor_reward_events_id_seq from public,anon,authenticated;
grant all on sequence public.advisor_reward_grants_id_seq,public.advisor_reward_events_id_seq to service_role;

create function app_private.reward_grant_guard_v1() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'Los premios emitidos no se pueden borrar.'; end if;
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo el administrador puede emitir o revocar premios.'; end if;
  if tg_op='INSERT' then
    if current_setting('app.reward_grant_command',true) is distinct from 'issue' or new.status<>'active'
      or new.issued_by is distinct from auth.uid() then raise exception 'Emisión no autorizada.'; end if;
  else
    if current_setting('app.reward_grant_command',true) is distinct from 'revoke' or old.status<>'active' or new.status<>'revoked'
      or new.revoked_by is distinct from auth.uid()
      or (to_jsonb(new)-array['status','revoked_by','revoked_at','revoke_reason'])
        is distinct from (to_jsonb(old)-array['status','revoked_by','revoked_at','revoke_reason']) then
      raise exception 'Las condiciones del premio emitido son inmutables.';
    end if;
  end if;
  return new;
end; $$;
create trigger reward_grant_guard before insert or update or delete on public.advisor_reward_grants
for each row execute function app_private.reward_grant_guard_v1();

create function app_private.reward_event_guard_v1() returns trigger language plpgsql set search_path='' as $$
declare v_grant public.advisor_reward_grants%rowtype;
begin
  if tg_op<>'INSERT' then raise exception 'El historial del monedero es inmutable.'; end if;
  select * into v_grant from public.advisor_reward_grants where id=new.grant_id;
  if auth.uid() is null or not public.is_admin() or new.actor_id is distinct from auth.uid()
    or new.advisor_id is distinct from v_grant.advisor_id or new.amount is distinct from v_grant.amount
    or (new.event_type='issued' and current_setting('app.reward_grant_command',true) is distinct from 'issue')
    or (new.event_type='revoked' and current_setting('app.reward_grant_command',true) is distinct from 'revoke') then
    raise exception 'Movimiento de premio no autorizado.';
  end if;
  return new;
end; $$;
create trigger reward_event_guard before insert or update or delete on public.advisor_reward_events
for each row execute function app_private.reward_event_guard_v1();
revoke all on function app_private.reward_grant_guard_v1(),app_private.reward_event_guard_v1() from public,anon,authenticated;

-- Tighten the draft state machine: only issuance can freeze a draft.
create or replace function app_private.reward_draft_guard_v1() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'El historial de premios no se puede borrar.'; end if;
  if auth.uid() is null or not public.is_admin() or coalesce(current_setting('app.reward_draft_command',true),'')<>'design' then
    raise exception 'Solo el administrador puede modificar diseños mediante el comando autorizado.';
  end if;
  if tg_op='INSERT' and new.status<>'draft' then raise exception 'El premio debe comenzar como diseño.'; end if;
  if tg_op='UPDATE' then
    if old.status<>'draft' or new.id<>old.id or new.advisor_id<>old.advisor_id or new.created_by<>old.created_by
      or new.request_token<>old.request_token or new.created_at<>old.created_at or new.version<>old.version+1 then
      raise exception 'El diseño emitido o cancelado no se puede modificar.';
    end if;
    if new.status='issued' and (current_setting('app.reward_grant_command',true) is distinct from 'issue'
      or not exists(select 1 from public.advisor_reward_grants g where g.source_draft_id=old.id and g.source_version=old.version)) then
      raise exception 'Falta la emisión certificada del premio.';
    end if;
  end if;
  return new;
end; $$;

create function public.reward_issue_draft_v1(p_draft_id bigint,p_expected_version integer,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_draft public.advisor_reward_drafts%rowtype;
  v_grant public.advisor_reward_grants%rowtype; v_name text; v_terms jsonb;
begin
  if v_uid is null or not public.is_admin() then raise exception 'Solo el administrador puede emitir premios.'; end if;
  if coalesce(length(btrim(p_reason)),0) not between 10 and 500 then raise exception 'Indica el motivo de emisión en 10 a 500 caracteres.'; end if;
  -- Same profile -> draft order as design commands, without blocking FK checks.
  perform 1 from public.profiles where id=v_uid for no key update;
  select * into v_draft from public.advisor_reward_drafts where id=p_draft_id for update;
  if not found then raise exception 'El diseño no existe.'; end if;
  select * into v_grant from public.advisor_reward_grants where source_draft_id=p_draft_id;
  if found then
    if p_expected_version is distinct from v_grant.source_version or btrim(p_reason) is distinct from v_grant.issue_reason then
      raise exception 'El diseño ya fue emitido con otra solicitud.';
    end if;
    return jsonb_build_object('grant_id',v_grant.id,'advisor_id',v_grant.advisor_id,'status',v_grant.status,'replayed',true);
  end if;
  if v_draft.status<>'draft' then raise exception 'El diseño no está disponible para emitir.'; end if;
  if p_expected_version is distinct from v_draft.version then raise exception 'El diseño cambió. Actualiza antes de emitir.'; end if;
  select p.full_name into v_name from public.profiles p where p.id=v_draft.advisor_id and p.is_active
    and exists(select 1 from public.user_roles r where r.user_id=p.id and r.role='advisor');
  if v_name is null then raise exception 'El asesor ya no está activo.'; end if;
  if v_draft.expires_on is not null and v_draft.expires_on<(statement_timestamp() at time zone 'America/Caracas')::date then
    raise exception 'No se puede emitir un premio vencido.'; end if;
  if (select count(*) from public.products p where p.id=any(v_draft.allowed_product_ids) and p.is_active)<>cardinality(v_draft.allowed_product_ids) then
    raise exception 'Hay productos inactivos. Revisa el diseño antes de emitir.'; end if;
  v_terms:=to_jsonb(v_draft)-array['id','created_by','request_token','note','status','version','created_at','updated_at'];
  perform set_config('app.reward_grant_command','issue',true);
  insert into public.advisor_reward_grants(source_draft_id,source_version,advisor_id,advisor_name_snapshot,amount,kind,period,terms_snapshot,issued_by,issue_reason,expires_on)
    values(v_draft.id,v_draft.version,v_draft.advisor_id,v_name,v_draft.amount,v_draft.kind,v_draft.period,v_terms,v_uid,btrim(p_reason),v_draft.expires_on) returning * into v_grant;
  perform set_config('app.reward_draft_command','design',true);
  update public.advisor_reward_drafts set status='issued',version=version+1,updated_at=statement_timestamp() where id=v_draft.id;
  insert into public.advisor_reward_events(grant_id,advisor_id,actor_id,event_type,amount,reason)
    values(v_grant.id,v_grant.advisor_id,v_uid,'issued',v_grant.amount,btrim(p_reason));
  return jsonb_build_object('grant_id',v_grant.id,'advisor_id',v_grant.advisor_id,'status','active','replayed',false);
end; $$;

create function public.reward_revoke_grant_v1(p_grant_id bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_grant public.advisor_reward_grants%rowtype;
begin
  if v_uid is null or not public.is_admin() then raise exception 'Solo el administrador puede revocar premios.'; end if;
  if coalesce(length(btrim(p_reason)),0) not between 10 and 500 then raise exception 'Justifica la revocación en 10 a 500 caracteres.'; end if;
  select * into v_grant from public.advisor_reward_grants where id=p_grant_id for update;
  if not found then raise exception 'El premio no existe.'; end if;
  if v_grant.status='revoked' then
    if v_grant.revoke_reason is distinct from btrim(p_reason) then raise exception 'El premio ya fue revocado.'; end if;
    return jsonb_build_object('grant_id',v_grant.id,'advisor_id',v_grant.advisor_id,'replayed',true);
  end if;
  -- Block 2 has no redemption path. This command must be tightened when usage is installed.
  perform set_config('app.reward_grant_command','revoke',true);
  update public.advisor_reward_grants set status='revoked',revoked_by=v_uid,revoked_at=statement_timestamp(),revoke_reason=btrim(p_reason)
    where id=v_grant.id;
  insert into public.advisor_reward_events(grant_id,advisor_id,actor_id,event_type,amount,reason)
    values(v_grant.id,v_grant.advisor_id,v_uid,'revoked',v_grant.amount,btrim(p_reason));
  return jsonb_build_object('grant_id',v_grant.id,'advisor_id',v_grant.advisor_id,'replayed',false);
end; $$;
revoke all on function public.reward_issue_draft_v1(bigint,integer,text),public.reward_revoke_grant_v1(bigint,text) from public,anon;
grant execute on function public.reward_issue_draft_v1(bigint,integer,text),public.reward_revoke_grant_v1(bigint,text) to authenticated;
notify pgrst,'reload schema';
