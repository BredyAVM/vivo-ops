-- Advisor order creation must be all-or-nothing. The order header, its items,
-- the initial timeline event and an optional draft conversion are committed in
-- one Postgres transaction. A failed item/CRM reservation therefore cannot
-- leave an active order with zero items.

begin;

alter table public.orders
  add column if not exists advisor_creation_idempotency_key uuid,
  add column if not exists advisor_creation_request_hash text;

create unique index if not exists orders_advisor_creation_idempotency_uk
  on public.orders(created_by_user_id, advisor_creation_idempotency_key)
  where advisor_creation_idempotency_key is not null;

create or replace function public.advisor_create_order_atomic_v1(
  p_request_id uuid,
  p_client_id bigint,
  p_fulfillment public.fulfillment_type,
  p_total_usd numeric,
  p_total_bs_snapshot numeric,
  p_delivery_address text,
  p_receiver_name text,
  p_receiver_phone text,
  p_notes text,
  p_extra_fields jsonb,
  p_items jsonb,
  p_draft_id bigint default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_request_hash text;
  v_existing public.orders%rowtype;
  v_draft public.advisor_order_drafts%rowtype;
  v_order_id bigint;
  v_order_number text;
  v_order_created_at timestamptz;
  v_order_total_usd numeric;
  v_order_total_bs numeric;
  v_inserted_items integer := 0;
  v_attempt integer;
  v_schedule jsonb;
begin
  if v_uid is null or not public.has_role('advisor') then
    raise exception 'Solo un asesor autenticado puede crear esta orden.'
      using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'No se pudo identificar este intento de creación.'
      using errcode = '22023';
  end if;

  if p_client_id is null or p_client_id <= 0 or not exists (
    select 1 from public.clients client where client.id = p_client_id
  ) then
    raise exception 'Selecciona un cliente válido antes de crear la orden.'
      using errcode = '22023';
  end if;

  if p_total_usd is null or p_total_usd < 0
     or p_total_bs_snapshot is null or p_total_bs_snapshot < 0 then
    raise exception 'Los totales de la orden no son válidos.'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_extra_fields) is distinct from 'object' then
    raise exception 'La información adicional de la orden no es válida.'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 200
     or exists (
       select 1
       from jsonb_array_elements(p_items) item
       where jsonb_typeof(item) is distinct from 'object'
     ) then
    raise exception 'Debes agregar entre 1 y 200 productos válidos.'
      using errcode = '22023';
  end if;

  v_request_hash := md5(jsonb_build_object(
    'client_id', p_client_id,
    'fulfillment', p_fulfillment::text,
    'total_usd', round(p_total_usd, 2),
    'total_bs_snapshot', round(p_total_bs_snapshot, 2),
    'delivery_address', nullif(btrim(coalesce(p_delivery_address, '')), ''),
    'receiver_name', nullif(btrim(coalesce(p_receiver_name, '')), ''),
    'receiver_phone', nullif(btrim(coalesce(p_receiver_phone, '')), ''),
    'notes', nullif(btrim(coalesce(p_notes, '')), ''),
    'extra_fields', p_extra_fields,
    'items', p_items,
    'draft_id', p_draft_id
  )::text);

  perform pg_advisory_xact_lock(
    hashtextextended('advisor-order-create:' || v_uid::text || ':' || p_request_id::text, 0)
  );

  select order_row.*
  into v_existing
  from public.orders order_row
  where order_row.created_by_user_id = v_uid
    and order_row.advisor_creation_idempotency_key = p_request_id;

  if found then
    if v_existing.advisor_creation_request_hash is distinct from v_request_hash then
      raise exception 'Este intento ya creó una orden con información diferente. Abre la orden creada antes de volver a intentarlo.'
        using errcode = '22023';
    end if;

    if not exists (
      select 1 from public.order_items item where item.order_id = v_existing.id
    ) then
      raise exception 'La solicitud anterior quedó incompleta y requiere revisión de Master.'
        using errcode = '23514';
    end if;

    return jsonb_build_object(
      'orderId', v_existing.id,
      'orderNumber', v_existing.order_number,
      'totalUsd', v_existing.total_usd,
      'totalBs', v_existing.total_bs_snapshot,
      'replayed', true
    );
  end if;

  if p_draft_id is not null then
    select draft.*
    into v_draft
    from public.advisor_order_drafts draft
    where draft.id = p_draft_id
      and draft.advisor_user_id = v_uid
    for update;

    if not found then
      raise exception 'No se encontró el borrador que estás convirtiendo.'
        using errcode = '22023';
    end if;

    if v_draft.status = 'converted' and v_draft.converted_order_id is not null then
      select order_row.*
      into v_existing
      from public.orders order_row
      where order_row.id = v_draft.converted_order_id
        and order_row.attributed_advisor_id = v_uid;

      if found and exists (
        select 1 from public.order_items item where item.order_id = v_existing.id
      ) then
        return jsonb_build_object(
          'orderId', v_existing.id,
          'orderNumber', v_existing.order_number,
          'totalUsd', v_existing.total_usd,
          'totalBs', v_existing.total_bs_snapshot,
          'replayed', true,
          'duplicateSource', 'converted_draft'
        );
      end if;
    end if;

    if v_draft.status not in ('draft', 'quoted') then
      raise exception 'Este borrador ya fue cerrado y no puede crear otra orden.'
        using errcode = '22023';
    end if;

    if coalesce(v_draft.payload #>> '{event_budget,kind}', '') = 'admin_event_budget' then
      raise exception 'Solo Administración puede convertir un presupuesto de evento.'
        using errcode = '42501';
    end if;
  end if;

  for v_attempt in 1..25 loop
    v_order_number := format(
      'VO-%s-%s',
      to_char(timezone('America/Caracas', statement_timestamp()), 'YYYYMMDD'),
      lpad(floor(random() * 10000)::integer::text, 4, '0')
    );

    begin
      insert into public.orders (
        order_number,
        client_id,
        created_by_user_id,
        source,
        attributed_advisor_id,
        fulfillment,
        delivery_address,
        receiver_name,
        receiver_phone,
        status,
        total_usd,
        total_bs_snapshot,
        notes,
        extra_fields,
        is_price_locked,
        advisor_creation_idempotency_key,
        advisor_creation_request_hash
      ) values (
        v_order_number,
        p_client_id,
        v_uid,
        'advisor',
        v_uid,
        p_fulfillment,
        case when p_fulfillment = 'delivery' then nullif(btrim(coalesce(p_delivery_address, '')), '') else null end,
        nullif(btrim(coalesce(p_receiver_name, '')), ''),
        nullif(btrim(coalesce(p_receiver_phone, '')), ''),
        'created',
        round(p_total_usd, 2),
        round(p_total_bs_snapshot, 2),
        nullif(btrim(coalesce(p_notes, '')), ''),
        p_extra_fields,
        false,
        p_request_id,
        v_request_hash
      )
      returning id, created_at
      into v_order_id, v_order_created_at;

      exit;
    exception
      when unique_violation then
        v_order_id := null;
        if v_attempt = 25 then
          raise exception 'No se pudo generar un número único para la orden. Intenta nuevamente.'
            using errcode = '23505';
        end if;
    end;
  end loop;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    pricing_origin_currency,
    pricing_origin_amount,
    unit_price_usd_snapshot,
    line_total_usd,
    unit_price_bs_snapshot,
    line_total_bs_snapshot,
    sku_snapshot,
    product_name_snapshot,
    notes,
    crm_play_member_id,
    crm_play_benefit_id,
    crm_play_benefit_upgrade_id
  )
  select
    v_order_id,
    input.product_id,
    input.qty,
    input.pricing_origin_currency,
    input.pricing_origin_amount,
    input.unit_price_usd_snapshot,
    input.line_total_usd,
    input.unit_price_bs_snapshot,
    input.line_total_bs_snapshot,
    nullif(btrim(coalesce(input.sku_snapshot, '')), ''),
    nullif(btrim(coalesce(input.product_name_snapshot, '')), ''),
    nullif(input.notes, ''),
    input.crm_play_member_id,
    input.crm_play_benefit_id,
    input.crm_play_benefit_upgrade_id
  from jsonb_to_recordset(p_items) as input(
    product_id bigint,
    qty numeric,
    pricing_origin_currency text,
    pricing_origin_amount numeric,
    unit_price_usd_snapshot numeric,
    line_total_usd numeric,
    unit_price_bs_snapshot numeric,
    line_total_bs_snapshot numeric,
    sku_snapshot text,
    product_name_snapshot text,
    notes text,
    crm_play_member_id bigint,
    crm_play_benefit_id bigint,
    crm_play_benefit_upgrade_id bigint
  );

  get diagnostics v_inserted_items = row_count;
  if v_inserted_items <> jsonb_array_length(p_items) then
    raise exception 'No se pudieron guardar todos los productos de la orden.'
      using errcode = '23514';
  end if;

  v_schedule := case
    when jsonb_typeof(p_extra_fields -> 'schedule') = 'object'
      then p_extra_fields -> 'schedule'
    else '{}'::jsonb
  end;

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload,
    created_at
  ) values (
    v_order_id,
    v_order_number,
    'order_created',
    'approval',
    'Orden creada',
    'La orden fue creada y quedó pendiente de aprobación.',
    'warning',
    v_uid,
    jsonb_build_object(
      'fulfillment', p_fulfillment,
      'source', 'advisor',
      'urgent', coalesce((v_schedule ->> 'asap')::boolean, false),
      'delivery_time', nullif(
        btrim(concat_ws(' ', v_schedule ->> 'date', v_schedule ->> 'time_24')),
        ''
      ),
      'advisor_creation_idempotency_key', p_request_id
    ),
    v_order_created_at
  );

  if p_draft_id is not null then
    update public.advisor_order_drafts
    set
      status = 'converted',
      converted_order_id = v_order_id,
      converted_at = statement_timestamp()
    where id = p_draft_id
      and advisor_user_id = v_uid;

    if not found then
      raise exception 'No se pudo cerrar el borrador convertido.'
        using errcode = '23514';
    end if;
  end if;

  select order_row.total_usd, order_row.total_bs_snapshot
  into v_order_total_usd, v_order_total_bs
  from public.orders order_row
  where order_row.id = v_order_id;

  return jsonb_build_object(
    'orderId', v_order_id,
    'orderNumber', v_order_number,
    'totalUsd', v_order_total_usd,
    'totalBs', v_order_total_bs,
    'replayed', false
  );
end;
$function$;

revoke all on function public.advisor_create_order_atomic_v1(
  uuid,
  bigint,
  public.fulfillment_type,
  numeric,
  numeric,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  bigint
) from public, anon, service_role;

grant execute on function public.advisor_create_order_atomic_v1(
  uuid,
  bigint,
  public.fulfillment_type,
  numeric,
  numeric,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  bigint
) to authenticated;

comment on column public.orders.advisor_creation_idempotency_key is
  'Stable browser attempt key used to replay an advisor order creation without duplicating it.';

comment on column public.orders.advisor_creation_request_hash is
  'Canonical request fingerprint paired with the advisor creation idempotency key.';

comment on function public.advisor_create_order_atomic_v1(
  uuid,
  bigint,
  public.fulfillment_type,
  numeric,
  numeric,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  bigint
) is
  'Creates an advisor order, all items, its initial event and draft conversion atomically and idempotently.';

commit;
