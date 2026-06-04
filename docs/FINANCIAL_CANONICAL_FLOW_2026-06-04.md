# Flujo financiero canonico - VIVO Ops

Fecha: 2026-06-04

Este documento define el contrato base para pagos, movimientos, fondos, retenciones, redondeos, anulaciones y saldos de orden. La meta es dejar de resolver cada caso financiero desde la UI y mover la verdad del dinero a una capa unica y verificable.

## Principio central

`money_movements` es la fuente de verdad contable.

`payment_reports` es la solicitud, evidencia o declaracion de pago.

Una orden no esta pagada porque un reporte diga `confirmed`. Una orden esta pagada por la suma neta de movimientos financieros `confirmed` ligados a esa orden, mas aplicaciones de fondo registradas formalmente.

## Tablas principales

### `payment_reports`

Representa un pago reportado o una retencion reportada.

Estados canonicos:

- `pending`: reportado, aun no validado.
- `confirmed`: validado y convertido en movimiento financiero real.
- `rejected`: no cuenta como pago. Incluye rechazos y anulaciones operativas del reporte.

Regla: un reporte confirmado debe tener trazabilidad hacia al menos un movimiento financiero confirmado, normalmente por `money_movements.payment_report_id`.

### `money_movements`

Representa dinero real que afecta una cuenta.

Estados canonicos:

- `pending`: movimiento registrado pero no aprobado.
- `confirmed`: afecta saldo de cuenta y saldo financiero de orden.
- `rejected`: no afecta saldos.
- `voided`: fue confirmado o pendiente, pero se anulo dejando huella. No afecta saldos.

Regla: solamente `status = confirmed` cuenta para balances, cierres, pagos de orden y cobranza.

### `client_fund_movements`

Representa entradas y salidas del fondo del cliente.

Regla: no se debe cambiar `clients.fund_balance_usd` sin dejar una fila equivalente en `client_fund_movements`.

### `orders.extra_fields.payment`

Actualmente guarda datos como `client_fund_used_usd` y cierres por redondeo.

Regla futura: debe ser solo snapshot/resumen de conveniencia. No debe ser la fuente contable primaria.

## Saldo canonico de una orden

El saldo financiero de una orden debe calcularse asi:

```text
total_orden_usd
- suma_neta_money_movements_confirmed_de_la_orden
- aplicaciones_de_fondo_confirmadas
+ devoluciones_confirmadas_ligadas_a_la_orden
+ anulaciones/reversos_que_reabren_saldo
= saldo_pendiente_usd
```

Para bolivares antes de entrega:

```text
saldo_pendiente_bs
= snapshot_total_bs
- pagos_confirmados_en_bs_a_snapshot
- equivalentes_bs_de_pagos_confirmados_en_usd_si_aplican
```

Para cobranza posterior a entrega y fuera del dia de entrega:

```text
saldo_pendiente_usd * tasa_de_cobranza_aplicable
= monto_bs_a_cobrar
```

Regla critica: ninguna pantalla debe inventar su propio calculo de saldo. Master, asesor, pagos y detalle deben consumir el mismo resultado canonico.

## Flujos oficiales

### 1. Reportar pago

Entrada:

- orden
- cuenta destino
- metodo de pago
- moneda
- monto
- fecha de operacion
- referencia
- datos obligatorios segun metodo

Resultado:

- crea `payment_reports`
- no afecta cuenta todavia, salvo metodo auto-confirmado
- crea evento de timeline para master/admin y asesor

Reglas por metodo:

- `payment_mobile`: fecha, referencia, banco.
- `transfer`: fecha, referencia, banco.
- `zelle`: fecha, referencia, titular.
- `pos`: puede auto-confirmar si lo reporta rol autorizado del local.
- `cash_ves` / `cash_usd`: puede auto-confirmar si lo reporta rol autorizado del local/master/admin.
- `retention`: fecha, numero de factura, numero de comprobante.

### 2. Confirmar pago

Entrada:

- `payment_report_id`
- cuenta confirmada
- moneda confirmada
- monto confirmado
- fecha real del movimiento
- tasa si aplica
- notas de revision

Resultado atomico:

- `payment_reports.status = confirmed`
- crea `money_movements.status = confirmed`
- liga `money_movements.payment_report_id`
- guarda `payment_reports.confirmed_movement_id` con el movimiento financiero creado
- recalcula saldo de la orden
- si hay excedente, obliga decision: cambio, fondo o cierre por redondeo permitido
- crea evento `payment_confirmed`

Regla: confirmar pago debe ser una sola operacion atomica. No puede quedar reporte confirmado sin movimiento real ni sin `confirmed_movement_id`.

### 3. Rechazar reporte pendiente

Entrada:

- `payment_report_id`
- motivo

Resultado:

- `payment_reports.status = rejected`
- no crea movimiento
- crea evento `payment_rejected`

Regla: solo aplica si todavia no existe dinero confirmado.

### 4. Anular pago confirmado

Caso: se aprobo un pago pero luego se detecta error.

Entrada:

- `payment_report_id` o `money_movement_id`
- motivo obligatorio
- usuario admin

Resultado atomico:

- `money_movements.status = voided`
- `money_movements.voided_at/by/reason`
- `payment_reports.status = rejected` o estado equivalente visible como anulado
- `payment_reports.confirmed_movement_id = null`
- el pago deja de contar en saldo de cuenta
- el pago deja de contar en saldo de orden
- si ese pago genero fondo, se crea reverso de fondo
- crea evento `payment_voided`

Regla: no se elimina nada. Se conserva huella completa. Si el reporte queda en `confirmed`, debe tener `confirmed_movement_id`; si queda en `rejected`, no debe conservar `confirmed_movement_id`.

### 5. Aplicar fondo a orden

Entrada:

- orden
- cliente
- monto USD
- motivo/notas

Resultado atomico:

- crea `client_fund_movements.movement_type = debit`
- reduce `clients.fund_balance_usd`
- registra la aplicacion contra la orden
- afecta saldo de orden como pago no bancario

Regla futura: la aplicacion de fondo debe tener un registro propio consultable, no depender solo de `orders.extra_fields.payment.client_fund_used_usd`.

### 6. Enviar excedente a fondo

Caso: cliente pago de mas o se cancelo una orden ya pagada.

Resultado:

- crea `client_fund_movements.movement_type = credit`
- aumenta `clients.fund_balance_usd`
- conserva liga con orden/reporte/movimiento cuando exista

### 7. Devolver dinero al cliente

Resultado:

- crea `money_movements.direction = outflow`
- tipo sugerido: `withdrawal` o `refund`
- reduce saldo de cuenta
- puede estar ligado a orden y cliente
- si el dinero estaba en fondo, tambien crea `client_fund_movements.debit`

Regla: devolucion es movimiento financiero real, no cambio de estado invisible.

### 8. Retenciones

Retencion no es un pago ordinario del cliente. Es un documento que representa dinero disponible para impuestos.

Casos:

- La orden tiene saldo pendiente: la retencion puede cubrir parte del saldo.
- La orden ya esta cerrada: la retencion entra como excedente asociado a la orden/factura y exige decision: fondo o devolucion.
- El cliente paga sin IVA y luego entrega retencion: se registra como pago/compensacion especial contra esa orden.

Datos obligatorios:

- fecha
- numero de factura
- numero de comprobante
- monto

Resultado canonico:

- `payment_reports` con metodo `retention`
- al confirmar, crea `money_movements` hacia la cuenta de retenciones
- si genera excedente, se decide fondo/devolucion

### 9. Cierre por redondeo

Solo admin.

Regla:

- faltante maximo permitido: `0.09 USD`
- si falta dinero hasta ese limite, admin puede cerrar diferencia
- si sobra dinero, se mantiene el flujo actual de fondo/devolucion/cierre de excedente segun decision

Resultado:

- debe quedar registro auditable en `order_admin_adjustments`
- idealmente tambien debe existir movimiento/ajuste financiero canonico para que reportes no dependan solo de `extra_fields`

## Inconsistencias actuales detectadas

