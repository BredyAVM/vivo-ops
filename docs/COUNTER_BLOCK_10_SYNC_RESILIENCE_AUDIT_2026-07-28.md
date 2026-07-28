# Auditoría del Bloque 10 de Counter

Fecha: 2026-07-28

Alcance: sincronización, alertas y resiliencia de `/app/counter`.

## Resultado

El bloque queda implementado sin tablas, índices, RPC ni migraciones nuevas.
Counter reutiliza el canal canónico existente
`order_timeline_event_recipients`, ya publicado en Supabase Realtime, como una
señal ligera para pedidos listos. La verdad exacta sigue entrando por las
acciones de lectura protegidas del módulo.

No se modificó `/app/master/dashboard`.

## Evidencia previa de Supabase

La inspección de producción confirmó:

- `order_timeline_event_recipients` ya pertenece a la publicación
  `supabase_realtime`;
- el rol `authenticated` tiene permiso de lectura y existe una política RLS de
  selección;
- durante los 30 días auditados existían 311 señales con
  `target_role = 'counter'`;
- las señales reales de Counter corresponden a `order_ready` y
  `pickup_ready`.

Por eso no se publicaron `orders`, `payment_reports`, `money_movements` ni
tablas de liquidación. Publicarlas habría ampliado replicación y superficie de
datos sin necesidad.

## Estrategia por recurso

| Recurso | Disparador | Lectura exacta | Frecuencia de reparación |
| --- | --- | --- | --- |
| Cola activa | Realtime de evento dirigido a Counter, push, actualización manual o regreso a la pestaña | `refreshCounterQueueAction` | 5 minutos con Realtime sano; 60 segundos en fallback |
| Detalle abierto y pagos | Apertura, acción local, aviso de cambio o verificación mientras permanece seleccionado | `loadCounterOrderDetailAction` | 2 minutos, solo para la orden abierta |
| Caja y puntos | Apertura, acción monetaria, actualización manual o verificación con panel abierto | `loadCounterCashSnapshotAction` | 2 minutos, solo con Caja abierta |
| Liquidaciones | Apertura, retorno, actualización manual o señal de verificación con panel abierto | lecturas paginadas de liquidación existentes | 2 minutos, solo con Liquidaciones abierto |
| Históricos | Solicitud explícita del operador | búsqueda y expediente existentes | nunca se refresca automáticamente |
| Catálogo y reglas | Apertura de venta o modificación | lectura de catálogo existente | conserva caché corto y validación final en servidor |

El temporizador de 15 segundos solo revisa si algún recurso alcanzó su
vencimiento. No ejecuta una consulta en cada tick.

## Presupuesto de invocaciones

Antes del bloque:

- la cola ejecutaba un refresco cada 30 segundos mientras la pestaña estaba
  visible;
- eso equivalía a hasta 120 invocaciones por hora aun sin eventos;
- el retorno a la pestaña añadía otra invocación.

Después del bloque:

- con Realtime sano, la cola en reposo tiene un máximo teórico de 12
  reparaciones por hora;
- cada señal de pedido listo se agrupa durante 250 ms y dispara una sola lectura
  de cola;
- en fallback la cola usa como máximo 60 reparaciones por hora;
- detalle, caja y liquidaciones tienen como máximo 30 verificaciones por hora
  cada uno, pero únicamente mientras ese recurso está abierto;
- caja, liquidaciones e histórico generan cero refrescos automáticos cuando
  están cerrados.

Las promesas en vuelo de cola, detalle por orden, caja y primera página de
liquidaciones se reutilizan. Un tick, un push y un evento simultáneos no
multiplican la misma lectura.

## Frescura y protección contra carreras

- La cabecera distingue `En vivo`, `Conectando`, `Respaldo ligero` y
  `Sin conexión`.
- Si cambia el resumen de la orden abierta, el detalle muestra un aviso y
  permite consultar de nuevo la verdad del servidor.
- Cola y detalle reciben una secuencia local de lectura. Una respuesta iniciada
  antes no puede sobrescribir silenciosamente un detalle o estado optimista
  iniciado después.
- Una orden retirada conserva un marcador local para que una respuesta vieja de
  cola no la vuelva a insertar.
- El regreso a una pestaña procesa una señal pendiente sin consultar mientras
  la pestaña permanece oculta.
- Al desmontar Counter se elimina el canal Realtime y sus listeners.

## Alertas sin duplicados

- Un cambio real hacia `ready` produce mensaje y sonido en primer plano.
- Los pedidos que ya estaban listos al abrir la pantalla no vuelven a sonar.
- Push y Realtime comparten deduplicación por orden; si ambos notifican el mismo
  pedido se oye una sola alerta.
- Las señales Realtime también se deduplican por identificador.
- En segundo plano se deja la alerta al sistema operativo y no se reproduce
  audio adicional en la pestaña oculta.

## Reintentos idempotentes

Las RPC ya protegían los comandos con recibos idempotentes. Este bloque completa
el contrato en la interfaz:

- retiro pickup conserva la misma clave hasta recibir éxito;
- corrección de fecha y modificación de productos conservan la clave mientras
  el payload sea idéntico;
- movimiento manual y cierre de caja conservan formulario y clave cuando falla
  o queda incierta la respuesta;
- si el operador cambia el payload se genera una identidad nueva;
- pagos, devoluciones, salida de delivery, retorno y venta directa mantienen sus
  mecanismos idempotentes existentes.

Así un reintento de la misma intención no duplica dinero, entrega ni estado.

## Métricas operativas

El botón de estado abre una vista compacta, no financiera, con:

- invocaciones por cola, detalle, caja y liquidaciones;
- errores por recurso;
- duración promedio;
- última señal Realtime de la sesión.

Las métricas viven en la sesión del navegador y no agregan escrituras ni una
tabla de telemetría.

## Archivos

- `src/app/app/counter/CounterClient.tsx`
- `src/app/app/counter/CounterDeliveryWorkspace.tsx`
- `docs/COUNTER_BLOCK_10_SYNC_RESILIENCE_AUDIT_2026-07-28.md`
- `docs/COUNTER_IMPLEMENTATION_ROADMAP_2026-07-24.md`
- `docs/HANDOFF_COUNTER_2026-07-22.md`

## Validaciones

- inspección de publicación, permisos, política y señales reales en Supabase;
- lint focalizado;
- TypeScript sin emisión;
- build de producción;
- revisión de alcance: cero cambios en `/app/master/dashboard`;
- revisión de migraciones: ninguna requerida.

El lint completo del repositorio continúa reportando deuda previa fuera de
Counter (principalmente `no-explicit-any` y efectos en Advisor/Master). No se
alteraron esos módulos; los dos archivos TSX de este bloque pasan el lint
focalizado.

## Siguiente bloque

Bloque 11: experiencia operativa y acabado visual, sin agregar consultas por
estética y sin alterar el contrato funcional estabilizado.
