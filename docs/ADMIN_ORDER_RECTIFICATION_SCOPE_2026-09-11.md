# Rectificación administrativa de órdenes: alcance y evidencia operativa

Fecha: 2026-09-11. Investigación iniciada a petición del usuario.
Estado: diseño y dependencias revisados; sin cambios funcionales, migraciones
ni operaciones sobre pedidos reales en este bloque.

## Necesidad

Corregir una orden pagada que está en tránsito o entregada sin cancelar y
repetir artificialmente el cobro, la salida de productos y el delivery.
También distinguir entrega física real de un estado Entregada marcado por error.

## Evidencia revisada

- `master/ops/actions.ts` prohíbe editar órdenes entregadas y órdenes que ya
  salieron del local. No basta con habilitar el botón del editor.
- `master/dashboard/actions.ts::updateOrderAction` es un flujo de varias
  escrituras: modifica cliente, restaura/aplica fondo, sustituye partidas y
  escribe la orden. No se debe reutilizar sin cambios para esta rectificación.
- Inventario registra la salida al pasar a En camino o Entregada; su identidad
  de operación deriva del ID de la orden. Crear una segunda orden no hereda
  automáticamente la primera salida física.
- Existe `inventory_reverse_operation_v1`, solo Admin, para revertir una
  operación completa con vínculo a los movimientos originales. No demuestra
  por sí mismo que haya ocurrido una devolución física y no debe ejecutarse
  automáticamente por un cambio de cliente o de datos de contacto.
- Los reportes de delivery usan estado Entregada y eventos de entrega.
  Ya existe una corrección específica de responsable/costo de delivery.
- Los cierres de comisiones conservan fotografías por orden; no se deben
  reescribir silenciosamente al rectificar una operación incluida en un cierre.
- La cancelación financiera recién publicada es otra operación: no sustituye
  este flujo y no se debe usar como atajo automático para corregir datos.

## Diseño recomendado, todavía no implementado

Preferir rectificación sobre el mismo ID, con versiones antes/después y un
comprobante administrativo, cuando sigue siendo la misma venta. Reservar una
orden sustituta vinculada para casos que realmente requieran otra identidad.

Acceso Admin, motivo, resumen de impacto, comprobación de cambios concurrentes,
identidad estable de reintento y una transacción completa. No modificar fechas
ni tasas de los pagos originales; no volver a registrar dinero recibido.

Separar explícitamente:

1. Datos descriptivos: receptor, contacto, dirección y notas; sin efectos
   automáticos sobre partidas, dinero o existencias.
2. Cliente: confirmar a quién pertenece realmente el pago y revisar fondos
   consumidos/guardados y beneficios CRM antes de reasignar.
3. Precio/cantidades: calcular la diferencia comercial y su efecto sobre
   cobranza, saldo a favor y comisiones; conservar la valoración original de
   los pagos y no disponer de un fondo ya gastado.
4. Productos: aclarar si el registro estaba equivocado o hubo una entrega/
   devolución adicional real; solo esta decisión permite establecer el ajuste
   de inventario correcto.
5. Estado/fecha de entrega: distinguir rectificación del registro de una
   nueva operación física; revisar liquidaciones de delivery y cierres afectados.

## Casos aclarados por el usuario y auditoría posterior

El usuario confirmó errores de delivery detectados después de entregar, fechas
incorrectas y casos en que el producto regresa; actualmente cancelan y recrean
para resolverlos. Autorizó revisar canceladas y buscar órdenes similares.

La revisión de solo lectura encontró 79 canceladas, 18 con evento de entrega
anterior a su cancelación y 14 con movimientos de salida de inventario.
El caso 2377 → 2435 está expresamente relacionado en la nota de cancelación.
Otros pares son candidatos, no sustituciones probadas. Ver
`ADMIN_ORDER_RECTIFICATION_AUDIT_2026-09-11.md` para evidencia, límites y casos.

Prioridad funcional:

