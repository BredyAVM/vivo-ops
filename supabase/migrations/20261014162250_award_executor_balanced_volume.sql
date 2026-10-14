-- Additive, versioned evidence summary. Published inputs/results and financial flows are untouched.
create or replace function app_private.award_executor_summarize_v3(p_execution jsonb)
returns jsonb language sql immutable set search_path='' as $$
  with members as materialized (
    select x->>'advisor_id' as advisor_id,(x->>'play_id')::bigint as play_id,
      (x->>'client_id')::bigint as client_id,
      coalesce((x->>'excluded')::boolean,false) as excluded,
      coalesce((x->>'direct_contact')::boolean,false)
        or coalesce((x->>'direct_response')::boolean,false)
        or coalesce((x->>'direct_proposal')::boolean,false)
        or coalesce((x->>'delivered')::boolean,false) as contact,
      coalesce((x->>'direct_response')::boolean,false)
        or coalesce((x->>'delivered')::boolean,false) as response,
      coalesce((x->>'direct_proposal')::boolean,false)
        or coalesce((x->>'delivered')::boolean,false) as proposal,
      coalesce((x->>'delivered')::boolean,false) as delivered
    from jsonb_array_elements(p_execution->'evidence') x
  ), counts as (
    select advisor_id,play_id,count(*) filter(where not excluded) as assigned,
      count(*) filter(where not excluded and contact) as contact,
      count(*) filter(where not excluded and response) as response,
      count(*) filter(where not excluded and proposal) as proposal,
      count(*) filter(where not excluded and delivered) as delivered
    from members group by advisor_id,play_id
  ), volume as (
    select advisor_id,count(distinct client_id) filter(where not excluded and proposal) as proposal_clients,
      count(distinct client_id) filter(where not excluded and delivered) as delivered_clients
    from members group by advisor_id
  )
  select p_execution || jsonb_build_object('metrics_version','executor-summary-v3',
    'balanced_counts',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('advisor_name',
      (select r->>'advisor_name' from jsonb_array_elements(p_execution->'counts') r
        where r->>'advisor_id'=c.advisor_id and (r->>'play_id')::bigint=c.play_id limit 1)) order by c.advisor_id,c.play_id) from counts c),'[]'::jsonb),
    'balanced_volume',coalesce((select jsonb_agg(v order by advisor_id) from volume v),'[]'::jsonb));
$$;
revoke all on function app_private.award_executor_summarize_v3(jsonb) from public,anon,authenticated;

create or replace function app_private.award_executor_capture_v3(p_month date,p_full boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo el administrador.' using errcode='42501'; end if;
  v_result:=app_private.award_executor_summarize_v3(app_private.award_executor_capture_v2(p_month,true));
  return case when p_full then v_result else v_result-'evidence' end;
end; $$;
revoke all on function app_private.award_executor_capture_v3(date,boolean) from public,anon,authenticated;

create or replace function public.admin_award_evaluation_preview_v3(p_month date,p_advisor uuid default null,p_category text default null,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_facts jsonb; v_execution jsonb;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo el administrador.' using errcode='42501'; end if;
  if p_offset is null or p_offset<0 or p_offset>100000
    or (p_advisor is null)<>(p_category is null)
    or (p_category is not null and p_category not in ('executor','alchemist','influential','strategic')) then raise exception 'Detalle inválido.'; end if;
  if p_category='executor' then
    v_facts:=app_private.award_facts_capture_v2(p_month);
    v_execution:=app_private.award_executor_capture_v3(p_month,true);
    v_facts:=v_facts||jsonb_build_object('evidence_total',(select count(*) from jsonb_array_elements(v_execution->'evidence') x where x->>'advisor_id'=p_advisor::text),
      'executor_evidence',coalesce((select jsonb_agg(x) from(select x from jsonb_array_elements(v_execution->'evidence') x where x->>'advisor_id'=p_advisor::text order by x->>'client_name',x->>'member_id' limit 50 offset p_offset) q),'[]'::jsonb));
  else
    v_facts:=app_private.award_facts_capture_v2(p_month,p_advisor,p_category,p_offset,false);
    v_execution:=app_private.award_executor_capture_v3(p_month,false);
  end if;
  return v_facts||jsonb_build_object('execution',v_execution-'evidence');
end; $$;
revoke all on function public.admin_award_evaluation_preview_v3(date,uuid,text,integer) from public,anon;
grant execute on function public.admin_award_evaluation_preview_v3(date,uuid,text,integer) to authenticated;

-- Preserve the current prepare command's guards; fail closed if its expected definition changed.
do $$
declare v_definition text; v_anchor text;
begin
  v_definition:=pg_get_functiondef('public.admin_award_prepare_v2(date,jsonb,uuid)'::regprocedure);
  v_anchor:='  if p_month=date ''2026-09-01''';
  if strpos(v_definition,v_anchor)=0 or strpos(v_definition,'app_private.award_executor_capture_v2(p_month,true)')=0 then
    raise exception 'La función de cierre cambió; revisa la migración antes de aplicarla.';
  end if;
  v_definition:=replace(v_definition,v_anchor,$guard$
  if p_rules ? 'executorFormula' and (jsonb_typeof(p_rules->'executorFormula') is distinct from 'string'
    or p_rules->>'executorFormula' not in ('legacy-v1','balanced-volume-v1')) then raise exception 'Fórmula de Ejecutor inválida.'; end if;
  if p_rules ? 'executorEvidenceMode' and (jsonb_typeof(p_rules->'executorEvidenceMode') is distinct from 'string'
    or p_rules->>'executorEvidenceMode' not in ('recorded','supported')) then raise exception 'Base de registros inválida.'; end if;
  if p_rules ? 'executorDeliveryVolumeSharePct' and (jsonb_typeof(p_rules->'executorDeliveryVolumeSharePct') is distinct from 'number'
    or (p_rules->>'executorDeliveryVolumeSharePct')::numeric not between 1 and 50) then raise exception 'Peso de volumen de entrega inválido.'; end if;
  if exists(select 1 from jsonb_each(p_rules) r where r.key in ('executorDeliveryVolumeReference','executorProposalVolumeReference')
    and (jsonb_typeof(r.value) is distinct from 'number' or r.value::text!~'^[0-9]+$'
      or r.value::text::numeric not between 1 and 1000)) then raise exception 'Referencia gradual inválida.'; end if;
$guard$||v_anchor);
  execute replace(v_definition,'app_private.award_executor_capture_v2(p_month,true)','app_private.award_executor_capture_v3(p_month,true)');
end; $$;
notify pgrst,'reload schema';
