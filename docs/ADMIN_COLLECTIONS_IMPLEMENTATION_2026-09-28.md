# Cobranzas de Administración — estado de implementación

## Objetivo

Centro operativo para todas las órdenes y todos los vendedores, no limitado a asesores ni a entregadas. Ruta nueva `/app/admin/finanzas/cobranzas`; Cartera conserva el análisis de puntualidad. Accesos en menú, Inicio, Herramientas y Cartera.

## Implementado en código

- Filtros inclusivos de fecha Caracas, creación o entrega registrada; hoy, semana, mes, todo el historial.
- Canal (asesores/master/mostrador), modalidad (pickup/delivery), persona creadora o asesor asignado, rol actual del creador, estado operativo y financiero.
- Pendientes por defecto, todas las órdenes opcionalmente, pagadas, canceladas y pagos por verificar.
- Números cortos de orden; cliente, creador y asesor distintos; importe, cobertura y deuda canónica actual.
- Teléfono del cliente normalizado para abrir WhatsApp sin enviar mensajes automáticamente. Los perfiles de vendedores no tienen teléfono almacenado: se identifica al vendedor por nombre, no se inventa un contacto.
- Acceso al panel de pagos existente; no introduce nuevos comandos financieros.
- Paginación de 30 tras filtrar, totales del conjunto completo; error explícito si no puede verificarse el saldo.
- Decisión del usuario 2026-09-29: consulta exclusivamente bajo demanda. La entrada no lee saldos; fechas, presets y filtros solo preparan la consulta. Se ejecuta con Consultar, paginación explícita o Consultar de nuevo. Sin temporizador, actualización al volver a la pestaña ni precarga de enlaces.
- Período requiere ambas fechas. Todo el historial exige marcarlo expresamente antes de consultar. Cargar vendedores obtiene únicamente perfiles tras una acción explícita; no consulta órdenes ni saldos. Un error conserva la persona seleccionada.
- No recalcula ni cambia cierres de comisiones. Se muestra la hora de la consulta; el saldo es vigente a esa hora, no una promesa de actualización automática.

## Base de datos

APLICADA: `20260928192947_admin_collections_read_v1.sql`, RPC de lectura nueva, wrapper invoker + implementación privada definer con auth.uid y rol admin comprobado. No cambia datos de negocio.

APLICADA el 2026-09-29 tras autorización explícita: `20260928193835_finance_read_scope_payment_evidence.sql`. La comparación antes/después de 49 órdenes pasó dentro de la misma transacción con aislamiento repeatable read. Ambas funciones conservan lenguaje SQL, SECURITY INVOKER, search_path cerrado y sus ACL. #2534 y #2784 mantienen deuda cero; #2874 mantiene pendiente USD 42.93998903163324. No se modificaron pagos ni órdenes.

NO APLICADA y retirada de la cola de migraciones: `docs/proposals/finance_read_reuse_query_plans.NOT_APPLIED.sql`. La propuesta de reutilización de planes requería autorización adicional; NO reintentar sin aprobación explícita. El usuario eligió consultas por período bajo demanda: esta segunda modificación no es requisito para publicar Cobranzas.

La consulta sin filtros excedía 30 segundos. La primera optimización empujó al CTE el mismo filtro `r.order_id = p_order_id` ya aplicado por sus consumidores. EXPLAIN ANALYZE posterior mide 21617.727 ms para todo el historial: sigue siendo lento y no se carga automáticamente. La consulta de pendientes del 7 al 13 de septiembre de 2026 midió 1622.694 ms en base de datos, sin incluir red/renderizado; es una medición, no una garantía de latencia.

Históricos por bloques: posible trabajo futuro para analítica. No congelar saldos de cobranza por fecha de creación: pagos tardíos, anulaciones y ajustes pueden afectar órdenes antiguas. Cualquier resumen incremental requerirá invalidar/recalcular bloques afectados, no solo agregar fechas nuevas.

## Verificación ejecutada

- `npm run test:collections`: 12/12, incluyendo cero lecturas al entrar y ante fechas incompletas, presets locales y consulta explícita de historial.
- `npm run test:admin`: 119/119.
- ESLint de los nuevos archivos: sin errores.
- Consulta RPC con usuario admin y rol SQL authenticated: funciona en búsquedas y período de hoy.
- Usuario asesor: denegado. EXECUTE anónimo: false. Advisors de seguridad sin hallazgos de la función nueva (hay avisos previos del proyecto).
- Orden #2784: estado pagada, pendiente 0; excluida del filtro de pendientes.
- Se capturó una muestra de 22 estados financieros antes de la optimización, incluyendo #2534, #2784 y #2874. No se alteraron pagos, órdenes, fondos ni comisiones.
- `tsc --noEmit`: errores preexistentes en pruebas de active-orders, comisiones y snapshots; no reportó errores de los archivos nuevos.
- `npm run build`: EXIT 0 el 2026-09-29 con red autorizada; compila, verifica TypeScript y genera las páginas incluyendo Cobranzas. Falta revisión visual real.

## Pendientes antes de cerrar el bloque

1. Revisión visual con sesión autorizada: filtros sin lecturas automáticas, resultados, paginación y vendedor retenido tras error.
2. Commit de solo estos archivos, publicación y verificación de despliegue; preservar cambios ajenos.
3. No sustituir la deuda por total menos reportes ni por snapshots de comisiones.

Verificar el estado del commit y del despliegue antes de afirmar que está publicado. La integración incorpora `40b3651` de origin/main para preservar la corrección de saldo nativo VES del otro chat. Preservar los archivos no relacionados y las migraciones históricas sin seguimiento del directorio de trabajo.
