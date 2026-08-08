# Bloque 9: borradores universales de inventario

Fecha: 2026-08-07

## Resultado

Administración dispone de `/app/inventory/configure` para crear configuraciones
nuevas sin enumerar futuros consumibles por chat. La ruta se carga de forma
independiente y no agrega consultas a la dashboard de Máster.

El comando `inventory_save_catalog_draft_v1(jsonb)` es la única escritura del
flujo. Valida el rol dentro de Supabase y guarda atómicamente uno de estos casos:

- ítem físico interno con unidad base, presentaciones y reglas de control;
- producto `self` enlazado a un ítem existente o a uno nuevo;
- producto `direct` enlazado a uno o varios ítems existentes;
- producto `components` con componentes fijos o seleccionables;
- producto `none` con razón explícita de no consumo.

## Reutilización de estructura

No se crearon tablas ni columnas. El bloque usa:

- `products`;
- `inventory_items`;
- `inventory_item_presentations`;
- `product_inventory_links`;
- `product_components`.

Se agregó únicamente `inventory_items_canonical_name_uidx`, un índice único
parcial sobre el nombre normalizado de identidades no fusionadas. La auditoría
previa confirmó cero duplicados canónicos. El índice evita duplicados por carrera
entre dos sesiones y deja fuera los alias históricos fusionados.

## Invariantes de seguridad

- solo un usuario con rol `admin` puede ejecutar el comando;
- un producto o ítem nuevo siempre queda `is_active = false`;
- un producto queda `inventory_configuration_status = 'draft'`;
- un ítem nuevo siempre inicia con `current_stock_units = 0`;
- guardar no crea movimientos ni modifica pedidos;
- un producto existente solo puede reutilizarse si está inactivo, no aparece en
  pedidos y no es dependencia de otro producto;
- un fallo revierte identidad, presentaciones, vínculos y componentes completos;
- los borradores inactivos no cambian el estado global de apertura.

## Verificación

La migración fue aplicada a Supabase y la prueba
`INVENTORY_BLOCK_9_TRANSACTION_TESTS_2026-08-07.sql` pasó dentro de
`BEGIN/ROLLBACK`. Cubrió permisos, duplicados, presentaciones, las cuatro
políticas, reutilización y la invariancia de apertura. No quedaron fixtures.

El build de Next.js también pasó e incluye la ruta dinámica
`/app/inventory/configure`.

## Siguiente fase

El bloque 10 debe resolver activación incremental:

1. validar la configuración completa del borrador;
2. exigir apertura física cuando el ítem deba llevar existencia;
3. activar ítem y producto en una sola transacción;
4. no devolver el catálogo ya operativo al modo global de apertura;
5. mantener las órdenes sin bloqueos por inventario.
