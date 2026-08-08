-- Block 10: reviewed incremental opening and activation of Block 9 drafts.
-- No tables or columns are introduced. Drafts remain inactive until their
-- configuration is valid and every tracked item has an accepted opening path.

create or replace function app_private.inventory_item_has_accepted_opening_v1(
  p_inventory_item_id bigint
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive accepted_paths as (
    select
      count_header.id,
      count_header.parent_count_id,
      count_header.count_kind
    from public.inventory_counts count_header
    join public.inventory_count_lines count_line
      on count_line.inventory_count_id = count_header.id
    join public.inventory_movements movement
      on movement.id = count_line.movement_id
    where count_line.inventory_item_id = p_inventory_item_id
      and count_header.status = 'accepted'
      and count_line.line_status = 'accepted'
      and movement.operation_id is not null
      and not exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversal_of_movement_id = movement.id
      )

    union

    select
      parent.id,
      parent.parent_count_id,
      parent.count_kind
    from accepted_paths child
    join public.inventory_counts parent on parent.id = child.parent_count_id
  )
  select
    app_private.inventory_item_is_initialized_v1(p_inventory_item_id)
    and exists (
      select 1
      from accepted_paths accepted_path
      where accepted_path.count_kind = 'opening'
    );
$$;

revoke all on function app_private.inventory_item_has_accepted_opening_v1(bigint)
  from public, anon, authenticated, service_role;

create or replace function app_private.inventory_item_is_staged_draft_v1(
  p_inventory_item_id bigint
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.inventory_items item
    where item.id = p_inventory_item_id
      and not item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count', 'not_tracked')
      and not exists (
        select 1
        from public.inventory_movements legacy_movement
        where legacy_movement.inventory_item_id = item.id
          and legacy_movement.operation_id is null
      )
      and not exists (
        select 1
        from public.inventory_movements canonical_movement
        where canonical_movement.inventory_item_id = item.id
          and canonical_movement.operation_id is not null
          and not (
            (
              canonical_movement.movement_type = 'stock_count'
              and canonical_movement.reason_code in ('opening_balance', 'physical_count')
            )
            or (
              canonical_movement.movement_type = 'reversal'
              and exists (
                select 1
                from public.inventory_movements original
                where original.id = canonical_movement.reversal_of_movement_id
                  and original.inventory_item_id = item.id
                  and original.movement_type = 'stock_count'
              )
            )
          )
      )
  );
$$;

revoke all on function app_private.inventory_item_is_staged_draft_v1(bigint)
  from public, anon, authenticated, service_role;

create or replace function app_private.inventory_catalog_is_ready_v1()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with eligible_items as (
    select item.id
    from public.inventory_items item
    where item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
  )
  select
    exists (select 1 from eligible_items)
    and not exists (
      select 1
      from eligible_items eligible
      where not app_private.inventory_item_has_accepted_opening_v1(eligible.id)
    );
$$;

revoke all on function app_private.inventory_catalog_is_ready_v1()
  from public, anon, authenticated, service_role;

create or replace function public.inventory_cutover_mode_v1()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in (
        'admin'::public.user_role,
        'master'::public.user_role,
        'counter'::public.user_role
      )
  ) then
    raise exception 'No tienes permiso para consultar el modo de inventario.' using errcode = '42501';
  end if;

  if app_private.inventory_catalog_is_ready_v1() then
    return 'canonical';
  end if;

  if exists (
    select 1
    from public.inventory_counts count_header
    join public.inventory_count_lines count_line
      on count_line.inventory_count_id = count_header.id
    join public.inventory_items item
      on item.id = count_line.inventory_item_id
    where count_header.count_kind = 'opening'
      and item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
  ) then
    return 'opening';
  end if;

  return 'legacy';
end;
$$;

revoke all on function public.inventory_cutover_mode_v1()
  from public, anon;
grant execute on function public.inventory_cutover_mode_v1()
  to authenticated;

