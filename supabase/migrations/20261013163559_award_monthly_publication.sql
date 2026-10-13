create table public.award_month_reports (
  id uuid primary key default gen_random_uuid(),
  period date not null check(period=date_trunc('month',period)::date),
  request_token uuid not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  rule_version text not null check(rule_version='awards-v2'),
  rules_snapshot jsonb not null,
  input_snapshot jsonb not null,
  result_snapshot jsonb,
  status text not null default 'draft' check(status in('draft','review','published','superseded')),
  published_by uuid references public.profiles(id),
  published_at timestamptz,
  publication_reason text,
  supersedes_id uuid references public.award_month_reports(id),
  unique(created_by,request_token)
);
create unique index award_month_one_publication on public.award_month_reports(period) where status='published';
create index award_month_period_created on public.award_month_reports(period,created_at desc);
create index award_month_publisher on public.award_month_reports(published_by) where published_by is not null;
create index award_month_supersedes on public.award_month_reports(supersedes_id) where supersedes_id is not null;
create table public.award_month_events (
  id bigint generated always as identity primary key,
  report_id uuid not null references public.award_month_reports(id),
  actor_id uuid not null references public.profiles(id),
  event_type text not null check(event_type in('prepared','calculated','published','superseded')),
  reason text not null,
  created_at timestamptz not null default now(),
  unique(report_id,event_type)
);
create index award_month_event_actor on public.award_month_events(actor_id);
alter table public.award_month_reports enable row level security;
alter table public.award_month_events enable row level security;
create policy award_month_admin_read on public.award_month_reports for select to authenticated using((select public.is_admin()));
create policy award_month_events_admin_read on public.award_month_events for select to authenticated using((select public.is_admin()));
revoke all on public.award_month_reports,public.award_month_events from public,anon,authenticated;
grant select on public.award_month_reports,public.award_month_events to authenticated;

create function app_private.award_month_guard_v2() returns trigger language plpgsql set search_path='' as $$
declare v_actor uuid:=coalesce(nullif(current_setting('app.award_actor',true),'')::uuid,auth.uid());
begin
  if tg_op='DELETE' then raise exception 'El historial de evaluación es inmutable.'; end if;
  if v_actor is null or not exists(select 1 from public.user_roles where user_id=v_actor and role::text='admin') or coalesce(current_setting('app.award_command',true),'')<>tg_table_name then
    raise exception 'Usa el comando administrativo de evaluación.' using errcode='42501';
  end if;
  if tg_table_name='award_month_events' and tg_op<>'INSERT' then raise exception 'El historial es inmutable.'; end if;
  if tg_table_name='award_month_reports' and tg_op='UPDATE' then
    if (to_jsonb(new)-'status'-'result_snapshot'-'published_by'-'published_at'-'publication_reason'-'supersedes_id')
      is distinct from (to_jsonb(old)-'status'-'result_snapshot'-'published_by'-'published_at'-'publication_reason'-'supersedes_id') then
      raise exception 'El corte y las reglas son inmutables.';
    end if;
    if old.result_snapshot is not null and new.result_snapshot is distinct from old.result_snapshot then raise exception 'Los resultados son inmutables.'; end if;
    if not (old.status='draft' and new.status='review' or old.status='review' and new.status='published' or old.status='published' and new.status='superseded') then
      raise exception 'Transición de evaluación inválida.';
    end if;
  end if;
  return new;
end; $$;
revoke all on function app_private.award_month_guard_v2() from public,anon,authenticated;
create trigger award_month_reports_guard before insert or update or delete on public.award_month_reports for each row execute function app_private.award_month_guard_v2();
create trigger award_month_events_guard before insert or update or delete on public.award_month_events for each row execute function app_private.award_month_guard_v2();

create function public.admin_award_prepare_v2(p_month date,p_rules jsonb,p_token uuid)
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
  if p_month=date '2026-09-01' and (p_rules->>'executorEnabled')::boolean then raise exception 'Septiembre no tiene premio Ejecutor por fallas de registro.'; end if;
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
  insert into public.award_month_events(report_id,actor_id,event_type,reason) values(v_id,auth.uid(),'prepared','Corte de datos y reglas para revisión; sin emitir premios.');
  return v_id;
end; $$;

