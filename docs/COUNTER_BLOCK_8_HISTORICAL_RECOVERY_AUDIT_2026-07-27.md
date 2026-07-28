# Auditoría final del Bloque 8 - Consulta histórica y recuperación operativa

Fecha: 2026-07-27

Alcance: `/app/counter` y los RPC de lectura histórica necesarios para
Mostrador.

## Resultado

El Bloque 8 queda cerrado. Counter puede localizar una orden fuera de su bandeja
activa por número corto, nombre o teléfono; revisar su expediente operativo
completo bajo demanda; ejecutar solamente las acciones que todavía autoriza su
estado; y abrir el motor de cobro existente para una deuda futura, antigua o ya
entregada.

No se creó ninguna tabla ni se modificó ningún archivo de
`/app/master/dashboard`.

## Modelo reutilizado

El bloque conserva las fuentes y operaciones existentes:

- `orders`, `order_items` y `clients` siguen siendo las fuentes de la orden, sus
  productos y el cliente;
- `order_timeline_events` conserva la trazabilidad operativa;
- el estado financiero sigue derivándose del motor canónico de pagos;
- `counter_search_orders` y `counter_read_order_detail`, creados en el Bloque 3,
  fueron ampliados en vez de duplicados;
- el cobro reutiliza `CounterPaymentEngine`;
- la corrección de agenda, la entrada idempotente a cocina y las demás acciones
  permitidas reutilizan los comandos cerrados en los bloques anteriores.

## Contrato implementado

- La búsqueda se ejecuta únicamente cuando el operador la solicita.
- Admite el `orders.id` corto, incluso cuando tiene un solo dígito, nombre del
  cliente, teléfono, nombre del receptor y teléfono del receptor.
- Los nombres no dependen de mayúsculas ni acentos.
- Los teléfonos se comparan por sus dígitos normalizados.
- Cada página devuelve como máximo 25 resultados y continúa mediante cursor.
- El resultado ligero muestra cliente/receptor, agenda, modalidad, estado,
  resumen de productos, preparación, entrega y situación de pago.
- Los productos completos y el recorrido operativo se leen únicamente al abrir
  un expediente.
- Abrir una orden histórica no la introduce en la bandeja activa.
- Una orden pickup todavía editable puede corregir su fecha/hora con motivo y
  entrar a cocina mediante el comando idempotente existente.
- Una orden futura, antigua o entregada con saldo puede abrir el cobro mixto.
- Un pago digital reportado conserva la confirmación pendiente de Master.
- Una orden entregada queda en solo lectura operativa, pero admite pagos.
- Una orden cancelada queda totalmente en solo lectura y no admite cobro.
- Las acciones disponibles se derivan del estado real de la orden y no de la
  apariencia de la tarjeta de búsqueda.
- El resultado no expone movimientos, cuentas ni auditoría financiera
  administrativa.

## Presupuesto de carga

- La apertura de Counter no carga historial.
- Cada búsqueda o página adicional realiza una sola llamada a
  `counter_search_orders`.
- Cada expediente abierto realiza una sola llamada a
  `counter_read_order_detail`.
- No existen consultas individuales por resultado ni por producto.
- La situación financiera se calcula solamente para los resultados de la página
  solicitada, nunca para todo el histórico.
- El resumen incluye como máximo tres líneas de productos; el detalle completo
  queda fuera de la respuesta ligera.
- La paginación por cursor evita contar o desplazar todo el conjunto histórico.

Este diseño separa la operación diaria ligera de la recuperación precisa: la
información profunda existe, pero no se precarga.

## Índices

Se agregaron exactamente tres índices funcionales, sin tablas auxiliares:

- teléfono normalizado de `clients`;
- nombre normalizado de receptor en `orders`;
- teléfono normalizado de receptor en `orders`.

Se conservaron los índices existentes para `orders.id`, número de orden y nombre
normalizado del cliente.

La verificación con `EXPLAIN (ANALYZE, BUFFERS)` confirmó:

- la rama de teléfono de cliente pasó de un recorrido secuencial de
  aproximadamente 6.501 clientes y 35,7 ms a un `Bitmap Index Scan` de
  aproximadamente 0,3 ms;
- la búsqueda combinada por nombre/teléfono de receptor usa ambos índices
  mediante `BitmapOr` y resolvió la muestra en aproximadamente 0,24 ms.

Las cifras son observaciones de la base al momento de la auditoría y no un SLA.

## Migraciones remotas

- `20260728012828_counter_block_8_historical_recovery`
- `20260728013250_counter_block_8_index_hardening`
- `20260728013741_counter_block_8_index_helper_access`

Los archivos versionados son:

- `docs/COUNTER_BLOCK_8_HISTORICAL_RECOVERY_2026-07-27.sql`;
- `docs/COUNTER_BLOCK_8_INDEX_HARDENING_2026-07-27.sql`;
- `docs/COUNTER_BLOCK_8_PERMISSION_HARDENING_2026-07-27.sql`;
- `docs/COUNTER_BLOCK_8_ROLLBACK_2026-07-27.sql`.

La migración principal contiene la definición completa de los dos RPC y sus
controles. Su longitud no representa consultas repetidas en ejecución.

## Seguridad

- Los RPC validan `auth.uid()` y exigen Counter, Master o Admin.
- `PUBLIC` y `anon` no tienen `EXECUTE`.
- Un usuario autenticado sin rol operativo fue rechazado con SQLSTATE `42501`.
- Las funciones `SECURITY DEFINER` fijan un `search_path` controlado.
- El helper inmutable de teléfono es ejecutable por `authenticated` únicamente
  para que las escrituras legítimas puedan mantener el índice de expresión; no
  lee tablas ni eleva privilegios.
- El advisor registra como informativo que los RPC operativos
  `SECURITY DEFINER` son ejecutables por `authenticated`. Es intencional: son la
  API acotada del módulo y vuelven a comprobar identidad y rol dentro de la
  función.

No se introdujeron políticas RLS ni permisos directos sobre tablas.

## Pruebas transaccionales

Las pruebas se ejecutaron con `ROLLBACK`, sin persistir datos de prueba.

Casos aprobados:

- número corto de orden de un solo dígito;
- nombre con y sin acento;
- teléfono con normalización;
- nombre/teléfono alternativo del receptor;
- página acotada, cursor disponible y páginas sin solapamiento;
- resumen ligero sin arreglo completo de items;
- expediente bajo demanda con todos los items;
- lectura de una orden entregada y su fecha de entrega;
- situación de pago presente en el resultado;
- rechazo de usuario autenticado sin rol autorizado;
- permisos de ejecución para `authenticated` y denegación para `anon`.

## Verificación de código

- ESLint focalizado en los archivos modificados: aprobado.
- TypeScript sin emisión: aprobado.
- Build de producción con Next.js 16.2.6: aprobado.
- `git diff --check`: aprobado.
- No existen cambios bajo `/app/master/dashboard`.

## Rollback

El rollback elimina los tres índices nuevos, restaura la búsqueda del Bloque 3 y
retira el helper de teléfono. Los campos operativos adicionales del detalle son
compatibles de forma aditiva con los consumidores anteriores y se conservan para
no reemplazar innecesariamente el contrato financiero cerrado en el Bloque 4.

## Siguiente bloque

Bloque 9 - Cajas, puntos y cierres.

Debe completar la operación diaria de las cajas y puntos autorizados, cargar
cada espacio bajo demanda y mantener separados el cierre operativo, la
aprobación de gastos mayores y cualquier análisis financiero administrativo.