create or replace function public.inventory_opening_status_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Master o administracion pueden consultar la apertura.'
      using errcode = '42501';
  end if;

  with eligible_items as (
    select
      item.id,
      item.name,
      coalesce(item.inventory_group, 'other') as inventory_group,
      coalesce(item.unit_name, 'unidad') as unit_name,
      item.tracking_mode
    from public.inventory_items item
    where item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
  ),
  item_statuses as (
    select
      eligible.id,
      eligible.name,
      eligible.inventory_group,
      eligible.unit_name,
      eligible.tracking_mode,
      latest_count.inventory_count_id,
      case
        when app_private.inventory_item_has_accepted_opening_v1(eligible.id) then 'accepted'
        when app_private.inventory_item_is_initialized_v1(eligible.id) then 'under_review'
        else 'pending'
      end as opening_status
    from eligible_items eligible
    left join lateral (
      select count_header.id as inventory_count_id
      from public.inventory_count_lines count_line
      join public.inventory_counts count_header
        on count_header.id = count_line.inventory_count_id
      where count_line.inventory_item_id = eligible.id
        and (
          count_header.count_kind = 'opening'
          or exists (
            with recursive ancestors as (
              select parent.id, parent.parent_count_id, parent.count_kind
              from public.inventory_counts parent
              where parent.id = count_header.parent_count_id
              union
              select parent.id, parent.parent_count_id, parent.count_kind
              from ancestors child
              join public.inventory_counts parent on parent.id = child.parent_count_id
            )
            select 1 from ancestors where count_kind = 'opening'
          )
        )
      order by count_header.created_at desc, count_header.id desc
      limit 1
    ) latest_count on true
  ),
  totals as (
    select
      count(*)::integer as eligible_count,
      count(*) filter (where opening_status = 'accepted')::integer as accepted_count,
      count(*) filter (where opening_status = 'under_review')::integer as under_review_count,
      count(*) filter (where opening_status = 'pending')::integer as pending_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', id,
            'name', name,
            'inventory_group', inventory_group,
            'unit_name', unit_name,
            'tracking_mode', tracking_mode,
            'opening_status', opening_status,
            'inventory_count_id', inventory_count_id
          )
          order by inventory_group, name, id
        ),
        '[]'::jsonb
      ) as items
    from item_statuses
  )
  select jsonb_build_object(
    'eligible_count', totals.eligible_count,
    'accepted_count', totals.accepted_count,
    'under_review_count', totals.under_review_count,
    'pending_count', totals.pending_count,
    'ready', app_private.inventory_catalog_is_ready_v1(),
    'items', totals.items
  )
  into v_result
  from totals;

  return v_result;
end;
$$;

revoke all on function public.inventory_opening_status_v1()
  from public, anon;
grant execute on function public.inventory_opening_status_v1()
  to authenticated;

