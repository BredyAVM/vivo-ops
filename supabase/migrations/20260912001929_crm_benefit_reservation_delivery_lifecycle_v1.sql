set lock_timeout = '5s';
set statement_timeout = '30s';

begin;

-- A benefit placed in an open order is only a reservation. Commercial cost and
-- CRM conversion become real when the operational order is delivered.
alter table public.crm_play_redemptions
  add column if not exists reserved_by_user_id uuid
    references public.profiles(id) on delete restrict,
  add column if not exists reserved_at timestamptz;

alter table public.crm_play_redemptions disable trigger crm_play_redemptions_guard;

update public.crm_play_redemptions redemption
set
  reserved_by_user_id = coalesce(redemption.reserved_by_user_id, redemption.redeemed_by_user_id),
  reserved_at = coalesce(redemption.reserved_at, redemption.redeemed_at, redemption.created_at)
where redemption.reserved_by_user_id is null
   or redemption.reserved_at is null;

alter table public.crm_play_redemptions
  alter column reserved_by_user_id set not null,
  alter column reserved_at set not null,
  alter column redeemed_by_user_id drop not null,
  alter column redeemed_at drop not null,
  alter column redeemed_at drop default,
  alter column status set default 'reserved';

alter table public.crm_play_redemptions
  drop constraint if exists crm_play_redemptions_status_check,
  drop constraint if exists crm_play_redemptions_void_check;

alter table public.crm_play_redemptions
  add constraint crm_play_redemptions_status_check
    check (status in ('reserved', 'redeemed', 'voided')),
  add constraint crm_play_redemptions_void_check
    check (
      (
        status = 'reserved'
        and redeemed_by_user_id is null
        and redeemed_at is null
        and voided_at is null
        and void_reason is null
      )
      or (
        status = 'redeemed'
        and redeemed_by_user_id is not null
        and redeemed_at is not null
        and voided_at is null
        and void_reason is null
      )
      or (
        status = 'voided'
        and voided_at is not null
        and pg_catalog.btrim(coalesce(void_reason, '')) <> ''
        and (
          (redeemed_by_user_id is null and redeemed_at is null)
          or (redeemed_by_user_id is not null and redeemed_at is not null)
        )
      )
    );

drop index if exists public.crm_play_redemptions_active_member_benefit_unique;
create unique index crm_play_redemptions_active_member_benefit_unique
  on public.crm_play_redemptions(play_member_id, play_benefit_id)
  where status in ('reserved', 'redeemed') and play_benefit_id is not null;

drop index if exists public.crm_play_redemptions_order_item_unique;
create unique index crm_play_redemptions_order_item_unique
  on public.crm_play_redemptions(order_item_id)
  where order_item_id is not null and status in ('reserved', 'redeemed');

create index if not exists crm_play_redemptions_active_order_idx
  on public.crm_play_redemptions(order_id, status, play_member_id)
  where status in ('reserved', 'redeemed');

-- Lifecycle functions may update only the four benefit-state fields even after
-- a play closes. All frozen segmentation and commercial decision data remain
-- protected by the original member guard.
create or replace function app_private.crm_play_member_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  play_status text;
  lifecycle_context text := coalesce(
    pg_catalog.current_setting('app.crm_benefit_lifecycle_context', true),
    ''
  );
