# Bloque 34 — auditoría y navegación de Inventario General

Fecha: 2026-08-11

## Resultado

La entrada administrativa deja de presentar diez botones con el mismo peso.
Inventario General queda organizado alrededor de cinco preguntas frecuentes:

- Resumen: qué requiere atención hoy;
- Productos: cómo se configura cada producto o ítem;
- Entradas y operaciones: qué llegó o qué movimiento debe registrarse;
- Conteos: qué se contó y qué necesita revisión;
- Alertas: qué requiere una decisión.

El mapa de descuentos, las preparaciones, el historial, los ajustes y la
auditoría técnica permanecen disponibles bajo `Más herramientas`. Ninguna ruta
se eliminó y cada sección continúa cargándose únicamente cuando se abre.

## Auditoría de reutilización

La fase general no necesita otra tabla para frecuencias, responsables, mínimos
o estado. Ya existen en `inventory_items`:

- `primary_count_frequency`;
- `primary_count_role`;
- `low_stock_threshold`;
- `target_stock_units`;
- `inventory_group`;
- `tracking_mode`;
- `is_active`;
- `availability_mode`.

También existen el configurador versionado, los escritores administrativos y
las entidades canónicas de productos, componentes, vínculos, recetas, conteos,
movimientos, flujos y alertas. Los siguientes bloques deben simplificar su uso,
no duplicarlos.

## Frontera por módulo

Este bloque modifica solamente `/app/inventory`. No cambia las pantallas de
Master, Cocina, Asesor, Counter ni Finanzas. Master conserva acceso de lectura al
centro actual hasta que su adaptador operativo sea trabajado en la fase propia.
