-- Búsqueda del módulo Máster: número de orden, cliente y dirección.
-- El orden de prioridad se calcula en la base de datos para que funcione igual
-- con órdenes antiguas que no están cargadas en el día abierto en pantalla.
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
  advisor_name text
)
language sql
stable
security invoker
set search_path to 'public'
as $function$
  with normalized as (
    select
      public.search_normalize(coalesce(p_query, '')) as q,
      greatest(1, least(coalesce(p_limit, 10), 20)) as result_limit
  )
  select
    o.id,
    o.order_number,
    o.status::text,
    o.fulfillment::text,
    o.total_usd,
    o.total_bs_snapshot,
    o.created_at,
    o.extra_fields,
    c.full_name as client_name,
    c.phone as client_phone,
    a.full_name as advisor_name
  from public.orders o
  left join public.clients c on c.id = o.client_id
  left join public.profiles a on a.id = o.attributed_advisor_id
  cross join normalized n
  where length(n.q) >= 2
    and (
      o.id::text like n.q || '%'
      or public.search_normalize(coalesce(o.order_number, '')) like '%' || n.q || '%'
      or public.search_normalize(coalesce(c.full_name, '')) like '%' || n.q || '%'
      or public.search_normalize(coalesce(o.delivery_address, '')) like '%' || n.q || '%'
    )
  order by
    case
      when o.id::text = n.q then 0
      when public.search_normalize(coalesce(o.order_number, '')) = n.q then 1
      when o.id::text like n.q || '%' then 2
      when public.search_normalize(coalesce(o.order_number, '')) like n.q || '%' then 3
      when public.search_normalize(coalesce(c.full_name, '')) = n.q then 4
      when public.search_normalize(coalesce(c.full_name, '')) like n.q || '%' then 5
      when public.search_normalize(coalesce(o.order_number, '')) like '%' || n.q || '%' then 6
      when public.search_normalize(coalesce(c.full_name, '')) like '%' || n.q || '%' then 7
      else 8
    end,
    o.id desc
  limit (select result_limit from normalized);
$function$;
