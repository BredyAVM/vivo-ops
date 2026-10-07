-- Finish the October correction with a materialized worklist and a zero-conflict
-- postcondition. Re-running this correction is safe and does not rebuild cohorts.
set lock_timeout = '5s';
set statement_timeout = '30s';

do $correct_october$
declare candidate record; actor uuid; old_claims text; old_sub text; pending_ids bigint[]; member_id bigint;
  reason text := 'Descanso mensual autorizado: recibió una propuesta de jugada en septiembre. Excluir de las jugadas de octubre, aunque no canjeó el obsequio.';
begin
  old_claims := coalesce(current_setting('request.jwt.claims',true),'');
  old_sub := coalesce(current_setting('request.jwt.claim.sub',true),'');
  -- Materialize identities before changing parent summaries; a live joined
  -- FOR UPDATE cursor can skip rows whose parent was updated in the same batch.
  select coalesce(array_agg(m.id order by p.id,m.id),'{}'::bigint[]) into pending_ids
  from public.crm_play_members m join public.crm_plays p on p.id=m.play_id
  where p.starts_at >= '2026-10-01T04:00:00Z' and p.starts_at < '2026-11-01T04:00:00Z'
    and p.status in ('draft','frozen','active','paused') and m.workflow_status<>'removed'
    and app_private.crm_had_previous_month_offer_v1(m.client_id,p.starts_at);
  foreach member_id in array pending_ids
  loop
    select m.*,p.status as play_status,p.created_by_user_id as play_creator into strict candidate
    from public.crm_play_members m join public.crm_plays p on p.id=m.play_id
    where m.id=member_id for update of m,p;
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
  if exists (
    select 1 from public.crm_play_members m join public.crm_plays p on p.id=m.play_id
    where p.starts_at >= '2026-10-01T04:00:00Z' and p.starts_at < '2026-11-01T04:00:00Z'
      and p.status in ('draft','frozen','active','paused') and m.workflow_status<>'removed'
      and app_private.crm_had_previous_month_offer_v1(m.client_id,p.starts_at)
  ) then raise exception 'La revisión final todavía detecta propuestas del mes anterior'; end if;
  perform set_config('request.jwt.claims',old_claims,true);
  perform set_config('request.jwt.claim.sub',old_sub,true);
  perform set_config('app.crm_play_amendment_context','',true);
end;
$correct_october$;
