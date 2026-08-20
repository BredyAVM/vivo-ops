# Saneamiento de incidencias de inventario en órdenes

Fecha: 2026-08-20
Estado: aplicado en producción y certificado

## Resultado

El saneamiento eliminó las incidencias accionables acumuladas por el motor de
inventario de órdenes sin borrar su historial. Los eventos permanecen en la
trazabilidad, pero sus destinatarios dejan de requerir acción y el evento guarda
la causa de su conciliación.

No se añadieron tablas ni columnas. Se reutilizaron:

- `order_timeline_events` y `order_timeline_event_recipients`;
- `order_item_components`;
- `inventory_planned_flows`;
- `inventory_movements`;
- las funciones y triggers canónicos existentes.

## Causas corregidas

### Orden momentáneamente sin partidas

Durante una edición, el sistema puede borrar las partidas anteriores antes de
insertar sus reemplazos. Esa transición ya no se considera un error. Si la orden
queda momentáneamente vacía, su compromiso pasa a cero y la operación comercial
continúa sin bloqueo.

### Productos configurables con cantidad mayor a uno

Los marcadores `@sel` representan la composición de una presentación. La
cantidad de la partida repite esa composición. Por ejemplo, dos Single Pack con
cinco minis y cinco cachitas cada uno producen un snapshot físico de diez minis
y diez cachitas.

El snapshot almacena totales físicos. Así, el resolver de ventas, los
compromisos, las vistas del Máster y los descuentos comparten la misma lectura.

### Avisos históricos ya resueltos

Las entregas antiguas de mostrador que ya tenían movimientos canónicos dejaron
de figurar como pendientes. Las incidencias de compromiso pertenecientes a
órdenes entregadas o canceladas también se cerraron porque ya no existe un
compromiso abierto que reparar.

## Conciliación recuperada

La orden `VO-20260814-1809` pudo reconstruirse de forma determinista. Se
registraron una sola vez:

- 10 unidades de mini tequeño crudo;
- 10 unidades de cachita cruda;
- 2 salsas tártara de 1 oz;
- 1 Yukipack pera;
- 1 Yukipack durazno.

## Prevención

- Una misma causa pendiente genera un solo aviso accionable, aunque el ciclo de
  vida de la orden se actualice varias veces.
- Cuando un snapshot, compromiso o consumo se repara, el aviso correspondiente
  se cierra automáticamente.
- Cualquier error nuevo sigue siendo informativo y no bloquea la creación,
  aprobación, preparación ni entrega de una orden.

## Certificación

La prueba transaccional valida:

1. multiplicación de componentes por cantidad de presentaciones;
2. eliminación temporal de todas las partidas sin falso `order_without_items`;
3. cierre del compromiso cuando la orden queda vacía;
4. deduplicación y resolución automática de incidencias.

Archivo de prueba:
`docs/inventory/INVENTORY_ORDER_ISSUE_RECONCILIATION_TRANSACTION_TESTS_2026-08-20.sql`.
