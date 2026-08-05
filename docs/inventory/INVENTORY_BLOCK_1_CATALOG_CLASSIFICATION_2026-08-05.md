# Bloque 1: clasificación del catálogo

Fecha: 2026-08-05

Estado: aplicado y verificado en Supabase.

## Resultado

El catálogo vivo contiene 143 productos y 76 ítems de inventario. La matriz
anterior tenía 153 productos y 75 ítems: desde esa extracción se eliminaron 11
productos inactivos y se añadió Fanta Naranja 1,5 Lts como producto 162 e ítem
76.

Las políticas canónicas de los 143 productos vivos quedan distribuidas así:

| Política | Productos |
| --- | ---: |
| `self` | 56 |
| `direct` | 37 |
| `components` | 37 |
| `none` | 13 |

La clasificación aplicada a los 76 ítems queda así:

| Seguimiento | Ítems |
| --- | ---: |
| `transactional` | 46 |
| `periodic_count` | 1 |
| `not_tracked` | 29 |

También quedaron configurados:

- 23 alias históricos con destino físico canónico;
- 46 conteos por turno a cargo de Cocina;
- un conteo quincenal a cargo de Master para `Cajas grandes`;
- cinco prefritos con objetivo de 10 servicios y vida útil de 90 días;
- un prefrito regular bajo demanda con objetivo cero y vida útil de 90 días;
- 23 bebidas con alerta inclusiva al llegar a 10 unidades;
- cinco prefritos con alerta al bajar de 10 servicios.

## Límite deliberado

No se modificaron `products.inventory_enabled`,
`products.inventory_deduction_mode`, `product_inventory_links`, recetas,
movimientos ni saldos. El motor legado interpreta solo `self/composition` y en
algunas rutas no aplica `quantity_units`; activar allí las políticas canónicas
antes de migrar el consumidor alteraría pedidos reales.

La clasificación de productos permanece en
`INVENTORY_PRODUCT_MATRIX_2026-07-30.csv`, reconciliada por este documento con
el catálogo vivo. La escritura operativa de esas políticas se hará junto con el
motor atómico y la redirección de enlaces.

## Verificación

- migración: `20260805144417_inventory_catalog_classification.sql`;
- prueba previa: ejecución completa dentro de transacción y `ROLLBACK`;
- huella de saldos antes y después: sin cambios;
- huella de políticas de producto antes y después: sin cambios;
- huella de enlaces antes y después: sin cambios;
- 143 productos, 76 ítems, 107 enlaces, 2 recetas, 3 componentes de receta y
  3.782 movimientos al finalizar;
- asesores de Supabase: sin alertas nuevas causadas por este bloque; permanecen
  las deudas legadas ya documentadas de exposición `anon` y políticas
  permisivas duplicadas.
