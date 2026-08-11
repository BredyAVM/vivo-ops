# Bloque 31 — disponibilidad por fecha para Counter

Fecha: 2026-08-10

## Resultado

La pantalla `Nueva venta` de Counter ahora sigue el orden:

1. cliente;
2. momento de entrega (`Ahora` o `Agendar`);
3. productos;
4. entrega;
5. pago esperado.

Para una venta inmediata usa el momento actual. Para una venta agendada, espera
fecha y hora antes de habilitar la búsqueda de productos. Después consulta
`inventory_catalog_availability_v1` mediante la superficie
`counter_inventory`.

## Lectura operativa

La lista, el producto seleccionado y los renglones agregados muestran las mismas
señales canónicas de disponibilidad usadas por Asesor. Las advertencias aclaran
que la venta puede crearse y que Máster conserva la decisión final.

## Regla no bloqueante

No se modificaron:

- `createCounterQuickSaleAction`;
- la validación de `CounterDirectSaleIntent`;
- la transición hacia Cocina;
- el motor de pagos;
- la habilitación final por existencia.

El inventario no participa en el `disabled` del botón de crear. Si la consulta
falla, Counter puede continuar.

## Aislamiento del trabajo paralelo

El bloque modificó únicamente `CounterQuickSaleWorkspace.tsx`. Los cambios
locales existentes en `CounterClient`, `CounterOrderWorkspace`,
`CounterPaymentEngine`, `read-actions` y `read-model` no fueron editados ni
incluidos en este commit.

## Verificación

- Contrato de Counter con catálogo real y productos visibles.
- Respuesta global y por producto con `inventory_blocks_submission = false`.
- `npm run build`: correcto, incluyendo la integración actual de Counter.

No se crearon tablas, columnas ni migraciones.
