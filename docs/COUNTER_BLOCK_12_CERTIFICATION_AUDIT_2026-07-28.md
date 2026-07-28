# Auditoría del Bloque 12 - Certificación integral de Counter

Fecha: 2026-07-28

## 1. Resultado

La certificación técnica de Counter queda completada sobre esta historia:

```text
/app/counter
  -> Server Components y Server Actions exclusivos de Counter
  -> RPC autenticados de Supabase
  -> órdenes, cobros, custodia, caja y cierres canónicos
  -> relectura ligera de la superficie afectada
```

La salida operativa queda condicionada a dos validaciones humanas que no deben
simularse ni resolverse alterando el programa:

1. iniciar sesión en el navegador de prueba y firmar la aceptación visual en
   el monitor real del local;
2. disponer de un usuario con rol Counter puro. Los dos usuarios Counter
   activos encontrados también tienen rol `kitchen`.

No se retiraron roles ni se modificaron políticas de Cocina porque hacerlo
habría ampliado el alcance y podría afectar el módulo que se trabaja en
paralelo.

## 2. Hallazgos corregidos

### Despacho heredado

La RPC heredada:

```text
counter_dispatch_order(bigint, integer)
```

podía colocar una orden en `out_for_delivery` sin abrir liquidación, custodia,
cambio ni recibo idempotente. La aplicación ya no tenía consumidores de esa
RPC, pero `authenticated` todavía podía ejecutarla.

El Bloque 12 retiró su ejecución a `PUBLIC`, `anon` y `authenticated`. Se
conservó únicamente para `service_role` como superficie de recuperación. El
flujo operativo autorizado continúa siendo:

```text
counter_dispatch_delivery(uuid, bigint, integer, jsonb, jsonb, jsonb, text)
```

### Visibilidad directa de cuentas

La política anterior permitía a cualquier usuario autenticado leer las 16
cuentas activas. Un operador Counter podía ver 11 cuentas fuera de su perímetro
operativo aunque la interfaz consumiera el RPC filtrado.

La nueva política conserva la visibilidad anterior para usuarios que no tienen
rol Counter y limita a Counter a las cuentas directas configuradas. Resultado
real posterior a la migración:

| Rol probado | Cuentas activas visibles |
| --- | ---: |
| Counter | 5 |
| Counter fuera de perímetro | 0 |
| Advisor | 16 |
| Driver | 16 |
| Master | 16 |

Así se cierra la fuga de Counter sin cambiar el comportamiento de los otros
módulos.

## 3. Migración y reverso

Migración remota aplicada:

```text
20260728195653_counter_block12_certification_hardening
```

Archivos versionados:

- `docs/COUNTER_BLOCK_12_CERTIFICATION_HARDENING_2026-07-28.sql`;
- `docs/COUNTER_BLOCK_12_TRANSACTION_TESTS_2026-07-28.sql`;
- `docs/COUNTER_BLOCK_12_ROLLBACK_2026-07-28.sql`.

El reverso restaura exactamente la política y el permiso anteriores. Debe
usarse solo ante una regresión operativa comprobada porque vuelve a abrir las
dos fronteras corregidas.

## 4. Permisos

Pruebas ejecutadas:

- `anon` ve cero filas de órdenes, ítems, reportes, cuentas, movimientos y
  cierres;
- `anon` no ejecuta los comandos Counter;
- Counter, Master y Admin leen la configuración Counter;
- Advisor y Driver reciben `42501 counter_access_denied`;
- la RPC canónica de despacho permanece ejecutable por `authenticated`;
- la RPC heredada ya no es ejecutable por `authenticated`;
- Counter no ve cuentas fuera de su configuración directa.

La prueba de actualización directa de una orden con un usuario actual de
Counter sí encontró una fila actualizable porque ese usuario también posee rol
`kitchen`. No se atribuye esa capacidad al rol Counter y no se modificó Cocina.
La aceptación definitiva de la matriz de menor privilegio exige un usuario
Counter puro.

## 5. Prueba transaccional operativa

La prueba se ejecutó contra la base conectada y terminó íntegramente en
`ROLLBACK`. Cubrió:

- cobro en efectivo con cambio;
- dos ejecuciones con la misma clave idempotente y exactamente dos movimientos
  contables, sin duplicación;
- retiro pickup y reintento idempotente;
- pago de una orden ya entregada;
- despacho delivery con cobro esperado de USD 50 y cambio de USD 13;
- apertura atómica de la liquidación y cambio a `out_for_delivery`;
- retorno parcial de USD 30;
- retorno final de USD 20;
- reintento de la liquidación final sin duplicación.

