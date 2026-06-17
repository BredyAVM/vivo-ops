# Politica canonica de gobernanza financiera - VIVO Ops

Fecha: 2026-06-16

Este documento define las reglas canonicas para manejar dinero, cuentas, pagos, cierres, diferencias, anulaciones y correcciones dentro de VIVO Ops.

La meta es permitir una operacion flexible y rapida sin perder trazabilidad, auditoria ni control.

Regla central:

```text
El sistema puede corregir, ajustar, anular, reabrir y conciliar.
El sistema no debe borrar ni cambiar silenciosamente la historia financiera.
```

## 1. Principios financieros del sistema

1. `money_movements` es la fuente de verdad para saldos de cuentas y efectos financieros reales.
2. `payment_reports` representa una declaracion, evidencia o solicitud de pago; no es dinero confirmado por si sola.
3. Un cierre es una foto de control de una cuenta en una fecha/hora. No crea la realidad financiera; documenta lo que el sistema esperaba, lo que existia realmente y las diferencias.
4. Ningun movimiento financiero confirmado se borra. Si fue error, se anula o reversa dejando auditoria.
5. Toda correccion financiera requiere usuario, fecha, motivo, valor anterior, valor nuevo y vinculo al origen cuando aplique.
6. Las diferencias no se esconden. Se clasifican, se arrastran como pendientes y se resuelven formalmente.
7. Cada tipo de cuenta tiene reglas propias de cierre. No todas las cuentas deben cerrar en cero.
8. Las pantallas deben mostrar el estado financiero canonico, no recalcular saldos con reglas locales.

## 2. Fechas oficiales

Cada fecha responde una pregunta distinta. No deben mezclarse.

| Fecha | Campo sugerido | Responde | Uso canonico |
| --- | --- | --- | --- |
| Fecha de operacion | `operation_date` / `movement_date` | Cuando ocurrio realmente el pago o movimiento en banco/cuenta | Banco, cierre, tasa, cobranza, conciliacion |
| Fecha de reporte | `payment_reports.created_at` | Cuando el asesor o usuario reporto el pago | Diligencia operativa, seguimiento del asesor |
| Fecha pedido/entrega | `orders.delivery_reference_date` o fecha efectiva de entrega/operacion | A que dia comercial pertenece la orden | Tasa snapshot, cobranza, reportes comerciales |
| Fecha de confirmacion | `confirmed_at` / `reviewed_at` | Cuando master/admin valido la informacion | Auditoria interna, no fecha financiera principal |
| Fecha de resolucion | `resolved_at` | Cuando una diferencia o pendiente fue identificado/resuelto | Conciliacion y trazabilidad |

Reglas:

- Para cierres y saldos de cuenta se usa fecha de operacion.
- Para medir al asesor se usa fecha de reporte.
- Para tasa/cobranza se compara fecha de operacion del pago contra fecha comercial del pedido.
- Fecha de confirmacion master es auditoria, no debe definir a que cierre pertenece el dinero.

## 3. Tipos de cuenta y reglas de cierre

| Tipo de cuenta | Ejemplos | Naturaleza | Regla de cierre |
| --- | --- | --- | --- |
| `bank` | Bancamiga, Venezuela, Banesco | Dinero real en banco | Puede cerrar con diferencia clasificada |
| `cash` | Caja chica USD/VES | Efectivo fisico | Debe cerrar en cero o con ajuste formal |
| `pos` | Punto de venta | Cuenta temporal de recaudacion | Debe cerrar en cero y generar transferencia interna al banco |
| `wallet_usd` | Binance, PayPal, Zinli, wallet USD | Saldo digital manejado operativamente en USD | Puede cerrar con diferencia clasificada por conversion, fee o pendiente |
| `retention` | Retenciones IVA/ISLR | Credito/documento fiscal por aplicar | Cierre por documentos recibidos, aplicados y pendientes |
| `fund` | Fondo del cliente | Saldo custodio por cliente | Debe coincidir con ledger de fondo |
| `other` | Cuenta especial | Segun definicion administrativa | Debe declarar regla antes de usarse en cierre |

## 4. Cierres por tipo de cuenta

### 4.1 Banco

Un cierre bancario compara:

```text
saldo final real del banco
- saldo esperado del sistema
= diferencia del cierre
```

El saldo esperado del sistema se calcula:

```text
saldo inicial del cierre anterior
+ entradas confirmadas con fecha operacion del periodo
- salidas confirmadas con fecha operacion del periodo
= saldo esperado
```

La diferencia se clasifica en:

- pagos no identificados
- comisiones/gastos bancarios no registrados
- transferencias internas no registradas
- errores de monto
- diferencias por tasa o conversion
- otro pendiente por revisar

Un banco puede cerrar con diferencia siempre que quede clasificada.

Estados sugeridos:

- `cuadrado`: diferencia cero.
- `cerrado_con_pendientes`: diferencia totalmente clasificada.
- `diferencia_sin_explicar`: queda monto sin clasificar.
- `aprobado`: admin valido el cierre.
- `reabierto`: admin reabrio para corregir.
- `anulado`: el cierre no debe usarse como referencia.
- `corregido`: existe cierre correctivo posterior.

### 4.2 Punto de venta

El punto es una cuenta temporal.

Cuando un cliente paga por punto:

```text
entrada en cuenta POS
```

Cuando se cierra el lote del punto:

```text
salida desde cuenta POS
entrada en banco receptor
```

Esto es una transferencia interna, no un nuevo ingreso.

Reglas:

- El punto debe cerrar en cero.
- Si no cuadra, queda `con diferencia` y no debe aprobarse hasta resolver o ajustar.
- Al aprobar el cierre, el sistema debe generar o vincular una transferencia interna POS -> banco.
- Si el banco recibe menos por comision, la diferencia se explica en el cierre bancario o como gasto/comision asociada.

### 4.3 Caja

Caja debe cerrar en cero contra conteo fisico.

Reglas:

- Si hay faltante o sobrante, debe registrarse ajuste formal con motivo.
- No debe aprobarse un cierre de caja con diferencia no explicada.
- Admin puede aprobar un ajuste de caja; master puede registrar el conteo.

### 4.4 Wallet USD

Aplica para Binance, PayPal u otras wallets manejadas operativamente en USD.

Reglas:

- Se permite cerrar en USD aunque internamente existan activos o saldos convertidos.
- La diferencia se clasifica como conversion, fee, entrada no identificada, salida no registrada u otro pendiente.
- No se exige cuadrar por activo en la primera version, salvo que administracion lo requiera luego.

Ejemplo:

```text
Saldo real Binance USD: 1,000.00
Saldo esperado sistema: 998.80
Diferencia conversion/fee: 1.20
Estado: cerrado con pendientes clasificados
```

### 4.5 Retenciones

Retenciones no son banco ni caja. Son documentos/creditos fiscales.

Entradas:

- cliente entrega retencion de IVA/ISLR u otro comprobante.

Salidas:

- administracion aplica el acumulado contra impuestos.

Cierre recomendado:

```text
retenciones recibidas
- retenciones aplicadas
= retenciones pendientes por aplicar
```

Cada retencion debe tener:

- cliente
- orden/factura cuando aplique
- tipo de retencion
- monto
- fecha de emision/operacion
- fecha recibida/reportada
- numero de comprobante
- estado: pendiente, aplicada, anulada

## 5. Diferencias y pendientes

Una diferencia no siempre es error. Puede ser informacion incompleta.

Tipos canonicos:

- `unidentified_payment`: pago recibido no identificado.
- `unregistered_fee`: comision/gasto no registrado.
- `unregistered_transfer`: transferencia interna no registrada.
- `conversion_difference`: diferencia por conversion o tasa.
- `amount_error`: monto reportado o registrado distinto.
- `timing_difference`: diferencia temporal.
- `manual_adjustment`: ajuste aprobado.
- `other_pending`: pendiente sin clasificacion final.

Regla:

```text
diferencia del cierre
- diferencias clasificadas
= pendiente sin explicar
```

Un cierre bancario o wallet puede aprobarse con pendientes clasificados, segun politica administrativa. Caja y punto no deben aprobarse con pendiente sin ajuste formal.

## 6. Pendientes heredados

Un cierre no debe olvidar diferencias anteriores.

Cada cierre debe distinguir:

1. movimientos del periodo actual
2. pendientes heredados abiertos
3. pendientes heredados resueltos durante el periodo
4. nueva diferencia del cierre

Ejemplo:

```text
Lunes:
Banco tiene +10,000 Bs no identificados.
Se crea pendiente abierto.

Martes:
Asesor reporta pago con fecha operacion lunes.
Admin vincula ese reporte al pendiente.
El pendiente queda resuelto martes, pero financieramente pertenece al lunes.
```

Regla:

- El cierre viejo no se borra ni se reescribe como si nunca hubo pendiente.
- El cierre viejo queda como foto historica.
- La resolucion se registra con fecha, usuario y vinculo al pago/movimiento que resolvio el pendiente.

## 7. Correcciones, anulaciones y reversos

No se debe borrar historia financiera.

Acciones permitidas:

| Accion | Uso | Efecto |
| --- | --- | --- |
| `void` / anular | El movimiento nunca debio existir o fue confirmado por error | Deja de contar en saldos y conserva huella |
| `reverse` / reversar | Se necesita compensar formalmente un efecto anterior | Crea movimiento de signo contrario o ajuste asociado |
| `refund` / devolver | El dinero si entro y luego salio hacia cliente/tercero | Crea egreso real |
| `reopen` / reabrir | Un cierre aprobado necesita revision | Cambia estado y exige motivo |
| `adjust` / ajustar | Hay faltante, sobrante, fee, conversion u otro ajuste | Crea movimiento o partida de ajuste auditada |
| `resolve_pending` | Una diferencia fue identificada | Vincula pendiente con reporte/movimiento/documento |

