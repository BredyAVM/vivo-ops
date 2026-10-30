-- Read history through a bounded, explicitly authorized command. Direct table
-- SELECT would also publish its name in the authenticated GraphQL schema.
revoke all on app_private.client_commercial_type_history_v1 from public,anon,authenticated,service_role;

create function app_private.read_client_commercial_type_history_v1(p_client_id bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare result jsonb;
begin
  if auth.uid() is null or not public.is_master_or_admin()
     or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.is_active) then
    raise exception 'El historial requiere Master o Administración activos.' using errcode='42501';
  end if;
  if p_client_id is null or p_client_id<=0 then
    raise exception 'Cliente inválido.' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(h)order by h.id desc),'[]'::jsonb) into result
  from (
    select log.id,log.previous_type,log.new_type,log.recorded_at,
      actor.full_name as actor_name,previous_advisor.full_name as previous_advisor_name,
      new_advisor.full_name as new_advisor_name
    from app_private.client_commercial_type_history_v1 log
    left join public.profiles actor on actor.id=log.actor_id
    left join public.profiles previous_advisor on previous_advisor.id=log.previous_advisor_id
    left join public.profiles new_advisor on new_advisor.id=log.new_advisor_id
    where log.client_id=p_client_id order by log.id desc limit 50
  )h;
  return result;
end;
$f$;
revoke all on function app_private.read_client_commercial_type_history_v1(bigint)from public,anon,authenticated,service_role;
grant execute on function app_private.read_client_commercial_type_history_v1(bigint)to authenticated;

create function public.read_client_commercial_type_history_v1(p_client_id bigint)
returns jsonb language sql stable security invoker set search_path='' as $f$
  select app_private.read_client_commercial_type_history_v1(p_client_id);
$f$;
revoke all on function public.read_client_commercial_type_history_v1(bigint)from public,anon,authenticated,service_role;
grant execute on function public.read_client_commercial_type_history_v1(bigint)to authenticated;
