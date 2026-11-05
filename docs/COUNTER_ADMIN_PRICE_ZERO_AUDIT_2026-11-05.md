# Ajustes administrativos de precio en órdenes de Counter

Fecha: 5 de noviembre de 2026. Caso revisado: orden **36-37**.

## Hallazgo y causa

Las tres líneas tenían `admin_price_override_usd = 0`, con aprobador y motivo guardados, pero mantenían USD 14,00 + 3,00 + 2,50 en sus precios de origen e importes. El total persistido y la cobranza seguían mostrando USD 19,50.

La orden nació como venta rápida de Counter. Al reconstruirla, `trg_order_items_set_pricing` entraba en la rama de Counter y volvía al catálogo antes de alcanzar el ajuste administrativo. Esa rama también excluía los ajustes autorizados de las rutas USD y VES. En un reintento, el editor comparaba solamente el equivalente USD y el motivo: el cero ya guardado hacía que ignorase un cambio del precio nativo de 14 a 0.

## Corrección general

La migración `20261105120129_counter_admin_price_override_v1.sql` conserva el precio de catálogo para ventas ordinarias de Counter. Una aprobación administrativa explícita pasa por las validaciones existentes de administrador, importe y motivo, tanto en USD como en VES. No cambia permisos, reglas CRM, premios ni el configurador Muérdeme.

`approvedPriceTermsChanged` incorpora moneda e importe nativo a la comparación cuando existe aprobación administrativa. Reintroducir cero sobre un registro inconsistente deja de considerarse «sin cambios». La conservación de precios históricos continúa para líneas sin cambios reales.

## Corrección puntual de la 36-37

Se aplicó el procedimiento de [reparación de la orden](../tools/orders/repair-3637-counter-zero-prices.sql), con comprobación de versión, bloqueo de la orden y sus líneas, verificación de aprobador activo y validación de los tres ajustes cero existentes. Primero se ejecutó con reversión; después se confirmó.

Resultado verificado en la consulta financiera: total USD 0,00, equivalente Bs 0,00 y pendiente USD 0,00. Se conservaron los IDs de las líneas, productos, cantidades, notas, evidencia original, estado «Lista», retiro pickup y tasa 888,90. No había pagos registrados; no se generaron pagos, movimientos de dinero, fondo de cliente ni movimientos físicos de inventario. Quedó una entrada de auditoría con los importes anteriores y el motivo. No se ejecuta ninguna reparación general sobre otras órdenes ni sobre comisiones pagadas.

## Verificación

- 70 pruebas: reproducción del fallo con los tres ceros, USD/VES, fracciones, repetición, precios ordinarios de Counter, permisos, ajustes entregados y conservación histórica.
- 100 pruebas de comisiones.
- Compilación de producción completada. La revisión estática conserva los mismos nueve errores y dos advertencias anteriores del archivo grande de operaciones; el helper añadido no incorpora incidencias.
- Avisos de seguridad de Supabase comparados antes y después: idénticos.
