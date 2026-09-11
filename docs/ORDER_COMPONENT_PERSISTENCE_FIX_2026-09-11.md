# Conservación del detalle de packs — 2026-09-11

## Causa verificada

El cambio CRM `3893bf8` reutilizó el filtro de presentación en la carga y persistencia del compositor de Asesor y en `replaceAdvisorOrderItemsAction`. Eliminó `@sel|producto|cantidad` junto con los marcadores CRM. El texto visible permanecía, pero el resolutor de inventario usa las selecciones estructuradas o estos marcadores, no el texto descriptivo. La orden 2540 ilustró el problema; el usuario ya la corrigió y este bloque no la modifica.

## Corrección

- Separación entre detalle persistible y detalle visible. Los marcadores de piezas se conservan al crear, editar, cargar y recuperar borradores; los marcadores CRM se siguen excluyendo. Los permisos y columnas de beneficios no cambian.
- Validación del detalle contra el catálogo vigente con sesión autenticada antes de escribir la cabecera desde el compositor. El reemplazo de ítems vuelve a validar en el servidor antes de insertar.
- La descripción que se guarda se genera con las mismas selecciones que usa inventario. No se utiliza una descripción de seis piezas para sustituir una selección real de una pieza.
- Un detalle antiguo sin marcadores solo se reconstruye al guardar si sus nombres coinciden exactamente y sin ambigüedad con componentes permitidos y cumple las cantidades. No hay reparación masiva ni cambios a órdenes históricas.
- Packs incompletos, cantidades excedidas, componentes ajenos, marcadores malformados o duplicados generan un mensaje que identifica el ítem antes del guardado normal.
- Se conservan las notas libres; los componentes fijos obligatorios consideran la cantidad de packs. Las selecciones ya expresadas en piezas totales no se multiplican dos veces.

## Alcance y límites

No cambia precios, cobros, comisiones, permisos, tablas ni funciones de base de datos. No se guardaron órdenes reales para probar. Es una corrección del flujo de Asesor; no convierte todas las escrituras de órdenes de la aplicación en una única transacción. La validación previa de creación no sustituye las autorizaciones o validaciones de la base de datos, ni elimina posibles cambios concurrentes posteriores del catálogo.

La recuperación de borradores permite seguir trabajando con borradores incompletos, pero exige composición válida antes de convertirlos en orden. No se presume una prueba visual de guardado desde un navegador autenticado: la cobertura incluye funciones de normalización, fronteras de integración en el código, compilación y diagnóstico real de inventario con registros sintéticos revertidos.

## Verificación

- `test:order-details`: creación, edición, repetición, recuperación JSON de borradores, detalles visibles contradictorios, recuperación exacta y ambigua, faltantes/excesos, cantidades múltiples y medias, componentes fijos/opcionales, notas y separación CRM.
- Suite CRM completa: 19 pruebas aprobadas; Administración: 118; seguridad financiera: 6.
- Compilación de producción aprobada.
- SQL `tests/crm/order-detail-persistence.rollback.sql`: reproduce el error con texto sin selección; conserva marcadores a través del guardado real; el diagnóstico de inventario queda sin errores; no genera movimientos de inventario. Todo ejecutado dentro de una transacción revertida.

Las guías Next.js/Supabase orientaron la validación con la sesión del usuario y la separación entre presentación y persistencia. La publicación sigue la integración Git existente de Vercel.
