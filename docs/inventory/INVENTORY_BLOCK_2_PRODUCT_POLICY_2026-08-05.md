# Bloque 2: política canónica de productos

Fecha: 2026-08-05

Estado: aplicado y verificado en Supabase; descuentos canónicos inactivos.

## Resultado

Los 143 productos vivos tienen una política persistida:

| Política | Productos | Resolución |
| --- | ---: | --- |
| `self` | 56 | un ítem físico equivalente |
| `direct` | 37 | uno o más ítems físicos explícitos |
| `components` | 37 | composición comercial existente |
| `none` | 13 | no genera consumo físico |

Además:

- 138 productos están listos;
- 2 requieren receta de mostaza miel;
- 2 requieren convertir Evento/Colegio en composición abierta;
- 1 requiere corregir la identidad estacional de cerdo;
- 15 admiten medio servicio;
- 103 enlaces canónicos cubren 93 productos `self/direct`;
- los 37 productos `components` reutilizan `product_components`;
- los 13 `none` no tienen enlace físico.

## Separación segura del motor heredado

`inventory_deduction_mode` y los enlaces activos no son metadatos pasivos: el
flujo actual de entrega los consume. Ese flujo todavía puede ignorar cantidades
de enlaces `self`, buscar por nombre e interpretar selecciones desde notas.

Por esa razón:

- los 107 enlaces existentes permanecen en `configuration_version = 0`, activos
  y sin cambios;
- los 103 enlaces canónicos están en `configuration_version = 1` e inactivos;
- `inventory_policy` es la nueva autoridad de clasificación;
- ninguna venta, entrega, receta, existencia o movimiento cambió en este bloque.

La activación solo ocurrirá junto con el motor atómico que resuelva cantidades,
medios servicios, componentes guardados y la etapa de deducción.

## Visibilidad

La ruta `/app/inventory/products` lee esta configuración únicamente cuando el
usuario entra al Centro de Inventario. La dashboard no precarga el catálogo.

## Verificación

- migración: `20260805164243_inventory_product_policy_staging.sql`;
- prueba previa: ejecución completa dentro de transacción y `ROLLBACK`;
- 143 productos: 56 `self`, 37 `direct`, 37 `components`, 13 `none`;
- 138 listos y 5 pendientes técnicos;
- 107 enlaces heredados activos y 103 enlaces canónicos inactivos;
- 233 componentes y 2 recetas conservados;
- huellas de saldos y configuración heredada sin cambios;
- asesores de Supabase: ninguna alerta nueva causada por estas columnas; continúan
  las advertencias legadas de exposición y políticas permisivas sobre
  `product_inventory_links`.
