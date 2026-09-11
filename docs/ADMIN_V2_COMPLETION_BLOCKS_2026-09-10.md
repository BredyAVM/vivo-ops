# Administración: corte de integración del 10 de septiembre de 2026

## Orden aprobado

Terminar los bloques funcionales y publicar por cortes verificados. Después,
rediseñar Inicio y las pantallas con KPI prioritarios, navegación compacta y
menos texto. Este corte no cambia la entrada oficial ni retira el panel vigente.

## Implementación de este corte

- `/app/admin/finanzas/delivery`: entregas por último evento real y estado
  actualmente entregado; filtros de fechas, responsable/cliente/orden y tipo de
  servicio; totales sobre la selección completa y páginas de 30 registros.
  Costo guardado en `extra_fields.delivery.cost_usd`, cobertura y faltantes
  explícitos. No usa precio de catálogo actual para reconstruir historia.
- Liquidaciones pendientes con paginación por cursor, de todos los períodos,
  reutilizando `counter_read_pending_settlements`. El contador describe la página,
  nunca aparenta un total global cuando hay más resultados.
- `/app/admin/finanzas/delivery/[settlementId]`: lectura canónica existente,
  desglose en USD/VES, cobro esperado/declarado, efectivo devuelto, cambio enviado
  y pendiente. La custodia declarada cero no se presenta como retorno finalizado.
  Se muestran las últimas 100 entradas, pero los totales usan el ledger completo.
- `/app/admin/tareas`: grupos derivados de cuentas, pedidos activos y comisiones.
  Identidad estable por cuenta/condición u orden/cierre; una orden con varias
  condiciones aparece una vez. Conciliaciones huérfanas son un subconjunto del
  grupo de conciliación, no una segunda suma. Resolución en el origen, sin nuevas
  asignaciones, reglas de vencimiento ni botones genéricos para cerrar pendientes.
  Fallos parciales visibles por fuente. Otros pagos, Delivery e Inventario tienen
  accesos explícitos separados y no se incluyen en esos contadores.
- `/app/admin/reportes`: CSV de todas las cuentas y de todos los pedidos activos,
  usando los mismos lectores protegidos, corte y definición. Exporta el alcance
  descrito en Reportes, no filtros implícitos de otra pantalla. NULL queda vacío,
  moneda nativa/valoración distinguidas y texto protegido contra fórmulas CSV.
  Descarga con autorización Admin propia y `private, no-store`.
- `/app/admin/herramientas`: inventario/catálogo, clientes, eventos, jugadas,
  cuentas/reglas, tasa, usuarios y notificaciones. Las operaciones existentes no
  se duplican. Accesos `adminSection` al panel vigente, con lista permitida y solo
  rol Admin; seleccionan pestaña, nunca otorgan autoridad ni ejecutan mutaciones.

## Base de datos y seguridad

Migración `20260910174926_admin_delivery_overview_v1.sql`, alineada con el historial
remoto. Función nueva `SECURITY INVOKER`, `search_path=''`, validación de sesión y
rol Admin persistido, parámetros acotados, grants explícitos. No se concede acceso
directo a las tablas de liquidación ni se cambia RLS.

La primera prueba de la consulta directa a `delivery_settlements` falló por falta
de permiso y se revirtió. La versión final reutiliza el lector de Mostrador, no
agrega `SECURITY DEFINER` para sortear el permiso.

## Verificación antes de publicación

- 81 pruebas Admin, 77 de comisiones y 6 de seguridad aprobadas: 164 en total.
- Doce pruebas nuevas: fechas/cursor, faltantes, contratos inválidos, alcance,
  monedas, grupos sin duplicación, resolución por fuente, CSV y navegación segura.
- Compilación de producción y comprobación de tipos de aplicación aprobadas.
  `tsc --noEmit` global además incluye tests `.mts` con errores preexistentes de
  tipos de Node/fixtures; no se modificaron ni se ocultaron esos errores.
- Respuesta real de Delivery pasó por el parser TypeScript: 119 entregas del
  1–10 de septiembre, 8 con costo guardado, subtotal USD 4,30; 5 liquidaciones
  abiertas. Son valores al corte de la prueba, no una nueva estimación de costos.
- Admin puede consultar; anónimo y autenticado sin Admin rechazados en prueba
  transaccional. La consulta definitiva fue aplicada y comprobada nuevamente.

## Qué NO está terminado

Actualización financiera del 11 de septiembre: confirmación de reportes en
Master/Ops migrada a un comando atómico con cambio/fondo/redondeo/historial y
protección de reenvíos. Ver `ADMIN_PAYMENT_CONFIRMATION_ATOMIC_2026-09-11.md`.
Esto no cierra todavía el punto 3 completo ni migra nómina y uso del fondo.
Traspasos Master nuevos también tienen comando, reenvío protegido y anulación
completa certificada: `ADMIN_TRANSFER_ATOMIC_2026-09-11.md`.

Actualización del 11 de septiembre: también está implementada la corrección
atómica de entregas antiguas, con historial visible incluido. Ver
`ADMIN_DELIVERY_CORRECTION_2026-09-11.md`. No incluye conciliación ni relleno de
costos históricos, ni cierra todas las rutas de escritura directa.

Actualización posterior del mismo día: los pagos nuevos de comisión ya cuentan
con operación atómica, vínculo y reversión (`ADMIN_COMMISSION_ATOMIC_PAYMENTS_2026-09-10.md`).
Las asignaciones nuevas de Delivery en Master/Ops ya guardan costo y trazabilidad
juntos (`ADMIN_DELIVERY_COST_SNAPSHOT_2026-09-10.md`). Los puntos 1 y 2 siguientes
conservan pendientes sus conciliaciones históricas y los límites descritos allí.

Integración por enlaces no equivale a migración completa ni permite retirar V1.
Continúan pendientes:

1. Vínculo estructural y operación atómica para pagos de comisión; conciliación
   histórica con evidencia. No convertir estados `paid` en pagos ficticios.
2. Costos nuevos de delivery con snapshot completo y tratamiento de la brecha
   histórica. No inferir que cero guardado certifica servicio gratuito.
3. Trasladar escrituras de cuentas/pagos/transferencias, cierres y conciliación
   por comandos canónicos certificados. Siguen funcionando en sus módulos.
4. Cliente 360, equipo y notificaciones como pantallas propias livianas de V2;
   actualmente quedan integradas con el panel vigente.
5. Tareas individuales de todos los dominios, actividad/auditoría unificada,
   asignaciones y políticas de escalamiento aprobadas; exportaciones históricas
   amplias con filtros compartidos.
6. Rediseño común y validación de escritorio/móvil; aclarar diferencias de alcance
   entre KPI Master y Admin antes de homogeneizar nombres.
7. Costeo y rentabilidad requieren método de valoración y fuentes de costos
   aprobados; son una ampliación separada, no parte de la lectura publicada.

No se modificaron importes, comisiones, pagos, cuentas, tasas, usuarios ni historia
operativa. No se cambió la entrada oficial del módulo Administrador.
