begin;

-- CRM pricing belongs to the order item relationship, not to the catalog product.
-- These nullable references let a regular catalog product keep its normal price while
-- an eligible play can apply a frozen zero price or upgrade difference to one item.
alter table public.order_items
  add column if not exists crm_play_member_id bigint,
  add column if not exists crm_play_benefit_id bigint,
  add column if not exists crm_play_benefit_upgrade_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'order_items_crm_play_member_id_fkey'
      and conrelid = 'public.order_items'::pg_catalog.regclass
  ) then
    alter table public.order_items
      add constraint order_items_crm_play_member_id_fkey
      foreign key (crm_play_member_id)
      references public.crm_play_members(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'order_items_crm_play_benefit_id_fkey'
      and conrelid = 'public.order_items'::pg_catalog.regclass
  ) then
    alter table public.order_items
      add constraint order_items_crm_play_benefit_id_fkey
      foreign key (crm_play_benefit_id)
      references public.crm_play_benefits(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'order_items_crm_play_benefit_upgrade_id_fkey'
      and conrelid = 'public.order_items'::pg_catalog.regclass
  ) then
    alter table public.order_items
      add constraint order_items_crm_play_benefit_upgrade_id_fkey
      foreign key (crm_play_benefit_upgrade_id)
      references public.crm_play_benefit_upgrades(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'order_items_crm_binding_complete_check'
      and conrelid = 'public.order_items'::pg_catalog.regclass
  ) then
    alter table public.order_items
      add constraint order_items_crm_binding_complete_check
      check (
        (
          crm_play_member_id is null
          and crm_play_benefit_id is null
          and crm_play_benefit_upgrade_id is null
        )
        or (
          crm_play_member_id is not null
          and crm_play_benefit_id is not null
        )
      );
  end if;
end;
$$;

create index if not exists order_items_crm_binding_idx
  on public.order_items (crm_play_member_id, crm_play_benefit_id, crm_play_benefit_upgrade_id)
  where crm_play_member_id is not null;

create or replace function app_private.crm_order_item_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  product_row record;
  order_row record;
  member_row record;
  benefit_row record;
  upgrade_row record;
  expected_product_id bigint;
  expected_quantity numeric;
  expected_line_total_usd numeric := 0;
  expected_unit_price_usd numeric := 0;
  is_crm_item boolean;
  is_existing_redemption boolean := false;
