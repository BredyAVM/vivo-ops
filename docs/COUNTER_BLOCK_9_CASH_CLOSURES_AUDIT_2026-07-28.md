# Counter Block 9 - auditoría de cajas, puntos y cierres

Fecha: 2026-07-28  
Estado: cerrado en alcance técnico y de base de datos

## Resultado

El bloque completa la operación diaria de Caja Dark/DAR USD, Caja Dark/DAR
VES y puntos expresamente habilitados para Counter sin crear un libro mayor,
una caja o un cierre paralelo.

Se reutilizan como únicas fuentes:

- `money_movements`;
- `money_account_closures`;
- `money_account_closure_baselines`;
- `money_account_closure_profiles`;
- `counter_command_receipts`;
- reglas existentes de cuentas y roles.

No se creó ninguna tabla. Se agregó un único índice parcial para revisar la
ventana de gastos manuales del mismo operador y detectar fraccionamiento.

## Límites aplicados

- Counter ve únicamente Caja Dark/DAR USD, Caja Dark/DAR VES y los tres puntos
  activos autorizados.
- Floresta y las cuentas bancarias quedan fuera de la administración directa.
- Los movimientos manuales se limitan a las cajas DAR; los puntos reciben sus
  cobros mediante operaciones vinculadas a órdenes.
- Pagos, cambios y devoluciones no pueden registrarse como movimiento manual
  sin orden.
- Un gasto manual de hasta USD 20 equivalentes puede confirmarse directamente.
- Un gasto individual o acumulado que exceda el límite queda pendiente y no
  afecta el saldo.
- La tasa VES usada por el movimiento se obtiene de la tasa activa en servidor.
- Counter no puede retrofechar movimientos manuales.
- Solo Administración puede aprobar o rechazar un gasto manual pendiente.
  Master conserva su autoridad existente sobre autorizaciones vinculadas a
  órdenes, como devoluciones.
- Cajas y puntos cierran únicamente con diferencia cero.
- Un cierre de punto no crea un movimiento ni una transferencia bancaria.

## Lectura ligera

La pantalla inicial de `/app/counter` no carga caja.

Al abrir Caja se realiza una lectura acotada que devuelve:

- saldo exacto por cuenta desde el último cierre o baseline;
- entradas, salidas y neto del día;
- primeros 12 movimientos confirmados, con autor;
- cierre anterior;
- solicitudes pendientes, sin incluirlas en saldo.

El resto de movimientos del día se obtiene bajo demanda, 25 por página, con
cursor compuesto por `created_at` e `id`. No se cargan históricos de cuentas ni
se suman monedas distintas en un total referencial.

En la verificación remota con caché de base de datos:

- snapshot completo de las cinco cuentas: `14,790 ms`;
- primera página de movimientos de una cuenta: `7,114 ms`;
- lecturas físicas: `0` bloques en ambas mediciones.

## Persistencia y autoridad

Las acciones de caja dejaron de usar `SUPABASE_SERVICE_ROLE_KEY` y dejaron de
insertar directamente desde Next.js. Ahora usan la sesión del operador y RPC
transaccionales:

- `counter_record_manual_movement`;
- `counter_close_money_account`;
- `counter_read_cash_snapshot`;
- `counter_read_cash_movements`;
- `counter_decide_authorization`.

Todos los RPC sensibles son `SECURITY DEFINER`, fijan `search_path = ''`,
revocan ejecución a `anon` y validan `auth.uid()` y los roles permitidos dentro
de la función. El aviso del advisor sobre ejecución por `authenticated` es
intencional: la aplicación usa la sesión autenticada y la función aplica el
perímetro de autoridad antes de leer o escribir.

## Migraciones remotas

- `20260728142839_counter_block_9_cash_closures`
- `20260728143052_counter_block_9_legacy_pending_repair`

La segunda migración asignó grupo de autorización a tres solicitudes antiguas
que ya estaban pendientes. No modificó montos, estados, fechas ni saldos.

## Hallazgos de datos existentes

La lectura canónica detectó:

- `Punto BNC`: saldo `Bs -263.500,00`;
- `Punto BDV 1`: saldo `Bs -14.500,00`.

Los negativos provienen de consolidaciones administrativas registradas después
de cierres antiguos. No se fabricó un ajuste ni un baseline para ocultarlos.
Ambos puntos se muestran en Counter, pero el cierre queda bloqueado y marcado
para revisión administrativa hasta que Administración regularice el ledger
contra el saldo real.

También existían tres gastos pendientes antiguos sin grupo de autorización:
uno en Caja Dark/DAR VES y dos en Caja Dark/DAR USD. La reparación dejó los
tres decidibles por Administración y siguieron fuera del saldo.

## Pruebas aprobadas

`docs/COUNTER_BLOCK_9_TRANSACTION_TESTS_2026-07-28.sql` se ejecutó primero
junto con las definiciones nuevas y luego contra la migración instalada. En
ambos casos terminó con `ROLLBACK`.

Se verificó:

1. conjunto exacto de cinco cuentas visibles;
2. rechazo de advisor;
3. rechazo de banco y movimiento manual POS;
4. gasto menor confirmado;
5. gasto mayor pendiente;
6. pendiente sin efecto en saldo;
7. tasa VES tomada del servidor;
8. bloqueo de retrofecha;
9. detección de fraccionamiento `12 + 9`;
10. reintento idempotente sin duplicado;
11. Master no aprueba gasto manual;
12. Administración sí puede aprobarlo;
13. paginación sin solapamiento;
14. cierre exacto e idempotente;
15. rechazo de diferencia distinta de cero;
16. movimiento posterior a cierre del mismo día incluido;
17. cierre POS sin creación de transferencia.

Validaciones de aplicación:

- ESLint focalizado: aprobado;
- TypeScript `--noEmit`: aprobado;
- `git diff --check`: aprobado;
- build de producción Next.js: aprobado;
- sin cambios en `src/app/app/master/dashboard`.

## Reverso

`docs/COUNTER_BLOCK_9_ROLLBACK_2026-07-28.sql` elimina únicamente la función
de paginación y el índice nuevo. Los RPC existentes endurecidos son compatibles
con el cliente anterior y no deben degradarse, porque hacerlo reabriría límites
de autoridad ya corregidos. Los grupos asignados a solicitudes antiguas no
alteran hechos financieros y también se conservan.

## Próximo bloque

El siguiente trabajo es el Bloque 10: sincronización, alertas y resiliencia por
recurso, sin refrescar caja o históricos mientras sus espacios estén cerrados.