begin
  select play.status
  into play_status
  from public.crm_plays play
  where play.id = case when tg_op = 'DELETE' then old.play_id else new.play_id end;

  if play_status is null then
    raise exception 'CRM play does not exist';
  end if;

  if tg_op = 'UPDATE' and lifecycle_context = 'on' then
    if (
      pg_catalog.to_jsonb(new)
        - 'benefit_status'
        - 'benefit_reserved_at'
        - 'benefit_redeemed_at'
        - 'benefit_expired_at'
        - 'updated_at'
    ) is distinct from (
      pg_catalog.to_jsonb(old)
        - 'benefit_status'
        - 'benefit_reserved_at'
        - 'benefit_redeemed_at'
        - 'benefit_expired_at'
        - 'updated_at'
    ) then
      raise exception 'El contexto interno solo puede cambiar el estado del beneficio CRM.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' and play_status <> 'draft' then
    raise exception 'CRM play members can only be selected while the play is a draft';
  end if;

  if tg_op = 'DELETE' and play_status <> 'draft' then
    raise exception 'A frozen CRM play member cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    if play_status in ('frozen', 'closed', 'cancelled') then
      raise exception 'CRM play members cannot change while the play is %', play_status;
    end if;

    if play_status <> 'draft' and (
      new.play_id is distinct from old.play_id
      or new.client_id is distinct from old.client_id
      or new.advisor_id_snapshot is distinct from old.advisor_id_snapshot
      or new.eligible_at is distinct from old.eligible_at
      or new.first_purchase_on is distinct from old.first_purchase_on
      or new.last_purchase_on is distinct from old.last_purchase_on
      or new.purchase_count is distinct from old.purchase_count
      or new.net_revenue_usd is distinct from old.net_revenue_usd
      or new.average_ticket_usd is distinct from old.average_ticket_usd
      or new.cadence_days is distinct from old.cadence_days
      or new.cadence_window is distinct from old.cadence_window
      or new.last_advisor_id is distinct from old.last_advisor_id
      or new.last_advisor_name_snapshot is distinct from old.last_advisor_name_snapshot
      or new.last_gift_on is distinct from old.last_gift_on
      or new.days_since_last_purchase is distinct from old.days_since_last_purchase
      or new.used_pickup is distinct from old.used_pickup
      or new.used_delivery is distinct from old.used_delivery
      or new.decision_snapshot is distinct from old.decision_snapshot
      or new.eligibility_reasons is distinct from old.eligibility_reasons
      or new.created_at is distinct from old.created_at
    ) then
      raise exception 'Frozen CRM play member decision data is immutable';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app_private.crm_play_member_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_member_guard_v1() to service_role;

