begin;
create or replace function public.counter_read_pending_settlements(
  p_cursor_dispatched_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  with matched as materialized (
    select
      ds.*,
      o.order_number,
      o.fulfillment::text as fulfillment,
      c.full_name as client_name,
      c.phone as client_phone,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'expected_collection'
      ), 0) as expected_collection_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'customer_collection'
      ), 0) as customer_collection_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'cash_change_out'
      ), 0) as cash_change_out_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'cash_change_returned'
      ), 0) as cash_change_returned_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'cash_return'
      ), 0) as cash_return_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'digital_change_due'
      ), 0) as digital_change_due_usd,
      coalesce(sum(dse.amount_usd_equivalent) filter (
        where dse.entry_type = 'digital_change_completed'
      ), 0) as digital_change_completed_usd
    from public.delivery_settlements ds
    join public.orders o on o.id = ds.order_id
    left join public.clients c on c.id = o.client_id
    left join public.delivery_settlement_entries dse on dse.settlement_id = ds.id
    where ds.status in ('open', 'partial', 'discrepancy')
      and (
        p_cursor_dispatched_at is null
        or p_cursor_id is null
        or (ds.dispatched_at, ds.id) < (p_cursor_dispatched_at, p_cursor_id)
      )
    group by ds.id, o.id, c.id
    order by ds.dispatched_at desc, ds.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from matched
    order by dispatched_at desc, id desc
    limit v_limit
  )
  select jsonb_build_object(
    'results',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'orderId', p.order_id,
            'displayNumber', lpad(p.order_id::text, 2, '0'),
            'orderNumber', p.order_number,
            'status', p.status,
            'fulfillment', p.fulfillment,
            'clientName', coalesce(nullif(trim(p.client_name), ''), 'Cliente'),
            'clientPhone', p.client_phone,
            'responsibleName', p.responsible_name,
            'dispatchedAt', p.dispatched_at,
            'expectedCollectionUsd', round(p.expected_collection_usd::numeric, 2),
            'customerCollectionUsd', round(p.customer_collection_usd::numeric, 2),
            'cashChangeOutstandingUsd',
              round(greatest(0, p.cash_change_out_usd - p.cash_change_returned_usd)::numeric, 2),
            'cashReturnedUsd', round(p.cash_return_usd::numeric, 2),
            'digitalChangeOutstandingUsd',
              round(greatest(0, p.digital_change_due_usd - p.digital_change_completed_usd)::numeric, 2),
            'version', p.version
          )
          order by p.dispatched_at desc, p.id desc
        )
        from page p
      ), '[]'::jsonb),
    'nextCursor',
      case
        when (select count(*) from matched) > v_limit then (
          select jsonb_build_object('dispatchedAt', p.dispatched_at, 'id', p.id)
          from page p
          order by p.dispatched_at asc, p.id asc
          limit 1
        )
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

revoke all on function public.counter_read_pending_settlements(timestamptz, bigint, integer) from public;
revoke all on function public.counter_read_pending_settlements(timestamptz, bigint, integer) from anon;
grant execute on function public.counter_read_pending_settlements(timestamptz, bigint, integer) to authenticated;
grant execute on function public.counter_read_pending_settlements(timestamptz, bigint, integer) to service_role;

commit;