Caso: master confirma un pago por error.

No se elimina.

Flujo canonico:

```text
payment_report confirmado por error
money_movement confirmado por error
admin anula el movimiento con motivo
payment_report pasa a rejected/voided/reopened segun criterio UI
saldo de cuenta y orden se recalcula sin ese movimiento
queda evento de auditoria
```

Distincion critica:

- Anulacion: el movimiento nunca debio existir.
- Devolucion: el dinero si existio y luego salio realmente.

## 8. Permisos recomendados

| Accion | Master | Admin |
| --- | --- | --- |
| Registrar cierre | Si | Si |
| Aprobar cierre | No | Si |
| Reabrir cierre | No | Si |
| Anular cierre | No | Si |
| Crear ajuste financiero | Segun limite | Si |
| Anular pago confirmado | No | Si |
| Confirmar/rechazar reportes | Si | Si |
| Resolver pendientes | Si, si no afecta saldo aprobado | Si |
| Editar reglas de cierre | No | Si |

Los permisos pueden flexibilizarse, pero nunca se debe permitir una correccion financiera sin motivo y auditoria.

## 9. Primer cierre o linea base

Como VIVO Ops ya tiene operacion cargada antes de implementar cierres formales, el primer cierre debe funcionar como linea base.

Objetivo:

```text
fijar posicion desde una fecha/hora concreta
sin obligar a reconstruir perfectamente todo lo anterior
```

Reglas del primer cierre:

1. Se registra saldo real de cada cuenta.
2. Se calcula saldo esperado con lo que existe en sistema.
3. La diferencia inicial se clasifica como `baseline_difference` o categorias equivalentes.
4. Esa diferencia queda auditada y visible.
5. A partir de esa linea base, los cierres siguientes deben respetar el flujo canonico.

El primer cierre no debe esconder problemas previos; debe separarlos para que no contaminen la operacion futura.

## 10. Frecuencia recomendada

| Cuenta | Revision | Cierre formal |
| --- | --- | --- |
| Bancos de alto movimiento | 1-2 veces al dia | diario |
| Bancos de bajo movimiento | diario o interdiario | semanal/minimo mensual |
| Caja | cada turno o diario | diario |
| Punto | cada lote/cierre de punto | cada lote/cierre |
| Wallet USD | diario si hay uso alto, semanal si bajo | semanal/minimo mensual |
| Retenciones | revision semanal | mensual/periodo fiscal |

## 11. Estados canonicos

### Movimiento financiero

- `pending`
- `confirmed`
- `rejected`
- `voided`
- `reversed`

Solo `confirmed` afecta saldos.

### Reporte de pago

- `pending`
- `confirmed`
- `rejected`
- `voided`
- `reopened`

Un reporte `confirmed` debe tener un movimiento financiero confirmado vinculado.

### Cierre

- `draft`
- `registered`
- `with_difference`
- `approved`
- `reopened`
- `voided`
- `corrected`

### Pendiente de conciliacion

- `open`
- `partially_resolved`
- `resolved`
- `adjusted`
- `voided`

## 12. No regresion

Estas reglas no deben romperse en futuras implementaciones:

1. Ningun pago confirmado puede existir sin movimiento financiero real.
2. Ningun movimiento `voided` o `rejected` puede contar en saldos.
3. Ninguna diferencia puede desaparecer sin resolucion, ajuste o anulacion.
4. Ningun cierre aprobado se edita directamente; se reabre, anula o corrige.
5. Ningun traslado interno debe duplicar ingresos.
6. Punto y caja no se aprueban con diferencia no explicada.
7. Banco y wallet pueden cerrar con diferencia clasificada.
8. Retenciones se controlan por documentos, no por saldo bancario.
9. Fecha de confirmacion no reemplaza fecha de operacion.
10. Toda correccion financiera requiere motivo y auditoria.

## 13. Orden de implementacion recomendado

1. Crear cierre simple por cuenta con saldo real, saldo esperado y diferencia.
2. Agregar reglas por tipo de cuenta.
3. Agregar clasificacion de diferencias.
4. Agregar pendientes heredados y resolucion de pendientes.
5. Agregar aprobacion/reapertura/anulacion de cierres.
6. Agregar transferencias automaticas POS -> banco al aprobar cierre de punto.
7. Revisar reportes para usar fecha de operacion en cierres y tasa.
8. Crear vista de auditoria financiera por cuenta, orden y cierre.
9. Migrar/regularizar el primer cierre como linea base.