begin
  select
    product.id,
    product.type::text as product_type,
    product.extra_fields,
    product.is_active
  into product_row
  from public.products product
  where product.id = new.product_id;

  if product_row.id is null or not coalesce(product_row.is_active, false) then
    raise exception 'El producto ya no está disponible en el catálogo.' using errcode = '22023';
  end if;

  select
    order_data.id,
    order_data.client_id,
    order_data.attributed_advisor_id,
    order_data.source::text as source,
    nullif(order_data.extra_fields #>> '{pricing,fx_rate}', '')::numeric as fx_rate
  into order_row
  from public.orders order_data
  where order_data.id = new.order_id;

  if order_row.id is null then
    raise exception 'La orden no existe.' using errcode = 'P0002';
  end if;

  is_crm_item := new.crm_play_member_id is not null
    or new.crm_play_benefit_id is not null
    or new.crm_play_benefit_upgrade_id is not null;

  if not is_crm_item then
    if order_row.source = 'advisor'
      and (
        product_row.product_type = 'gambit'
        or coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') = 'crm_only'
      )
    then
      raise exception 'Este beneficio solo puede cargarse desde una jugada activa del cliente.'
        using errcode = '42501';
    end if;
  else
    if new.crm_play_member_id is null or new.crm_play_benefit_id is null then
      raise exception 'La vinculación CRM del producto está incompleta.' using errcode = '22023';
    end if;

    select
      member.id,
      member.play_id,
      member.client_id,
      member.advisor_id_snapshot,
      member.benefit_status,
      play.status as play_status,
      play.starts_at,
      play.ends_at
    into member_row
    from public.crm_play_members member
    join public.crm_plays play on play.id = member.play_id
    where member.id = new.crm_play_member_id;

    if member_row.id is null
      or member_row.client_id is distinct from order_row.client_id
      or member_row.advisor_id_snapshot is distinct from order_row.attributed_advisor_id
    then
      raise exception 'La jugada no corresponde al cliente y asesor de esta orden.' using errcode = '42501';
    end if;

    if caller_id is not null
      and caller_role <> 'service_role'
      and caller_id is distinct from order_row.attributed_advisor_id
    then
      raise exception 'Solo el asesor adjudicado puede aplicar este beneficio.' using errcode = '42501';
    end if;

    select
      benefit.id,
      benefit.product_id,
      benefit.quantity
    into benefit_row
    from public.crm_play_benefits benefit
    join public.crm_play_member_benefit_selections selection
      on selection.play_member_id = member_row.id
     and selection.play_benefit_id = benefit.id
     and selection.play_id = benefit.play_id
    where benefit.id = new.crm_play_benefit_id
      and benefit.play_id = member_row.play_id;

    if benefit_row.id is null then
      raise exception 'El beneficio no está seleccionado para este cliente.' using errcode = '42501';
    end if;

    expected_product_id := benefit_row.product_id;
    expected_quantity := benefit_row.quantity;
    expected_line_total_usd := 0;

    if new.crm_play_benefit_upgrade_id is not null then
      select
        upgrade.id,
        upgrade.target_product_id,
        upgrade.target_quantity,
        upgrade.customer_difference_usd_snapshot
      into upgrade_row
      from public.crm_play_benefit_upgrades upgrade
      where upgrade.id = new.crm_play_benefit_upgrade_id
        and upgrade.play_benefit_id = benefit_row.id
        and upgrade.play_id = member_row.play_id;

      if upgrade_row.id is null then
        raise exception 'La ampliación no pertenece al beneficio seleccionado.' using errcode = '42501';
      end if;

      expected_product_id := upgrade_row.target_product_id;
      expected_quantity := upgrade_row.target_quantity;
      expected_line_total_usd := coalesce(upgrade_row.customer_difference_usd_snapshot, 0);
    end if;

    if new.product_id is distinct from expected_product_id
      or pg_catalog.abs(coalesce(new.qty, 0) - expected_quantity) > 0.001
    then
      raise exception 'El producto final no corresponde al beneficio o ampliación seleccionada.'
        using errcode = '22023';
    end if;

    select exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = member_row.id
        and redemption.play_benefit_id = benefit_row.id
        and redemption.order_id = new.order_id
        and redemption.status = 'redeemed'
    ) into is_existing_redemption;

    if not is_existing_redemption then
      if member_row.play_status <> 'active'
        or (member_row.starts_at is not null and pg_catalog.now() < member_row.starts_at)
        or (member_row.ends_at is not null and pg_catalog.now() >= member_row.ends_at)
        or member_row.benefit_status not in ('available', 'reserved')
      then
        raise exception 'El beneficio de esta jugada ya no está disponible.' using errcode = '55000';
      end if;
    end if;

    expected_line_total_usd := pg_catalog.round(greatest(0, expected_line_total_usd), 2);
    expected_unit_price_usd := case
      when expected_quantity > 0 then pg_catalog.round(expected_line_total_usd / expected_quantity, 2)
      else 0
    end;

    new.pricing_origin_currency := 'USD';
    new.pricing_origin_amount := expected_unit_price_usd;
    new.unit_price_usd_snapshot := expected_unit_price_usd;
    new.line_total_usd := expected_line_total_usd;

    if order_row.fx_rate is not null and order_row.fx_rate > 0 then
      new.unit_price_bs_snapshot := pg_catalog.round(expected_unit_price_usd * order_row.fx_rate, 2);
      new.line_total_bs_snapshot := pg_catalog.round(expected_line_total_usd * order_row.fx_rate, 2);
    end if;
  end if;

  select nullif(pg_catalog.string_agg(clean_line, E'\n' order by line_number), '')
  into new.notes
  from (
    select pg_catalog.btrim(part.line) as clean_line, part.line_number
    from pg_catalog.regexp_split_to_table(coalesce(new.notes, ''), E'\\r?\\n')
      with ordinality as part(line, line_number)
    where pg_catalog.btrim(part.line) <> ''
      and pg_catalog.lower(pg_catalog.btrim(part.line)) not like '@crm|%'
  ) visible_lines;

  return new;
end;
$$;

revoke all on function app_private.crm_order_item_guard_v1() from public, anon, authenticated;
grant execute on function app_private.crm_order_item_guard_v1() to service_role;