create or replace function public.inventory_submit_draft_opening_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_counted_quantity_units numeric,
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
  v_count_id bigint;
  v_movement jsonb;
  v_movement_id bigint;
  v_existing_count_id bigint;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administracion puede presentar la apertura incremental de un borrador.'
      using errcode = '42501';
  end if;
  if p_operation_id is null or p_inventory_item_id is null then
    raise exception 'operation_id e inventory_item_id son obligatorios.' using errcode = '22023';
  end if;
  if p_counted_quantity_units is null or p_counted_quantity_units < 0 then
    raise exception 'La existencia inicial debe ser mayor o igual a cero.' using errcode = '22023';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements movement
    where movement.operation_id = p_operation_id
  ) then
    select count_line.inventory_count_id
    into v_existing_count_id
    from public.inventory_count_lines count_line
    join public.inventory_movements movement on movement.id = count_line.movement_id
    where movement.operation_id = p_operation_id
      and movement.reason_code = 'opening_balance'
    limit 1;

    if v_existing_count_id is null then
      raise exception 'La clave idempotente ya pertenece a otra operacion.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object(
        'status', 'replayed',
        'inventory_count_id', v_existing_count_id,
        'inventory_item_id', p_inventory_item_id
      );
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Item de inventario no encontrado.' using errcode = 'P0002';
  end if;
  if not app_private.inventory_item_is_staged_draft_v1(v_item.id) then
    raise exception 'El item no es un borrador fisico elegible para apertura incremental.'
      using errcode = '22023';
  end if;
  if v_item.tracking_mode = 'not_tracked' then
    raise exception 'Un item no controlado no requiere apertura fisica.' using errcode = '22023';
  end if;
  if app_private.inventory_item_is_initialized_v1(v_item.id) then
    raise exception 'El item ya tiene una apertura canonica vigente.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.inventory_movements movement
    where movement.inventory_item_id = v_item.id
      and movement.operation_id is not null
      and not exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversal_of_movement_id = movement.id
      )
  ) then
    raise exception 'El item conserva una operacion canonica vigente y no puede abrirse de nuevo.'
      using errcode = '22023';
  end if;

  insert into public.inventory_counts (
    count_kind,
    status,
    responsible_role,
    requested_by_user_id,
    created_by_user_id,
    submitted_at,
    notes
  )
  values (
    'opening',
    'submitted',
    'admin'::public.user_role,
    v_actor,
    v_actor,
    v_now,
    nullif(btrim(p_notes), '')
  )
  returning id into v_count_id;

  v_movement := app_private.inventory_apply_delta_v1(
    p_operation_id,
    v_item.id,
    'stock_count',
    p_counted_quantity_units - v_item.current_stock_units,
    'opening_balance',
    coalesce(nullif(btrim(p_notes), ''), 'Apertura incremental de borrador'),
    null,
    null,
    v_actor,
    null
  );
  v_movement_id := (v_movement ->> 'movement_id')::bigint;

  insert into public.inventory_count_lines (
    inventory_count_id,
    inventory_item_id,
    expected_quantity_units,
    counted_quantity_units,
    line_status,
    note,
    movement_id,
    counted_by_user_id,
    counted_at
  )
  values (
    v_count_id,
    v_item.id,
    v_item.current_stock_units,
    p_counted_quantity_units,
    'submitted',
    nullif(btrim(p_notes), ''),
    v_movement_id,
    v_actor,
    v_now
  );

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object(
      'status', 'applied',
      'inventory_count_id', v_count_id,
      'inventory_item_id', v_item.id,
      'count_kind', 'opening'
    );
end;
$$;

revoke all on function public.inventory_submit_draft_opening_v1(uuid, bigint, numeric, text)
  from public, anon;
grant execute on function public.inventory_submit_draft_opening_v1(uuid, bigint, numeric, text)
  to authenticated;

