# Bloque 35 — perfil operativo y calendario de conteo

Fecha: 2026-08-11

## Decisión canónica

Cada ítem conserva una sola frecuencia principal de conteo programado:

- por turno;
- diaria;
- semanal;
- quincenal;
- mensual.

Un valor nulo no significa que el ítem no pueda contarse. En la interfaz se
presenta como **Solo por solicitud** y permite conteos puntuales sin incorporar
el ítem a todos los cierres. Cuando existe una frecuencia programada también
debe existir un rol responsable.

## Reutilización

No se creó ninguna tabla ni columna. El perfil usa directamente:

- `inventory_items.primary_count_frequency`;
- `inventory_items.primary_count_role`;
- `inventory_items.inventory_group`;
- `inventory_items.unit_name`;
- `inventory_items.tracking_mode`;
- `inventory_items.availability_mode`;
- `inventory_items.low_stock_threshold`;
- `inventory_items.target_stock_units`;
- `inventory_items.is_active`.

La edición continúa pasando por `inventory_update_item_controls_v1`. La creación
universal también guarda los mismos campos mediante el flujo de borrador
existente.

## Resultado operativo

Administración entra primero al perfil del ítem, puede buscar por nombre,
familia o tipo y entiende en la misma vista:

- dónde aparecerá para ser contado;
- quién es el responsable;
- cuál es su unidad y existencia actual;
- qué mínimo y objetivo tiene configurados;
- qué estructura está protegida para no reinterpretar el historial.

La capa comercial y la receta siguen dentro del mismo producto, pero separadas
en pestañas explícitas para evitar confundir precio con existencia o fórmula.
