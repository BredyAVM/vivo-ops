# Evento 2667: ampliación histórica regularizada

Aplicado en producción el 21/09/2026. Raíz de evento **671**, presupuesto inicial
convertido en orden **2667**, ampliación histórica **2782** (borrador **710**).

## Resultado confirmado

| Concepto | Composición | Importe USD |
| --- | --- | ---: |
| Orden inicial 2667, conservada | 50 combos × 5 UND = 250 Mini Tequeños Fritos | 152,10 |
| Ampliación histórica 2782 | 40 combos × 5 UND = 200 Mini Tequeños Fritos | 111,20 |
| Evento consolidado | 90 combos = 450 UND | 263,30 |

La tarifa confirmada es US$2,78 por grupo de 5 UND. Los 40 adicionales suman
US$111,20. Se conserva el presupuesto inicial sin reinterpretar sus otros cargos:
la diferencia de US$13,10 frente a 50 × US$2,78 **no se atribuyó al stand** ni a otro
concepto sin evidencia. No se crearon combos nuevos en el catálogo.

Ambas órdenes quedan entregadas y **sin pagos registrados**. Intención de pago:
pago móvil; presupuesto de nacimiento en USD, no un cobro ficticio en bolívares.
Se conserva la tasa histórica del presupuesto (847,44) para la ampliación; no se
revaloriza la negociación usando la tasa actual. Comisión general heredada.
Cliente, asesor y receptor se toman de la orden inicial sin duplicar registros.

## Inventario y trazabilidad

- La orden original, su línea 12249 y su salida de 250 UND permanecen intactas.
- La ampliación contiene línea 12787 y componente producto 5 por 200 UND.
- Hubo conteos físicos posteriores al evento. El primer conteo posterior auditado
  fue 229, línea 3859, aceptado, con 289 UND contadas y movimiento 11567.
- No se volvió a descontar inventario actual ni se alteraron aquellos conteos.
  **No se afirma que su diferencia de −153 corresponda a los 200 adicionales.**
- La excepción histórica consta en el presupuesto, orden y ajuste administrativo.
  No es una regla para omitir consumo de nuevas ampliaciones operativas.
- No se llamó a aprobar, enviar a cocina ni marcar entregado; se insertó la
  ampliación histórica en estado entregado. Cero movimientos de stock, pagos,
  compromisos o nuevos tiempos de cocina para la orden 2782.
- Fecha comercial: 18/09/2026. La hora exacta de entrega adicional no está
  documentada. El evento de entrega usa las 16:00 previstas como referencia de
  fecha para reportes diarios, con `delivery_time_known=false` y origen explícito.
  La creación real y `recorded_at` conservan el 21/09/2026. No se atribuye una
  entrega real a esa hora ni al operador de la entrega inicial.
- Seguimiento informativo para Máster y asesor: ampliación histórica registrada;
  no solicitud de preparar ni entregar otra vez.

## Auditoría y verificación

Se revisaron definiciones vigentes, guardas de precio y composición, triggers de
órdenes e ítems, reportes por fecha de entrega, API de eventos y saldos. Se usaron
las guías Supabase y Postgres para transacción corta, bloqueos acotados, permisos y
verificación de efectos. Sin tablas, columnas, funciones, privilegios ni reglas
nuevas; sin deshabilitar triggers ni ampliar facultades de Máster.

Runbook: `tools/events/regularize-2667-historical-extension.sql`. Termina en
`ROLLBACK` por defecto; se aplicó el mismo bloque verificado con `COMMIT` explícito.
UUID estable: `f8795f80-1328-4ba5-a689-946406467d12`.

Pruebas en producción revertidas antes de aplicar:

1. Regularización completa con aserciones de composición, precio, fecha, saldos,
   ausencia de consumo/pago/compromisos y preservación exacta de la orden inicial.
2. Repetición de la operación en la misma transacción: no duplica órdenes.
3. Lectura del evento como Máster y como su asesor: dos órdenes, una ampliación,
   total US$263,30. No equivale a una prueba visual del navegador.

Consulta independiente después de confirmar: órdenes 2667 y 2782 entregadas,
250 + 200 UND, pendientes US$152,10 + US$111,20, cero compromisos activos,
un único movimiento de inventario original por −250 UND, cero movimientos nuevos.
El asesor de seguridad de Supabase mantiene observaciones generales del proyecto
(rutas de búsqueda mutables, exposición de esquemas/funciones y protección de
contraseñas); esta operación de datos no modifica esos objetos ni los resuelve.

## Cómo consultarlo

**Eventos → Colegio Bella Vista** (`/app/events/671`): inicial 2667 y ampliación
2782, con cobranza consolidada en **Pagos del evento**. La ficha individual de
2667 conserva 250 UND y US$152,10; no muestra sola el total de ambas órdenes.
No crear otra ampliación por estos mismos 200 UND ni volver a enviarlos a cocina.