create or replace function public.inventory_submit_staged_recount_v1(
  p_operation_id uuid,
  p_existing_count_id bigint,
  p_lines jsonb,
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
  v_is_admin boolean;
  v_is_kitchen boolean;
  v_count public.inventory_counts%rowtype;
  v_item_ids bigint[];
  v_line_count integer;
  v_distinct_count integer;
  v_line record;
  v_item public.inventory_items%rowtype;
  v_delta numeric;
  v_movement jsonb;
  v_movement_id bigint;
  v_existing_operation_count_id bigint;
  v_now timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;

  select
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor and role_row.role = 'admin'::public.user_role
    ),
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor and role_row.role = 'kitchen'::public.user_role
    )
  into v_is_admin, v_is_kitchen;

  if not v_is_admin and not v_is_kitchen then
    raise exception 'Solo cocina o administracion pueden presentar reconteos.' using errcode = '42501';
  end if;
  if p_operation_id is null or p_existing_count_id is null then
    raise exception 'operation_id y existing_count_id son obligatorios.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) <> 'array'
    or jsonb_array_length(p_lines) = 0
    or jsonb_array_length(p_lines) > 200
  then
    raise exception 'El reconteo debe contener entre 1 y 200 lineas.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) element
    where jsonb_typeof(element) <> 'object'
      or nullif(element ->> 'inventory_item_id', '') is null
      or nullif(element ->> 'counted_quantity_units', '') is null
      or (element ->> 'counted_quantity_units')::numeric < 0
  ) then
    raise exception 'Cada linea requiere item y cantidad no negativa.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements movement
    where movement.operation_id = p_operation_id
  ) then
    select count_line.inventory_count_id
    into v_existing_operation_count_id
    from public.inventory_count_lines count_line
    join public.inventory_movements movement on movement.id = count_line.movement_id
    where movement.operation_id = p_operation_id
    limit 1;

    if v_existing_operation_count_id is distinct from p_existing_count_id then
      raise exception 'La clave idempotente ya pertenece a otra operacion.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object(
        'status', 'replayed',
        'inventory_count_id', p_existing_count_id,
        'count_kind', 'recount'
      );
  end if;

  select
    count(*),
    count(distinct (element ->> 'inventory_item_id')::bigint),
    array_agg(
      distinct (element ->> 'inventory_item_id')::bigint
      order by (element ->> 'inventory_item_id')::bigint
    )
  into v_line_count, v_distinct_count, v_item_ids
  from jsonb_array_elements(p_lines) element;

  if v_line_count <> v_distinct_count then
    raise exception 'Un item no puede repetirse dentro del reconteo.' using errcode = '22023';
  end if;

  perform 1
  from public.inventory_items item
  where item.id = any(v_item_ids)
  order by item.id
  for update;

  if (select count(*) from public.inventory_items item where item.id = any(v_item_ids))
    <> cardinality(v_item_ids)
  then
    raise exception 'El reconteo contiene items inexistentes.' using errcode = '22023';
  end if;

  select count_header.*
  into v_count
  from public.inventory_counts count_header
  where count_header.id = p_existing_count_id
    and count_header.status = 'open'
    and count_header.count_kind = 'recount'
  for update;

  if not found then
    raise exception 'La solicitud de reconteo ya no esta abierta.' using errcode = '22023';
  end if;
  if not v_is_admin and v_count.responsible_role <> 'kitchen'::public.user_role then
    raise exception 'La solicitud no corresponde al rol de cocina.' using errcode = '42501';
  end if;
  if (
    select count(*)
    from public.inventory_count_lines count_line
    where count_line.inventory_count_id = v_count.id
      and count_line.line_status = 'pending'
  ) <> cardinality(v_item_ids)
    or exists (
      select 1
      from public.inventory_count_lines count_line
      where count_line.inventory_count_id = v_count.id
        and count_line.line_status = 'pending'
        and count_line.inventory_item_id <> all(v_item_ids)
    )
  then
    raise exception 'Las lineas enviadas no coinciden con la solicitud abierta.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.inventory_items item
    where item.id = any(v_item_ids)
      and (
        item.merged_into_item_id is not null
        or item.tracking_mode = 'not_tracked'
        or not app_private.inventory_item_is_initialized_v1(item.id)
        or (not item.is_active and not app_private.inventory_item_is_staged_draft_v1(item.id))
      )
  ) then
    raise exception 'El reconteo contiene un item no operativo o ajeno a borradores.'
      using errcode = '22023';
  end if;

  for v_line in
    select
      (element ->> 'inventory_item_id')::bigint as inventory_item_id,
      (element ->> 'counted_quantity_units')::numeric as counted_quantity_units,
      nullif(btrim(element ->> 'note'), '') as note
    from jsonb_array_elements(p_lines) element
    order by (element ->> 'inventory_item_id')::bigint
  loop
    select item.*
    into v_item
    from public.inventory_items item
    where item.id = v_line.inventory_item_id;

    v_delta := v_line.counted_quantity_units - v_item.current_stock_units;
    v_movement := app_private.inventory_apply_delta_v1(
      p_operation_id,
      v_item.id,
      'stock_count',
      v_delta,
      'physical_count',
      coalesce(v_line.note, nullif(btrim(p_notes), ''), 'Reconteo de apertura incremental'),
      null,
      null,
      v_actor,
      null
    );
    v_movement_id := (v_movement ->> 'movement_id')::bigint;

    update public.inventory_count_lines
    set counted_quantity_units = v_line.counted_quantity_units,
        line_status = 'submitted',
        note = coalesce(v_line.note, note),
        movement_id = v_movement_id,
        counted_by_user_id = v_actor,
        counted_at = v_now
    where inventory_count_id = v_count.id
      and inventory_item_id = v_item.id
      and line_status = 'pending';
  end loop;

  update public.inventory_counts
  set status = 'submitted',
      submitted_at = v_now,
      notes = coalesce(nullif(btrim(p_notes), ''), notes)
  where id = v_count.id;

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object(
      'status', 'applied',
      'inventory_count_id', v_count.id,
      'count_kind', 'recount'
    );
end;
$$;

revoke all on function public.inventory_submit_staged_recount_v1(uuid, bigint, jsonb, text)
  from public, anon;
grant execute on function public.inventory_submit_staged_recount_v1(uuid, bigint, jsonb, text)
  to authenticated;

