# Bloque 2: cuentas, caja y conciliación

## Recorrido publicado

- Cuentas → cuenta → Conciliación → Resolver/Ver detalle. Se conserva el filtro de cuenta y las fechas existentes.
- Tres caminos distintos: vincular un movimiento confirmado registrado tarde; registrar ingreso/egreso/comisión/ajuste faltante; explicar sin movimiento.
- Un cobro de cliente se registra en su orden y luego se vincula. Un traspaso se registra como traspaso y luego se vincula. Nunca se simulan con ingresos libres.
- Se puede resolver una parte. El resto conserva su cuenta, moneda y origen (cierre/línea base), incluso si queda un centavo. No se aplica a diferencias bancarias la tolerancia subcentavo de cobranza USD.
- Se muestra la fecha/hora del saldo observado. El administrador confirma con evidencia que el importe ya estaba en ese saldo. La coincidencia de fecha o referencia no constituye prueba automática.
- Cuentas → Cierres → Ver cierre: foto original, diferencias relacionadas, motivo y anulación protegida. Dependencias posteriores y conciliaciones resueltas impiden anular sin revisarlas primero.
- Ingreso/egreso de Administración: registro atómico del principal y comisión, comprobante por identidad y enlace desde el historial. No cambia el límite ni los permisos de Master Ops.
- La configuración de cuentas, reglas y líneas base conserva su centro existente, con acceso explícito desde Configuración. No se crea otra configuración paralela ni se retira el panel antiguo.

## Integridad y temporalidad

`account_reconciliation_resolutions` guarda entrada, actor, hora, estado original, evidencia de movimiento, resto y resultado. Una resolución y sus efectos se confirman juntos. La ruta antigua ya no hace tres escrituras independientes ni intenta insertar el `source_kind` inexistente `reconciliation_residual`.

Las resoluciones monetarias son Admin. Master conserva la explicación sin movimiento; la interfaz antigua deriva los movimientos/compensaciones al recorrido nuevo. RLS, permisos explícitos y funciones privilegiadas privadas mantienen la autorización en la base.

Al vincular dinero existente se bloquea el movimiento, se comprueba cuenta/moneda/signo/fecha/confirmación posterior al corte, versión exacta y cantidad aún no conciliada. Una asignación no puede cubrir más que el movimiento ni más que la diferencia. El importe probado como incluido en el ancla se excluye del incremento posterior de la posición y de la vista previa del cierre. No se altera el ledger, la fecha bancaria, el cobro del pedido ni la fotografía histórica.

Deshacer una resolución conserva el movimiento existente; solo anula uno generado por la propia resolución. Reabre la partida original y anula el resto generado. Si ese resto ya fue resuelto, se exige deshacer primero la resolución descendiente. Un movimiento conciliado no se puede modificar o anular por otra ruta sin liberar antes la evidencia.

`account_cash_operations` certifica ingresos/egresos administrativos por UUID + actor + entrada exacta, incluyendo el principal y comisión. Repetir el envío devuelve el comprobante, incluso si después el movimiento fue anulado; no crea dinero otra vez.

## Recuperación

Los formularios administrativos de movimiento, conciliación, cierre y transferencia guardan el envío antes de transmitirlo en `sessionStorage`, con versión, usuario y tipo de operación. No guardan credenciales ni documentos bancarios. Al recargar la misma pestaña se comprueba el envío original; los errores de resultado incierto nunca habilitan una nueva identidad automáticamente.

La recuperación cubre recarga y navegación dentro de la misma pestaña/sesión de navegador. No certifica recuperación tras borrar almacenamiento, cerrar definitivamente la sesión del navegador o usar otro dispositivo. Las identidades ya recibidas por el servidor permanecen protegidas por sus comprobantes. El almacenamiento indisponible bloquea un nuevo envío antes de transmitirlo.

## Verificación

- `test:accounts-operations`: validación de centavos, identidad, recibos, errores inciertos, autorización, recuperación aislada por usuario y recorridos existentes.
- `account-reconciliation.rollback.sql`: datos sintéticos revertidos; parcial, exacto, VES, fee, resto de 0,01, reversión dependiente, movimiento existente conservado, foto intacta, reenvíos, permisos y fallo inyectado al final sin escrituras parciales.
- Regresiones SQL revertidas: cierres, corte observado, traspasos, deducibles de delivery y precisión de cobranza.
- Regresiones de aplicación: Admin, seguridad y delivery; TypeScript de aplicación, lint del alcance y build de producción.
- Revisión visual sin guardar ingresos, egresos, cierres o resoluciones reales.

Migración aplicada: `20260915150105_account_reconciliation_operations_v1.sql`. Pruebas de aplicación: 119 Admin + 35 operaciones de cuentas, además de seguridad y delivery. El linter de seguridad conserva los avisos previos y añade dos avisos de descubrimiento de esquema GraphQL autenticado para las nuevas tablas: sus nombres son visibles tras iniciar sesión, pero RLS limita las filas a los roles administrativos y no se conceden escrituras directas. Las pruebas verifican que Asesor no obtiene filas. No hay nuevas funciones privilegiadas públicas ni acceso anónimo a estas tablas. Referencia: [aviso de esquema autenticado](https://supabase.com/docs/guides/database/database-linter?lint=0027_pg_graphql_authenticated_table_exposed).

## Límites y próximos bloques

- No se concilian automáticamente diferencias reales ni se completan costos/deudas con suposiciones.
- Búsqueda de movimientos: 50 resultados visibles y aviso para acotar cuando hay más; no limita el importe total ni resuelve los omitidos.
- El historial conserva resoluciones anteriores; los registros legados resueltos solo con nota no adquieren evidencia estructurada ficticia ni reversión automática nueva.
- No se reescriben cierres posteriores que hayan documentado otras diferencias. Cada una conserva su propio pendiente y evidencia.
- No se certifica reconstrucción bitemporal completa ni carrera entre dos sesiones reales en producción. Las pruebas cubren reintentos, versiones obsoletas, bloqueo y solapamientos lógicos con fixtures revertidos.
- La migración del resto de escritores legados, edición nativa de toda la configuración, importación de extractos y reglas de aprobación/reapertura adicionales mantienen sus bloques propios; esta entrega no declara terminado todo Finanzas.

## Secuencia vigente

1. Delivery: deudas/deducibles — entregado en `DELIVERY_DEBTS_WEEKLY_2026-09-15.md`.
2. Cuentas, caja y conciliación — este corte.
3. Autorizaciones completas: cobertura y antes/después.
4. Correcciones de órdenes y devoluciones físicas.
5. Comisiones, metas y jugadas integradas.
6. Clientes y cobranza.
7. Administración completa: catálogo, inventario, usuarios, parámetros y configuración.
8. Tareas, historial y reportes.
9. KPIs y presentación compacta.
10. Rentabilidad y proyección, con metodología de costos acordada.
