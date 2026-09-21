-- Preserve explicit international country codes in the search-only normalizer.
-- National Venezuelan inputs still share one key with +58 inputs.
create or replace function public.search_phone_digits(p_value text)
returns text language sql immutable parallel safe security invoker
set search_path = ''
as $$
  with cleaned as (
    select pg_catalog.regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') as value,
      pg_catalog.btrim(coalesce(p_value, '')) as raw
  )
  select case
    when raw like '00%' then substr(value, 3)
    when raw like '+%' then value
    when length(value) = 11 and value like '0%' then '58' || substr(value, 2)
    when length(value) = 10 then '58' || value
    else value end
  from cleaned;
$$;
-- Refresh expression indexes because their immutable search expression changed.
reindex index public.clients_phone_search_digits_idx;
reindex index public.orders_receiver_phone_search_digits_idx;
