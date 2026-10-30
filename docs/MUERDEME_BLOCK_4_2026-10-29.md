# Muérdeme conectado con cocina e inventario

## Configuración y uso

En **Administración → Negocio → Marcas → Catálogo Muérdeme**, cada producto guardado tiene **Preparación e inventario**. Administración configura por presentación los insumos, cantidades y unidades reales. Simple y doble tienen recetas independientes; el sistema no duplica automáticamente todos los ingredientes al elegir doble.

Una línea de consumo puede ser siempre necesaria o depender de un ingrediente incluido. Si el cliente retira ese ingrediente, se omite solo su consumo asociado. Los extras usan su propia receta y cantidad. Las papas incluidas y las agrandadas consumen la presentación final elegida, sin descontar también la original. Cada componente de un combo aporta su consumo; se puede configurar además el empaque del combo. La exclusión de inventario requiere una decisión explícita con motivo.

En el configurador de pedidos, **Ver preparación e inventario** consulta las instrucciones y el consumo al pulsarlo. Muestra existencias físicas, sin reservar ni descontar por consultar. La pantalla de receta limita la búsqueda a 200 insumos y mantiene los vinculados a la vista. No añade consultas al crear pedidos exclusivamente VIVO.

Las cantidades admiten hasta seis decimales y conservan la unidad del inventario, por ejemplo kg, litro o pieza. Solo se vinculan ítems activos, sin fusionar, con seguimiento transaccional y consumo por venta. Un insumo descontado en producción necesita una decisión de configuración antes de usarlo también en venta; no se vincula automáticamente.

## Cocina

El desglose conserva cada hamburguesa y su posición en el combo, la presentación simple o doble, los ingredientes retirados y sus extras. Papas y bebidas aparecen por separado. El resumen distingue hamburguesas, porciones de papas y bebidas; no interpreta un combo como una pieza. La preparación de Muérdeme no muestra precios ni documentos internos. Las líneas VIVO conservan su presentación anterior.

La pantalla de cocina y el ticket utilizan el mismo resultado calculado en el servidor, sin consultar otra vez las recetas. Una preparación incompleta genera una advertencia visible y no inventa cantidades.

## Consumo y conservación

Se reutilizan `inventory_items`, la resolución canónica de órdenes, las reservas y los movimientos de inventario existentes. No se crea un segundo saldo ni un descuento independiente. Al aprobar se comprometen cantidades; el delivery descuenta en la salida a reparto y el pickup cuando se entrega, conforme a las reglas existentes. Una repetición de la operación de salida conserva la protección contra duplicados.

El guardado verifica que todas las presentaciones tengan consumo completo. Una receta pendiente o desactualizada devuelve instrucciones para revisar y ninguna lista parcial de consumos. Los cambios de precio no invalidan por sí solos una receta física; cambios en ingredientes o cantidad de carnes requieren revisarla.

Las recetas tienen revisiones inmutables. Cada renglón guardado recibe un certificado del servidor con su preparación y cantidades. El certificado se conserva al sustituir atómicamente los renglones de la misma orden, si la configuración comercial no cambió. Cambiar la receta afecta a renglones nuevos; copiar un renglón a otra orden obtiene un certificado nuevo. La validación comercial previa de versiones continúa vigente y no actualiza precios silenciosamente.

Los adaptadores comerciales Muérdeme mantienen política de inventario `none`, para que una configuración adicional del catálogo general no produzca un segundo descuento. Sus cantidades físicas proceden exclusivamente del certificado. Los marcadores internos se conservan al guardar y se ocultan en las vistas y WhatsApp.

## Instalación y comprobaciones

Migración aplicada: `20261029163705_muerdeme_kitchen_inventory_v1.sql`. La integración añade una unión al final del diagnóstico existente, con verificación de su definición anterior y comparación automática de hasta 12 órdenes VIVO. Si cambia su resultado, la instalación falla y se revierte. Las funciones nuevas son invocadoras, con `search_path` vacío, permisos explícitos y tablas privadas con RLS. No se añadió una función privilegiada.

