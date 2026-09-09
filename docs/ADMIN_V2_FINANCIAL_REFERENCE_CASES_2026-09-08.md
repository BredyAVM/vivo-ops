# Casos financieros de referencia — Admin V2

Fecha de corte: 2026-09-08
Estado: especificación verificable del Bloque 0
Documento asociado: `docs/ADMIN_V2_KPI_DICTIONARY_2026-09-08.md`

Estos casos convierten el contrato financiero en resultados observables. Deben
servir para revisar consultas, fixtures, pruebas transaccionales, tarjetas,
drill-downs y exportaciones. No insertan ni corrigen datos.

## 1. Convenciones de prueba

- Zona horaria: `America/Caracas`.
- Período diario de referencia: 2026-09-08 00:00 a 2026-09-09 00:00.
- Semana de referencia: lunes 2026-09-07 a lunes 2026-09-14.
- Mes de referencia: 2026-09-01 a 2026-10-01.
- Solo movimientos `confirmed` afectan caja y saldo.
- Los montos USD se comparan a centavos.
- Los montos VES conservan el snapshot nativo exacto a centavos.
- Un resultado desconocido se espera como `null`/`Q4_blocked`, nunca `0`.
- Un KPI de posición siempre declara `as_of`.
- Los nombres e identificadores de los ejemplos son ficticios.

Cada prueba debe comprobar tres cosas:

1. el número visible;
2. la definición/calidad visible;
3. que el drill-down contenga exactamente las filas que explican el número.

## 2. Matriz rápida

| Caso | Comercial | Tesorería | Posición/Control |
| --- | --- | --- | --- |
| `RF-01` Anticipo y entrega posterior | Venta en fecha de entrega | Cobro en fecha de operación | Cartera al `as_of` |
| `RF-02` Reporte pendiente | Sin efecto comercial adicional | Cero caja | Tarea pendiente |
| `RF-03` Confirmación tardía de operación anterior | Sin mover venta | Flujo en fecha real, no revisión | Auditoría separada |
| `RF-04` Pipeline vs entrega | Pipeline antes; venta después | Independiente | Saldo de pedido activo |
| `RF-05` Impuesto | Base e impuesto separados | Entra total pagado | Cartera incluye obligación total |
| `RF-06` Transferencia interna | Sin venta | Sin ingreso externo duplicado | Cambio neto por fee |
| `RF-07` Valoración VES | Sin efecto | Equivalente histórico del movimiento | Valoración actual por tasa al corte |
| `RF-08` Snapshot VES exacto | Conserva precio de origen | Pago nativo exacto | Cierra USD y Bs juntos |
| `RF-09` Cobranza VES posterior | Venta histórica intacta | Operación con tasa del cobro | Cotización actual del pendiente |
| `RF-10` Excedente a fondo | Venta no aumenta | Entra todo el efectivo | Nace pasivo de cliente |
| `RF-11` Cambio mayor al excedente | Venta no cambia | Sale cambio real | Reabre saldo de orden |
| `RF-12` Void vs refund | Venta según estado real | Efectos diferentes | Auditoría preservada |
| `RF-13` Cierre bancario | Sin venta | Sin flujo creado por cierre | Diferencia abierta |
| `RF-14` Caja/POS | Sin venta nueva | Transferencia separada | Cero o ajuste formal |
| `RF-15` Comisión | Devengo por entrega | Pago por fecha de movimiento | Retenido, pagadero y saldo |
| `RF-16` Estado `paid` sin ledger | Sin cambio | Cero pago verificable | Anomalía, no saldo cero |
| `RF-17` Delivery | Cargo y costo separados | Pago solo con movimiento | Custodia no es remuneración |
| `RF-18` Inventario sin costo | Sin inferir margen | Sin gasto inventado | Valor monetario bloqueado |
| `RF-19` Frontera de período | Fecha comercial Caracas | `movement_date` | `as_of` explícito |
| `RF-20` Reintento y fallo parcial | Sin duplicados | Una sola operación | Todo o nada |

## 3. Casos detallados

### RF-01 — Anticipo, entrega y cobro final en días distintos

Datos:

```text
Orden O-101
Base comercial después de descuento: USD 100,00
Impuesto: USD 16,00
Total contractual: USD 116,00
Anticipo confirmado: USD 60,00 con movement_date 2026-09-06
Entrega real: 2026-09-08 10:00 -04:00
Pago final confirmado: USD 56,00 con movement_date 2026-09-09
```

Esperado:

| Consulta | Resultado |
| --- | --- |
| Comercial 2026-09-08 | C01 = 1; C02 = 100,00; C03 = 16,00; C04 = 116,00 |
| Tesorería 2026-09-08 | T01 = 0,00 |
| Tesorería 2026-09-06 | T01 = 60,00 |
| Posición al cierre del 2026-09-08 | P06 incluye USD 56,00 |
| Tesorería 2026-09-09 | T01 = 56,00 |
| Posición después del pago final | P06 para O-101 = 0,00 |

No se permite mostrar `Abonado del 8 = 60,00`. Es un anticipo del día 6
asociado a una venta entregada el día 8, no caja del día 8.

Si se consulta hoy la cohorte comercial del día 8, C07 puede mostrar cobertura
actual 116,00. Debe decir `actual al as_of`; no prueba que la orden estuviera
pagada el día 8.

### RF-02 — Reporte pendiente no es dinero

Datos:

```text
Reporte PR-201 creado 2026-09-08 11:00
Monto reportado: USD 50,00
operation_date declarada: 2026-09-08
status: pending
Sin money_movement confirmado
```

Esperado:

- T01 = 0,00.
- T08 = 1 reporte / USD 50,00 indicativos.
- Ningún saldo de cuenta aumenta.
- El saldo de la orden no se reduce como pago confirmado.
- El drill-down abre el reporte y la evidencia, no un movimiento inexistente.

### RF-03 — Confirmación tardía conserva fecha real de operación

Datos:

```text
PR-202 reportado el 2026-09-08
Operación bancaria real: 2026-09-08
Master confirma el 2026-09-09 09:00
Movimiento resultante: confirmed, movement_date 2026-09-08
Monto: USD 75,00
```

Esperado:

- T01 del 8 aumenta USD 75,00.
- T01 del 9 no aumenta por esta operación.
- `reviewed_at` del 9 aparece en auditoría.
- La productividad de revisión puede atribuirse al 9, pero no la caja.
- Si un período histórico se recalcula después de la confirmación, debe indicar
  su nueva hora de cálculo o que fue restatado por una operación retrofechada.

### RF-04 — Orden programada no equivale a venta entregada

Datos:

```text
Orden O-102 aprobada, total comercial sin impuesto USD 200,00
Programada: 2026-09-08
Entrega real: 2026-09-10
```

Esperado:

- El 8: C06 incluye una orden y USD 200,00; C01/C02 no la incluyen.
- El 10: C01 = 1 y C02 incluye USD 200,00.
- P07 muestra su saldo mientras permanece activa y no entregada.
- Un estado `queued`, `confirmed`, `in_kitchen`, `ready` o
  `out_for_delivery` no reconoce por sí mismo la venta como entregada.

### RF-05 — Base comercial, impuesto y total

Datos:

```text
Subtotal: USD 120,00
Descuento: USD 20,00
Subtotal después de descuento: USD 100,00
Impuesto de factura: USD 16,00
Total: USD 116,00
Orden entregada y pagada en el mismo día
```

Esperado:

- C02 = 100,00.
- C03 = 16,00.
- C04 = 116,00.
- T01 = 116,00 si el movimiento confirmado es por el total.
- C05 usa 100,00 como ticket comercial sin impuesto.
- P06 usa el pendiente de la obligación total de 116,00, no solo C02.

`Facturación neta = 116,00` y `Venta = 100,00` sin explicar impuesto son
presentaciones rechazadas.

### RF-06 — Transferencia interna con fee

Datos:

```text
Cuenta A: salida interna USD 100,00
Cuenta B: entrada interna USD 100,00
Fee bancario confirmado: USD 2,00
Mismo operation_id/grupo y movement_date 2026-09-08
```

Esperado:

- T02 = 0,00 por las patas internas.
- T03 incluye únicamente el fee USD 2,00.
- T04 = -2,00.
- T05 = una transferencia por USD 100,00, no USD 200,00.
- P01 de A cambia -102,00 y P01 de B +100,00.
- La posición consolidada cambia -2,00.

Si las patas tienen equivalentes USD distintos, la diferencia requiere una
clasificación FX separada. No se oculta ni se llama ingreso.

### RF-07 — Equivalente histórico no es valoración actual

Datos:

```text
Cuenta VES
Baseline: Bs 10.000,00; equivalente histórico USD 100,00
Entrada posterior: Bs 5.000,00 a tasa 125; equivalente almacenado USD 40,00
Saldo nativo al corte: Bs 15.000,00
Tasa activa al as_of: 150 Bs/USD
```

Esperado:

