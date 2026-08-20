# Certificación — corte de inventario al salir en ruta

Fecha: 2026-08-20

## Decisión canónica

Una orden delivery consume inventario cuando se entrega al motorizado y pasa a
`out_for_delivery`. En ese momento los productos dejan de estar en el local.
El estado `delivered` confirma la entrega al cliente, pero no produce un segundo
descuento.

Los retiros en local continúan consumiendo al pasar a `delivered`, porque ese es
el momento en que el producto sale físicamente del establecimiento.

## Efecto sobre conteos y disponibilidad

- El saldo `current_stock_units` baja al salir en ruta.
- Los compromisos de la orden quedan `fulfilled` en la misma transacción.
- Un conteo iniciado después del despacho ya no espera encontrar esos productos.
- La orden deja de aparecer como demanda comprometida pendiente.
- Un saldo insuficiente puede quedar negativo y genera control sin bloquear el
  despacho.

## Devoluciones

La liquidación del motorizado registra cobros y efectivo; no devuelve mercancía
al inventario. Si regresa producto utilizable, Administración o Cocina registra
la cantidad exacta como `return_in`. Si regresa averiado o como merma, utiliza
el movimiento correspondiente.

## Pruebas reversibles ejecutadas

Se creó una orden delivery temporal con 999 Pepsi 2 Lts para forzar saldo
negativo dentro de una transacción finalizada en `ROLLBACK`. Se comprobó que:

- `ready` no descontó inventario;
- `out_for_delivery` creó `sale_out`;
- el saldo bajó exactamente 999 UND;
- el compromiso abierto quedó cerrado;
- el saldo negativo no bloqueó la transición;
- `delivered` no creó otro movimiento ni volvió a bajar el saldo.

En la misma certificación, un retiro temporal no descontó en `ready` y sí lo
hizo exactamente una vez al pasar a `delivered`. La transacción se revirtió y
no dejó órdenes, movimientos, saldos ni alertas de prueba.

## Seguridad y trazabilidad

Se conservaron la autenticación, los límites por rol, `search_path = ''`, los
bloqueos transaccionales por operación y orden, el orden estable de bloqueo de
ítems y los permisos mínimos. El disparador continúa capturando fallas para que
inventario nunca revierta el avance de una orden y resuelve automáticamente la
incidencia cuando el reintento termina correctamente.

Migraciones:

- `20260820184644_inventory_consume_on_dispatch_v1.sql`;
- `20260820185313_inventory_dispatch_issue_resolution_v1.sql`.
