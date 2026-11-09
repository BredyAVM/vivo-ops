# NC: cupón compartido en bebidas y delivery

La NC de noviembre (#36) continúa en borrador, con sus 27 integrantes y exclusiones conservadas. No se confirmó ni compartió la campaña. Los aportes del asesor y de la empresa siguen pendientes de revisión.

## Operación

- Compra mínima: $15 en productos pagados, sin envío ni líneas bonificadas.
- El asesor elige explícitamente las bebidas y/o un envío; seleccionar al cliente no agrega productos.
- Un solo límite de $4 por pedido y cliente. El cliente paga el exceso; el sobrante no queda como saldo ni efectivo.
- Ejemplo: bebida de $3,50 + envío de $4 = $4 de cupón y $3,50 pagados por el cliente.
- Cada opción usa una unidad. Las unidades adicionales sin cupón se agregan desde el catálogo normal.
- Guardar reserva el cupón; entregar confirma su consumo. Quitar el beneficio o cancelar libera la reserva. Los canjes entregados conservan su historial.
- Reabrir un borrador, recalcular y modificar un pedido conservan la identidad CRM. La base calcula el descuento autorizado; no confía en precios enviados desde el navegador.

## Revisión de costos

En la definición de la NC se muestra un único aporte máximo del asesor sobre los $4; el resto corresponde a la empresa. Si se usa menos, ambos aportes se prorratean sobre el descuento efectivo. El redondeo acumulado evita cargos adicionales por dividirlo entre varios productos. Hasta revisar los importes y marcar «Costos revisados», la confirmación del snapshot queda bloqueada.

Los importes por opción son soporte interno del límite común, no créditos acumulables. Los presupuestos calculan un máximo de $4 por cliente, aunque existan muchas bebidas y zonas disponibles. El catálogo autorizado usa el grupo de inventario `beverages` y los productos Delivery Zona 1–7; no se autoriza comida.

## Verificación

- Pruebas aisladas con las funciones instaladas de PostgreSQL: precio canónico, suma máxima, prorrateo, modificación, reemplazo, cancelación, entrega, mínimo, moneda VES, conservación de precios, autorización y uso único.
- Pruebas de recuperación de borradores, obsequios existentes, precios aprobados y protección frente a envíos repetidos.
- Sin pedidos ni movimientos financieros de prueba en producción.

Migraciones: `20261109185549_crm_shared_coupon_v1.sql` y `20261109191708_crm_coupon_catalog_options_v1.sql`. La segunda admite el catálogo de opciones del cupón y conserva el máximo de ocho alternativas para jugadas ordinarias.
