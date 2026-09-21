# Eventos: un pago distribuido entre órdenes

## Entrega y uso

En **Eventos y ampliaciones → abrir evento → Pagos del evento**:

1. El asesor asignado, Máster o Administración pulsa **Reportar un pago**.
2. Indica cuenta, método, monto recibido, fecha y datos del comprobante. Si recibió
   bolívares, indica también la tasa del pago; el recibo sigue denominado en Bs.
3. **Ver distribución** muestra los importes por orden, en la misma moneda del
   recibo. Se cubren primero las órdenes más antiguas, sin trasladar excedentes
   históricos ni modificar precios.
4. **Enviar pago a revisión** guarda un solo reporte del evento. Todavía no
   registra ingreso ni da por pagadas las órdenes.
5. Máster recibe **Confirmar pago del evento** en su bandeja de acciones, abre la
   ficha, verifica el comprobante y confirma el pago completo o lo rechaza con motivo.
6. Solo Administración puede **Anular pago completo**. No se permite anular una
   parte desde la pantalla de una orden o desde Cuentas.

Se admiten abonos parciales. Cada orden conserva sus importes, moneda de nacimiento,
comisión, preparación y entrega. La suma de los ingresos distribuidos es exactamente
el monto original recibido; no se crea además un ingreso por el total del evento.

## Auditoría y reutilización

Se revisaron en Supabase las definiciones vigentes de `confirm_payment_report`,
`confirm_payment_report_atomic_v1`, `get_order_financial_state`, los controles de
precisión, `find_active_payment_duplicate`, `reject_payment_report` y
`void_financial_movement_v1`; también tablas, permisos, reglas de cuentas y triggers.

Se reutilizan:

- `payment_reports`: una asignación por orden, creada solo al confirmar.
- `money_movements`: ingreso real de cada asignación.
- `payment_confirmation_operations`: identidad, reintentos y efectos de cada confirmación.
- `order_payment_precision_allocations`: cobertura y redondeo canónicos existentes.
- `financial_void_operations`: reversión existente por asignación, dentro de una sola transacción.
- `money_account_payment_rules`: cuentas y métodos habilitados para cada rol.
- `order_timeline_events` y destinatarios: acción para Máster, seguimiento para asesor.

No existía identidad de recibo compartida entre órdenes. Por eso se incorpora
**una tabla** `event_payment_operations` (7 columnas) y **una columna de vínculo**
`payment_reports.event_payment_id`. No se duplican saldos, cuentas, comisiones ni
se reutiliza `movement_group_id` para un significado distinto al financiero actual.

La tabla nueva no admite lectura ni escritura directa de usuarios/API. RLS y
privilegios cerrados; RPC con control de rol y pertenencia al evento. La observación
informativa `rls_enabled_no_policy` es intencional: acceso exclusivamente por RPC.
No se añadieron advertencias de seguridad de nivel WARN/ERROR.

## Reglas de consistencia

- Un reporte pendiente por evento, con UUID estable y contenido inmutable.
- Preview calculada en servidor. Se verifica otra vez al reportar y confirmar.
- Si cambian saldos, órdenes o aparecen pagos pendientes por orden, no se redistribuye
  silenciosamente: se rechaza el reporte desactualizado y se registra uno nuevo.
- Una referencia compartida por dos asignaciones iguales no se considera duplicado.
  La detección de duplicados compara también el recibo completo del evento contra
  los pagos normales. No se inventan referencias distintas para cada asignación.
- Bloqueo de órdenes en orden ascendente antes de cuentas y reportes. Confirmación
  y anulación completas: cualquier error revierte todos sus efectos.
- La base impide editar, eliminar, desvincular o anular individualmente la evidencia.
  Los estados internos de operación incompleta no pueden confirmarse al finalizar
  una transacción; no se autorizan por notas ni variables manipulables de sesión.
- Los pagos anteriores por orden siguen computándose sin migraciones históricas.
- Cerrar nuevas ampliaciones no impide cobrar el evento.
- Administración conserva la exclusividad sobre precios y comisiones. Registrar
  o confirmar el pago no concede permiso para cambiar condiciones comerciales.

## Alcance deliberado

Esta pantalla distribuye dinero que cubre saldos pendientes. **Cambio, excedentes,
retenciones y uso de fondos del cliente** continúan en sus flujos existentes por
orden; no se improvisan equivalencias ni se acreditan fondos automáticamente aquí.
Los reportes agrupados pendientes se ven en la ficha y acción del evento, no como
varios reportes pendientes independientes dentro de cada orden.

## Verificación

- 22 pruebas SQL aisladas: roles, pertenencia, reglas de cuenta, USD/Bs, abonos,
  saldo cambiado, falsificación de distribución, duplicados, reintento, fallo de
  la última asignación, anulación completa, protección de evidencia y privilegios.
- 16 pruebas SQL anteriores de ampliaciones y prueba de resumen: sin regresiones.
- Dos pruebas reales **revertidas con ROLLBACK** en Supabase: circuito asesor →
  Máster → Administración, confirmación en USD, confirmación en Bs con cobertura
  histórica/actual, idempotencia, anulación parcial rechazada y reversión completa.
- Orden 2667, sus ítems e inventario sin cambios persistentes; cero pagos de prueba
  guardados. No se regularizaron sus ampliaciones históricas.
- Compilación de producción y ESLint de las pantallas/acciones nuevos correctos.
- `tsc --noEmit` conserva errores anteriores en pruebas de administración/comisiones;
  no se modificaron esos archivos para ocultarlos.
- La revisión visual con una sesión autenticada sigue pendiente. Compilar y subir
  a main no equivale a verificar el despliegue.

## Ruta que sigue abierta

1. Viajes compartidos/entregas parciales: vincular órdenes sin duplicar delivery
   al cliente ni remuneración del motorizado.
2. Productos configurables: integrar selección canónica de composición, sin
   inventar piezas ni habilitar Gambits indiscriminadamente.
3. Conversión atómica del presupuesto inicial, preservando perfil y creación del cliente.
La regularización histórica de 2667 se completó después de confirmar cantidades
y condiciones: ampliación histórica 2782, 200 UND por US$111,20; evento consolidado
450 UND por US$263,30, pendiente de pago. No se repitió cocina ni consumo actual.
Detalle: [auditoría de regularización](EVENT_2667_HISTORICAL_EXTENSION_2026-09-21.md).

Migraciones: `20260921145826_event_consolidated_payments_v1.sql`,
`20260921151230_event_payment_account_rules_v1.sql` y
`20260921151833_event_payment_pending_visibility_v1.sql`, aplicadas en Supabase.