- 97 pruebas de marcas, catálogo, configuración, guardado, recetas, permisos y pantallas aprobadas; 26 pruebas de cocina y 30 de conservación de detalles/CRM aprobadas.
- PostgreSQL aislado: igualdad entre cálculo de navegador y SQL; retiros, doble carne, extras, papas agrandadas, cantidades precisas, recetas incompletas, revisión concurrente y reintentos. Certificado conservado al borrar/reinsertar renglones; otro renglón usa la receta vigente.
- Las funciones reales existentes de reserva, resolución de rutas y salida se ejercitaron con dependencias mínimas de inventario en una base aislada: suma de VIVO y Muérdeme, reserva sin descuento, salida física, repetición segura y rechazo de una segunda salida con otra clave.
- Base real: prueba transaccional de creación de receta y preparación con cantidad `0.123456`, revertida. No se escribieron órdenes, pagos ni movimientos. Las existencias y la definición de las funciones financieras públicas conservaron sus huellas antes y después de instalar.
- Compilación de producción, TypeScript y revisión de los componentes nuevos sin errores. Formulario de receta verificado en escritorio y con ventana móvil de 390 px, sin controles fuera del ancho.
- El asesor de seguridad conserva sus avisos anteriores y agrega dos avisos potenciales de descubrimiento GraphQL por las tablas privadas nuevas. La introspección real bajo `authenticated` y el esquema habitual no las expone. No se ampliaron permisos para ocultar esos avisos.

## Condiciones de apertura

### Bebidas VIVO compartidas, 30 de octubre

Los grupos de bebidas de los combos seleccionan productos existentes del catálogo VIVO. La referencia interna `vivo:<productId>` identifica el mismo producto; no crea una identidad de menú, un adaptador comercial ni otro saldo de inventario para la bebida. La opción de crear una bebida independiente de Muérdeme se reemplaza por una explicación y el servidor rechaza esa creación.

Se permiten bebidas activas, de catálogo normal, con configuración física completa y vínculos vigentes de versión 1. Se ignoran los vínculos antiguos de versión 0, evitando sumar ambos. Bebidas inactivas, internas, obsequios o con insumos inactivos/incompletos no se pueden incorporar a un combo nuevo. Los filtros conservan las opciones ya elegidas y la consulta sigue limitada a 200 referencias; no carga órdenes ni historia financiera.

El precio del combo cubre la bebida incluida. Solo se suma un suplemento expresamente configurado; un cambio del precio de la bebida vendida aparte no modifica el combo. La bebida independiente conserva su precio y comisión VIVO. El estímulo del combo sigue la regla del mayor importe una sola vez por pedido.

La preparación toma exactamente los vínculos vigentes del producto VIVO y los suma al mismo diagnóstico y libro de inventario existentes. Si una orden contiene una bebida incluida y otra igual vendida aparte, se descuentan dos unidades del mismo inventario. Consultar y reservar no descuentan; la salida física conserva su protección contra reintentos. El certificado ya guardado conserva su consumo anterior aunque luego cambien los vínculos; otro renglón nuevo obtiene los vigentes. No se modifican las funciones centrales de reserva ni de salida para añadir este bloque.

La migración `20261030145549_muerdeme_shared_vivo_drinks_v1.sql` añade lectores invocadores y amplía la validación del menú, sus referencias y el consumo Muérdeme. No escribe productos, saldos, pagos, comisiones ni órdenes reales. Las pruebas PostgreSQL aisladas ejercitan creación sin duplicados, cotización y preparación iguales en cliente/servidor, certificados históricos, permisos y despacho real con las funciones existentes.

Muérdeme permanece con ventas deshabilitadas. No hay menú, cantidades comerciales ni existencias Muérdeme inventadas. Antes de abrir ventas se deben cargar el menú aprobado, los insumos, las recetas físicas y los conteos de apertura necesarios, y terminar las condiciones del canal de pedidos y del estímulo configurable por orden. Este bloque no altera precios, pagos históricos ni cierres de comisión pagados de VIVO.