- P01 = Bs 15.000,00.
- Equivalente histórico de ancla + movimientos = USD 140,00, mostrado solo como
  referencia histórica de operación.
- P02, valoración actual = 15.000 / 150 = USD 100,00.
- P03 usa USD 100,00 si la cuenta pertenece al alcance de tesorería.

Sumar USD 140,00 como “saldo actual” falla el caso.

### RF-08 — Pago VES exacto de orden con precio de origen VES

Datos:

```text
Orden mixta con snapshot comercial exacto: Bs 15.000,00
Equivalente contable redondeado: USD 20,34
Pago antes o durante el día de entrega: Bs 15.000,00
```

Esperado:

- El cobro solicitado es Bs 15.000,00, no `20,34 × tasa`.
- El movimiento conserva monto nativo y tasa de operación/snapshot aplicable.
- `pending_bs = 0` y `pending_usd = 0` juntos.
- No queda residuo de USD 0,01 por redondeo.
- C02 conserva el snapshot comercial; la confirmación no repricing la orden.

### RF-09 — Cobranza VES posterior a la entrega

Datos:

```text
Orden ya entregada fuera del día de entrega
Saldo congelado: USD 10,00
Tasa aplicable a movement_date: 750 Bs/USD
```

Esperado:

- Cotización de cobro: Bs 7.500,00.
- Un pago exacto por Bs 7.500,00 cierra USD 10,00.
- La venta histórica no cambia.
- La UI declara modo `post_delivery_usd` y tasa 750.
- No usa el cociente entre totales ni la tasa snapshot original para inventar
  otro pendiente.

### RF-10 — Excedente almacenado como fondo del cliente

Datos:

```text
Total de orden: USD 45,17
Pago confirmado: USD 50,00
Decisión: guardar excedente en fondo
```

Esperado:

- T01 = USD 50,00 en la fecha del movimiento.
- C04 de la orden permanece USD 45,17.
- Pendiente de orden = 0,00.
- P04 aumenta USD 4,83.
- El subledger `client_fund_movements` contiene el crédito vinculado.
- P05 aumenta solo USD 45,17 por el efecto combinado, antes de otros pasivos.

El excedente no es una segunda venta ni ingreso libre.

### RF-11 — Cambio mayor al excedente disponible

Datos del ejemplo canónico:

```text
Orden: USD 45,17
Ingreso: USD 50,00
Cambio físico entregado: USD 5,00
Excedente respaldado: USD 4,83
```

Esperado:

- T01 registra +50,00.
- T03 registra `change_given` -5,00.
- El fondo cubre/debita solo 4,83 según la operación canónica.
- La orden vuelve a tener pendiente USD 0,17.
- No se cierra esa diferencia como redondeo automático.

La transacción completa debe ser atómica; un fallo no puede dejar el ingreso sin
el cambio o el fondo parcialmente actualizado.

### RF-12 — Anulación y devolución no son equivalentes

Escenario A, movimiento inválido:

```text
Pago USD 100,00 confirmado por error y luego voided por Admin
```

Esperado:

- El movimiento voided deja de contar en T01 y P01.
- No aparece un egreso refund.
- La orden recupera su pendiente.
- Reporte, fondo derivado y auditoría se sincronizan sin borrar filas.

Escenario B, dinero real devuelto:

```text
Pago real USD 100,00 el día 8
Refund real USD 100,00 el día 10
```

Esperado:

- T01 del 8 = +100,00.
- T09/T03 del 10 = 100,00 de salida.
- Ambos movimientos permanecen confirmados y vinculados.
- El neto de ambos días es cero, pero la historia no desaparece.

### RF-13 — Cierre bancario con diferencia clasificada

Datos:

```text
Ancla válida: USD 1.000,00
Entradas confirmadas del período: USD 300,00
Salidas confirmadas del período: USD 100,00
Esperado: USD 1.200,00
Saldo real contado: USD 1.190,00
```

Esperado:

- Cierre: expected 1.200,00; counted 1.190,00; difference -10,00.
- P01 usa 1.190,00 como nueva foto real después del cierre válido.
- P12 crea/muestra shortage abierto USD 10,00.
- El cierre no crea un gasto de USD 10,00 por sí solo.
- Resolver después conserva el cierre original y vincula nota/movimiento.

Si el cierre se rechaza, su conciliación no debe seguir como tarea activa. El
diagnóstico `A-P0-01` demuestra que esta invariante necesita certificación.

### RF-14 — Caja y POS requieren tratamiento propio

Caja:

```text
Esperado USD 500,00; contado USD 495,00
```

