# Incorporación puntual de bebida en camino — 2026-10-08

## Alcance

Máster y Administración pueden registrar una bebida activa de catálogo que ya
acompaña físicamente una orden delivery `out_for_delivery`. Se añade una partida
nueva; no se habilita el editor general después del despacho ni se reabre una
orden entregada/cancelada. Asesor y Counter no reciben este permiso.

La operación admite solo `products.type = product`, familia `beverages`, precio
normal positivo y composición fija. No admite jugadas, beneficios CRM, productos
administrativos, descuentos/precios manuales ni cambios de productos anteriores.
El flujo independiente de obsequios de precio cero se conserva sin alteraciones.

## Cobro en la misma orden

- La bebida se cobra con el resto del pedido, usando el catálogo vigente en el
  servidor y la tasa snapshot de la orden. No se crea otra orden ni otro pago.
- VES conserva su monto comercial nativo exacto. El equivalente USD se deriva
  de la línea completa antes de redondear; no se reconstruye VES desde USD.
- Las partidas anteriores conservan identidad, cantidades, precios y aprobaciones.
- Se conservan los porcentajes existentes de descuento/impuesto y se actualizan
  sus importes y los totales por moneda. No se renegocian esas condiciones.
- Reportes, movimientos confirmados, fondo, costo de delivery y liquidaciones
  existentes no se reescriben. El nuevo pendiente se consulta mediante el estado
  financiero canónico; el formulario no lo calcula ni declara un pago nuevo.
- Un snapshot incompleto/inconsistente exige conciliación y no se repara
  silenciosamente. Si existe una liquidación con entradas de custodia de efectivo,
  esa ampliación exige conciliar dicho eje y el comando la rechaza, sin cambios.
  No se inventa otra moneda/plan de cobranza ni dinero recibido por el motorizado.

## Inventario

Los triggers canónicos siguen activos al insertar la partida. Los compromisos
regenerados se cierran como `fulfilled`, porque la botella ya salió. El resolver
canónico atribuye el consumo a `order_item_id` de la partida nueva; exclusivamente
esas cantidades generan `sale_out` mediante `inventory_apply_delta_v1`.

No se repite el consumo de las partidas anteriores, ni siquiera si su despacho
anterior tiene incidencias. Un faltante permite saldo negativo. Una ruta ausente,
conteo no inicializado o falla genera incidencia crítica `beverage_append`; no
borra la venta ni bloquea la incorporación real. Los movimientos físicos parciales
del intento fallido se revierten juntos. La pantalla muestra que el cobro se
guardó y el inventario necesita revisión; no debe agregarse otra vez la bebida.

La entrega final mantiene la idempotencia del despacho original. No produce
otra salida para las partidas ya consumidas. Una incidencia de la incorporación
requiere conciliación por la nueva partida, sin reproducir el despacho completo.

## Auditoría y concurrencia

`master_append_dispatched_beverage_v1` mantiene un bloqueo por operación y orden,
verifica `last_modified_at`, exige sesión y rol Máster/Admin en el servidor y
guarda motivo, actor, fecha, partida nueva y totales anteriores/nuevos en
`order_dispatched_beverage_appended`. Cocina/Counter y el asesor/motorizado interno
reciben contexto para revisar. El texto interno no se añade a las notas para
WhatsApp del cliente.

Un reintento con la misma clave devuelve el comprobante, incluso si la orden
avanzó desde entonces. Reutilizar la clave para otra orden/producto/cantidad/motivo
se rechaza. No hay reintentos de escritura automáticos ni tablas/columnas nuevas.
La RPC pública es `SECURITY INVOKER`; la implementación privada tiene autorización
explícita, `search_path` vacío y acceso revocado para `PUBLIC` y `anon`.

## Interfaz y verificación

El acceso `Agregar bebida / obsequio` abre el editor existente bajo demanda.
Para una orden en camino solo ofrece las incorporaciones puntuales: el editor
general sigue oculto y bloqueado. La bebida requiere confirmar su inclusión
física, cantidad y motivo. La opción vive en Máster Ops/espacio compartido de
órdenes; no se editan pantallas de `/app/master/dashboard`.

Migración aplicada: `20261008221501_master_append_paid_beverage.sql`.
Pruebas aisladas: `tests/master-ops/beverage-append-db.mjs` (18 comprobaciones con
guards reales de precio), más regresiones de obsequios y edición previa al corte.

Caso 3166 ejecutado y verificado en producción el 2026-10-08, a las 18:20 de
Caracas, mediante sesión autenticada y acción autorizada en Máster Ops:

- Se incorporó una Lipton Limón 1,5 Lts de catálogo, Bs 5.175; partida `14374`.
- Total anterior Bs 26.450 / USD 30,24; nuevo Bs 31.625 / USD 36,16, sin
  descuento/impuesto. El estado permaneció `out_for_delivery`.
- Las tres partidas originales permanecieron idénticas (checksum previo/posterior
  `4f5d3ae2ff2d3b21df2f0ece82a607d7`). No se añadieron ni alteraron reportes o
  movimientos de pago. La liquidación `798`, sin entradas de custodia, se conservó.
- Inventario registró exclusivamente `sale_out` de una botella, movimiento
  `14845`, artículo físico `35`. Las dos salidas del despacho original no se
  repitieron; resultado `inventory_status = applied`.
- Evento de auditoría `30825`, con motivo, actor, totales y destinatarios de
  Cocina, Counter, asesor y motorizado. Operación idempotente
  `083f81a2-46bc-4363-aad0-5f279bf74983`.
- El detalle visible confirmó la partida nueva y el total. El pendiente USD
  mostrado por el estado financiero canónico fue USD 36,15: conserva su cálculo
  preciso propio, distinto del total USD redondeado por partidas. No se forzó
  una igualdad artificial ni se modificó ese eje financiero compartido.
