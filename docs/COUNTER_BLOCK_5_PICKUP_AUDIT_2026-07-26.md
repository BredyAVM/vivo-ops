# Auditoría final del Bloque 5 - Pickup operativo

Fecha: 2026-07-26

Alcance: `/app/counter`, autorización puntual en `/app/master/ops` y RPC
operativos necesarios.

## Resultado

El Bloque 5 queda cerrado. Counter puede corregir la agenda de un pickup,
enviarlo a cocina una sola vez, modificar sus productos según el estado,
solicitar autorización para una orden preparada o con precio protegido y
registrar la entrega física con las reglas financieras canónicas.

No se modificó ningún archivo de `/app/master/dashboard`.

## Modelo reutilizado

El bloque conserva las fuentes canónicas existentes:

- `orders` y `order_items` siguen siendo la orden y sus líneas;
- `payment_reports`, `money_movements` y el estado financiero del Bloque 4
  siguen determinando el pago;
- `counter_command_receipts` conserva idempotencia;
- `order_timeline_events` conserva trazabilidad y avisos;
- la entrada y el retorno a cocina reutilizan los estados operativos de la
  orden.

Se creó una sola tabla: `counter_pickup_change_requests`. Su función es
conservar la solicitud y decisión de Master cuando Counter no puede modificar
un pickup directamente. No duplica órdenes, pagos, movimientos ni estados
financieros.

## Contrato implementado

- Corrección de fecha y hora antes de que el pickup esté listo, siempre con
  motivo.
- Envío a cocina idempotente desde la corrección operativa.
- Aumento, reducción y eliminación de líneas únicamente en pickup.
- Motivo obligatorio cuando existe reducción o eliminación.
- Reprecio y totales calculados en servidor con productos y tasa canónicos.
- Pedido listo o con precio protegido: solicitud pendiente sin mutación previa.
- Aprobación o rechazo exclusivamente por Master/Admin desde Master Ops.
- Retorno a cocina al aprobar una modificación que necesita preparación.
- Solicitud pendiente visible al abrir el detalle y bloqueante de la entrega.
- Entrega física de pickup por Counter.
- Efectivo o punto pendiente bloquean la entrega.
- Pago digital pendiente con asesor asignado permite entregar y mantiene la
  cobranza.
- Pago digital pendiente sin asesor bloquea hasta confirmación de Master.
- Cambio pendiente bloquea la entrega.
- Delivery no puede usar las mutaciones de pickup.
- Counter no puede cancelar una orden.
- Una orden entregada no admite cambios de agenda o productos; conserva la
  carga posterior de pagos.

## Migraciones remotas

- `20260726220533_counter_block5_pickup_operation`
- `20260726222410_counter_block5_trigger_safe_item_mutations`
- `20260726222552_counter_block5_timeline_recipient_types`
- `20260726223553_counter_block5_read_hardening`
- `20260726224452_counter_block5_completion_guard`

Las dos correcciones intermedias conservaron los triggers históricos de
`order_items`: las líneas existentes solo cambian cantidad y snapshots en
bolívares, y las adiciones usan el precio base activo que esos triggers
validan. No se deshabilitó ni reescribió ningún control histórico de precios.

## Seguridad

- Los comandos públicos validan `auth.uid()` y el rol autorizado dentro de la
  función.
- `PUBLIC` y `anon` no tienen `EXECUTE`.
- Los helpers internos no son ejecutables por `authenticated`.
- `authenticated` no tiene `SELECT`, `INSERT`, `UPDATE` ni `DELETE` directo
  sobre `counter_pickup_change_requests`.
- La lectura usa `counter_read_pickup_change_requests`, está limitada a 20
  solicitudes y valida Counter, Master o Admin.
- La decisión valida Master/Admin y una firma fresca de la orden antes de
  aplicar el plan aprobado.
- La restricción única permite como máximo una solicitud pendiente por orden.

El advisor de seguridad conserva avisos intencionales para los RPC
`SECURITY DEFINER` ejecutables por `authenticated`. Son la entrada operacional
necesaria para un Counter puro y todos validan identidad, rol, estado y
argumentos. La exposición GraphQL directa de la tabla fue eliminada.

El advisor de rendimiento informa que las dos llaves foráneas hacia perfiles
no tienen índices propios. No hay lecturas por solicitante o revisor y la
lectura real usa el índice por orden; crear esos índices ahora agregaría costo
de escritura sin servir una consulta del módulo.

## Pruebas transaccionales

Todas las pruebas funcionales se ejecutaron dentro de transacciones que
terminaron en `ROLLBACK`.

Casos aprobados:

- corrección de agenda y entrada a cocina;
- reducción y adición directa en pickup activo;
- recálculo exacto sin eludir los triggers de precio;
- solicitud sobre pickup listo sin mutación previa;
- aprobación por Master, aplicación y retorno a cocina;
- pickup con precio protegido enviado a autorización aun antes de estar listo;
- rechazo de modificación sobre delivery;
- entrega con pago digital pendiente y asesor;
- bloqueo del mismo caso sin asesor;
- bloqueo de efectivo pendiente aunque exista asesor;
- bloqueo de entrega mientras exista cambio digital pendiente;
- lectura del detalle con un usuario autenticado y rol Counter;
- acceso directo de escritura rechazado;
- reintentos protegidos por comprobante y estado.

La auditoría posterior confirmó cero órdenes y cero solicitudes de prueba
persistidas.

## Rendimiento

La cola activa no carga solicitudes por cada orden. El historial de
autorizaciones se consulta únicamente al abrir el detalle y en paralelo con el
resto del detalle.

`EXPLAIN (ANALYZE, BUFFERS)` sobre la lectura por orden confirmó:

- `Index Scan` en
  `counter_pickup_change_requests_order_requested_idx`;
- límite de 20 filas;
- 0 bloques leídos de disco en la medición;
- 0,119 ms de ejecución observada.

## Verificación de código

- TypeScript sin emisión: aprobado.
- ESLint focalizado: aprobado.
- Build de producción con Next.js 16.2.6: aprobado.
- `git diff --check`: aprobado.
- No existen cambios bajo `/app/master/dashboard`.

`src/app/app/master/ops/actions.ts` conserva 11 avisos históricos de
`no-explicit-any`; el archivo en `HEAD` presenta los mismos 11, por lo que el
bloque no agrega deuda de lint.

## Siguiente bloque

Bloque 6 - Delivery y liquidación.

Debe completar despacho al motorizado, ETA, cambio entregado, custodia y retorno
total o parcial entre días, sin mezclar la entrega física con el pago o la
liquidación.
