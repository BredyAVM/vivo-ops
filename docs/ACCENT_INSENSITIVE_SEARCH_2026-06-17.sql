-- Accent-insensitive client search for master/advisor modules.
-- Run in Supabase SQL editor.

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create or replace function public.search_normalize(input text)
returns text
language sql
immutable
parallel safe
set search_path = public, extensions
as $$
  select regexp_replace(
    lower(unaccent(coalesce(input, ''))),
    '\s+',
    ' ',
    'g'
  );
$$;

create index if not exists clients_full_name_search_norm_trgm_idx
on public.clients using gin (public.search_normalize(full_name) extensions.gin_trgm_ops);

create index if not exists clients_billing_company_search_norm_trgm_idx
on public.clients using gin (public.search_normalize(billing_company_name) extensions.gin_trgm_ops);

create index if not exists clients_delivery_note_name_search_norm_trgm_idx
on public.clients using gin (public.search_normalize(delivery_note_name) extensions.gin_trgm_ops);

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
      public.search_normalize(p_query) as q,
      regexp_replace(coalesce(p_query, ''), '\D', '', 'g') as digits,
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
          regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || n.digits || '%'
          or regexp_replace(coalesce(c.billing_phone, ''), '\D', '', 'g') like '%' || n.digits || '%'
          or regexp_replace(coalesce(c.delivery_note_phone, ''), '\D', '', 'g') like '%' || n.digits || '%'
        )
      )
    )
  order by
    case
      when public.search_normalize(c.full_name) = n.q then 0
      when public.search_normalize(c.full_name) like n.q || '%' then 1
      when public.search_normalize(c.full_name) like '%' || n.q || '%' then 2
      else 3
    end,
    c.updated_at desc nulls last,
    c.id desc
  limit (select result_limit from normalized);
$$;

grant execute on function public.search_normalize(text) to authenticated;
grant execute on function public.search_clients_unaccent(text, integer) to authenticated;
