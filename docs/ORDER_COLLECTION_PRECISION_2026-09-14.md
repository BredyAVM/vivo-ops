# Precision de cobranza

## Regla aprobada

Conservar la conversion precisa internamente y presentar importes monetarios con dos decimales. Despues de confirmar un pago, cerrar automaticamente un residuo positivo menor de USD 0,01, sin modificar el dinero realmente recibido. USD 0,01 exactos siguen pendientes.

## Separacion de responsabilidades

- `money_movements`: dinero nativo real y equivalente contable existente, sin cambio de escala ni reescritura historica.
- `order_collection_precision_enrollments`: inicio del tratamiento preciso para una orden sin movimientos o aplicaciones de fondo previos.
- `order_payment_precision_allocations`: cobertura USD precisa, diferencia por cierre/cotizacion, importe y cotizacion anteriores, tasa de cobertura, fecha, actor y movimiento origen. Su efecto solo cuenta mientras el movimiento esta confirmado.
- `get_order_financial_state`: unica salida canonica para todas las pantallas; mantiene su firma. `pending_usd` puede conservar mas decimales internamente; `pending_bs` es el importe nativo final cotizado.

No hay nuevos botones ni autorizaciones. La confirmacion atomica de Master/Admin y la insercion directa certificada de Counter pasan por el mismo registro de cobertura. Una anulacion conserva la asignacion historica, pero deja de aplicarla. Modificar el importe, moneda, tasa o fecha de un pago certificado exige anularlo y registrar el correcto.

## Base y compatibilidad

La tasa proviene de `extra_fields.pricing.fx_rate`, nunca del cociente de totales redondeados. Se usan snapshots de lineas, no el catalogo actual. Las lineas USD y los overrides USD mantienen su importe USD. Las lineas VES mantienen su importe Bs dividido por la tasa original sin redondeo prematuro.

Para ordenes totalmente VES se usa el total Bs, incluidos descuento e impuesto Bs, dividido por la tasa. En ordenes USD/mixtas se conservan los descuentos e impuestos USD ya autorizados del encabezado. A la misma tasa se respeta la cotizacion Bs por linea y se descuenta la cobertura confirmada. Una orden cuyo encabezado total es cero en ambas monedas no genera deuda por diferencias de redondeo.

Se exige coherencia entre encabezado y lineas. Los casos sin evidencia suficiente, con historia financiera previa no certificada o con ajustes administrativos de encabezado no conciliables con las lineas conservan el calculo anterior: no se adivina ni se migra su saldo. El uso previo de fondo tambien queda fuera de la incorporacion automatica. La incorporacion de esos historicos requiere otra revision expresa.

La precision usa `numeric` de PostgreSQL, no flotantes del navegador. No se cambia la moneda contable ni la tasa de los movimientos. Dos medios pagos VES no producen un fondo ficticio por la suma de sus equivalentes contables redondeados.

## Pruebas

`tests/admin/order-collection-precision.rollback.sql` se ejecuta despues de la migracion propuesta sin su `COMMIT`, seguido siempre de `ROLLBACK`:

- 2.000 combinaciones sinteticas de monto y tasa: cotizacion nativa completa y regreso al importe original.
- Tasa igual, mayor y menor; abonos parciales; dos abonos cuyos equivalentes USD redondeados suman un centavo mas.
- Pago completo en USD, residuo de 0,009 y deuda de 0,01; auditoria separada del dinero real.
- Conversion del abono congelada a su tasa; anulacion de pago y del cierre de residuo.
- Excedente real, fondo y reintento idempotente.
- Orden mixta, precios USD pequenos y redondeo por linea.
- Confirmacion Master/Admin y Counter; denegacion anonima; restricciones de escritura del historial.
- Orden pagada antes de la version permanece cerrada sin incorporacion retroactiva.

Tambien se ejecutan las regresiones SQL existentes de confirmacion y anulacion. Los fixtures usan cuentas, productos, clientes y ordenes sinteticos, no operaciones reales.

`npm run test:collection-precision` verifica los limites estructurales del contrato; no sustituye las pruebas SQL de comportamiento.

## Publicacion y controles

Migracion aplicada: `20260915001157_order_collection_precision_v1.sql`. Verificacion posterior: no quedaron ordenes sinteticas ni asignaciones de prueba persistentes.

Las tablas nuevas tienen RLS, lectura limitada a roles financieros y al asesor propietario, y carecen de permisos de escritura para la aplicacion. El asesor ajeno y el usuario anonimo se prueban expresamente. El auditor de Supabase avisa de que el esquema de las tablas es descubrible por usuarios autenticados; es el acceso de lectura intencional requerido por el calculador invocador, no una politica de lectura universal de filas. [Referencia del aviso](https://supabase.com/docs/guides/database/database-linter?lint=0027_pg_graphql_authenticated_table_exposed).

Los indices nuevos de claves foraneas pueden figurar inicialmente como no utilizados, al no existir todavia asignaciones reales. No se eliminan por ese aviso inicial. Las advertencias preexistentes de otros modulos no forman parte de esta correccion.
