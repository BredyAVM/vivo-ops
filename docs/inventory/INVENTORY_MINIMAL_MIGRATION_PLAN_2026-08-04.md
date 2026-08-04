# Plan mínimo de migración de inventario

Fecha: 2026-08-04

Estado: baseline y Fase A estructural aplicadas; backfill no iniciado.

## 0. Ejecución del 2026-08-04

Se reconciliaron los archivos locales con las 38 migraciones que ya estaban
registradas en Supabase. Después se incorporaron y verificaron estas dos
migraciones de inventario:

- `20260804201752_inventory_existing_schema_baseline.sql`: registra las nueve
  columnas físicas de `products` y las cinco tablas de inventario que ya
  existían fuera del historial. En producción se marcó como baseline aplicada;
  no se volvió a ejecutar su DDL ni se tocaron los datos.
- `20260804202722_inventory_phase_a_foundation.sql`: añade la estructura
  no destructiva aprobada, incluyendo las cinco tablas nuevas, restricciones,
  índices de claves foráneas y RLS.

La verificación posterior conservó exactamente las filas existentes: 143
productos, 76 ítems físicos, 107 enlaces, 2 recetas, 3 componentes de receta y
3.772 movimientos. Las cinco tablas nuevas quedaron vacías, como corresponde:
todavía no existe backfill ni saldo inicial.

Los asesores de Supabase ya no reportan claves foráneas nuevas sin índice. Se
mantienen documentadas dos deudas de las cinco tablas legadas: permisos de
`anon` demasiado amplios y políticas permisivas duplicadas para lectura. No se
cambiaron en Fase A para no alterar el comportamiento de la aplicación antes de
migrar sus consumidores.

## 1. Principio

La migración no conservará dos maneras de representar la misma regla. Cada tabla y
columna tendrá un consumidor y una autoridad explícitos. El orden obligatorio es:

1. inventariar lo existente;
2. reutilizar o cambiar de semántica de forma deliberada;
3. crear solo lo que no pueda representarse correctamente;
4. migrar consumidores;
5. demostrar que lo legado ya no se usa;
6. eliminarlo.

No se crean columnas «por si acaso» ni se dejan duplicados indefinidos.

## 2. Estado vivo revisado

Lectura de Supabase del 2026-08-04:

| Estructura | Filas | Uso observado |
| --- | ---: | --- |
| `products` | 143 | 123 habilitados para inventario |
| `inventory_items` | 76 | 69 activos; 56 con saldo negativo |
| `product_inventory_links` | 107 | 64 `self_link`, 43 `recipe` |
| `inventory_recipes` | 2 | 2 activas |
| `inventory_recipe_components` | 3 | insumos de las recetas actuales |
| `inventory_movements` | 3.772 | solo `sale_out` / `order_delivery` |
| `order_item_components` | 0 | existe, pero el flujo no la usa |

La base cambió desde el corte del 2026-07-30. Antes de ejecutar cualquier
migración se regenerarán las matrices para no restaurar productos eliminados ni
omitir ítems nuevos.

### Desfase de historial detectado

El historial remoto contiene migraciones hasta `20260803145851`, mientras que la
carpeta local encontrada contiene solo siete archivos y termina en una versión
distinta de julio. Además, no se encontró en todo el workspace una migración que
cree `inventory_items`, `product_inventory_links` o `inventory_movements`.

Por tanto, las estructuras de inventario existen en producción pero no están
reproducibles desde el historial local disponible. Es un prerrequisito corregir
esa deriva antes de generar la migración funcional.

El procedimiento seguro será:

1. ejecutar `db pull` únicamente cuando se confirme el checkout de migraciones
   correcto;
2. generar el baseline en un espacio temporal;
3. revisar el archivo completo, porque el pull puede incluir diferencias de otros
   módulos;
4. aislar y validar el dominio de inventario sin modificar Counter, Master o
   finanzas;
5. sincronizar el historial remoto solo después de comprobar que el baseline
   representa objetos que ya existen y no intenta recrearlos.

No se ejecutará `db push`, `migration repair` ni una migración de baseline sin esa
revisión. El baseline debe quedar marcado como ya aplicado en el remoto, no volver
a ejecutar DDL sobre las tablas existentes.

## 3. `products`: reciclar y retirar duplicados

### Se conservan

- `inventory_enabled`: indica que la política está configurada y activa;
- `inventory_deduction_mode`: se reutiliza como política canónica, ampliando los
  valores a `self`, `direct`, `components` y `none`;
