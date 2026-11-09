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

Los importes por opción son soporte interno del límite común, no créditos acumulables. Los presupuestos calculan un máximo de $4 por cliente, aunque existan muchas bebidas y zonas disponibles. La autorización se configura por familias: **Bebidas** y **Delivery**, juntas o por separado. En borrador los productos nuevos entran automáticamente. Para incluirlos también después de publicar, el administrador debe activar la casilla explícita por jugada; en la NC #36 está activada. Esto conserva la lista de clientes y los importes ya entregados. Los desactivados o que salgan de las familias no se ofrecen para canjes nuevos.

Bebidas usa la clasificación existente `inventory_group=beverages`; Delivery reutiliza el criterio de la aplicación (nombre con «delivery» o SKU de delivery), sin una lista fija de zonas. Los identificadores de producto se mantienen internamente solo para vincular selección, reservas e historial, y se generan desde la regla de familia. La pantalla muestra casillas por familia y permite desplegar los productos disponibles hoy.

## Verificación

- Pruebas aisladas con las funciones instaladas de PostgreSQL: precio canónico, suma máxima, prorrateo, modificación, reemplazo, cancelación, entrega, mínimo, moneda VES, conservación de precios, autorización y uso único.
- Pruebas de recuperación de borradores, obsequios existentes, precios aprobados y protección frente a envíos repetidos.
- Sin pedidos ni movimientos financieros de prueba en producción.

Migraciones: `20261109185549_crm_shared_coupon_v1.sql`, `20261109191708_crm_coupon_catalog_options_v1.sql` y `20261109193045_crm_coupon_dynamic_families_v1.sql`. La segunda conserva el máximo de ocho alternativas para jugadas ordinarias; la tercera incorpora familias dinámicas y protege los términos publicados y el historial financiero.
