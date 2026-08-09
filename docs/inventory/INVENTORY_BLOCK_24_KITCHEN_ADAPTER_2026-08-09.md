# Bloque 24: adaptador operativo de Cocina

## Objetivo

Conectar Cocina al Centro Canónico de Inventario sin cargar datos de inventario
en la cola principal de pedidos y sin introducir bloqueos de órdenes.

El adaptador cubre:

- recepción física de mercancía;
- producción y preparación por receta;
- conteo ciego por turno;
- conteo puntual solicitado verbalmente por Máster;
- respuesta a solicitudes y reconteos abiertos;
- averías, mermas y pruebas de calidad.

## Auditoría previa

La revisión del repositorio y de Supabase confirmó:

- 54 ítems activos sin alias y 48 ítems con apertura aceptada;
- los mismos 48 ítems forman el programa de conteo por turno de Cocina;
- las tablas canónicas ya existentes son suficientes:
  `inventory_items`, `inventory_item_presentations`, `inventory_movements`,
  `inventory_lots`, `inventory_planned_flows`, `inventory_counts` e
  `inventory_count_lines`;
- las recepciones reutilizan `inventory_planned_flows` y `inventory_lots`, sin
  una tabla paralela de entradas;
- las averías, mermas y pruebas ya son tipos de `inventory_movements`;
- no existía una interfaz operativa de Cocina para estos comandos;
- no existían entradas, averías, mermas ni pruebas canónicas registradas al
  iniciar el bloque.

No se crearon tablas, columnas, vistas ni funciones nuevas. Tampoco se aplicó
una migración de Supabase.

## RPC reutilizados

| Operación | Autoridad canónica |
| --- | --- |
| Entrada física | `inventory_reconcile_receipt_v1` |
| Lectura de entradas y expectativas | `inventory_receipt_workspace_v1` |
| Inicio de preparación | `inventory_start_recipe_v2` |
| Terminación de preparación | `inventory_complete_production_v1` |
| Lectura de producción | `inventory_production_workspace_v1` |
| Conteo operativo | `inventory_submit_count_v1` |
| Reconteo abierto | `inventory_submit_staged_recount_v1` |
| Avería, merma o prueba | `inventory_record_loss_v1` |

Los RPC son `SECURITY DEFINER`, revocan ejecución de `public` y `anon`, y
validan el rol operativo mediante `auth.uid()` y `user_roles`. El adaptador
también vuelve a validar Cocina o Administración en cada Server Action.

## Rutas bajo demanda

La pantalla principal `/app/kitchen` conserva la cola de pedidos. Solo se añadió
un enlace **Inventario** con `prefetch={false}`.

El dominio operativo se divide para no cargar todo al mismo tiempo:

- `/app/kitchen/inventory`: guía de operación;
- `/app/kitchen/inventory/receipts`: entradas reales;
- `/app/kitchen/inventory/production`: preparaciones y lotes;
- `/app/kitchen/inventory/counts`: conteos ciegos;
- `/app/kitchen/inventory/losses`: averías, mermas y pruebas.

Cada ruta consulta Supabase únicamente al abrirse.

## Reglas operativas implementadas

### Entradas

- Cocina registra únicamente lo recibido físicamente.
- Puede capturar presentaciones completas y unidades sueltas.
- Si selecciona una expectativa de Máster, la cantidad real cierra esa
  expectativa aunque haya diferencia.
- Una entrada no planificada también queda permitida y trazada.

### Producción

- Reutiliza las recetas activas y sus tiempos.
- Una preparación programada no aumenta el producto terminado hasta cerrarse.
- La salida física real se declara al terminar el lote.

### Conteos

- El formulario nunca recibe ni muestra el saldo esperado.
- El programa de turno contiene los 48 ítems asignados a Cocina.
- Bolsas, cajas o paquetes se convierten a unidades base; también se aceptan
  unidades sueltas y fracciones operativas.
- Un conteo puntual permite registrar un solo ítem cuando Máster lo solicita
  personalmente.
- Las solicitudes abiertas y los reconteos selectivos se presentan sobre sus
  líneas pendientes.
- Al presentar, el saldo se ajusta inmediatamente a lo contado y el reporte
  queda `submitted` para revisión de Máster.

### Calidad

- `damage`: avería después de freír;
- `waste`: merma apartada antes de freír;
- `quality_taste`: cantidad exacta probada por control de calidad.

Las tres salidas descuentan inmediatamente. La nota es opcional; no se exige
foto ni explicación. Su reverso continúa reservado a Administración por el
motor canónico existente.

## Límites preservados

- No se modificó Máster, Counter, Finanzas ni el motor de órdenes.
- No se bloquea creación, aprobación, preparación ni entrega de pedidos.
- No se leen datos de inventario al cargar `/app/kitchen`.
- No se duplicó saldo, movimiento, lote, conteo o receta.

## Verificación

- ESLint de los componentes y acciones modificados: aprobado.
- Compilación de producción de Next.js: aprobada.
- La compilación reconoce las cinco rutas nuevas como dinámicas y bajo demanda.
- Prueba transaccional con un usuario de Cocina:
  - una prueba de calidad creó movimiento `-1`;
  - una entrada creó movimiento `+1` y lote de recepción;
  - un conteo creó movimiento de ajuste y encabezado `submitted` con responsable
    `kitchen`;
  - los tres movimientos conservaron el usuario actor.
- La transacción se revirtió y se confirmó:
  - saldo original restaurado;
  - cero movimientos, lotes y conteos de prueba;
  - cero órdenes o eventos de órdenes afectados.
- Un usuario con rol exclusivo de Asesor fue rechazado en entrada, conteo y
  pérdida; no se creó ningún movimiento.

La prueba reproducible está en
`INVENTORY_BLOCK_24_TRANSACTION_TESTS_2026-08-09.sql`.
