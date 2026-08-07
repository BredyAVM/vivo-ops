# Bloque 7: apertura física y corte operativo

Fecha: 2026-08-07

Estado: **aplicado en Supabase y probado con `ROLLBACK`; apertura física real
pendiente**.

## Resultado preparado

- nueva ruta independiente `/app/inventory/opening`;
- conteo inicial ciego, sin mostrar el saldo legado;
- captura por lotes de los ítems inventariables existentes;
- saldo físico actualizado al presentar el conteo;
- revisión de Master o Administración;
- aceptación completa o reconteo selectivo;
- cierre automático de la cadena padre cuando se acepta el reconteo;
- activación de ventas derivada de aperturas aceptadas, sin tabla ni bandera
  adicional.

No se crea ninguna tabla ni columna.

## Estados del corte

| Modo | Condición | Escritor de ventas |
| --- | --- | --- |
| `legacy` | todavía no existe ningún conteo de apertura | se conserva el escritor actual |
| `opening` | comenzó la apertura, pero no están aceptados todos los ítems | no se escribe consumo; es una ventana controlada sin entregas |
| `canonical` | todos los ítems activos y rastreados tienen apertura aceptada y no revertida | la entrega y el consumo se confirman en una sola transacción |

La pantalla exige confirmar la ventana controlada. No deben cerrarse entregas
entre el primer lote presentado y la aceptación del último ítem.

## Consumo por entrega

El trigger preparado escucha únicamente la transición real a `delivered` y solo
actúa en modo `canonical`. La resolución del pedido, las validaciones de stock,
los movimientos firmados y la actualización del saldo ocurren dentro de la misma
transacción que la entrega. Si el consumo falla, la entrega también se revierte.

La autoridad queda así:

- Master y Administración: entregas bajo sus permisos vigentes;
- Counter: solo el retiro `walk_in` y `pickup` que acaba de completar;
- Asesor y Cocina: no confirman consumos de ventas.

## Frontera con Master y Counter

No se agregan pantallas ni lecturas pesadas en esos módulos. La única modificación
local en Master consulta el modo del corte antes de usar su escritor legado y
protege una orden entregada contra ediciones sin reverso formal. Counter no recibió
cambios de código: su operación existente será observada por el trigger de base.

## Verificación reversible

Las pruebas transaccionales comprobaron:

- baseline real de 0 aperturas y 47 ítems pendientes;
- visibilidad restringida a Master y Administración;
- lote parcial sin activación de ventas;
- bloqueo del escritor legado después de abrir un ítem;
- reconteo selectivo y cierre correcto de su padre;
- activación solo al llegar a 47 aperturas aceptadas;
- consumo automático de una entrega de Master;
- límite estricto de Counter a su `walk_in pickup`;
- rechazo de una orden de Asesor intentada por Counter.

La migración y todas las fixtures se ejecutaron dentro de una única transacción
con `ROLLBACK`. La comprobación posterior confirmó cero funciones del Bloque 7,
cero conteos de apertura y cero órdenes de prueba persistidas en producción.

## Estado operativo actual

La migración `20260807200921_inventory_opening_cutover_v1` está instalada, pero
permanece en modo `legacy`: 0 de 47 ítems tienen apertura, `ready=false` y no
existe ningún consumo canónico de venta. En este estado no consulta stock al
procesar órdenes, no bloquea estados y conserva el escritor vigente.

Antes de iniciar el primer conteo físico se revisará nuevamente la operación con
el usuario. Durante esa futura ventana no deben cerrarse entregas. También se
definirá explícitamente cómo informar faltantes sin introducir bloqueos
innecesarios en la creación, aprobación o agenda de pedidos.
