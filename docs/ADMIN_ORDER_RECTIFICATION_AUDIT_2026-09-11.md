# Auditoría de cancelaciones y posibles órdenes sustitutas

Fecha de revisión: 2026-09-11. Zona de lectura de fechas: America/Caracas.
Origen: consultas SELECT al proyecto Supabase de VIVO Ops y código local.
Estado: investigación, no implementación ni reparación histórica.

## Resultado

La práctica descrita por el usuario aparece en los datos: se usa cancelación
para resolver problemas de carga, modalidad de entrega y registro de pagos.
Hay un vínculo explícito de corrección, además de candidatos por similitud.
La cancelación financiera no es por sí sola una devolución física ni una
rectificación comercial. Estos casos son anteriores al bloque de cancelación
atómica publicado el 11 de septiembre; no evalúan su ejecución.

## Cobertura y límites

- 79 órdenes actualmente canceladas, creadas entre el 1 de junio y el 10 de
  septiembre de 2026. La cancelación más reciente consultada ocurrió el 10 de
  septiembre a las 22:01 UTC.
- Las 79 tienen evento `order_cancelled` en `order_timeline_events`. Consultar
  únicamente `order_events.event = 'cancelled'` no recupera ese historial legado.
- 18 tienen evento `delivered` anterior a la cancelación; esto prueba el estado
  registrado, no que el cliente haya recibido físicamente el producto.
- 5 tienen evento `out_for_delivery`; 14 tienen movimientos `sale_out`.
  Los grupos se superponen y no deben sumarse.
- La búsqueda inicial produjo 36 pares para 27 canceladas; 10 de esas canceladas
  habían sido marcadas entregadas. No equivale a 27 sustituciones confirmadas.
- Criterios: mismo cliente; creación de la candidata entre un día antes de la
  creación original y tres días después de su cancelación; mismos productos y
  cantidades agregadas, o referencia explícita al ID candidato en el motivo.
  Se admitieron candidatas canceladas y creadas antes de cancelar la original.
- Se amplió manualmente el caso 533 porque añadir el servicio de delivery cambia
  la firma de productos y queda fuera de la coincidencia exacta.
- No se compararon exhaustivamente componentes personalizados ni se buscaron
  reemplazos en otro cliente o fuera de la ventana. Compras recurrentes y
  registros duplicados también producen similitudes. No hay enlace automático.
- No se modificó ninguna orden, pago, fondo, existencia ni comisión. No se
  consultaron teléfonos ni datos de contacto para establecer coincidencias.

## Casos verificados

| Original / candidata | Evidencia | Consecuencia para el diseño |
| --- | --- | --- |
| 2377 → 2435 | Motivo explícito: `ERROR EN PEDIDO / CORRECCIÓN ORDEN 2435`. Original entregada el 4 de septiembre, sustituta creada y marcada entregada el 7, ambas programadas para el 4. Partidas y total cambiaron: USD 29,67 → 27,53. | La corrección debe conservar la fecha efectiva comprobada y documentar diferencias de productos/precio; no simular una entrega nueva para editar. |
| 2328 / 2335 | Mismo cliente y partidas/cantidades. Motivo: problema al registrar pago mixto de bebida. Ambas marcadas entregadas. La candidata se creó unos cuatro minutos antes de cancelar la original. | Corregir el registro del pago sin repetir la venta. Vínculo probable, no explícito. |
| 533 / 554 | Motivo `cambio a delivery`. Mismo cliente y partida de Cachitas Crudas con cantidad 2; candidata añade Delivery Zona 1 y cambia retiro por delivery. | Modalidad de entrega y servicio cobrado deben poder corregirse de manera controlada. Vínculo probable. |
| 238 / 319 | Mismo cliente, productos y cantidades; original retiro y candidata delivery. Igual total en bolívares: 26.560. Tasa 582,69 → 587,41 y total USD 45,58 → 45,22. Fecha programada 11 de junio en ambas; entrega registrada de candidata el 15. | Recrear puede cambiar valoración y fecha analítica aunque se mantenga la fecha programada. Vínculo probable. |
| 73 / 74 | Mismo cliente, productos, cantidades y USD 38,56. Original retiro, candidata delivery. Cancelación por carga incorrecta. | Otro candidato de corrección de modalidad, no prueba de dos ventas físicas. |
| 361 | Salió en camino el 30 de junio y se canceló después por fecha de entrega pendiente de definir. USD 80,10 confirmados y crédito al fondo por USD 80,10. | Caso de reprogramación después de salir; el retorno físico no está probado por la cancelación. No se identificó una sustituta por la coincidencia inicial. |

IDs de orden internos, no números comerciales. Las fechas de entrega aquí
significan eventos registrados; no se validaron con el cliente ni el repartidor.

## Inventario: hechos y precauciones

- 2377 registra una salida; 2435 registra dos movimientos de salida. No hay
  reversas vinculadas a esos movimientos mediante `reversal_of_movement_id`.
