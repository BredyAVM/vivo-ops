# Muérdeme · Bloque 10 · Administración del catálogo

Fecha: 2 de noviembre de 2026. Secuencia: [esquema general](MUERDEME_INTEGRATION_SCHEME_2026-10-28.md).

## Resultado

Administración → Negocio → Marcas → Muérdeme → Catálogo permite crear y modificar hamburguesas, extras, papas y combos tanto en preparación como durante la operación. Las bebidas incluidas siguen vinculadas a los productos VIVO; no se crea otro catálogo de bebidas.

Cada guardado incorpora una versión inmutable con administrador, fecha y hora. La nota es opcional; si se omite, se registra «Carga inicial» o «Actualización del catálogo». Se pueden revisar los cambios de precios en USD y los apartados modificados antes de guardar. Un precio pendiente sigue siendo distinto de cero.

Desde cada producto se abre «Historial de cambios». La consulta lee únicamente ese producto, en páginas de hasta 25 versiones, con el detalle visual plegado. No se consulta al entrar al inicio ni al catálogo sin solicitarlo.

Archivar deja el producto fuera de nuevas cotizaciones; no lo elimina. Se conservan las comprobaciones que impiden dejar incompletos combos y hamburguesas dependientes. Se pueden volver a habilitar productos archivados guardando una nueva versión.

## Conservación de información

- Los pedidos guardados conservan precios, selección, certificado físico y condiciones del estímulo. No se escriben órdenes, pagos ni liquidaciones históricas durante un cambio del catálogo.
- Las cotizaciones nuevas utilizan las versiones actuales. Un formulario abierto antes del cambio debe actualizarse; el control de versiones impide guardar una cotización desactualizada como si fuera vigente.
- Un cambio de precio conserva la validez física de una receta cuya composición no cambió. Cambiar carne simple/doble o ingredientes exige revisar la receta antes de nuevas ventas. Las recetas pendientes impiden consumo incompleto.
- No se habilitan ventas, activan adaptadores, crean menús de muestra ni movimientos de inventario en producción. La apertura queda en el bloque 16.
- Las modificaciones y la repetición de pedidos existentes después de cambios comerciales se revisan integralmente en el bloque 13; este bloque no promete recotizar automáticamente esas modificaciones.

## Permisos y concurrencia

La función nueva de guardado mantiene autorización por administrador activo en base de datos, permisos por fila, versión esperada, bloqueo transaccional compartido e idempotencia con comprobación de documento y nota. Los clientes anteriores siguen usando la función original mediante una envoltura compatible. El historial también exige administrador activo. No se conceden permisos a anónimos ni a usuarios de operación para administrar el menú.

Migración: `20261102154757_muerdeme_live_catalog_v1.sql`. Las versiones anteriores no reciben notas retroactivas inventadas. No se modifican las funciones financieras, de comisiones ni de inventario.

## Menú y recetas pendientes

El menú comercial definitivo corresponde al bloque 11. Las cantidades por hamburguesa, doble, extra y porción de papas corresponden al bloque 12: por ejemplo, lonjas de queso y tocineta, gramos o unidades de los demás insumos. No se presuponen cantidades. Es posible preparar nombres, presentaciones, retiros permitidos, extras y precios antes de completar esas recetas físicas.

## Verificación

174 pruebas de marcas, catálogo, configuración, bebidas compartidas, inventario, canales, Counter y conservación histórica; 100 de comisiones. Incluyen cambios con ventas habilitadas en base aislada, reintentos, ediciones simultáneas, conservación de recetas por cambios de precio, revisión por cambios físicos, historial paginado y rechazo de roles no autorizados. Comprobación de tipos, revisión estática y compilación de producción antes de publicar.

Migración aplicada en producción con ventas Muérdeme deshabilitadas y cero entradas de menú, antes y después. Comparadas las definiciones de 158 funciones financieras, de comisiones e inventario: ninguna cambió. Los dos comandos nuevos son de ejecución con permisos del usuario, sin acceso anónimo y con `search_path` cerrado. La revisión de avisos de seguridad no señaló las funciones nuevas; las tablas Muérdeme conservan sus permisos y protección por filas existentes.