- campos comerciales como `type`, `is_combo`, `units_per_service`,
  `is_detail_editable`, `detail_units_limit` e
  `is_combo_component_selectable`.

El valor actual `composition` se migrará a `components`.

### Se eliminan después de migrar consumidores

| Columna | Razón |
| --- | --- |
| `is_inventory_item` | duplica exactamente `inventory_enabled` en la lectura actual |
| `inventory_kind` | los 143 productos tienen el valor por defecto `finished_good`; pertenece al ítem físico |
| `inventory_unit_name` | los 143 productos dicen `pieza`; la unidad autorizada vive en `inventory_items` |
| `packaging_name` | duplica presentación física y solo tiene datos en 5 productos |
| `packaging_size` | misma duplicación |
| `current_stock_units` | cuatro valores no cero contradicen los saldos de los ítems enlazados |
| `low_stock_threshold` | el umbral pertenece al ítem compartido |
| `inventory_group` | los 143 productos dicen `other`; la familia pertenece al ítem físico |

No se eliminan en la primera migración. El código actual todavía las referencia.
Primero se cambia la lectura y escritura; después una auditoría de código y objetos
de base debe devolver cero dependencias.

## 4. `inventory_items`: única autoridad física

### Columnas existentes que se conservan

- `id`, `name`, `inventory_kind`, `unit_name`;
- `current_stock_units` como proyección del kardex, no como edición libre;
- `low_stock_threshold`, `is_active`, `notes`, `inventory_group`.

### Columnas que migran a otra estructura y luego se eliminan

- `packaging_name`;
- `packaging_size`.

Un ítem puede tener más de una presentación y esas dos columnas solo permiten una.

### Columnas nuevas mínimas

| Columna | Función |
| --- | --- |
| `tracking_mode` | `transactional`, `periodic_count` o `not_tracked` |
| `consumption_triggers` | arreglo de `sale`, `production` y `manual_issue` |
| `availability_mode` | `on_hand_only`, `immediate_recipe` o `scheduled_recipe` |
| `target_stock_units` | objetivo operativo opcional, por ejemplo 10 servicios prefritos |
| `shelf_life_days` | vida útil opcional |
| `merged_into_item_id` | identidad canónica de un alias histórico |
| `primary_count_frequency` | periodicidad principal editable; el conteo bajo demanda siempre existe |
| `primary_count_role` | rol responsable usando el enum `user_role` existente |
| `low_stock_inclusive` | distingue `< límite` de `<= límite` |

No se agregan por ahora proveedor, días de despacho, capacidad simultánea ni otros
datos opcionales que todavía no consumirá el motor.

## 5. Relaciones comerciales y físicas

### `product_components`

Se reutiliza sin columnas nuevas. Continúa siendo la plantilla comercial. Su
índice único actual evita reglas duplicadas para el mismo padre, componente y modo.

### `order_item_components`

Se reutiliza para la selección real. Se agrega únicamente
`component_name_snapshot`, porque una edición futura del catálogo no debe cambiar
la lectura del pedido histórico. El flujo dejará de interpretar selecciones desde
notas.

### `product_inventory_links`

Se reutilizan todas sus columnas. `quantity_units` será obligatoria y se respetará
también en `self_link`. Se agregan restricciones, no columnas:

- cantidad mayor que cero;
- valores conocidos de `deduction_mode`;
- índice único parcial por producto e ítem cuando `is_active = true`.

No habrá resolución por coincidencia de nombre.

## 6. Recetas

`inventory_recipes` e `inventory_recipe_components` se reutilizan.

Se agregan a `inventory_recipes`:

| Columna | Función |
| --- | --- |
| `lead_time_minutes` | preparación, enfriamiento y empaque |
| `production_multiple` | múltiplo válido de producción |
| `version` | evita reinterpretar una producción histórica después de editar la receta |

`output_quantity_units`, `recipe_kind`, `is_active` y `created_at` ya existen y se
conservan. La vida útil no se duplica en la receta: vive en el ítem resultante.

Las ediciones crean una versión nueva y desactivan la anterior. Un índice parcial
garantiza una sola receta activa por salida y tipo.

## 7. Kardex

`inventory_movements` se conserva y pasa a ser inmutable.

### Semántica reciclada

`quantity_units` representará el delta firmado:

- entrada: positivo;
- salida: negativo;
- ajuste de conteo: diferencia entre contado y esperado;
- reverso: signo opuesto al movimiento original.

Los 3.772 movimientos actuales son `sale_out` positivos, por lo que el backfill
puede convertirlos de forma determinista a negativos. No existen otros tipos
históricos que requieran inferencia.

