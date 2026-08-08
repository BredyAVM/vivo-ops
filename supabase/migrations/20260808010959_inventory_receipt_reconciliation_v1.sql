-- Block 11: expected receipts and physical receipt reconciliation.
-- Reuses planned flows, lots, presentations, movements, and the canonical balance.
-- No receipt table and no parallel stock balance are introduced.

alter table public.inventory_planned_flows
  add column operation_id uuid,
  add column capture_details jsonb not null default '{}'::jsonb;

alter table public.inventory_lots
  add column planned_flow_id bigint,
  add column capture_details jsonb not null default '{}'::jsonb;

alter table public.inventory_planned_flows
  drop constraint inventory_planned_flows_quantity_check;

alter table public.inventory_planned_flows
  add constraint inventory_planned_flows_quantity_check
  check (
    (flow_type = 'declared_unavailability' and quantity_units is null)
    or (
      flow_type = 'expected_receipt'
      and (quantity_units is null or quantity_units > 0)
    )
    or (
      flow_type not in ('declared_unavailability', 'expected_receipt')
      and quantity_units is not null
      and quantity_units > 0
    )
  ) not valid;

alter table public.inventory_planned_flows
  validate constraint inventory_planned_flows_quantity_check;

alter table public.inventory_planned_flows
  add constraint inventory_planned_flows_capture_details_object_check
  check (jsonb_typeof(capture_details) = 'object') not valid;

alter table public.inventory_planned_flows
  validate constraint inventory_planned_flows_capture_details_object_check;

alter table public.inventory_lots
  add constraint inventory_lots_capture_details_object_check
  check (jsonb_typeof(capture_details) = 'object') not valid;

alter table public.inventory_lots
  validate constraint inventory_lots_capture_details_object_check;

alter table public.inventory_lots
  add constraint inventory_lots_planned_flow_id_fkey
  foreign key (planned_flow_id)
  references public.inventory_planned_flows(id)
  on delete restrict
  not valid;

alter table public.inventory_lots
  validate constraint inventory_lots_planned_flow_id_fkey;

alter table public.inventory_lots
  add constraint inventory_lots_planned_receipt_shape_check
  check (planned_flow_id is null or lot_kind = 'receipt') not valid;

alter table public.inventory_lots
  validate constraint inventory_lots_planned_receipt_shape_check;

create unique index inventory_planned_flows_operation_uidx
  on public.inventory_planned_flows (operation_id)
  where operation_id is not null;

create unique index inventory_lots_planned_flow_uidx
  on public.inventory_lots (planned_flow_id)
  where planned_flow_id is not null;

comment on column public.inventory_planned_flows.operation_id is
  'Idempotency key for a user-created planned inventory fact.';
comment on column public.inventory_planned_flows.capture_details is
  'Validated frozen input snapshot for expected quantities and presentations.';
comment on column public.inventory_lots.planned_flow_id is
  'Expected receipt reconciled by this physical receipt lot. One receipt closes one expectation.';
comment on column public.inventory_lots.capture_details is
  'Validated frozen snapshot of the physical presentations and conversions received.';

-- Recover presentation defaults that already exist in the legacy item columns.
insert into public.inventory_item_presentations (
  inventory_item_id,
  name,
  base_units_per_presentation,
  allows_fractional_quantity,
  is_active
)
select
  item.id,
  btrim(item.packaging_name),
  item.packaging_size,
  item.inventory_group = 'sauces'
    or lower(item.packaging_name) similar to '%(galon|galón|kilo|recipiente)%',
  true
from public.inventory_items item
where item.merged_into_item_id is null
  and nullif(btrim(item.packaging_name), '') is not null
  and item.packaging_size > 0
on conflict do nothing;

