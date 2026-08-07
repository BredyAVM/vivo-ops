# Plan mínimo de migración de inventario

Fecha: 2026-08-04

Estado: baseline, Fase A estructural, clasificación, política de productos,
recetas canónicas y motor atómico v1 aplicados; saldo inicial y activación
operativa pendientes.

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

## 0.1. Ejecución del 2026-08-05: Bloque 1

Se reconcilió la matriz del 2026-07-30 contra el catálogo vivo. Desde aquella
extracción se habían eliminado 11 productos inactivos y se había creado Fanta
Naranja 1,5 Lts como producto 162 e ítem físico 76. El catálogo vivo quedó en
143 productos y 76 ítems, todos con una decisión canónica conocida.

Se aplicó `20260805144417_inventory_catalog_classification.sql`. La migración:

- clasifica 46 ítems como `transactional`, 29 como `not_tracked` y uno como
  `periodic_count`;
- asigna los 46 ítems operativos por turno a Cocina;
- mantiene `Cajas grandes` como conteo quincenal a cargo de Master;
- declara 23 alias históricos mediante `merged_into_item_id`, sin sumar ni
  trasladar saldos;
- configura objetivo 10 y vida útil de 90 días para los cinco prefritos de
  stock, y objetivo cero para el prefrito regular bajo demanda y el producto de
  cerdo estacional;
- configura alerta inclusiva en 10 unidades para 23 bebidas y alerta estricta
  por debajo de 10 para los cinco prefritos mantenidos;
- incorpora Fanta Naranja 1,5 Lts bajo las mismas reglas de bebida.

La prueba previa se ejecutó dentro de una transacción revertida. La verificación
posterior conservó exactamente las huellas de `current_stock_units`, las
políticas operativas de `products` y `product_inventory_links`; tampoco cambió
el número de productos, enlaces, recetas ni movimientos.

Las 143 políticas comerciales están resueltas en la matriz canónica, pero no se
reescribieron todavía en las columnas operativas de `products`. El consumidor
actual solo entiende `self/composition` y omite conversiones de unidad en parte
del flujo. Activarlas antes del cambio coordinado del motor produciría descuentos
incorrectos. No se tocó código de Master, Counter, Cocina ni Finanzas en este
bloque.

## 0.2. Ejecución del 2026-08-05: Bloque 2

Se aplicó `20260805164243_inventory_product_policy_staging.sql`. La auditoría del
consumidor real demostró que `products.inventory_deduction_mode` no es una
clasificación pasiva: el flujo heredado de entrega lo usa directamente para
descontar. Por eso no se amplió ni se reescribió esa columna.

La migración añadió únicamente los campos que el nuevo centro ya consume:

- `products.inventory_policy`, con `self`, `direct`, `components` o `none`;
- `products.inventory_configuration_status`, que deja productos nuevos en
  `draft` y hace visibles las configuraciones incompletas;
- `products.allows_half_service`, como regla comercial explícita;
- `product_inventory_links.configuration_version`, que separa los enlaces
  heredados de la configuración canónica;
- `product_inventory_links.deduction_stage`, que declara la etapa física futura.

Quedaron clasificados 143 productos: 56 `self`, 37 `direct`, 37 `components` y
13 `none`. Hay 138 listos y cinco pendientes técnicos ya identificados: dos
recetas de mostaza miel, dos packs abiertos de eventos/colegios y una corrección
del producto de cerdo estacional. Quince productos permiten medio servicio.

Se prepararon 103 enlaces canónicos para 93 productos. Todos tienen
`configuration_version = 1` e `is_active = false`. Los 107 enlaces heredados
siguen en versión 0, activos y sin cambios; `product_components` conserva sus 233
filas. La migración verificó dentro de la misma transacción que no variaran
saldos, movimientos, recetas, componentes ni campos heredados de descuento.

La nueva lectura está aislada en `/app/inventory/products`. No se añadió ninguna
consulta a la carga inicial de la dashboard ni se cambió código operativo de
Master, Counter, Cocina o Finanzas.

## 0.3. Ejecución del 2026-08-05: Bloque 3

