-- No aplica is an audited request, never an advisor-controlled KPI exclusion.
create table public.crm_play_no_apply_requests (
  id bigint generated always as identity primary key,
  play_member_id bigint not null references public.crm_play_members(id),
  play_id bigint not null references public.crm_plays(id),
  client_id bigint not null references public.clients(id),
  advisor_id_snapshot uuid not null references public.profiles(id),
  requested_by_user_id uuid not null references public.profiles(id),
  reason_code text not null check (reason_code in ('duplicate','wrong_assignment','criteria_mismatch','do_not_contact','other')),
  justification text not null check (length(btrim(justification)) between 10 and 1000),
  member_snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  reviewed_by_user_id uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  check ((status = 'pending' and reviewed_at is null and reviewed_by_user_id is null and review_note is null)
    or (status <> 'pending' and reviewed_at is not null and reviewed_by_user_id is not null
      and length(btrim(review_note)) between 10 and 500))
);
create unique index crm_no_apply_one_pending on public.crm_play_no_apply_requests(play_member_id) where status = 'pending';
create index crm_no_apply_play_status on public.crm_play_no_apply_requests(play_id,status,requested_at desc,id desc);
create index crm_no_apply_advisor on public.crm_play_no_apply_requests(advisor_id_snapshot,play_member_id,id desc);
create index crm_no_apply_member on public.crm_play_no_apply_requests(play_member_id,id desc);
create index crm_no_apply_client on public.crm_play_no_apply_requests(client_id);
create index crm_no_apply_requester on public.crm_play_no_apply_requests(requested_by_user_id);
create index crm_no_apply_reviewer on public.crm_play_no_apply_requests(reviewed_by_user_id) where reviewed_by_user_id is not null;
alter table public.crm_play_no_apply_requests enable row level security;
create policy crm_no_apply_read on public.crm_play_no_apply_requests for select to authenticated
  using (advisor_id_snapshot = (select auth.uid()) or (select public.is_master_or_admin()));
revoke all on public.crm_play_no_apply_requests from public, anon, authenticated;
grant select on public.crm_play_no_apply_requests to authenticated, service_role;
grant all on public.crm_play_no_apply_requests to service_role;
grant usage, select on sequence public.crm_play_no_apply_requests_id_seq to service_role;

