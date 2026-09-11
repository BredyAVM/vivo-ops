# Correcciones de Delivery — 11 de septiembre de 2026

## Implementado

El formulario vigente de corrección de entregas en Master Dashboard/Master Ops
usa `correct_delivered_delivery_v1`. No cambia el formulario ni agrega pasos.
Se mantiene exclusivamente para Admin y pedidos delivery ya entregados.

La función ejecuta en una transacción: bloqueo de la orden, lectura del valor
previo, cambio de repartidor/costo, snapshot con actor/fecha/motivo, evento de
orden y evento del historial visible. Si falla el último evento se revierte todo.
Preserva los otros metadatos, estado entregado, total de venta y fecha de entrega.

- Interno limpia datos externos/distancia; externo conserva nombre/teléfono del
  partner seleccionado como en el flujo anterior. Se permiten partners históricos
  inactivos: no se inventa una nueva restricción para corregir historia.
- Un costo desconocido sigue siendo NULL; cero ingresado sigue siendo cero.
- Motivo de 6–500 caracteres, incluidos controles contra solo espacios/saltos.
- El snapshot anterior queda en el historial junto al nuevo. No se reconstruyen
  costos automáticamente con precios actuales.
- La acción utiliza la sesión normal, no la clave de servicio. La base de datos
  comprueba el rol Admin persistido y conserva RLS (`SECURITY INVOKER`, ruta de
  búsqueda vacía, sin ejecución anónima ni por service_role).
- El envío de notificaciones reutiliza el ID del evento ya guardado y no duplica
  su entrada visible. Los avisos siguen siendo best effort; una falla del aviso
  no implica que la corrección haya fallado.

Migración: `20260911135611_delivery_correction_atomic_v1.sql`.

## Verificación

- 89 pruebas Admin, 79 de comisiones, 6 de seguridad: 174 aprobadas.
- Compilación de producción y tipos de aplicación aprobados.
- Pruebas SQL transaccionales con orden sintética: falla tardía y rollback de
  orden/ambos eventos; antes/después; fecha/actor; preservación de otros campos;
  NULL/cero; cambio interno/externo; motivo/distancia/importe/modo inválidos;
  estado no entregado; rechazo de todas las identidades no Admin existentes,
  incluidos Master, asesor, cocina, mostrador y driver; sesión vacía y anónimo.
- No persiste ninguna orden ni función de prueba. No se probaron correcciones
  reales desde el navegador ni dos sesiones concurrentes independientes.
- Asesor de seguridad sin advertencias sobre la función nueva. No se considera
  resuelta la totalidad de advertencias preexistentes del proyecto.

## Límites y próximos bloques

Este corte sustituye la corrección anterior no atómica. No modifica por sí solo
ningún pedido real, pago, saldo, comisión, tarifa o liquidación de custodia.
La conciliación de costos históricos con evidencia sigue pendiente.

No es un cierre universal de escrituras directas: otras rutas con permisos sobre
`orders` y las políticas existentes de eventos requieren su propia migración.
El historial usa las tablas existentes, no un nuevo registro inmutable certificado.
El bloqueo serializa escrituras y conserva el antes real; no hay control optimista
de formulario desactualizado ni deduplicación por ID de solicitud. Repetir una
corrección genera otro evento, no un pago.

Continúan pendientes comandos canónicos de cuentas/pagos/transferencias/cierres,
Cliente 360/equipo/notificaciones propios de V2, cobertura total de tareas/reportes
y rediseño visual. No se retira la entrada administrativa anterior.

Guías aplicadas: Supabase/Postgres para atomicidad y permisos; Next.js para la
acción autenticada y notificaciones; Vercel para publicación/verificación.
