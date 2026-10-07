set lock_timeout = '5s';
set statement_timeout = '30s';

-- A greeting, a response or mere list membership is not an offer. Keep removed
-- and closed campaign evidence: removing someone must not erase a real launch.
create index if not exists crm_members_client_launch_time_idx
  on public.crm_play_members(client_id,play_launched_at)
  where play_launched_at is not null;

create function app_private.crm_had_previous_month_offer_v1(
  p_client_id bigint,p_starts_at timestamptz
) returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.crm_play_members previous_member
    where previous_member.client_id = p_client_id
      and previous_member.play_launched_at >=
        ((date_trunc('month',p_starts_at at time zone 'America/Caracas') - interval '1 month') at time zone 'America/Caracas')
      and previous_member.play_launched_at <
        (date_trunc('month',p_starts_at at time zone 'America/Caracas') at time zone 'America/Caracas')
  );
$$;
revoke all on function app_private.crm_had_previous_month_offer_v1(bigint,timestamptz)
  from public,anon,authenticated,service_role;

-- Defense at confirmation/publication, including direct authenticated updates.
-- Do not rewrite historic closed snapshots or delivered benefits.
create function app_private.crm_play_monthly_rest_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status in ('frozen','active')
    and exists (
      select 1 from public.crm_play_members member_row
      where member_row.play_id = new.id and member_row.workflow_status <> 'removed'
        and app_private.crm_had_previous_month_offer_v1(member_row.client_id,new.starts_at)
    ) then
    raise exception 'La lista incluye clientes con una jugada lanzada el mes anterior. Revísala antes de confirmar o compartir.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.crm_play_monthly_rest_guard_v1()
  from public,anon,authenticated,service_role;
create trigger crm_play_monthly_rest_guard before update on public.crm_plays
  for each row execute function app_private.crm_play_monthly_rest_guard_v1();

-- Patch only reviewed anchors; preserve authorization and all other filters.
do $patch$
declare original text; revised text; anchor text;
begin
  original := pg_get_functiondef('public.crm_rebuild_play_members_v1(bigint)'::regprocedure);
  anchor := '    and metric.purchase_count >= minimum_purchases';
  revised := replace(original,anchor,
    '    and not app_private.crm_had_previous_month_offer_v1(metric.client_id,play_row.starts_at)' || E'\n' || anchor);
  if revised=original then raise exception 'CRM preview filter anchor changed'; end if;
  execute revised;

  original := pg_get_functiondef('public.crm_confirm_play_v1(bigint)'::regprocedure);
  anchor := '  active_rate := public.get_active_exchange_rate();';
  revised := replace(original,anchor,$confirm$
  if exists (
    select 1 from public.crm_play_members member_row
    where member_row.play_id=p_play_id and member_row.workflow_status<>'removed'
      and app_private.crm_had_previous_month_offer_v1(member_row.client_id,play_row.starts_at)
  ) then
    raise exception 'Hay clientes con una jugada lanzada el mes anterior. Vuelve a probar la lista antes de confirmar.' using errcode='40001';
  end if;
$confirm$ || anchor);
  if revised=original then raise exception 'CRM confirmation anchor changed'; end if;
  execute revised;

  original := pg_get_functiondef('public.crm_add_manual_play_member_v1(bigint,bigint,uuid,text)'::regprocedure);
  anchor := '  advisor_id := coalesce(p_advisor_id, client_row.primary_advisor_id);';
  revised := replace(original,anchor,$manual$
  if app_private.crm_had_previous_month_offer_v1(p_client_id,play_row.starts_at) then
    raise exception 'Este cliente recibió una propuesta de jugada el mes anterior y debe descansar este mes.' using errcode='23514';
  end if;
$manual$ || anchor);
  if revised=original then raise exception 'CRM manual inclusion anchor changed'; end if;
  execute revised;
end;
$patch$;

-- Authorized correction of October lists only. Do not regenerate cohorts,
-- reactivate drafts, change finances, or silently remove an in-flight benefit.
do $correct_october$
declare candidate record; actor uuid; old_claims text; old_sub text;
  reason text := 'Descanso mensual autorizado: recibió una propuesta de jugada en septiembre. Excluir de las jugadas de octubre, aunque no canjeó el obsequio.';
begin
  old_claims := coalesce(current_setting('request.jwt.claims',true),'');
  old_sub := coalesce(current_setting('request.jwt.claim.sub',true),'');
  for candidate in
    select m.*,p.status as play_status,p.created_by_user_id as play_creator
    from public.crm_play_members m join public.crm_plays p on p.id=m.play_id
    where p.starts_at >= '2026-10-01T04:00:00Z' and p.starts_at < '2026-11-01T04:00:00Z'
      and p.status in ('draft','frozen','active','paused') and m.workflow_status<>'removed'
      and app_private.crm_had_previous_month_offer_v1(m.client_id,p.starts_at)
    order by p.id,m.id
    for update of m,p
  loop
    if candidate.play_launched_at is not null or exists (
      select 1 from public.crm_play_redemptions r where r.play_member_id=candidate.id and r.status in ('reserved','redeemed')
    ) then
      raise exception 'El cliente % de la jugada % ya tiene una oferta o beneficio en curso. Revisar sin borrar su historial.',candidate.client_id,candidate.play_id;
    end if;
    actor := candidate.play_creator;
    if not exists(select 1 from public.user_roles where user_id=actor and role='admin') then
      raise exception 'La corrección de octubre requiere autoría de un administrador';
    end if;
    perform set_config('request.jwt.claim.sub',actor::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
    if candidate.play_status='draft' then
      if exists(select 1 from public.crm_play_member_events e where e.play_member_id=candidate.id) then
        raise exception 'No se puede quitar un candidato con seguimiento de un borrador';
      end if;
      insert into public.crm_play_amendments
        (play_id,amendment_type,client_id,advisor_id_snapshot,previous_values,new_values,reason,created_by_user_id)
      values (candidate.play_id,'member_removed',candidate.client_id,candidate.advisor_id_snapshot,
        jsonb_build_object('workflow_status',candidate.workflow_status,'benefit_status',candidate.benefit_status),
        jsonb_build_object('excluded_from_draft',true,'exclusion','previous_month_offer'),reason,actor);
      delete from public.crm_play_members where id=candidate.id;
      perform public.crm_refresh_play_preview_summary_v1(candidate.play_id);
    else
      perform public.crm_remove_published_play_member_v1(candidate.play_id,candidate.client_id,reason);
    end if;
  end loop;
  perform set_config('request.jwt.claims',old_claims,true);
  perform set_config('request.jwt.claim.sub',old_sub,true);
  perform set_config('app.crm_play_amendment_context','',true);
end;
$correct_october$;