Esperado: no aprobar como cierre limpio. Debe existir conteo corregido o ajuste
formal auditado por USD 5,00.

POS:

```text
Recaudación del lote: Bs 20.000,00
Transferencia al banco: Bs 20.000,00
```

Esperado:

- La cuenta POS termina en cero después de la transferencia vinculada.
- La entrada al banco no aumenta T02.
- T05 muestra una transferencia interna.
- Si la implementación solo registra el snapshot POS, el cierre permanece con
  tarea `transferencia por vincular`; no se presume que el banco recibió.

### RF-15 — Comisión: devengo, retención, pagadero y pago

Entrada a la fórmula versionada:

```text
Carry de comisión: USD 5,00
Deuda previa del asesor: USD 2,00
Comisión bruta del período: USD 50,00
Deducción regalo: USD 5,00
Deducción directa: USD 3,00
Deuda pendiente de clientes: USD 20,00
```

Cálculo esperado:

```text
Crédito antes de deducciones = 5 + 50 = 55
Deducciones solicitadas = 2 + 5 + 3 = 10
Crédito después de deducciones = 45
Comisión retenida = min(45, 20) = 20
Pagadero = 45 - 20 = 25
Deuda saliente del asesor = 0
```

Resultados:

- P08 = 50,00 para el devengo bruto del período.
- P09 = 20,00 retenido.
- P10 = 25,00 una vez conformado.
- Un abono confirmado de USD 15,00 produce T10/T03 = 15,00 en su
  `movement_date` y P11 = 10,00.
- El pago no cambia P08 ni se atribuye como venta del día de pago.

### RF-16 — Cierre de comisión marcado `paid` sin pago verificable

Datos diagnósticos:

```text
closure.status = paid
payable_usd = 12,11
Suma de movimientos vinculados identificables = 0,00
```

Esperado:

- T10 = 0,00 verificable.
- P11 no fuerza saldo cero; devuelve anomalía `paid_without_ledger`.
- La tarjeta de comisiones muestra estado inconsistente.
- No se crea, infiere ni confirma movimiento desde la lectura.
- El drill-down enlaza el cierre y explica la ausencia de ledger.

Este caso representa `A-P0-03` y debe fallar mientras una pantalla confíe solo
en la palabra `paid`.

### RF-17 — Delivery: cargo, costo, payable, pago y custodia

Datos:

```text
Orden delivery entregada el 2026-09-08
Cargo comercial al cliente: USD 8,00
Costo snapshot del servicio: USD 5,00
Custodia devuelta por el motorizado: USD 100,00 de cobro al cliente
Sin movimiento de pago al motorizado
```

Esperado:

- El cargo de 8,00 forma parte de C02 si es una línea del subtotal comercial.
- P14 registra costo devengado USD 5,00 con `Q1_exact`.
- Una contribución delivery de USD 3,00 puede mostrarse solo porque cargo y
  costo tienen cobertura exacta.
- Los USD 100,00 de `delivery_settlements` son custodia/cobranza retornada, no
  remuneración del motorizado.
- T03 de pago al motorizado = 0,00.
- P15 permanece `Q4_blocked` si no existe subledger de payable/pago.

Si el costo de 5,00 proviene del catálogo actual y no del snapshot de la orden,
P14 pasa a `Q2_derived` y el agregado muestra cobertura explícita.

### RF-18 — Existencias sin costo conocido

Datos:

```text
Ítem abierto y contado: 25 unidades
Costo unitario/lote: inexistente
```

Esperado:

- Inventario operativo muestra 25 unidades con su estado de apertura.
- B01 valor de inventario = `null`, `Q4_blocked`.
- B02 COGS = `null`, `Q4_blocked`.
- B03/B04 margen y utilidad = `null`, `Q4_blocked`.
- No se usa precio de venta como costo ni se asigna costo cero.

Si el ítem no tiene conteo de apertura aceptado, incluso stock/disponibilidad se
mantienen nulos según el contrato de inventario; no son cero unidades.

### RF-19 — Frontera Caracas y posición histórica

Datos:

```text
Entrega: 2026-09-09 03:30 UTC = 2026-09-08 23:30 Caracas
Confirmación de pago: 2026-09-09 04:10 UTC
movement_date declarado: 2026-09-08
```

Esperado:

- C01/C02 pertenecen al día comercial 8.
- T01 pertenece al día de operación 8.
- `confirmed_at` pertenece al 9 en UTC, pero solo a auditoría.
- La semana es lunes 7 a domingo 13 de septiembre en Caracas.
- Una consulta posterior de la cohorte del 8 muestra estado de cobro actual
  solo si lo etiqueta con `as_of`.