create or replace function app_private.inventory_product_activation_diagnostics_v1(
  p_product_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive nodes as (
    select
      root.id as product_id,
      0 as depth,
      array[root.id]::bigint[] as path,
      false as has_cycle
    from public.products root
    where root.id = p_product_id

    union all

    select
      component.component_product_id,
      parent.depth + 1,
      parent.path || component.component_product_id,
      component.component_product_id = any(parent.path)
    from nodes parent
    join public.products parent_product on parent_product.id = parent.product_id
    join public.product_components component
      on component.parent_product_id = parent.product_id
    where parent_product.inventory_policy = 'components'
      and not parent.has_cycle
      and parent.depth < 16
  ),
  node_products as (
    select
      node.product_id,
      node.depth,
      node.path,
      node.has_cycle,
      product.name,
      product.is_active,
      product.inventory_policy,
      product.inventory_configuration_status,
      product.detail_units_limit,
      product.extra_fields
    from nodes node
    join public.products product on product.id = node.product_id
  ),
  node_links as (
    select
      node.product_id,
      node.depth,
      link.inventory_item_id,
      link.deduction_mode,
      item.name as inventory_item_name,
      item.is_active as item_is_active,
      item.tracking_mode,
      item.merged_into_item_id
    from node_products node
    join public.product_inventory_links link
      on link.product_id = node.product_id
     and link.configuration_version = 1
    left join public.inventory_items item on item.id = link.inventory_item_id
  ),
  errors as (
    select 'product_not_found'::text as code,
           format('El producto %s no existe.', p_product_id) as message
    where not exists (select 1 from public.products where id = p_product_id)

    union all
    select 'product_not_draft',
           'Solo puede activarse un producto inactivo con configuracion draft.'
    from public.products product
    where product.id = p_product_id
      and (product.is_active or product.inventory_configuration_status <> 'draft')

    union all
    select 'policy_missing',
           format('El producto %s no tiene politica canonica.', node.name)
    from node_products node
    where node.inventory_policy is null

    union all
    select 'component_not_ready',
           format('El componente %s debe estar activo y ready antes de activar el producto.', node.name)
    from node_products node
    where node.depth > 0
      and (not node.is_active or node.inventory_configuration_status <> 'ready')

    union all
    select 'component_cycle',
           format('La composicion contiene un ciclo en el producto %s.', node.product_id)
    from node_products node
    where node.has_cycle

    union all
    select 'component_depth_exceeded',
           'La composicion supera 16 niveles.'
    from node_products node
    where node.depth = 16
      and node.inventory_policy = 'components'

    union all
    select 'self_link_invalid',
           format('%s requiere exactamente un enlace self canonico.', node.name)
    from node_products node
    where node.inventory_policy = 'self'
      and (
        select count(*)
        from public.product_inventory_links link
        where link.product_id = node.product_id
          and link.configuration_version = 1
          and link.deduction_mode = 'self_link'
      ) <> 1

    union all
    select 'self_extra_link',
           format('%s contiene enlaces incompatibles con self.', node.name)
    from node_products node
    where node.inventory_policy = 'self'
      and exists (
        select 1
        from public.product_inventory_links link
        where link.product_id = node.product_id
          and link.configuration_version = 1
          and link.deduction_mode <> 'self_link'
      )

    union all
    select 'direct_link_missing',
           format('%s requiere al menos un enlace directo canonico.', node.name)
    from node_products node
    where node.inventory_policy = 'direct'
      and not exists (
        select 1
        from public.product_inventory_links link
        where link.product_id = node.product_id
          and link.configuration_version = 1
          and link.deduction_mode = 'recipe'
      )

    union all
    select 'direct_link_invalid',
           format('%s contiene enlaces incompatibles con direct.', node.name)
    from node_products node
    where node.inventory_policy = 'direct'
      and exists (
        select 1
        from public.product_inventory_links link
        where link.product_id = node.product_id
          and link.configuration_version = 1
          and link.deduction_mode <> 'recipe'
      )

    union all
    select 'components_missing',
           format('%s no tiene productos componentes.', node.name)
    from node_products node
    where node.inventory_policy = 'components'
      and not exists (
        select 1 from public.product_components component
        where component.parent_product_id = node.product_id
      )

    union all
    select 'components_with_physical_links',
           format('%s no debe tener enlaces fisicos directos.', node.name)
    from node_products node
    where node.inventory_policy = 'components'
      and exists (
        select 1 from public.product_inventory_links link
        where link.product_id = node.product_id
          and link.configuration_version = 1
      )

    union all
    select 'selectable_limit_missing',
           format('%s requiere un limite de seleccion mayor que cero.', node.name)
    from node_products node
    where node.inventory_policy = 'components'
      and node.detail_units_limit <= 0
      and exists (
        select 1 from public.product_components component
        where component.parent_product_id = node.product_id
          and component.component_mode = 'selectable'::public.product_component_mode
      )

    union all
    select 'none_has_configuration',
           format('%s es none y no puede tener enlaces ni componentes.', node.name)
    from node_products node
    where node.inventory_policy = 'none'
      and (
        exists (
          select 1 from public.product_inventory_links link
          where link.product_id = node.product_id
            and link.configuration_version = 1
        )
        or exists (
          select 1 from public.product_components component
          where component.parent_product_id = node.product_id
        )
      )

    union all
    select 'none_reason_missing',
           format('%s requiere una razon de no consumo.', node.name)
    from node_products node
    where node.depth = 0
      and node.inventory_policy = 'none'
      and char_length(btrim(coalesce(node.extra_fields ->> 'inventory_none_reason', ''))) < 3

    union all
    select 'inventory_item_missing',
           format('Un enlace de %s apunta a un item inexistente.', node.name)
    from node_products node
    join public.product_inventory_links link
      on link.product_id = node.product_id
     and link.configuration_version = 1
    left join public.inventory_items item on item.id = link.inventory_item_id
    where node.inventory_policy in ('self', 'direct')
      and item.id is null

    union all
    select 'inventory_item_invalid',
           format('El item %s no es una identidad fisica operativa.', link.inventory_item_name)
    from node_links link
    where link.inventory_item_name is not null
      and (
        link.merged_into_item_id is not null
        or link.tracking_mode = 'not_tracked'
      )

    union all
    select 'inventory_item_opening_pending',
           format('El item %s requiere una apertura aceptada antes de activar el producto.', link.inventory_item_name)
    from node_links link
    where link.inventory_item_name is not null
      and link.merged_into_item_id is null
      and link.tracking_mode in ('transactional', 'periodic_count')
      and not app_private.inventory_item_has_accepted_opening_v1(link.inventory_item_id)

    union all
    select 'inventory_item_inactive_dependency',
           format('El item %s pertenece a un componente ya activado pero esta inactivo.', link.inventory_item_name)
    from node_links link
    where link.depth > 0
      and not link.item_is_active

    union all
    select 'inventory_item_not_staged',
           format('El item %s esta inactivo pero no pertenece al flujo seguro de borradores.', link.inventory_item_name)
    from node_links link
    where link.depth = 0
      and not link.item_is_active
      and not app_private.inventory_item_is_staged_draft_v1(link.inventory_item_id)
  ),
  error_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('code', error_row.code, 'message', error_row.message)
        order by error_row.code, error_row.message
      ),
      '[]'::jsonb
    ) as value
    from errors error_row
  ),
  item_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'inventory_item_id', linked.inventory_item_id,
          'name', linked.inventory_item_name,
          'is_active', linked.item_is_active,
          'tracking_mode', linked.tracking_mode,
          'accepted_opening', app_private.inventory_item_has_accepted_opening_v1(linked.inventory_item_id),
          'will_activate', linked.depth = 0 and not linked.item_is_active
        )
        order by linked.inventory_item_id
      ),
      '[]'::jsonb
    ) as value
    from (
      select
        link.inventory_item_id,
        max(link.inventory_item_name) as inventory_item_name,
        bool_or(link.item_is_active) as item_is_active,
        max(link.tracking_mode) as tracking_mode,
        min(link.depth) as depth
      from node_links link
      where link.inventory_item_name is not null
      group by link.inventory_item_id
    ) linked
  )
  select jsonb_build_object(
    'product_id', p_product_id,
    'ready', jsonb_array_length(error_payload.value) = 0,
    'errors', error_payload.value,
    'items', item_payload.value,
    'items_to_activate', coalesce((
      select jsonb_agg(link.inventory_item_id order by link.inventory_item_id)
      from (
        select distinct node_link.inventory_item_id
        from node_links node_link
        where node_link.depth = 0
          and not node_link.item_is_active
      ) link
    ), '[]'::jsonb)
  )
  from error_payload, item_payload;
