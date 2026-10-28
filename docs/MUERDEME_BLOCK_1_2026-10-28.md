# Muérdeme bloque 1 de integración

## Entrega

La base de marcas es independiente de los escritores comerciales actuales. Administración dispone de **Negocio → Marcas y Muérdeme**, con consulta explícita y catálogo opcional de 25 productos por página. La pantalla conserva el panel y los componentes de navegación administrativos.

- VIVO Fritos figura en operación; Muérdeme permanece en preparación.
- Los productos sin una asignación explícita se presentan como VIVO, sin modificar sus filas ni precios.
- Los estímulos iniciales de Muérdeme son USD 0,30 por primer pedido y USD 0,20 por recurrente. Administración puede modificar los importes en preparación, con coma o punto decimal y cero explícito.
- Cada guardado genera una versión con autor, hora e identificador del intento. Las versiones anteriores se conservan. Un reintento idéntico no duplica la versión; una pantalla desactualizada debe volver a consultar.
- Las relaciones de adquisición por marca tienen un almacenamiento separado de la asignación VIVO del cliente. No se crean fichas, relaciones ni asignaciones reales en este bloque.

## Límites de activación

La configuración de estímulos es un borrador comercial. No genera derechos de cobro, liquidaciones, movimientos ni porcentajes. Sigue pendiente definir cuándo se gana el estímulo, la primera compra válida y el tratamiento de referidos y cancelaciones antes de habilitar esa operación.

No se han cargado hamburguesas, combos, papas, bebidas ni precios de prueba. Tampoco se habilita la venta de Muérdeme. Los comandos para clasificar productos, registrar la adquisición de clientes y abrir ventas se incorporarán con los siguientes bloques, junto con sus validaciones canónicas. La pantalla no expone un interruptor para saltarse esa preparación.

El historial completo queda persistido; la pantalla inicial muestra la versión y fecha actuales. Su visor de versiones anteriores queda para la ampliación de configuración comercial.

## Datos y permisos

Migración: `supabase/migrations/20261028185749_commercial_brand_foundation_v1.sql`, alineada con la versión aplicada en Supabase.

Tablas nuevas en `app_private`: `commercial_brands`, `commercial_product_brands`, `commercial_client_relationships` y `commercial_incentive_policy_revisions`. Todas tienen RLS. Las funciones públicas nuevas usan `SECURITY INVOKER`, `search_path` vacío y acceso exclusivamente administrativo con perfil activo. Anónimo, asesor, master e inactivos no ejecutan las operaciones administrativas.

Los roles de aplicación no pueden modificar los indicadores de apertura ni las asignaciones de producto o cliente. Las revisiones de estímulos permiten lectura e inserción administrativas; no permiten actualización ni borrado. No se cambian los permisos de las tablas comerciales anteriores.

## Validación

- 81 pruebas específicas aprobadas: PostgreSQL aislado, modelos, comandos de servidor, carga por consulta, navegación administrativa, conservación de acuerdos, comisiones VIVO y la mejora de recepción de inventario incorporada desde `main`.
- Compilación estricta de producción y ESLint aprobados. La comprobación global de tipos de los archivos de pruebas conserva errores anteriores de `registerHooks` y tipado de otros ensayos; no se modifica esa configuración ni se presenta como aprobada.
- En la base real, consulta y guardado de una versión de prueba bajo rol administrativo con **ROLLBACK**. La revisión persistida al terminar sigue siendo 1, con USD 0,30 y USD 0,20.
- Catálogo real: 151 productos; la comparación de precios y términos comerciales antes y después produjo el mismo hash `c133fc9f32b51b52c16b754ac00ee137`.
- Funciones financieras y de comisiones existentes: mismo hash antes y después, `9ae59364f8c5a4ba39889089c28a732d`.
- El ensayo aislado comparó íntegramente productos, existencias, clientes, órdenes, partidas, pagos y liquidaciones pagadas antes y después de instalar y operar la nueva configuración, sin diferencias.
- El asesor de seguridad conserva las alertas anteriores y añade cuatro avisos de posible descubrimiento GraphQL por los permisos SELECT requeridos por las funciones invocadoras. La comprobación real de GraphQL bajo `authenticated` y el `search_path` habitual no refleja tipos ni colecciones de estas tablas privadas. La función pública de consulta sí es visible, y rechaza a quien no sea administrador activo. RLS se mantiene también para accesos directos; no se cambia a funciones que omitan esa protección para suprimir el aviso.

## Siguiente bloque

Catálogo estructurado de hamburguesas, presentaciones, ingredientes retirables, extras, papas y combos fijos o elegibles. Cada hamburguesa de un combo conservará su configuración individual. El menú y los precios definitivos se cargarán cuando se aprueben; los ejemplos comerciales no se convierten en precios reales.
