# Muérdeme bloque 2 de catálogo configurable

## Acceso y alcance

**Administrador → Negocio → Marcas y Muérdeme → Catálogo de Muérdeme** permite crear y configurar hamburguesas, extras, papas, bebidas y combos. La consulta del listado es explícita, de 25 registros por página. La configuración completa se lee al abrir un producto; no se descarga al entrar al módulo administrativo.

Todo queda en preparación. Este bloque no habilita ventas ni crea productos en el catálogo operativo de VIVO. Los nombres, recetas comerciales y precios definitivos deben cargarse por administración; no se insertan los ejemplos de presupuestos o pruebas como menú comercial.

## Configuraciones disponibles

| Tipo | Configuración |
| --- | --- |
| Hamburguesa | Presentaciones simples o dobles, cada una con precio propio, ingredientes incluidos y permiso para retirar cada ingrediente. |
| Hamburguesa con papas | Una presentación vincula las papas y las porciones que ya incluye su precio completo. |
| Extra | Presentaciones con precio en USD; cada hamburguesa define cuáles permite y su cantidad máxima. |
| Papas | Tamaños con precio propio y ampliaciones de una presentación a otra con suplemento explícito en USD. |
| Bebida | Presentaciones con precios propios; pueden elegirse como componentes de combos. |
| Combo | Precio completo propio, grupos de hamburguesas, papas y bebidas, cantidad de cada grupo y opciones permitidas con suplementos explícitos. |

Un grupo con una opción es fijo; con varias opciones permite elegir. Cantidad dos en hamburguesas conserva dos unidades configurables individualmente para el próximo bloque del editor de pedidos. El precio de los componentes incluidos no se vuelve a sumar al del combo. Los extras y ampliaciones mantienen sus cargos separados.

Si un combo tiene un grupo de papas, no admite simultáneamente hamburguesas que ya incluyan papas. El sistema señala esa configuración para resolverla antes de guardar. No añade ni elimina acompañamientos silenciosamente.

Los ingredientes de este catálogo describen qué incluye y qué se puede retirar de la hamburguesa. No sustituyen la futura receta de costos con gramajes, rendimiento o materias primas. Elegir doble no duplica automáticamente los demás ingredientes.

## Trabajo administrativo

Conviene crear primero extras, papas y bebidas; luego vincularlos a las hamburguesas y armar los combos. También se pueden guardar borradores básicos y completar sus vínculos después. Un precio vacío queda **pendiente**; cero representa explícitamente **sin cargo**. Los importes aceptan coma o punto decimal y hasta dos decimales, con la moneda visible.

Duplicar una presentación copia su configuración para ajustarla, conservando independientes los cambios de cada presentación. El archivo conserva los registros, pero no se permite archivar un componente ni retirar una presentación si eso deja incompleto un producto o combo vinculado. Primero se ajusta ese vínculo.

Cada guardado conserva una revisión inmutable con autor, hora y operación. Reintentar el mismo guardado devuelve el mismo resultado. Una pantalla desactualizada debe volver a consultar antes de guardar. Se conservan los filtros del catálogo al regresar desde un producto.

## Datos y seguridad

Migración aplicada: `supabase/migrations/20261028193056_muerdeme_menu_drafts_v1.sql`.

Las identidades y revisiones viven en `app_private.muerdeme_menu_entries` y `app_private.muerdeme_menu_revisions`. Solo administración activa puede leer o insertar, con RLS. No se concede actualización ni borrado. Las funciones son invocadoras, con `search_path` vacío. Los validadores y los triggers verifican también los intentos de inserción directa y los cambios que podrían dejar incompletos otros borradores.

El bloqueo de guardado está limitado al catálogo de preparación de Muérdeme. No comparte bloqueos con órdenes, pagos, inventario o comisiones de VIVO. Los vínculos solo admiten tipos y presentaciones de Muérdeme; no pueden apuntar a productos VIVO ni formar combos anidados o ciclos.

Las búsquedas de opciones devuelven hasta 200 productos y mantienen primero los que ya están vinculados. Si hay más, se habilita una búsqueda explícita para acotar. Las configuraciones tienen límites de tamaño y cantidad para evitar peticiones desproporcionadas.

## Validación

- 107 pruebas específicas aprobadas: documentos y referencias, dinero, permisos, PostgreSQL real aislado, comandos de servidor, renderizado, navegación y regresiones de precios, comisiones e inventario de VIVO.
- Compilación estricta de producción y ESLint aprobados. No se cambia ni se presenta como aprobada la comprobación global de tipos de los antiguos archivos de pruebas.
- En la base real se crearon, vincularon y consultaron los cinco tipos dentro de una transacción con **ROLLBACK**. Se comprobó el reintento exacto, el precio pendiente, el combo con dos hamburguesas y el rechazo al archivar un extra vinculado. No quedaron productos ni revisiones de ensayo.
- Los 151 productos operativos conservaron el hash de precios y términos `c133fc9f32b51b52c16b754ac00ee137`. Las funciones financieras y de comisiones existentes conservaron `9ae59364f8c5a4ba39889089c28a732d`.
- El asesor de seguridad mantiene los avisos anteriores y añade dos avisos de descubrimiento potencial GraphQL por los permisos de lectura necesarios para las funciones invocadoras. La consulta real de GraphQL bajo `authenticated` y el `search_path` habitual no refleja tipos ni colecciones de las tablas privadas nuevas. RLS y las comprobaciones administrativas se mantienen; no se conceden permisos anónimos ni funciones que eludan RLS.

## Próximo bloque

Conectar este catálogo al editor compartido de pedidos, con selección individual de cada hamburguesa, retiros, extras y ampliaciones. Después siguen cocina, inventario operativo, pagos, WhatsApp, órdenes mixtas y liquidaciones. La habilitación comercial continúa siendo una operación separada.
