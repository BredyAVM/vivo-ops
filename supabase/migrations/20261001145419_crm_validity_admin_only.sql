-- Authorizing exceptions is exclusively an administrator responsibility.
-- Version synchronized with the managed migration service.
-- Master retains its existing read access, never authorization authority.
do $patch$
declare v_source text; v_old text;
begin
  select pg_get_functiondef('public.crm_authorize_order_validity_v1(uuid,bigint,bigint,text,date,text)'::regprocedure) into v_source;
  v_old := 'auth.uid() is null or not public.is_master_or_admin()';
  if strpos(v_source,v_old) = 0 then raise exception 'CRM validity authorization changed; review migration'; end if;
  execute replace(replace(v_source,v_old,'auth.uid() is null or public.is_admin() is not true'),
    'Solo master o administrador pueden autorizar esta excepción.',
    'Solo el administrador puede autorizar esta excepción.');

  select pg_get_functiondef('public.crm_read_order_validity_v1(bigint)'::regprocedure) into v_source;
  v_old := 'return app_private.crm_order_validity_state_v1(p_order_id);';
  if strpos(v_source,v_old) = 0 then raise exception 'CRM validity reader changed; review migration'; end if;
  execute replace(v_source,v_old,$new$return (
    select coalesce(jsonb_agg(value || jsonb_build_object(
      'authorizationRoleAllowed', public.is_admin() is true,
      'canAuthorize', coalesce((value->>'canAuthorize')::boolean,false) and public.is_admin() is true
    ) order by (value->>'memberId')::bigint),'[]'::jsonb)
    from jsonb_array_elements(app_private.crm_order_validity_state_v1(p_order_id))
  );$new$);

  select pg_get_functiondef('app_private.crm_assert_order_validity_v1(bigint)'::regprocedure) into v_source;
  if strpos(v_source,'a master o administrador') = 0 then raise exception 'CRM validity message changed; review migration'; end if;
  execute replace(v_source,'a master o administrador','al administrador');
end;
$patch$;