-- Confirmed current-catalog receiving presentations from the inventory audit.
with presentation_seed(item_name, presentation_name, base_units, allows_fractional) as (
  values
    ('Dondys', 'Bolsa de 30', 30::numeric, false),
    ('Pepsi Lata', 'Caja de 24', 24::numeric, true),
    ('Malta Lata', 'Caja de 24', 24::numeric, true),
    ('Coca-Cola Lata', 'Caja de 12', 12::numeric, true),
    ('Yukypack', 'Caja de 24', 24::numeric, true),
    ('Pepsi 1 Lt', 'Paquete de 6', 6::numeric, true),
    ('Pepsi 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Pepsi 2 Lts', 'Paquete de 6', 6::numeric, true),
    ('Coca-Cola 1 Lt', 'Paquete de 6', 6::numeric, true),
    ('Coca-Cola 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Coca-Cola 2 Lts', 'Paquete de 6', 6::numeric, true),
    ('Coca-Cola Sin Azúcar 1 Lt', 'Paquete de 6', 6::numeric, true),
    ('Coca-Cola Sin Azúcar 2 Lts', 'Paquete de 6', 6::numeric, true),
    ('Chinotto 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Chinotto 2 Lts', 'Paquete de 6', 6::numeric, true),
    ('Fanta Naranja 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Frescolita 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Frescolita 2 Lts', 'Paquete de 6', 6::numeric, true),
    ('Jugo del Valle 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Lipton Durazno 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Lipton Limón 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Yukery Manzana 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Yukery Naranja 1,5 Lts', 'Paquete de 6', 6::numeric, true),
    ('Yukery Pera 1,5 Lts', 'Paquete de 6', 6::numeric, true)
)
insert into public.inventory_item_presentations (
  inventory_item_id,
  name,
  base_units_per_presentation,
  allows_fractional_quantity,
  is_active
)
select
  item.id,
  seed.presentation_name,
  seed.base_units,
  seed.allows_fractional,
  true
from presentation_seed seed
join public.inventory_items item
  on item.name = seed.item_name
 and item.merged_into_item_id is null
on conflict do nothing;