$$;

revoke all on function app_private.inventory_product_activation_diagnostics_v1(bigint)
  from public, anon, authenticated, service_role;

create or replace function public.inventory_activation_queue_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administracion puede consultar la cola de activacion.'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', product.id,
          'sku', product.sku,
          'name', product.name,
          'inventory_policy', product.inventory_policy,
          'diagnostics', diagnostics.value
        )
        order by product.created_at, product.id
      )
      from public.products product
      cross join lateral (
        select app_private.inventory_product_activation_diagnostics_v1(product.id) as value
      ) diagnostics
      where product.inventory_configuration_status = 'draft'
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', item.id,
          'name', item.name,
          'unit_name', item.unit_name,
          'tracking_mode', item.tracking_mode,
          'current_stock_units', item.current_stock_units,
          'opening_status', case
            when item.tracking_mode = 'not_tracked' then 'not_required'
            when app_private.inventory_item_has_accepted_opening_v1(item.id) then 'accepted'
            when app_private.inventory_item_is_initialized_v1(item.id) then 'under_review'
            else 'pending'
          end,
          'latest_count_id', latest_count.inventory_count_id,
          'can_activate', item.tracking_mode = 'not_tracked'
            or app_private.inventory_item_has_accepted_opening_v1(item.id),
          'needs_opening', item.tracking_mode <> 'not_tracked'
            and not app_private.inventory_item_is_initialized_v1(item.id),
          'linked_products', coalesce(linked_products.value, '[]'::jsonb)
        )
        order by item.created_at, item.id
      )
      from public.inventory_items item
      left join lateral (
        select count_header.id as inventory_count_id
        from public.inventory_count_lines count_line
        join public.inventory_counts count_header
          on count_header.id = count_line.inventory_count_id
        where count_line.inventory_item_id = item.id
        order by count_header.created_at desc, count_header.id desc
        limit 1
      ) latest_count on true
      left join lateral (
        select jsonb_agg(
          jsonb_build_object('id', product.id, 'name', product.name)
          order by product.name, product.id
        ) as value
        from public.product_inventory_links link
        join public.products product on product.id = link.product_id
        where link.inventory_item_id = item.id
          and link.configuration_version = 1
          and product.inventory_configuration_status = 'draft'
      ) linked_products on true
      where app_private.inventory_item_is_staged_draft_v1(item.id)
    ), '[]'::jsonb),
    'catalog_ready', app_private.inventory_catalog_is_ready_v1()
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.inventory_activation_queue_v1()
  from public, anon;