- Sin reconstrucción temporal, B06 permanece bloqueado; no se afirma cómo se
  veía la cartera al final de un día pasado.

### RF-20 — Idempotencia, concurrencia y fallo parcial

Operación de referencia:

```text
Confirmar reporte de pago
Crear movimiento de ingreso
Entregar cambio
Acreditar excedente restante a fondo
Registrar evento
operation_id = UUID-X
```

Pruebas obligatorias:

1. Enviar UUID-X dos veces devuelve el mismo resultado y crea una sola operación.
2. Enviar UUID-X concurrentemente desde dos solicitudes deja una sola operación.
3. Inyectar fallo antes de cada efecto produce rollback total.
4. No puede quedar reporte `confirmed` sin movimiento confirmado.
5. No puede cambiar `clients.fund_balance_usd` sin su movimiento de fondo.
6. El evento puede ser parte del commit; una notificación externa puede ser
   best effort, pero no cambia el resultado financiero.
7. El read model después del commit cuadra C07, T01, P01 y P04.

Una compensación manual posterior no convierte un comando multietapa en
atómico. El caso solo pasa con todo o nada e idempotencia verificable.

## 4. Casos diagnósticos de corte que no modifican datos

### RF-D01 — Cobertura de baseline

Snapshot auditado: 16 cuentas activas, 14 con baseline activo.

Esperado:

- P13 = 14/16 = 87,5%.
- Las dos cuentas restantes muestran `sin baseline`.
- P01 de esas cuentas puede mostrar cálculo operativo `Q3_incomplete`, pero no
  badge de saldo reconciliado.

### RF-D02 — Conciliación ligada a cierre rechazado

Snapshot auditado: tres ítems abiertos con cierre fuente `rejected`.

Esperado:

- P12 los separa como `orphaned_source`.
- No aumentan silenciosamente la cola normal de conciliación válida.
- Un click abre cierre e ítem; la lectura no cambia ninguno.

### RF-D03 — Cobertura delivery histórica

Muestra auditada: 1.000 órdenes entregadas devueltas por la API; 487 con costo
explícito y 513 sin él.

Esperado:

- Cobertura explícita de la muestra = 48,7%.
- El costo agregado declara que es una muestra y no toda la población.
- Las filas con fallback catálogo son `Q2_derived`.
- Las filas sin costo ni fallback son `Q3_incomplete` y aportan `null`, no cero,
  al análisis de cobertura.

### RF-D04 — Política de autorización contradictoria

Datos:

```text
Egreso Master: USD 50,00
Dashboard legacy: regla desde USD 10
Master Ops vigente: auto-confirmación hasta USD 100 inclusive
```

Esperado bajo la política canónica vigente:

- El movimiento de USD 50,00 queda confirmado si cumple las demás reglas.
- Un egreso de USD 100,00 inclusive también puede quedar confirmado.
- Un egreso de USD 100,01 queda pendiente para Admin.
- El monto de comparación incluye fee y usa equivalente USD de la tasa indicada.
- La regla no se extrapola a transferencias ni cambio al cliente.

Hasta centralizarla, T07 debe mostrar la política que originó cada solicitud y
no fingir uniformidad histórica.

### RF-D05 — Estados reales de cierre

Snapshot auditado: 569 cierres, 554 `recorded`, 15 `rejected`, 0 `approved`.

Esperado:

- El tablero muestra esos estados reales.
- No etiqueta `recorded` como `approved`.
- No inicia una aprobación masiva para corregir una etiqueta.
- El equipo define primero si cero diferencia queda operativo como `recorded` y
  reserva `approved` para excepciones, o si habrá transición explícita.

## 5. Criterios de certificación

Un read model financiero de Admin V2 queda certificado cuando:

1. pasa todos los casos aplicables sin excepciones ocultas;
2. devuelve el mismo conjunto en tarjeta, drill-down y exportación;
3. no depende de límites de 500/1.000 filas para formar totales;
4. muestra la menor calidad presente en el agregado y su cobertura;
5. rechaza etiquetas que mezclen fecha comercial con fecha de movimiento;
6. excluye transferencias internas de ingreso/gasto externo;
7. no publica `Q4_blocked` como cero ni como estimación;
8. conserva snapshots, actor, motivo, fecha y vínculo de auditoría;
9. prueba permisos para `anon`, usuario autenticado sin rol, Asesor, Counter,
   Master y Admin según el contrato de cada lectura;
10. toda futura acción crítica pasa además RF-20 antes de habilitarse.