1. Corregir datos de delivery sobre la misma venta, incluyendo distinguir
   retiro/delivery, servicio cobrado al cliente y responsable/costo del viaje.
   El corrector existente de responsable/costo no cubre los tres conceptos.
2. Separar fecha programada, entrega efectiva y momento de la corrección.
   No recalcular la venta a la tasa del día por corregir estos datos.
3. Registrar retorno físico y su destino, conservando el viaje ocurrido y
   el pago original cuando la venta sigue vigente. No devolver automáticamente
   ingredientes al inventario por recibir un producto preparado.
4. Rectificar partidas/precio por diferencias reales y usar sustitución
   vinculada solo cuando haga falta; no volver a simular cobro y entrega.

## Regla operativa vigente: devolución, venta y avería

La decisión más reciente del usuario exige una operación sencilla: devolver
las unidades al inventario correspondiente a su estado y seguir vendiendo de
forma normal. No crear un circuito operativo separado ni pedir al operador
seleccionar lotes, procedencia o piezas recuperadas en cada venta. Esto sustituye
la propuesta de asignar manualmente destinos/origen y de cobrar aparte al asesor:

1. Registrar la devolución de las piezas que efectivamente regresaron. Si
   regresan 100, ingresan 100 unidades en su estado real: crudas si son crudas,
   producto final si están fritas; prefritas solo si ese es su estado y existe
   una categoría compatible. Piezas sueltas no deben convertirse en paquetes
   cerrados por la devolución. No asumir que todo retorno es producto preparado.
2. Vender mediante órdenes normales. El sistema elige y descuenta de manera
   automática las existencias compatibles; el operador no identifica su origen.
   En el ejemplo aislado, si se venden 75 de las 100, quedan 25 unidades.
3. Al cierre del día, resolver las restantes: si el asesor las compra, crear
   una orden a nombre del asesor por esas piezas; si se descartan, registrar
   una salida por avería. Puede repartirse el sobrante entre ambos destinos.

La venta al asesor es una orden normal con su cobro o saldo pendiente; no un
cargo paralelo por las mismas piezas ni una deducción automática de comisiones.
No se fijó precio especial ni se autorizó registrar compras de asesores reales.
El ejemplo previo de unas 50 piezas es contexto, no una transacción a ejecutar.

Requisitos derivados, todavía no implementados:

- Registrar cantidades por producto realmente recibidas, vinculadas a la orden
  y salida original. No asumir retorno físico al cancelar ni reingresar más
  piezas que las entregadas pendientes de devolución.
- Integrar el retorno en las existencias por producto y estado, en unidades.
  La procedencia y el vínculo a la orden son trazabilidad interna, no una tarea
  adicional del operador. Verificar unidades/conversiones y rutas actuales antes
  de elegir tablas o interfaz; no inventar equivalencias entre paquetes y piezas.
- El consumo automático debe aprovechar el estado compatible sin descontar
  dos veces lo ya consumido: si ya está frito, no volver a consumir crudos o
  ingredientes por esa misma pieza. Si regresa crudo, conservar el flujo normal
  de preparación para su venta frita. No tratar frito y crudo como intercambiables.
- La compra del asesor utiliza el mismo flujo de inventario que cualquier orden.
  No es avería ni exige asignar manualmente piezas a una procedencia especial.
  Conservar reglas de precios y permisos de las órdenes normales.
- La avería consume solo las piezas efectivamente descartadas disponibles, conserva
  motivo y responsable del registro, y no duplica el consumo original ni genera
  automáticamente una deuda al asesor. No afirmar contabilización de costo o
  pérdida duplicada sin revisar el modelo de valoración existente.
- Impedir que las mismas piezas queden simultáneamente disponibles, utilizadas
  en otra venta o descartadas. Conservar fechas, trazabilidad y saldos por producto.
- Integrar el sobrante al cierre habitual sin una conciliación manual separada
  por devolución. No registrar averías, compras al asesor ni cobros de forma
  automática solo porque terminó el día.
