-- Parameter correction only: keep old snapshots/results, publication commands and financial flows intact.
create or replace function public.admin_award_prepare_v2(p_month date,p_rules jsonb,p_token uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_existing public.award_month_reports%rowtype; v_input jsonb;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo el administrador.' using errcode='42501'; end if;
  if p_token is null or p_rules is null or jsonb_typeof(p_rules)<>'object'
    or coalesce(p_rules->>'globalMinimum','')!~'^[0-9]+([.][0-9]+)?$'
    or (p_rules->>'globalMinimum')::numeric not between 1 and 100
    or jsonb_typeof(p_rules->'executorEnabled') is distinct from 'boolean'
    or jsonb_typeof(p_rules->'deliveryTargets') is distinct from 'object'
    or length(coalesce(p_rules->>'executorReason',''))>500 then raise exception 'Confirma los parámetros de cierre.'; end if;
  if p_rules ? 'contactTargetPct' then
    if jsonb_typeof(p_rules->'contactTargetPct') is distinct from 'number'
      or (p_rules->>'contactTargetPct')::numeric not between 1 and 100 then raise exception 'Referencia de contacto inválida.'; end if;
  end if;
  if p_rules ? 'executorReviewNote' then
    if jsonb_typeof(p_rules->'executorReviewNote') is distinct from 'string'
      or length(p_rules->>'executorReviewNote')>500 then raise exception 'Observación de Ejecutor inválida.'; end if;
  end if;
  if p_month=date '2026-09-01' and (p_rules->>'executorEnabled')::boolean
    and length(trim(coalesce(p_rules->>'executorReviewNote','')))<10 then
    raise exception 'Septiembre requiere justificar la aceptación de las limitaciones del registro de Ejecutor.';
  end if;
  if not (p_rules->>'executorEnabled')::boolean and length(trim(coalesce(p_rules->>'executorReason','')))<10 then raise exception 'Justifica por qué Ejecutor no es evaluable.'; end if;
  if exists(select 1 from jsonb_each(p_rules->'deliveryTargets') t where t.key!~'^[1-9][0-9]*$' or jsonb_typeof(t.value)<>'number'
    or t.value::text::numeric<=0 or t.value::text::numeric>100) then raise exception 'Metas de entrega inválidas.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('award-prepare:'||auth.uid()::text||p_token::text,0));
  select * into v_existing from public.award_month_reports where created_by=auth.uid() and request_token=p_token;
  if v_existing.id is not null then
    if v_existing.period is distinct from p_month or v_existing.rules_snapshot is distinct from p_rules then raise exception 'Esta solicitud corresponde a otra revisión.'; end if;
    return v_existing.id;
  end if;
  v_input:=app_private.award_facts_capture_v2(p_month,null,null,0,true);
  v_input:=v_input||jsonb_build_object('execution',app_private.award_executor_capture_v2(p_month,true));
  if (p_rules->>'executorEnabled')::boolean and (jsonb_array_length(v_input#>'{execution,plays}')=0
    or exists(select 1 from jsonb_array_elements(v_input#>'{execution,plays}') p where not (p_rules->'deliveryTargets') ? (p->>'id'))) then
    raise exception 'Completa las metas de entrega de todas las campañas antes de guardar con Ejecutor incluido.';
  end if;
  perform set_config('app.award_command','award_month_reports',true);
  insert into public.award_month_reports(period,request_token,created_by,rule_version,rules_snapshot,input_snapshot)
  values(p_month,p_token,auth.uid(),'awards-v2',p_rules,v_input) returning id into v_id;
  perform set_config('app.award_command','award_month_events',true);
  insert into public.award_month_events(report_id,actor_id,event_type,reason)
    values(v_id,auth.uid(),'prepared','Corte de datos y reglas para revisión; sin emitir premios.' ||
      case when (p_rules->>'executorEnabled')::boolean and length(trim(coalesce(p_rules->>'executorReviewNote','')))>0
        then ' Ejecutor: '||trim(p_rules->>'executorReviewNote') else '' end);
  return v_id;
end; $$;
revoke all on function public.admin_award_prepare_v2(date,jsonb,uuid) from public,anon;
grant execute on function public.admin_award_prepare_v2(date,jsonb,uuid) to authenticated;
notify pgrst,'reload schema';