create or replace function app_private.crm_play_redemption_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_row record;
  option_row record;
  upgrade_row record;
  order_row record;
  commercial_subtotal numeric;
  order_discount_pct numeric;
  expected_product_id bigint;
  expected_quantity numeric;
  expected_line_total numeric;
  lifecycle_time timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'Los registros de beneficios CRM no se eliminan; deben anularse.'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if new.play_member_id is distinct from old.play_member_id
      or new.play_benefit_id is distinct from old.play_benefit_id
      or new.play_benefit_upgrade_id is distinct from old.play_benefit_upgrade_id
      or new.order_id is distinct from old.order_id
      or (
        new.order_item_id is distinct from old.order_item_id
        and not (
          new.status = 'voided'
          and new.order_item_id is null
          and old.order_item_id is not null
        )
      )
      or new.product_id is distinct from old.product_id
      or new.quantity is distinct from old.quantity
      or new.play_name_snapshot is distinct from old.play_name_snapshot
      or new.unit_benefit_value_usd is distinct from old.unit_benefit_value_usd
      or new.unit_advisor_cost_usd is distinct from old.unit_advisor_cost_usd
      or new.unit_company_cost_usd is distinct from old.unit_company_cost_usd
      or new.benefit_value_usd is distinct from old.benefit_value_usd
      or new.benefit_credit_usd is distinct from old.benefit_credit_usd
      or new.customer_paid_difference_usd is distinct from old.customer_paid_difference_usd
      or new.advisor_charge_usd is distinct from old.advisor_charge_usd
      or new.company_cost_usd is distinct from old.company_cost_usd
      or new.reserved_by_user_id is distinct from old.reserved_by_user_id
      or new.reserved_at is distinct from old.reserved_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'La identidad y los montos congelados del beneficio CRM son inmutables.'
        using errcode = '55000';
    end if;

    if old.status = 'reserved' and new.status = 'redeemed' then
      if old.redeemed_by_user_id is not null
        or old.redeemed_at is not null
        or new.redeemed_by_user_id is null
        or new.redeemed_at is null
        or new.voided_at is not null
        or new.void_reason is not null
      then
        raise exception 'La entrega del beneficio no tiene una auditoría válida.'
          using errcode = '22023';
      end if;
    elsif old.status in ('reserved', 'redeemed') and new.status = 'voided' then
      if new.voided_at is null or pg_catalog.btrim(coalesce(new.void_reason, '')) = '' then
        raise exception 'La anulación del beneficio requiere fecha y motivo.'
          using errcode = '22023';
      end if;
      if old.status = 'reserved' and (
        new.redeemed_by_user_id is not null or new.redeemed_at is not null
      ) then
        raise exception 'Una reserva anulada no puede figurar como entregada.'
          using errcode = '22023';
      end if;
      if old.status = 'redeemed' and (
        new.redeemed_by_user_id is distinct from old.redeemed_by_user_id
        or new.redeemed_at is distinct from old.redeemed_at
      ) then
        raise exception 'La evidencia de entrega del beneficio es inmutable.'
          using errcode = '55000';
      end if;
      return new;
    else
      raise exception 'Transición de beneficio CRM no permitida: % -> %', old.status, new.status
        using errcode = '55000';
    end if;
  else
    if new.status <> 'reserved'
      or new.reserved_by_user_id is null
      or new.reserved_at is null
      or new.redeemed_by_user_id is not null
      or new.redeemed_at is not null
      or new.voided_at is not null
      or new.void_reason is not null
    then
      raise exception 'Un beneficio nuevo debe comenzar como reserva auditada.'
        using errcode = '22023';
    end if;
  end if;

  select
    member.id,
    member.client_id,
    member.play_id,
    member.advisor_id_snapshot,
    member.workflow_status,
    member.benefit_status,
    play.name as play_name,
    play.status as play_status,
    play.starts_at,
    play.ends_at,
    play.purchase_requirement_mode,
    play.minimum_order_amount_usd
  into member_row
  from public.crm_play_members member
  join public.crm_plays play on play.id = member.play_id
  where member.id = new.play_member_id;

  if member_row.id is null then
    raise exception 'La pertenencia a la jugada CRM no existe.' using errcode = 'P0002';
  end if;

  lifecycle_time := case when tg_op = 'INSERT' then new.reserved_at else new.redeemed_at end;
  if tg_op = 'INSERT' then
    if member_row.play_status <> 'active'
      or (member_row.starts_at is not null and lifecycle_time < member_row.starts_at)
      or (member_row.ends_at is not null and lifecycle_time >= member_row.ends_at)
      or member_row.benefit_status not in ('available', 'reserved')
    then
      raise exception 'El beneficio de esta jugada ya no está disponible.' using errcode = '55000';
    end if;
  end if;

  select
    benefit.id,
    benefit.product_id,
    benefit.quantity,
    benefit.unit_benefit_value_usd,
    benefit.unit_advisor_cost_usd,
    benefit.unit_company_cost_usd
  into option_row
  from public.crm_play_benefits benefit
  join public.crm_play_member_benefit_selections selection
    on selection.play_benefit_id = benefit.id
   and selection.play_member_id = new.play_member_id
   and selection.play_id = benefit.play_id
  where benefit.id = new.play_benefit_id
    and benefit.play_id = member_row.play_id;

  if option_row.id is null then
    raise exception 'El beneficio no fue seleccionado para este cliente.' using errcode = '42501';
  end if;

  expected_product_id := option_row.product_id;
  expected_quantity := option_row.quantity;
  expected_line_total := 0;

  if new.play_benefit_upgrade_id is not null then
    select
      upgrade.id,
      upgrade.target_product_id,
      upgrade.target_quantity,
      upgrade.customer_difference_usd_snapshot
    into upgrade_row
    from public.crm_play_benefit_upgrades upgrade
    where upgrade.id = new.play_benefit_upgrade_id
      and upgrade.play_benefit_id = option_row.id
      and upgrade.play_id = member_row.play_id;

    if upgrade_row.id is null then
      raise exception 'La ampliación no pertenece al beneficio seleccionado.' using errcode = '42501';
    end if;

    expected_product_id := upgrade_row.target_product_id;
    expected_quantity := upgrade_row.target_quantity;
    expected_line_total := coalesce(upgrade_row.customer_difference_usd_snapshot, 0);
  end if;

  if new.product_id is distinct from expected_product_id
    or pg_catalog.abs(new.quantity - expected_quantity) > 0.001
  then
    raise exception 'El producto final no corresponde al beneficio o ampliación seleccionada.'
      using errcode = '22023';
  end if;

  select
    order_data.id,
    order_data.client_id,
    order_data.attributed_advisor_id,
    order_data.status::text as status,
    order_data.extra_fields
  into order_row
  from public.orders order_data
  where order_data.id = new.order_id;

  if order_row.id is null
    or order_row.client_id is distinct from member_row.client_id
    or order_row.attributed_advisor_id is distinct from member_row.advisor_id_snapshot
  then
    raise exception 'La orden no corresponde al cliente y asesor de esta jugada.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' and order_row.status in ('delivered', 'cancelled') then
    raise exception 'No se puede reservar un beneficio en una orden cerrada.' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and order_row.status <> 'delivered' then
    raise exception 'El beneficio solo se entrega al completar la orden.' using errcode = '55000';
  end if;

  if new.order_item_id is null or not exists (
    select 1
    from public.order_items item
    where item.id = new.order_item_id
      and item.order_id = new.order_id
      and item.product_id = expected_product_id
      and item.crm_play_member_id = new.play_member_id
      and item.crm_play_benefit_id = new.play_benefit_id
      and item.crm_play_benefit_upgrade_id is not distinct from new.play_benefit_upgrade_id
      and pg_catalog.abs(item.qty - expected_quantity) <= 0.001
      and pg_catalog.abs(coalesce(item.line_total_usd, 0) - expected_line_total) <= 0.02
  ) then
    raise exception 'La orden no contiene la línea exacta y vinculada del beneficio CRM.'
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    order_discount_pct := greatest(0, least(100, coalesce(
      nullif(order_row.extra_fields #>> '{pricing,discount_pct}', '')::numeric,
      0
    )));

    select pg_catalog.round(
      coalesce(sum(coalesce(item.line_total_usd, 0)), 0)
        * (1 - order_discount_pct / 100),
      2
    )
    into commercial_subtotal
    from public.order_items item
    where item.order_id = new.order_id
      and item.crm_play_member_id is null;

    if member_row.purchase_requirement_mode = 'minimum_order'
      and commercial_subtotal + 0.005 < member_row.minimum_order_amount_usd
    then
      raise exception 'La compra comercial no alcanza el mínimo exigido por la jugada.'
        using errcode = '55000';
    end if;

    return new;
  end if;

  new.play_name_snapshot := member_row.play_name;
  new.unit_benefit_value_usd := option_row.unit_benefit_value_usd;
  new.unit_advisor_cost_usd := option_row.unit_advisor_cost_usd;
  new.unit_company_cost_usd := option_row.unit_company_cost_usd;
  new.benefit_value_usd := pg_catalog.round(option_row.unit_benefit_value_usd * option_row.quantity, 2);
  new.benefit_credit_usd := new.benefit_value_usd;
  new.customer_paid_difference_usd := pg_catalog.round(expected_line_total, 2);
  new.advisor_charge_usd := pg_catalog.round(option_row.unit_advisor_cost_usd * option_row.quantity, 2);
  new.company_cost_usd := pg_catalog.round(option_row.unit_company_cost_usd * option_row.quantity, 2);
  return new;
end;
$$;

revoke all on function app_private.crm_play_redemption_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_redemption_guard_v1() to service_role;

alter table public.crm_play_redemptions enable trigger crm_play_redemptions_guard;

create or replace function app_private.crm_reserve_order_item_benefit_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  member_row record;
  order_row record;
begin
  if new.crm_play_member_id is null then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat('crm-play-member:', new.crm_play_member_id), 0)
  );

  select member.id, member.benefit_status
  into member_row
  from public.crm_play_members member
  where member.id = new.crm_play_member_id
  for update;

  select order_data.id, order_data.attributed_advisor_id, order_data.status::text as status
  into order_row
  from public.orders order_data
  where order_data.id = new.order_id;

  actor_id := coalesce(auth.uid(), order_row.attributed_advisor_id);
  if actor_id is null or not exists (
    select 1 from public.profiles profile where profile.id = actor_id
  ) then
    raise exception 'No se pudo identificar al responsable de reservar el beneficio.'
      using errcode = '42501';
  end if;

  if order_row.status in ('delivered', 'cancelled') then
    raise exception 'No se puede reservar un beneficio en una orden cerrada.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.crm_play_redemptions active_redemption
    where active_redemption.play_member_id = new.crm_play_member_id
      and active_redemption.status in ('reserved', 'redeemed')
      and active_redemption.order_id <> new.order_id
  ) then
    raise exception 'Este beneficio ya está reservado o entregado en otra orden.'
      using errcode = '23505';
  end if;

  insert into public.crm_play_redemptions (
    play_member_id,
    play_benefit_id,
    play_benefit_upgrade_id,
    order_id,
    order_item_id,
    product_id,
    quantity,
    status,
    reserved_by_user_id,
    reserved_at,
    redeemed_by_user_id,
    redeemed_at
  ) values (
    new.crm_play_member_id,
    new.crm_play_benefit_id,
    new.crm_play_benefit_upgrade_id,
    new.order_id,
    new.id,
    new.product_id,
    new.qty,
    'reserved',
    actor_id,
    pg_catalog.now(),
    null,
    null
  );

  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'on', true);
  update public.crm_play_members member
  set
    benefit_status = 'reserved',
    benefit_reserved_at = coalesce(member.benefit_reserved_at, pg_catalog.now()),
    benefit_redeemed_at = null,
    benefit_expired_at = null
  where member.id = new.crm_play_member_id;
  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'off', true);

  return new;
