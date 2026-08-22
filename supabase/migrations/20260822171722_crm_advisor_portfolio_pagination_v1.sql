-- Server-paginated CRM portfolio for the authenticated advisor.
--
-- Returning one JSON document avoids the Data API row cap while keeping the
-- full-portfolio summary exact. Only the requested client page leaves the
-- database, so large advisor portfolios remain light on mobile devices.

create or replace function public.crm_my_client_portfolio_page_v1(
  p_purchase_window integer default 6,
  p_search text default null,
  p_segment text default 'all',
  p_sort text default 'attention',
  p_page integer default 1,
  p_page_size integer default 40,
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
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
$$;

revoke all on function public.crm_my_client_portfolio_page_v1(
  integer, text, text, text, integer, integer, timestamptz
) from public, anon, authenticated;

grant execute on function public.crm_my_client_portfolio_page_v1(
  integer, text, text, text, integer, integer, timestamptz
) to authenticated, service_role;

comment on function public.crm_my_client_portfolio_page_v1(
  integer, text, text, text, integer, integer, timestamptz
) is
  'Exact full-portfolio summary plus a server-filtered client page for the authenticated advisor.';
