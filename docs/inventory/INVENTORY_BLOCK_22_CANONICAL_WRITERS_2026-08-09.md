# Bloque 22: cierre de escritores heredados

## Objetivo

Dejar al Centro de Inventario como único punto de administración de productos,
ítems físicos, vínculos, recetas, movimientos y producción, sin alterar el flujo
de órdenes de la dashboard de Máster.

No se crearon tablas, columnas ni migraciones.

## Cambios aplicados

### Dashboard de Máster / Administración

- **Inventario** continúa siendo un enlace independiente a `/app/inventory` y
  no carga el dominio nuevo dentro de la dashboard.
- **Crear producto** y **Crear nuevo** ahora llevan al configurador universal de
  `/app/inventory/configure`.
- La reactivación de productos inactivos se deriva al Centro de Inventario.
- Las secciones antiguas de inventario y composición aparecen como solo lectura.
- El editor comercial conserva únicamente precio, comisión, costo de obsequio y
  pago de rider.
- La desactivación comercial continúa disponible; la activación exige el flujo
  canónico de validación.

### Cierre en servidor

Las acciones heredadas de creación/edición de ítems, recetas, movimientos y
producción rechazan cualquier intento antes de escribir en Supabase. La creación
y copia antigua de productos también se rechazan con una indicación explícita de
usar el Centro de Inventario.

`updateCatalogItemAction` dejó de escribir:

- `inventory_items`;
- `product_inventory_links`;
- `product_components`;
- columnas de política o saldo de inventario en `products`;
- activación, unidades por servicio o estructura operativa.

La acción conserva exclusivamente datos comerciales que no reinterpretan el
inventario: precio, comisión, costo de obsequio y pago de rider.

## Límites respetados

- No se modificó la creación, aprobación, preparación, entrega o cobro de
  órdenes.
- No se cambió Cocina, Counter ni Finanzas.
- Inventario continúa sin bloquear solicitudes ni órdenes.
- No se alteró la base de datos ni el cutover canónico.

## Verificación

- Compilación de producción de Next.js: aprobada.
- Comprobación estática: los seis escritores heredados de inventario rechazan la
  operación y el editor comercial no contiene mutaciones de inventario.
- Supabase: `ready_for_canonical_operation`, estructura y operación listas,
  103/103 productos activos configurados, 48/48 aperturas aceptadas y 13/13
  recetas canónicas activas.
- Seguridad operativa: `inventory_blocks_orders = false`, Asesor puede enviar y
  Máster conserva la decisión final.

## Siguiente bloque

Bloque 23: adaptador operativo de Cocina sobre los RPC canónicos existentes para
recepción real, producción, conteos ciegos, averías, mermas y prueba de calidad.