create function app_private.crm_no_apply_history_guard_v1() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'El historial de No aplica no se puede borrar.' using errcode = '42501';
  end if;
  if old.status <> 'pending' or new.status not in ('approved','rejected')
    or (to_jsonb(new) - array['status','reviewed_at','reviewed_by_user_id','review_note'])
      is distinct from (to_jsonb(old) - array['status','reviewed_at','reviewed_by_user_id','review_note']) then
    raise exception 'La solicitud original y las decisiones son inmutables.' using errcode = '42501';
  end if;
  if new.reviewed_by_user_id is distinct from auth.uid() or not exists (
    select 1 from public.user_roles where user_id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Solo el administrador puede resolver No aplica.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger crm_no_apply_history_guard before update or delete on public.crm_play_no_apply_requests
  for each row execute function app_private.crm_no_apply_history_guard_v1();

-- The legacy follow-up RPC must not bypass administrative review.
create function app_private.crm_no_apply_legacy_guard_v1() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.workflow_status = 'not_applicable' and new.workflow_status is distinct from old.workflow_status then
    raise exception 'Solicita No aplica con una justificación; requiere aprobación del administrador.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger crm_no_apply_legacy_guard before update on public.crm_play_members
  for each row execute function app_private.crm_no_apply_legacy_guard_v1();

create function public.crm_request_play_no_apply_v1(p_play_member_id bigint,p_reason_code text,p_justification text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member_row public.crm_play_members%rowtype;
  play_row public.crm_plays%rowtype;
  request_id bigint;
  reason text := btrim(coalesce(p_justification,''));
begin
  if auth.uid() is null or not exists (
    select 1 from public.user_roles where user_id = auth.uid() and role = 'advisor'
  ) then
    raise exception 'Solo el asesor asignado puede solicitar No aplica.' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code not in ('duplicate','wrong_assignment','criteria_mismatch','do_not_contact','other')
    or length(reason) not between 10 and 1000 then
    raise exception 'Selecciona un motivo y justifícalo en 10 a 1000 caracteres.' using errcode = '22023';
  end if;
  -- Match the published-audience amendment lock order: play, member, request.
  select play.* into play_row from public.crm_plays play
    join public.crm_play_members member on member.play_id = play.id where member.id = p_play_member_id;
  if play_row.id is null then raise exception 'La participación no existe.' using errcode = 'P0002'; end if;
  select * into play_row from public.crm_plays where id = play_row.id for update;
  select * into member_row from public.crm_play_members where id = p_play_member_id for update;
  if member_row.advisor_id_snapshot is distinct from auth.uid() then
    raise exception 'El cliente no pertenece a tu lista.' using errcode = '42501';
  end if;
  if play_row.status not in ('active','paused') or play_row.ends_at <= now() or member_row.workflow_status = 'removed' then
    raise exception 'Solo puedes solicitarlo para un cliente de una jugada publicada vigente.' using errcode = '55000';
  end if;
  if member_row.benefit_status = 'redeemed' or exists (
    select 1 from public.crm_play_redemptions where play_member_id = member_row.id and status = 'redeemed'
  ) then raise exception 'El cliente ya recibió un beneficio; no puede excluirse.' using errcode = '55000'; end if;
  if exists (select 1 from public.crm_play_no_apply_requests where play_member_id = member_row.id and status = 'pending') then
    raise exception 'Ya hay una solicitud pendiente para este cliente.' using errcode = '55000';
  end if;
  insert into public.crm_play_no_apply_requests(play_member_id,play_id,client_id,advisor_id_snapshot,
    requested_by_user_id,reason_code,justification,member_snapshot)
  values (member_row.id,member_row.play_id,member_row.client_id,member_row.advisor_id_snapshot,
    auth.uid(),p_reason_code,reason,to_jsonb(member_row)) returning id into request_id;
  insert into public.crm_play_member_events(play_member_id,event_type,from_status,to_status,note,actor_user_id,created_at)
  values (member_row.id,'note',member_row.workflow_status,member_row.workflow_status,
    'Solicitud No aplica #' || request_id || ': ' || reason,auth.uid(),now());
  return jsonb_build_object('request_id',request_id,'client_id',member_row.client_id,'play_id',member_row.play_id);
end;
$$;

create function public.crm_review_play_no_apply_v1(p_request_id bigint,p_approve boolean,p_review_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request_row public.crm_play_no_apply_requests%rowtype;
  member_row public.crm_play_members%rowtype;
  play_row public.crm_plays%rowtype;
  review_reason text := btrim(coalesce(p_review_note,''));
begin
  if auth.uid() is null or not exists (
    select 1 from public.user_roles where user_id = auth.uid() and role = 'admin'
  ) then raise exception 'Solo el administrador puede resolver No aplica.' using errcode = '42501'; end if;
  if p_approve is null or length(review_reason) not between 10 and 500 then
    raise exception 'Justifica la decisión en 10 a 500 caracteres.' using errcode = '22023';
  end if;
  select * into request_row from public.crm_play_no_apply_requests where id = p_request_id;
  if request_row.id is null then raise exception 'La solicitud no existe.' using errcode = 'P0002'; end if;
  select * into play_row from public.crm_plays where id = request_row.play_id for update;
  select * into member_row from public.crm_play_members where id = request_row.play_member_id for update;
  select * into request_row from public.crm_play_no_apply_requests where id = p_request_id for update;
  if request_row.status <> 'pending' then raise exception 'Esta solicitud ya fue resuelta.' using errcode = '55000'; end if;
  if p_approve then
    if member_row.benefit_status in ('reserved','redeemed') or exists (
      select 1 from public.crm_play_redemptions where play_member_id = member_row.id and status in ('reserved','redeemed')
    ) or exists (
      select 1 from public.order_items item join public.orders order_row on order_row.id = item.order_id
      where item.crm_play_member_id = member_row.id and order_row.status <> 'cancelled'
    ) then
      raise exception 'El beneficio está en un pedido o ya se entregó. Resuelve el pedido antes de excluir al cliente.' using errcode = '55000';
    end if;
    perform public.crm_remove_published_play_member_v1(request_row.play_id,request_row.client_id,
      'No aplica #' || request_row.id || ': ' || left(review_reason,450));
  end if;
  update public.crm_play_no_apply_requests set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by_user_id = auth.uid(),reviewed_at = now(),review_note = review_reason where id = p_request_id;
  insert into public.crm_play_member_events(play_member_id,event_type,from_status,to_status,note,actor_user_id,created_at)
  values (member_row.id,'note',member_row.workflow_status,case when p_approve then 'removed' else member_row.workflow_status end,
    'No aplica #' || request_row.id || case when p_approve then ' aprobado: ' else ' rechazado: ' end || review_reason,auth.uid(),now());
  return jsonb_build_object('request_id',p_request_id,'client_id',member_row.client_id,'play_id',member_row.play_id);
end;
$$;
revoke all on function public.crm_request_play_no_apply_v1(bigint,text,text) from public,anon;
revoke all on function public.crm_review_play_no_apply_v1(bigint,boolean,text) from public,anon;
grant execute on function public.crm_request_play_no_apply_v1(bigint,text,text) to authenticated;
grant execute on function public.crm_review_play_no_apply_v1(bigint,boolean,text) to authenticated;
revoke all on function app_private.crm_no_apply_history_guard_v1() from public,anon,authenticated;
revoke all on function app_private.crm_no_apply_legacy_guard_v1() from public,anon,authenticated;
comment on table public.crm_play_no_apply_requests is 'No aplica: immutable justified requests; only administrator approval removes an evaluable play member.';
notify pgrst, 'reload schema';
