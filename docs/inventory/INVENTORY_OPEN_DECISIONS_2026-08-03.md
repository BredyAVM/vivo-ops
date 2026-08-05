# Lista maestra de pendientes de inventario

Fecha: 2026-08-03

Esta es la única lista activa de trabajo. Una decisión ya confirmada no vuelve a
preguntarse salvo que el usuario solicite cambiarla o aparezca evidencia técnica
incompatible.

## Estado del catálogo actual

- 143 de 143 productos vivos tienen política canónica definida;
- 76 de 76 ítems vivos tienen clasificación canónica definida y aplicada en
  Supabase;
- no quedan preguntas de negocio del catálogo actual necesarias para continuar;
- los estados distintos de `confirmed` representan migraciones o correcciones
  técnicas conocidas, no respuestas faltantes del usuario.

## 1. Cerrar técnicamente el catálogo existente

Estado: **clasificación base aplicada; enlaces, recetas y composiciones en curso**.

- crear el ítem a granel de mostaza miel de 1 kg y enlazar sus recetas de 2 oz y
  5 oz reutilizando las tablas actuales;
- separar la empanada Pulled Pork estacional de la receta cruda del restaurante;
- convertir Evento/Colegio en una composición abierta y persistir la selección
  real de cada pedido;
- los 23 alias con objetivo físico ya tienen `merged_into_item_id`, sin sumar ni
  trasladar saldos; falta redirigir los enlaces cuando se active el motor nuevo;
- conservar Desayuno Woman y Crema de Leche únicamente como históricos;
- mantener `Cajas grandes` como ítem de conteo periódico. Sus valores operativos
  podrán editarse posteriormente desde el sistema y no bloquean esta fase.

## 2. Configuración universal de productos e ítems

Estado: **pendiente**.

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

## 3. Encaje con Supabase

Estado: **estructura mínima y clasificación del catálogo aplicadas**.

- reutilizar primero `products`, `product_components`, `inventory_items`,
  `product_inventory_links`, `inventory_recipes`,
  `inventory_recipe_components`, `inventory_movements` y
  `order_item_components`;
- identificar qué reglas caben en columnas actuales;
- justificar cada columna o tabla adicional antes de crearla;
- eliminar descuentos por coincidencia de nombre y notas interpretadas;
- mover los movimientos y saldos a comandos atómicos e idempotentes;
- mantener la trazabilidad mediante reversos, nunca borrando movimientos.

El detalle de reutilización, columnas legadas y cinco tablas nuevas justificadas
está en `INVENTORY_MINIMAL_MIGRATION_PLAN_2026-08-04.md`.

## 4. Migración y activación

Estado: **en curso**.

- clasificación de identidades aplicada; redirección de enlaces pendiente del
  cambio coordinado del motor;
- ejecutar conteo físico inicial;
- registrar `opening_balance` sin reinterpretar saldos históricos;
- probar venta, producción, recepción, pérdida, conteo, reverso y reservas;
- activar por etapas antes de conectar las vistas adaptadas de cocina, Master,
  Counter y Administración.

## Configuración diferida dentro del sistema

No son preguntas activas de este chat:

- consumibles que todavía no existen en el catálogo;
- proveedores, días de despacho y múltiplos de compra;
- mínimos, objetivos y frecuencias particulares que Administración pueda editar;
- tolerancias de alertas y calendarios que puedan configurarse por familia o ítem;
- capacidad simultánea de producción cuando se decida automatizarla.
