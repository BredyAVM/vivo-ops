-- Counter Block 8 operational rollback.
-- Restores the Block 3 search contract and removes Block 8-only indexes/helper.
-- The extra timestamp/receiver keys in counter_read_order_detail are additive and
-- intentionally remain because older clients ignore them safely.

begin;

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
    select order_row.*, client.full_name as client_name, client.phone as client_phone
    from public.orders order_row
    left join public.clients client on client.id = order_row.client_id
    where (
      p_cursor_created_at is null
      or p_cursor_id is null
      or (order_row.created_at, order_row.id) < (p_cursor_created_at, p_cursor_id)
    )
      and (
        order_row.order_number ilike '%' || v_query || '%'
        or public.search_normalize(client.full_name)
          like '%' || public.search_normalize(v_query) || '%'
        or client.phone ilike '%' || v_query || '%'
        or (
          v_digits <> ''
          and (
            order_row.id = case
              when length(v_digits) <= 18 then v_digits::bigint
              else null
            end
            or regexp_replace(coalesce(client.phone, ''), '[^0-9]', '', 'g')
              like '%' || v_digits || '%'
          )
        )
      )
    order by order_row.created_at desc, order_row.id desc
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
            'id', page.id,
            'displayNumber', lpad(page.id::text, 2, '0'),
            'orderNumber', page.order_number,
            'status', page.status::text,
            'fulfillment', page.fulfillment::text,
            'clientName', coalesce(nullif(trim(page.client_name), ''), 'Cliente'),
            'clientPhone', page.client_phone,
            'scheduledDate', page.extra_fields->'schedule'->>'date',
            'scheduledTime',
              case
                when coalesce((page.extra_fields->'schedule'->>'asap')::boolean, false)
                  then 'Lo antes posible'
                else coalesce(
                  page.extra_fields->'schedule'->>'time_12',
                  page.extra_fields->'schedule'->>'time_24'
                )
              end,
            'totalUsd',
              round(coalesce(
                nullif(page.extra_fields->'pricing'->>'total_usd', '')::numeric,
                page.total_usd,
                0
              ), 2),
            'totalBs',
              round(coalesce(
                nullif(page.extra_fields->'pricing'->>'total_bs', '')::numeric,
                page.total_bs_snapshot,
                0
              ), 2),
            'note', page.notes,
            'createdAt', page.created_at
          )
          order by page.created_at desc, page.id desc
        )
        from page
      ), '[]'::jsonb),
    'nextCursor',
      case
        when (select count(*) from matched) > v_limit then (
          select jsonb_build_object('createdAt', page.created_at, 'id', page.id)
          from page
          order by page.created_at asc, page.id asc
          limit 1
        )
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

drop index if exists public.clients_counter_phone_digits_trgm_idx;
drop index if exists public.orders_receiver_name_search_norm_trgm_idx;
drop index if exists public.orders_receiver_phone_digits_trgm_idx;

drop function if exists public.counter_phone_digits(text);

revoke all on function public.counter_search_orders(text, timestamptz, bigint, integer)
  from public, anon;
grant execute on function public.counter_search_orders(text, timestamptz, bigint, integer)
  to authenticated, service_role;

commit;