end;
$$;

revoke all on function app_private.crm_reserve_order_item_benefit_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists crm_order_items_reserve_benefit on public.order_items;
create trigger crm_order_items_reserve_benefit
after insert on public.order_items
for each row
when (new.crm_play_member_id is not null)
execute function app_private.crm_reserve_order_item_benefit_v1();

create or replace function app_private.crm_release_order_item_reservation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lifecycle_row record;
begin
  if old.crm_play_member_id is null then
    return old;
  end if;

  select redemption.id, redemption.play_member_id, redemption.status
  into lifecycle_row
  from public.crm_play_redemptions redemption
  where redemption.order_item_id = old.id
    and redemption.status in ('reserved', 'redeemed')
  for update;

  if lifecycle_row.id is null then
    raise exception 'La línea CRM no tiene una reserva auditable asociada.' using errcode = '55000';
  end if;
  if lifecycle_row.status = 'redeemed' then
    raise exception 'Un beneficio entregado no puede retirarse desde una modificación ordinaria.'
      using errcode = '55000';
  end if;

  update public.crm_play_redemptions redemption
  set
    status = 'voided',
    order_item_id = null,
    voided_at = pg_catalog.now(),
    void_reason = pg_catalog.concat(
      'Reserva liberada al retirar el producto del pedido ', old.order_id, '.'
    )
  where redemption.id = lifecycle_row.id;

  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'on', true);
  update public.crm_play_members member
  set
    benefit_status = case
      when exists (
        select 1 from public.crm_play_redemptions remaining
        where remaining.play_member_id = member.id and remaining.status = 'redeemed'
      ) then 'redeemed'
      when exists (
        select 1 from public.crm_play_redemptions remaining
        where remaining.play_member_id = member.id and remaining.status = 'reserved'
      ) then 'reserved'
      when play.status in ('active', 'paused')
        and (play.starts_at is null or pg_catalog.now() >= play.starts_at)
        and (play.ends_at is null or pg_catalog.now() < play.ends_at)
        then 'available'
      else 'expired'
    end,
    benefit_reserved_at = case when exists (
      select 1 from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id and remaining.status in ('reserved', 'redeemed')
    ) then member.benefit_reserved_at else null end,
    benefit_redeemed_at = case when exists (
      select 1 from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id and remaining.status = 'redeemed'
    ) then member.benefit_redeemed_at else null end
  from public.crm_plays play
  where member.id = lifecycle_row.play_member_id
    and play.id = member.play_id;
  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'off', true);

  return old;
