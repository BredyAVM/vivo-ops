# Administración operativa: hoja de ruta vigente

## Decisión del usuario

Administración debe servir para consultar y para actuar. Además de ingresos,
egresos y caja chica, debe permitir revisar órdenes, modificar precios o ajustes
cuando el estado y los permisos lo permitan, ratificar órdenes modificadas y
autorizar egresos. No agregar aprobaciones a operaciones que hoy no las necesitan.
Escritorio prioritario, móvil útil y poco texto. Publicar cortes verificados.

Este documento actualiza el orden de trabajo, no certifica que todos los bloques
estén implementados. Los documentos anteriores conservan evidencia histórica.

## Orden de implementación

1. **Cuentas operativas**: ingreso y egreso en Administración, cuenta preseleccionada,
   resultado e historial. Después, transferencias con el comando atómico existente.
2. **Autorizaciones y cierre**: bandeja por operación individual, no solo grupos por
   cuenta. Órdenes nuevas y re-aprobaciones, egresos, pagos reportados y ajustes que
   efectivamente requieran autorización. Integrar cierres y conciliación financiera.
3. **Cobranza y clientes**: saldo, pagos, diferencias, cambios y fondo del cliente,
   seguimiento y resolución desde cada caso sin repetir un cobro.
4. **Comisiones y delivery**: revisión, correcciones, cierre y pago; distinguir
   retorno de dinero en custodia del pago del servicio. Tratar faltantes e historia
   con evidencia, sin inventar costos ni pagos.
5. **Rectificaciones y devoluciones**: fechas/delivery/datos de órdenes con revisión
   del impacto; retorno físico por unidad y estado compatible, venta normal y avería
   o venta al asesor. La cancelación no demuestra por sí sola un retorno físico.
6. **Herramientas**: productos, inventario, clientes, equipo/permisos, tasa, tarifas,
   eventos y jugadas. Reutilizar centros vigentes; distinguir enlace de migración.
7. **Pendientes, auditoría y reportes**: cobertura de todos los dominios, filtros y
   exportación coherentes, quién hizo/solicitó/autorizó y cuándo.
8. **KPIs y diseño común**: facturación y cierres día/semana, cobrado/pendiente,
   entregas y comparación temporal; escritorio/móvil. Rentabilidad y proyecciones
   requieren acordar fuentes y metodología de costos.

## Contrato transversal de autorización

- Una pantalla de consulta no equivale a un circuito terminado.
- Mostrar operación, solicitante, motivo, fecha, importe/moneda y cuenta u orden.
- Para cambios de precio/ajustes: valores antes/después e impacto comercial,
  cobro pendiente/saldo a favor y comisiones afectadas. No confundir el importe de
  una orden con el importe del cambio solicitado.
- Aprobar, rechazar o corregir según el tipo. Rechazo con motivo; al corregir,
  volver a validar y autorizar el resultado actual, no una propuesta obsoleta.
- Aprobar una orden, ratificar una modificación y confirmar un egreso NO son el
  mismo comando. Conservar reglas por rol/estado y efectos propios.
- Proteger reintentos y concurrencia antes de migrar nuevas decisiones financieras.
- Los pendientes desaparecen al resolver la operación original, no por un botón
  genérico de cerrar tarea. Registrar actor, fecha y resultado sin pasos redundantes.
- No introducir un sistema de solicitudes de cambios de precio sin comprobar cómo
  se generan y ratifican hoy; la bandeja existente de pedidos activos no incluye
  todas las órdenes nuevas. No presentarla como cobertura total.

## Primer corte: ingreso y egreso nativos en Administración

Implementación inicial en `/app/admin/finanzas/cuentas/movimiento`:

- Acceso desde Inicio, Cuentas, cada cuenta activa y Herramientas.
- Reutiliza formulario y registro de Operaciones; agrega una acción de acceso
  exclusivamente Admin, sin nueva contabilidad ni service-role adicional.
- Preselecciona cuenta y tipo; rechaza enlaces a cuentas inactivas o no disponibles.
- Conserva moneda, tasa, fecha, motivo y campos opcionales; resultado y enlace a
  movimientos del día. Los pagos de clientes siguen registrándose en sus órdenes.
- Bloqueo inmediato de doble envío en el formulario y edición deshabilitada durante
  el envío. Esto NO equivale a idempotencia en base de datos ante pérdida de conexión:
  el registro existente aún requiere ese endurecimiento antes de certificar reintentos.
- No se cambia el umbral vigente de egresos de Master ni se autoaprueban solicitudes
  existentes. Admin ya confirma sus propios registros según la regla actual.

Pendientes de este corte: transferencias nativas, comprobante por ID de operación,
reintentos garantizados en base de datos y prueba funcional con sesión Admin en la
interfaz. La bandeja integral de autorizaciones sigue en el bloque 2; no se declara
construida por actualizar esta hoja de ruta.

## Verificación del primer corte

- 137 pruebas aprobadas: 118 Admin existentes, 6 seguridad y 13 del flujo operativo
  y su política. Casos nuevos ejecutan la acción real con dependencias de sesión y
  base de datos simuladas: USD/VES, comisión, ingreso, rechazo por rol, cuentas
  inactivas, error de escritura y navegación contextual.
- Compilación de producción y tipos de aplicación aprobados. Primera ejecución
  bloqueada por descarga de Google Fonts; repetición con red aprobada.
- ESLint de archivos nuevos y formulario compartido sin errores.
- Consulta real de solo lectura: 16 cuentas activas con moneda admitida, tasa activa
  disponible y RLS de movimientos habilitado. No demuestra por sí sola toda la
  política de permisos ni sustituye una prueba de escritura autenticada.
- Sin migraciones, cambios de roles ni transacciones sobre dinero real.
