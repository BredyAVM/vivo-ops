# Auditoría final del Bloque 3 - Capa de lectura ligera y exacta

Fecha: 2026-07-25

Alcance: exclusivamente `/app/counter` y funciones de lectura de Counter.

## Resultado

El Bloque 3 queda cerrado. Counter dejó de precargar caja, catálogo, componentes,
ítems y movimientos al abrir. La ruta inicial ejecuta dos lecturas lógicas en
paralelo:

1. configuración operativa;
2. cola activa.

El detalle de orden, la caja, el catálogo, las búsquedas y las liquidaciones se
leen únicamente bajo demanda.

El alcance funcional del Bloque 3 no modifica `/app/master/dashboard`.

## Medición anterior

La apertura anterior ejecutaba aproximadamente veinte lecturas físicas:

- perfil;
- hasta 120 órdenes;
- cuentas y reglas;
- hasta 500 productos;
- tasa;
- ítems de todas las órdenes;
- estado financiero de todas las órdenes;
- perfiles de asesores y motorizados;
- partners;
- movimientos de caja;
- cierres, baselines y movimientos históricos para calcular saldos;
- componentes de todos los productos;
- perfiles creadores de movimientos.

Además, `router.refresh()` repetía toda la ruta cada 30 segundos, al volver a la
pestaña, al recibir push y después de cada mutación.

## Contratos implementados

| Función | Propósito | Momento de lectura |
| --- | --- | --- |
| `counter_read_configuration()` | nombre del operador, tasa activa y cuentas/reglas de pago Counter | apertura |
| `counter_read_active_queue(limit)` | resumen operativo y financiero de órdenes activas | apertura y refresco de cola |
| `counter_read_order_detail(order_id)` | una orden con estado financiero e ítems | selección |
| `counter_search_clients(query, cursor, limit)` | búsqueda acotada de clientes | venta directa |
| `counter_search_orders(query, cursor, limit)` | búsqueda histórica profunda | solicitud explícita |
| `counter_read_cash_snapshot(limit)` | saldo exacto, resumen del día y página reciente por caja/POS | apertura de Caja |
| `counter_read_pending_settlements(cursor, limit)` | custodias delivery abiertas, parciales o con discrepancia | solicitud explícita |
| `counter_read_catalog()` | productos activos y componentes | nueva venta o agregar ítems |

## Decisiones de diseño

- No se creó ninguna tabla.
- No se creó ningún índice porque las consultas ya tienen índices compatibles.
- La cola reutiliza `orders_counter_operational_idx`.
- El detalle reutiliza `idx_order_items_order_id_id`.
- Las búsquedas reutilizan los índices trigram de órdenes y clientes.
- Caja reutiliza los índices de cuentas, cierres, baselines y movimientos.
- Liquidaciones reutiliza `delivery_settlements_operational_idx` y
  `delivery_settlement_entries_settlement_type_idx`.
- La verdad financiera sigue en `get_orders_financial_state`.
- El saldo de caja parte del último cierre o baseline y agrega únicamente
  movimientos confirmados posteriores.
- Catálogo se conserva en memoria durante la sesión del Counter una vez cargado;
  las acciones finales siguen revalidando datos en servidor.
- El refresco de 30 segundos actualiza únicamente la cola. No existe
  `router.refresh()` en Counter.

## Seguridad

Las ocho funciones:

- son `SECURITY DEFINER`;
- tienen `search_path = ''`;
- exigen `auth.uid()`;
- exigen rol `counter`, `master` o `admin`;
- revocan `EXECUTE` a `PUBLIC` y `anon`;
- conceden ejecución únicamente a `authenticated` y `service_role`.

El advisor de Supabase informa la advertencia genérica de funciones
`SECURITY DEFINER` ejecutables por usuarios autenticados. Es intencional en este
caso: cada función realiza el control de rol dentro de la función y las tablas
subyacentes no deben exponerse de forma amplia al Counter.

## Pruebas ejecutadas

### Datos y exactitud

- cola activa devuelta: 2 órdenes;
- productos activos bajo demanda: 111;
- componentes activos bajo demanda: 162;
- cajas/POS directos: 5;
- estados financieros de cola diferentes de la función canónica: 0;
- conteos de ítems de detalle diferentes de `order_items`: 0;
- saldos de caja diferentes del algoritmo canónico anterior: 0 de 5;
- diferencia máxima de saldos: 0,00;
- búsqueda histórica: 10 resultados en primera página y 10 en segunda;
- duplicados entre páginas: 0;
- búsqueda de nombre con acento usando término sin acento: aprobada para cliente
  y orden;
- liquidaciones pendientes existentes al probar: 0.

### Rendimiento de base de datos

Medido con `EXPLAIN (ANALYZE, BUFFERS)` y una sesión Counter:

| Lectura | Tiempo observado |
| --- | ---: |
| configuración | 4,522 ms |
| cola activa | 24,576 ms |
| caja exacta | 11,552 ms |
| búsqueda histórica | 18,475 ms |

La apertura inicial ejecuta configuración y cola en paralelo. Caja, catálogo,
detalle e históricos no participan en ese costo.

### Código

- `npx tsc --noEmit --incremental false`: aprobado.
- `npm run build`: aprobado con Next.js 16.2.6.
- Revisión React del flujo nuevo: carga bajo demanda, claves estables, limpieza
  de intervalos/eventos y estados de carga independientes.
- ESLint focalizado conserva errores históricos del componente monolítico
  (`Date.now()`/`Math.random()` usados para IDs de formularios). No fueron
  introducidos por el Bloque 3 ni se amplió el alcance para refactorizarlos.

## Migraciones remotas

- `20260725221330_counter_block3_light_read_model`
- `20260725223121_counter_block3_pending_settlement_read`
- `20260725224226_counter_block3_normalized_search`

## Trabajo concurrente protegido

Durante el bloque aparecieron cambios de otro chat en Master, Dashboard y
helpers compartidos. El trabajo concurrente publicó `CounterClient.tsx` y
`counter/actions.ts` dentro del commit `229f3a1`, que también contiene cambios
ajenos del otro módulo, y publicó los dos nuevos archivos de lectura en
`68327f4`. No se reescribió historia ni se tocaron los archivos del otro módulo;
el commit final del Bloque 3 queda limitado a la ruta inicial y su documentación.

## Siguiente bloque

Bloque 4 - Motor de caja registradora.

El siguiente bloque puede consumir esta capa para cobros simples, mixtos,
cambio y devoluciones sin volver a cargar la ruta completa.
