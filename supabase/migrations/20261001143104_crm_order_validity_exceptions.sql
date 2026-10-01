-- Individual order exceptions. No campaign, order, reservation or price is rewritten.
-- Filename synchronized with the version assigned by the managed migration service.
create table app_private.crm_order_validity_exceptions (
  id uuid primary key,
  order_id bigint not null references public.orders(id),
  play_member_id bigint not null references public.crm_play_members(id),
  benefit_fingerprint text not null,
  authorized_through date not null check (isfinite(authorized_through)),
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default now()
);
create index crm_order_validity_exceptions_lookup on app_private.crm_order_validity_exceptions
  (order_id, play_member_id, benefit_fingerprint, approved_at desc);
alter table app_private.crm_order_validity_exceptions enable row level security;
revoke all on app_private.crm_order_validity_exceptions from public, anon, authenticated, service_role;

create or replace function app_private.crm_order_validity_state_v1(p_order_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with benefits as (
    select o.id, o.status::text order_status, o.client_id, o.attributed_advisor_id,
      nullif(o.extra_fields #>> '{schedule,date}', '')::date scheduled_on,
      m.id member_id, m.client_id member_client_id, m.advisor_id_snapshot,
      m.workflow_status, m.benefit_status, p.name, p.status play_status, p.starts_at, p.ends_at,
      md5(jsonb_build_array(o.client_id, o.attributed_advisor_id, m.id, p.starts_at, p.ends_at,
        jsonb_agg(jsonb_build_array(i.id,i.product_id,i.qty,i.crm_play_benefit_id,
          i.crm_play_benefit_upgrade_id) order by i.id))::text) fingerprint
    from public.orders o
    join public.order_items i on i.order_id = o.id
    join public.crm_play_members m on m.id = i.crm_play_member_id
    join public.crm_plays p on p.id = m.play_id
    where o.id = p_order_id
    group by o.id, o.status, o.client_id, o.attributed_advisor_id, o.extra_fields,
      m.id, m.client_id, m.advisor_id_snapshot, m.workflow_status, m.benefit_status,
      p.name, p.status, p.starts_at, p.ends_at
  ), rules as (
    select b.*, e.authorized_through, e.reason, e.approved_at, e.approved_by,
      (b.client_id = b.member_client_id and b.attributed_advisor_id = b.advisor_id_snapshot
        and b.workflow_status not in ('removed','not_applicable')
        and b.benefit_status in ('available','reserved','expired')
        and b.play_status in ('active','closed')
        and (b.starts_at is null or now() >= b.starts_at)
        and not exists (select 1 from public.crm_play_redemptions r
          where r.play_member_id = b.member_id and r.status in ('reserved','redeemed')
            and (r.order_id <> b.id or r.status = 'redeemed'))) as can_use,
      (b.play_status = 'active' and b.benefit_status in ('available','reserved')
        and (b.starts_at is null or coalesce(b.scheduled_on, (now() at time zone 'America/Caracas')::date)
          >= (b.starts_at at time zone 'America/Caracas')::date)
        and (b.ends_at is null or (now() < b.ends_at and
          coalesce(b.scheduled_on, (now() at time zone 'America/Caracas')::date)
            <= (b.ends_at at time zone 'America/Caracas')::date))) as ordinary_valid,
      (e.id is not null and (now() at time zone 'America/Caracas')::date <= e.authorized_through
        and coalesce(b.scheduled_on, (now() at time zone 'America/Caracas')::date) <= e.authorized_through
        and (b.starts_at is null or coalesce(b.scheduled_on, (now() at time zone 'America/Caracas')::date)
          >= (b.starts_at at time zone 'America/Caracas')::date)) as exception_valid
    from benefits b left join lateral (
      select x.* from app_private.crm_order_validity_exceptions x
      where x.order_id = b.id and x.play_member_id = b.member_id and x.benefit_fingerprint = b.fingerprint
      order by x.approved_at desc, x.id desc limit 1
    ) e on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'memberId',member_id,'playName',name,'playStatus',play_status,'scheduledOn',scheduled_on,
    'endsOn',(ends_at at time zone 'America/Caracas')::date,'fingerprint',fingerprint,
    'authorizedThrough',authorized_through,'reason',reason,'approvedAt',approved_at,
    'approvedBy',(select full_name from public.profiles where id = r.approved_by),
    'canAuthorize',coalesce(can_use and order_status not in ('delivered','cancelled'),false),
    'exceptionValid',coalesce(can_use and exception_valid,false),
    'eligible',coalesce(can_use and (ordinary_valid or exception_valid),false)
  ) order by member_id),'[]'::jsonb) from rules r;
