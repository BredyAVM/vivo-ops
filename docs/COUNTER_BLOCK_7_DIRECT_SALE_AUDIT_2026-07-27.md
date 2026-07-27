# Auditoría final del Bloque 7 - Venta directa y agenda

Fecha: 2026-07-27

Alcance: `/app/counter` y los RPC necesarios para su venta directa.

## Resultado

El Bloque 7 queda cerrado. Counter puede buscar o crear obligatoriamente al
cliente, componer una venta con el catálogo canónico, elegir pickup o delivery,
crear una orden inmediata para cocina o una futura para agenda y abrir
opcionalmente el motor de cobro ya existente.

No se modificó ningún archivo de `/app/master/dashboard`.

## Modelo reutilizado

El bloque conserva las fuentes existentes:

- `clients` sigue siendo la fuente única de clientes;
- `orders` y `order_items` siguen siendo la orden y sus líneas;
- `products` y `product_components` siguen definiendo catálogo, combos y
  configuraciones;
- `exchange_rates` sigue proporcionando la tasa vigente;
- `order_timeline_events` y sus destinatarios conservan la trazabilidad;
- `counter_command_receipts` conserva la idempotencia;
- los estados `confirmed` y `created` siguen siendo, respectivamente, la
  entrada a cocina y la agenda operativa;
- `CounterPaymentEngine` sigue siendo el único motor de cobro de Mostrador.

Se creó una sola tabla: `order_discount_rules`. Guarda reglas generales
activables y reutilizables por rol, método, moneda y modalidad. No duplica
órdenes, precios, pagos, agenda ni estados. La tabla quedó sin filas porque hoy
no existe ningún descuento habilitado.

## Contrato implementado

- No existe venta anónima: nombre y teléfono válido son obligatorios.
- Un teléfono se normaliza a E.164 y una restricción funcional evita duplicados
  concurrentes.
- Si el teléfono ya existe, se reutiliza el cliente en vez de crear otro.
- Cliente, datos fiscales, dirección reciente, orden, items, snapshots, totales
  y evento inicial se escriben en una sola transacción.
- Cada intento usa una llave idempotente; un reintento devuelve la misma orden
  y no repite cocina ni eventos.
- Productos inactivos y componentes inválidos se rechazan en servidor.
- Combos fijos se reconstruyen desde `product_components`.
- Productos configurables validan componentes permitidos, cantidades fijas,
  piezas requeridas y límite de detalle; las etiquetas se reconstruyen con los
  nombres actuales.
- Precio, moneda de origen y tasa se vuelven a leer al confirmar.
- Las líneas nacidas en VES conservan su monto exacto en bolívares; las nacidas
  en USD conservan su monto exacto en dólares.
- La venta inmediata queda `confirmed`, con una sola marca de envío a cocina y
  destinatario `kitchen`.
- La venta futura queda `created`, sin marca de cocina y con destinatario
  `master`.
- La orden guarda `attributed_advisor_id = null`; el operador y la atribución a
  Mostrador quedan en el snapshot de Counter.
- El porcentaje de descuento libre fue eliminado de la interfaz y del comando.
- Una regla seleccionada se valida de nuevo por vigencia, rol, método, moneda y
  modalidad dentro de la transacción.
- El vencimiento o la desactivación entre la carga del catálogo y la
  confirmación rechaza la venta completa.
- Factura, nota de entrega, receptor, dirección y GPS conservan snapshots en la
  orden.
- La opción `Abrir cobro al crear` selecciona la orden recién creada y abre el
  motor de pagos mixtos existente; no crea un segundo flujo financiero.

## Migración remota

- `20260727181211_counter_block_7_atomic_direct_sale`

La migración completa está en
`docs/COUNTER_BLOCK_7_DIRECT_SALE_2026-07-27.sql`. El rollback verificable está
en `docs/COUNTER_BLOCK_7_ROLLBACK_2026-07-27.sql`.

## Seguridad

- El RPC público valida `auth.uid()` y exige Counter, Master o Admin.
- `PUBLIC` y `anon` no tienen `EXECUTE`.
- El helper de composición no es ejecutable por `authenticated`.
- Las funciones `SECURITY DEFINER` fijan `search_path = ''`.
- `authenticated` no tiene lectura ni escritura directa sobre
  `order_discount_rules`.
- La tabla tiene RLS habilitado y solo `service_role` posee acceso directo.
- El catálogo devuelve únicamente reglas activas, vigentes y habilitadas para
  Counter.
- La acción de Next.js ya no usa la llave de servicio para crear una venta.

El advisor de seguridad informa dos avisos intencionales de RPC
`SECURITY DEFINER` ejecutable por `authenticated`: catálogo y creación de venta.
Ambos son entradas operativas necesarias y validan identidad y rol dentro de la
función. También informa que la tabla tiene RLS sin políticas; es intencional,
porque se revocó el acceso directo y toda lectura operativa pasa por el
catálogo acotado. Referencia:
[Supabase Database Linter](https://supabase.com/docs/guides/database/database-linter).

## Pruebas transaccionales

Las pruebas funcionales se ejecutaron con un usuario Counter sin Master/Admin
dentro de una transacción que terminó en `ROLLBACK`.

Casos aprobados:

- creación inmediata y entrada única a cocina;
- reintento idempotente con el mismo resultado y un solo comprobante;
- atribución a Mostrador sin asesor ficticio;
- snapshots exactos para la moneda de origen y la tasa;
- reutilización de cliente por teléfono normalizado;
- prevención de un segundo cliente con el mismo teléfono;
- venta futura delivery sin entrada prematura a cocina;
- factura, nota de entrega, receptor y dirección;
- producto configurable con componentes reconstruidos en servidor;
- regla activa aplicable, descuento e IVA exactos;
- rechazo de regla vencida en la confirmación;
- rollback total de la venta rechazada, incluido el comprobante;
- rechazo de usuario autenticado sin rol autorizado.

La auditoría posterior confirmó:

- cero reglas de descuento sembradas;
- cero clientes de prueba;
- cero órdenes de prueba;
- cero comprobantes de prueba persistidos.

## Rendimiento

- La apertura de Counter no añadió consultas.
- Catálogo, componentes y reglas continúan cargando únicamente al abrir una
  operación que los necesita.
- La creación es una sola llamada de red y una sola transacción.
- No existen consultas por item desde el cliente ni escrituras secuenciales.
- El RPC procesa únicamente los items enviados y sus componentes.
- El índice parcial de reglas activas cubre la lectura de Counter.
- El índice funcional de teléfono resuelve la deduplicación exacta sin recorrer
  el histórico.

El advisor de rendimiento marca como informativos los índices aún no usados
porque la tabla está vacía, y las llaves `created_by`/`updated_by` sin índices
propios. No existe una lectura por esos campos, por lo que agregar índices ahora
solo aumentaría el costo de escritura.

## Verificación de código

- TypeScript sin emisión: aprobado.
- ESLint focalizado en los archivos del bloque: aprobado.
- Build de producción con Next.js 16.2.6: aprobado.
- `git diff --check`: aprobado.
- La revisión de React no encontró efectos de datos, cascadas de consultas ni
  duplicación de estado financiero.
- El lint global conserva errores históricos fuera de Counter; el bloque no
  agregó errores en sus archivos.
- No existen cambios bajo `/app/master/dashboard`.

## Siguiente bloque

Bloque 8 - Consulta histórica y recuperación operativa.

Debe completar el buscador profundo paginado y el expediente bajo demanda,
permitiendo informar y cobrar órdenes antiguas sin convertir la apertura de
Counter en una carga histórica.
