# Delivery: relación de servicios y registro de pagos

## Causa y corrección

El lector anterior dejó de usar el tabulador cuando faltaba un costo guardado. Al mismo tiempo, la asignación interna desde Ops podía enviar un costo vacío. El catálogo conservaba las tarifas, pero la consulta presentaba importes faltantes.

- `assign_delivery_with_cost_v1` conserva su firma y las reglas externas. En asignaciones internas sin importe manual, captura la tarifa interna de los productos de la orden. Un cero explícito no se sustituye. Sin tarifa válida la operación continúa pendiente, sin inventar cero.
- Cálculo legacy conserva los costos guardados; para internos sin costo vuelve a mostrar una estimación explícitamente rotulada «propuesto». No se presenta la estimación como costo histórico certificado ni como deuda neta de pagos anteriores.
- No hay relleno masivo de órdenes históricas ni alteración de inventario, precios al cliente, cobros o custodia.

## Administración → Finanzas → Delivery

Todos los números de orden visibles usan el identificador corto canónico (ID de orden), incluida la descarga, los comprobantes y la custodia. La referencia larga permanece únicamente como evidencia interna.

Período inclusivo en fecha Caracas; filtros por interno/externo, responsable exacto, orden y cliente. Tabla paginada de 30, totales y CSV de toda la selección (máximo 5000 entregas por consulta; no trunca resultados). El costo interno procede de `internal_rider_pay_usd`, no del precio cobrado al cliente. Las propuestas externas usan una única tarifa activa de la empresa para la distancia registrada; huecos y superposiciones quedan pendientes.

Fecha: último evento `delivered` de una orden actualmente entregada; las regularizaciones con fecha expresamente confirmada usan esa fecha sin inventar una hora. Órdenes sin ninguna de estas evidencias no entran en períodos.

Selección de hasta 500 entregas de un responsable:

1. Confirmar propuestas históricas solo si corresponden al período.
2. Registrar un egreso nuevo en cuenta USD/VES, con monto nativo, tasa explícita si aplica, fecha y referencia; o vincular un egreso independiente existente confirmado cuyo total USD coincida exactamente.
3. Revisar que la selección no duplica pagos anteriores. «Sin pago vinculado» no asegura que nunca se pagó fuera del sistema o mediante un egreso genérico.
4. Consultar el recibo con detalle congelado de las entregas. Puede anularse íntegramente con motivo. Una anulación conserva evidencia e historial; si solo se había vinculado un egreso anterior, este se conserva.

Al confirmar una tarifa propuesta para pagar, se guarda también su costo en la orden con usuario, fecha y evento. Así, el cálculo tradicional y Administración conservan el mismo importe confirmado aunque cambie después el catálogo. No sucede al consultar ni automáticamente para órdenes históricas.

El botón registra contablemente una transferencia/entrega de dinero realizada fuera de la aplicación: no envía dinero al banco. No admite abonos parciales a una entrega ni una factura que combine responsables. Se pueden pagar grupos parciales de entregas de un período. Las comisiones bancarias se mantienen en el flujo de egresos existente; no se inventan tarifas, deducciones o compensaciones de nómina.

Custodia se mantiene en `/app/admin/finanzas/delivery/custodia`; sus liquidaciones no son remuneración del repartidor. Las rutas de detalle anteriores permanecen disponibles.

## Integridad

Nuevas tablas con RLS, lectura exclusiva Admin y escritura directa revocada. Comando público invoker, implementación privada definer con autorización explícita y `search_path` vacío. Recibo por solicitud; mismo envío devuelve el mismo resultado. Bloqueo ordenado por órdenes y exclusividad por entrega/egreso impiden dobles vínculos en períodos superpuestos. Se verifica la huella de la vista antes de pagar y se conserva la base confirmada aunque cambie el catálogo.

Egreso, recibo y enlaces son una transacción. Las pantallas antiguas no pueden alterar por separado un egreso vinculado ni cancelar/reasignar una entrega pagada: se anula primero el registro de servicios. Esto es una corrección contable; no representa una devolución bancaria.

## Verificación

- `npm run test:delivery`: estimaciones, ceros, cantidades inválidas, totales completos, pagos congelados, alcance temporal, exportación y regresiones de delivery.
- `npm run test:admin`, `test:admin-operations`, `test:security` y compilación de producción.
- `tests/admin/delivery-services.rollback.sql`: datos sintéticos; permisos Admin/asesor/Master/anónimo, captura interna, confirmación de tarifas, vista obsoleta, reintento, superposición, USD/VES, anulación y conservación histórica, egreso anterior e inyección de fallo final sin egreso huérfano.
- Regresiones SQL de asignación, corrección y tarifa externa, todas con reversión completa.
- No se ejecutan pagos reales como parte de las pruebas. La exclusividad se prueba con reintentos y solapamientos secuenciales; no se afirma prueba de carrera en dos sesiones independientes.
- El asesor de seguridad detecta los nombres de las dos tablas nuevas en GraphQL para usuarios autenticados, por su permiso de lectura. Las pruebas confirman que RLS oculta las filas al asesor y que no hay escritura directa. No se declara el proyecto libre de advertencias: [alcance del aviso de descubrimiento GraphQL](https://supabase.com/docs/guides/database/database-linter?lint=0027_pg_graphql_authenticated_table_exposed).

Guías de Supabase/Postgres: transacciones, evidencia y permisos. Guías Next.js/React: separación de consultas de negocio, acciones autenticadas y protección de doble envío. Guías Vercel y Browser: publicación y revisión de interfaz.