drop trigger if exists crm_order_items_guard on public.order_items;
create trigger crm_order_items_guard
before insert or update on public.order_items
for each row execute function app_private.crm_order_item_guard_v1();

-- The legacy pricing guards continue protecting ordinary items. CRM-bound items have
-- already been validated and priced by crm_order_items_guard, so their frozen benefit
-- price must not be replaced by the catalog price.
create or replace function public.trg_order_items_pricing_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_effective_price numeric(12,2);
  v_price_fields_changed boolean;
  v_product_price numeric(12,2);
  v_is_crm_item boolean := new.crm_play_member_id is not null;
begin
  if tg_op = 'INSERT' then
    if not public.is_admin() then
      if not v_is_crm_item then
        select pg_catalog.round(coalesce(product.base_price_usd, 0)::numeric, 2)
        into v_product_price
        from public.products product
        where product.id = new.product_id;

        if not found then
          raise exception 'Product % not found for order item insert', new.product_id;
        end if;

        new.unit_price_usd_snapshot := v_product_price;
      end if;

      new.override_unit_price_usd := null;
      new.override_reason := null;
      new.override_approved_by := null;
      new.override_approved_at := null;
    elsif not v_is_crm_item and new.unit_price_usd_snapshot is null then
      select pg_catalog.round(coalesce(product.base_price_usd, 0)::numeric, 2)
      into v_product_price
      from public.products product
      where product.id = new.product_id;

      if not found then
        raise exception 'Product % not found for order item insert', new.product_id;
      end if;

      new.unit_price_usd_snapshot := v_product_price;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    v_price_fields_changed :=
      (new.unit_price_usd_snapshot is distinct from old.unit_price_usd_snapshot)
      or (new.override_unit_price_usd is distinct from old.override_unit_price_usd)
      or (new.override_reason is distinct from old.override_reason);

    if v_price_fields_changed and not public.is_admin() then
      raise exception 'Only ADMIN can change item pricing or set an override.';
    end if;
  end if;

  if new.override_unit_price_usd is not null then
    if coalesce(nullif(pg_catalog.btrim(new.override_reason), ''), '') = '' then
      raise exception 'override_reason is required when override_unit_price_usd is set.';
    end if;

    if tg_op = 'INSERT'
      or (tg_op = 'UPDATE' and (
        new.override_unit_price_usd is distinct from old.override_unit_price_usd
        or new.override_reason is distinct from old.override_reason
      ))
    then
      new.override_approved_by := coalesce(auth.uid(), new.override_approved_by);
      new.override_approved_at := pg_catalog.now();
    end if;
  else
    new.override_reason := null;
    new.override_approved_by := null;
    new.override_approved_at := null;
  end if;

  v_effective_price := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);
  new.line_total_usd := pg_catalog.round((new.qty * v_effective_price)::numeric, 2);
  return new;
end;
$$;

create or replace function public.trg_order_items_set_pricing()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_product record;
  v_unit_price numeric;
  v_is_counter_direct_sale boolean := false;
  v_is_crm_item boolean := new.crm_play_member_id is not null;
  v_fx_rate numeric;
