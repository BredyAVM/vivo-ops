# Eventos con ampliaciones — primera entrega operativa

## Alcance verificado

Se implementa una ficha compacta `/app/events/[id]`, accesible desde Eventos y ampliaciones.
Administración conserva `/app/events` para presupuestar. Asesor y Máster tienen acceso
al seguimiento sin obtener permiso para editar el presupuesto original.

No se crean tablas ni columnas. Se reutilizan:

- `advisor_order_drafts`: raíz administrativa, tarifas y solicitudes de ampliación.
- `payload.event_terms`: tarifas por producto/unidad, moneda y comisión autorizadas por Administración.
- `payload.event_extension`: relación con la raíz, solicitud identificable, condiciones congeladas y revisión.
- `converted_order_id`: única orden de cada ampliación aprobada.
- `orders`, `order_items`, `order_item_components`: ejecución, preparación y consumo normales.
- `order_admin_adjustments`: condiciones comerciales canónicas de cada nueva orden.
- `order_timeline_events` y destinatarios: avisos y resolución de acciones.

## Uso

1. Administración crea el presupuesto inicial y lo convierte como actualmente.
2. En Eventos y ampliaciones abre su ficha y configura las tarifas de adicionales.
   Estas se pueden definir antes de convertir el presupuesto. No se infieren dividiendo
   el precio inicial: puede contener stand, descuentos y otros servicios.
3. El asesor asignado solicita cantidades, fecha, hora, entrega e indicaciones.
   Los productos del presupuesto inicial aparecen primero; también puede pedir
   otros productos fijos del catálogo. Los no tarifados pasan a Administración.
4. Administración autoriza precio y comisión de las excepciones; el máster nunca
   recibe campos editables de precio ni un permiso indirecto de autorizarlos.
5. Máster aprueba operativamente. La creación es transaccional e idempotente y
   usa `approve_order` para dejar la orden en cola. Se abre desde la ficha y sigue
   el flujo normal de cocina y entrega; no se reabre la orden entregada original.
6. El evento muestra órdenes, ampliaciones, pagado y saldo. Solicitudes pendientes,
   rechazadas y órdenes canceladas no incrementan el total de venta consolidado.
7. Cerrar nuevas ampliaciones no equivale a entregar órdenes ni cerrar la cobranza.

## Unidades e inventario

La tarifa explicita UND, servicio o envase. Para productos directos que se cotizan
por servicio, se congela la conversión a UND usando `units_per_service` al solicitar
o autorizar; una solicitud de 2 servicios de mini equivale a 50 UND. Por UND, 100
mini siguen siendo 100 UND. La preparación conserva cocina/en sitio/sin preparación.

La nueva orden conserva componentes propios. La orden inicial no se modifica ni
se vuelve a descontar. Se mantienen las reglas existentes de consumo al despacho
y de inventario no bloqueante, salvo protecciones manuales vigentes.

## Seguridad y trazabilidad

- Permisos en servidor y RPC; un asesor no puede consultar eventos ajenos.
- No se amplía la RLS general de borradores para Máster.
- Reintentos de solicitud se identifican por UUID y mismo contenido; aprobación
  repetida devuelve la misma orden, incluso si la respuesta anterior se perdió.
- El trigger final de precio de una ampliación solo acepta líneas del presupuesto
  autorizado, vinculadas a la orden exacta en creación. No concede override a Máster.
- El editor genérico no puede reconstruir las líneas de una ampliación aprobada:
  se cancela por el circuito existente y se solicita una nueva. Cocina, entregas y
  pagos no requieren editar esos ítems.
- Se conservan `event_budget` y `event_extension` al reemplazar otros extra_fields.
- Cambiar tarifas no recalcula solicitudes anteriores ni comisiones históricas.
- Aprobar, rechazar o pasar a revisión del máster resuelve el aviso de acción previo.

## Límites explícitos y siguientes entregas

Esta entrega NO completa toda la arquitectura discutida:

1. **Pago único distribuido entre órdenes: entrega posterior implementada.** Ver
   [Pago consolidado del evento](EVENT_PAYMENTS_IMPLEMENTATION_2026-09-21.md).
   Reporte único, confirmación y anulación completas, referencias compartidas y
   asignación real al circuito financiero. Cambio, excedentes y retenciones siguen
   por orden; no se netean automáticamente excedentes históricos entre órdenes.
2. **Viajes compartidos y entregas parciales:** cada ampliación admite un delivery
   por viaje. No existe aún consolidación de varias ampliaciones en un mismo viaje;
   no cargar otro delivery si no corresponde un nuevo viaje. Retiro/transporte propio
   no simula la asignación de un motorizado.
3. **Catálogo configurable:** se admiten productos de composición fija, no Gambits
   ni productos con selección editable. Incorporar el selector canónico para esos
   casos en la siguiente entrega, sin inventar su composición.
4. **Conversión del presupuesto inicial:** sigue el flujo preexistente. La creación
   de ampliaciones es atómica; falta migrar la conversión inicial multiescritura a
   una operación atómica, preservando la creación y el perfil comercial del cliente.
5. **Orden 2667:** no regularizada. Falta conocer cantidad adicional real y precio
   acordado. No usar este flujo operativo para simular preparación de algo ya entregado;
   la regularización histórica requiere revisar los conteos posteriores para no duplicar consumo.

## Verificación

- 16 pruebas aisladas de Postgres: permisos, precios, idempotencia, UND/servicios,
  VES, identidad persistente, rechazo, cierre, avisos y aislamiento entre asesores.
- 10 pruebas de eventos/resumen/comisiones existentes y nuevas.
- Prueba transaccional real en Supabase con rollback: Administración autoriza,
  asesor solicita, Máster aprueba, precio correcto, orden en cola, reintento único,
  orden 2667/ítems/movimientos originales sin cambios.
- Segunda prueba real revertida: 2 servicios se resuelven en 50 UND de crudo,
  precio de origen VES 2000 preservado, sin consumo físico prematuro y aviso resuelto.
- Compilación de producción correcta. `tsc --noEmit` global detecta errores
  preexistentes en tests de administración/comisiones; no se cambiaron esos archivos.
- ESLint de las nuevas pantallas y acciones, sin errores. El test SQL usa el mismo
  runtime aislado PGlite 0.5.8 de las pruebas CRM existentes, bajo `outputs/crm-auto-link-test-runtime`.
- Sin hallazgos de seguridad nuevos respecto a la lectura previa de Supabase.
- Falta validar visualmente con sesiones autenticadas de cada rol; no se afirma
  verificación de despliegue por el mero hecho de subir un commit.