create function public.admin_award_calculate_v2(p_report uuid,p_results jsonb,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_report public.award_month_reports%rowtype;
begin
  if p_actor is null or not exists(select 1 from public.user_roles where user_id=p_actor and role::text='admin') then raise exception 'Solo el administrador validado por el servidor.' using errcode='42501'; end if;
  perform set_config('app.award_actor',p_actor::text,true);
  select * into v_report from public.award_month_reports where id=p_report for update;
  if v_report.id is null then raise exception 'La revisión no existe.'; end if;
  if v_report.result_snapshot is not null then
    if v_report.result_snapshot=p_results then return v_report.id; end if;
    raise exception 'La revisión ya tiene otro cálculo.';
  end if;
  -- Backend-only EXECUTE: browser-authenticated users, even admins, cannot submit scores.
  if p_results is null or p_results->>'ruleVersion' is distinct from 'awards-v2'
    or jsonb_typeof(p_results->'advisors') is distinct from 'array'
    or jsonb_array_length(p_results->'advisors')=0
    or (select count(*) from jsonb_array_elements(p_results->'advisors'))<>(select count(*) from jsonb_array_elements(v_report.input_snapshot->'strategic_metrics'))
    or exists(select 1 from jsonb_array_elements(p_results->'advisors') a where not exists(
      select 1 from jsonb_array_elements(v_report.input_snapshot->'strategic_metrics') m where m->>'advisor_id'=a->>'id')
      or jsonb_typeof(a->'categories') is distinct from 'object' or not (a->'categories') ?& array['alchemist','influential','strategic','executor']
      or jsonb_typeof(a->'total') is distinct from 'number'
      or (a->>'total')::numeric not between 0 and 100 or jsonb_typeof(a->'qualified') is distinct from 'boolean')
    or (select count(distinct a->>'id') from jsonb_array_elements(p_results->'advisors') a)<>jsonb_array_length(p_results->'advisors') then
    raise exception 'Cálculo incompleto o incompatible.';
  end if;
  perform set_config('app.award_command','award_month_reports',true);
  update public.award_month_reports set result_snapshot=p_results,status='review' where id=p_report;
  perform set_config('app.award_command','award_month_events',true);
  insert into public.award_month_events(report_id,actor_id,event_type,reason) values(p_report,p_actor,'calculated','Motor awards-v2: revisión calculada sobre el corte guardado.');
  return p_report;
end; $$;

create function public.admin_award_publish_v2(p_report uuid,p_expected_published uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_report public.award_month_reports%rowtype; v_current uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo el administrador.' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,''))) not between 10 and 500 then raise exception 'Justifica el cierre o la corrección.'; end if;
  select * into v_report from public.award_month_reports where id=p_report;
  if v_report.id is null then raise exception 'La revisión no existe.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('award-publication:'||v_report.period::text,0));
  select * into v_report from public.award_month_reports where id=p_report for update;
  if v_report.status='published' and v_report.publication_reason=trim(p_reason) then return p_report; end if;
  if v_report.status<>'review' or v_report.result_snapshot is null then raise exception 'Revisa el corte calculado antes de publicar.'; end if;
  if (v_report.period+interval '1 month')::timestamp at time zone 'America/Caracas'>now() then raise exception 'El mes todavía está en curso; solo permite revisión.'; end if;
  select id into v_current from public.award_month_reports where period=v_report.period and status='published' for update;
  if v_current is distinct from p_expected_published then raise exception 'La publicación cambió; actualiza y revisa antes de corregir.'; end if;
  perform set_config('app.award_command','award_month_reports',true);
  if v_current is not null then update public.award_month_reports set status='superseded' where id=v_current; end if;
  update public.award_month_reports set status='published',published_by=auth.uid(),published_at=now(),publication_reason=trim(p_reason),supersedes_id=v_current where id=p_report;
  perform set_config('app.award_command','award_month_events',true);
  if v_current is not null then insert into public.award_month_events(report_id,actor_id,event_type,reason) values(v_current,auth.uid(),'superseded',trim(p_reason)); end if;
  insert into public.award_month_events(report_id,actor_id,event_type,reason) values(p_report,auth.uid(),'published',trim(p_reason));
  return p_report;
end; $$;

create function public.admin_award_report_view_v2(p_report uuid,p_advisor uuid default null,p_category text default null,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.award_month_reports%rowtype; v_evidence jsonb; v_page jsonb; v_count bigint;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Solo el administrador.' using errcode='42501'; end if;
  if p_offset is null or p_offset<0 or p_offset>100000 or p_category is not null and p_category not in('alchemist','influential','strategic','executor') then raise exception 'Detalle inválido.'; end if;
  select * into r from public.award_month_reports where id=p_report;
  if r.id is null then raise exception 'La revisión no existe.'; end if;
  v_evidence:=case when p_category='executor' then r.input_snapshot#>'{execution,evidence}' else r.input_snapshot->'evidence' end;
  select count(*) into v_count from jsonb_array_elements(coalesce(v_evidence,'[]'::jsonb)) e
    where e->>'advisor_id'=p_advisor::text and (p_category='executor' or e->>'category'=p_category);
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_page from(select e from jsonb_array_elements(coalesce(v_evidence,'[]'::jsonb)) e
    where e->>'advisor_id'=p_advisor::text and (p_category='executor' or e->>'category'=p_category)
    order by e->>'client_name',e->>'client_id',e->>'member_id' limit 50 offset p_offset)q;
  return jsonb_build_object('id',r.id,'period',r.period,'status',r.status,'created_at',r.created_at,'published_at',r.published_at,
    'publication_reason',r.publication_reason,'rules',r.rules_snapshot,'result',r.result_snapshot,
    'input',((r.input_snapshot-'evidence')||jsonb_build_object('execution',(r.input_snapshot->'execution')-'evidence','evidence_total',v_count,
      'evidence',case when p_category='executor' then '[]'::jsonb else v_page end,'executor_evidence',case when p_category='executor' then v_page else '[]'::jsonb end)));
end; $$;

create function public.advisor_award_month_view_v2(p_month date,p_category text default null,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.award_month_reports%rowtype; v_own jsonb; v_evidence jsonb; v_page jsonb; v_count bigint;
begin
  if auth.uid() is null or not (public.has_role('advisor') or public.is_admin()) then raise exception 'No autorizado.' using errcode='42501'; end if;
  if p_offset is null or p_offset<0 or p_offset>100000 or p_category is not null and p_category not in('alchemist','influential','strategic','executor') then raise exception 'Detalle inválido.'; end if;
  select * into r from public.award_month_reports where period=p_month and status='published';
  if r.id is null then return null; end if;
  select a into v_own from jsonb_array_elements(r.result_snapshot->'advisors') a where a->>'id'=auth.uid()::text;
  if v_own is null then return null; end if;
  v_evidence:=case when p_category='executor' then r.input_snapshot#>'{execution,evidence}' else r.input_snapshot->'evidence' end;
  select count(*) into v_count from jsonb_array_elements(coalesce(v_evidence,'[]'::jsonb)) e where e->>'advisor_id'=auth.uid()::text and (p_category='executor' or e->>'category'=p_category);
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_page from(select e from jsonb_array_elements(coalesce(v_evidence,'[]'::jsonb)) e
    where e->>'advisor_id'=auth.uid()::text and (p_category='executor' or e->>'category'=p_category) order by e->>'client_name',e->>'client_id',e->>'member_id' limit 15 offset p_offset)q;
  return jsonb_build_object('id',r.id,'period',r.period,'published_at',r.published_at,'rules',r.rules_snapshot,
    'own',v_own,'evidence',v_page,'evidence_total',v_count,'leaders',r.result_snapshot->'categoryLeaders',
    'board',(select jsonb_agg(jsonb_build_object('name',a->>'name','total',a->'total','qualified',a->'qualified')) from jsonb_array_elements(r.result_snapshot->'advisors') a));
end; $$;
revoke all on function public.admin_award_prepare_v2(date,jsonb,uuid),public.admin_award_calculate_v2(uuid,jsonb,uuid),public.admin_award_publish_v2(uuid,uuid,text),public.admin_award_report_view_v2(uuid,uuid,text,integer),public.advisor_award_month_view_v2(date,text,integer) from public,anon;
revoke all on function public.admin_award_calculate_v2(uuid,jsonb,uuid) from authenticated;
grant execute on function public.admin_award_calculate_v2(uuid,jsonb,uuid) to service_role;
grant execute on function public.admin_award_prepare_v2(date,jsonb,uuid),public.admin_award_publish_v2(uuid,uuid,text),public.admin_award_report_view_v2(uuid,uuid,text,integer),public.advisor_award_month_view_v2(date,text,integer) to authenticated;
comment on table public.award_month_reports is 'Immutable data/rules/results cuts, admin-only raw access; publication never issues a financial reward.';
notify pgrst,'reload schema';