- 2328 y 2335 registran cada una salidas de los mismos tres artículos de
  inventario, cantidades 37, 1 y 1. No hay reversas vinculadas a esas salidas.
- Lo anterior prueba múltiples salidas registradas en los pares, no la pérdida
  neta física: puede haber devoluciones, desperdicio o ajustes manuales sin
  vínculo a la orden. No se deben compensar automáticamente.
- Movimientos antiguos de junio usan `operation_id` nulo y cantidades positivas
  para `sale_out`; los recientes usan operación identificada y deltas negativos.
  No sumar ambos formatos como si fueran el mismo libro ni aplicarles sin
  distinción el reversor moderno.
- El retorno de alimento preparado no implica que vuelvan a existir todos sus
  ingredientes. Revertir la receta completa sin distinguir destino y condición
  puede inflar existencias. Debe registrarse lo realmente recibido y su destino.

## Dinero, delivery y comisiones

- 2328 tiene cobro USD 22,18 y salida de cancelación USD 22,18. En 2335 hay
  cobro USD 22,18 más Bs 2.625, equivalentes a USD 3,25; crédito por excedente
  USD 0,07. Son asientos registrados: no demuestran que se devolviera y recibiera
  físicamente ese efectivo. No debe llamarse doble cobro neto sin conciliarlo.
- En ese par también cambió la tasa: 804,81 → 807,39. La candidata conserva
  `orders.total_usd = 25,35` pero `extra_fields.pricing.total_usd = 25,36`.
  Diferencia histórica de un centavo detectada; no corregida en esta auditoría.
- 238 registra pago Bs 26.560 y devolución Bs 26.558,10; 319 registra pago
  Bs 26.560. Los equivalentes USD del pago original y el nuevo son distintos.
  La rectificación debe conservar moneda, importe, tasa y fecha del cobro real.
- No se encontraron filas en `delivery_settlements` para las once órdenes
  examinadas en detalle. Eso no acredita ausencia de todo costo o pago histórico
  al conductor en otros registros.
- El reporte de delivery obtiene la entrega de `max(order_events.created_at)`
  para el evento `delivered`, no de la fecha programada. Fuente:
  `20260910174926_admin_delivery_overview_v1.sql`.
- Las fotografías de comisiones consultadas incluyen 74, 319 y 554 en estado
  preliminar; 319 figura con fecha 15 de junio. No se halló, para los IDs
  examinados, evidencia de comisión cerrada/pagada dentro de esas fotografías.
  No se debe inferir de esto que ninguna cancelada haya afectado un cierre.

## Decisiones para implementación

1. Mantener la misma orden cuando sigue siendo la misma venta. Auditar antes y
   después, quién, cuándo y motivo; no recalcular a la tasa actual por defecto.
2. Separar modalidad retiro/delivery, cargo al cliente y costo/responsable del
   viaje. El corrector existente de delivery cubre solo parte del problema.
3. Separar fecha programada, entrega efectiva y momento de registrar la
   corrección. Los periodos cerrados requieren ajustes explícitos.
4. Registrar devolución física aparte: cantidades, condición/destino y viaje
   realizado. El pago puede conservarse si la venta continúa.
5. Para una sustitución necesaria, enlazar ambas órdenes y resolver dinero,
   productos y viajes en una operación coherente; no crear un pago ficticio.
6. Revisar candidatos históricos con aprobación individual antes de reparar.
   No modificar retrospectivamente saldos o existencias por similitud.

Decisión posterior vigente del usuario: registrar las piezas que efectivamente
regresan al inventario por unidades y estado real (crudo, final frito o prefrito
cuando corresponda). No todo retorno es producto preparado. Vender mediante
órdenes normales con descuento automático del inventario compatible, sin pedir
al operador seleccionar procedencia ni gestionar un circuito separado.
Al cierre, el sobrante se vende al asesor en una orden normal o sale
por avería. Ejemplo: 100 devueltas, 75 vendidas y 25 vendidas al asesor o averiadas.
Esto sustituye la propuesta anterior de un cargo separado al asesor. No implica
reponer ingredientes ni descontarlos otra vez al revender las mismas piezas.
Los ejemplos aportados no se vincularon automáticamente a pedidos históricos.
Ver la regla completa en `ADMIN_ORDER_RECTIFICATION_SCOPE_2026-09-11.md`.

## Verificación y entregable

Corrección posterior autorizada: el vínculo de `BOMBY_1` a mini tequeño fue
confirmado como incorrecto por el usuario y corregido prospectivamente a una
unidad de Bombys Crudos, migración `20260911203043`. Se conservaron precios y
estado inactivo del producto. No se modificó la salida histórica de la orden
2435 ni se corrigieron saldos pasados. La auditoría precedente describe el
estado observado antes de esta corrección puntual.

Consultas de lectura contra tablas actuales, contraste de eventos, partidas,
movimientos financieros, fondos, inventario y fotografías de comisiones.
No hay cambio funcional ni despliegue en este documento. Las pruebas de
rectificación/devolución siguen pendientes hasta implementar ese bloque.