end;
$$;

revoke all on function app_private.crm_release_order_item_reservation_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists crm_order_items_release_reservation on public.order_items;
create trigger crm_order_items_release_reservation
before delete on public.order_items
for each row
when (old.crm_play_member_id is not null)
execute function app_private.crm_release_order_item_reservation_v1();

create or replace function app_private.crm_finalize_order_benefits_on_delivery_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  member_ids bigint[];
begin
  if new.status <> 'delivered' or old.status = 'delivered' then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat('crm-order-delivery:', new.id), 0)
  );

  actor_id := coalesce(auth.uid(), new.last_modified_by, new.attributed_advisor_id);
  if actor_id is null or not exists (
    select 1 from public.profiles profile where profile.id = actor_id
  ) then
    raise exception 'No se pudo identificar al responsable de entregar los beneficios.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.order_items item
    where item.order_id = new.id
      and item.crm_play_member_id is not null
      and not exists (
        select 1
        from public.crm_play_redemptions redemption
        where redemption.order_item_id = item.id
          and redemption.order_id = new.id
          and redemption.play_member_id = item.crm_play_member_id
          and redemption.play_benefit_id = item.crm_play_benefit_id
          and redemption.play_benefit_upgrade_id is not distinct from item.crm_play_benefit_upgrade_id
          and redemption.status in ('reserved', 'redeemed')
      )
  ) then
    raise exception 'La orden contiene un beneficio CRM sin reserva válida.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.crm_play_redemptions redemption
    left join public.order_items item
      on item.id = redemption.order_item_id
     and item.order_id = redemption.order_id
     and item.crm_play_member_id = redemption.play_member_id
     and item.crm_play_benefit_id = redemption.play_benefit_id
     and item.crm_play_benefit_upgrade_id is not distinct from redemption.play_benefit_upgrade_id
    where redemption.order_id = new.id
      and redemption.status = 'reserved'
      and item.id is null
  ) then
    raise exception 'La orden tiene una reserva CRM sin producto correspondiente.' using errcode = '55000';
  end if;

  select pg_catalog.array_agg(distinct redemption.play_member_id order by redemption.play_member_id)
  into member_ids
  from public.crm_play_redemptions redemption
  where redemption.order_id = new.id
    and redemption.status = 'reserved';

  if coalesce(pg_catalog.array_length(member_ids, 1), 0) = 0 then
    return new;
  end if;

  update public.crm_play_redemptions redemption
  set
    status = 'redeemed',
    redeemed_by_user_id = actor_id,
    redeemed_at = pg_catalog.now()
  where redemption.order_id = new.id
    and redemption.status = 'reserved';

  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'on', true);
  update public.crm_play_members member
  set
    benefit_status = 'redeemed',
    benefit_redeemed_at = pg_catalog.now(),
    benefit_expired_at = null
  where member.id = any(member_ids);
  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'off', true);

  insert into public.crm_play_member_events (
    play_member_id,
    event_type,
    from_status,
    to_status,
    note,
    actor_user_id,
    created_at
  )
  select
    member.id,
    'benefit_redeemed',
    member.workflow_status,
    member.workflow_status,
    pg_catalog.concat('Obsequio entregado en la orden ', coalesce(new.order_number, new.id::text)),
    actor_id,
    pg_catalog.now()
  from public.crm_play_members member
  where member.id = any(member_ids);

  return new;
