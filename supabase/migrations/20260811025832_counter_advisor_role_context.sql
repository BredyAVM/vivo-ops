-- Counter client context must only present active users who really hold
-- the advisor role. Historical order attribution can also contain Master
-- or Counter users, so it is not sufficient by itself.

begin;

create or replace function public.counter_search_clients(
  p_query text,
  p_cursor_id bigint default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_query text := trim(coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  if length(v_query) < 2 then
    return jsonb_build_object('results', '[]'::jsonb, 'nextCursorId', null);
  end if;

  with matched as materialized (
    select client.*
    from public.clients client
    where client.is_active = true
      and (p_cursor_id is null or client.id < p_cursor_id)
      and (
        public.search_normalize(client.full_name)
          like '%' || public.search_normalize(v_query) || '%'
        or client.phone ilike '%' || v_query || '%'
        or (
          regexp_replace(v_query, '[^0-9]', '', 'g') <> ''
          and regexp_replace(coalesce(client.phone, ''), '[^0-9]', '', 'g')
              like '%' || regexp_replace(v_query, '[^0-9]', '', 'g') || '%'
        )
      )
    order by client.id desc
    limit v_limit + 1
  ),
  page as materialized (
    select matched.*
    from matched
    order by matched.id desc
    limit v_limit
  ),
  page_with_advisor as materialized (
    select
      page.*,
      coalesce(primary_profile.id, recent_order.attributed_advisor_id) as advisor_user_id,
      coalesce(primary_profile.full_name, recent_profile.full_name) as advisor_name,
      case
        when primary_profile.id is not null then 'primary'
        when recent_order.attributed_advisor_id is not null then 'last_order'
        else 'none'
      end as advisor_source,
      coalesce(primary_profile.is_active, recent_profile.is_active) as advisor_is_active,
      recent_order.created_at as advisor_last_order_at
    from page
    left join public.profiles primary_profile
      on primary_profile.id = page.primary_advisor_id
     and primary_profile.is_active = true
     and exists (
       select 1
       from public.user_roles primary_role
       where primary_role.user_id = primary_profile.id
         and primary_role.role = 'advisor'
     )
    left join lateral (
      select
        order_row.attributed_advisor_id,
        order_row.created_at
      from public.orders order_row
      join public.profiles advisor_profile
        on advisor_profile.id = order_row.attributed_advisor_id
       and advisor_profile.is_active = true
      where order_row.client_id = page.id
        and exists (
          select 1
          from public.user_roles advisor_role
          where advisor_role.user_id = order_row.attributed_advisor_id
            and advisor_role.role = 'advisor'
        )
      order by order_row.created_at desc, order_row.id desc
      limit 1
    ) recent_order on primary_profile.id is null
    left join public.profiles recent_profile
      on recent_profile.id = recent_order.attributed_advisor_id
  )
  select jsonb_build_object(
    'results',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', result.id,
            'fullName', coalesce(nullif(trim(result.full_name), ''), 'Cliente'),
            'phone', result.phone,
            'clientType', result.client_type,
            'fundBalanceUsd', coalesce(result.fund_balance_usd, 0),
            'advisorUserId', result.advisor_user_id,
            'advisorName', result.advisor_name,
            'advisorSource', result.advisor_source,
            'advisorIsActive', result.advisor_is_active,
            'advisorLastOrderAt', result.advisor_last_order_at
          )
          order by result.id desc
        )
        from page_with_advisor result
      ), '[]'::jsonb),
    'nextCursorId',
      case
        when (select count(*) from matched) > v_limit
          then (select min(result.id) from page result)
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

comment on function public.counter_search_clients(text, bigint, integer)
is 'Busqueda paginada Counter con asesor primario o ultimo asesor activo, validado por rol real.';

revoke all on function public.counter_search_clients(text, bigint, integer)
  from public, anon;
grant execute on function public.counter_search_clients(text, bigint, integer)
  to authenticated, service_role;

commit;
