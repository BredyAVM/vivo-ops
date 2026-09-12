# Cierre de cuentas desde Administración

## Implementación

- Cuentas y Herramientas abren `/app/admin/finanzas/cuentas/cierre`. La cuenta del
  enlace se conserva; una cuenta no disponible no se sustituye silenciosamente.
- Cuenta, fecha, hora de Caracas para caja/punto, contado, tasa VES y notas. Motivo
  diario prellenado. Banco/cartera conserva corte diario completo.
- Saldo esperado y diferencia estimada se actualizan al cambiar el corte. Una
  respuesta tardía de otra selección no sustituye el contexto actual. Errores no
  se muestran como saldo cero.
- La vista previa se extrae del panel vigente a un lector compartido. Ambos usan
  sesión/RLS en vez de credenciales de servicio para esa consulta. Paginación de
  movimientos y referencias evita el límite silencioso de las primeras 1000 filas.
- Guardado mediante `create_account_closure_v1`, sin segunda contabilidad ni
  nuevas reglas de diferencias. El comando calcula el corte final y guarda cierre,
  diferencia conciliable si corresponde y comprobante de forma atómica.
- Mismo ID y mismos datos para comprobar un resultado incierto; edición bloqueada
  mientras se guarda y durante la incertidumbre. Comprobante con ID, diferencia
  efectiva y enlace al historial de la cuenta/fecha.
- Cerrar el punto no transfiere dinero al banco. Se mantiene el traspaso separado
  del flujo actual; este corte no crea depósitos supuestos ni pagos bancarios.

## Límites explícitos

- La vista previa es informativa y no reserva movimientos; la diferencia efectiva
  se recalcula al guardar. No se certifica aquí todo el protocolo concurrente de
  los escritores anteriores del libro de movimientos.
- Identidad del intento conservada durante la vida del formulario. Recuperación
  automática después de recarga/cierre del navegador sigue pendiente; la interfaz
  advierte no recargar un envío incierto y permite comprobar el mismo intento.
- Anulación de cierre, resolución de diferencias, configuración de perfiles y
  línea base siguen en el centro vigente. No se declara conciliación terminada.
- Guardar desde Admin requiere Admin; el comando compartido conserva el acceso
  Master autorizado previamente para el panel operativo.

## Pruebas

- 181 pruebas aprobadas (119 Admin, 56 operaciones, 6 seguridad), compilación de
  producción y ESLint de los archivos nuevos aprobados. Sin residuos de las
  cuentas, movimientos ni función de la prueba SQL.

- 11 pruebas nuevas de modelo, acción real con sesión/base simuladas y lector real:
  monedas, valoración histórica, día/hora, ancla anterior, punto y retiro vinculado,
  1001 movimientos, permisos, reintentos, fallos, comprobante y controles de interfaz.
- Prueba SQL canónica repetida con cuentas ficticias y ROLLBACK: banco, caja,
  punto, VES, duplicados, diferencias, anulación, dependencias y fallo tardío.
- Lectura real con sesión Master comprobada para perfiles, bases y cierres después
  de retirar credenciales de servicio de la vista previa. Sin cierres reales.
- La comprobación global `tsc --noEmit` encuentra errores previos en tests de
  comisiones y tipados Node registerHooks; no son errores de los archivos nuevos.
  La compilación Next verifica tipos de aplicación por separado.
