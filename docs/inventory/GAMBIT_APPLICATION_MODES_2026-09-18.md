# Jugadas: aplicación discrecional y mediante CRM

## Contrato acordado

Ambas vías son jugadas comerciales. Administración decide por producto Gambit si permite:

- Uso a discreción del asesor.
- Uso mediante una jugada del CRM.
- Ambas vías simultáneamente.
- Ninguna vía, mientras prepara su configuración.

Estar activo sigue siendo requisito. No se alteran las suspensiones explícitas, vigencias, precios, costos del asesor, comisiones ni vínculos de inventario. Las órdenes existentes no se reescriben.

## Dónde se configura

Centro de Inventario → Configurar → Ver o modificar un perfil → Producto → seleccionar producto Gambit → **Forma de aplicar la jugada** → **Guardar datos comerciales**.

Las mismas casillas aparecen al crear un producto de familia Gambit. Por defecto, uno nuevo queda solo para CRM. Un producto inactivo listo para operación conserva el flujo existente de reactivación; los borradores se configuran desde el formulario de creación/reutilización.

La implementación no cambia masivamente la condición de productos existentes. En particular, `GAMBIT_DONDY_1` conserva su condición previa: para ofrecerlo libremente hay que marcar **A discreción del asesor**. Si también se utilizará en CRM, se dejan ambas casillas marcadas. Los Cliente Nuevo previamente habilitados conservan ambas vías.

## Persistencia sin duplicaciones

Se reutiliza `products.extra_fields.catalog_access_scope`:

| Valor | Discrecional | CRM |
| --- | --- | --- |
| `advisor_gift` | Sí | Sí |
| `advisor_gift_only` | Sí | No |
| `crm_only` | No | Sí |
| `gambit_disabled` | No | No |

`advisor_gift` ya permitía ambas vías; se conserva su significado. Un Gambit sin clasificación sigue cerrado para selección libre y conserva su posibilidad de uso CRM. `admin_internal` no se convierte en producto comercial mediante estas casillas.

Los permisos de configuración se validan en las RPC existentes, con autenticación y rol administrador. Se mantiene el contrato JSON de creación/edición agregando un parámetro opcional dentro del objeto existente; clientes anteriores que no lo envíen conservan la condición anterior. No hay tablas, columnas ni RPC públicas nuevas.

## Canales y guardado

- Asesor usa la política común para la selección libre.
- Máster conserva todos los productos necesarios para construir beneficios del CRM, pero excluye los no discrecionales de la búsqueda libre. No filtrar el catálogo completo: rompería la selección desde una jugada.
- Counter filtra la lista de venta libre. Sus componentes obligatorios se mantienen disponibles por la ruta independiente de composiciones.
- El configurador de campañas y el contexto CRM excluyen productos con CRM deshabilitado.
- La base valida ambos caminos al escribir `order_items`, incluso si se evita la interfaz.
- Un beneficio vinculado conserva sus validaciones de cliente, asesor, selección, cantidad, ampliación, vigencia y redención. Habilitar ambas vías no evita esas comprobaciones.
- Una redención existente sigue siendo válida si después se deshabilita la vía CRM; no se reescribe su historial.
- Los productos discrecionales de precio cero se mantienen gratuitos para el cliente. Las estrategias con precio conservan su precio fuente: no se convierten automáticamente en regalos.
- El uso queda distinguido por las columnas CRM existentes de la línea: con vínculo = CRM; sin vínculo = discrecional. No crear un segundo registro de redención por el uso libre.
- Los rechazos comerciales identificados de la edición de Máster se devuelven como resultados legibles, en lugar de lanzar la excepción genérica de producción.

## Verificación y límites

- `npm run build`: correcto. La primera ejecución aislada no pudo descargar Google Fonts; la repetición con acceso de red compiló y completó páginas y TypeScript.
- 18 pruebas Node: cuatro combinaciones, compatibilidad anterior, creación/edición, catálogo, CRM y validaciones de beneficios.
- 21 comprobaciones SQL con rollback: persistencia de las cuatro combinaciones, preservación de otros campos, catálogo Counter, guardado por administrador en orden de asesor y por asesor adjudicado, rechazo de configuración por asesor, validación de CRM aunque ambas vías estén habilitadas, precio cero, modo inválido, estrategia con precio y redención histórica.
- Las inserciones de prueba utilizaron una tabla temporal con el trigger real. No se insertaron líneas en órdenes reales ni se modificaron existencias. Los cambios de configuración durante las pruebas se revirtieron.
- ESLint dirigido: correcto.
- Revisión React: casillas accesibles con etiquetas y fieldset; componente compartido; sin nuevas consultas al interactuar ni cargas adicionales del inventario.
- Revisión de seguridad Supabase antes/después: sin hallazgos nuevos. Persisten avisos preexistentes del proyecto, fuera de este cambio. Referencia: https://supabase.com/docs/guides/database/database-linter.
- `tsc --noEmit` aislado detectó errores en pruebas ajenas a esta entrega (`registerHooks` y snapshots de comisiones). No se corrigieron esos archivos. La compilación de producción sí terminó correctamente.
- El intento de revisión visual local llegó a la pantalla de inicio de sesión. No se utilizaron credenciales ni se afirma haber completado una prueba interactiva autenticada del formulario.

Migración local: `20260918124833_gambit_application_modes.sql`, aplicada a producción mediante Supabase. La migración reemplaza las funciones verificadas y conserva los permisos existentes. No reclasifica ningún producto automáticamente.

Auditoría precedente: `DONDY_ACTIVE_CATALOG_AUDIT_2026-09-18.md`. Su recomendación inicial de abrir todo Gambit activo queda reemplazada por este contrato explícito de dos vías configurables.
