# Bloque 20: acceso operativo de Máster a revisiones

## Problema corregido

El Centro de Inventario ya permitía a Máster leer y revisar conteos, pero el
módulo operativo de Máster no tenía un acceso visible a esa pantalla. Por eso el
flujo de apertura estaba implementado en base de datos y en Inventario, pero no
era descubrible desde la operación diaria.

## Solución

- El encabezado de `/app/master/ops` muestra un acceso **Inventario** que abre
  directamente `/app/inventory/counts`.
- El enlace usa `prefetch={false}`: el listado no se consulta al cargar Máster,
  sino únicamente cuando el usuario decide abrir Inventario.
- La pantalla se denomina **Conteos y revisiones** y coloca primero los conteos
  presentados que requieren decisión.
- La pantalla resume conteos por revisar, reconteos activos y registros visibles.
- El regreso desde Inventario respeta el rol: Máster vuelve a `/app/master/ops`
  y Administración vuelve a `/app/master/dashboard`.

## Autoridad conservada

No se creó ninguna tabla, columna, RPC ni política nueva. Se verificó que las
políticas existentes permiten a Máster leer `inventory_counts` e
`inventory_count_lines`, y que `inventory_review_count_v1` mantiene la decisión
en Máster o Administración. El endpoint no es ejecutable por `public`.

Este bloque no carga saldos, no activa recetas y no cambia el comportamiento de
las órdenes. La apertura física real continúa pendiente de ser presentada desde
una sesión de Administración y revisada desde una sesión de Máster.
