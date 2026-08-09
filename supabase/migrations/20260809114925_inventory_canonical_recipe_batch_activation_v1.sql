-- Block 19: atomic activation of every staged canonical inventory recipe.
-- Reuses the existing recipe activation command and writes no opening balance.

set lock_timeout = '5s';
set statement_timeout = '30s';

create or replace function public.inventory_activate_canonical_recipes_v1()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe record;
  v_result jsonb;
  v_canonical_count integer;
  v_active_count integer;
  v_activated_count integer := 0;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede activar todas las recetas canónicas.'
      using errcode = '42501';
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('vivo_inventory_recipe_batch_activation_v1', 0)
  ) then
    raise exception 'Otra activación canónica está en curso.' using errcode = '55P03';
  end if;

  if not app_private.inventory_catalog_is_ready_v1() then
    raise exception 'La apertura física completa debe estar aceptada antes de activar recetas.'
      using errcode = '22023';
  end if;

  select count(*)::integer
  into v_canonical_count
  from public.inventory_recipes recipe
  where coalesce(recipe.notes, '') like 'Bloque 3:%';

  if v_canonical_count = 0 then
    raise exception 'No existen recetas canónicas preparadas.' using errcode = '22023';
  end if;

  for v_recipe in
    select recipe.id, recipe.is_active
    from public.inventory_recipes recipe
    where coalesce(recipe.notes, '') like 'Bloque 3:%'
    order by recipe.id
    for update
  loop
    v_result := public.inventory_activate_recipe_v1(v_recipe.id);
    if v_result ->> 'status' = 'applied' then
      v_activated_count := v_activated_count + 1;
    end if;
  end loop;

  select count(*)::integer
  into v_active_count
  from public.inventory_recipes recipe
  where coalesce(recipe.notes, '') like 'Bloque 3:%'
    and recipe.is_active;

  if v_active_count <> v_canonical_count then
    raise exception 'La activación canónica quedó incompleta: % de %.',
      v_active_count, v_canonical_count;
  end if;

  return jsonb_build_object(
    'status', case when v_activated_count = 0 then 'replayed' else 'applied' end,
    'canonical_recipe_count', v_canonical_count,
    'active_recipe_count', v_active_count,
    'activated_recipe_count', v_activated_count
  );
end;
$$;

revoke all on function public.inventory_activate_canonical_recipes_v1()
  from public, anon;
grant execute on function public.inventory_activate_canonical_recipes_v1()
  to authenticated, service_role;

comment on function public.inventory_activate_canonical_recipes_v1() is
  'Admin-only atomic activation of every staged canonical inventory recipe after the complete accepted opening.';
