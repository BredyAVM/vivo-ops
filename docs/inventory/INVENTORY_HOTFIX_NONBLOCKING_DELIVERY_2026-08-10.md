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
y el saldo puede quedar negativo. Las alertas existentes de disponibilidad y
procura exponen la discrepancia para reposición o reconteo.

## Alcance

- No se modificó `/app/master/dashboard`.
- No se modificó la interfaz de Master Ops.
- No se corrigió artificialmente el saldo de la salsa.
- Se mantiene una sola autoridad de inventario y un solo libro de movimientos.
- La corrección aplica a toda entrega canónica, incluida la realizada desde
  Master Ops y el pickup autorizado de Counter.

## Migración

`20260810145845_inventory_nonblocking_order_delivery_v1`
