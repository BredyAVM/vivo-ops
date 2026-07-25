# Counter - Auditoría y diseño del Bloque 2

Fecha: 2026-07-24  
Módulo: `/app/counter`  
Estado: **cerrado y verificado el 2026-07-25**

## 1. Resultado

El Bloque 2 se diseñó como una base transaccional exclusiva para las operaciones
del mostrador. No agrega un dashboard, no cambia la experiencia visual y no toca
`/app/master/dashboard`.

La propuesta mantiene tres ejes independientes:

| Eje | Fuente canónica | Responsabilidad |
|---|---|---|
| Cumplimiento físico | `orders.status` | cocina, listo, en camino, entregado |
| Estado financiero | `payment_reports` + `money_movements` confirmados | evidencia, confirmación, saldo y deuda |
| Liquidación de delivery | `delivery_settlements` + sus entradas | custodia, cobro real, retornos y cambio pendiente |

`money_movements` continúa siendo la única verdad de saldo. Las tablas nuevas de
liquidación no calculan ni reemplazan balances de caja.

## 2. Evidencia de la auditoría previa

La revisión del esquema remoto encontró:

- `delivery_trips` tiene estructura de asignación y tarifa, no de custodia;
- `delivery_trips` no tiene filas, mientras existen más de mil órdenes
  entregadas;
- la asignación operativa vigente vive en `orders`;
- `money_movements` ya contiene estados, trazabilidad de aprobación y
  `movement_group_id`, pero no una clave de idempotencia completa;
- `payment_reports` ya obliga a que un reporte confirmado tenga su movimiento;
- no existía una estructura para retorno parcial o custodia entre turnos;
- la auditoría de duplicidad confirmó que `money_movements` ya contiene todo el
  ciclo necesario para solicitar, aprobar, rechazar y ejecutar devoluciones o
  gastos superiores al límite;
- se detectaron movimientos confirmados después de un cierre del mismo día, por
  lo que un filtro que use solo `movement_date > closure_date` puede omitirlos.

### Decisión sobre `delivery_trips`

No se amplía `delivery_trips`.

La tabla conserva su significado de viaje/asignación/tarifa. La nueva estructura
`delivery_settlements` representa únicamente la liquidación y custodia. Así no se
mezcla el costo del viaje con el dinero del cliente ni se crea una segunda
asignación de motorizado.

## 3. Persistencia propuesta

### 3.1 `counter_command_receipts`

Registra:

- actor;
- tipo de comando;
- clave de idempotencia;
- alcance de orden o cuenta;
- intención normalizada;
- resultado final.

La unicidad por actor, comando y clave evita que un doble clic o reintento
duplique dinero. Reusar una clave con otra intención produce error.

### 3.2 Autorizaciones reutilizando `money_movements`

No se crea una tabla paralela de autorizaciones. Se reutilizan los campos
existentes:

- `status`;
- `approval_required` y `approval_required_reason`;
- `reviewed_at` y `reviewed_by_user_id`;
- campos de rechazo;
- `movement_group_id`.

El gasto superior al límite crea un `money_movement` pendiente. Master/Admin
confirma o rechaza ese mismo movimiento.

Una devolución crea desde la solicitud sus movimientos pendientes agrupados. La
aprobación conserva esos movimientos pendientes pero revisados; la ejecución
confirma los mismos registros. No se duplican ni la autorización ni el egreso.

### 3.3 `delivery_settlements`

Persiste por orden:

- responsable de la custodia;
- asignación interna o externa capturada al despacho;
- fecha y actor del despacho;
- finalización del cobro real al cliente;
- estado `not_required`, `open`, `partial`, `settled`, `discrepancy` o `voided`;
- continuidad entre turnos y días.

### 3.4 `delivery_settlement_entries`

Es un historial append-only de:

- cobro esperado;
- cobro real informado;
- cambio en efectivo entregado al motorizado;
- retorno de efectivo;
- cambio digital pendiente;
- cambio digital confirmado;
- retorno de cambio o ajuste de custodia preparado para extensión controlada.

Toda entrada que mueve dinero físico o digital exige vínculo con
`money_movements`. Las entradas informativas no pueden fingir un movimiento de
caja.

## 4. Comandos atómicos

| Comando | Actor permitido | Efecto |
|---|---|---|
| `counter_apply_order_payments` | Counter, Master/Admin | varias líneas de pago, confirmación directa, cambio y fondo en una transacción |
| `counter_record_manual_movement` | Counter, Master/Admin | ingreso manual o gasto; gasto Counter mayor a USD 20 queda pendiente |
| `counter_request_refund` | Counter, Master/Admin | solicita devolución exacta y valida monto reembolsable |
| `counter_decide_authorization` | Master/Admin | aprueba o rechaza; confirma gasto aprobado |
| `counter_execute_refund` | Counter, Master/Admin | ejecuta solo una devolución aprobada |
| `counter_dispatch_delivery` | Counter, Master/Admin | cambia la orden a en camino y abre custodia con cambio/retorno esperado |
| `counter_record_delivery_return` | Counter, Master/Admin | registra cobro real y retorno parcial o total |
| `counter_complete_delivery_digital_change` | Master/Admin | confirma el cambio digital y su salida real del ledger |
| `counter_close_money_account` | Counter, Master/Admin | cierre exacto por timestamp sin transferencia automática |

