# Bloque 15 — Disponibilidad por fecha para el catálogo

Fecha: 2026-08-08

Estado: aplicado en Supabase; contrato compartido preparado para Counter y
Asesor, sin modificar sus pantallas.

## Resultado

`inventory_catalog_availability_v1` evalúa el catálogo para una fecha y hora
obligatorias. La evaluación ocurre después de seleccionar la entrega y antes de
presentar o completar los productos.

El RPC recibe:

- `p_target_at`: fecha y hora de entrega;
- `p_product_ids`: lista opcional de hasta 200 productos; `null` evalúa todo el
  catálogo activo;
- `p_surface`: superficie operativa autorizada.

Devuelve un resultado por `product_id`, mensajes en español, capacidades en la
unidad comercial del producto y `inventory_blocks_submission: false` tanto en
la respuesta general como en cada producto.

## Estructura reutilizada

No se crearon tablas, columnas, índices ni triggers. La lectura reutiliza:

- `products` y sus políticas canónicas;
- `product_components` para combos fijos y seleccionables;
- `product_inventory_links` versión 1;
- `inventory_items` y sus aperturas;
- `inventory_planned_flows` para compromisos, entradas y producción;
- `inventory_recipes` e `inventory_recipe_components`.

La aplicación comparte los tipos y el normalizador de argumentos desde
`src/lib/inventory/availability.ts` para evitar que Counter y Asesor inventen
contratos distintos.

## Estados canónicos

- `not_tracked`: producto comercial que no mueve inventario, como Delivery.
- `outside_horizon`: fecha posterior al horizonte operativo de 10 días.
- `inventory_not_active`: el corte canónico todavía no ha sido activado.
- `configuration_pending`: configuración física incompleta o inconsistente.
- `selection_required`: el contenido configurable todavía no se conoce.
- `requires_opening`: falta el conteo físico del ítem requerido.
- `availability_unknown`: la evaluación automática no pudo completarse.
- `unavailable`: no existe capacidad protegida para la fecha.
- `relies_on_incoming`: la capacidad depende de reposición o producción futura.
- `low`: existe capacidad, pero algún ítem está en su nivel crítico.
- `available`: existe capacidad sin afectar compromisos confirmados.

Todos son estados informativos. Ninguno deshabilita productos ni impide enviar
una solicitud a Master.

## Productos y composiciones

- Productos directos se convierten a sus ítems físicos canónicos.
- Combos fijos calculan la capacidad del conjunto completo y quedan limitados
  por el componente con menor capacidad.
- Single Packs, Vivo Box y productos con componentes seleccionables devuelven
  `selection_required`; no se inventa una composición para aparentar stock.
- Los productos sin control transaccional devuelven `not_tracked`.
- Los medios servicios usan la regla real de cada producto. En servicios de 25,
  12 piezas permiten `0.5`; 11 piezas no.

La evaluación exacta de un configurable se hace después de guardar su selección
estructurada. El motor existente `inventory_preview_order_commitment_v1` vuelve
a resolver esa composición antes de que Master decida.

## Preparaciones

- Una receta inmediata puede sumar capacidad desde sus insumos disponibles.
- El stock ya preparado continúa disponible aunque durante una apertura parcial
  todavía falte contar algún insumo de la receta.
- Una receta programada, como prefritos, no usa el crudo como capacidad
  inmediata. Solo cuenta el prefrito almacenado o una producción planificada
  que ya tenga hora disponible.

## Fechas, compromisos y reposiciones

La capacidad protege todos los compromisos aprobados dentro del horizonte. La
respuesta separa:

- `available_without_affecting_confirmed`: disponibilidad para la fecha, que
  puede apoyarse en entradas o producciones previstas;
- `available_without_planned_incoming`: disponibilidad que no necesita esas
  entradas futuras;
- `depends_on_incoming`;
- `next_available_at`, cuando una fecha futura puede confirmarse mediante los
  flujos conocidos;
- `next_known_supply_at`, cuando existe un suministro próximo que todavía no
  garantiza por sí solo la disponibilidad completa.

Los pedidos posteriores a 10 días no consumen la lectura operativa actual.
Reciben `outside_horizon` y quedan para revisión posterior de Master.

## Superficies y permisos

- `advisor_availability`: Asesor, Master o Administración.
- `counter_inventory`: Counter, Master o Administración.
- `master_inventory` e `inventory_center`: Master o Administración.
- `admin_inventory`: únicamente Administración.

Asesor y Counter reciben la lectura comercial mínima. No reciben identificadores,
cantidades ni problemas internos de los ítems físicos. Master y Administración
reciben `internal_details` para explicar el componente limitante.

El asesor de Supabase marca intencionalmente el RPC como `security definer`
ejecutable por `authenticated`. El RPC valida `auth.uid()`, rol y superficie
antes de leer; `anon` y `PUBLIC` no tienen permiso de ejecución.

## Integración posterior en los otros módulos

1. Counter o Asesor exige fecha y hora antes del catálogo.
2. Construye los parámetros con `buildInventoryAvailabilityRpcArgs`.
3. Ejecuta `inventory_catalog_availability_v1` con su superficie.
4. Une la respuesta al catálogo mediante `product_id`.
5. Presenta `message`, capacidad y dependencia como información.
6. No oculta, deshabilita ni rechaza productos por este resultado.
7. Al enviar la orden, Master conserva la decisión final.

## Verificación

- 103 productos activos evaluados en una sola llamada.
- bebida agotada antes de una reposición y disponible dependiendo de ella después;
- próxima disponibilidad calculada desde el flujo esperado;
- receta inmediata propagada desde mayonesa y menjurje;
- combo fijo limitado correctamente por seis ítems físicos;
- medios servicios de 25 validados con 12 y 11 piezas;
- configurables identificados sin asumir contenido;
- fechas posteriores a 10 días aisladas del cálculo operativo;
- permisos de Asesor, Counter, Master y Administración verificados;
- ninguna mutación persistida por las pruebas;
- catálogo completo evaluado en aproximadamente 51 ms con apertura simulada.

