# Bloque 29 — alertas de inventario por rol

Fecha: 2026-08-10

## Resultado

Las alertas de inventario continúan en su centro propio. No se agregaron a las
notificaciones de acciones ni al seguimiento de órdenes.

Cada rol entra por una superficie independiente y recibe únicamente las
categorías configuradas para esa combinación de rol y superficie:

- Administración: centro completo y configuración;
- Máster: lectura operativa de disponibilidad, compromisos, producción,
  control, procura y sistema;
- Asesor: disponibilidad comercial, solo informativa;
- Cocina: producción y control, solo informativo;
- Counter: disponibilidad comercial, preparada para su adaptador de fecha.

## Presentación

- El enlace de Máster consulta `master_inventory`, no el centro administrativo.
- Asesor dispone de una sección independiente `Disponibilidad`; no aumenta la
  carga inicial de su pantalla de pedidos.
- Cocina dispone de `Inventario > Alertas`; se carga únicamente al abrirla.
- Administración mantiene rutas y excepciones configurables desde el Centro de
  Inventario.

Las pantallas de Asesor y Cocina no pueden tomar, resolver ni reabrir alertas.
Su lectura es informativa. Máster y Administración conservan la gestión.

## Estructura reutilizada

No se crearon tablas ni columnas. Se reutilizan:

- `inventory_alert_policies`;
- `inventory_alert_policy_routes`;
- `inventory_alerts`;
- `inventory_alert_workspace_v1` e `inventory_alert_summary_v1`.

La única ampliación de datos es la ruta general de disponibilidad hacia
`counter_inventory`; las categorías internas no se exponen a Counter ni a
Asesor.

## Garantía operativa

Las alertas son señales de lectura y gestión. Ninguna de estas superficies puede
impedir crear, aprobar, preparar, despachar o entregar una orden.

## Migración

- `20260810231922_inventory_alert_role_surfaces_v1.sql`