create or replace function app_private.inventory_normalize_receipt_capture_v1(
  p_inventory_item_id bigint,
  p_capture jsonb,
  p_allow_unknown boolean
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_capture jsonb := coalesce(p_capture, '{}'::jsonb);
  v_unknown boolean;
  v_source_name text;
  v_loose_units numeric := 0;
  v_lines jsonb;
  v_line jsonb;
  v_presentation public.inventory_item_presentations%rowtype;
  v_presentation_id bigint;
  v_quantity numeric;
  v_factor numeric;
  v_line_units numeric;
  v_total numeric := 0;
  v_seen_ids bigint[] := array[]::bigint[];
  v_normalized_lines jsonb := '[]'::jsonb;
begin
  if p_inventory_item_id is null then
    raise exception 'inventory_item_id es obligatorio.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_capture) <> 'object' then
    raise exception 'La captura de presentaciones debe ser un objeto.' using errcode = '22023';
  end if;

  begin
    v_unknown := coalesce((v_capture ->> 'quantity_unknown')::boolean, false);
  exception when invalid_text_representation then
    raise exception 'quantity_unknown debe ser booleano.' using errcode = '22023';
  end;
  v_source_name := nullif(btrim(coalesce(v_capture ->> 'source_name', '')), '');
  if v_source_name is not null and char_length(v_source_name) > 160 then
    raise exception 'La fuente admite hasta 160 caracteres.' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(v_capture ->> 'loose_units', '')), '') is not null then
    begin
      v_loose_units := (v_capture ->> 'loose_units')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Las unidades sueltas no son válidas.' using errcode = '22023';
    end;
  end if;
  if v_loose_units < 0 then
    raise exception 'Las unidades sueltas no pueden ser negativas.' using errcode = '22023';
  end if;

  v_lines := coalesce(v_capture -> 'presentations', '[]'::jsonb);
  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) > 20 then
    raise exception 'La captura admite una lista de hasta 20 presentaciones.' using errcode = '22023';
  end if;

  if v_unknown then
    if not p_allow_unknown then
      raise exception 'Una recepción física requiere cantidad exacta.' using errcode = '22023';
    end if;
    if v_loose_units <> 0 or jsonb_array_length(v_lines) <> 0 then
      raise exception 'Una expectativa de cantidad desconocida no puede mezclar cantidades.'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'quantity_unknown', true,
      'source_name', v_source_name,
      'loose_units', 0,
      'presentations', '[]'::jsonb,
      'total_units', null
    );
  end if;

  for v_line in
    select line.value
    from jsonb_array_elements(v_lines) with ordinality line(value, ordinal)
    order by line.ordinal
  loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'Cada presentación debe ser un objeto.' using errcode = '22023';
    end if;
    begin
      v_presentation_id := (v_line ->> 'presentation_id')::bigint;
      v_quantity := (v_line ->> 'quantity')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Cada presentación requiere identificador y cantidad válidos.'
        using errcode = '22023';
    end;
    if v_presentation_id is null or v_quantity is null or v_quantity <= 0 then
      raise exception 'Cada cantidad de presentación debe ser mayor que cero.' using errcode = '22023';
    end if;
    if v_presentation_id = any(v_seen_ids) then
      raise exception 'Una presentación no puede repetirse en la misma captura.' using errcode = '22023';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_presentation_id);

    select presentation.*
    into v_presentation
    from public.inventory_item_presentations presentation
    where presentation.id = v_presentation_id
      and presentation.inventory_item_id = p_inventory_item_id
      and presentation.is_active;
    if not found then
      raise exception 'La presentación no pertenece al ítem o está inactiva.' using errcode = '22023';
    end if;
    if not v_presentation.allows_fractional_quantity and v_quantity <> trunc(v_quantity) then
      raise exception 'La presentación % solo admite cantidades enteras.', v_presentation.name
        using errcode = '22023';
    end if;

    if nullif(btrim(coalesce(v_line ->> 'base_units_per_presentation', '')), '') is null then
      v_factor := v_presentation.base_units_per_presentation;
    else
      begin
        v_factor := (v_line ->> 'base_units_per_presentation')::numeric;
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'La conversión indicada no es válida.' using errcode = '22023';
      end;
    end if;
    if v_factor is null or v_factor <= 0 then
      raise exception 'La conversión debe ser mayor que cero.' using errcode = '22023';
    end if;

    v_line_units := v_quantity * v_factor;
    v_total := v_total + v_line_units;
    v_normalized_lines := v_normalized_lines || jsonb_build_array(jsonb_build_object(
      'presentation_id', v_presentation.id,
      'presentation_name', v_presentation.name,
      'quantity', v_quantity,
      'base_units_per_presentation', v_factor,
      'default_base_units_per_presentation', v_presentation.base_units_per_presentation,
      'conversion_overridden', v_factor <> v_presentation.base_units_per_presentation,
      'base_units', v_line_units
    ));
  end loop;

  v_total := v_total + v_loose_units;
  if v_total <= 0 then
    raise exception 'La cantidad total debe ser mayor que cero o marcarse como desconocida.'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'quantity_unknown', false,
    'source_name', v_source_name,
    'loose_units', v_loose_units,
    'presentations', v_normalized_lines,
    'total_units', v_total
  );
end;
$$;

