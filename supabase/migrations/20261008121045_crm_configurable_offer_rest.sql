-- Campaign-specific exclusion of clients who received a CRM proposal.
-- Preserve existing monthly behavior when no explicit configuration exists.
set lock_timeout='5s';
set statement_timeout='30s';

create function app_private.crm_offer_rest_bounds_v1(p_rules jsonb,p_starts_at timestamptz)
returns table(from_at timestamptz,to_at timestamptz)
language plpgsql stable rows 1 set search_path='' as $function$
declare
  mode text := coalesce(p_rules->>'offer_rest_mode','previous_month');
  days_text text;
  day_count integer;
  first_day date;
  last_day date;
begin
  if mode='none' then return; end if;
  if mode='previous_month' then
    if p_starts_at is null then return; end if;
    from_at := (date_trunc('month',p_starts_at at time zone 'America/Caracas')-interval '1 month') at time zone 'America/Caracas';
    to_at := date_trunc('month',p_starts_at at time zone 'America/Caracas') at time zone 'America/Caracas';
  elsif mode='days' then
    days_text := coalesce(p_rules->>'offer_rest_days','');
    if days_text !~ '^[0-9]{1,4}$' then
      raise exception 'Indica una cantidad entera de días para el descanso entre propuestas.' using errcode='22023';
    end if;
    day_count := days_text::integer;
    if day_count<1 or day_count>3650 or p_starts_at is null then
      raise exception 'El descanso debe ser de 1 a 3650 días y requiere una fecha inicial de la jugada.' using errcode='22023';
    end if;
    to_at := date_trunc('day',p_starts_at at time zone 'America/Caracas') at time zone 'America/Caracas';
    from_at := (date_trunc('day',p_starts_at at time zone 'America/Caracas')-make_interval(days=>day_count)) at time zone 'America/Caracas';
  elsif mode='dates' then
    if coalesce(p_rules->>'offer_rest_from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or coalesce(p_rules->>'offer_rest_to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Selecciona las fechas desde y hasta para excluir propuestas.' using errcode='22023';
    end if;
    first_day := (p_rules->>'offer_rest_from')::date;
    last_day := (p_rules->>'offer_rest_to')::date;
    if last_day<first_day then
      raise exception 'La fecha hasta no puede ser anterior a la fecha desde del descanso.' using errcode='22023';
    end if;
    from_at := first_day::timestamp at time zone 'America/Caracas';
    to_at := (last_day+1)::timestamp at time zone 'America/Caracas';
  else
    raise exception 'Selecciona un tipo válido de descanso entre propuestas.' using errcode='22023';
  end if;
  return next;
end;
$function$;
revoke all on function app_private.crm_offer_rest_bounds_v1(jsonb,timestamptz)
from public,anon,authenticated,service_role;

create function app_private.crm_had_excluded_offer_v1(p_client_id bigint,p_starts_at timestamptz,p_rules jsonb)
returns boolean language sql stable set search_path='' as $function$
  select exists (
    select 1 from app_private.crm_offer_rest_bounds_v1(p_rules,p_starts_at) offer_window
    join public.crm_play_members previous_member on previous_member.client_id=p_client_id
      and previous_member.play_launched_at is not null
      and previous_member.play_launched_at>=offer_window.from_at
      and previous_member.play_launched_at<offer_window.to_at
  );
$function$;
revoke all on function app_private.crm_had_excluded_offer_v1(bigint,timestamptz,jsonb)
from public,anon,authenticated,service_role;

-- Validate explicit configuration even for an empty preview, and reject API
-- clients that bypass the administrator form. Existing RLS/auth is unchanged.
create function app_private.crm_offer_rest_settings_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  perform 1 from app_private.crm_offer_rest_bounds_v1(new.rules_snapshot,new.starts_at);
  return new;
end;
$function$;
revoke all on function app_private.crm_offer_rest_settings_guard_v1()
from public,anon,authenticated,service_role;
create trigger crm_offer_rest_settings_guard before insert or update of rules_snapshot,starts_at on public.crm_plays
for each row execute function app_private.crm_offer_rest_settings_guard_v1();

do $patch$
declare definition text; anchor text; target text;
begin
  foreach target in array array[
    'public.crm_rebuild_play_members_v1(bigint)',
    'public.crm_confirm_play_v1(bigint)',
    'public.crm_add_manual_play_member_v1(bigint,bigint,uuid,text)',
    'app_private.crm_play_monthly_rest_guard_v1()'
  ] loop
    definition := pg_get_functiondef(target::regprocedure);
    if target like '%crm_rebuild%' then
      anchor := 'app_private.crm_had_previous_month_offer_v1(metric.client_id,play_row.starts_at)';
      definition := replace(definition,anchor,'app_private.crm_had_excluded_offer_v1(metric.client_id,play_row.starts_at,play_row.rules_snapshot)');
    elsif target like '%crm_confirm%' then
      anchor := 'app_private.crm_had_previous_month_offer_v1(member_row.client_id,play_row.starts_at)';
      definition := replace(definition,anchor,'app_private.crm_had_excluded_offer_v1(member_row.client_id,play_row.starts_at,play_row.rules_snapshot)');
    elsif target like '%crm_add_manual%' then
      anchor := 'app_private.crm_had_previous_month_offer_v1(p_client_id,play_row.starts_at)';
      definition := replace(definition,anchor,'app_private.crm_had_excluded_offer_v1(p_client_id,play_row.starts_at,play_row.rules_snapshot)');
    else
      anchor := 'app_private.crm_had_previous_month_offer_v1(member_row.client_id,new.starts_at)';
      definition := replace(definition,anchor,'app_private.crm_had_excluded_offer_v1(member_row.client_id,new.starts_at,new.rules_snapshot)');
    end if;
    if position(anchor in pg_get_functiondef(target::regprocedure))=0 then
      raise exception 'Configurable offer rest patch anchor missing: %',target;
    end if;
    definition := replace(definition,'recibieron una propuesta de jugada el mes anterior','recibieron una propuesta de jugada durante el período de descanso seleccionado');
    definition := replace(definition,'recibió una propuesta de jugada el mes anterior','recibió una propuesta de jugada durante el período de descanso seleccionado');
    definition := replace(definition,'descansar este mes','respetar el período de descanso seleccionado');
    definition := replace(definition,'con una jugada lanzada el mes anterior','con una jugada lanzada durante el período de descanso seleccionado');
    execute definition;
  end loop;

  -- Advance a calendar exclusion together with "Preparar siguiente mes".
  -- A regular copy retains its exact dates; rolling days stay rolling days.
  target := 'public.crm_clone_play_v3(bigint,text,integer)';
  definition := pg_get_functiondef(target::regprocedure);
  anchor := '      ends_at = case';
  if position(anchor in definition)=0 then raise exception 'Clone rest patch anchor missing'; end if;
  definition := replace(definition,anchor,$clone$
      rules_snapshot = case when source_play.rules_snapshot->>'offer_rest_mode'='dates' then
        source_play.rules_snapshot || jsonb_build_object(
          'offer_rest_from',to_char((source_play.rules_snapshot->>'offer_rest_from')::date+make_interval(months=>p_shift_months),'YYYY-MM-DD'),
          'offer_rest_to',to_char(case
            when (source_play.rules_snapshot->>'offer_rest_to')::date = (date_trunc('month',(source_play.rules_snapshot->>'offer_rest_to')::date)+interval '1 month'-interval '1 day')::date
              then date_trunc('month',(source_play.rules_snapshot->>'offer_rest_to')::date+make_interval(months=>p_shift_months))+interval '1 month'-interval '1 day'
            else (source_play.rules_snapshot->>'offer_rest_to')::date+make_interval(months=>p_shift_months)
          end,'YYYY-MM-DD')
        )
      else play.rules_snapshot end,
      ends_at = case$clone$);
  execute definition;
end;
$patch$;
-- No cohorts, campaign statuses, prices, redemptions or history are rewritten.