begin
  if new.override_unit_price_usd is not null
    or new.override_reason is not null
    or new.override_approved_by is not null
    or new.override_approved_at is not null
  then
    if not public.is_admin() then
      raise exception 'Only ADMIN can change item pricing or set an override.';
    end if;
  end if;

  select
    product.id,
    product.sku,
    product.name,
    product.base_price_usd,
    product.base_price_bs,
    product.source_price_currency,
    product.source_price_amount,
    coalesce(order_data.extra_fields #>> '{counter,quick_sale}', 'false') = 'true' as is_counter_direct_sale,
    case
      when coalesce(order_data.extra_fields #>> '{counter,quick_sale}', 'false') = 'true'
        then nullif(order_data.extra_fields #>> '{pricing,fx_rate}', '')::numeric
      else null
    end as fx_rate
  into v_product
  from public.products product
  join public.orders order_data on order_data.id = new.order_id
  where product.id = new.product_id;

  if not found then
    raise exception 'Invalid product_id';
  end if;

  v_is_counter_direct_sale := v_product.is_counter_direct_sale;
  v_fx_rate := v_product.fx_rate;

  if tg_op = 'INSERT' then
    new.sku_snapshot := v_product.sku;
    new.product_name_snapshot := v_product.name;

    if v_is_crm_item then
      v_unit_price := coalesce(new.unit_price_usd_snapshot, 0);
      new.line_total_usd := pg_catalog.round(coalesce(new.qty, 0) * v_unit_price, 2);
      return new;
    end if;

    if v_is_counter_direct_sale then
      if v_fx_rate is null or v_fx_rate <= 0 then
        raise exception 'counter_exchange_rate_invalid';
      end if;

      new.pricing_origin_currency := v_product.source_price_currency::text;
      new.pricing_origin_amount := v_product.source_price_amount;

      if v_product.source_price_currency::text = 'VES' then
        new.unit_price_bs_snapshot := pg_catalog.round(v_product.source_price_amount, 2);
        new.line_total_bs_snapshot := pg_catalog.round(v_product.source_price_amount * coalesce(new.qty, 0), 2);
        new.unit_price_usd_snapshot := pg_catalog.round(v_product.source_price_amount / v_fx_rate, 2);
        new.line_total_usd := pg_catalog.round(v_product.source_price_amount * coalesce(new.qty, 0) / v_fx_rate, 2);
      else
        new.unit_price_usd_snapshot := pg_catalog.round(v_product.source_price_amount, 2);
        new.line_total_usd := pg_catalog.round(v_product.source_price_amount * coalesce(new.qty, 0), 2);
        new.unit_price_bs_snapshot := pg_catalog.round(v_product.source_price_amount * v_fx_rate, 2);
        new.line_total_bs_snapshot := pg_catalog.round(v_product.source_price_amount * coalesce(new.qty, 0) * v_fx_rate, 2);
      end if;

      return new;
    end if;

    new.unit_price_usd_snapshot := v_product.base_price_usd;
  end if;

  v_unit_price := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);
  new.line_total_usd := coalesce(new.qty, 0) * coalesce(v_unit_price, 0);
  return new;
end;
$$;

-- Backfill the structural binding for every redemption that already has an item.
update public.order_items item
set
  crm_play_member_id = redemption.play_member_id,
  crm_play_benefit_id = redemption.play_benefit_id,
  crm_play_benefit_upgrade_id = redemption.play_benefit_upgrade_id
from public.crm_play_redemptions redemption
where redemption.order_item_id = item.id
  and redemption.status = 'redeemed'
  and (
    item.crm_play_member_id is distinct from redemption.play_member_id
    or item.crm_play_benefit_id is distinct from redemption.play_benefit_id
    or item.crm_play_benefit_upgrade_id is distinct from redemption.play_benefit_upgrade_id
  );

-- Legacy Gambit SKUs are play-only. Regular products remain in the ordinary catalog
-- even when a play also uses them.
update public.products product
set extra_fields = coalesce(product.extra_fields, '{}'::jsonb)
  || jsonb_build_object('catalog_access_scope', 'crm_only')
where product.type::text = 'gambit'
  and product.is_active = true
  and coalesce(product.extra_fields ->> 'catalog_access_scope', '') <> 'crm_only';

-- September was configured with a Loyal-only duplicate SKU as the base benefit for
-- both plays. Point the active plays to the regular Single Pack so it keeps its normal
-- catalog price and only becomes free through the structural CRM binding above.
alter table public.crm_play_benefits disable trigger crm_play_benefits_guard;

update public.crm_play_benefits benefit
set
  product_id = regular_product.id,
  product_name_snapshot = regular_product.name,
  source_price_currency_snapshot = regular_product.source_price_currency,
  source_price_amount_snapshot = regular_product.source_price_amount,
  catalog_price_usd_snapshot = pg_catalog.round(
    regular_product.source_price_amount / nullif(play.pricing_exchange_rate_ves_per_usd, 0),
    6
  )
from public.products regular_product, public.products legacy_product, public.crm_plays play
where benefit.play_id = play.id
  and play.name in ('Aniversario · septiembre de 2026', 'Loyal · septiembre de 2026')
  and benefit.product_id = legacy_product.id
  and legacy_product.sku = 'LOYAL_SINGLE_6'
  and regular_product.sku = 'SINGLE_6'
  and play.id = benefit.play_id;

alter table public.crm_play_benefits enable trigger crm_play_benefits_guard;

alter table public.crm_plays disable trigger crm_plays_guard;
alter table public.crm_plays disable trigger crm_play_terms_guard;

update public.crm_plays play
set gift_product_id = regular_product.id
from public.products regular_product, public.products legacy_product
where play.name in ('Aniversario · septiembre de 2026', 'Loyal · septiembre de 2026')
  and play.gift_product_id = legacy_product.id
  and legacy_product.sku = 'LOYAL_SINGLE_6'
  and regular_product.sku = 'SINGLE_6';

alter table public.crm_plays enable trigger crm_play_terms_guard;
alter table public.crm_plays enable trigger crm_plays_guard;

-- Repair order 2538: retain the one redeemed benefit, preserve the customer's chosen
-- composition, and remove the four manually loaded duplicate Gambit items.
update public.order_items redeemed_item
set
  product_id = regular_product.id,
  sku_snapshot = regular_product.sku,
  product_name_snapshot = regular_product.name,
  notes = coalesce(
    (
      select duplicate_item.notes
      from public.order_items duplicate_item
      join public.products duplicate_product on duplicate_product.id = duplicate_item.product_id
      where duplicate_item.order_id = order_data.id
        and duplicate_item.crm_play_member_id is null
        and duplicate_product.sku = 'ANIVERSARIO_SINGLEPACK'
      order by duplicate_item.id
      limit 1
    ),
    redeemed_item.notes
  )
from public.orders order_data,
  public.products regular_product,
  public.crm_play_redemptions redemption,
  public.crm_play_benefits benefit,
  public.crm_plays play
where order_data.order_number = 'VO-20260911-0265'
  and redeemed_item.order_id = order_data.id
  and redemption.order_item_id = redeemed_item.id
  and redemption.order_id = order_data.id
  and benefit.id = redemption.play_benefit_id
  and play.id = benefit.play_id
  and play.name = 'Aniversario · septiembre de 2026'
  and regular_product.sku = 'SINGLE_6';

alter table public.crm_play_redemptions disable trigger crm_play_redemptions_guard;

update public.crm_play_redemptions redemption
set product_id = regular_product.id
from public.orders order_data,
  public.products regular_product,
  public.crm_play_benefits benefit,
  public.crm_plays play
where order_data.order_number = 'VO-20260911-0265'
  and redemption.order_id = order_data.id
  and benefit.id = redemption.play_benefit_id
  and play.id = benefit.play_id
  and play.name = 'Aniversario · septiembre de 2026'
  and regular_product.sku = 'SINGLE_6';

alter table public.crm_play_redemptions enable trigger crm_play_redemptions_guard;

delete from public.order_items duplicate_item
using public.orders order_data, public.products duplicate_product
where order_data.order_number = 'VO-20260911-0265'
  and duplicate_item.order_id = order_data.id
  and duplicate_item.product_id = duplicate_product.id
  and duplicate_product.sku = 'ANIVERSARIO_SINGLEPACK'
  and duplicate_item.crm_play_member_id is null;

insert into public.order_events (
  order_id,
  order_number,
  event_type,
  event_group,
  title,
  message,
  severity,
  payload
)
select
  order_data.id,
  order_data.order_number,
  'system_correction',
  'crm',
  'Beneficio CRM corregido',
  'Se conservó un solo beneficio válido y se retiraron los productos Gambit duplicados.',
  'info',
  jsonb_build_object(
    'migration', 'crm_catalog_benefit_boundary',
    'order_number', order_data.order_number,
    'repair', 'kept_redeemed_item_and_removed_unbound_gambit_duplicates'
  )
from public.orders order_data
where order_data.order_number = 'VO-20260911-0265'
  and not exists (
    select 1
    from public.order_events existing_event
    where existing_event.order_id = order_data.id
      and existing_event.payload ->> 'migration' = 'crm_catalog_benefit_boundary'
  );

comment on column public.order_items.crm_play_member_id is
  'Structural CRM member binding. Null for ordinary catalog items.';
comment on column public.order_items.crm_play_benefit_id is
  'Structural CRM benefit binding used to authorize a play-specific item price.';
comment on column public.order_items.crm_play_benefit_upgrade_id is
  'Optional allowed upgrade whose frozen customer difference is charged on this item.';

commit;
