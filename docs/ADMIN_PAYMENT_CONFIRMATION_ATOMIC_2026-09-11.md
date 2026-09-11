# Confirmación de pagos Master/Ops — 11 de septiembre de 2026

## Alcance implementado

`confirmPaymentReportAction` y su entrada Ops llaman un único comando con la
sesión normal. El comando confirma el reporte, registra el cobro, entrega cambio,
guarda el remanente en el fondo del cliente o aplica el redondeo, y escribe el
historial visible y un comprobante protegido, todo en una transacción.

- Identidad del reintento: reporte de pago. Mismo actor y datos devuelven el mismo
  comprobante; datos distintos o pago anulado producen error sin otro cobro.
- Orden y cliente se obtienen del reporte, no de identificadores confiados al formulario.
- Permisos persistidos: Admin/Master; Counter solo su propio reporte sin cambiar
  cuenta/moneda/importe y con las reglas vigentes para las cuentas utilizadas.
- Bloqueos: reporte lógico, orden, cuentas ordenadas, reporte y saldo del cliente.
- Saldo a favor incremental: no absorbe excedentes históricos ni usa el importe
  reportado como límite cuando el importe confirmado es diferente.
- Para estos comprobantes nuevos, la cobertura de bolívares usa el movimiento
  realmente confirmado. Un reporte de USD 12 confirmado por USD 1 no puede cerrar
  falsamente una orden de USD 10. Se conserva el reporte original; no se revalúa
  automáticamente el historial anterior. Se reutiliza el lector canónico protegido.
- Cambio nunca superior al excedente disponible. Ops conserva su decisión explícita
  y cambio completo; Dashboard conserva cambio parcial con remanente al fondo.
- Redondeo de excedente: Admin, hasta USD 1, con evidencia anterior/nueva.
- Fecha elegida en Ops se guarda dentro de la transacción. Dashboard conserva
  por defecto la fecha original del reporte. No se agregan pasos al formulario.
- Notificaciones posteriores no convierten una operación ya guardada en fallo.

El procedimiento privilegiado está en `app_private` para escribir el comprobante
sin permitir su fabricación desde la API. La entrada pública es invocadora,
con permisos explícitos y sin acceso anónimo. No se amplían permisos de tablas.

## Pruebas

Migración aplicada: `20260911143717_master_payment_atomic_v1.sql`.
Compilación de producción y tipos de aplicación aprobados; 180 pruebas Node
(95 Admin, 79 comisiones, 6 seguridad). Pruebas transaccionales repetidas después
de aplicar la migración. Asesor de seguridad: tabla descubrible en GraphQL para
autenticados por su permiso SELECT; las filas siguen restringidas por RLS a
Admin/Master y al Counter propietario. No se considera acceso público a datos.

`tests/admin/payment-confirmation.rollback.sql` utiliza exclusivamente órdenes,
cliente y cuentas sintéticos dentro de una transacción revertida. Comprueba fallo
tardío (incluida fecha y fondo), reenvío, datos distintos, cambio parcial/excesivo,
importe confirmado distinto al reportado, redondeo/límite, USD/VES, asociación,
validación numérica, reglas Ops y permisos. No aplica cobros reales.

`tests/admin/payment-confirmation-command.test.mts` comprueba el contrato del
formulario, compatibilidad de cambio simple, recibos y que las acciones no
continúen escribiendo dinero en pasos separados.

## Límites que no deben presentarse como terminados

- No se convierte un reporte antiguo ya confirmado en un comprobante nuevo.
- La creación del reporte de nómina y su compensación posterior, uso independiente
  del fondo, y comandos de Mostrador no se migran con esta entrega.
- La función primitiva anterior sigue disponible para compatibilidad. Esto protege
  las entradas migradas; no certifica todas las rutas de escritura de la aplicación.
- Retenciones conservan su tipo de salida `withdrawal`; no se redefine su tratamiento
  contable ni se concilia historia automáticamente.
- Anulaciones, transferencias y cierres se abordan en los siguientes bloques.
- Las pruebas de reenvío se ejecutan secuencialmente; no constituyen una prueba de
  carga concurrente. Los bloqueos no coordinan escritores antiguos que no los usan.
