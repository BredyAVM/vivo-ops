# Inventario completamente no bloqueante en órdenes

Fecha: 2026-08-10

## Resultado

Inventario ya no puede impedir que una partida se guarde ni que una orden sea
aprobada, reprogramada, cancelada, preparada o entregada. El motor intenta
sincronizar composición, compromisos y consumo; si no puede, conserva la acción
operativa y registra una incidencia auditable.

No se crearon tablas ni columnas. Se reutilizaron:

- `order_timeline_events` y sus destinatarios para incidencias ligadas a una
  orden;
- `inventory_alerts`, políticas y rutas para el ciclo de atención;
- `inventory_movements` como único libro físico;
- los cuatro triggers que ya conectaban órdenes con inventario.

## Reglas

### Falta física

Una entrega válida crea sus movimientos `sale_out` aunque la existencia no
alcance. El saldo puede quedar negativo; así se conserva el hecho físico sin
inventar una reposición.

### Falla estructural

Si falta una apertura, una configuración no resuelve, el ítem no es operativo,
la autorización no es válida o se detecta otra excepción, el trigger automático
la captura. La orden continúa y se crea una incidencia crítica o de advertencia.
No se inserta un movimiento incompleto.

### Saldo negativo

Cada cambio de saldo ejecuta un guardián independiente de recetas, vínculos y
umbrales. Un ítem activo, inicializado y rastreado con saldo menor que cero abre
una alerta:

- categoría: `control`;
- tipo: `negative_stock`;
- severidad: `critical`;
- requiere acción: sí;
- fuente: `inventory_balance_guard`.

La política global de control vigente la dirige a Máster, Administración y
Cocina en sus superficies configuradas. La alerta se resuelve automáticamente
cuando el saldo vuelve a cero o positivo.

## Trazabilidad de fallas

Los eventos automáticos usan el grupo `inventory` y uno de estos tipos:

- `inventory_snapshot_sync_failed`;
- `inventory_commitment_sync_failed`;
- `inventory_sale_sync_failed`.

Máster y Administración son destinatarios con acción requerida. Al abrir el
Centro de Alertas, el reconciliador incorpora esos eventos como alertas de
sistema sin mezclarlos con las acciones comerciales normales de la orden.

## Seguridad

Todas las funciones nuevas o reemplazadas viven en `app_private`, fijan
`search_path = ''` y no conceden ejecución a `public`, `anon`,
`authenticated` ni `service_role`. No se añadió ninguna RPC pública.

## Verificación

Se ejecutaron pruebas transaccionales con `ROLLBACK`:

1. recuperación a saldo cero resolvió la alerta negativa;
2. regreso a saldo negativo abrió exactamente una alerta crítica;
3. una entrega con consumo ya registrado provocó intencionalmente un error de
   inventario, pero la orden quedó `delivered`, no duplicó movimientos y creó
   exactamente una incidencia dentro de la transacción;
4. la alerta crítica fue visible en `master_inventory`;
5. al finalizar, el saldo productivo, la orden y sus movimientos conservaron
   sus valores originales.

Los asesores de seguridad y rendimiento no reportaron hallazgos asociados con
las funciones o el trigger de esta migración.

## Migración

`20260810152823_inventory_order_flow_nonblocking_v2`

El archivo histórico
`20260807214500_inventory_non_blocking_order_policy_v1.sql` nunca fue aplicado
y no debe aplicarse: su motor privado todavía rechazaba faltantes físicos.
