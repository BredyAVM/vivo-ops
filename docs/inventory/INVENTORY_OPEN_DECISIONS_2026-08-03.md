# Lista maestra de pendientes de inventario

Fecha: 2026-08-03

Esta es la única lista activa de trabajo. Una decisión ya confirmada no vuelve a
preguntarse salvo que el usuario solicite cambiarla o aparezca evidencia técnica
incompatible.

## Estado del catálogo actual

- 144 de 144 productos vivos tienen política canónica definida y estado `ready`;
- 77 de 77 ítems vivos tienen clasificación canónica definida y aplicada en
  Supabase;
- no quedan preguntas de negocio del catálogo actual necesarias para continuar;
- los estados distintos de `confirmed` representan migraciones o correcciones
  técnicas conocidas, no respuestas faltantes del usuario.

## 1. Cerrar técnicamente el catálogo existente

Estado: **cerrado para el catálogo vivo**.

- el ítem a granel de mostaza miel de 1 kg y sus recetas de 2 oz y 5 oz ya están
  preparados;
- Pulled Pork estacional ya tiene identidad corregida; el producto del
  restaurante no existe en el catálogo y se creará posteriormente desde el
  configurador;
- Evento quedó como composición abierta de cinco familias y Colegio como
  histórico; la selección real de las partidas nuevas ya se congela en el
  snapshot canónico;
- los 23 alias con objetivo físico ya tienen `merged_into_item_id`, sin sumar ni
  trasladar saldos; los enlaces canónicos ya apuntan a identidades finales y
  permanecen inactivos hasta el cambio de motor;
- conservar Desayuno Woman y Crema de Leche únicamente como históricos;
- mantener `Cajas grandes` como ítem de conteo periódico. Sus valores operativos
  podrán editarse posteriormente desde el sistema y no bloquean esta fase.
- `Degustación Prefritos (8 und)` consume ocho piezas crudas y no servicios
  prefritos; su vínculo canónico ya evita el alias fusionado de mini tequeño.

## 2. Configuración universal de productos e ítems

Estado: **en curso; creación atómica de borradores aplicada y probada**.

Definir un asistente genérico que permita crear o reutilizar:

- producto comercial;
- ítem físico interno;
- unidad base y presentaciones de entrada;
- política `self`, `direct`, `components` o `none`;
- modo `transactional`, `periodic_count` o `not_tracked`;
- recetas, tiempos, almacenamiento y disponibilidad;
- umbrales, objetivos, programas de conteo y alertas.

No se levantará por chat el catálogo futuro de consumibles. Administración lo
incorporará progresivamente mediante este asistente.

La primera fase ya está disponible en `/app/inventory/configure` solo para
Administración:

- crea ítems internos con unidad, control, disponibilidad, conteo, umbrales y
  presentaciones;
- crea productos con política `self`, `direct`, `components` o `none`;
- reutiliza ítems canónicos y productos inactivos que no tengan historia de
  pedidos ni dependencias;
- guarda todo en una transacción como borrador inactivo, stock cero y sin
  conectar descuentos;
- no crea tablas ni columnas; solo añade una restricción de unicidad por índice
  para impedir duplicados concurrentes de identidad física.

Queda pendiente la segunda fase del asistente: validación final, apertura
incremental y activación segura; luego se incorporará la edición de recetas y
tiempos desde el mismo flujo.

## 3. Encaje con Supabase

Estado: **estructura mínima, clasificación, política, recetas, motor atómico,
resolución de venta y compromisos fechados aplicados**.

- reutilizar primero `products`, `product_components`, `inventory_items`,
  `product_inventory_links`, `inventory_recipes`,
  `inventory_recipe_components`, `inventory_movements` y
  `order_item_components`;
- identificar qué reglas caben en columnas actuales;
- justificar cada columna o tabla adicional antes de crearla;
- eliminar descuentos por coincidencia de nombre y notas interpretadas;
- comandos atómicos e idempotentes instalados para apertura, entradas, pérdidas,
  recetas, ajustes, conteos y reversos;
- resolución de órdenes instalada para productos directos, medios servicios,
  componentes fijos, selecciones, promociones y productos no inventariables;
- composición comercial congelada automáticamente y compromisos aprobados
  representados en `inventory_planned_flows` sin mover stock;
- trazabilidad canónica protegida mediante reversos, sin borrar movimientos.

El detalle de reutilización, columnas legadas y cinco tablas nuevas justificadas
está en `INVENTORY_MINIMAL_MIGRATION_PLAN_2026-08-04.md`.

## 4. Migración y activación

Estado: **en curso; apertura y corte aplicados y probados con `ROLLBACK`;
conteo físico real pendiente**.

- clasificación de identidades y enlaces versión 1 aplicada; activación pendiente
  del cambio coordinado del motor;
- 13 recetas canónicas preparadas; las dos heredadas continúan activas sin
  modificaciones hasta retirar el comando no atómico de Master;
- ejecutar conteo físico inicial;
- registrar `opening_balance` sin reinterpretar saldos históricos;
- producción, recepción, pérdida, conteo y reverso ya están probados de forma
  aislada; venta también está resuelta y probada, pero permanece desconectada;
- `order_item_components` ya se persiste al crear o modificar partidas y su
  escritura directa quedó cerrada;
- compromisos y dependencias fechadas ya protegen el horizonte móvil de diez
  días sin descontar físicamente pedidos futuros;
- la ruta independiente de apertura, la revisión y el reconteo selectivo están
  preparados sin nuevas tablas ni columnas;
- la venta canónica se activará solo cuando todos los ítems tengan apertura
  aceptada; actualmente continúa en `legacy`, sin afectar ni bloquear órdenes;
- activar por etapas antes de conectar las vistas adaptadas de cocina, Master,
  Counter y Administración.

## Configuración diferida dentro del sistema

No son preguntas activas de este chat:

- consumibles que todavía no existen en el catálogo;
- proveedores, días de despacho y múltiplos de compra;
- mínimos, objetivos y frecuencias particulares que Administración pueda editar;
- tolerancias de alertas y calendarios que puedan configurarse por familia o ítem;
- capacidad simultánea de producción cuando se decida automatizarla.
