# Autorizaciones operativas: primer corte

## Implementado

- `/app/admin/autorizaciones`: bandeja paginada por operación. Separa movimientos
  pendientes, órdenes creadas no devueltas al asesor, órdenes en cola que necesitan
  ratificación y reportes de pago pendientes. Sin corte temporal que oculte atrasos.
- Filtros y contadores por tipo; no suma importes de monedas o dominios diferentes.
  En órdenes se identifica el total como total de orden, no como importe del ajuste.
- Egresos simples: detalle de cuenta, importe nativo, tasa, equivalente, comisión,
  fecha, autor, concepto, beneficiario, referencia, motivo de revisión y notas.
  Aprobar/rechazar desde Admin, motivo obligatorio solo para rechazo.
- Gasto y comisión se deciden juntos. Solo un gasto y como máximo una comisión,
  misma cuenta/moneda/fecha/autor/tasa, todos pendientes, sin orden ni reporte de
  pago vinculados, y cuenta activa. Otros tipos se revisan en el centro vigente;
  no se convierten en gastos por aparecer en la bandeja.
- Revisión con huella del contenido: cambios en filas, pertenencia al grupo o
  estado de la cuenta invalidan la decisión anterior. Un reintento devuelve
  revisión desactualizada; no modifica otra vez las filas ya resueltas.
- Resultado incierto bloquea otro envío hasta actualizar el estado. El comprobante
  contiene IDs y fecha; el historial muestra el actor de revisión y el rechazo.
- Órdenes/pagos abren el detalle operativo existente y la pestaña correspondiente,
  con regreso fijo a Autorizaciones para Admin. No duplican comandos de aprobación,
  modificación, ratificación o confirmación de pagos.
- Accesos desde navegación, Pendientes, Cuentas y Herramientas. Los avisos nuevos
  de egreso pendiente apuntan a esta bandeja.

## Seguridad y concurrencia

Lecturas SECURITY INVOKER, RLS de sesión y comprobación Admin explícita. La acción
servidora comprueba Admin antes de acceder a la base. La decisión privada usa
SECURITY DEFINER porque no existe política UPDATE autenticada para movimientos;
no se agrega una política general ni se usa service-role desde la aplicación.
Funciones con search_path vacío, permisos anónimos revocados y actor auth.uid().

Los escritores vigentes no comparten un protocolo de bloqueo por grupo. Por eso
la decisión toma brevemente SHARE ROW EXCLUSIVE sobre movimientos y bloqueos
compartidos de cuentas: evita inserciones tardías en un grupo durante la decisión.
La espera máxima de bloqueo es 3 s, la sentencia 10 s; no hay red ni interacción
humana dentro de la transacción. Es una limitación de concurrencia conocida:
conviene sustituirla por una entidad de operación y protocolo común si aumenta
el volumen de decisiones. Un timeout no se presenta como aprobación.

Se conservan el motivo original de autorización y los importes. No se ejecutan
pagos bancarios ni se cambian umbrales de aprobación.

## Evidencia

- 157 pruebas: 118 Admin, 33 operaciones (11 nuevas) y 6 seguridad.
- Compilación de producción y ESLint de archivos nuevos aprobados.
- Prueba SQL con cuentas/movimientos ficticios, transacción y ROLLBACK: aprobación
  con comisión, rechazo y motivo, respuesta repetida/opuesta, datos modificados,
  cuenta inactiva, tipos ajenos, moneda VES, fallo tardío y acceso no-Admin/anónimo.
- Verificación de limpieza: sin cuentas, movimientos o función de prueba restantes.
- Migración aditiva aplicada. Lectura posterior autenticada funciona; ninguna
  aprobación ni modificación de órdenes reales ejecutada por el agente.
- Asesores de seguridad: sin hallazgos nuevos frente al corte inmediatamente
  anterior. Persisten avisos previos de permisos, rutas de funciones y Auth; esto
  no certifica seguridad integral. Referencias de seguimiento:
  [rutas de funciones](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable),
  [visibilidad GraphQL](https://supabase.com/docs/guides/database/database-linter?lint=0026_pg_graphql_anon_table_exposed),
  [contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Pendiente, no certificado en este corte

- Comparación histórica antes/después de cambios comerciales y autorización de
  la versión exacta de la orden: se conservan los comandos existentes, que aún
  requieren endurecimiento. Las órdenes no usan la nueva huella de egresos.
- Cierres/conciliación nativos, inventarios y otros dominios de aprobación siguen
  en sus bandejas. No se afirma que este listado represente todas las tareas.
- El aprobador antiguo de movimientos conserva su implementación anterior; este
  corte no certifica sus controles ni retira el panel de respaldo.
- Aprobación interactiva real deliberadamente no ejecutada. La prueba de escritura
  es SQL reversible más acciones con dependencias simuladas, no una operación real.
- Revisión visual de la nueva ruta tras despliegue por completar en este corte.