- No asignar un vencimiento, condición sanitaria o aptitud de reventa a partir
  de esta conversación. El sistema registra la evaluación de quien corresponda.

«Como si no se hubiese hecho la orden» se interpreta en la disponibilidad de
las piezas retornadas, no como borrar la orden, su historial, pagos o viajes
realizados. Una devolución física registra un reingreso; una mera corrección
de fecha/delivery no crea por sí misma un retorno.

El dinero del cliente original se resuelve por cancelación o continuidad de su
venta, separado del retorno físico y de la nueva compra del asesor. No volver
a registrar un pago original ni transferirlo al asesor por la devolución.
La revisión histórica no autoriza conciliar ni reparar automáticamente pedidos.

## Verificación prevista al implementar

### Comprobaciones previas de integración

Lectura del catálogo vivo y funciones actuales el 2026-09-11:

- Los prefritos existentes usan `servicio` como unidad canónica. Las
  presentaciones `UND sueltas` convierten piezas a fracciones de servicio
  (por ejemplo 1/25 o 1/20); no sumar piezas directamente a ese saldo.
- En la consulta de ítems activos no fusionados no hay ítems del grupo `fried`.
  La restricción de catálogo sí admite el grupo. Integrar producto final exige
  configurar ese estado físico y sus consumos, no usar crudo como sustituto.
- Las rutas alternativas actuales usan `master_fallback`, incluida protección
  de saldos. No equivalen por sí solas al consumo automático de finales que
  solicita el usuario. Los compromisos y el consumo al despacho deben conservar
  las mismas reglas para evitar reservar una cosa y descontar otra.
- Discrepancia que requiere confirmar antes de configurar la familia Bomby:
  producto 197 `BOMBY_1` / `Bomby (und)` apunta en ruta principal y vínculo activo
  al ítem 1 `Mini tequeño crudo`, cantidad 1. Producto 17 `BOMB_F_25` /
  `Bombys Fritos` apunta al ítem 19 `Bombys Crudos`, cantidad 25 por servicio.
  En la orden 2435, la auditoría ya identificó una salida de 43 unidades del
  ítem 1. No se asumió que el vínculo sea intencional ni se cambió el catálogo.
  El usuario confirmó posteriormente que debe descontar Bombys Crudos.
  Corrección prospectiva aplicada el 2026-09-11 a las 20:30:43 UTC, migración
  `20260911203043_correct_bomby_unit_inventory_source.sql`: vínculo y ruta ahora
  apuntan a una unidad de Bombys Crudos. Conserva estado inactivo y precios.
  La orden 2435 y sus movimientos no fueron reparados ni reescritos.

Solo se implementó la corrección puntual del catálogo confirmada por el usuario.
Se probaron resoluciones y consumos reales sintéticos de 1 y 43 unidades bajo
ROLLBACK, conservación del historial y reejecución de la migración sin duplicar
su registro. No quedaron órdenes de prueba. No se creó todavía la función de
devolución ni el consumo automático de producto final.

### Pruebas del flujo completo

Pruebas sintéticas bajo ROLLBACK de identidad, permisos, reintentos, concurrencia
lógica, fallo tardío, conservación de pagos y ausencia de doble consumo/delivery.
Pruebas de regresión de cancelación, pagos, fondos, inventario y comisiones.
Casos adicionales: retorno parcial; uso de recuperados sin doble consumo;
100 devueltas - 75 vendidas - 25 vendidas al asesor = 0; alternativa con 25
averiadas; reparto de 25 entre venta y avería; impedir exceso o doble devolución;
orden del asesor pendiente/pagada sin duplicar cargos ni dinero del cliente.
Retorno crudo conserva estado crudo; frito conserva final; piezas sueltas no
crean paquetes ficticios; venta posterior sin elección manual de origen y sin
doble consumo; mezcla de existencias compatible sin sobregiro ni doble asignación.
Compilación, comprobación del formulario con sesión Admin y publicación por
bloque verificado. Este documento no acredita que esas pruebas o el flujo ya
estén implementados.
