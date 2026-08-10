# Contrato canónico del módulo Asesor

Fecha de corte: 2026-08-10

## Propósito

Este documento fija los límites operativos del módulo Asesor para que futuras integraciones, especialmente inventario, no rompan pedidos, pagos, navegación, eventos ni permisos.

## Autoridad y permisos

- El asesor solo consulta información propia o atribuida a su usuario.
- Las comisiones son de solo lectura. El asesor no modifica períodos, porcentajes, cierres, obsequios ni deducciones.
- Los borradores propios pueden archivarse. Archivar los retira de la bandeja sin borrar su trazabilidad física.
- Los pagos se reportan desde las acciones canónicas existentes; la interfaz no confirma ni rechaza pagos.
- Las órdenes y sus eventos mantienen las reglas canónicas del dominio y las políticas RLS vigentes.

## Cobranza

- Una deuda operativa para cobranza es una orden `delivered` con saldo reportable mayor que cero.
- El saldo debe salir de `get_orders_financial_state`; no debe recalcularse con una fórmula paralela si la RPC está disponible.
- La vista por cliente agrupa órdenes entregadas y totaliza saldos en USD y bolívares.
- La vista por orden conserva número operativo, fecha, monto y acceso al reporte de pago.
- Los reportes por validar, confirmados y rechazados permanecen separados del saldo cobrable.

## Comisiones

- La fuente es `advisor_commission_periods`, `advisor_commission_closures` y `advisor_commission_deductions`.
- La aplicación muestra el snapshot cerrado por administración y no intenta reconstruir el período en el cliente.
- Las órdenes del snapshot pueden abrirse, conservando el período seleccionado como ruta de regreso.
- Productos y obsequios pueden agruparse visualmente, pero el detalle original del snapshot debe conservarse.
- Una futura acción de "conforme / no conforme" requiere una tabla, estados y permisos propios; no debe guardarse como nota informal.

## Borradores y presupuestos

- `draft` y `quoted` son trabajos activos del asesor.
- Eliminar desde la interfaz significa pasar a `archived` y registrar `archived_at`.
- No se ejecuta borrado físico desde el teléfono.
- Un borrador archivado no aparece en la bandeja activa y no puede convertirse accidentalmente en pedido.

## Navegación

- Las rutas internas pueden recibir `returnTo`, pero solo se acepta un destino que empiece por `/app/advisor`.
- Abrir una orden debe conservar día, filtro, búsqueda, cliente o período de origen.
- Editar o repetir desde el detalle vuelve primero al detalle y luego a la pantalla de origen.
- Solo debe existir una acción visible de volver en el encabezado; las tarjetas no deben duplicarla.

## Contrato para inventario futuro

- Inventario no se integra en esta entrega.
- La fecha y modalidad de entrega deben definirse antes de consultar disponibilidad de productos.
- La integración futura debe consumir el contrato canónico del inventario, no calcular existencias dentro del compositor del asesor.
- Una alerta de poca existencia o falta estimada debe advertir al asesor, pero puede permitir enviar a revisión del máster.
- El máster conserva la decisión operativa final cuando exista una diferencia entre disponibilidad calculada y realidad física.

## Pendientes posteriores

- Diseñar la conformidad del cierre de comisiones con comentario, estado y auditoría.
- Incorporar señales de disponibilidad cuando finalice el contrato canónico de inventario.
- Ejecutar QA móvil de recorridos completos con datos reales: pedido, edición, presupuesto, pago, cobranza, alertas y comisiones.
