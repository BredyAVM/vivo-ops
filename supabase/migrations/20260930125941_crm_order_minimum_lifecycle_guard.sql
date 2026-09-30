-- Validate the final order, not a partially rebuilt basket. No existing order is rewritten.
create table app_private.crm_order_minimum_exceptions (
  id uuid primary key,
  order_id bigint not null references public.orders(id),
  play_member_id bigint not null references public.crm_play_members(id),
  benefit_fingerprint text not null,
  minimum_required_usd numeric not null check (minimum_required_usd > 0),
  minimum_authorized_usd numeric not null check (minimum_authorized_usd >= 0),
  commercial_subtotal_at_approval numeric not null,
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default now(),
  check (minimum_authorized_usd < minimum_required_usd)
);
create index crm_order_minimum_exceptions_lookup
  on app_private.crm_order_minimum_exceptions(order_id, play_member_id, benefit_fingerprint);
alter table app_private.crm_order_minimum_exceptions enable row level security;
revoke all on app_private.crm_order_minimum_exceptions from public, anon, authenticated, service_role;

create or replace function app_private.crm_order_minimum_state_v1(p_order_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with basket as (
    select o.id, o.client_id, o.attributed_advisor_id,
      round(coalesce(sum(i.line_total_usd) filter (where i.crm_play_member_id is null), 0)
        * (1 - greatest(0, least(100, coalesce(
          nullif(o.extra_fields #>> '{pricing,discount_pct}', '')::numeric, 0))) / 100), 2) as commercial
    from public.orders o left join public.order_items i on i.order_id = o.id
    where o.id = p_order_id
    group by o.id
  ), benefits as (
    select m.id as member_id, p.name, p.minimum_order_amount_usd as required,
      b.commercial,
      md5(jsonb_build_array(b.client_id, b.attributed_advisor_id, m.id,
        p.minimum_order_amount_usd,
        jsonb_agg(jsonb_build_array(i.id, i.product_id, i.qty, i.crm_play_benefit_id,
          i.crm_play_benefit_upgrade_id) order by i.id))::text) as fingerprint
    from basket b
    join public.order_items i on i.order_id = b.id
    join public.crm_play_members m on m.id = i.crm_play_member_id
    join public.crm_plays p on p.id = m.play_id
    where p.purchase_requirement_mode = 'minimum_order'
    group by b.client_id, b.attributed_advisor_id, b.commercial, m.id, p.name, p.minimum_order_amount_usd
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'memberId', b.member_id, 'playName', b.name, 'requiredUsd', b.required,
    'commercialUsd', b.commercial, 'fingerprint', b.fingerprint,
    'authorizedFloorUsd', e.minimum_authorized_usd, 'reason', e.reason,
    'approvedAt', e.approved_at,
    'approvedBy', (select full_name from public.profiles where id = e.approved_by),
    'eligible', b.commercial + 0.005 >= coalesce(e.minimum_authorized_usd, b.required)
  ) order by b.member_id), '[]'::jsonb)
  from benefits b left join lateral (
    select exception.* from app_private.crm_order_minimum_exceptions exception
    where exception.order_id = p_order_id and exception.play_member_id = b.member_id
      and exception.benefit_fingerprint = b.fingerprint
    order by exception.minimum_authorized_usd, exception.approved_at desc limit 1
  ) e on true;
$$;

create or replace function app_private.crm_assert_order_minimum_v1(p_order_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text; v_benefit jsonb;
begin
  -- Serialize all financial/product edits and exception approvals on the same order.
  select status::text into v_status from public.orders where id = p_order_id for update;
  if not found or v_status = 'cancelled' then return; end if;
  for v_benefit in select value from jsonb_array_elements(app_private.crm_order_minimum_state_v1(p_order_id)) loop
    if not (v_benefit ->> 'eligible')::boolean then
      raise exception 'El beneficio de esta jugada («%») requiere una compra de al menos $% sin contar regalos. La compra quedó en $%. Completa el mínimo, retira el obsequio o solicita una excepción al administrador.',
        v_benefit ->> 'playName',
        coalesce(v_benefit ->> 'authorizedFloorUsd', v_benefit ->> 'requiredUsd'),
        v_benefit ->> 'commercialUsd'
        using errcode = '23514';
    end if;
  end loop;
end;
$$;

create or replace function app_private.crm_order_minimum_deferred_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'orders' then
    if tg_op = 'UPDATE' then
      -- Payments, notes and returning a legacy invalid order to review remain possible.
      if new.client_id is not distinct from old.client_id
        and new.attributed_advisor_id is not distinct from old.attributed_advisor_id
        and new.extra_fields #> '{pricing}' is not distinct from old.extra_fields #> '{pricing}'
        and (new.status is not distinct from old.status or new.status::text in ('created', 'cancelled'))
      then return null; end if;
    end if;
    perform app_private.crm_assert_order_minimum_v1(new.id);
  else
    if tg_op <> 'INSERT' then
      perform app_private.crm_assert_order_minimum_v1(old.order_id);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.order_id is distinct from old.order_id) then
      perform app_private.crm_assert_order_minimum_v1(new.order_id);
    end if;
  end if;
  return null;
end;
$$;

-- Take the parent lock before a line changes, not just at commit: concurrent
-- edits to different lines must not each validate an obsolete basket.
create or replace function app_private.crm_lock_order_minimum_edit_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform id from public.orders where id = new.order_id for update;
  elsif tg_op = 'DELETE' then
    perform id from public.orders where id = old.order_id for update;
  else
    perform id from public.orders where id in (old.order_id, new.order_id) order by id for update;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger crm_order_minimum_lock_items
before insert or update or delete on public.order_items
for each row execute function app_private.crm_lock_order_minimum_edit_v1();

create constraint trigger crm_order_minimum_after_order
after insert or update on public.orders deferrable initially deferred
for each row execute function app_private.crm_order_minimum_deferred_guard_v1();
create constraint trigger crm_order_minimum_after_items
after insert or update or delete on public.order_items deferrable initially deferred
for each row execute function app_private.crm_order_minimum_deferred_guard_v1();

-- Use the same policy at physical delivery, including a bounded admin exception.
-- Guard the replacement so a changed upstream function cannot be silently overwritten.
do $patch$
declare v_source text; v_old text := $old$if member_row.purchase_requirement_mode = 'minimum_order'
      and commercial_subtotal + 0.005 < member_row.minimum_order_amount_usd
    then
      raise exception 'La compra comercial no alcanza el mínimo exigido por la jugada.'
        using errcode = '55000';
    end if;$old$;
begin
  select pg_get_functiondef('app_private.crm_play_redemption_guard_v1()'::regprocedure) into v_source;
  if strpos(v_source, v_old) = 0 then raise exception 'CRM delivery guard changed; review migration before applying'; end if;
  execute replace(v_source, v_old, 'perform app_private.crm_assert_order_minimum_v1(new.order_id);');
end;
$patch$;

create or replace function public.crm_read_order_minimum_v1(p_order_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not (public.is_master_or_admin() or public.has_role('counter')
    or exists (select 1 from public.orders where id = p_order_id and attributed_advisor_id = auth.uid())) then
    raise exception 'No tienes permiso para consultar esta orden.' using errcode = '42501';
  end if;
  return app_private.crm_order_minimum_state_v1(p_order_id);
end;
$$;

create or replace function public.crm_authorize_order_minimum_v1(
  p_request_id uuid, p_order_id bigint, p_member_id bigint, p_fingerprint text,
  p_expected_commercial_usd numeric, p_minimum_authorized_usd numeric, p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_benefit jsonb; v_id uuid; v_existing record;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Solo el administrador puede autorizar esta excepción.' using errcode = '42501';
  end if;
  if p_request_id is null or p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then
    raise exception 'Explica el motivo de la excepción (entre 10 y 1000 caracteres).' using errcode = '22023';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.status::text in ('delivered', 'cancelled', 'out_for_delivery') then
    raise exception 'La excepción solo puede autorizarse antes de la salida o entrega.' using errcode = '55000';
  end if;
  select * into v_existing from app_private.crm_order_minimum_exceptions where id = p_request_id;
  if found then
    if v_existing.order_id is distinct from p_order_id or v_existing.play_member_id is distinct from p_member_id
      or v_existing.benefit_fingerprint is distinct from p_fingerprint
      or v_existing.minimum_authorized_usd is distinct from p_minimum_authorized_usd
      or v_existing.reason is distinct from btrim(p_reason) or v_existing.approved_by is distinct from auth.uid() then
      raise exception 'La solicitud ya fue usada con otros datos.' using errcode = '22023';
    end if;
    return jsonb_build_object('id', v_existing.id, 'authorized', true);
  end if;
  select value into v_benefit from jsonb_array_elements(app_private.crm_order_minimum_state_v1(p_order_id))
    where (value ->> 'memberId')::bigint = p_member_id;
  if v_benefit is null or v_benefit ->> 'fingerprint' is distinct from p_fingerprint
    or (v_benefit ->> 'commercialUsd')::numeric is distinct from p_expected_commercial_usd then
    raise exception 'La orden cambió. Revisa sus condiciones antes de autorizar.' using errcode = '40001';
  end if;
  if p_minimum_authorized_usd is null or p_minimum_authorized_usd::text in ('NaN', 'Infinity', '-Infinity')
    or p_minimum_authorized_usd < 0 or p_minimum_authorized_usd >= (v_benefit ->> 'requiredUsd')::numeric
    or p_minimum_authorized_usd <> round(p_minimum_authorized_usd, 2) then
    raise exception 'Indica un mínimo excepcional válido, menor al mínimo de la jugada.' using errcode = '22023';
  end if;
  insert into app_private.crm_order_minimum_exceptions (
    id, order_id, play_member_id, benefit_fingerprint, minimum_required_usd,
    minimum_authorized_usd, commercial_subtotal_at_approval, reason, approved_by
  ) values (p_request_id, p_order_id, p_member_id, p_fingerprint, (v_benefit ->> 'requiredUsd')::numeric,
    p_minimum_authorized_usd, p_expected_commercial_usd, btrim(p_reason), auth.uid()) returning id into v_id;
  insert into public.order_timeline_events (
    order_id, order_number, event_type, event_group, title, message, severity, actor_user_id, payload
  ) values (p_order_id, v_order.order_number, 'crm_minimum_exception_approved', 'approval',
    'Excepción de compra mínima autorizada por administrador', btrim(p_reason), 'warning', auth.uid(),
    jsonb_build_object('exception_id', v_id, 'play_member_id', p_member_id,
      'required_usd', (v_benefit ->> 'requiredUsd')::numeric,
      'authorized_floor_usd', p_minimum_authorized_usd, 'commercial_usd', p_expected_commercial_usd));
  return jsonb_build_object('id', v_id, 'authorized', true);
end;
$$;

revoke all on function app_private.crm_order_minimum_state_v1(bigint) from public, anon, authenticated, service_role;
revoke all on function app_private.crm_assert_order_minimum_v1(bigint) from public, anon, authenticated, service_role;
revoke all on function app_private.crm_order_minimum_deferred_guard_v1() from public, anon, authenticated, service_role;
revoke all on function app_private.crm_lock_order_minimum_edit_v1() from public, anon, authenticated, service_role;
revoke all on function public.crm_read_order_minimum_v1(bigint) from public, anon;
revoke all on function public.crm_authorize_order_minimum_v1(uuid,bigint,bigint,text,numeric,numeric,text) from public, anon;
grant execute on function public.crm_read_order_minimum_v1(bigint) to authenticated;
grant execute on function public.crm_authorize_order_minimum_v1(uuid,bigint,bigint,text,numeric,numeric,text) to authenticated;
