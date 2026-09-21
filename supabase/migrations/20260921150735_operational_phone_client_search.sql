-- Read-only search contract; no order, client, historical or financial data is changed.
-- Keep SECURITY INVOKER and existing row-level access restrictions.
create or replace function public.search_phone_digits(p_value text)
returns text language sql immutable parallel safe security invoker
set search_path = ''
as $$
  with cleaned as (
    select pg_catalog.regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') as value
  ), international as (
    select case when value like '00%' then substr(value, 3) else value end as value from cleaned
  )
  select case
    when length(value) = 11 and value like '0%' then '58' || substr(value, 2)
    when length(value) = 10 then '58' || value
    else value end
  from international;
$$;
revoke all on function public.search_phone_digits(text) from public, anon;
grant execute on function public.search_phone_digits(text) to authenticated, service_role;

create or replace function public.search_clients_unaccent(
  p_query text,
  p_limit integer default 20
)
returns setof public.clients
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with normalized as (
    select
      trim(public.search_normalize(p_query)) as q,
      public.search_phone_digits(p_query) as digits,
      greatest(1, least(coalesce(p_limit, 20), 120)) as result_limit
  )
  select c.*
  from public.clients c
  cross join normalized n
  where length(n.q) >= 2
    and (
      public.search_normalize(c.full_name) like '%' || n.q || '%'
      or public.search_normalize(c.billing_company_name) like '%' || n.q || '%'
      or public.search_normalize(c.billing_tax_id) like '%' || n.q || '%'
      or public.search_normalize(c.delivery_note_name) like '%' || n.q || '%'
      or coalesce(c.phone, '') ilike '%' || p_query || '%'
      or coalesce(c.billing_phone, '') ilike '%' || p_query || '%'
      or coalesce(c.delivery_note_phone, '') ilike '%' || p_query || '%'
      or (
        length(n.digits) >= 4
        and (
          public.search_phone_digits(c.phone) like '%' || n.digits || '%'
          or public.search_phone_digits(c.billing_phone) like '%' || n.digits || '%'
          or public.search_phone_digits(c.delivery_note_phone) like '%' || n.digits || '%'
        )
      )
    )
  order by
    case
      when length(n.digits) >= 4 and public.search_phone_digits(c.phone) = n.digits then -1
      when public.search_normalize(c.full_name) = n.q then 0
      when public.search_normalize(c.full_name) like n.q || '%' then 1
      when public.search_normalize(c.full_name) like '%' || n.q || '%' then 2
      else 3
    end,
    c.updated_at desc nulls last,
    c.id desc
  limit (select result_limit from normalized);
$$;


create or replace function public.search_master_orders(
  p_query text,
  p_limit integer default 10
)
returns table (
  id bigint,
  order_number text,
  status text,
  fulfillment text,
  total_usd numeric,
  total_bs_snapshot numeric,
  created_at timestamptz,
  extra_fields jsonb,
  client_name text,
  client_phone text,
  advisor_name text,
  match_priority integer
)
language sql
stable
security invoker
set search_path to 'public'
as $function$
  with normalized as (
    select
      trim(public.search_normalize(coalesce(p_query, ''))) as q,
      public.search_phone_digits(p_query) as digits,
      greatest(1, least(coalesce(p_limit, 10), 20)) as result_limit
  ),
  matches as (
    select
      o.id,
      o.order_number,
      o.status::text as status,
      o.fulfillment::text as fulfillment,
      o.total_usd,
      o.total_bs_snapshot,
      o.created_at,
      o.extra_fields,
      c.full_name as client_name,
      c.phone as client_phone,
      a.full_name as advisor_name,
      case
        when o.id::text = n.q then 0
        when public.search_normalize(coalesce(o.order_number, '')) = n.q then 1
        when o.id::text like n.q || '%' then 2
        when public.search_normalize(coalesce(o.order_number, '')) like n.q || '%' then 3
        when public.search_normalize(coalesce(c.full_name, '')) = n.q then 4
        when public.search_normalize(coalesce(c.full_name, '')) like n.q || '%' then 5
        when public.search_normalize(coalesce(o.order_number, '')) like '%' || n.q || '%' then 6
        when public.search_normalize(coalesce(c.full_name, '')) like '%' || n.q || '%' then 7
        when (length(n.digits) >= 4 and (
          public.search_phone_digits(c.phone) like '%' || n.digits || '%'
          or public.search_phone_digits(o.receiver_phone) like '%' || n.digits || '%'
        )) then 4
        else 8
      end as match_priority
    from public.orders o
    left join public.clients c on c.id = o.client_id
    left join public.profiles a on a.id = o.attributed_advisor_id
    cross join normalized n
    where (length(n.q) >= 2 or n.q ~ '^[0-9]+$')
      and (
        o.id::text like n.q || '%'
        or public.search_normalize(coalesce(o.order_number, '')) like '%' || n.q || '%'
        or public.search_normalize(coalesce(c.full_name, '')) like '%' || n.q || '%'
        or public.search_normalize(coalesce(o.delivery_address, '')) like '%' || n.q || '%'
        or (length(n.digits) >= 4 and (
          public.search_phone_digits(c.phone) like '%' || n.digits || '%'
          or public.search_phone_digits(o.receiver_phone) like '%' || n.digits || '%'
        ))
      )
  )
  select *
  from matches
  order by match_priority, id desc
  limit (select result_limit from normalized);