grant execute on function public.inventory_activation_queue_v1()
  to authenticated;

create or replace function public.inventory_activate_item_draft_v1(
  p_inventory_item_id bigint
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
  v_catalog_ready_before boolean;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administracion puede activar items de inventario.' using errcode = '42501';
  end if;
  if p_inventory_item_id is null then
    raise exception 'inventory_item_id es obligatorio.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory_item_activation:' || p_inventory_item_id::text, 0)
  );

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Item de inventario no encontrado.' using errcode = 'P0002';
  end if;
  if v_item.is_active then
    return jsonb_build_object(
      'status', 'replayed',
      'inventory_item_id', v_item.id,
      'is_active', true
    );
  end if;
  if not app_private.inventory_item_is_staged_draft_v1(v_item.id) then
    raise exception 'El item no pertenece al flujo seguro de borradores.' using errcode = '22023';
  end if;
  if v_item.tracking_mode <> 'not_tracked'
    and not app_private.inventory_item_has_accepted_opening_v1(v_item.id)
  then
    raise exception 'El item requiere una apertura aceptada antes de activarse.' using errcode = '22023';
  end if;

  v_catalog_ready_before := app_private.inventory_catalog_is_ready_v1();

  update public.inventory_items
  set is_active = true
  where id = v_item.id;

  if v_catalog_ready_before and not app_private.inventory_catalog_is_ready_v1() then
    raise exception 'La activacion intentaba devolver el catalogo al modo de apertura.'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'inventory_item_id', v_item.id,
    'is_active', true
  );
