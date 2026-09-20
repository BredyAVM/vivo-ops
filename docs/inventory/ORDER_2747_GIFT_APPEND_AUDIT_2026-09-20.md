# Orden 2747: obsequio posterior a preparación

## Evidencia y alcance

- Orden `VO-20260919-7569`, ID 2747. Al auditar: `out_for_delivery`, seis partidas, ninguna del producto 89, `last_modified_at=null`.
- El medio servicio pagado de Dondys (producto 4, cantidad 0.5) es distinto del regalo solicitado.
- Regalo identificado: producto 89, `GAMBIT_DONDY_1`, **Dondy (1 und)**, precio cero, activo, composición fija, `catalog_access_scope=advisor_gift` (discrecional + CRM). Aparecía en diez partidas gratuitas de órdenes creadas el 19/09 (horario Caracas). El cliente de 2747 no tiene candidatos CRM para este producto.
- Cronología 19/09, Caracas: pago confirmado 16:50:42; cocina lista 17:04:25; motorizado asignado 17:11:07; en camino 17:35:07.
- El usuario confirmó que el intento ocurrió estando **lista en cocina, antes de asignar el motorizado**. No atribuir aquel rechazo al estado actual en camino.

## Controles encontrados

1. `MasterOpsOrderEditor.isMasterOpsOrderPricingChanged` considera cualquier nueva partida un cambio de precio, aunque cueste cero. La validación impide ese cambio al Máster si el pago confirmado alcanza el 90%; la preparación del guardado repite el control y puede exigir tasa actual/motivo administrativo.
2. La edición general permite `ready` pero no `out_for_delivery` (tanto la regla operativa como `app_private.update_order_core_atomic_v1`). Este segundo control impide la reparación por la vía general **ahora**, no explica por sí solo el intento original.
3. `public.update_order_core_atomic_v1` delega en la privada V2, que a su vez usa la privada V1. La edición general reconstruye partidas. Abrir sus estados indiscriminadamente pondría en riesgo identidades, evidencia CRM y consumo ya registrado.
4. Los errores arrojados desde Server Actions pueden aparecer redactados en producción. No contamos con el registro de la respuesta fallida original ni el rol exacto de aquella sesión: el rechazo por protección de precio se identifica en código y datos, pero no se presenta como una traza histórica recuperada.

## Corrección acotada

- Nuevo comando `master_append_zero_price_gift_v1`, sin tablas ni columnas nuevas.
- Disponible solo para Máster/Admin autenticados, en órdenes abiertas. No habilita edición general en camino ni reabre entregadas/canceladas.
- Solo agrega obsequios Gambit activos, discrecionales, de precio cero y composición fija. Las jugadas CRM siguen pasando por sus guardas/autovinculación; no se ignoran elegibilidad, reservas ni cobros adicionales.
- Conserva íntegramente las partidas originales, tasa, documentos, pago, descuentos, totales y estado. Los disparadores heredados recalculan subtotales al insertar: el comando restaura el encabezado financiero original dentro de la misma transacción.
- Guarda motivo/actor y avisa en el historial a cocina (acción) y al asesor (seguimiento). Se debe coordinar físicamente el añadido si ya salió el motorizado.
- En cocina/lista: reserva según los disparadores habituales; aún no registra salida física.
- En camino con salida previa: resuelve fuentes y descuenta **solo la nueva partida**, incluso si existe otro Dondy pagado. Cierra compromisos regenerados por el disparador. Si la salida original no existe, reintenta el consumo canónico completo.
- Inventario negativo permitido. Si la conciliación falla, conserva el obsequio y registra alerta de revisión; no bloquea la operación.
- Bloqueo de fila, control de versión e idempotencia impiden guardados repetidos o desde una pantalla desactualizada.
- Los rechazos esperados del nuevo comando se devuelven como mensajes legibles.

## Ruta de uso

- Orden lista/en cocina: **Modificar orden → Agregar obsequio sin cambiar el pago**. Usar al abrir, antes de editar otros campos.
- Orden en camino: **Agregar obsequio** en el detalle. No ofrece edición del resto de la orden.
- Seleccionar **Dondy (1 und)**, cantidad `1`, motivo; pulsar **Agregar solo este obsequio**.
- Los Gambits de composición seleccionable y beneficios con cobro siguen usando el editor/configuración CRM normal: esta incorporación acotada no sustituye ese flujo.

## Verificación

- `node tests/master-ops/gift-append-db.mjs`: 12 casos en Postgres aislado, incluidos `ready`, `in_kitchen`, en camino, pago protegido, preservación de partidas/totales, solo 1 UND adicional, negativos, idempotencia, roles, cantidades, catálogo inválido, estados cerrados y fallo de inventario no bloqueante.
- Prueba transaccional contra los disparadores reales de 2747: agregado correcto, encabezado intacto excepto sello de modificación, seis partidas originales intactas, exactamente un movimiento adicional de -1 UND Dondy, reintento idempotente. **ROLLBACK de toda la prueba**.
- Comprobación posterior: orden 2747 aún en camino, seis partidas, cero regalos 89, seis movimientos originales, `last_modified_at=null`. No se reparó ni se entregó la orden automáticamente.
- Compilación de producción y revisión de permisos del comando. La primera compilación limitada falló únicamente al descargar Google Fonts; repetida con acceso de red.
- La revisión automática de seguridad no señala la función nueva; existen avisos anteriores del proyecto fuera del alcance de esta reparación.