end;
$$;

revoke all on function app_private.crm_finalize_order_benefits_on_delivery_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists orders_finalize_crm_benefits_on_delivery on public.orders;
create trigger orders_finalize_crm_benefits_on_delivery
after update of status on public.orders
for each row
when (new.status = 'delivered' and old.status is distinct from new.status)
execute function app_private.crm_finalize_order_benefits_on_delivery_v1();

create or replace function app_private.crm_void_play_redemptions_on_order_cancel_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_ids bigint[];
begin
  if new.status <> 'cancelled' or old.status = 'cancelled' then
    return new;
  end if;

  select pg_catalog.array_agg(distinct redemption.play_member_id order by redemption.play_member_id)
  into member_ids
  from public.crm_play_redemptions redemption
  where redemption.order_id = new.id
    and redemption.status in ('reserved', 'redeemed');

  if coalesce(pg_catalog.array_length(member_ids, 1), 0) = 0 then
    return new;
  end if;

  update public.crm_play_redemptions redemption
  set
    status = 'voided',
    voided_at = pg_catalog.now(),
    void_reason = pg_catalog.concat(
      case when redemption.status = 'reserved' then 'Reserva liberada' else 'Entrega anulada' end,
      ' automáticamente al cancelar el pedido ',
      coalesce(new.order_number, new.id::text),
      '.'
    )
  where redemption.order_id = new.id
    and redemption.status in ('reserved', 'redeemed');

  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'on', true);
  update public.crm_play_members member
  set
    benefit_status = case
      when exists (
        select 1 from public.crm_play_redemptions remaining
        where remaining.play_member_id = member.id and remaining.status = 'redeemed'
      ) then 'redeemed'
      when exists (
        select 1 from public.crm_play_redemptions remaining
        where remaining.play_member_id = member.id and remaining.status = 'reserved'
      ) then 'reserved'
      when play.status in ('active', 'paused')
        and (play.starts_at is null or pg_catalog.now() >= play.starts_at)
        and (play.ends_at is null or pg_catalog.now() < play.ends_at)
        then 'available'
      else 'expired'
    end,
    benefit_reserved_at = case when exists (
      select 1 from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id and remaining.status in ('reserved', 'redeemed')
    ) then member.benefit_reserved_at else null end,
    benefit_redeemed_at = case when exists (
      select 1 from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id and remaining.status = 'redeemed'
    ) then member.benefit_redeemed_at else null end
  from public.crm_plays play
  where member.id = any(member_ids)
    and play.id = member.play_id;
  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'off', true);

  return new;
