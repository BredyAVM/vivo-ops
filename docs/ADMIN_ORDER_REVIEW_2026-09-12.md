# Revisión nativa de órdenes en Administración

## Alcance del corte

- Autorizaciones abre órdenes nuevas y ratificaciones en
  `/app/admin/autorizaciones/ordenes/[orderId]`.
- Pedido vigente, fecha/hora, dirección, notas, asesor y estado financiero canónico.
  Se distinguen abono confirmado, fondo aplicado, pendiente y reportes sin confirmar.
  Aprobar la orden no confirma pagos ni genera un cobro.
- Cambios históricos muestran antes/después únicamente cuando el evento original
  lo conserva. No se inventan importes anteriores. Modificar/devolver sigue en el
  centro operativo existente con regreso a Autorizaciones.
- Una revisión corresponde a la huella de cabecera y líneas. Cambios posteriores o
  una decisión previa obligan a actualizar antes de aprobar. No se agrega una
  confirmación adicional ni motivo obligatorio: nota opcional.
- Reutiliza `approve_order` y `reapprove_queued_order`: conserva validaciones de
  inventario protegido y auditoría canónica. El evento visible y sus destinatarios
  se guardan en la misma transacción. Notificación a dispositivos es posterior y
  de mejor esfuerzo; su fallo no convierte una aprobación guardada en un error.

## Seguridad y límites

- Sesión Admin comprobada en lectura, acción y base de datos. Función pública
  invocadora; comando privado privilegiado, ruta de búsqueda vacía y sin ejecución
  anónima. No hay escritura financiera nueva con credenciales de servicio.
- Bloqueo `order-edit:<id>` compartido con edición atómica, cabecera FOR UPDATE y
  líneas bloqueadas antes de volver a comparar. La cabecera bloquea nuevas líneas
  referenciadas por FK durante la decisión. Estado y eventos se guardan juntos.
- La huella cubre cabecera y líneas, no congela pagos concurrentes. Los indicadores
  financieros son una consulta informativa, no una autorización de esos pagos.
- Resultado incierto/desactualizado retira el botón hasta actualizar la revisión.
  Repetir la huella anterior no vuelve a aprobar ni a enviar avisos.
- Los botones antiguos de aprobación siguen con su implementación previa: este
  corte no certifica su concurrencia ni retira el respaldo operativo.
- Pendiente: capturar antes/después completo en todos los escritores de cambios
  comerciales, mostrar impacto en comisiones y migrar correcciones/rectificaciones.

## Verificación

- 170 pruebas aprobadas: 119 Admin, 45 operaciones y 6 seguridad; 12 nuevas ejecutan
  modelo y acción real con dependencias simuladas, incluidos permisos y resultados
  inciertos, ratificación y fallos posteriores de notificación/caché.
- Compilación de producción y ESLint aprobados.
- SQL con órdenes ficticias dentro de BEGIN/ROLLBACK: aprobación, ratificación,
  huella antigua, cambios reales de cabecera/línea, repetición, devolución al asesor,
  rechazo canónico de pack sin selecciones y fallo tardío de evento. Se verifica
  rollback de estado, preparación de inventario y auditoría. Roles no-Admin y
  anónimos rechazados por la base.
- Limpieza comprobada: cero órdenes/líneas de prueba y ninguna función de prueba.
- Migración aditiva aplicada, sin aprobar ni modificar pedidos reales.

## Seguimiento del despliegue anterior

El ajuste de menú `b9f4d28` está READY y visualmente no desborda. Su primer escaneo
encontró dos advertencias Node DEP0169 en `/app/master/ops` con HTTP 200; no se
atribuyen a una operación fallida ni se certifican como resueltas en este corte.