revoke all on function app_private.inventory_normalize_receipt_capture_v1(bigint, jsonb, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.inventory_save_expected_receipt_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_effective_at timestamptz,
  p_capture jsonb,
  p_notes text default null,
  p_replaces_flow_id bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.inventory_items%rowtype;
  v_capture jsonb;
  v_quantity numeric;
  v_existing public.inventory_planned_flows%rowtype;
  v_replaced public.inventory_planned_flows%rowtype;
  v_flow_id bigint;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Master o administración pueden declarar recepciones esperadas.'
      using errcode = '42501';
  end if;
  if p_operation_id is null or p_inventory_item_id is null or p_effective_at is null then
    raise exception 'operation_id, inventory_item_id y effective_at son obligatorios.'
      using errcode = '22023';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  select flow.*
  into v_existing
  from public.inventory_planned_flows flow
  where flow.operation_id = p_operation_id;
  if found then
    if v_existing.flow_type <> 'expected_receipt'
      or v_existing.inventory_item_id <> p_inventory_item_id
    then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'replayed',
      'expected_flow_id', v_existing.id,
      'inventory_item_id', v_existing.inventory_item_id,
      'quantity_units', v_existing.quantity_units,
      'effective_at', v_existing.effective_at,
      'capture_details', v_existing.capture_details
    );
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;
  if not found then
    raise exception 'Ítem de inventario no encontrado.' using errcode = 'P0002';
  end if;
  if not v_item.is_active
    or v_item.merged_into_item_id is not null
    or v_item.tracking_mode not in ('transactional', 'periodic_count')
  then
    raise exception 'El ítem no admite recepciones esperadas.' using errcode = '22023';
  end if;

  v_capture := app_private.inventory_normalize_receipt_capture_v1(
    v_item.id,
    p_capture,
    true
  );
  v_quantity := nullif(v_capture ->> 'total_units', '')::numeric;

  if p_replaces_flow_id is not null then
    select flow.*
    into v_replaced
    from public.inventory_planned_flows flow
    where flow.id = p_replaces_flow_id
    for update;
    if not found
      or v_replaced.flow_type <> 'expected_receipt'
      or v_replaced.inventory_item_id <> v_item.id
      or v_replaced.status not in ('draft', 'active')
    then
      raise exception 'La expectativa reemplazada no está activa o no corresponde al ítem.'
        using errcode = '22023';
    end if;
  end if;

  insert into public.inventory_planned_flows (
    inventory_item_id,
    flow_type,
    quantity_units,
    effective_at,
    status,
    depends_on_flow_id,
    notes,
    created_by_user_id,
    operation_id,
    capture_details
  )
  values (
    v_item.id,
    'expected_receipt',
    v_quantity,
    p_effective_at,
    'active',
    p_replaces_flow_id,
    nullif(btrim(p_notes), ''),
    v_actor,
    p_operation_id,
    v_capture
  )
  returning id into v_flow_id;

  if p_replaces_flow_id is not null then
    update public.inventory_planned_flows
    set status = 'cancelled',
        resolved_by_user_id = v_actor,
        resolved_at = v_now,
        updated_at = v_now,
        notes = case
          when notes is null then format('Reemplazada por expectativa #%s.', v_flow_id)
          else notes || E'\n' || format('Reemplazada por expectativa #%s.', v_flow_id)
        end
    where id = p_replaces_flow_id;
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'expected_flow_id', v_flow_id,
    'inventory_item_id', v_item.id,
    'quantity_units', v_quantity,
    'effective_at', p_effective_at,
    'capture_details', v_capture,
    'replaced_flow_id', p_replaces_flow_id
  );
end;
$$;

revoke all on function public.inventory_save_expected_receipt_v1(
  uuid, bigint, timestamptz, jsonb, text, bigint
) from public, anon;
grant execute on function public.inventory_save_expected_receipt_v1(
  uuid, bigint, timestamptz, jsonb, text, bigint
) to authenticated, service_role;