Se aplicó `20260805171625_inventory_recipe_catalog_staging.sql`. Antes de
escribir se auditó el consumidor real y se encontró que la dashboard de Master
ya puede ejecutar toda receta con `is_active = true`, escribiendo movimientos y
saldos mediante llamadas separadas. Por eso las 13 recetas canónicas quedaron
guardadas con `is_active = false`; las dos recetas heredadas y sus tres
componentes permanecieron intactas y activas.

La configuración canónica incluye:

- seis transformaciones de crudo a prefrito, con 240 minutos y salida en
  servicios;
- tártara a granel desde mayonesa y menjurje;
- porcionado de tártara en 5, 2 y 1 oz;
- preparación de tártara por galón;
- un nuevo ítem físico interno para mostaza miel de 1 kg, reutilizando
  `inventory_items` e `inventory_item_presentations`;
- porcionado de mostaza miel en 5 y 2 oz.

También se cerraron los cinco pendientes técnicos del Bloque 2: las dos mostazas
quedaron enlazadas a receta, Evento se convirtió en composición abierta de cinco
familias fritas, Colegio quedó histórico y no inventariable, y la línea de cerdo
se corrigió a Pulled Pork estacional. Los 143 productos están ahora en estado
`ready`.

No se crearon tablas ni productos comerciales. El artículo especial del
restaurante no existe en el catálogo vivo y, por la regla de alcance, se
incorporará posteriormente mediante el configurador universal.

La migración conservó las huellas de saldos existentes, movimientos, enlaces de
producto, recetas heredadas y todos los componentes comerciales ajenos a Evento.
La lectura nueva está aislada en `/app/inventory/recipes`.

## 0.4. Ejecución del 2026-08-07: Bloque 4

Se aplicaron `20260807175917_inventory_atomic_engine_v1.sql`,
`20260807183124_inventory_read_access_hardening.sql` y
`20260807183841_inventory_opening_command_cleanup.sql`. No se creó una tabla de
operaciones: `inventory_movements.operation_id` ya representa la clave común e
idempotente y `reversal_of_movement_id` conserva el vínculo de reversión. La
apertura quedó disponible únicamente mediante el conteo trazable, sin un atajo
individual paralelo.

El motor v1 cubre apertura física, recepción y devolución, pérdidas, ajuste
administrativo, receta, reverso, conteo, aceptación y reconteo selectivo. Cada
comando valida usuario y rol, usa bloqueos transaccionales y actualiza kardex y
saldo de forma indivisible. Los hechos canónicos quedan inmutables.

La prueba se ejecutó primero dentro de transacciones revertidas. Después de la
aplicación, las huellas continuaron exactamente iguales: 77 ítems, 3.905
movimientos heredados, cero movimientos canónicos, 15 recetas y dos recetas
activas. Ningún ítem fue abierto y las 13 recetas canónicas siguen inactivas.

El rol anónimo perdió todos los privilegios sobre las diez tablas del dominio.
La lectura técnica nueva vive en `/app/inventory/operations` y solo se carga al
entrar. No se cambió código de Master, Cocina, Counter, Asesor ni Finanzas.

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

- `inventory_enabled`: se conserva temporalmente como interruptor heredado;
- `inventory_deduction_mode`: se conserva sin cambios mientras lo consuma el
  motor heredado; no es la autoridad canónica;
- campos comerciales como `type`, `is_combo`, `units_per_service`,
  `is_detail_editable`, `detail_units_limit` e
  `is_combo_component_selectable`.

La autoridad nueva es `inventory_policy`. La separación evita activar descuentos
antes de que el motor atómico pueda respetar cantidades, componentes y etapas.
Cuando el motor nuevo sea el único consumidor, se retirarán el interruptor y el
modo heredados tras demostrar cero dependencias.

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
también en `self_link`. El Bloque 2 agregó dos columnas necesarias para una
transición segura:

- `configuration_version`: versión 0 para el motor heredado y versión 1 para la
  configuración canónica preparada;
- `deduction_stage`: `kitchen`, `production`, `packing` o `fulfillment`.

También se agregan estas restricciones:

- cantidad mayor que cero;
- valores conocidos de `deduction_mode`;
- unicidad por producto, ítem y versión de configuración.

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

- clasificación de los 143 productos y 76 ítems vivos completada;
- enlaces canónicos versión 1 preparados e inactivos;
- recetas canónicas preparadas e inactivas; el catálogo físico contiene ahora 77
  ítems por la base comprada de mostaza miel;
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
