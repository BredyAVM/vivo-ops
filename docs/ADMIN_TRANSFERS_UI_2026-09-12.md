# Transferencias operativas desde Administración

## Alcance implementado

- Ruta `/app/admin/finanzas/cuentas/transferencia`, accesible desde Cuentas,
  detalle de cada cuenta activa y Herramientas.
- Cuenta de origen preseleccionada cuando procede; cuenta destino diferente;
  importe enviado y recibido en sus monedas, tasas por cuenta VES, comisión
  adicional en moneda de origen, fecha, concepto, referencia y notas opcionales.
- Resumen de salida total y entrada, comprobante por identificador y enlaces a
  ambas cuentas para consultar los movimientos del día.
- Es un registro dentro de VIVO, no una integración bancaria para enviar dinero.

## Integración y protección

Se extrajo el adaptador del comando `create_money_transfer_v1` a
`src/lib/finance/money-transfer-command.ts`. Lo comparten Master y Admin;
no hay segunda contabilidad ni nuevas reglas de valoración. El servidor exige
rol Admin y utiliza el cliente de sesión. La función de base de datos existente
vuelve a comprobar autorización y cuentas activas.

El comprobante se valida: identidad del envío, identificadores positivos y
distintos para origen/destino/comisión, presencia de comisión consistente y estado
de reintento explícito. Un fallo de refresco de vistas no oculta un comprobante
confirmado en la acción Admin.

El formulario bloquea envíos simultáneos. Una respuesta incierta congela los datos
y permite reenviar exactamente el mismo contenido con la misma identidad. Un
rechazo explícito permite corregir, conservando la identidad del envío; si ya
existía una transferencia confirmada, el servidor rechaza el cambio de contenido.
Solo tras obtener comprobante se ofrece Nueva transferencia.

La identidad se conserva mientras la pantalla permanezca abierta: no se añadió
persistencia de reintentos tras cerrar/recargar el navegador. Ante resultado
incierto se indica no cerrar ni recargar. El historial existente permite revisar
operaciones, pero no se agregó un recuperador de solicitudes entre sesiones.

No se añadió bloqueo por saldo insuficiente ni se impuso igualdad entre valores
USD de origen/destino: no se modifican las reglas del comando existente. Las
diferencias de valoración siguen sujetas a la calidad de lectura financiera.
Las fechas futuras conservan la regla existente; la consulta de cuentas mantiene
su corte actual, por lo que un movimiento futuro no aparece antes de esa fecha.

## Verificación

- 146 pruebas aprobadas: 118 Admin, 22 operaciones y 6 seguridad.
- Pruebas nuevas de comprobantes, errores de red, roles, conservación de payload,
  rechazo de base de datos y error de refresco posterior a confirmación.
- Compilación de producción y tipos de aplicación aprobados; ESLint de archivos
  nuevos y formulario sin errores.
- Prueba SQL transaccional existente repetida con ROLLBACK: salida/entrada/comisión,
  fallo tardío, reintento, cambio de contenido, importes/tasas inválidos, rechazo
  anónimo/no-Admin, anulación parcial rechazada y anulación completa con reintento.
- Consulta posterior: cero cuentas y operaciones de prueba, función de prueba
  eliminada por rollback. No se modificaron movimientos reales ni el esquema
  persistente.
- Pendiente verificación visual/interactiva con sesión Admin. La sesión de
  navegador disponible en el corte anterior era de Asesor; no se amplían permisos.

## No incluido

Bandeja de autorizaciones, cierres/conciliación nativos, rediseño global y el resto
de módulos conservan su hoja de ruta. La anulación completa de transferencias ya
existe en el centro previo; este corte incorpora creación y comprobante, no un
nuevo botón de anulación en Administración.
