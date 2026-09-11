# Cancelación financiera segura de órdenes

Fecha: 2026-09-11. Continúa ADMIN_CLIENT_CHANGE_RECEIVABLE_2026-09-11.md.

## Resultado operativo

Master/Admin mantienen las dos opciones existentes: enviar el pago disponible
al fondo del cliente o devolverlo desde cuentas. El fondo que se había usado
para pagar la orden se restaura por separado. Dashboard admite devolución
parcial y guarda el resto; Ops exige devolución completa. No hay nuevas
aprobaciones ni campos técnicos para el usuario.

Al abrir Cancelar se consulta un resumen exclusivo de esa orden: efectivo
disponible, fondo aplicado pendiente de restaurar y excedente ya enviado al
fondo. La confirmación usa la misma fotografía; si cambió, exige actualizar.
La consulta solo se ejecuta con el formulario abierto.

## Reglas y ejemplos

- Pago de 120 por orden de 100 con excedente 20 ya guardado: cancelar a fondo
  agrega 100, no 120. El cliente conserva 120 en total, no 140.
- Si esos 20 ya se gastaron en otra orden, no se vuelven a acreditar.
- Fondo aplicado 30 y previamente restaurado 10: se restauran solo 20.
- Cambio a favor 4,73 entregado como 5 después de pago 14,73: cancelar permite
  devolver 9,73. No se vuelve a devolver el cambio ni se conserva deuda de venta
  de una orden cancelada en la cartera vigente.
- Bs se valoran según sus movimientos confirmados, no por el importe nominal
  de la factura ni por la tasa del día de cancelación.
- Reportes pendientes se rechazan dentro de la cancelación. Movimientos de
  dinero pendientes u obligaciones de cambio abiertas requieren resolverse
  primero para evitar dos entregas del mismo dinero.

## Integridad y permisos

`cancel_order_atomic_v1` guarda en una sola transacción restauración de fondo,
devoluciones, rechazo de reportes pendientes, estado de la orden, ambos
historiales y comprobante protegido con fotografía previa, usuario y hora.
Una falla tardía revierte todo. La misma solicitud se puede reintentar sin
duplicar movimientos; otra solicitud no puede cancelar otra vez esa orden.

Funciones privilegiadas privadas, search_path cerrado, sesión obligatoria y
autorización Master/Admin dentro del comando. Tabla de comprobantes sin
escritura directa para los roles de aplicación; lectura Master/Admin con RLS.
Orden, cuentas, movimientos, reportes y fondo se bloquean durante la operación.

Una cancelación con dinero no puede ejecutarse mediante una actualización
directa del estado, incluida la ruta del asesor. El asesor conserva la
cancelación de órdenes sin dinero con sus permisos existentes. Se bloquean
pagos nuevos sobre órdenes canceladas y modificaciones aisladas del dinero de
las cancelaciones certificadas; tampoco se permite reabrirlas o cambiar su
cliente/importes. La corrección integral de una cancelación queda pendiente.

Inventario y CRM conservan sus disparadores existentes. Cancelar no implica
que mercancía físicamente entregada volvió al almacén; no se simula devolución
física ni se modifican cierres históricos de comisiones.

## Verificación

- 114 pruebas Node de administración, 79 de comisiones y 6 de seguridad.
- Compilación de producción Next.js y su comprobación TypeScript aprobadas.
  `tsc --noEmit` directo sigue señalando errores previos de tipos en archivos
  de pruebas .mts; no se cambiaron ni se ocultaron en este bloque.
- SQL con datos sintéticos bajo ROLLBACK: sin dinero, excedentes, excedente
  gastado, fondo aplicado neto, cambio adelantado, USD/VES, devolución parcial,
  devolución exacta Ops, montos inválidos, resumen desactualizado, reintentos,
  fallo tardío, rechazo de reportes, protecciones posteriores y permisos.
- Regresión SQL de confirmación, cambio a cobrar, anulación financiera,
  transferencias y cierres de cuentas con los nuevos disparadores presentes.
- Ninguna orden, pago o devolución comercial real se usa para probar.

## Límites y siguiente secuencia

Publicación expand/contract: primero la migración de operación atómica,
después las acciones Dashboard/Ops y, solo al verificar READY, la migración
`order_cancellation_cutover_guard_v1`. Evita que una pantalla antigua abone
fondo y falle únicamente al actualizar el estado. El guard final se verifica
de nuevo bajo ROLLBACK. Abrir de nuevo la pantalla si el navegador conservó
una versión anterior al despliegue.

Los movimientos antiguos de fondo sin vínculo suficiente se bloquean para
conciliación, no se interpretan por aproximación. No se reparan cancelaciones
históricas, ni se revierte individualmente un pago ya liquidado al cancelar.
No se realizó una prueba de carga con sesiones concurrentes independientes.
Los avisos de seguridad previos del proyecto no se consideran resueltos por
este bloque; se compara la revisión antes/después y se inspeccionan los nuevos
objetos y permisos.

Revisión posterior: sin nuevos avisos de search_path, funciones privilegiadas
públicas o acceso anónimo. El catálogo GraphQL detecta una tabla adicional
visible para authenticated (75 frente a 74); la política RLS limita sus filas
a Master/Admin y el ensayo como asesor devuelve cero comprobantes. Es un
aviso de descubrimiento del esquema, no una autorización de lectura de filas.
[Criterio del aviso](https://supabase.com/docs/guides/database/database-linter).
La sesión de navegador disponible es Asesor; la inspección visual del nuevo
formulario Master/Admin queda pendiente de una sesión con ese rol.

Publicación funcional: commit `6b155f7`, despliegue
`vivo-9h9hgr6jn-bredyavms-projects.vercel.app`, READY con alias de producción.
Migraciones aplicadas: `20260911171210` (operación) y `20260911171756`
(protección posterior al despliegue). Suite SQL de cancelación repetida después
de ambas migraciones: aprobada. Consulta sin escritura de las 20 órdenes
vigentes más recientes: 20 resúmenes disponibles, cero bloqueos en esa muestra.
Revisión de logs de esa publicación: un aviso Node DEP0169 por `url.parse()`
en una respuesta HTTP 200, sin excepción funcional identificada en esa muestra.
Su origen exacto queda pendiente de diagnóstico; no se ocultó la advertencia.

Pendientes: nómina y deducibles; uso independiente del fondo y redondeo atómicos;
conciliación histórica guiada; corrección integral de cancelaciones; rediseño
visual KPI-first de las pantallas terminadas. Revisar cada bloque y publicarlo
por separado, como se acordó con el usuario.
