-- Block 16: read-only readiness audit for the canonical inventory cutover and integration sequence.
-- Reuses the existing catalog, opening, recipe, commitment, role, and ledger
-- structures. It never activates inventory, writes stock, or blocks an order.

create or replace function public.inventory_cutover_readiness_v1()
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
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Master o administración pueden consultar la preparación del corte.'
      using errcode = '42501';
  end if;

  with recursive
  eligible_items as materialized (
    select
      item.id,
      item.name,
      coalesce(item.inventory_group, 'other') as inventory_group,
      coalesce(item.unit_name, 'unidad') as unit_name,
      item.tracking_mode,
      item.availability_mode
    from public.inventory_items item
    where item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
  ),
  opening_items as materialized (
    select
      item.*,
      app_private.inventory_item_has_accepted_opening_v1(item.id) as accepted_opening,
      app_private.inventory_item_is_initialized_v1(item.id) as initialized
    from eligible_items item
  ),
  active_products as materialized (
    select product.*
    from public.products product
    where product.is_active
  ),
  component_walk as (
    select
      component.parent_product_id as root_product_id,
      component.component_product_id as product_id,
      array[component.parent_product_id, component.component_product_id]::bigint[] as path,
      component.component_product_id = component.parent_product_id as has_cycle,
      1 as depth
    from public.product_components component
    join active_products root on root.id = component.parent_product_id

    union all

    select
      parent.root_product_id,
      component.component_product_id,
      parent.path || component.component_product_id,
      component.component_product_id = any(parent.path),
      parent.depth + 1
    from component_walk parent
    join public.product_components component
      on component.parent_product_id = parent.product_id
    where not parent.has_cycle
      and parent.depth < 17
  ),
  active_product_issues as materialized (
    select
      product.id,
      product.sku,
      product.name,
      case
        when product.inventory_configuration_status is distinct from 'ready'
          then 'configuration_not_ready'
        when product.inventory_policy is null
          then 'policy_missing'
        when product.inventory_policy = 'self' and (
          (
            select count(*)
            from public.product_inventory_links link
            where link.product_id = product.id
              and link.configuration_version = 1
              and link.deduction_mode = 'self_link'
          ) <> 1
          or exists (
            select 1
            from public.product_inventory_links link
            where link.product_id = product.id
              and link.configuration_version = 1
              and link.deduction_mode <> 'self_link'
          )
        ) then 'self_links_invalid'
        when product.inventory_policy = 'direct' and (
          not exists (
            select 1
            from public.product_inventory_links link
            where link.product_id = product.id
              and link.configuration_version = 1
              and link.deduction_mode = 'recipe'
          )
          or exists (
            select 1
            from public.product_inventory_links link
            where link.product_id = product.id
              and link.configuration_version = 1
              and link.deduction_mode <> 'recipe'
          )
        ) then 'direct_links_invalid'
        when product.inventory_policy = 'components' and (
          not exists (
            select 1
            from public.product_components component
            where component.parent_product_id = product.id
          )
          or exists (
            select 1
            from public.product_inventory_links link
            where link.product_id = product.id
              and link.configuration_version = 1
          )
        ) then 'components_invalid'
        when product.inventory_policy = 'none' and (
          exists (
            select 1
            from public.product_components component
            where component.parent_product_id = product.id
          )
          or exists (
            select 1
            from public.product_inventory_links link
            where link.product_id = product.id
              and link.configuration_version = 1
          )
        ) then 'none_has_inventory_configuration'
        else null
      end as issue_code
    from active_products product
  ),
  invalid_links as materialized (
    select
      link.id,
      link.product_id,
      link.inventory_item_id,
      case
        when item.id is null then 'inventory_item_missing'
        when item.merged_into_item_id is not null then 'inventory_item_merged'
        when item.tracking_mode = 'not_tracked' then 'inventory_item_not_tracked'
        when not item.is_active and product.is_active then 'active_product_item_inactive'
        when link.quantity_units <= 0 then 'quantity_not_positive'
        else null
      end as issue_code
    from public.product_inventory_links link
    join public.products product on product.id = link.product_id
    left join public.inventory_items item on item.id = link.inventory_item_id
    where link.configuration_version = 1
  ),
  canonical_recipes as materialized (
    select
      recipe.*,
      output_item.name as output_name,
      output_item.unit_name as output_unit_name,
      output_item.availability_mode as output_availability_mode
    from public.inventory_recipes recipe
    join public.inventory_items output_item
      on output_item.id = recipe.output_inventory_item_id
    where coalesce(recipe.notes, '') like 'Bloque 3:%'
  ),
  canonical_recipe_status as materialized (
    select
      recipe.id,
      recipe.output_inventory_item_id,
      recipe.output_name,
      recipe.output_unit_name,
      recipe.recipe_kind,
      recipe.version,
      recipe.lead_time_minutes,
      recipe.output_quantity_units,
      recipe.production_multiple,
      recipe.is_active,
      not (
        recipe.output_quantity_units <= 0
        or recipe.production_multiple <= 0
        or recipe.lead_time_minutes < 0
        or not exists (
          select 1
          from public.inventory_recipe_components component
          where component.recipe_id = recipe.id
        )
        or exists (
          select 1
          from public.inventory_recipe_components component
          left join public.inventory_items input_item
            on input_item.id = component.input_inventory_item_id
          where component.recipe_id = recipe.id
            and (
              input_item.id is null
              or not input_item.is_active
              or input_item.merged_into_item_id is not null
              or input_item.tracking_mode <> 'transactional'
              or component.quantity_units <= 0
            )
        )
      ) as definition_valid,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('id', blocker.id, 'name', blocker.name)
          order by blocker.name, blocker.id
        )
        from (
          select output_opening.id, output_opening.name
          from opening_items output_opening
          where output_opening.id = recipe.output_inventory_item_id
            and not output_opening.accepted_opening

          union

          select input_opening.id, input_opening.name
          from public.inventory_recipe_components component
          join opening_items input_opening
            on input_opening.id = component.input_inventory_item_id
          where component.recipe_id = recipe.id
            and not input_opening.accepted_opening
        ) blocker
      ), '[]'::jsonb) as opening_blockers
    from canonical_recipes recipe
  ),
  recipe_required_outputs as materialized (
    select item.id, item.name
    from eligible_items item
    where item.availability_mode in ('immediate_recipe', 'scheduled_recipe')
  ),
  open_orders as materialized (
    select
      order_row.id,
      order_row.order_number,
      order_row.status::text as status,
      app_private.inventory_order_sale_diagnostics_v1(order_row.id) as diagnostics
    from public.orders order_row
    where order_row.status::text in (
      'queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'
    )
  ),
  open_order_status as materialized (
    select
      order_row.*,
      jsonb_array_length(coalesce(order_row.diagnostics -> 'errors', '[]'::jsonb)) as error_count,
      jsonb_array_length(coalesce(order_row.diagnostics -> 'lines', '[]'::jsonb)) as required_commitment_lines,
      (
        select count(*)::integer
        from public.inventory_planned_flows flow
        where flow.order_id = order_row.id
          and flow.flow_type = 'order_commitment'
          and flow.status in ('draft', 'active')
      ) as active_commitment_lines
    from open_orders order_row
  ),
  required_triggers(table_name, trigger_name) as (
    values
      ('inventory_items'::text, 'inventory_guard_stock_projection_v1'::text),
      ('inventory_movements', 'inventory_guard_canonical_movement_v1'),
      ('inventory_lots', 'inventory_lots_validate_planned_flow_v1'),
      ('order_items', 'inventory_10_order_item_snapshot_v1'),
      ('order_items', 'inventory_20_order_item_commitment_v1'),
      ('orders', 'inventory_order_commitment_lifecycle_v1'),
      ('orders', 'inventory_order_sale_cutover_v1')
  ),
  missing_triggers as materialized (
    select expected.table_name, expected.trigger_name
    from required_triggers expected
    where not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = expected.table_name
        and trigger_row.tgname = expected.trigger_name
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
    )
  ),
  required_roles(role_name) as (
    values ('admin'::text), ('master'), ('kitchen'), ('advisor'), ('counter')
  ),
  role_coverage as materialized (
    select
      required.role_name,
      (
        select count(distinct role_row.user_id)::integer
        from public.user_roles role_row
        where role_row.role::text = required.role_name
      ) as user_count
    from required_roles required
  ),
  metrics as materialized (
    select
      (select count(*)::integer from public.products) as catalog_product_count,
      (select count(*)::integer from active_products) as active_product_count,
      (select count(*)::integer from public.products product where product.inventory_configuration_status = 'ready') as ready_catalog_product_count,
      (select count(*)::integer from active_product_issues issue where issue.issue_code is not null) as active_product_issue_count,
      (select count(*)::integer from public.product_inventory_links link where link.configuration_version = 1) as canonical_link_count,
      (select count(*)::integer from invalid_links link where link.issue_code is not null) as invalid_link_count,
      (select count(*)::integer from component_walk walk where walk.has_cycle) as component_cycle_count,
      (select count(*)::integer from component_walk walk where walk.depth >= 16) as component_depth_issue_count,
      (select count(*)::integer from recipe_required_outputs) as recipe_required_output_count,
      (select count(*)::integer from canonical_recipe_status) as canonical_recipe_count,
      (select count(*)::integer from canonical_recipe_status recipe where recipe.is_active) as active_canonical_recipe_count,
      (select count(*)::integer from canonical_recipe_status recipe where not recipe.definition_valid) as invalid_recipe_count,
      (
        select count(*)::integer
        from recipe_required_outputs output_item
        where not exists (
          select 1
          from canonical_recipe_status recipe
          where recipe.output_inventory_item_id = output_item.id
            and recipe.definition_valid
        )
      ) as missing_recipe_output_count,
      (select count(*)::integer from eligible_items) as eligible_item_count,
      (select count(*)::integer from opening_items item where item.accepted_opening) as accepted_opening_count,
      (select count(*)::integer from opening_items item where item.initialized and not item.accepted_opening) as opening_under_review_count,
      (select count(*)::integer from opening_items item where not item.initialized) as pending_opening_count,
      (
        select count(*)::integer
        from public.inventory_counts count_header
        where count_header.status in ('submitted', 'recount_requested')
      ) as pending_count_review_count,
      (select count(*)::integer from open_order_status) as open_order_count,
      (select count(*)::integer from open_order_status order_row where order_row.error_count > 0) as order_resolver_error_count,
      (
        select count(*)::integer
        from open_order_status order_row
        where order_row.required_commitment_lines <> order_row.active_commitment_lines
      ) as commitment_mismatch_count,
      (
        select count(*)::integer
        from public.inventory_planned_flows flow
        left join public.orders order_row on order_row.id = flow.order_id
        where flow.flow_type = 'order_commitment'
          and flow.status in ('draft', 'active')
          and (
            order_row.id is null
            or order_row.status::text not in (
              'queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'
            )
          )
      ) as orphan_commitment_count,
      (
        select count(*)::integer
        from public.inventory_planned_flows flow
        where flow.flow_type = 'expected_receipt'
          and flow.status in ('draft', 'active')
      ) as active_expected_receipt_count,
      (
        select count(*)::integer
        from public.inventory_planned_flows flow
        where flow.flow_type = 'planned_production'
          and flow.status = 'active'
      ) as active_production_count,
      (
        select count(*)::integer
        from public.inventory_movements movement
        where movement.operation_id is not null
      ) as canonical_movement_count,
      (select count(*)::integer from missing_triggers) as missing_trigger_count,
      (select count(*)::integer from role_coverage role_row where role_row.user_count = 0) as missing_role_count
  ),
  readiness as materialized (
    select
      metrics.*,
      (
        metrics.active_product_issue_count = 0
        and metrics.invalid_link_count = 0
        and metrics.component_cycle_count = 0
        and metrics.component_depth_issue_count = 0
        and metrics.invalid_recipe_count = 0
        and metrics.missing_recipe_output_count = 0
        and metrics.order_resolver_error_count = 0
        and metrics.commitment_mismatch_count = 0
        and metrics.orphan_commitment_count = 0
        and metrics.missing_trigger_count = 0
        and metrics.missing_role_count = 0
      ) as structural_ready
    from metrics
  ),
  final_readiness as materialized (
    select
      readiness.*,
      (
        readiness.structural_ready
        and readiness.eligible_item_count > 0
        and readiness.accepted_opening_count = readiness.eligible_item_count
        and readiness.pending_count_review_count = 0
        and readiness.active_canonical_recipe_count = readiness.canonical_recipe_count
        and readiness.active_production_count = 0
      ) as operational_ready
    from readiness
  )
  select jsonb_build_object(
    'generated_at', now(),
    'read_only', true,
    'inventory_blocks_orders', false,
    'cutover_mode', case
      when app_private.inventory_catalog_is_ready_v1() then 'canonical'
      when exists (
        select 1
        from public.inventory_counts count_header
        join public.inventory_count_lines count_line
          on count_line.inventory_count_id = count_header.id
        join eligible_items item on item.id = count_line.inventory_item_id
        where count_header.count_kind = 'opening'
      ) then 'opening'
      else 'legacy'
    end,
    'status', case
      when final.operational_ready then 'ready_for_canonical_operation'
      when not final.structural_ready then 'structural_blockers'
      when final.accepted_opening_count > 0 then 'opening_in_progress'
      else 'structure_ready_opening_pending'
    end,
    'structural_ready', final.structural_ready,
    'operational_ready', final.operational_ready,
    'summary', jsonb_build_object(
      'catalog_products', final.catalog_product_count,
      'active_products', final.active_product_count,
      'ready_catalog_products', final.ready_catalog_product_count,
      'canonical_links', final.canonical_link_count,
      'canonical_recipes', final.canonical_recipe_count,
      'active_canonical_recipes', final.active_canonical_recipe_count,
      'eligible_opening_items', final.eligible_item_count,
      'accepted_openings', final.accepted_opening_count,
      'open_orders', final.open_order_count,
      'canonical_movements', final.canonical_movement_count
    ),
    'checks', jsonb_build_array(
      jsonb_build_object(
        'code', 'catalog_configuration',
        'phase', 'structure',
        'status', case when final.active_product_issue_count = 0 then 'pass' else 'blocked' end,
        'blocks_cutover', true,
        'title', 'Configuración del catálogo activo',
        'detail', case
          when final.active_product_issue_count = 0
            then format('%s productos activos tienen política y resolución canónica coherentes.', final.active_product_count)
          else format('%s productos activos requieren corrección.', final.active_product_issue_count)
        end,
        'current', final.active_product_count - final.active_product_issue_count,
        'required', final.active_product_count
      ),
      jsonb_build_object(
        'code', 'canonical_links',
        'phase', 'structure',
        'status', case when final.invalid_link_count = 0 then 'pass' else 'blocked' end,
        'blocks_cutover', true,
        'title', 'Vínculos físicos canónicos',
        'detail', case
          when final.invalid_link_count = 0
            then format('%s vínculos versión 1 son válidos.', final.canonical_link_count)
          else format('%s vínculos versión 1 son inválidos.', final.invalid_link_count)
        end,
        'current', final.canonical_link_count - final.invalid_link_count,
        'required', final.canonical_link_count
      ),
      jsonb_build_object(
        'code', 'component_graph',
        'phase', 'structure',
        'status', case
          when final.component_cycle_count = 0 and final.component_depth_issue_count = 0 then 'pass'
          else 'blocked'
        end,
        'blocks_cutover', true,
        'title', 'Combos y componentes',
        'detail', case
          when final.component_cycle_count = 0 and final.component_depth_issue_count = 0
            then 'La composición no contiene ciclos ni profundidades inválidas.'
          else format('%s ciclos y %s rutas demasiado profundas.', final.component_cycle_count, final.component_depth_issue_count)
        end
      ),
      jsonb_build_object(
        'code', 'recipe_definitions',
        'phase', 'structure',
        'status', case
          when final.invalid_recipe_count = 0 and final.missing_recipe_output_count = 0 then 'pass'
          else 'blocked'
        end,
        'blocks_cutover', true,
        'title', 'Definiciones de preparación',
        'detail', case
          when final.invalid_recipe_count = 0 and final.missing_recipe_output_count = 0
            then format('%s salidas preparadas tienen receta canónica válida.', final.recipe_required_output_count)
          else format('%s recetas inválidas y %s salidas sin receta.', final.invalid_recipe_count, final.missing_recipe_output_count)
        end,
        'current', final.recipe_required_output_count - final.missing_recipe_output_count,
        'required', final.recipe_required_output_count
      ),
      jsonb_build_object(
        'code', 'order_resolution',
        'phase', 'structure',
        'status', case
          when final.order_resolver_error_count = 0
            and final.commitment_mismatch_count = 0
            and final.orphan_commitment_count = 0 then 'pass'
          else 'blocked'
        end,
        'blocks_cutover', true,
        'title', 'Órdenes y compromisos existentes',
        'detail', case
          when final.order_resolver_error_count = 0
            and final.commitment_mismatch_count = 0
            and final.orphan_commitment_count = 0
            then format('%s órdenes abiertas se resuelven sin inconsistencias.', final.open_order_count)
          else format('%s errores de resolución, %s compromisos desalineados y %s compromisos huérfanos.', final.order_resolver_error_count, final.commitment_mismatch_count, final.orphan_commitment_count)
        end,
        'current', final.open_order_count - final.order_resolver_error_count - final.commitment_mismatch_count,
        'required', final.open_order_count
      ),
      jsonb_build_object(
        'code', 'database_guards',
        'phase', 'structure',
        'status', case when final.missing_trigger_count = 0 then 'pass' else 'blocked' end,
        'blocks_cutover', true,
        'title', 'Guardas del libro y de órdenes',
        'detail', case
          when final.missing_trigger_count = 0
            then 'Las siete guardas críticas están instaladas y habilitadas.'
          else format('Faltan %s guardas críticas.', final.missing_trigger_count)
        end,
        'current', 7 - final.missing_trigger_count,
        'required', 7
      ),
      jsonb_build_object(
        'code', 'role_coverage',
        'phase', 'structure',
        'status', case when final.missing_role_count = 0 then 'pass' else 'blocked' end,
        'blocks_cutover', true,
        'title', 'Cobertura de roles operativos',
        'detail', case
          when final.missing_role_count = 0
            then 'Administración, Master, Cocina, Asesor y Counter tienen usuarios asignados.'
          else format('Faltan usuarios en %s roles requeridos.', final.missing_role_count)
        end,
        'current', 5 - final.missing_role_count,
        'required', 5
      ),
      jsonb_build_object(
        'code', 'physical_opening',
        'phase', 'operation',
        'status', case
          when final.accepted_opening_count = final.eligible_item_count and final.eligible_item_count > 0 then 'pass'
          when final.accepted_opening_count > 0 then 'pending'
          else 'blocked'
        end,
        'blocks_cutover', true,
        'title', 'Apertura física',
        'detail', format('%s de %s ítems tienen apertura aceptada; %s están en revisión.', final.accepted_opening_count, final.eligible_item_count, final.opening_under_review_count),
        'current', final.accepted_opening_count,
        'required', final.eligible_item_count
      ),
      jsonb_build_object(
        'code', 'canonical_recipe_activation',
        'phase', 'operation',
        'status', case
          when final.active_canonical_recipe_count = final.canonical_recipe_count then 'pass'
          when final.accepted_opening_count > 0 then 'pending'
          else 'blocked'
        end,
        'blocks_cutover', true,
        'title', 'Activación de recetas canónicas',
        'detail', format('%s de %s recetas canónicas están activas.', final.active_canonical_recipe_count, final.canonical_recipe_count),
        'current', final.active_canonical_recipe_count,
        'required', final.canonical_recipe_count
      ),
      jsonb_build_object(
        'code', 'pending_reviews',
        'phase', 'operation',
        'status', case when final.pending_count_review_count = 0 then 'pass' else 'pending' end,
        'blocks_cutover', true,
        'title', 'Conteos por revisar',
        'detail', case
          when final.pending_count_review_count = 0 then 'No hay conteos pendientes de decisión.'
          else format('Hay %s conteos pendientes de revisión o reconteo.', final.pending_count_review_count)
        end,
        'current', final.pending_count_review_count,
        'required', 0
      ),
      jsonb_build_object(
        'code', 'production_in_progress',
        'phase', 'operation',
        'status', case when final.active_production_count = 0 then 'pass' else 'pending' end,
        'blocks_cutover', true,
        'title', 'Preparaciones en curso',
        'detail', case
          when final.active_production_count = 0 then 'No hay preparaciones canónicas abiertas.'
          else format('Deben resolverse %s preparaciones antes del corte.', final.active_production_count)
        end,
        'current', final.active_production_count,
        'required', 0
      ),
      jsonb_build_object(
        'code', 'expected_receipts',
        'phase', 'operation',
        'status', 'info',
        'blocks_cutover', false,
        'title', 'Entradas esperadas',
        'detail', format('%s entradas esperadas permanecen como proyección; nunca cuentan como existencia recibida.', final.active_expected_receipt_count),
        'current', final.active_expected_receipt_count
      )
    ),
    'opening', jsonb_build_object(
      'eligible_count', final.eligible_item_count,
      'accepted_count', final.accepted_opening_count,
      'under_review_count', final.opening_under_review_count,
      'pending_count', final.pending_opening_count,
      'pending_items', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', item.id,
            'name', item.name,
            'inventory_group', item.inventory_group,
            'unit_name', item.unit_name,
            'status', case when item.initialized then 'under_review' else 'pending' end
          )
          order by item.inventory_group, item.name, item.id
        )
        from opening_items item
        where not item.accepted_opening
      ), '[]'::jsonb)
    ),
    'recipes', jsonb_build_object(
      'required_output_count', final.recipe_required_output_count,
      'canonical_count', final.canonical_recipe_count,
      'active_count', final.active_canonical_recipe_count,
      'activation_queue', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', recipe.id,
            'output_inventory_item_id', recipe.output_inventory_item_id,
            'output_name', recipe.output_name,
            'output_unit_name', recipe.output_unit_name,
            'recipe_kind', recipe.recipe_kind,
            'version', recipe.version,
            'lead_time_minutes', recipe.lead_time_minutes,
            'status', case
              when not recipe.definition_valid then 'invalid'
              when recipe.is_active then 'active'
              when jsonb_array_length(recipe.opening_blockers) > 0 then 'blocked_by_opening'
              else 'ready_to_activate'
            end,
            'opening_blockers', recipe.opening_blockers
          )
          order by recipe.output_name, recipe.version, recipe.id
        )
        from canonical_recipe_status recipe
      ), '[]'::jsonb)
    ),
    'orders', jsonb_build_object(
      'open_count', final.open_order_count,
      'resolver_error_count', final.order_resolver_error_count,
      'commitment_mismatch_count', final.commitment_mismatch_count,
      'orphan_commitment_count', final.orphan_commitment_count,
      'issues', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', order_row.id,
            'order_number', order_row.order_number,
            'status', order_row.status,
            'errors', order_row.diagnostics -> 'errors',
            'required_commitment_lines', order_row.required_commitment_lines,
            'active_commitment_lines', order_row.active_commitment_lines
          )
          order by order_row.id
        )
        from open_order_status order_row
        where order_row.error_count > 0
          or order_row.required_commitment_lines <> order_row.active_commitment_lines
      ), '[]'::jsonb)
    ),
    'roles', coalesce((
      select jsonb_object_agg(role_row.role_name, role_row.user_count)
      from role_coverage role_row
    ), '{}'::jsonb),
    'safety', jsonb_build_object(
      'performs_writes', false,
      'activates_cutover', false,
      'blocks_order_submission', false,
      'advisor_can_submit', true,
      'master_keeps_final_decision', true
    )
  ) into v_result
  from final_readiness final;

  return v_result;
end;
$$;

revoke all on function public.inventory_cutover_readiness_v1()
  from public, anon;
grant execute on function public.inventory_cutover_readiness_v1()
  to authenticated;

comment on function public.inventory_cutover_readiness_v1() is
  'Master/Admin read-only audit of structural and operational readiness for canonical inventory cutover; never writes stock or blocks orders.';
