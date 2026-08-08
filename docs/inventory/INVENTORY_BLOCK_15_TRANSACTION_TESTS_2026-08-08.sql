-- Bloque 15: ejecutar manualmente en Supabase SQL Editor.
-- Toda captura, movimiento y expectativa se revierte al finalizar.

begin;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (
      select user_id::text
      from public.user_roles
      where role = 'admin'
      order by user_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);

-- Se aíslan los dos ítems usados por la prueba. El ROLLBACK restaura sus flujos.
update public.inventory_planned_flows
set status = 'cancelled'
where inventory_item_id in (1, 26)
  and status in ('draft', 'active');

select public.inventory_submit_count_v1(
  gen_random_uuid(),
  'opening',
  '[
    {"inventory_item_id":1,"counted_quantity_units":12},
    {"inventory_item_id":26,"counted_quantity_units":0}
  ]'::jsonb,
  'Bloque 15: apertura de prueba'
);

select public.inventory_save_expected_receipt_v1(
  gen_random_uuid(),
  26,
  now() + interval '1 hour',
  '{"quantity_unknown":false,"loose_units":10,"presentations":[]}'::jsonb,
  'Bloque 15: reposición de prueba',
  null
);

do $$
declare
  v_half_service jsonb;
  v_before_receipt jsonb;
  v_after_receipt jsonb;
  v_selectable jsonb;
  v_outside_horizon jsonb;
begin
  -- Mini Tequeños Fritos: servicio 25, medio servicio 12.
  v_half_service := public.inventory_catalog_availability_v1(
    now(),
    array[5]::bigint[],
    'inventory_center'
  ) -> 'products' -> 0;

  if (v_half_service ->> 'available_without_affecting_confirmed')::numeric <> 0.5
    or v_half_service ->> 'availability_state' not in ('available', 'low')
  then
    raise exception 'Twelve pieces must permit one half service: %', v_half_service;
  end if;

  -- Pepsi 1,5 Lts antes de la expectativa.
  v_before_receipt := public.inventory_catalog_availability_v1(
    now(),
    array[30]::bigint[],
    'inventory_center'
  ) -> 'products' -> 0;

  if v_before_receipt ->> 'availability_state' <> 'unavailable'
    or v_before_receipt ->> 'next_available_at' is null
    or (v_before_receipt ->> 'inventory_blocks_submission')::boolean
  then
    raise exception 'Unexpected state before receipt: %', v_before_receipt;
  end if;

  -- La misma bebida después de la hora prevista depende de esa reposición.
  v_after_receipt := public.inventory_catalog_availability_v1(
    now() + interval '2 hours',
    array[30]::bigint[],
    'inventory_center'
  ) -> 'products' -> 0;

  if v_after_receipt ->> 'availability_state' <> 'relies_on_incoming'
    or (v_after_receipt ->> 'available_without_affecting_confirmed')::numeric <> 10
    or (v_after_receipt ->> 'available_without_planned_incoming')::numeric <> 0
  then
    raise exception 'Unexpected state after receipt: %', v_after_receipt;
  end if;

  -- Single Pack requiere conocer su contenido.
  v_selectable := public.inventory_catalog_availability_v1(
    now(),
    array[1]::bigint[],
    'inventory_center'
  ) -> 'products' -> 0;

  if v_selectable ->> 'availability_state' <> 'selection_required' then
    raise exception 'Selectable product must request its composition: %', v_selectable;
  end if;

  v_outside_horizon := public.inventory_catalog_availability_v1(
    now() + interval '11 days',
    array[30]::bigint[],
    'inventory_center'
  ) -> 'products' -> 0;

  if v_outside_horizon ->> 'availability_state' <> 'outside_horizon' then
    raise exception 'Distant product must remain outside the horizon: %', v_outside_horizon;
  end if;
end;
$$;

select public.inventory_adjust_stock_v1(
  gen_random_uuid(),
  1,
  11,
  'block_15_half_service_test',
  'Bloque 15: bajar a once piezas'
);

do $$
declare
  v_product jsonb;
begin
  v_product := public.inventory_catalog_availability_v1(
    now(),
    array[5]::bigint[],
    'inventory_center'
  ) -> 'products' -> 0;

  if (v_product ->> 'available_without_affecting_confirmed')::numeric <> 0
    or v_product ->> 'availability_state' <> 'unavailable'
  then
    raise exception 'Eleven pieces must not permit a half service: %', v_product;
  end if;
end;
$$;

-- Asesor solo consume su superficie y no recibe detalles físicos internos.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (
      select role_row.user_id::text
      from public.user_roles role_row
      where role_row.role = 'advisor'
        and not exists (
          select 1
          from public.user_roles elevated
          where elevated.user_id = role_row.user_id
            and elevated.role in ('admin', 'master', 'counter')
        )
      order by role_row.user_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);
set local role authenticated;

do $$
declare
  v_response jsonb;
begin
  v_response := public.inventory_catalog_availability_v1(
    now(),
    array[1, 30, 65]::bigint[],
    'advisor_availability'
  );

  if (v_response ->> 'inventory_blocks_submission')::boolean
    or exists (
      select 1
      from jsonb_array_elements(v_response -> 'products') product
      where product ? 'internal_details'
    )
  then
    raise exception 'Advisor boundary failed: %', v_response;
  end if;

  begin
    perform public.inventory_catalog_availability_v1(
      now(),
      array[30]::bigint[],
      'counter_inventory'
    );
    raise exception 'Advisor unexpectedly accessed the Counter surface.';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

rollback;