end;
$$;

revoke all on function public.inventory_activate_item_draft_v1(bigint)
  from public, anon;
grant execute on function public.inventory_activate_item_draft_v1(bigint)
  to authenticated;

create or replace function public.inventory_activate_product_draft_v1(
  p_product_id bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_product public.products%rowtype;
  v_diagnostics jsonb;
  v_first_error jsonb;
  v_item_ids bigint[];
  v_catalog_ready_before boolean;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administracion puede activar productos del catalogo.' using errcode = '42501';
  end if;
  if p_product_id is null then
    raise exception 'product_id es obligatorio.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory_product_activation:' || p_product_id::text, 0)
  );

  select product.*
  into v_product
  from public.products product
  where product.id = p_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado.' using errcode = 'P0002';
  end if;
  if v_product.is_active and v_product.inventory_configuration_status = 'ready' then
    return jsonb_build_object(
      'status', 'replayed',
      'product_id', v_product.id,
      'is_active', true,
      'configuration_status', 'ready'
    );
  end if;

  select array_agg(link.inventory_item_id order by link.inventory_item_id)
  into v_item_ids
  from public.product_inventory_links link
  where link.product_id = v_product.id
    and link.configuration_version = 1;

  if coalesce(cardinality(v_item_ids), 0) > 0 then
    perform 1
    from public.inventory_items item
    where item.id = any(v_item_ids)
    order by item.id
    for update;
  end if;

  v_diagnostics := app_private.inventory_product_activation_diagnostics_v1(v_product.id);
  if not coalesce((v_diagnostics ->> 'ready')::boolean, false) then
    v_first_error := v_diagnostics -> 'errors' -> 0;
    raise exception '[%] %',
      coalesce(v_first_error ->> 'code', 'activation_invalid'),
      coalesce(v_first_error ->> 'message', 'La configuracion no puede activarse.')
      using errcode = '22023', detail = (v_diagnostics -> 'errors')::text;
  end if;

  v_catalog_ready_before := app_private.inventory_catalog_is_ready_v1();

  update public.inventory_items item
  set is_active = true
  where item.id in (
    select (element.value #>> '{}')::bigint
    from jsonb_array_elements(v_diagnostics -> 'items_to_activate') element(value)
  );

  update public.product_inventory_links
  set is_active = true
  where product_id = v_product.id
    and configuration_version = 1;

  update public.products
  set is_active = true,
      inventory_configuration_status = 'ready',
      extra_fields = coalesce(extra_fields, '{}'::jsonb)
        || jsonb_build_object(
          'inventory_activation', jsonb_build_object(
            'activated_at', now(),
            'activated_by', v_actor,
            'configuration_version', 1
          )
        )
  where id = v_product.id;

  if v_catalog_ready_before and not app_private.inventory_catalog_is_ready_v1() then
    raise exception 'La activacion intentaba devolver el catalogo al modo de apertura.'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'product_id', v_product.id,
    'activated_inventory_item_ids', coalesce(v_diagnostics -> 'items_to_activate', '[]'::jsonb),
    'is_active', true,
    'configuration_status', 'ready'
  );
end;
$$;

revoke all on function public.inventory_activate_product_draft_v1(bigint)
  from public, anon;
grant execute on function public.inventory_activate_product_draft_v1(bigint)
  to authenticated;

comment on function app_private.inventory_item_has_accepted_opening_v1(bigint) is
  'Accepted opening authority, including an accepted recount descended from an opening.';
comment on function public.inventory_submit_draft_opening_v1(uuid, bigint, numeric, text) is
  'Admin-only blind opening for an inactive zero-stock draft. The item remains inactive for review.';
comment on function public.inventory_submit_staged_recount_v1(uuid, bigint, jsonb, text) is
  'Completes an open recount for active items or inactive staged drafts without bypassing review.';
comment on function public.inventory_activation_queue_v1() is
  'Admin-only activation queue with canonical diagnostics for Block 9 drafts.';
comment on function public.inventory_activate_item_draft_v1(bigint) is
  'Activates a staged item only after accepted opening when tracking requires stock.';
comment on function public.inventory_activate_product_draft_v1(bigint) is
  'Atomically validates and activates a product draft and eligible root physical items.';
