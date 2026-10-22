# Notificación de pedidos nuevos de Asesor a Máster

Fecha: 2026-10-22.

## Causa verificada

La creación atómica conservaba `order_created`, pero no sus destinatarios ni la
llamada push. El compositor ya no utilizaba el escritor antiguo, que además
terminaba al encontrar ese evento. En tres días de producción se revisaron 58
eventos nuevos de origen Asesor sin destinatarios, frente a 38 modificaciones
con destinatarios correctos. No era necesario reescribir el módulo receptor.

## Contrato vigente

- Se conserva `advisor_create_order_atomic_v1`, con la sesión/RLS original,
  partidas, precios, borradores, reservas CRM/premios e idempotencia intactos.
- Al insertar el evento canónico `order_created` de una orden cuyo creador y
  asesor atribuido coinciden, un trigger `SECURITY INVOKER` inserta los
  destinatarios Máster/Admin (acción) y Asesor atribuido (seguimiento) en la misma
  transacción. No crea otro evento, notificación legado, tabla ni columna.
- La acción autenticada programa el transporte con `after`, solo después de
  confirmar el resultado de la creación. El ciclo de vida de Next/Vercel espera
  esa tarea; no hay promesas abandonadas ni temporizadores del navegador.
- Tanto el punto de entrada actual como el de compatibilidad usan una única
  reserva durable en `order_timeline_events.payload.master_created_push`.
  Un bloqueo por orden/evento permite un solo ganador entre llamadas simultáneas
  y reintentos, incluso si regresan por el punto de entrada antiguo.
- Las RPC de reserva y resultado son `SECURITY INVOKER` y ejecutables solo por
  `service_role`. La acción identifica al asesor desde la sesión real; la RPC
  verifica origen, creador/atribución, partidas y evento. No se amplían permisos
  de `anon`/`authenticated`, no se modifica RLS y no se expone la clave al cliente.
- La alerta usa `sendPushToRoleDevices` y el enrutador de suscripciones existentes.
  Abre `/app/master/ops?openOrder=<id>&tab=pedido`; las suscripciones de Admin
  conservan su adaptación nativa. El número corto se presenta con el helper
  compartido. No se cambia ninguna pantalla de `/app/master/dashboard`.
- Un fallo push no invalida ni vuelve a crear la orden. Se registra un resultado
  `sent`, `partial`, `failed`, `skipped` o `uncertain`, con contadores y fechas.
  `sent` acredita aceptación del proveedor push, no lectura humana del aviso.
  No se guardan endpoints, claves, cuerpos de error ni datos personales en ese
  comprobante. Los logs `advisor_created_push` permiten revisar el resultado.

## Límite explícito de entrega y duplicados

La reserva se persiste **antes** del envío externo. Si se pierde una respuesta,
el proceso se interrumpe o solo algunos dispositivos aceptan el aviso, no se
repite la difusión automáticamente: hacerlo podría duplicar avisos ya entregados.
Los casos `claimed` sin cierre o `uncertain` requieren diagnóstico; no deben
liberarse por tiempo ni tratarse como prueba de que nadie recibió el aviso.
Esto evita duplicados de aplicación; no promete entrega exactamente una vez de
un transporte externo. El pedido y sus destinatarios internos permanecen guardados
aunque falle el transporte. La visualización/sonido también requiere que el
dispositivo tenga una suscripción activa y permisos del navegador.

Solo son elegibles órdenes `created`, completas y creadas en los últimos 15
minutos. Una orden ya aprobada o histórica no produce un nuevo aviso por reabrirla
o repetir una solicitud. No hay polling, cron, backfill ni difusión masiva de
pedidos anteriores. El punto de compatibilidad puede completar el evento o sus
destinatarios si faltan en una creación reciente; no restablece estados leídos.

## Verificación

- `npm run test:master-new-order-alerts`: transporte con dependencias simuladas y
  PostgreSQL aislado ejecutando el escritor atómico instalado más esta migración.
- Cubre roles, destinatarios, rollback por partida inválida, reintentos con claves
  distintas, reserva única, cierre con token, pérdida de respuesta, envío parcial,
  ausencia de suscripción, orden antigua/aprobada/vacía y compatibilidad.
- `npm run test:orders-workspace`: regresiones del espacio compartido y creación.
- No se crean pedidos de prueba ni se envían avisos de prueba a producción.

Migración aplicada: `20261022202057_advisor_created_master_notifications.sql`.
La definición del escritor atómico de producción conservó su checksum
`652f0b694fee346bae1d53ca4c477209`. RLS continuó habilitado y las dos RPC nuevas
rechazan `anon`/`authenticated`; solo `service_role` puede ejecutarlas. El análisis
de seguridad no añadió hallazgos frente a la línea base (380 existentes).

Validación local: 19 comprobaciones específicas, 32 de `orders-workspace`, 26 de
PWA/enrutamiento y compilación de producción correctas. La recepción visible en
el dispositivo de cada operador se valida con el siguiente pedido real, sin crear
órdenes ficticias ni disparar avisos retroactivos.
