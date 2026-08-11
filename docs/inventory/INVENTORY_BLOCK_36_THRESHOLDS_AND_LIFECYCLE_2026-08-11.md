# Bloque 36 — mínimos, objetivos y ciclo de vida

Fecha: 2026-08-11

## Auditoría aplicada

La revisión directa de producción confirmó:

- 54 ítems activos y 3 inactivos;
- 19 ítems sin punto mínimo;
- 50 ítems sin stock objetivo;
- 44 productos inactivos;
- 37 productos marcados como temporales.

Por tanto, no se crearon tablas ni columnas. Se reutilizan
`inventory_items.is_active`, `products.is_active`, `products.is_temporary`,
`low_stock_threshold`, `target_stock_units`, `notes` y `products.extra_fields`.

## Semántica

- **Punto mínimo:** nivel desde el cual se solicita atención.
- **Objetivo después de reponer:** nivel al que se quiere regresar; no puede ser
  menor que el punto mínimo.
- **Producto inactivo:** no se ofrece en ventas nuevas. Las órdenes abiertas no
  se borran ni se bloquean.
- **Ítem inactivo:** conserva saldo e historial, pero no aparece en conteos ni
  produce alertas nuevas.
- **Producto temporal:** conserva `is_temporary`; su entrada y salida de
  temporada se controla con el mismo estado reversible del catálogo.

## Guardas

`inventory_set_product_active_status_v1` impide desactivar un producto que aún
es componente de otro producto activo. Al reactivarlo comprueba que sus ítems y
componentes estén operativos.

`inventory_set_item_active_status_v1` impide retirar un ítem usado por productos,
recetas o flujos activos. La desactivación resuelve sus alertas abiertas, no
altera el saldo y nunca bloquea órdenes.

Los cambios de producto se registran en el historial existente de
`products.extra_fields`; una nota de estado opcional se conserva en
`inventory_items.notes` para los ítems.
