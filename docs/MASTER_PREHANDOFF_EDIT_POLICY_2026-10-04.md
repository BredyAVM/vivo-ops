# Modificaciones operativas antes de la salida física — 2026-10-04

## Regla vigente

Máster y Administración pueden agregar, sustituir, aumentar, reducir y retirar
productos antes de su salida física, incluso si la orden está en cocina, lista,
pagada al 90 % o más, o tiene protección manual del precio. Una reducción no
requiere Administración solamente por cambiar el total resultante del pedido.
El motivo y la auditoría de la modificación avanzada siguen siendo obligatorios.

El corte es `out_for_delivery` para delivery y `delivered` para pickup. No se
habilita edición ordinaria de órdenes despachadas, entregadas o canceladas.
Después de ese corte se necesitan los procedimientos formales de corrección y,
si corresponde, devolución física de inventario. No se amplían permisos del asesor.

La protección económica permanece: Máster no puede crear, copiar, trasladar a
otro producto ni cambiar precios especiales administrativos. Tampoco renegocia
descuentos, impuestos o tasa manual de una orden protegida. Las líneas que
permanecen conservan su moneda de origen, precio unitario, snapshots y evidencia
de aprobación; cambiar su cantidad o retirarlas no otorga un precio nuevo.
Una línea nueva o un producto sustituto usa el catálogo vigente, no hereda el
precio especial del producto retirado. Los beneficios CRM mantienen sus reglas.

Un producto histórico desactivado puede conservarse, reducirse o retirarse.
No puede aumentarse ni venderse nuevamente mientras esté inactivo.

Esta política sustituye únicamente la restricción de cantidades/retiros de
líneas aprobadas descrita el 2026-09-30 en el handoff; no elimina la protección
de sus términos unitarios ni la identidad y contexto de la aprobación.

## Dinero y trazabilidad

- Guardar una modificación no modifica, anula ni recrea el pago original.
- El total nuevo y el saldo se leen del estado financiero canónico.
- Si se reduce un pedido con fondo aplicado, el monto aplicado ya existente se
  limita al nuevo total y la diferencia vuelve al fondo mediante el ledger del
  guardado atómico existente; no se crea un segundo pago.
- Si los pagos confirmados dejan excedente, Máster decide en Pagos: `Guardar en
  fondo` o `Devolver diferencia`. No se convierte automáticamente en devolución.
- `store_operational_order_excess_v1` relee el estado bajo bloqueo de orden y
  cliente, descuenta obligaciones/cambios pendientes, registra créditos en
  `client_fund_movements` y actualiza el saldo del cliente en una transacción.
- Cada crédito se vincula a los reportes confirmados que lo respaldan. Así la
  anulación canónica puede revertirlo o rechazar la anulación si ese fondo ya se
  utilizó. Si un excedente histórico no tiene respaldo suficiente en reportes,
  no se inventa ese vínculo: se solicita conciliación y no se acredita nada.
- Reintentar la decisión no duplica el mismo excedente. El importe propuesto para
  devolver es el efectivamente acreditado por el servidor, no el saldo antiguo
  de la pantalla. La devolución usa el comando de fondo ya existente, con
  sus cuentas autorizadas, idempotencia, registro contable e historial.
- Cancelar el formulario de devolución deja el dinero en fondo; no significa
  que se entregó efectivo al cliente.

## Counter y Cocina

Counter conserva su permiso de modificar pickup antes del retiro, incluyendo
órdenes listas con protección de precio. No obtiene permiso de modificar
delivery ni de otorgar precios manuales o aprobar sus propios reembolsos.

En una orden pickup lista, agregar o aumentar productos clasificados
canónicamente como `products.inventory_group = 'beverages'` no reinicia cocina.
Una sustitución de Pepsi por Coca-Cola se trata como retiro más incorporación
de bebida. Agregar o aumentar comida sí conserva la vuelta a cocina del contrato
de Counter. Las reducciones y los cambios siguen auditados.

## Inventario

Las partidas retenidas conservan su `order_items.id`; una reducción de cantidad
actualiza esa fila y dispara los mecanismos existentes de composición y
compromisos. No se recrea la aprobación ni se reproducen ventas físicas.
Sustituciones/retiros utilizan el guardado atómico compartido, no un flujo local
de cada módulo. El corte físico y la tolerancia a incidencias de inventario no
cambian. No se agregan tablas ni columnas ni se reparan órdenes históricas.

## Implementación y verificación

- Helpers compartidos: `approved-price-preservation.ts` y
  `operational-edit-pricing.ts`.
- Editor/validación de Máster, guardado compartido `updateOrderAction` y comandos
  SQL actuales. No se modifican pantallas de `/app/master/dashboard`.
- Migración aplicada: `20261004190450_prehandoff_operational_item_changes.sql`.
- Pruebas aisladas: `tests/master-ops/operational-edit-pricing.test.mts` y
  `tests/master-ops/operational-edit-db.mjs`. La orden 3070 se consultó solamente
  como evidencia del bloqueo; no se altera ni se usa para escrituras de prueba.

Comprobación operativa después de publicar:

1. Con Máster, cambiar una bebida por otra en una orden lista y pagada; guardar
   con motivo. Debe conservarse el estado y el pago original.
2. Retirar una bebida de una orden pagada; comprobar total, saldo a favor y
   auditoría. Probar guardar en fondo o preparar/devolver la diferencia y ver
   cada momento en el historial financiero de la orden.
3. Con Counter puro, sustituir una bebida de pickup listo sin reiniciar cocina;
   agregar comida sí debe activar la preparación necesaria.
4. Confirmar que Asesor no edita una orden en cocina y que Máster no puede
   inventar un precio especial, aumentar un producto inactivo ni modificar una
   orden ya despachada/entregada.

Las pruebas automáticas no sustituyen esta comprobación con sesiones reales de
Máster/Counter después del despliegue; no se realizaron devoluciones reales para
verificar el cambio.

Verificación técnica: 52 pruebas Node, 14 comprobaciones de la nueva política en
PostgreSQL aislado, 19 regresiones de la migración previa, TypeScript y compilación
de producción correctos. La aplicación de la migración no cambió los checksums
de cabecera, partidas, pagos ni fondo de la orden 3070. Se verificó que `anon` no
ejecuta la RPC nueva y que esta exige autenticación y rol Máster/Admin, con
`search_path` vacío. El asesor de seguridad mantiene sus avisos previos y agrega
el aviso esperado de RPC `SECURITY DEFINER` ejecutable por `authenticated`; esa
ejecución es intencional y la autorización específica está dentro de la función.