Los comandos se crean en Bloque 2, pero se conectarán a la interfaz solo en el
bloque funcional correspondiente.

## 5. Reglas de consistencia

### 5.1 Pagos mixtos

- entre una y doce líneas por operación;
- cada línea valida cuenta, moneda, método y regla Counter vigente;
- efectivo y punto autorizados pueden confirmarse;
- transferencia, pago móvil, Zelle o wallet permanecen pendientes;
- el cambio de Counter solo sale de una caja física directa;
- cualquier excedente no entregado como cambio queda en el fondo del cliente;
- un error en cualquier línea revierte reportes, movimientos, cambio y fondo.

### 5.2 Delivery

- el despacho bloquea la orden antes de crear la liquidación;
- el cambio en efectivo produce egreso confirmado desde el despacho;
- el retorno produce reporte y movimiento confirmado en la misma transacción;
- el cobro real puede ser menor al esperado sin convertirlo en deuda del
  motorizado;
- la liquidación se cierra cuando lo realmente cobrado fue retornado;
- si el cobro se finalizó y queda efectivo bajo custodia, el estado es
  `discrepancy`;
- la deuda restante de la orden continúa separada y puede seguir con el asesor;
- el estado físico `delivered` continúa siendo decisión de Master.

### 5.3 Cierres

El corte usa:

```text
último contado
+ movimientos confirmados después del timestamp del ancla
- movimientos confirmados después del timestamp del ancla
= saldo esperado
```

También exige que `movement_date` no sea posterior a la fecha local del cierre.
Con esto se incluyen movimientos registrados después de un cierre anterior del
mismo día, incluso si conservan la misma fecha operativa.

El cierre de punto no crea una transferencia bancaria automática.

## 6. Concurrencia

Los comandos mantienen transacciones cortas y no hacen llamadas externas.

Orden de bloqueo:

1. recibo idempotente;
2. orden, si existe;
3. liquidación o grupo de movimientos, si aplica;
4. cuentas monetarias en orden ascendente de `id`;
5. cliente, cuando se acredita fondo.

Los cierres y los comandos monetarios nuevos bloquean la misma fila de cuenta.
Esto serializa el saldo relevante sin bloquear toda la tabla de movimientos.

## 7. Seguridad

- RLS está activo en todas las tablas nuevas;
- usuarios autenticados solo reciben lectura filtrada;
- no hay `INSERT`, `UPDATE` o `DELETE` directo para Counter;
- las mutaciones pasan por funciones estrechas;
- todas las funciones privilegiadas usan `search_path = ''`;
- `PUBLIC` y `anon` no pueden ejecutar los comandos;
- cada comando valida `auth.uid()` y el rol real;
- la función de detección de pagos duplicados también queda endurecida.

Referencias técnicas:

- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [PostgreSQL Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)

## 8. Archivos

- `COUNTER_BLOCK_2_ATOMIC_PERSISTENCE_2026-07-24.sql`: migración versionada;
- `COUNTER_BLOCK_2_TRANSACTION_TESTS_2026-07-24.sql`: pruebas con `ROLLBACK`;
- `COUNTER_BLOCK_2_ROLLBACK_2026-07-24.sql`: reversión previa a exposición.

## 9. Aplicación remota

Migraciones aplicadas:

- `20260725204313_counter_block2_atomic_persistence`;
- `20260725204543_counter_block2_closure_diagnostics`;
- `20260725204741_counter_block2_exact_confirmation_timestamps`.

La primera crea la persistencia y los comandos. Las dos siguientes conservan el
mismo contrato: amplían el diagnóstico de cierre y sustituyen la hora fija de
inicio de transacción por la hora real de confirmación monetaria. Esto permite
ordenar correctamente un cierre y un movimiento posterior aunque ambos se
ejecuten dentro de una sola transacción.

## 10. Verificación final

- existen exactamente tres tablas nuevas:
  `counter_command_receipts`, `delivery_settlements` y
  `delivery_settlement_entries`;
- no existe `counter_authorization_requests`;
- `money_movements` no recibió una columna de autorización paralela;
- RLS está activo en las tres tablas;
- `authenticated` no tiene permisos directos de mutación;
- todas las funciones privilegiadas usan `search_path = ''`;
- las firmas de autorización usan `movement_group_id`;
- la batería transaccional completa pasó y terminó con `ROLLBACK`;
- pagos mixtos, cambio, gasto superior al límite, devolución autorizada,
  liquidación parcial/multidía, reintentos y cierres consecutivos pasaron;
- dos sesiones concurrentes sobre una misma clave produjeron un solo recibo
  completado;
- el recibo técnico de concurrencia fue eliminado;
- las tres tablas quedaron con cero filas de prueba;
- TypeScript se verificó con `npx.cmd tsc --noEmit --pretty false`;
- no se modificó la interfaz de Counter ni `/app/master/dashboard`.