end;
$$;

revoke all on function app_private.crm_void_play_redemptions_on_order_cancel_v1()
  from public, anon, authenticated, service_role;

-- Compatibility endpoint for clients deployed before this migration. It can
-- verify a reservation but can no longer mark it delivered from the browser.
create or replace function public.crm_redeem_play_benefits_v3(
  p_play_member_id bigint,
  p_order_id bigint,
  p_fulfillments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  member_row record;
  order_row record;
  requested_count integer;
  reserved_count integer;
begin
  if caller_id is null then
    raise exception 'Se requiere autenticación para consultar la reserva CRM.' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_fulfillments) <> 'array' then
    raise exception 'Los beneficios CRM deben enviarse como una lista.' using errcode = '22023';
  end if;

  select member.id, member.client_id, member.advisor_id_snapshot
  into member_row
  from public.crm_play_members member
  where member.id = p_play_member_id;

  if member_row.id is null then
    raise exception 'La pertenencia a la jugada CRM no existe.' using errcode = 'P0002';
  end if;
  if not (member_row.advisor_id_snapshot = caller_id or public.is_master_or_admin()) then
    raise exception 'Esta jugada pertenece a otro asesor.' using errcode = '42501';
  end if;

  select order_data.id, order_data.client_id, order_data.attributed_advisor_id
  into order_row
  from public.orders order_data
  where order_data.id = p_order_id;

  if order_row.id is null or order_row.client_id is distinct from member_row.client_id then
    raise exception 'La orden no pertenece al cliente de esta jugada.' using errcode = '22023';
  end if;
  if not (order_row.attributed_advisor_id = caller_id or public.is_master_or_admin()) then
    raise exception 'La orden pertenece a otro asesor.' using errcode = '42501';
  end if;

  select count(*)::integer
  into requested_count
  from pg_catalog.jsonb_array_elements(p_fulfillments) entry(value);

  select count(*)::integer
  into reserved_count
  from public.crm_play_redemptions redemption
  where redemption.play_member_id = p_play_member_id
    and redemption.order_id = p_order_id
    and redemption.status in ('reserved', 'redeemed')
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_fulfillments) entry(value)
      where (entry.value ->> 'play_benefit_id')::bigint = redemption.play_benefit_id
        and (
          nullif(entry.value ->> 'play_benefit_upgrade_id', '')::bigint
          is not distinct from redemption.play_benefit_upgrade_id
        )
    );

  if requested_count = 0 or reserved_count <> requested_count then
    raise exception 'No se pudo verificar la reserva completa de beneficios de la orden.'
      using errcode = '55000';
  end if;

  return pg_catalog.jsonb_build_object(
    'play_member_id', p_play_member_id,
    'order_id', p_order_id,
    'reserved_count', reserved_count,
    'redeemed_count', 0,
    'advisor_charge_usd', 0,
    'company_cost_usd', 0,
    'customer_paid_difference_usd', 0
  );
