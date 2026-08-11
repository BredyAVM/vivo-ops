# Bloque 33 — certificación V1 no bloqueante

Fecha de cierre: 2026-08-10

## Resultado

El centro canónico queda **certificado para el piloto operativo V1**. La
estructura, la apertura, los escritores, la disponibilidad por fecha, las
alertas por rol y los controles administrativos usan el mismo centro de verdad.
Inventario informa, proyecta y registra; no rechaza ni revierte una orden.

Esta certificación no significa que todos los parámetros comerciales estén
terminados. Quedan doce mínimos por decidir desde el configurador y la adopción
diaria de los conteos por Cocina. Son trabajo operativo configurable, no una
carencia del motor ni un motivo para frenar órdenes.

## Auditoría del esquema existente

No se creó ninguna tabla ni columna en este bloque. Se revisaron y conservaron:

- `products`, con sus campos comerciales y los campos heredados que todavía
  consumen otros módulos;
- `product_components`, para composiciones fijas y seleccionables;
- `product_inventory_links`, para la resolución física versionada;
- `inventory_items`, como saldo físico canónico;
- `inventory_recipes` e `inventory_recipe_components`, para preparaciones;
- `inventory_movements`, como libro mayor;
- `inventory_planned_flows`, para compromisos, reposiciones y eventos;
- `inventory_counts` e `inventory_count_lines`, para conteos y reconteos;
- `inventory_alerts`, `inventory_alert_policies` e
  `inventory_alert_policy_routes`, para señales separadas por rol.

Los campos de inventario presentes en `products` no se eliminaron ni se
duplicaron: siguen funcionando como contrato de catálogo mientras los saldos y
movimientos viven exclusivamente en las entidades canónicas. Retirarlos ahora
rompería lectores existentes de Catálogo, Master, Asesor o Counter.

## Estado productivo certificado

- 54 identidades canónicas activas: 49 con seguimiento físico y 5 sin saldo
  independiente;
- 48 ítems incluidos en la apertura, todos aceptados, ninguno pendiente o en
  revisión;
- 103 productos comerciales activos;
- 90 productos activos con inventario habilitado y ninguno pendiente de
  configuración canónica;
- 13 productos compuestos resuelven por `product_components`, sin enlace físico
  directo propio;
- `Salsa Tártara 5oz` conserva su enlace versionado V1 y su identidad física,
  aunque el registro legado permanezca inactivo como parte del corte;
- 13 recetas canónicas activas;
- modo `canonical`, estado `ready_for_canonical_operation` y
  `inventory_blocks_orders = false`.

## Alertas útiles, separadas y configurables

Después del refresco de certificación existen 37 señales abiertas y relevantes:

- 18 de disponibilidad para Asesor y Counter;
- 15 de procura para Administración y Master;
- 4 de producción para Cocina, Administración y Master.

No existe ninguna alerta abierta para un ítem sin apertura o sin operación
física. Tampoco queda abierta ninguna incidencia `inventory_sale_sync_failed`.
Las cantidades en cero que sí fueron contadas y pertenecen al catálogo vigente
continúan siendo información legítima de disponibilidad y procura.

Los doce mínimos todavía configurables son:

1. Mandocas Crudas;
2. Salsa Tártara 5oz;
3. Salsa Tártara 1oz;
4. Tequeños Regulares Pre-Fritos;
5. Bombys Crudos;
6. Tequeños Regulares Crudos;
7. Salsa Tártara 2oz;
8. Aderezo Mostaza Miel 2oz;
9. Aderezo Mostaza Miel 5oz;
10. Dondys;
11. Salsa Tártara Galón;
12. Aderezo Mostaza Miel a granel (envase 1 kg).

Administración puede definirlos desde el configurador; no se inventaron valores
en la migración.

## Defecto encontrado y reparado

La entrega ya era no bloqueante, pero el consumo automático llamaba al escritor
público con el rol de quien cerraba la orden. Cuando Counter entregaba una orden
originada por Asesor, la frontera manual de Counter rechazaba el movimiento y lo
dejaba como incidencia.

`inventory_commit_order_sale_v1` ahora distingue dos contextos:

- una llamada RPC manual mantiene sin cambios la autorización estricta de
  Administración, Master o el retiro `walk_in` propio de Counter;
- la llamada automática desde el trigger de una orden entregada registra el
  consumo para cualquier origen válido, conservando al actor real y permitiendo
  saldo negativo.

La migración reutiliza la función y el trigger existentes:

- `20260811014500_inventory_order_sale_trigger_context_v3.sql`.

No se amplió el permiso de `anon`; las 50 funciones públicas de inventario son
`SECURITY DEFINER`, tienen `search_path` vacío, no son ejecutables por `anon` ni
por `public`, y mantienen sus comprobaciones internas por rol.

## Conciliación histórica

Se recuperaron atómicamente nueve entregas que habían quedado sin consumo por
esa frontera: órdenes 1734, 1735, 1737, 1739, 1740, 1741, 1744, 1748 y 1749.
El resultado fue:

- 38 movimientos `sale_out` escritos;
- 9 incidencias históricas resueltas con nota de conciliación;
- 0 incidencias de sincronización abiertas;
- saldos físicos resultantes no negativos en el momento de la conciliación.

La corrección no modificó precios, pagos, estados de las órdenes ni módulos de
Finanzas.

## Pruebas ejecutadas

Las pruebas transaccionales terminaron en `ROLLBACK` y acreditaron:

- Counter puede entregar una orden de Asesor sin que inventario intervenga en
  el estado;
- el trigger crea los cinco movimientos correspondientes en el caso probado;
- una venta con cinco ítems forzados a cero termina con cinco saldos negativos,
  sin error de sincronización y con la orden entregada;
- la llamada RPC manual de Counter sobre una orden ajena sigue denegada;
- `inventory_blocks_orders` permanece en `false`;
- las superficies por rol muestran 37 alertas para Administración/Master, 18
  para Asesor/Counter y 4 para Cocina;
- ninguna alerta abierta pertenece a un ítem no inicializado.

El guion reproducible está en
`docs/inventory/INVENTORY_BLOCK_33_TRANSACTION_TESTS_2026-08-10.sql`.

## Lectura de los asesores de Supabase

La revisión no encontró una vulnerabilidad nueva causada por este bloque. Las
advertencias sobre RPC `SECURITY DEFINER` y tablas visibles a usuarios
autenticados describen la arquitectura existente: las cuentas son internas, las
tablas tienen RLS y los RPC validan el rol dentro de cada función. Los índices
de inventario marcados como no usados corresponden a rutas recientes del piloto;
no se eliminaron sin tráfico representativo.

## Alcance que queda después de V1

No queda un bloque estructural pendiente dentro de la ruta acordada. La siguiente
fase es retroalimentación operativa:

- definir los doce mínimos cuando Administración tenga el criterio;
- empezar los conteos reales por Cocina y revisar sus diferencias;
- ajustar rutas y sensibilidad de alertas desde el sistema;
- corregir recetas, presentaciones o vínculos desde el configurador cuando la
  operación detecte una excepción;
- decidir más adelante, con evidencia, si alguna regla dejará de ser solamente
  informativa. Ese cambio no forma parte de V1.