create or replace function public.inventory_cancel_expected_receipt_v1(
  p_expected_flow_id bigint,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_flow public.inventory_planned_flows%rowtype;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Master o administración pueden cancelar expectativas.'
      using errcode = '42501';
  end if;
  if p_expected_flow_id is null then
    raise exception 'expected_flow_id es obligatorio.' using errcode = '22023';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  select flow.*
  into v_flow
  from public.inventory_planned_flows flow
  where flow.id = p_expected_flow_id
  for update;
  if not found or v_flow.flow_type <> 'expected_receipt' then
    raise exception 'Expectativa de recepción no encontrada.' using errcode = 'P0002';
  end if;
  if v_flow.status = 'cancelled' then
    return jsonb_build_object('status', 'replayed', 'expected_flow_id', v_flow.id);
  end if;
  if v_flow.status not in ('draft', 'active') then
    raise exception 'La expectativa ya fue conciliada y no puede cancelarse.' using errcode = '22023';
  end if;

  update public.inventory_planned_flows
  set status = 'cancelled',
      resolved_by_user_id = v_actor,
      resolved_at = v_now,
      updated_at = v_now,
      notes = case
        when nullif(btrim(p_notes), '') is null then notes
        when notes is null then btrim(p_notes)
        else notes || E'\n' || btrim(p_notes)
      end
  where id = v_flow.id;

  return jsonb_build_object('status', 'applied', 'expected_flow_id', v_flow.id);
end;
$$;

revoke all on function public.inventory_cancel_expected_receipt_v1(bigint, text)
  from public, anon;
grant execute on function public.inventory_cancel_expected_receipt_v1(bigint, text)
  to authenticated, service_role;

create or replace function public.inventory_reconcile_receipt_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_capture jsonb,
  p_expected_flow_id bigint default null,
  p_lot_code text default null,
  p_received_at timestamptz default now(),
  p_expires_at timestamptz default null,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.inventory_items%rowtype;
  v_expected public.inventory_planned_flows%rowtype;
  v_existing_movement public.inventory_movements%rowtype;
  v_existing_lot public.inventory_lots%rowtype;
  v_capture jsonb;
  v_received_quantity numeric;
  v_difference numeric;
  v_lot_id bigint;
  v_expiry timestamptz;
  v_expected_status text;
  v_movement jsonb;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'kitchen'::public.user_role)
  ) then
    raise exception 'Solo cocina o administración pueden registrar mercancía recibida.'
      using errcode = '42501';
  end if;
  if p_operation_id is null or p_inventory_item_id is null then
    raise exception 'operation_id e inventory_item_id son obligatorios.' using errcode = '22023';
  end if;
  if p_received_at is null or p_received_at > now() + interval '5 minutes' then
    raise exception 'La fecha real de recepción no puede estar en el futuro.' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= p_received_at then
    raise exception 'El vencimiento debe ser posterior a la recepción.' using errcode = '22023';
  end if;
  if p_lot_code is not null and (
    btrim(p_lot_code) = '' or char_length(btrim(p_lot_code)) > 120
  ) then
    raise exception 'El código de lote admite entre 1 y 120 caracteres.' using errcode = '22023';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  select movement.*
  into v_existing_movement
  from public.inventory_movements movement
  where movement.operation_id = p_operation_id
    and movement.movement_type = 'inbound';
  if found then
    if v_existing_movement.inventory_item_id <> p_inventory_item_id then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;
    select lot.* into v_existing_lot
    from public.inventory_lots lot
    where lot.id = v_existing_movement.inventory_lot_id;
    if v_existing_lot.planned_flow_id is not null then
      select flow.* into v_expected
      from public.inventory_planned_flows flow
      where flow.id = v_existing_lot.planned_flow_id;
    end if;
    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object(
        'status', 'replayed',
        'inventory_lot_id', v_existing_movement.inventory_lot_id,
        'expected_flow_id', v_existing_lot.planned_flow_id,
        'expected_quantity_units', case
          when v_existing_lot.planned_flow_id is null then null
          else v_expected.quantity_units
        end,
        'received_quantity_units', v_existing_lot.initial_quantity_units,
        'difference_quantity_units', case
          when v_existing_lot.planned_flow_id is null or v_expected.quantity_units is null then null
          else v_existing_lot.initial_quantity_units - v_expected.quantity_units
        end,
        'expected_flow_status', case
          when v_existing_lot.planned_flow_id is null then null
          else v_expected.status
        end,
        'capture_details', v_existing_lot.capture_details
      );
  end if;
  if exists (
    select 1 from public.inventory_movements movement
    where movement.operation_id = p_operation_id
  ) then
    raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;
  if not found then
    raise exception 'Ítem de inventario no encontrado.' using errcode = 'P0002';
  end if;
  if not v_item.is_active
    or v_item.merged_into_item_id is not null
    or v_item.tracking_mode not in ('transactional', 'periodic_count')
  then
    raise exception 'El ítem no admite entradas operativas.' using errcode = '22023';
  end if;
  if not app_private.inventory_item_is_initialized_v1(v_item.id) then
    raise exception 'El ítem requiere una apertura aceptada antes de recibir mercancía.'
      using errcode = '22023';
  end if;

  v_capture := app_private.inventory_normalize_receipt_capture_v1(
    v_item.id,
    p_capture,
    false
  );
  v_received_quantity := (v_capture ->> 'total_units')::numeric;

  if p_expected_flow_id is not null then
    select flow.*
    into v_expected
    from public.inventory_planned_flows flow
    where flow.id = p_expected_flow_id
    for update;
    if not found
      or v_expected.flow_type <> 'expected_receipt'
      or v_expected.inventory_item_id <> v_item.id
      or v_expected.status not in ('draft', 'active')
    then
      raise exception 'La expectativa ya no está activa o no corresponde al ítem.'
        using errcode = '22023';
    end if;
  end if;

  v_expiry := coalesce(
    p_expires_at,
    case
      when v_item.shelf_life_days is not null and v_item.shelf_life_days > 0
        then p_received_at + make_interval(days => v_item.shelf_life_days)
      else null
    end
  );

  insert into public.inventory_lots (
    inventory_item_id,
    lot_code,
    lot_kind,
    received_or_produced_at,
    expires_at,
    initial_quantity_units,
    status,
    notes,
    created_by_user_id,
    planned_flow_id,
    capture_details
  )
  values (
    v_item.id,
    nullif(btrim(p_lot_code), ''),
    'receipt',
    p_received_at,
    v_expiry,
    v_received_quantity,
    'open',
    nullif(btrim(p_notes), ''),
    v_actor,
    p_expected_flow_id,
    v_capture
  )
  returning id into v_lot_id;

  v_movement := app_private.inventory_apply_delta_v1(
    p_operation_id,
    v_item.id,
    'inbound',
    v_received_quantity,
    case when p_expected_flow_id is null then 'unplanned_merchandise_receipt'
         else 'expected_merchandise_receipt' end,
    p_notes,
    null,
    v_lot_id,
    v_actor,
    null
  );

  if p_expected_flow_id is not null then
    v_difference := case
      when v_expected.quantity_units is null then null
      else v_received_quantity - v_expected.quantity_units
    end;
    v_expected_status := case
      when v_difference is null or v_difference = 0 then 'fulfilled'
      else 'failed'
    end;

    update public.inventory_planned_flows
    set status = v_expected_status,
        resolved_by_user_id = v_actor,
        resolved_at = v_now,
        updated_at = v_now
    where id = v_expected.id;
  end if;

  return v_movement || jsonb_build_object(
    'status', 'applied',
    'inventory_lot_id', v_lot_id,
    'expected_flow_id', p_expected_flow_id,
    'expected_quantity_units', case when p_expected_flow_id is null then null else v_expected.quantity_units end,
    'received_quantity_units', v_received_quantity,
    'difference_quantity_units', v_difference,
    'expected_flow_status', v_expected_status,
    'capture_details', v_capture
  );