$function$;


revoke all on function public.search_master_orders(text, integer) from public, anon;
grant execute on function public.search_master_orders(text, integer) to authenticated, service_role;

create index if not exists clients_phone_search_digits_idx
  on public.clients using gin (public.search_phone_digits(phone) extensions.gin_trgm_ops);
create index if not exists orders_receiver_phone_search_digits_idx
  on public.orders using gin (public.search_phone_digits(receiver_phone) extensions.gin_trgm_ops);

-- The advisor portfolio keeps its canonical ownership/CRM scopes and pagination.
CREATE OR REPLACE FUNCTION public.crm_my_client_portfolio_page_v1(p_purchase_window integer DEFAULT 6, p_search text DEFAULT NULL::text, p_segment text DEFAULT 'all'::text, p_sort text DEFAULT 'attention'::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 40, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with parameters as materialized (
    select
      greatest(2, least(coalesce(p_purchase_window, 6), 50))::integer
        as purchase_window,
      coalesce(p_as_of, pg_catalog.now()) as as_of,
      pg_catalog.btrim(
        pg_catalog.translate(
          pg_catalog.lower(coalesce(p_search, '')),
          'áéíóúüñÁÉÍÓÚÜÑ',
          'aeiouunAEIOUUN'
        )
      ) as normalized_search,
      public.search_phone_digits(p_search) as phone_digits,
      case
        when p_segment in ('contact', 'overdue', 'new') then p_segment
        else 'all'
      end as segment,
      case
        when p_sort in ('recent', 'revenue', 'name') then p_sort
        else 'attention'
      end as sort_mode,
      greatest(1, coalesce(p_page, 1))::integer as requested_page,
      greatest(10, least(coalesce(p_page_size, 40), 100))::integer as page_size
  ),
  portfolio as materialized (
    select
      metric.*,
      (
        metric.last_purchase_on is null
        or metric.days_since_last_purchase >= 60
      ) as needs_contact,
      (
        metric.cadence_days is not null
        and metric.cadence_days > 0
        and metric.days_since_last_purchase is not null
        and metric.days_since_last_purchase > metric.cadence_days
      ) as outside_rhythm,
      (
        metric.first_purchase_on is not null
        and (
          (parameters.as_of at time zone 'America/Caracas')::date
          - metric.first_purchase_on
        ) between 0 and 30
      ) as is_new_client,
      pg_catalog.concat_ws(
        ' ',
        pg_catalog.translate(
          pg_catalog.lower(coalesce(metric.client_name, '')),
          'áéíóúüñÁÉÍÓÚÜÑ',
          'aeiouunAEIOUUN'
        ),
        pg_catalog.lower(coalesce(metric.phone, '')),
        pg_catalog.regexp_replace(coalesce(metric.phone, ''), '[^0-9]', '', 'g'),
        case
          when pg_catalog.regexp_replace(coalesce(metric.phone, ''), '[^0-9]', '', 'g') like '58%'
            then '0' || pg_catalog.substr(
              pg_catalog.regexp_replace(coalesce(metric.phone, ''), '[^0-9]', '', 'g')
              , 3
            )
          else null
        end
      ) as search_haystack
    from parameters
    cross join lateral crm_private.crm_my_client_portfolio_core_v1(
      parameters.purchase_window,
      parameters.as_of
    ) metric
  ),
  summary as materialized (
    select
      pg_catalog.count(*)::bigint as total_clients,
      pg_catalog.count(*) filter (where portfolio.needs_contact)::bigint
        as contact_count,
      pg_catalog.count(*) filter (where portfolio.outside_rhythm)::bigint
        as overdue_count,
      pg_catalog.count(*) filter (where portfolio.is_new_client)::bigint
        as new_count,
      coalesce(pg_catalog.round(pg_catalog.sum(portfolio.net_revenue_usd), 2), 0::numeric)
        as total_revenue_usd
    from portfolio
  ),
  filtered as materialized (
    select portfolio.*
    from portfolio
    cross join parameters
    where (
      parameters.segment = 'all'
      or (parameters.segment = 'contact' and portfolio.needs_contact)
      or (parameters.segment = 'overdue' and portfolio.outside_rhythm)
      or (parameters.segment = 'new' and portfolio.is_new_client)
    )
      and (
        parameters.normalized_search = ''
        or (length(parameters.phone_digits) >= 4
          and public.search_phone_digits(portfolio.phone) like '%' || parameters.phone_digits || '%')
        or not exists (
          select 1
          from pg_catalog.unnest(
            pg_catalog.regexp_split_to_array(parameters.normalized_search, '\s+')
          ) token(value)
          where token.value <> ''
            and portfolio.search_haystack not like '%' || token.value || '%'
        )
      )
  ),
  filtered_count as materialized (
    select pg_catalog.count(*)::bigint as value
    from filtered
  ),
  page_context as materialized (
    select
      parameters.page_size,
      filtered_count.value,
      greatest(
        1,
        pg_catalog.ceil(filtered_count.value::numeric / parameters.page_size)::integer
      ) as total_pages,
      least(
        parameters.requested_page,
        greatest(
          1,
          pg_catalog.ceil(filtered_count.value::numeric / parameters.page_size)::integer
        )
      ) as current_page
    from parameters
    cross join filtered_count
  ),
  ranked as materialized (
    select
      filtered.*,
      pg_catalog.row_number() over (
        order by
          case when parameters.sort_mode = 'name'
            then pg_catalog.lower(coalesce(filtered.client_name, '')) end asc nulls last,
          case when parameters.sort_mode = 'revenue'
            then filtered.net_revenue_usd end desc nulls last,
          case when parameters.sort_mode = 'recent'
            then filtered.last_purchase_on end desc nulls last,
          case when parameters.sort_mode = 'attention'
            then (filtered.last_purchase_on is null)::integer end desc nulls last,
          case when parameters.sort_mode = 'attention'
            then filtered.days_since_last_purchase end desc nulls last,
          case when parameters.sort_mode = 'attention'
            then filtered.net_revenue_usd end desc nulls last,
          filtered.client_id asc
      ) as result_position
    from filtered
    cross join parameters
  ),
  page_rows as materialized (
    select ranked.*
    from ranked
    cross join page_context
    where ranked.result_position
      between ((page_context.current_page - 1) * page_context.page_size) + 1
          and page_context.current_page * page_context.page_size
  )
  select pg_catalog.jsonb_build_object(
    'summary', pg_catalog.jsonb_build_object(
      'total_clients', summary.total_clients,
      'contact_count', summary.contact_count,
      'overdue_count', summary.overdue_count,
      'new_count', summary.new_count,
      'total_revenue_usd', summary.total_revenue_usd
    ),
    'pagination', pg_catalog.jsonb_build_object(
      'filtered_count', page_context.value,
      'current_page', page_context.current_page,
      'total_pages', page_context.total_pages,
      'page_size', page_context.page_size
    ),
    'rows', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(page_rows)
            - array[
              'needs_contact',
              'outside_rhythm',
              'is_new_client',
              'search_haystack',
              'result_position'
            ]::text[]
          order by page_rows.result_position
        )
        from page_rows
      ),
      '[]'::jsonb
    )
  )
  from summary
  cross join page_context;
$function$;
