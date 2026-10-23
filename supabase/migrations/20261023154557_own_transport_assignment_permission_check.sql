begin;
set local lock_timeout='5s';

-- Custody is intentionally RPC-only (Counter block 6). Payment items are
-- Admin-only under RLS. Assignment needs only a yes/no conflict check, not
-- table access or financial details for the caller.
create function app_private.own_transport_has_obligations_v1(p_order_id bigint)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or public.is_master_or_admin() is not true then
    raise exception 'Solo Máster o Administración pueden comprobar esta asignación.' using errcode='42501';
  end if;
  if not exists(select 1 from public.orders where id=p_order_id
    and fulfillment::text='delivery' and status::text in ('confirmed','in_kitchen','ready')) then
    raise exception 'Orden no disponible para asignar transporte propio.' using errcode='55000';
  end if;
  return exists(select 1 from public.delivery_settlements where order_id=p_order_id)
    or exists(select 1 from public.delivery_service_payment_items where order_id=p_order_id);
end;
$$;
revoke all on function app_private.own_transport_has_obligations_v1(bigint) from public,anon,authenticated,service_role;
grant execute on function app_private.own_transport_has_obligations_v1(bigint) to authenticated;

-- Preserve the public command's invoker/RLS semantics and every write.
do $$
declare
  v_definition text:=pg_get_functiondef('public.assign_own_transport_v1(bigint,text,text,text,uuid)'::regprocedure);
  v_old text:='if exists(select 1 from public.delivery_settlements where order_id=p_order_id)
    or exists(select 1 from public.delivery_service_payment_items where order_id=p_order_id) then';
begin
  if position(v_old in v_definition)=0 then
    raise exception 'Unexpected installed own transport assignment routine';
  end if;
  execute replace(v_definition,v_old,'if app_private.own_transport_has_obligations_v1(p_order_id) then');
end;
$$;
commit;
