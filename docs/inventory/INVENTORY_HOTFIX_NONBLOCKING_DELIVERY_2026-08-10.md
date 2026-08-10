# Corrección operativa: entrega no bloqueante por inventario

Fecha: 2026-08-10

## Incidente

La transición de una orden a `delivered` estaba fallando en producción con el
mensaje `Existencia insuficiente para completar la venta: Salsa Tártara 5oz.`.
El catálogo ya se encontraba en modo canónico y el trigger
`inventory_order_sale_cutover_v1` ejecutaba el consumo dentro de la misma
transacción de entrega. Una guarda adicional rechazaba la operación cuando el
saldo físico era menor al consumo resuelto.

## Decisión canónica aplicada

La disponibilidad de inventario informa la decisión operativa, pero no bloquea
la creación, aprobación, preparación ni entrega de una orden. Una venta ya
realizada es un hecho físico y debe quedar asentada en el libro.

Por ello, `inventory_commit_order_sale_v1` conserva todas sus validaciones de
identidad, rol, idempotencia, resolución, apertura e integridad, pero deja de
rechazar una salida por falta de existencia. El movimiento `sale_out` se registra
y el saldo puede quedar negativo. Desde la migración V2, todo saldo negativo
operativo abre además una alerta crítica de control, aunque el ítem no tenga
umbral de procura, receta o vínculo comercial directo.

## Alcance

- No se modificó `/app/master/dashboard`.
- No se modificó la interfaz de Master Ops.
- No se corrigió artificialmente el saldo de la salsa.
- Se mantiene una sola autoridad de inventario y un solo libro de movimientos.
- La corrección aplica a toda entrega canónica, incluida la realizada desde
  Master Ops y el pickup autorizado de Counter.

## Migración

`20260810145845_inventory_nonblocking_order_delivery_v1`

## Cierre posterior de la frontera

Esta corrección puntual eliminó el veto cuantitativo dentro del comando de
consumo, pero los disparadores de composición, compromisos y entrega todavía
podían revertir una orden ante otra falla del motor. Esa frontera quedó cerrada
por `20260810152823_inventory_order_flow_nonblocking_v2`.

En la V2:

- los cuatro disparadores de inventario capturan sus excepciones;
- la orden o partida siempre conserva su operación;
- la incidencia se escribe en el timeline existente para Máster y
  Administración;
- el centro de alertas incorpora esa incidencia como alerta de sistema al
  refrescarse;
- el saldo negativo mantiene una alerta crítica de control propia y se resuelve
  automáticamente cuando el saldo vuelve a cero o positivo.

El contrato completo está documentado en
`INVENTORY_ORDER_FLOW_FULL_NONBLOCKING_2026-08-10.md`.
