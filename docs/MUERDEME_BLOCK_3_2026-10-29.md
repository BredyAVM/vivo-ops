# Muérdeme: configurador en el creador compartido de pedidos

## Acceso y alcance

En **Nuevo pedido → Muérdeme · menú**, Administrador, Master y Asesor comparten el mismo configurador. El catálogo se consulta al pulsar **Consultar menú**; abrir el editor de órdenes no descarga el menú ni consulta su historial. El listado tiene filtros de nombre y tipo y páginas de 25 productos. La composición completa y las referencias se leen al elegir un producto, con un máximo de 201 entradas vinculadas.

Mientras Muérdeme siga en preparación, administración puede revisar configuraciones y combinarlas con VIVO en el carrito. Las órdenes que contienen Muérdeme no se envían todavía a operación: la comprobación se hace antes de escribir el cliente o la orden, además de existir un bloqueo en la base de datos. Retirar las líneas Muérdeme permite continuar normalmente con VIVO. Los demás vendedores reciben un aviso de preparación y no acceden aún al menú sin publicar.

No se cargó un menú comercial ni se inventaron precios. La apertura requiere el menú aprobado y completar cocina, inventario operativo y condiciones comerciales de los bloques siguientes.

## Configuración por unidad

- La presentación simple o doble parte de sus propios ingredientes. Elegir doble no duplica automáticamente salsas, cebolla o los demás componentes.
- Los ingredientes incluidos aparecen seleccionados. Solo se pueden retirar los autorizados por el catálogo, sin reducir automáticamente el precio.
- Los extras tienen presentación, precio en USD y cantidad máxima. Un precio pendiente impide cobrar ese extra; cero conserva su significado explícito de gratuito.
- Las papas incluidas se agrandan por el suplemento configurado y por las porciones correspondientes. No se cobra nuevamente una porción completa.
- Los combos conservan el precio base y sus cantidades de hamburguesas, papas y bebidas. Cada hamburguesa tiene selecciones, retiros y extras independientes. Los componentes incluidos no suman otra vez sus precios individuales.
- Cada producto configurado entra como un renglón de cantidad uno. Se puede volver a configurar o retirar; para otra configuración se añade otro renglón. Dos combos distintos conservan composiciones separadas.
- El precio de pantalla usa centavos enteros; PostgreSQL lo verifica de forma independiente con importes decimales exactos.

## Datos y guardado

La migración `20261029154907_muerdeme_order_configurator_v1.sql` añade vínculos entre las identidades del menú y productos adaptadores nuevos. Al guardar por primera vez una hamburguesa, papas, bebida o combo se prepara un adaptador **inactivo**, sin inventario y con comisión porcentual cero. Los extras permanecen como componentes configurables. Reintentar o guardar otra revisión conserva la misma identidad. El vínculo exige un producto propio de Muérdeme; no convierte productos VIVO existentes.

El precio del adaptador no se usa para cobrar. El importe procede de la presentación elegida y sus suplementos. Las consultas y el guardado verifican las versiones del producto y los componentes utilizados; un cambio exige volver a consultar, sin sustituir opciones ni actualizar precios silenciosamente.

La composición y las revisiones se conservan en un documento estructurado dentro de las notas del renglón, junto con el desglose legible. El marcador interno `@muerdeme|` queda oculto en los resúmenes compartidos, detalle de asesor, cocina y WhatsApp. Los escritores existentes conservan ese documento mediante sus notas, sin añadir columnas a órdenes históricas.

El guardado del servidor comprueba identidad, cantidad, moneda, precio, revisiones y ausencia de beneficios VIVO. Un trigger final verifica también las escrituras directas. Para productos VIVO el trigger devuelve el registro sin entrar en las tablas privadas del menú, conservando las escrituras existentes con cuenta de servicio. Las funciones de precios, pagos, comisiones y guardado ya existentes en la base no fueron reemplazadas.

Todas las funciones nuevas son invocadoras y tienen `search_path` vacío. Los vínculos tienen RLS y no admiten actualización ni borrado desde la aplicación. La sesión y el perfil deben estar activos; no se añade acceso anónimo ni se habilitan ventas desde estos comandos.

## Comprobaciones

- 127 pruebas específicas aprobadas sobre marcas, catálogo, composición y precios, servidor, renderizado, repetición, guardado de asesor, precios administrativos y comisiones. Tras los ajustes finales se aprobaron otras 29 comprobaciones relevantes y la compilación estricta de producción.
- La compilación de Next.js y la revisión de los archivos nuevos con ESLint finalizaron correctamente.
- En PostgreSQL aislado se probaron los adaptadores inactivos, roles, reintentos de catálogo, retiros no autorizados, extras excesivos, revisiones vencidas, bloqueo de ventas, escritura de asesor con precio certificado y conservación de VIVO. Una prueba adicional confirma que el escritor VIVO de servicio no necesita acceso al menú privado.
- En la base real se prepararon los cinco tipos y se cotizó un combo con dos hamburguesas distintas, un extra y papas ampliadas, dentro de una transacción revertida. Se rechazaron ingredientes ajenos y versiones vencidas. Quedaron **cero entradas, revisiones y adaptadores de ensayo**.
- Los 151 productos existentes conservaron el hash de términos `a39530473a583b649591e1bb3627bb49`. Las funciones financieras, de precios, guardado y comisiones verificadas conservaron `94ad0d20efd07bd59605b2e428345b2f`.
- En la prueba visual local del componente real, un combo de ensayo pasó de USD 15 a USD 17 con sus suplementos y se combinó con un renglón VIVO de USD 14: total USD 31. Sus dos hamburguesas conservaron retiros distintos. Estos importes son fixtures de prueba, no tarifas aprobadas. No se registró una venta.
- Vista de computadora revisada; en el formato móvil de 390 px la zona útil de 373 px coincidió con el ancho del contenido y ningún control excedió sus límites. Se restauró el tamaño del navegador. La captura móvil tuvo fallos intermitentes del navegador; la comprobación del ancho se hizo mediante el DOM.
- El asesor de seguridad mantiene los avisos anteriores y añade un aviso de descubrimiento potencial GraphQL por la lectura de la tabla privada de vínculos. La introspección real bajo `authenticated` y el esquema de búsqueda habitual no expone ese adaptador. No se relajaron las reglas para ocultar avisos.

## Siguiente bloque

Completar el recorrido operativo: composición para cocina, recetas y disponibilidad de inventario Muérdeme, despacho y pagos, repetición y cotizaciones, alcance de beneficios y metas por marca. También falta habilitar el canal del teléfono con permisos propios y cerrar las condiciones del estímulo por pedido. Las pantallas preparadas no habilitan esos derechos de cobro ni la apertura comercial por sí solas.
