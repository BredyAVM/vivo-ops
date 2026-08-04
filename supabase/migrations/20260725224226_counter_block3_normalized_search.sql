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
    select c.*
    from public.clients c
    where c.is_active = true
      and (p_cursor_id is null or c.id < p_cursor_id)
      and (
        public.search_normalize(c.full_name)
          like '%' || public.search_normalize(v_query) || '%'
        or c.phone ilike '%' || v_query || '%'
        or (
          regexp_replace(v_query, '[^0-9]', '', 'g') <> ''
          and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
              like '%' || regexp_replace(v_query, '[^0-9]', '', 'g') || '%'
        )
      )
    order by c.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from matched
    order by id desc
    limit v_limit
  )
  select jsonb_build_object(
    'results',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'fullName', coalesce(nullif(trim(p.full_name), ''), 'Cliente'),
            'phone', p.phone,
            'clientType', p.client_type,
            'fundBalanceUsd', coalesce(p.fund_balance_usd, 0)
          )
          order by p.id desc
        )
        from page p
      ), '[]'::jsonb),
    'nextCursorId',
      case
        when (select count(*) from matched) > v_limit
          then (select min(p.id) from page p)
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

create or replace function public.counter_search_orders(
  p_query text,
  p_cursor_created_at timestamptz default null,
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
  v_digits text := regexp_replace(trim(coalesce(p_query, '')), '[^0-9]', '', 'g');
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
    return jsonb_build_object('results', '[]'::jsonb, 'nextCursor', null);
  end if;

  with matched as materialized (
    select o.*, c.full_name as client_name, c.phone as client_phone
    from public.orders o
    left join public.clients c on c.id = o.client_id
    where (
      p_cursor_created_at is null
      or p_cursor_id is null
      or (o.created_at, o.id) < (p_cursor_created_at, p_cursor_id)
    )
      and (
        o.order_number ilike '%' || v_query || '%'
        or public.search_normalize(c.full_name)
          like '%' || public.search_normalize(v_query) || '%'
        or c.phone ilike '%' || v_query || '%'
        or (
          v_digits <> ''
          and (
            o.id = case when length(v_digits) <= 18 then v_digits::bigint else null end
            or regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%'
          )
        )
      )
    order by o.created_at desc, o.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from matched
    order by created_at desc, id desc
    limit v_limit
  )
  select jsonb_build_object(
    'results',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'displayNumber', lpad(p.id::text, 2, '0'),
            'orderNumber', p.order_number,
            'status', p.status::text,
            'fulfillment', p.fulfillment::text,
            'clientName', coalesce(nullif(trim(p.client_name), ''), 'Cliente'),
            'clientPhone', p.client_phone,
            'scheduledDate', p.extra_fields->'schedule'->>'date',
            'scheduledTime',
              case
                when coalesce((p.extra_fields->'schedule'->>'asap')::boolean, false) then 'Lo antes posible'
                else coalesce(
                  p.extra_fields->'schedule'->>'time_12',
                  p.extra_fields->'schedule'->>'time_24'
                )
              end,
            'totalUsd',
              round(coalesce(
                nullif(p.extra_fields->'pricing'->>'total_usd', '')::numeric,
                p.total_usd,
                0
              ), 2),
            'totalBs',
              round(coalesce(
                nullif(p.extra_fields->'pricing'->>'total_bs', '')::numeric,
                p.total_bs_snapshot,
                0
              ), 2),
            'note', p.notes,
            'createdAt', p.created_at
          )
          order by p.created_at desc, p.id desc
        )
        from page p
      ), '[]'::jsonb),
    'nextCursor',
      case
        when (select count(*) from matched) > v_limit then (
          select jsonb_build_object('createdAt', p.created_at, 'id', p.id)
          from page p
          order by p.created_at asc, p.id asc
          limit 1
        )
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

commit;