$$;

create or replace function app_private.crm_order_has_validity_exception_v1(p_order_id bigint, p_member_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from jsonb_array_elements(app_private.crm_order_validity_state_v1(p_order_id)) r
    where (r->>'memberId')::bigint = p_member_id and (r->>'exceptionValid')::boolean);
$$;

create or replace function app_private.crm_assert_order_validity_v1(p_order_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text; v_rule jsonb;
begin
  select status::text into v_status from public.orders where id = p_order_id for update;
  if not found or v_status = 'cancelled' then return; end if;
  for v_rule in select value from jsonb_array_elements(app_private.crm_order_validity_state_v1(p_order_id)) loop
    if not (v_rule->>'eligible')::boolean then
      raise exception 'El beneficio de esta jugada («%») no está habilitado para esta fecha. Solicita una excepción de vigencia a master o administrador, cambia la fecha o retira el obsequio.', v_rule->>'playName'
        using errcode = '23514';
    end if;
  end loop;
end;
$$;

create or replace function public.crm_read_order_validity_v1(p_order_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not (public.is_master_or_admin() or public.has_role('counter')
    or exists (select 1 from public.orders where id = p_order_id and attributed_advisor_id = auth.uid())) then
    raise exception 'No tienes permiso para consultar esta orden.' using errcode = '42501';
  end if;
  return app_private.crm_order_validity_state_v1(p_order_id);
end;
$$;

create or replace function public.crm_authorize_order_validity_v1(
  p_request_id uuid, p_order_id bigint, p_member_id bigint, p_fingerprint text,
  p_authorized_through date, p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_rule jsonb; v_existing record;
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Solo master o administrador pueden autorizar esta excepción.' using errcode = '42501';
  end if;
  if p_request_id is null or p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then
    raise exception 'Explica el motivo de la excepción (entre 10 y 1000 caracteres).' using errcode = '22023';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.status::text in ('delivered','cancelled') then
    raise exception 'La excepción solo puede autorizarse antes de la entrega o cancelación.' using errcode = '55000';
  end if;
  select * into v_existing from app_private.crm_order_validity_exceptions where id = p_request_id;
  if found then
    if v_existing.order_id is distinct from p_order_id or v_existing.play_member_id is distinct from p_member_id
      or v_existing.benefit_fingerprint is distinct from p_fingerprint
      or v_existing.authorized_through is distinct from p_authorized_through
      or v_existing.reason is distinct from btrim(p_reason) or v_existing.approved_by is distinct from auth.uid() then
      raise exception 'La solicitud ya fue usada con otros datos.' using errcode = '22023';
    end if;
    return jsonb_build_object('id',v_existing.id,'authorized',true);
  end if;
  select value into v_rule from jsonb_array_elements(app_private.crm_order_validity_state_v1(p_order_id))
    where (value->>'memberId')::bigint = p_member_id;
  if v_rule is null or v_rule->>'fingerprint' is distinct from p_fingerprint then
    raise exception 'La orden cambió. Revisa sus condiciones antes de autorizar.' using errcode = '40001';
  end if;
  if not (v_rule->>'canAuthorize')::boolean then
    raise exception 'El cliente o el beneficio no admiten esta excepción; revisa su pertenencia y uso en otras órdenes.' using errcode = '55000';
  end if;
  if p_authorized_through is null or not isfinite(p_authorized_through)
    or p_authorized_through < (now() at time zone 'America/Caracas')::date
    or p_authorized_through < (v_rule->>'scheduledOn')::date
    or (v_rule->>'endsOn' is not null and p_authorized_through <= (v_rule->>'endsOn')::date) then
    raise exception 'Indica una fecha posterior al cierre que cubra hoy y la fecha programada.' using errcode = '22023';
  end if;
  insert into app_private.crm_order_validity_exceptions
    (id,order_id,play_member_id,benefit_fingerprint,authorized_through,reason,approved_by)
    values (p_request_id,p_order_id,p_member_id,p_fingerprint,p_authorized_through,btrim(p_reason),auth.uid());
  insert into public.order_timeline_events
    (order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values (p_order_id,v_order.order_number,'crm_validity_exception_approved','approval',
      'Excepción de vigencia de jugada autorizada',btrim(p_reason),'warning',auth.uid(),
      jsonb_build_object('exception_id',p_request_id,'play_member_id',p_member_id,
        'authorized_through',p_authorized_through,'original_ends_on',v_rule->>'endsOn'));
  return jsonb_build_object('id',p_request_id,'authorized',true);
end;
$$;

-- Validate final baskets/schedule before they advance, but permit cancellation,
-- gift removal and unrelated notes/payments on previously blocked orders.
create or replace function app_private.crm_order_validity_deferred_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_order_id bigint;
begin
  if tg_table_name = 'orders' then
    if tg_op = 'UPDATE' then
      if old.status::text = 'delivered' or new.status::text = 'cancelled'
        or (new.status::text = 'created' and new.status is distinct from old.status) then return null; end if;
      if new.client_id is not distinct from old.client_id
        and new.attributed_advisor_id is not distinct from old.attributed_advisor_id
        and new.extra_fields #> '{schedule}' is not distinct from old.extra_fields #> '{schedule}'
        and new.status is not distinct from old.status then return null; end if;
    end if;
    v_order_id := new.id;
  else
    v_order_id := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
    if exists (select 1 from public.orders where id = v_order_id and status::text = 'delivered') then return null; end if;
  end if;
  -- Delivery already checked before redemption; redeemed members aren't available again.
  if not exists (select 1 from public.orders where id = v_order_id and status::text = 'delivered') then
    perform app_private.crm_assert_order_validity_v1(v_order_id);
  end if;
  return null;
end;
$$;
create constraint trigger crm_order_validity_after_order after insert or update on public.orders
  deferrable initially deferred for each row execute function app_private.crm_order_validity_deferred_guard_v1();
create constraint trigger crm_order_validity_after_items after insert or update or delete on public.order_items
  deferrable initially deferred for each row execute function app_private.crm_order_validity_deferred_guard_v1();

-- Guarded patches preserve all currently deployed pricing and reservation rules.
do $patch$
declare v_source text; v_old text;
begin
  select pg_get_functiondef('app_private.crm_finalize_order_benefits_on_delivery_v1()'::regprocedure) into v_source;
  v_old := '  update public.crm_play_redemptions redemption';
  if strpos(v_source,v_old) = 0 then raise exception 'CRM delivery function changed; review migration'; end if;
  execute replace(v_source,v_old,'  perform app_private.crm_assert_order_validity_v1(new.id);' || E'\n' || v_old);

  select pg_get_functiondef('app_private.crm_order_item_guard_v1()'::regprocedure) into v_source;
  v_old := $old$if member_row.play_status <> 'active'
        or (member_row.starts_at is not null and pg_catalog.now() < member_row.starts_at)
        or (member_row.ends_at is not null and pg_catalog.now() >= member_row.ends_at)
        or member_row.benefit_status not in ('available', 'reserved')
      then$old$;
  if strpos(v_source,v_old) = 0 then raise exception 'CRM item guard changed; review migration'; end if;
  execute replace(v_source,v_old,$new$if (member_row.play_status <> 'active'
        or (member_row.starts_at is not null and pg_catalog.now() < member_row.starts_at)
        or (member_row.ends_at is not null and pg_catalog.now() >= member_row.ends_at)
        or member_row.benefit_status not in ('available', 'reserved'))
        and not app_private.crm_order_has_validity_exception_v1(new.order_id,new.crm_play_member_id)
      then$new$);
end;
$patch$;

revoke all on function app_private.crm_order_validity_state_v1(bigint) from public,anon,authenticated,service_role;
revoke all on function app_private.crm_order_has_validity_exception_v1(bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function app_private.crm_assert_order_validity_v1(bigint) from public,anon,authenticated,service_role;
revoke all on function app_private.crm_order_validity_deferred_guard_v1() from public,anon,authenticated,service_role;
revoke all on function public.crm_read_order_validity_v1(bigint) from public,anon;
revoke all on function public.crm_authorize_order_validity_v1(uuid,bigint,bigint,text,date,text) from public,anon;
grant execute on function public.crm_read_order_validity_v1(bigint) to authenticated;
grant execute on function public.crm_authorize_order_validity_v1(uuid,bigint,bigint,text,date,text) to authenticated;