end;
$$;

revoke all on function public.inventory_reconcile_receipt_v1(
  uuid, bigint, jsonb, bigint, text, timestamptz, timestamptz, text
) from public, anon;
grant execute on function public.inventory_reconcile_receipt_v1(
  uuid, bigint, jsonb, bigint, text, timestamptz, timestamptz, text
) to authenticated, service_role;

create or replace function public.inventory_receipt_workspace_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_can_plan boolean;
  v_can_receive boolean;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  select
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
    ),
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role in ('admin'::public.user_role, 'kitchen'::public.user_role)
    )
  into v_can_plan, v_can_receive;

  if not v_can_plan and not v_can_receive then
    raise exception 'No tienes permiso para consultar recepciones de inventario.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'permissions', jsonb_build_object(
      'can_plan', v_can_plan,
      'can_receive', v_can_receive
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'name', item.name,
        'unit_name', item.unit_name,
        'inventory_group', item.inventory_group,
        'current_stock_units', item.current_stock_units,
        'shelf_life_days', item.shelf_life_days,
        'initialized', app_private.inventory_item_has_accepted_opening_v1(item.id)
      ) order by item.inventory_group, item.name, item.id)
      from public.inventory_items item
      where item.is_active
        and item.merged_into_item_id is null
        and item.tracking_mode in ('transactional', 'periodic_count')
    ), '[]'::jsonb),
    'presentations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', presentation.id,
        'inventory_item_id', presentation.inventory_item_id,
        'name', presentation.name,
        'base_units_per_presentation', presentation.base_units_per_presentation,
        'allows_fractional_quantity', presentation.allows_fractional_quantity
      ) order by presentation.inventory_item_id, presentation.name, presentation.id)
      from public.inventory_item_presentations presentation
      join public.inventory_items item on item.id = presentation.inventory_item_id
      where presentation.is_active
        and item.is_active
        and item.merged_into_item_id is null
    ), '[]'::jsonb),
    'active_expectations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', flow.id,
        'inventory_item_id', flow.inventory_item_id,
        'item_name', item.name,
        'unit_name', item.unit_name,
        'quantity_units', flow.quantity_units,
        'effective_at', flow.effective_at,
        'status', flow.status,
        'notes', flow.notes,
        'capture_details', flow.capture_details,
        'created_at', flow.created_at,
        'is_overdue', flow.effective_at < now()
      ) order by flow.effective_at, item.name, flow.id)
      from public.inventory_planned_flows flow
      join public.inventory_items item on item.id = flow.inventory_item_id
      where flow.flow_type = 'expected_receipt'
        and flow.status in ('draft', 'active')
    ), '[]'::jsonb),
    'recent_receipts', coalesce((
      select jsonb_agg(receipt.payload order by receipt.received_at desc, receipt.lot_id desc)
      from (
        select
          lot.id as lot_id,
          lot.received_or_produced_at as received_at,
          jsonb_build_object(
            'lot_id', lot.id,
            'inventory_item_id', lot.inventory_item_id,
            'item_name', item.name,
            'unit_name', item.unit_name,
            'received_quantity_units', lot.initial_quantity_units,
            'received_at', lot.received_or_produced_at,
            'expires_at', lot.expires_at,
            'lot_code', lot.lot_code,
            'notes', lot.notes,
            'capture_details', lot.capture_details,
            'expected_flow_id', flow.id,
            'expected_quantity_units', flow.quantity_units,
            'expected_status', flow.status,
            'difference_quantity_units', case
              when flow.id is null or flow.quantity_units is null then null
              else lot.initial_quantity_units - flow.quantity_units
            end
          ) as payload
        from public.inventory_lots lot
        join public.inventory_items item on item.id = lot.inventory_item_id
        left join public.inventory_planned_flows flow on flow.id = lot.planned_flow_id
        where lot.lot_kind = 'receipt'
        order by lot.received_or_produced_at desc, lot.id desc
        limit 100
      ) receipt
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'active_expectations', (
        select count(*) from public.inventory_planned_flows flow
        where flow.flow_type = 'expected_receipt' and flow.status in ('draft', 'active')
      ),
      'overdue_expectations', (
        select count(*) from public.inventory_planned_flows flow
        where flow.flow_type = 'expected_receipt'
          and flow.status in ('draft', 'active')
          and flow.effective_at < now()
      ),
      'receipt_mismatches', (
        select count(*)
        from public.inventory_lots lot
        join public.inventory_planned_flows flow on flow.id = lot.planned_flow_id
        where lot.lot_kind = 'receipt'
          and flow.quantity_units is not null
          and lot.initial_quantity_units <> flow.quantity_units
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.inventory_receipt_workspace_v1()
  from public, anon;
grant execute on function public.inventory_receipt_workspace_v1()
  to authenticated, service_role;

comment on function app_private.inventory_normalize_receipt_capture_v1(bigint, jsonb, boolean) is
  'Validates and freezes presentation conversions into canonical base units.';
comment on function public.inventory_save_expected_receipt_v1(uuid, bigint, timestamptz, jsonb, text, bigint) is
  'Master/Admin idempotent command to create or replace an expected receipt without increasing stock.';
comment on function public.inventory_cancel_expected_receipt_v1(bigint, text) is
  'Master/Admin idempotent cancellation of an unresolved expected receipt.';
comment on function public.inventory_reconcile_receipt_v1(uuid, bigint, jsonb, bigint, text, timestamptz, timestamptz, text) is
  'Kitchen/Admin physical receipt: creates a lot, increases canonical stock, and fully closes one expectation.';
comment on function public.inventory_receipt_workspace_v1() is
  'Role-aware receipt workspace read model for Inventory and future Kitchen/Master adapters.';
