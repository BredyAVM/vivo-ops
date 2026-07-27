# Auditoría final del Bloque 6 - Delivery y liquidación

Fecha: 2026-07-27

Alcance: `/app/counter` y RPC operativos de despacho, custodia, retorno y
cambio digital.

## Resultado

El Bloque 6 queda cerrado. Counter entrega un pedido listo al motorizado
asignado, registra el ETA, el cobro esperado y el cambio que sale de caja en
una única operación. La custodia puede liquidarse de forma total, parcial, en
otro turno o en otro día.

La entrega física final sigue siendo competencia exclusiva de Master. La deuda
del cliente, el estado de entrega y la custodia del motorizado permanecen como
ejes independientes.

No se modificó ningún archivo de `/app/master/dashboard`.

## Modelo reutilizado

No se creó ninguna tabla.

El bloque reutiliza:

- `orders` para cumplimiento físico y ETA;
- `delivery_settlements` para la liquidación persistente;
- `delivery_settlement_entries` para cobro esperado, cambio, custodia y
  retornos;
- `money_movements` como único ledger;
- `payment_reports` para el efectivo recibido y confirmado;
- `order_change_obligations` para el cambio digital pendiente;
- `counter_command_receipts` para idempotencia;
- `order_events` y `order_timeline_events` para trazabilidad.

Se añadieron vínculos entre la obligación digital y la liquidación/entrada que
la originó. No se creó un saldo, pago ni estado financiero paralelo.

## Contrato implementado

- Sin motorizado o partner asignado, la orden no sale.
- El ETA es obligatorio y queda en la orden y la línea de tiempo.
- Despacho permitido únicamente desde delivery `ready`.
- La salida cambia la orden a `out_for_delivery`; Counter nunca la marca
  `delivered`.
- El cobro esperado acepta USD, VES y varias líneas.
- El cambio puede dividirse entre efectivo y digital.
- El cambio asignado debe coincidir con cobro esperado menos saldo actual.
- Cada cambio en efectivo genera el egreso exacto en la caja seleccionada.
- El cambio digital queda a cargo del asesor asignado o de Master cuando no
  existe asesor.
- La ejecución digital completa obligación, movimiento y liquidación en una
  sola transacción.
- El retorno registra por separado lo recibido del cliente y lo ingresado
  realmente a caja.
- Se aceptan retornos parciales y posteriores sin reabrir la cobranza ya
  declarada final.
- Una diferencia de custodia queda como `discrepancy`.
- Una deuda restante del cliente no impide liquidar una custodia cuadrada.
- Motorizados internos y externos usan el mismo modelo.
- Liquidaciones antiguas abiertas se consultan bajo demanda y con cursor.
- El cierre de caja no depende de cerrar todas las liquidaciones; depende del
  efectivo contado contra movimientos confirmados.

## Interfaz operativa

- El botón de salida antiguo dejó de llamar `counter_dispatch_order`.
- La salida abre un formulario de custodia con ETA, cobro esperado y cambio.
- La orden `out_for_delivery` ya no muestra `Marcar entregada`.
- El detalle muestra custodia pendiente, saldo de la orden y cambio digital
  como valores separados.
- El retorno permite varias monedas y varias cajas.
- El panel `Liquidaciones` no se precarga: consulta 25 pendientes al abrir y
  pagina por cursor.
- Una liquidación puede seguir visible aunque la orden ya no esté entre las
  primeras órdenes de la cola activa.
- La funcionalidad se extrajo de `CounterClient.tsx` a un componente de dominio
  propio para no seguir ampliando el monolito principal.

## Migraciones remotas

- `20260727160408_counter_block_6_delivery_dispatch`
- `20260727160452_counter_block_6_delivery_read_model`
- `20260727161933_counter_block_6_digital_change_execution`
- `20260727162100_counter_block_6_dispatch_idempotency`

La última migración conserva en el comprobante el resultado enriquecido del
despacho, de modo que un reintento posterior devuelva exactamente la misma
respuesta aunque la orden haya cambiado.

## Seguridad

