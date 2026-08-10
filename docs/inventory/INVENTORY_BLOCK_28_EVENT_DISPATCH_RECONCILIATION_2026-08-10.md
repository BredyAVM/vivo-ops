# Bloque 28 — despacho y conciliación de inventario para eventos

Fecha: 2026-08-10
Estado: implementado, probado y aplicado en producción.

## Regla canónica

El inventario que sale temporalmente para un evento no se descuenta dos veces.
El despacho registra toda la cantidad enviada y reserva únicamente el excedente
sobre el compromiso que ya pertenece a la orden.

Al cerrar el evento se informan, por cada ítem:

- cantidad devuelta;
- avería o merma;
- cantidad efectivamente consumida.

La devolución libera la reserva temporal. Las pérdidas generan movimientos
físicos. La venta continúa descontándose una sola vez cuando la orden se marca
como entregada. Una diferencia entre lo consumido y lo comprometido genera una
advertencia para Máster y Administración, pero nunca bloquea la orden.

## Modelo reutilizado

No se creó ninguna tabla. Se reutilizaron:

- `inventory_planned_flows` para la reserva temporal `event_dispatch`;
- `inventory_movements` para averías y mermas;
- `order_timeline_events` y sus destinatarios para la trazabilidad;
- el compromiso existente de la orden como referencia de consumo.

## Operación

El apartado `Inventario > Operaciones` permite a Máster y Administración:

1. escoger una orden activa;
2. registrar las cantidades que salen al evento;
3. conciliar retornos y pérdidas;
4. consultar los despachos abiertos y su historial.

## Garantía no bloqueante

El reporte de averías, mermas o diferencias puede dejar el saldo negativo. El
saldo y su alerta muestran el hecho físico; nunca revierten ni impiden el avance
de una orden.

## Verificación

- Migración aplicada en producción.
- Prueba transaccional despacho → reserva de excedente → retorno → liberación:
  correcta y revertida sin dejar datos de prueba.
- Prueba transaccional de pérdida con saldo cero → saldo negativo: correcta y
  revertida.
- RPC nuevas sin ejecución para `anon`, con `search_path` fijo y permiso para
  usuarios autenticados autorizado internamente por rol.
- `npm run build`: correcto.

## Migración

- `20260810223043_inventory_event_dispatch_reconciliation_v1.sql`
