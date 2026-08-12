-- Allow Administration to prepare a ready product while it remains inactive.
-- Reuses the canonical versioned writer; activation and sales visibility remain separate.

begin;

set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
declare
  v_signature regprocedure := to_regprocedure(
    'public.inventory_update_product_physical_configuration_v1(jsonb)'
  );
  v_definition text;
  v_old_guard text := $old$
  if not v_product.is_active or v_product.inventory_configuration_status <> 'ready' then
    raise exception 'Solo se puede versionar un producto activo y listo.' using errcode = '22023';
  end if;
$old$;
  v_new_guard text := $new$
  if v_product.inventory_configuration_status <> 'ready' then
    raise exception 'Solo se puede versionar un producto listo.' using errcode = '22023';
  end if;
$new$;
begin
  if v_signature is null then
    raise exception 'No existe la funcion canonica de revision fisica.';
  end if;

  select pg_get_functiondef(v_signature)
  into v_definition;

  if position(v_old_guard in v_definition) = 0 then
    if position(v_new_guard in v_definition) > 0 then
      return;
    end if;
    raise exception 'La validacion esperada de revision fisica cambio; se detuvo la migracion.';
  end if;

  v_definition := replace(v_definition, v_old_guard, v_new_guard);
  execute v_definition;
end;
$migration$;

revoke all on function public.inventory_update_product_physical_configuration_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_update_product_physical_configuration_v1(jsonb)
  to authenticated, service_role;

comment on function public.inventory_update_product_physical_configuration_v1(jsonb) is
  'Admin-only physical product revision writer. Accepts ready active or inactive products, preserves activation state, archives prior structure, never changes stock, and never blocks orders.';

do $verify$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.inventory_update_product_physical_configuration_v1(jsonb)'::regprocedure
  ) into v_definition;

  if position('if not v_product.is_active or v_product.inventory_configuration_status' in v_definition) > 0 then
    raise exception 'La revision fisica todavia exige un producto activo.';
  end if;

  if position('if v_product.inventory_configuration_status <> ''ready''' in v_definition) = 0 then
    raise exception 'La revision fisica perdio la validacion de configuracion ready.';
  end if;
end;
$verify$;

commit;