- `PUBLIC` y `anon` no pueden ejecutar los RPC del bloque.
- Cada RPC público valida `auth.uid()`, rol, estado y argumentos.
- Counter y Master/Admin pueden despachar y registrar retornos.
- Counter no puede ejecutar cambio digital.
- El asesor solo puede ejecutar la obligación que le fue asignada.
- Master/Admin ejecuta la obligación cuando su responsable canónico es Master;
  Admin conserva override.
- La ruta digital heredada se retiró de `authenticated` para impedir que el
  movimiento y la obligación se desincronicen.
- `authenticated` no tiene lectura directa sobre las tablas de liquidación.
- Las lecturas pasan por RPC acotados con validación de rol.
- Todos los RPC nuevos fijan `search_path = ''`.

El advisor de Supabase marca como advertencia intencional los tres RPC
`SECURITY DEFINER` ejecutables por `authenticated`. Son entradas operativas
estrechas, no funciones genéricas, y validan identidad y autoridad dentro de
la transacción. El aviso de RLS sin política sobre `order_change_obligations`
también es intencional: no existe acceso directo para `authenticated`.

Los avisos de llaves foráneas sin índice son previos y corresponden a usuarios
de auditoría que no forman parte de los filtros del módulo. Los dos vínculos
nuevos sí tienen índices de cobertura.

## Pruebas transaccionales

Todas las pruebas de base se ejecutaron en una transacción con `ROLLBACK`.

Casos aprobados:

- rechazo de delivery externo sin partner o motorizado;
- rechazo de salida sin ETA;
- despacho con cobro esperado de USD 50 sobre saldo de USD 37;
- cambio mixto: USD 10 en efectivo y USD 3 digital;
- un solo egreso de caja ante el reintento;
- respuesta idempotente exacta;
- obligación digital asignada al asesor de la orden;
- rechazo del Counter al intentar ejecutar esa obligación;
- ejecución por el asesor responsable y vínculo con el movimiento;
- retorno parcial de USD 20;
- retorno final posterior de USD 30;
- liquidación final exacta y orden sin saldo ni excedente ficticio;
- custodia liquidada con USD 15 todavía debidos por el cliente;
- cierre con USD 5 faltantes convertido en `discrepancy`;
- las tres órdenes permanecieron `out_for_delivery`, sin mutación final por
  Counter;
- lectura detallada por rol Counter.

La auditoría posterior confirmó:

- cero liquidaciones sintéticas;
- cero entradas sintéticas;
- cero obligaciones digitales sintéticas;
- lectura directa de tablas rechazada para `authenticated`;
- ruta digital heredada no ejecutable por `authenticated`.

## Lectura ligera

La apertura de `/app/counter` no carga liquidaciones.

- La bandeja se solicita únicamente al abrir `Liquidaciones`.
- Cada página trae como máximo 25 filas.
- El detalle se solicita al seleccionar una liquidación.
- El historial de entradas está limitado a 100 filas.
- No existe consulta por orden desde el cliente.
- Los filtros abiertos usan los índices creados en los Bloques 2, 3 y 4.

## Verificación de código

- TypeScript sin emisión: aprobado.
- ESLint focalizado: aprobado.
- Build de producción con Next.js 16.2.6: aprobado.
- Redirección local no autenticada a `/login`: aprobada.
- Consola del navegador en esa carga: sin warnings ni errores.
- La inspección visual autenticada queda para la prueba operativa con sesión
  Counter, porque no se usaron ni inventaron credenciales.
- No existen cambios bajo `/app/master/dashboard`.

## Reversión

`docs/COUNTER_BLOCK_6_ROLLBACK_2026-07-27.sql` contiene una reversión
conservadora. Se detiene si existe cualquier custodia real; no permite borrar
movimientos o liquidaciones para forzar el rollback.

## Siguiente bloque

Bloque 7 - Venta directa y agenda.

Debe revisar y completar la creación de cliente, venta inmediata hacia cocina
y venta futura hacia agenda, reutilizando el compositor y los precios
canónicos que ya existen.