1. Master y asesor calculan saldos en varios lugares con reglas parecidas pero no identicas.
2. Algunas pantallas suman `payment_reports.status = confirmed`; otras suman `money_movements.status = confirmed`.
3. `client_fund_used_usd` vive en `orders.extra_fields`, lo cual funciona como snapshot pero no como ledger canonico.
4. Retencion se esta integrando como metodo, pero falta cerrar el contrato de confirmacion/anulacion/excedente.
5. Anulacion de movimiento confirmado esta en zona fragil porque el flujo debe actualizar reporte, movimiento, saldo de orden, saldo de cuenta y posibles fondos en una sola operacion.
6. Hay acciones en TypeScript y RPC en Supabase mezcladas; la frontera no esta suficientemente clara.

## Capa canonica propuesta

Crear o consolidar funciones centrales en Supabase:

- `report_order_payment(...)`
- `confirm_order_payment_report(...)`
- `reject_order_payment_report(...)`
- `void_order_payment(...)`
- `apply_client_fund_to_order(...)`
- `store_order_excess_to_fund(...)`
- `refund_order_money(...)`
- `register_order_retention(...)`
- `close_order_rounding_difference(...)`
- `get_order_financial_state(order_id)`

Las pantallas no deben calcular saldos por su cuenta. Deben leer `get_order_financial_state` o una vista/materializacion equivalente.

## Estado financiero unico recomendado

Crear una respuesta unica para cada orden:

```ts
type OrderFinancialState = {
  orderId: number;
  totalUsd: number;
  totalBs: number | null;
  confirmedPaidUsd: number;
  confirmedPaidBs: number | null;
  pendingUsd: number;
  pendingBs: number | null;
  pendingReportsUsd: number;
  hasPendingReports: boolean;
  hasVoidedPayments: boolean;
  hasRetentions: boolean;
  clientFundUsedUsd: number;
  overpaidUsd: number;
  roundingDifferenceUsd: number;
  paymentStatus: 'unpaid' | 'partial' | 'pending_review' | 'paid' | 'overpaid' | 'voided_or_reopened';
};
```

## Orden de implementacion

### Fase 1 - Diagnostico SQL

Crear consultas para detectar:

- reportes confirmados sin movimiento confirmado
- movimientos confirmados sin reporte ligado cuando deberian tenerlo
- movimientos voided que aun tienen reporte confirmed
- ordenes donde advisor y master podrian calcular saldos distintos
- fondos donde `clients.fund_balance_usd` no coincide con `client_fund_movements`

### Fase 2 - Funcion de estado financiero

Implementar `get_order_financial_state(order_id)` como fuente unica de saldo.

Primero usarla en Master dashboard. Luego Advisor home, Advisor pagos y Advisor detalle.

Primer SQL propuesto:

- `docs/ORDER_FINANCIAL_STATE_RPC_2026-06-04.sql`

Esta funcion recibe opcionalmente `p_operation_date` y `p_active_bs_rate` para respetar la regla de pagos en bolivares: antes o durante el dia de entrega usa el snapshot Bs congelado; despues del dia de entrega puede calcular cobranza dolarizada con tasa activa.

### Fase 3 - Rehacer confirmacion/anulacion

Centralizar:

- confirmar pago
- rechazar reporte
- anular pago confirmado
- registrar retencion

Todas deben ser atomicas y devolver resultado verificable.

### Fase 4 - Fondos y devoluciones

Mover aplicacion de fondo a ledger canonico. Mantener `orders.extra_fields.payment.client_fund_used_usd` solo como snapshot temporal o cache.

### Fase 5 - Limpieza de UI

Eliminar calculos duplicados en pantallas. La UI solo muestra:

- total
- confirmado
- pendiente
- reportes pendientes
- anulados
- fondos
- retenciones

## Reglas de no regresion

- Ningun pago confirmado puede existir sin movimiento contable real.
- Ningun movimiento `voided` puede contar en saldos.
- Ningun fondo puede cambiar sin `client_fund_movements`.
- Ninguna pantalla debe decidir por si sola si una orden esta pagada.
- Toda anulacion debe tener motivo, usuario y fecha.
- Toda diferencia por redondeo debe quedar auditada.
- Toda retencion debe estar ligada a factura/comprobante.
