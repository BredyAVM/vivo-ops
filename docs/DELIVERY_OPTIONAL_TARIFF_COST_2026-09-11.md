# Delivery externo: tarifa automática y costo pendiente

## Regla operativa

Máster selecciona la empresa y puede continuar aunque no conozca distancia o costo. Si ingresa distancia y deja el costo vacío, el servidor consulta el tabulador activo de esa empresa al guardar. Una única tarifa aplicable queda registrada con importe, rango, identificador, usuario y fecha. Un costo manual explícito, incluso cero, tiene prioridad.

Sin distancia, sin tarifa aplicable, con tarifas superpuestas o con precio de catálogo inválido, la asignación se guarda con costo pendiente (`null`), nunca como cero. Se mantienen las validaciones de valores mal escritos y los permisos existentes. Los rangos se aplican tal como están configurados; no se redondean distancias para cubrir huecos.

## Administración

Una vez entregada la orden, Administración → Finanzas → Delivery muestra `Costo pendiente` y el enlace `Completar costo` en el detalle del período. Abre la orden en Máster Ops → Entrega. El administrador usa `Corregir externo`, completa distancia, costo y motivo, y guarda sin cancelar ni recrear la orden. Esta corrección conserva sus controles administrativos existentes; no busca una tarifa actual automáticamente en la base de datos para una entrega histórica.

El listado sigue sujeto al período seleccionado. No se creó una nueva bandeja global ni un proceso de pago a empresas externas. Registrar costo no paga ni modifica el cargo al cliente. Los retornos de efectivo y liquidaciones de custodia son independientes del costo del servicio.

## Implementación

- `assign_delivery_with_cost_v1`: misma firma, `security invoker`, autorización Master/Admin y `search_path` cerrado; registro atómico de asignación, costo e historial.
- Nuevas fuentes `external_partner_tariff_v1` y `external_partner_pending_v1`; se conserva la fuente manual.
- Dos interfaces: Máster Dashboard y Máster Ops. El historial visible utiliza el importe devuelto por la base de datos, no el costo vacío enviado por la pantalla.
- Ninguna modificación retroactiva de tarifas, costos, órdenes reales, inventario, comisiones ni dinero.
- Migración aplicada: `20260911210715_external_delivery_optional_tariff_cost.sql`.

## Verificación

- 118 pruebas de Administración aprobadas.
- Compilación de producción de Next.js aprobada.
- Tres suites SQL con datos sintéticos y reversión completa: asignación y permisos; tarifas y continuidad operativa; corrección administrativa.
- Casos: costo/distancia ausentes, cero explícito, manual, límites inclusivos, huecos, tarifa inactiva, empresa inactiva, rango abierto, superposición y conservación del costo al cambiar el catálogo.
- Flujo verificado en base de datos: asignar pendiente → salir a delivery → entregar → completar costo como Admin.
- Cero órdenes, empresas y tarifas de prueba remanentes. Anónimo sin permiso de ejecución.
- La comprobación global adicional `tsc --noEmit` encontró errores en pruebas preexistentes ajenas al cambio (tipos de `registerHooks` y fixtures de comisiones); la compilación de la aplicación sí pasó. No se alteraron esas pruebas.
- Sin prueba visual autenticada de los formularios administrativos en esta sesión; no se guardaron operaciones reales desde el navegador.

Las guías de Supabase/Next.js orientaron la validación autorizada del lado del servidor; la revisión de React mantuvo los controles de doble envío existentes, añadió etiquetas accesibles y evitó nuevas solicitudes de tarifa desde Máster Ops. La publicación usa el despliegue Git existente de Vercel.
