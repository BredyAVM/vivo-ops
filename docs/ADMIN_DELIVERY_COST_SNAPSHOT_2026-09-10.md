# Delivery: asignaciones y costo guardado — 10 de septiembre de 2026

## Corte implementado

- Master Dashboard y Master Ops asignan repartidor y costo en una sola llamada
  `assign_delivery_with_cost_v1`. La transacción bloquea la orden, conserva sus
  otros metadatos y revierte asignación, costo y eventos si falla cualquier paso.
- Snapshot versión 1: importe USD a centavos, origen del dato de entrada,
  tipo de servicio, repartidor/partner, referencia, distancia externa, fecha y
  usuario autenticado. Se guarda también en `order_events`, con el costo previo.
- No se modifica la tarifa de negocio: Dashboard sigue proponiendo el pago
  interno configurado en la línea/producto al asignar; Ops mantiene su entrada
  manual. Se captura esa entrada, no se certifica una factura ni un pago.
- Reasignar o quitar repartidor invalida el costo/snapshot anterior, incluso
  mediante las tres funciones antiguas. Sus firmas siguen disponibles para
  clientes vigentes; conservan los permisos funcionales de Master/Admin.
- Campo vacío permanece desconocido; cero escrito se conserva. Los formularios
  externos mantienen su requisito previo de costo y distancia. Se rechazan
  importes negativos, no finitos o fuera de rango, sin convertirlos a cero.
- Admin distingue registro nuevo, anterior y corrección administrativa. Master
  deja de recalcular costos de lectura con el catálogo vigente; muestra faltantes
  y advierte que sus sumas son subtotales de costos guardados, no pagos/saldos.
- La corrección administrativa existente invalida el snapshot anterior y lo
  incorpora al evento previo. Su migración a una operación atómica queda pendiente.

## Seguridad y verificación

Migración remota/local `20260911021217_delivery_assignment_cost_snapshot_v1.sql`.
Cuatro funciones `SECURITY INVOKER`, `search_path=''`, autorización persistida
Master/Admin y sesión obligatoria, sin ejecución anónima. No se amplía RLS ni
se crean nuevas tablas expuestas. Los eventos usan la política vigente, no un
nuevo archivo de auditoría inmutable.

- 86 pruebas Admin, 79 de comisiones y 6 de seguridad: 171 aprobadas.
- Compilación de producción y tipos de aplicación aprobados. No se afirma que
  el `tsc` global de fixtures preexistentes esté limpio.
- `tests/admin/delivery-cost.rollback.sql`: orden sintética, preservación de
  metadatos, costo desconocido/cero, reasignación legacy, limpieza, historia,
  rechazo de negativos/NaN y de reasignación de una entrega finalizada.
- Fallo inyectado al insertar el evento final: revierte asignación, importe y
  eventos. Admin y Master autorizados; asesor y anónimo rechazados.
- Todo el ensayo terminó en ROLLBACK. No persisten orden ni función de prueba.
- Asesor de seguridad: ninguna advertencia sobre las cuatro funciones de este
  corte. Persisten advertencias anteriores del proyecto; no se certifica todo
  el sistema como libre de vulnerabilidades.
- Se usa bloqueo por orden; no se hizo ensayo de dos sesiones independientes.

## Límites y próximos cortes

1. No se rellenaron costos históricos, ni se modificaron pedidos reales, pagos,
   cuentas, comisiones, tarifas o liquidaciones de custodia.
2. La pantalla antigua `/orders/[id]` aún administra `delivery_trips` por su flujo
   previo y no genera este snapshot de costo. Su llamada legacy ahora invalida
   costos anteriores para no atribuirlos a otro repartidor.
3. No hay deduplicación por identificador de solicitud: repetir una asignación
   genera otro evento, no otro pago. No se certifica idempotencia de pagos aquí.
4. Falta migrar la corrección histórica al comando canónico, reconciliar historia
   con evidencia y completar el diseño visual/unificación de etiquetas V1/V2.
5. Costos guardados no equivalen a cuentas por pagar, dinero cobrado al cliente,
   efectivo bajo custodia ni rentabilidad certificada.

Guías utilizadas: Supabase y Postgres (transacciones, permisos), Next.js/React
(frontera de acciones y formularios), Vercel (publicación) y Browser (verificación).
Documentación de funciones: https://supabase.com/docs/guides/database/functions