Resultado:

```json
{
  "payment_change_idempotency": true,
  "pickup_completion": true,
  "delivered_order_payment": true,
  "delivery_custody_partial_final": true
}
```

Las capacidades restantes conservan la evidencia transaccional de sus bloques
de origen:

- caja, cambios, devoluciones y autorizaciones: Bloques 2 y 4;
- modificación y entrega pickup: Bloque 5;
- custodia, cambio mixto y retornos: Bloque 6;
- venta inmediata, agenda y cliente obligatorio: Bloque 7;
- histórico y pago de orden antigua: Bloque 8;
- gastos, caja, puntos y cierres: Bloque 9;
- reconexión, reintentos y lecturas por recurso: Bloque 10.

## 6. Invariantes de producción

La revisión agregada, sin exponer importes ni datos de clientes, devolvió:

| Invariante | Resultado |
| --- | ---: |
| Cuentas Counter operativas | 5 |
| Saldos negativos | 0 |
| Cuentas no listas para cierre | 0 |
| Últimos cierres con diferencia | 0 |
| Recibos idempotentes duplicados | 0 |
| Comandos `processing` estancados | 0 |
| Movimientos confirmados inválidos | 0 |
| Liquidaciones cerradas sin fecha | 0 |
| Liquidaciones abiertas con fecha de cierre | 0 |

## 7. Ligereza y precisión

La carga inicial de `/app/counter` conserva únicamente dos RPC en paralelo:

1. `counter_read_configuration`;
2. `counter_read_active_queue`.

Detalle, catálogo, caja, movimientos, liquidaciones e histórico permanecen
bajo demanda. No se añadió ninguna consulta de interfaz.

Métricas observadas en `pg_stat_statements`:

| RPC | Llamadas | Media | Máximo observado |
| --- | ---: | ---: | ---: |
| `counter_read_active_queue` | 116 | 12,30 ms | 67,48 ms |
| `counter_read_configuration` | 22 | 4,37 ms | 11,12 ms |
| `counter_read_order_detail` | 1 | 37,81 ms | 37,81 ms |
| `counter_search_orders` | 1 | 32,34 ms | 32,34 ms |
| `counter_read_cash_snapshot` | 1 | 31,55 ms | 31,55 ms |

Un `EXPLAIN ANALYZE` autenticado de la cola completa ejecutó en 29,53 ms con
cero lecturas físicas. El JavaScript inicial crudo declarado por el manifiesto
de la ruta permanece exactamente en 339.694 bytes; el Bloque 12 no aumentó el
bundle.

## 8. Logs

- Postgres registró la migración aplicada y las pruebas posteriores terminaron
  correctamente.
- Realtime no mostró eventos de error asociados a Counter en la ventana
  disponible.
- El conector no pudo recuperar los logs de API. Esta observación se repite en
  la ventana de salida, sin convertirla en motivo para añadir telemetría o
  consultas al módulo.

## 9. Validación de aplicación

- ESLint focalizado de `src/app/app/counter`: aprobado;
- TypeScript `--noEmit`: aprobado;
- `next build`: aprobado;
- manifiesto cliente de `/app/counter`: 339.694 bytes;
- archivos de `/app/master/dashboard`: sin cambios;
- componentes y consultas nuevas: ninguna;
- tablas o índices nuevos: ninguno.

El lint global conserva 120 errores y 69 advertencias en módulos ajenos a
Counter, principalmente Advisor, Master y rutas generales. No se corrigieron
en este bloque para respetar el aislamiento solicitado. El build y TypeScript
completos sí quedaron verdes.

## 10. Matriz de salida

| Criterio | Estado |
| --- | --- |
| Contratos RPC y permisos | Aprobado |
| Persistencia, idempotencia y saldos | Aprobado |
| Rendimiento y bundle | Aprobado |
| Lint focalizado, tipos y build | Aprobado |
| Migración y reverso | Aprobado |
| No tocar Master Dashboard | Aprobado |
| Usuario Counter puro | Pendiente operativo |
| Navegador autenticado y resoluciones reales | Pendiente operativo |
| Observación de logs API en ventana de salida | Pendiente operativo |

No se debe inventar un Bloque 13. Después del commit del Bloque 12 solo
corresponde completar estas verificaciones operativas y firmar la salida.