### Columnas nuevas mínimas

| Columna | Función |
| --- | --- |
| `operation_id` | UUID estable que agrupa e identifica idempotentemente un hecho |
| `reversal_of_movement_id` | referencia al movimiento revertido |
| `inventory_lot_id` | lote opcional para vencimiento y trazabilidad |

`order_id`, `reason_code`, `notes`, `created_at` y `created_by_user_id` continúan
en uso. No se crea una tabla separada de operaciones en la primera fase:
`operation_id` basta para agrupar una operación atómica mientras no exista un
workflow propio de operaciones.

Los movimientos contabilizados no se actualizan ni se borran.

## 8. Tablas nuevas estrictamente necesarias

### `inventory_item_presentations`

Una fila por caja, bolsa, paquete, recipiente o presentación de recepción. Contiene
ítem, nombre, factor hacia unidad base, posibilidad de fracción, estado y fechas.
Reemplaza definitivamente `packaging_name` y `packaging_size`.

### `inventory_lots`

Identifica lote, ítem, fecha de recepción/producción, vencimiento, cantidad inicial
y estado. Es necesaria para prefritos con vida útil y para investigar fabricación,
mermas o averías.

### `inventory_planned_flows`

Centro único para hechos futuros que no son movimientos: compromiso de pedido,
recepción esperada, producción planificada o indisponibilidad declarada. Conserva
ítem, tipo, cantidad, fecha efectiva, estado, pedido/receta opcionales y dependencia
de otro flujo. Evita crear tablas separadas de reservas, reposiciones y planes.

### `inventory_counts`

Encabezado de conteo ciego, cambio de turno, solicitud puntual o reconteo.

### `inventory_count_lines`

Esperado congelado, contado, diferencia, nota y estado de revisión por ítem. Es
necesaria porque un movimiento aislado no puede representar el reporte completo ni
un reconteo parcial.

Total inicial justificado: **cinco tablas nuevas**. Ninguna duplica una tabla
existente.

## 9. Escritura atómica

Los flujos actuales insertan movimientos y actualizan saldos en llamadas separadas.
La migración los reemplazará por comandos SQL transaccionales que:

1. validan usuario y rol;
2. bloquean `inventory_items` por `id` ascendente;
3. revalidan stock y configuración;
4. insertan todos los movimientos con un `operation_id` estable;
5. actualizan la proyección de saldo;
6. confirman todo o no confirman nada.

El orden estable de bloqueo evita interbloqueos. Las transacciones no incluyen
llamadas externas.

Las funciones privilegiadas usarán `search_path = ''`, comprobarán `auth.uid()` y
roles internamente, revocarán ejecución a `PUBLIC` y `anon`, y otorgarán solo las
operaciones necesarias a `authenticated`.

## 10. Fases

### Fase A. Preparación no destructiva

- reconciliar primero la deriva entre esquema vivo, historial remoto y archivos
  locales;
- refrescar matrices contra la base viva;
- añadir columnas y cinco tablas nuevas;
- añadir RLS, claves foráneas e índices de claves foráneas;
- no cambiar todavía el comportamiento de la aplicación.

### Fase B. Backfill

- clasificar los 143 productos y 76 ítems vivos;
- crear presentaciones desde los empaques actuales;
- migrar alias con `merged_into_item_id`;
- cargar recetas canónicas;
- convertir la semántica histórica de cantidades;
- no aceptar los saldos actuales como apertura.

### Fase C. Cambio del motor

- persistir `order_item_components`;
- eliminar parsing por notas y búsqueda por nombre;
- activar comandos atómicos e idempotentes;
- impedir edición directa de saldos.

### Fase D. Línea base

- conteo físico ciego;
- `opening_balance`;
- validación de stock y disponibilidad.

### Fase E. Limpieza

- comprobar cero referencias de código, vistas, funciones y triggers a las columnas
  legadas de `products` y a los empaques legados de `inventory_items`;
- eliminar esas columnas;
- eliminar código de compatibilidad;
- ejecutar asesores de seguridad y rendimiento.

## 11. Condición de aprobación

La migración SQL no se escribirá hasta revisar esta lista final:

- cada columna existente tiene decisión de conservar, reciclar, migrar o eliminar;
- cada tabla nueva cubre una brecha imposible de representar correctamente;
- no queda saldo en dos lugares;
- no queda selección comercial en notas;
- no queda reverso que borre historial;
- no se activa inventario sin conteo inicial.
