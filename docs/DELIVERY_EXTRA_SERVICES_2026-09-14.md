# Delivery: servicios adicionales

## Alcance implementado

- Administración registra fecha real, responsable activo (motorizado interno o empresa externa), concepto e importe USD positivo de hasta dos decimales.
- El servicio no crea órdenes, clientes, cierres, productos, inventario ni cobros de clientes. Es una obligación de remuneración que se paga junto con los deliveries.
- Se consulta por fecha del servicio (Caracas), no fecha de carga. Es posible registrar hoy una diligencia pasada. No se permiten fechas futuras.
- El catálogo permite elegir responsables sin entregas en el período. El directorio interno reutiliza `get_driver_profiles` porque `user_roles` restringe lecturas de roles ajenos.
- «Pagar período» suma todas las entregas y servicios adicionales pendientes del responsable en las fechas consultadas. La búsqueda de orden/cliente solo afecta la tabla de entregas.
- La selección parcial permite elegir entregas y adicionales explícitamente. También se admiten liquidaciones compuestas únicamente por servicios adicionales.
- La confirmación y el comprobante separan subtotal de entregas y subtotal de adicionales. Un único egreso se vincula al total; un egreso anterior debe coincidir exactamente y no se duplica.
- Se puede anular un adicional pendiente indicando motivo. Para corregirlo, anular y registrar el dato correcto. Si está pagado, primero anular la liquidación completa.
- Al anular una liquidación se liberan las entregas y los adicionales. Se anula el egreso creado por ella; si se vinculó un egreso anterior, ese egreso se conserva. El comprobante mantiene la evidencia histórica.

## Integridad

- `delivery_extra_services`: RLS y lectura exclusiva de administración; sin escrituras directas de clientes.
- Registro idempotente mediante UUID de solicitud, identidad del administrador y payload exacto. Reintentos conservan la identidad.
- Pago usa el comando existente `pay_delivery_services_v1`, ampliado de manera compatible con clientes que no envían `extras`.
- Bloqueos ordenados: órdenes, servicios adicionales, registro de pago, movimiento. El servicio reclama un único `payment_id`; huella de consulta verificada dentro de la transacción.
- Ningún cambio en asignación operativa de delivery ni en precios de órdenes.
- Los importes adicionales no son automáticamente pagos ni movimientos bancarios hasta confirmar su liquidación.

## Verificación

- Pruebas TypeScript en `tests/admin/delivery-services.test.mts` (selección, totales, datos inválidos, CSV seguro).
- Pruebas SQL sintéticas en `tests/admin/delivery-extras.rollback.sql`, siempre dentro de transacción revertida: extras solos, mixtos, externos e internos, reintentos, doble pago, responsable incorrecto, período, huella, anulación, egreso existente, fallo de último paso y permisos.
- Reejecutar la suite anterior `tests/admin/delivery-services.rollback.sql` para compatibilidad USD/VES, costos y anulaciones existentes.
- No usar operaciones reales para verificar pagos.

## Deducibles: implementados en el bloque del 2026-09-15

- Separar deuda total del importe elegido por administración para descontar en esa semana; admitir cero.
- Si la deuda supera lo ganado, conservar el remanente sin generar pagos negativos.
- Ejemplo sintético: ganado 100, deuda 60, descuento elegido 20, pago 80, deuda restante 40.
- Las compras vinculadas a pedidos deben reducir también su deuda canónica mediante compensación, sin crear otro ingreso de efectivo ni duplicar la deuda como un préstamo manual.
- Libro de abonos, compensaciones, reversión y pruebas: `docs/DELIVERY_DEBTS_WEEKLY_2026-09-15.md`.
