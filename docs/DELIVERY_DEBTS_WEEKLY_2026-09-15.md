# Delivery: deudas y deducibles semanales

## Operación

- «Deudas y deducibles» permite registrar préstamos ya entregados, otros cargos acordados y compras vinculadas a un pedido existente. Registrar una deuda no mueve dinero; la salida real de un préstamo se registra en Cuentas, sin repetirla si ya existe.
- Las compras se consultan por número corto. Administración confirma el cliente y responsable. No se crea una segunda cuenta por cobrar: el saldo se lee del estado financiero canónico de ese pedido y disminuye también cuando se confirma un pago normal.
- La consulta incluye deudas cuya fecha sea anterior o igual al final del período, incluidas semanas anteriores. Muestra su **saldo pendiente actual**, no una reconstrucción histórica de lo que se debía al cierre de esa semana.
- En «Pagar período» o «Pagar selección» se elige un importe por deuda. Cero es válido; no hay descuento automático del saldo completo. Deuda y fecha de descuento no pueden ser posteriores al período o a la fecha de pago.
- Ganado = costo de entregas + servicios adicionales. Neto = ganado − descuentos elegidos. Si la selección supera lo ganado o la deuda, se rechaza sin modificarla silenciosamente.
- Ejemplo: ganado 100, deuda 60, descuento 20: egreso neto 80 y saldo de deuda 40. Si ganado 25 y descuento 25, se liquida sin egreso y quedan 35 de deuda.
- El egreso nuevo o existente debe corresponder al **neto**, en USD o VES con la tasa del pago. Nunca se crea una entrada de caja para aparentar un abono del motorizado.
- Comprobante: entregas, adicionales, bruto, deducciones por deuda, saldos al liquidar y neto. Historial de abonos con enlace al comprobante; anulaciones conservadas.

## Compras y precisión

Cada compensación de compra crea un crédito de remuneración y una aplicación de fondo por igual importe, vinculados a la liquidación y al pedido. El neto del fondo del cliente es cero y no cambia `clients.fund_balance_usd`. La aplicación `order_fund_applied` reduce el saldo canónico; no hay un `order_payment` ficticio ni cambio en inventario.

Se conserva la base precisa cuando corresponde al contrato `precise_collection_v1`. El residuo estrictamente menor de un centavo se documenta en `delivery_debt_allocations.rounding_usd`, separado del importe descontado. Un centavo exacto sigue pendiente. La lectura de precisión incluye solamente asignaciones no revertidas y respeta los permisos de la orden.

## Reversión e integridad

- Nuevas tablas: `delivery_debts` (origen de deuda) y `delivery_debt_allocations` (abonos por liquidación). Lectura administrativa, RLS y sin escrituras directas del cliente. La cobertura de una compra es legible por los roles autorizados para esa orden.
- Registro idempotente por UUID, usuario y payload; el mismo envío no crea una segunda deuda/liquidación. La interfaz conserva la identidad durante reintentos sin modificar los datos.
- Pago: órdenes de entrega y compra en orden estable, adicionales y deudas bloqueados antes de validar saldo/huella. Se conserva el rechazo de servicios pagados o tarifas cambiadas.
- Anular una liquidación revierte sus abonos y compensaciones, libera servicios y anula solo el egreso creado por ella. Un egreso preexistente vinculado se conserva.
- No se puede anular una deuda con abonos activos: primero se anulan sus liquidaciones. No se puede editar/eliminar su evidencia de fondo ni cancelar/cambiar importes o cliente de una compra compensada sin deshacer su liquidación.
- La anulación conserva pagos ordinarios que la compra haya recibido por otra vía; solo reabre el importe compensado.
- No se importan ni se crean automáticamente deudas históricas reales. Administración registra y confirma las existentes.
- Los costos de servicios siguen siendo **brutos**; el egreso es **neto**. Un futuro reporte de rentabilidad no debe sustituir el costo de servicios por el egreso neto ni tratar la recuperación de préstamo como venta.

## Verificación

- `npm run test:delivery-debts`: importes, elección cero, límites, centavos, parseo y saldo preciso.
- `tests/admin/delivery-debts.rollback.sql`: datos sintéticos dentro de transacción revertida; creación/reintento, arrastre, parcial, cero, exceso, saldos obsoletos, compras precisas, pago ordinario, egreso existente, reversión, escritura indebida, fallo final y permisos.
- Regresiones SQL: `delivery-services.rollback.sql`, `delivery-extras.rollback.sql`, `order-collection-precision.rollback.sql`.
- Regresiones de aplicación: `test:admin`, `test:security`, `test:delivery`, `test:collection-precision`; compilación de producción y revisión visual sin guardar operaciones reales.

## Límites explícitos

- Hasta 100 deudas por liquidación y 500 entregas/adicionales, como control de tamaño de transacción.
- No hay cobro de préstamos en efectivo desde este panel ni cronograma obligatorio de cuotas; se elige el descuento cada semana. Las compras sí reflejan los pagos normales del pedido.
- Los reintentos de formularios conservan identidad en memoria. Recuperación persistente tras recargar el navegador sigue siendo un endurecimiento transversal pendiente.
- Las pruebas verifican bloqueos, rechazos de estado obsoleto y solapamiento lógico; no se registraron fixtures persistentes para una carrera real entre dos sesiones en producción.
