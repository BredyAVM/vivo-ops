# Bloque 26 — configuración física versionada

Fecha: 2026-08-10  
Estado: implementado y aplicado en producción.

## Resultado

- Administración puede modificar la regla física de un producto activo desde
  `/app/inventory/configure?view=edit`.
- Las opciones canónicas son `self`, `direct`, `components` y `none`.
- Se reutilizan `products`, `product_inventory_links`, `product_components` y
  `products.extra_fields`; no se creó ninguna tabla ni columna.
- La revisión anterior queda archivada en
  `products.extra_fields.inventory_physical_history` y la revisión vigente en
  `inventory_physical_revision`.
- El cambio no escribe existencias, no bloquea órdenes y no reactiva el
  mecanismo legado representado por `product_inventory_links.is_active`.
- Las entregas con un compromiso existente usan las líneas físicas ya
  congeladas en `inventory_planned_flows`, evitando reinterpretar una orden
  confirmada después de cambiar una regla del catálogo.

## Interfaz

El configurador separa tres tareas para evitar una pantalla única saturada:

1. modificar lo existente;
2. revisar y activar borradores;
3. crear un producto o ítem.

El editor de producto mantiene por separado los datos comerciales y la regla
física. Antes de activar una revisión muestra el número siguiente y confirma
que no cambiará saldos.

## Seguridad y pruebas

- El RPC `inventory_update_product_physical_configuration_v1` exige sesión con
  rol `admin`, usa `SECURITY DEFINER` con `search_path` vacío y no está expuesto
  a `anon`.
- La prueba transaccional reversible confirmó incremento de versión, historial,
  vínculo canónico y `orders_blocked = false`.
- Órdenes entregadas con compromisos resuelven desde
  `configuration_source = committed_snapshot`.
- `npm run build` finalizó correctamente.
- Los asesores de Supabase no reportaron una observación nueva asociada al RPC;
  continúan existiendo avisos heredados fuera del alcance de este bloque.

## Migraciones

- `20260810220745_inventory_product_physical_revision_v1.sql`
- `20260810221717_inventory_product_physical_link_semantics_v1.sql`

