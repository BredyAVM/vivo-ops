-- Additive commercial identity. No historical client/order/payment is rewritten.
alter table public.clients drop constraint clients_client_type_check;
alter table public.clients add constraint clients_client_type_check
  check (client_type in ('own','assigned','direct','legacy') or client_type is null);

alter table public.orders add column sales_channel text
  check (sales_channel in ('in_person','whatsapp','advisor'));
comment on column public.orders.sales_channel is
  'Observed intake channel at creation. Independent of source, brand, fulfillment and advisor ownership. NULL is unrecorded history.';
create index orders_sales_channel_created_idx on public.orders(sales_channel,created_at,id)
  where sales_channel is not null;

create function app_private.guard_order_sales_channel_v1()
returns trigger language plpgsql security invoker set search_path = '' as $f$
begin
  if tg_op = 'UPDATE' then
    if new.sales_channel is distinct from old.sales_channel then
      raise exception 'El canal registrado del pedido no se cambia al editar la orden.' using errcode='22023';
    end if;
    return new;
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.profiles p where p.id=(select auth.uid()) and p.is_active
  ) then
    raise exception 'Usuario inactivo.' using errcode='42501';
  end if;
  new.sales_channel := coalesce(new.sales_channel,
    case when new.source::text='walk_in' then 'in_person' else 'advisor' end);
  if new.sales_channel not in ('in_person','whatsapp','advisor') then
    raise exception 'Selecciona Presencial, WhatsApp o Asesor.' using errcode='22023';
  end if;
  if new.sales_channel in ('in_person','whatsapp') and auth.uid() is not null
     and not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'La venta directa requiere permisos de Counter, Master o Administración.' using errcode='42501';
  end if;
  -- This metadata never changes source, approval, payment or commission terms.
  return new;
end;
$f$;
revoke all on function app_private.guard_order_sales_channel_v1() from public,anon,authenticated,service_role;
create trigger orders_commercial_channel_v1 before insert or update of sales_channel
  on public.orders for each row execute function app_private.guard_order_sales_channel_v1();

create table app_private.client_commercial_type_history_v1 (
  id bigint generated always as identity primary key,
  client_id bigint not null references public.clients(id),
  actor_id uuid references public.profiles(id),
  previous_type text,
  new_type text,
  previous_advisor_id uuid,
  new_advisor_id uuid,
  recorded_at timestamptz not null default now()
);
create index client_commercial_type_history_client_idx
  on app_private.client_commercial_type_history_v1(client_id,id);
alter table app_private.client_commercial_type_history_v1 enable row level security;
revoke all on app_private.client_commercial_type_history_v1 from public,anon,authenticated,service_role;
grant select on app_private.client_commercial_type_history_v1 to authenticated;
create policy client_commercial_type_history_staff_read on app_private.client_commercial_type_history_v1
  for select to authenticated using (
    (select auth.uid()) is not null and (select public.is_master_or_admin())
    and exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.is_active)
  );

-- Only transitions involving the new Direct category are changed. Existing
-- own/assigned/legacy classifications and assignment rules retain their meaning.
create function app_private.guard_direct_client_classification_v1()
returns trigger language plpgsql security invoker set search_path = '' as $f$
begin
  if auth.uid() is not null and not exists (
    select 1 from public.profiles p where p.id=(select auth.uid()) and p.is_active
  ) then
    raise exception 'Usuario inactivo.' using errcode='42501';
  end if;
  if tg_op='UPDATE' and (old.client_type='direct' or new.client_type='direct')
     and (new.client_type is distinct from old.client_type
       or new.primary_advisor_id is distinct from old.primary_advisor_id)
     and auth.uid() is not null and not public.is_master_or_admin() then
    raise exception 'La clasificación y asignación del cliente directo requieren Master o Administración.' using errcode='42501';
  end if;
  if new.client_type='direct' and new.primary_advisor_id is not null then
    new.client_type := 'assigned';
  end if;
  return new;
end;
$f$;
revoke all on function app_private.guard_direct_client_classification_v1() from public,anon,authenticated,service_role;
create trigger clients_commercial_direct_guard_v1 before insert or update of client_type,primary_advisor_id
  on public.clients for each row execute function app_private.guard_direct_client_classification_v1();

-- Private trigger writer: application roles cannot forge or delete history.
create function app_private.record_direct_client_classification_v1()
returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  if tg_op='INSERT' then
    if new.client_type='direct' then
      insert into app_private.client_commercial_type_history_v1
        (client_id,actor_id,new_type,new_advisor_id)
      values(new.id,auth.uid(),new.client_type,new.primary_advisor_id);
    end if;
  elsif (old.client_type='direct' or new.client_type='direct')
     and (new.client_type is distinct from old.client_type
       or new.primary_advisor_id is distinct from old.primary_advisor_id) then
    insert into app_private.client_commercial_type_history_v1
      (client_id,actor_id,previous_type,new_type,previous_advisor_id,new_advisor_id)
    values(new.id,auth.uid(),old.client_type,new.client_type,old.primary_advisor_id,new.primary_advisor_id);
  end if;
  return new;
end;
$f$;
revoke all on function app_private.record_direct_client_classification_v1() from public,anon,authenticated,service_role;
create trigger clients_commercial_direct_history_v1 after insert or update of client_type,primary_advisor_id
  on public.clients for each row execute function app_private.record_direct_client_classification_v1();

-- Keep the existing command, idempotency receipt, commercial suspension check,
-- atomic stock validation and payment integration. Patch only the intake data.
do $patch$
declare body text; original text;
begin
  original:=replace(pg_get_functiondef('public.counter_create_direct_sale_without_commercial_guard_v1(uuid,jsonb)'::regprocedure),E'\r\n',E'\n');
  body:=replace(original,
    'v_client_type := coalesce(nullif(trim(p_payload->>''clientType''), ''''), ''own'');',
    E'v_client_type := ''direct'';\n  if coalesce(nullif(trim(p_payload->>''salesChannel''), ''''), ''in_person'') not in (''in_person'',''whatsapp'') then\n    raise exception ''Selecciona Presencial o WhatsApp para una venta de Counter.'' using errcode=''22023'';\n  end if;');
  if body=original then raise exception 'Counter intake assignment anchor changed'; end if;
  original:=body;
  body:=replace(body, 'v_client_type not in (''own'', ''assigned'', ''legacy'')',
    'v_client_type not in (''own'', ''assigned'', ''direct'', ''legacy'')');
  if body=original then raise exception 'Counter client validation anchor changed'; end if;
  original:=body;
  body:=replace(body,E'    source,\n    fulfillment,',E'    source,\n    sales_channel,\n    fulfillment,');
  if body=original then raise exception 'Counter order column anchor changed'; end if;
  original:=body;
  body:=replace(body,E'    ''walk_in'',\n    v_fulfillment,',
    E'    ''walk_in'',\n    coalesce(nullif(trim(p_payload->>''salesChannel''), ''''), ''in_person''),\n    v_fulfillment,');
  if body=original then raise exception 'Counter order value anchor changed'; end if;
  execute body;

  original:=replace(pg_get_functiondef('app_private.rescue_orphan_client_from_live_order_v1()'::regprocedure),E'\r\n',E'\n');
  body:=replace(original,'and client.primary_advisor_id is null',
    E'and client.primary_advisor_id is null\n    and client.client_type is distinct from ''direct''');
  if body=original then raise exception 'Advisor rescue anchor changed'; end if;
  execute body;
end;
$patch$;