end;
$$;

revoke all on function public.crm_redeem_play_benefits_v3(bigint, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.crm_redeem_play_benefits_v3(bigint, bigint, jsonb)
  to authenticated, service_role;

-- The current atomic editor keeps redeemed lines immutable. This wrapper first
-- removes omitted reservations in the same transaction, allowing the original
-- editor to rebuild the remaining order without leaving a phantom benefit.
create or replace function app_private.update_order_core_atomic_v2(
  p_order_id bigint,
  p_expected_last_modified_at timestamptz,
  p_order_patch jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row record;
  next_client_id bigint;
  next_advisor_id uuid;
begin
  if pg_catalog.jsonb_typeof(p_order_patch) <> 'object'
    or pg_catalog.jsonb_typeof(p_items) <> 'array'
  then
    raise exception 'La modificación de la orden no tiene el formato esperado.' using errcode = '22023';
  end if;

  select order_data.id, order_data.client_id, order_data.attributed_advisor_id
  into order_row
  from public.orders order_data
  where order_data.id = p_order_id
  for update;

  if order_row.id is null then
    raise exception 'La orden no existe.' using errcode = 'P0002';
  end if;

  next_client_id := coalesce(nullif(p_order_patch ->> 'client_id', '')::bigint, order_row.client_id);
  next_advisor_id := coalesce(nullif(p_order_patch ->> 'attributed_advisor_id', '')::uuid, order_row.attributed_advisor_id);

  if exists (
    select 1
    from public.order_items item
    join public.crm_play_members member on member.id = item.crm_play_member_id
    join public.crm_play_redemptions redemption
      on redemption.order_item_id = item.id
     and redemption.status in ('reserved', 'redeemed')
    where item.order_id = p_order_id
      and (
        member.client_id is distinct from next_client_id
        or member.advisor_id_snapshot is distinct from next_advisor_id
      )
  ) then
    raise exception 'No puedes cambiar el cliente o asesor mientras la orden conserve un beneficio CRM.'
      using errcode = '55000';
  end if;

  delete from public.order_items item
  using public.crm_play_redemptions redemption
  where item.order_id = p_order_id
    and redemption.order_item_id = item.id
    and redemption.status = 'reserved'
    and not exists (
      select 1
      from pg_catalog.jsonb_to_recordset(p_items) incoming(order_item_id bigint)
      where incoming.order_item_id = item.id
    );

  return app_private.update_order_core_atomic_v1(
    p_order_id,
    p_expected_last_modified_at,
    p_order_patch,
    p_items
  );
end;
$$;

create or replace function public.update_order_core_atomic_v1(
  p_order_id bigint,
  p_expected_last_modified_at timestamptz,
  p_order_patch jsonb,
  p_items jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app_private.update_order_core_atomic_v2(
    p_order_id,
    p_expected_last_modified_at,
    p_order_patch,
    p_items
  )
$$;

revoke all on function app_private.update_order_core_atomic_v2(bigint, timestamptz, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb)
  from public, anon, service_role;
grant execute on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb)
  to authenticated;

comment on column public.crm_play_redemptions.reserved_at is
  'When the benefit was attached to an open order; this is not delivery or financial recognition.';
comment on function app_private.crm_finalize_order_benefits_on_delivery_v1() is
  'Turns valid CRM benefit reservations into delivered redemptions only when the operational order is delivered.';
comment on function public.crm_redeem_play_benefits_v3(bigint, bigint, jsonb) is
  'Compatibility verifier for an existing reservation. Delivery is exclusively controlled by the order delivered transition.';
comment on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb) is
  'Atomically edits an order, releases omitted CRM reservations and preserves delivered CRM evidence.';

commit;
