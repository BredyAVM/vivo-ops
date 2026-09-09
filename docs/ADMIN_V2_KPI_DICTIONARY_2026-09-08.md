# Diccionario canónico de KPI financieros — Admin V2

Fecha de corte: 2026-09-08
Estado: contrato documental del Bloque 0
Alcance: lectura financiera y ejecutiva del futuro módulo Administración

Este documento define qué significa cada cifra financiera que podrá mostrar
Admin V2. No crea tablas, no cambia datos y no autoriza nuevas operaciones.

Su propósito es impedir que una misma etiqueta mezcle ventas, cobros, saldos,
fechas o monedas distintas. Toda tarjeta, reporte, exportación y drill-down de
Admin V2 deberá poder demostrar que respeta este contrato.

## 1. Autoridad y fuentes normativas

Este diccionario se apoya en:

- `docs/FINANCIAL_CANONICAL_FLOW_2026-06-04.md`;
- `docs/FINANCIAL_GOVERNANCE_POLICY_2026-06-16.md`;
- `docs/FINANCIAL_OPERATIONS_MANUAL_2026-06-18.md`;
- `docs/FINANCIAL_CLOSURE_IMPLEMENTATION_PLAN_2026-06-16.md`;
- `docs/COUNTER_CANONICAL_CONTRACT_2026-07-24.md`;
- `docs/COUNTER_BLOCK_6_DELIVERY_AUDIT_2026-07-27.md`;
- `docs/inventory/INVENTORY_CANONICAL_CONTRACT_2026-07-30.md`;
- `docs/inventory/INVENTORY_BLOCK_14_REPORTING_2026-08-08.md`;
- `src/lib/orders/order-money.ts`;
- `src/lib/finance/account-balances.ts`;
- `src/lib/commissions/settlement-engine.ts`;
- `src/lib/commissions/closure-snapshot.ts`;
- `src/lib/commissions/payment-ledger.ts`;
- `public.get_order_financial_state(...)` y
  `public.get_orders_financial_state(...)` en las migraciones vigentes.

Si una pantalla, acción antigua o cálculo local contradice estas fuentes, la
contradicción debe mostrarse como diagnóstico. No se modifica este contrato
para hacer coincidir una cifra heredada.

## 2. Tres lentes que nunca se mezclan

### 2.1 Comercial

Responde qué se vendió, entregó o mantiene programado el negocio. Su eje
principal es la fecha comercial o de entrega, no la fecha del pago.

### 2.2 Tesorería

Responde qué dinero entró o salió realmente de las cuentas. Su fuente primaria
es `money_movements` y su eje es `movement_date`.

### 2.3 Posición

Responde qué tiene y qué debe el negocio en un instante de corte. No es un flujo
del día, semana o mes. Usa `as_of` y combina saldos de cuentas, cartera y pasivos
identificados sin presentarlos como ingresos o gastos del período.

Una selección visual de “día”, “semana” o “mes” puede modificar Comercial y
Tesorería. No debe convertir silenciosamente una posición actual en una
posición histórica. Si no existe reconstrucción histórica verificable, la
posición se etiqueta `Actual al corte`.

## 3. Convenciones globales

### 3.1 Zona horaria y ventanas

- Zona obligatoria: `America/Caracas`.
- Día: intervalo semiabierto `[00:00, 00:00 del día siguiente)`.
- Semana: lunes 00:00 hasta lunes siguiente 00:00.
- Mes: primer día 00:00 hasta primer día del mes siguiente 00:00.
- Rango personalizado: inicio inclusivo y fin exclusivo internamente. La UI
  puede mostrar ambas fechas como inclusivas si convierte el final al día
  siguiente antes de consultar.
- `as_of`: instante único de cálculo retornado por el servidor. Todas las
  tarjetas de una misma carga deben compartirlo.
- Mes en curso: `MTD`; una comparación justa usa el mismo número de días u horas
  transcurridas del período anterior y lo declara.

### 3.2 Ejes temporales oficiales

| Código | Eje | Campo o derivación canónica | Uso |
| --- | --- | --- | --- |
| `commercial_date` | Fecha comercial efectiva | Fecha/hora real de entrega; para legado, fallback declarado a programación | Ventas entregadas y comisión devengada |
| `scheduled_date` | Fecha programada | Snapshot de agenda de la orden | Pipeline, carga futura y compromisos |
| `movement_date` | Fecha real de operación | `money_movements.movement_date` | Cobros, egresos, tasas aplicadas, cierres y tesorería |
| `report_created_at` | Fecha de reporte | `payment_reports.created_at` | Diligencia y cola operativa; nunca caja |
| `reviewed_at` | Fecha de revisión | Confirmación o rechazo | Auditoría; nunca sustituye `movement_date` |
| `closure_at` | Corte de cuenta | `money_account_closures.closure_at` | Foto y conciliación de cuenta |
| `resolved_at` | Resolución | Pendiente de conciliación | Auditoría de resolución, no reescritura del cierre |
| `calculation_cutoff_at` | Corte de cálculo | Snapshot de comisión | Reproducibilidad de liquidación |

La jerarquía de `commercial_date` para órdenes entregadas debe devolverse desde
un read model canónico. Debe priorizar la marca real de finalización. Cuando una
orden heredada solo tenga fecha programada o creación, la fila se marca como
`derived_legacy`; no se presenta esa fecha como entrega observada.

### 3.3 Monedas y tasas

| Contexto | Regla |
| --- | --- |
| Venta comercial | USD comercial y Bs snapshot de la orden; descuento incluido e impuesto separado |
| Orden antes o durante el día de entrega | Usa el snapshot exacto en Bs y la tasa snapshot almacenada |
| Cobranza posterior a la entrega | Saldo USD congelado por tasa activa/aplicable a `movement_date` |
| Movimiento real | Moneda nativa, monto nativo, tasa de la operación y `amount_usd_equivalent` almacenado |
| Cierre | Moneda nativa y tasa capturada por el cierre |
| Posición VES actual | Saldo nativo VES dividido entre la tasa de valoración vigente al `as_of` |
| Comparación histórica | Usa snapshots históricos; nunca la tasa activa de hoy para reescribir el pasado |

Está prohibido tratar `total_bs / total_usd` como tasa. Una orden puede tener
precios de origen VES, precios de origen USD y redondeos por línea.

Los agregados se calculan con precisión de base y se redondean para presentación
al final. No se suman valores ya formateados.

### 3.4 Estados financieros

- Solo `money_movements.status = confirmed` afecta tesorería y saldos.
- `pending`, `rejected` y `voided` no afectan saldos.
- Un `payment_report` pendiente es evidencia por revisar, no dinero.
- Una orden cancelada no genera venta comercial entregada.
- Un cierre es una foto de control, no un ingreso, egreso o ajuste por sí mismo.
- Un traspaso interno no es ingreso ni gasto externo.
- Un refund es una salida real; un void elimina el efecto contable de un registro
  inválido; un reversal compensa formalmente otro movimiento. No son sinónimos.

### 3.5 Calidad obligatoria

Cada KPI y cada fila de detalle debe devolver una clasificación de calidad.

| Código | Estado | Significado y presentación |
| --- | --- | --- |
| `Q1_exact` | Exacto canónico | Fuente estructurada, vínculos completos y sin fallback |
| `Q2_derived` | Derivado declarado | Cálculo reproducible, pero usa fallback o clasificación legacy visible |
| `Q3_incomplete` | Cobertura incompleta | El total se muestra con numerador, denominador y advertencia; no se presenta como completo |
| `Q4_blocked` | No publicable | Falta una dependencia contable o vínculo esencial; se muestra “No disponible”, nunca cero |

`0` significa un valor medido igual a cero. `null` significa desconocido o no
aplicable. La UI no convierte `null` en `0`.

### 3.6 Contrato mínimo de respuesta

Todo KPI debe transportar, aunque algunos campos no sean visibles en la tarjeta:

```text
kpi_id
value
native_currency, si aplica
display_currency
period_start
period_end_exclusive
as_of
time_axis
statuses_included
statuses_excluded
rate_basis
tax_basis
quality_code
coverage_numerator
coverage_denominator
drill_down_route
definition_version
```

El drill-down debe reutilizar el mismo período, `as_of`, filtros y versión de
definición que la tarjeta.

## 4. Diccionario — Comercial

| ID y etiqueta aprobada | Fórmula | Fuente y filtro | Eje | Moneda | Calidad | Drill-down mínimo |
| --- | --- | --- | --- | --- | --- | --- |
| `C01` Órdenes entregadas | `count(distinct order_id)` | Órdenes con estado `delivered`; excluir canceladas y registros sin identidad | `commercial_date` | Conteo | Q1 si hay finalización real; Q2 con fallback legacy | Órdenes con fecha efectiva/fallback, estado, cliente, asesor y total |
| `C02` Ventas entregadas sin impuesto | `sum(subtotal_after_discount_usd)` | Órdenes de `C01`; helper canónico `getOrderCommercialNetUsd` | `commercial_date` | USD; Bs snapshot opcional separado | Q1/Q2 según fecha | Orden, subtotal, descuento, impuesto, total y origen de fecha |
| `C03` Impuesto facturado de ventas entregadas | `sum(invoice_tax_amount_usd)` | Snapshot de pricing de órdenes de `C01` | `commercial_date` | USD y Bs snapshot en columnas separadas | Q1 si snapshot existe; Q3 con cobertura | Orden, porcentaje, base, impuesto USD/Bs y documento |
| `C04` Total contractual de órdenes entregadas | `sum(total_usd)` | Total financiero snapshot de órdenes de `C01` | `commercial_date` | USD; Bs snapshot separado | Q1/Q2 | Orden, base comercial, impuesto, redondeo y total |
| `C05` Ticket comercial promedio | `C02 / C01`, si `C01 > 0` | Mismo conjunto de `C01` y `C02` | `commercial_date` | USD por orden | Hereda la menor calidad de C01/C02 | Mismo detalle de C02 y pie reconciliado |
| `C06` Pipeline programado activo | `sum(subtotal_after_discount_usd)` y conteo | Órdenes no entregadas/no canceladas ya aprobadas o en ejecución, agrupadas por `scheduled_date` | `scheduled_date` | USD comercial; impuesto aparte | Q1 si agenda snapshot completa | Órdenes, estado operativo, fecha programada, pendiente y alertas |
| `C07` Cobertura actual de órdenes entregadas del período | `sum(clamp(total_usd - pending_usd, 0, total_usd))` | Estado de orden retornado por `get_orders_financial_state` para la cohorte `C01` | Cohorte por `commercial_date`; posición al `as_of` | USD de obligación | Q1 actual; Q4 para reconstrucción histórica no soportada | Órdenes con total, movimientos, fondo, redondeo y pendiente |
| `C08` Saldo actual de órdenes entregadas del período | `sum(pending_usd)` | Estado financiero canónico de la cohorte `C01` | Cohorte por `commercial_date`; posición al `as_of` | USD; cotización Bs separada | Q1 actual; Q4 histórico sin ledger temporal | Órdenes con antigüedad, estado de cobro, reportes pendientes y movimientos |
| `C09` Órdenes canceladas | Conteo; importe solo como exposición cancelada, no venta | Evento/estado canónico de cancelación y snapshot de orden | Fecha del evento de cancelación | Conteo y USD informativo | Q1 si existe evento; Q3 si solo estado actual | Orden, fecha original, cancelación, pagos, fondo o refund |

Reglas de etiqueta:

- `C02` no se llama “Facturación neta” porque no descuenta necesariamente
  refunds o notas de crédito posteriores.
- `C07` no se llama “Abonado del día”: puede incluir anticipos de días previos.
- `C08` no se llama “Pendiente del día”: es el pendiente actual de una cohorte
  comercial.
- Una orden programada pero no entregada pertenece a `C06`, no a `C02`.

## 5. Diccionario — Tesorería

La clasificación de flujo externo e interno debe ser estructurada. Mientras un
movimiento legacy dependa del texto de `description`, el resultado no supera
`Q2_derived`.

| ID y etiqueta aprobada | Fórmula | Fuente y filtro | Eje | Moneda | Calidad | Drill-down mínimo |
| --- | --- | --- | --- | --- | --- | --- |
| `T01` Cobros confirmados de órdenes | `sum(amount_usd_equivalent)` y suma nativa por moneda | `money_movements`: `confirmed`, `inflow`, `order_payment` | `movement_date` | Nativo por cuenta y USD equivalente de operación | Q1 | Movimiento, orden, reporte, cuenta, monto, tasa, referencia y confirmación |
| `T02` Otros ingresos externos confirmados | Suma de inflows externos no incluidos en T01 | Movimientos confirmados con clasificación externa; excluir transferencias internas | `movement_date` | Nativo y USD equivalente de operación | Q1 estructurado; Q2/Q3 legacy | Movimiento, categoría, contraparte, cuenta, documento y tasa |
| `T03` Egresos externos confirmados | Suma de outflows externos confirmados | Gastos, refunds, cambio entregado, pagos de comisión y otros egresos; excluir pata de transferencia interna | `movement_date` | Nativo y USD equivalente de operación | Q1 si categoría/vínculo estructurado | Movimiento, categoría, origen, cuenta, documento y aprobador |
| `T04` Flujo neto externo | `T01 + T02 - T03` | Mismos conjuntos y período | `movement_date` | USD equivalente de cada operación; nativo por moneda en detalle | Hereda la menor calidad de T01–T03 | Tres pestañas reconciliadas y transferencias excluidas visibles aparte |
| `T05` Traspasos internos ejecutados | Conteo de operación y monto de una sola pata origen | Grupo/entidad de transferencia con salida e ingreso vinculados; no sumar ambas patas como volumen | `movement_date` | Nativo origen/destino; USD de operación | Q1 estructurado; Q2 legacy por grupo/texto | Transferencia, patas, cuentas, tasas, fee y diferencia FX |
| `T06` Comisiones y fees pagados | `sum(amount_usd_equivalent)` | `money_movements`: `confirmed`, `outflow`, `fee_charge` | `movement_date` | Nativo y USD equivalente de operación | Q1 | Movimiento fee y operación/grupo que lo originó |
| `T07` Operaciones pendientes de aprobación | `count(distinct operation_id o movement_group_id)` y monto solicitado | Movimientos `pending`; no incluir en caja | Fecha de creación para cola; `movement_date` informativa | USD equivalente solicitado y nativo | Q1 si operación agrupada; Q2 si solo movimiento | Solicitud, creador, cuenta, monto total con fee, antigüedad y razón |
| `T08` Reportes de pago pendientes | Conteo y `sum(reported_amount_usd_equivalent)` indicativo | `payment_reports.status = pending` | `report_created_at`; mostrar `operation_date` por separado | Moneda reportada y equivalente declarado | Q1 como cola; nunca dinero | Reporte, orden, cuenta reportada, evidencia, fecha operación y antigüedad |
| `T09` Refunds confirmados | Suma de salidas reales clasificadas `refund` y vinculadas al origen | Movimiento confirmado con relación estructurada al pago/fondo/orden | `movement_date` | Nativo y USD equivalente | Q4 mientras refund comparta taxonomía ambigua `withdrawal`; Q1 después | Refund, pago origen, orden/cliente, cuenta, motivo y aprobador |
| `T10` Pagos de comisión ejecutados | Suma de movimientos de pago vinculados a cierre de comisión | Movimiento confirmado con `commission_closure_id` o vínculo equivalente | `movement_date` | Nativo y USD equivalente | Q4 para total definitivo basado solo en texto; Q2 diagnóstico legacy | Movimiento, cierre, período, asesor, fee y saldo posterior |

Reglas:

- `payment_reports.created_at` mide reporte, no entrada de caja.
- `confirmed_at` mide revisión, no período financiero.
- Un POS que consolida hacia un banco no produce un segundo ingreso.
- Una diferencia de conversión entre patas de un traspaso necesita categoría FX;
  no se oculta dentro de `T04`.
- Las operaciones `pending` se muestran como tarea, nunca en flujo realizado.

## 6. Diccionario — Posición al corte

| ID y etiqueta aprobada | Fórmula | Fuente y filtro | Eje | Moneda | Calidad | Drill-down mínimo |
| --- | --- | --- | --- | --- | --- | --- |
| `P01` Saldo nativo por cuenta | Último cierre válido o baseline + neto de movimientos confirmados posteriores | `money_accounts`, perfiles, cierres/baselines y `money_movements`; respetar regla POS | `as_of` actual | Moneda de la cuenta | Q1 con ancla; Q3 y badge `sin baseline` sin ancla | Cuenta, ancla, movimientos posteriores, cierres y conciliación |
| `P02` Valoración actual de cuenta | USD: `P01`; VES: `P01 / active_rate_at_as_of` | P01 y tasa activa con hora | `as_of` | USD de valoración actual, junto al nativo | Q1 si tasa/ancla válidas; Q3 si falta ancla | Cuenta, saldo nativo, tasa, hora y equivalente histórico aparte |
| `P03` Posición bruta de tesorería | `sum(P02)` solo para cuentas incluidas explícitamente en alcance de tesorería | Cuentas activas; excluir perfil `retention` y cuentas especiales no clasificadas | `as_of` | USD actual y totales nativos | Q3 hasta formalizar alcance; Q1 después | Cuentas incluidas/excluidas y motivo de clasificación |
| `P04` Fondos de clientes por devolver/aplicar | Saldo cacheado de clientes reconciliado contra suma neta de `client_fund_movements` | Clientes y subledger de fondo | `as_of` | USD | Q1 si ambos cuadran; Q3 mostrando diferencia si no | Cliente, créditos, débitos, órdenes, reportes y cuenta custodio |
| `P05` Tesorería después de fondos de clientes | `P03 - P04` | P03 y P04 | `as_of` | USD actual | Hereda calidad; etiqueta obligatoria `parcial` | Cuentas y pasivo de fondos |
| `P06` Cartera entregada actual | `sum(pending_usd)` | Estado financiero canónico de órdenes `delivered` | Estado al `as_of`; antigüedad desde `commercial_date` | USD; cotización Bs actual separada | Q1 actual; Q4 histórico no reconstruible | Orden, cliente, días, total, pagos/fondo y pendiente |
| `P07` Saldo de pedidos activos no entregados | `sum(pending_usd)` | Órdenes aprobadas/en ejecución no entregadas ni canceladas | Estado al `as_of`; `scheduled_date` como dimensión | USD y cotización Bs según contrato de orden | Q1 | Orden, agenda, etapa, total y estado de pago |
| `P08` Comisión bruta devengada | Suma de `grossCommissionUsd` de snapshots de liquidación | Cierres de comisión generados por período/asesor y órdenes entregadas | Período por `commercial_date`; snapshot al `calculation_cutoff_at` | USD | Q1 para snapshot versionado; Q2 legacy | Período, asesor, órdenes, base, porcentaje y términos especiales |
| `P09` Comisión retenida por cobranza | Suma de `settlement.retainedCommissionUsd` | Snapshot versión vigente | Corte de cálculo de comisión | USD | Q1 versionado; Q2 inferencia legacy | Asesor, deuda de clientes, crédito y carry resultante |
| `P10` Comisión conformada pagadera | Suma de `payable_usd` de cierres conformados `closed` | Cierres con conformidad y snapshot bloqueado | Corte del cierre de comisión | USD | Q1 si workflow y snapshot completos | Cierre, fórmula, deducciones, carry y conformidad |
| `P11` Comisión pendiente de pago | `max(0, payable_usd - pagos_confirmados_vinculados)` por cierre | Cierre conformado + movimientos estructuralmente vinculados | Posición al `as_of`; pagos por `movement_date` | USD | Q4 si el vínculo depende solo de descripción; Q1 con FK/ledger | Cierre, pagos, fees, saldo y estado |
| `P12` Conciliaciones abiertas | Conteo y suma absoluta por moneda; USD solo a tasa capturada por la partida | `money_account_reconciliation_items` abiertos/partiales con fuente vigente | Posición al `as_of`; fecha de origen y resolución separadas | Nativo y USD de registro | Q1 si fuente válida; Q3 si fuente rechazada/anulada | Ítem, cierre/baseline, cuenta, causa, antigüedad y resolución |
| `P13` Cobertura y frescura de cierres | `% cuentas activas con baseline/ancla` y edad del último cierre válido | Cuentas, perfiles, baselines y cierres válidos | `as_of` contra `closure_at` | Porcentaje, conteo y tiempo | Q1 | Cuentas sin ancla, cierres vencidos, frecuencia y responsable |
| `P14` Costo devengado de delivery y cobertura | Suma de `delivery.cost_usd` snapshot; cobertura `órdenes con costo / deliveries entregados` | Órdenes delivery entregadas | `commercial_date` | USD | Q1 para snapshot; Q2 fallback catálogo; Q3 agregado mixto | Orden, rider/partner, costo, fuente, distancia y cobertura |
| `P15` Obligación pendiente con riders/partners | Costo devengado menos pagos vinculados | Subledger de payable de delivery y movimientos de pago | Posición al `as_of` | USD/nativo | Q4 hasta existir vínculo costo–pago | Proveedor, entregas, costo, pagos y saldo |
| `P16` Retenciones pendientes por aplicar | Recibidas confirmadas menos aplicaciones/anulaciones documentadas | Cuenta/perfil `retention`, reportes, movimientos y documentos fiscales | Posición al `as_of`; fechas de emisión/recepción separadas | Nativo y equivalente registrado | Q3 mientras el control documental no sea completo | Comprobante, cliente, factura/orden, monto y estado |
| `P17` Tasa general activa | Última fila `exchange_rates.is_active = true` | Historial de tasas con anterior, actor, razón y `operation_id` | `effective_at` y `as_of` | Bs/USD | Q1 si existe una sola activa | Historial, anterior/nueva, variación, actor, hora y razón |

`P05` no se llama “caja libre”, porque todavía no descuenta comisiones, impuestos,
proveedores, delivery ni otros pasivos. `P03` no debe publicarse hasta que cada
cuenta especial tenga una inclusión o exclusión explícita.

## 7. Indicadores no publicables todavía

| ID y etiqueta solicitada | Estado | Dependencia faltante |
| --- | --- | --- |
| `B01` Valor monetario de inventario | `Q4_blocked` | Costo por recepción/lote y método de valoración |
| `B02` Costo de ventas — COGS | `Q4_blocked` | Costeo de compras, producción/recetas y snapshot de consumo |
| `B03` Margen bruto | `Q4_blocked` | C02 menos B02 con cobertura completa |
| `B04` Utilidad neta | `Q4_blocked` | Devengo de costos, gastos, impuestos y pasivos; un flujo de caja no basta |
| `B05` Valor monetario de merma/avería | `Q4_blocked` | Costo unitario asociado al movimiento físico |
| `B06` Histórico de cartera “como estaba” | `Q4_blocked` | Read model temporal que reconstruya estado a un `as_of` pasado |
| `B07` Refunds totales exactos | `Q4_blocked` | Tipo/vínculo estructurado; no inferencia libre desde `withdrawal` o texto |
| `B08` Resultado FX de transferencias | `Q4_blocked` | Entidad de transferencia, tasa pactada y clasificación de diferencia |
| `B09` Delivery pagado y por pagar exacto | `Q4_blocked` | Payable y vínculo estructurado con movimiento de pago |

Inventario puede mostrar cantidades, disponibilidad, compromisos, entradas,
producción, conteos y kardex. Una cantidad sin costo conocido no tiene valor
monetario cero; su valor es desconocido.

## 8. Reglas de drill-down y exportación

1. El total del detalle debe reconciliar exactamente con la tarjeta.
2. El detalle conserva `period_start`, `period_end_exclusive`, `as_of`, eje,
   calidad y versión de definición.
3. Cada fila incluye el identificador de su autoridad: orden, movimiento,
   reporte, cuenta, cierre, conciliación, comisión, delivery o ítem.
4. Los movimientos muestran monto nativo, equivalente USD almacenado, tasa y
   estado; no solo una columna USD.
5. Las órdenes muestran base comercial, impuesto y total por separado.
6. Las filas derivadas explican el fallback utilizado.
7. Una exportación no elimina filas `null`, incompletas o anomalías; las etiqueta.
8. La UI no vuelve a calcular totales desde una página limitada del detalle.
9. Un enlace a orden o cuenta respeta los permisos del usuario y no expone una
   tabla completa por comodidad.

## 9. Diagnóstico P0 registrado al corte

Estas observaciones no son correcciones ni instrucciones para modificar datos.
Son condiciones que Admin V2 debe mostrar, excluir o tratar como calidad
degradada hasta que exista una operación de saneamiento autorizada.

| ID | Hallazgo al 2026-09-08 | Impacto sobre KPI | Tratamiento documental |
| --- | --- | --- | --- |
| `A-P0-01` | 31 conciliaciones abiertas; 3 siguen abiertas aunque su cierre fuente está `rejected` | P12 podría presentar tareas huérfanas | Marcar `orphaned_source`; no resolver automáticamente desde la UI |
| `A-P0-02` | 16 cuentas activas y solo 14 con baseline activo | P01–P03 pueden aparentar una posición reconciliada inexistente | Badge `sin baseline`; P13 muestra cobertura 14/16, no 100% |
| `A-P0-03` | Un cierre de comisión `paid` por USD 12,11 no tiene movimiento identificable por el vínculo legacy | P11/T10 no pueden cuadrar solo con estado | Mostrar anomalía; no fabricar un movimiento ni bajar el saldo a cero |
| `A-P0-04` | En una muestra de 1.000 órdenes entregadas devuelta por la API, 487 tenían costo delivery explícito y 513 no | P14 no representa costo histórico completo | Mostrar cobertura de la muestra; fallback catálogo es Q2, nunca snapshot histórico |
| `A-P0-05` | La dashboard legacy exige aprobación Admin desde USD 10, mientras la política vigente de Master Ops permite hasta USD 100 inclusive | T07 puede variar según la pantalla que originó el egreso | No publicar SLA/volumen normativo hasta centralizar una regla; referencia vigente: USD 100 |
| `A-P0-06` | 569 cierres observados: 554 `recorded`, 15 `rejected`, ninguno `approved` | Un KPI “cierres aprobados” sería cero por semántica de workflow, no necesariamente por falta de operación | Mostrar estados reales y decidir contrato antes de agregar aprobación masiva |
| `A-P0-07` | Confirmación base de pago es atómica, pero cambio, fondo y redondeo se ejecutan después en acciones de aplicación | T01/P04/C07 pueden quedar parcialmente sincronizados ante fallo | No migrar esa escritura a Admin V2 hasta tener un comando atómico completo |
| `A-P0-08` | Anulación financiera, cierre/conciliación y pago/estado de comisión conservan rutas multietapa | Posición y auditoría pueden divergir | Lectura permitida con advertencia; escritura V2 bloqueada hasta RPC idempotente |
| `A-P0-09` | La resolución parcial intenta usar `source_kind = reconciliation_residual`, pero no se encontró una migración que amplíe el constraint documental `baseline\|closure\|manual` | Una resolución parcial puede fallar o quedar sin contrato verificable | Validar esquema efectivo antes de habilitar el botón; no probar mediante escritura en producción |

Las cantidades observadas son una fotografía de diagnóstico. No se reutilizan
como constantes ni como fuente de los KPI futuros.

## 10. Criterio de aceptación del Bloque 0 financiero

El diccionario queda listo para implementación cuando:

1. cada tarjeta propuesta tiene un `kpi_id` de este documento;
2. diseño no usa las etiquetas prohibidas para conceptos distintos;
3. las consultas declaran eje temporal, moneda, tasa, impuestos y estados;
4. el backend puede devolver calidad y cobertura;
5. el drill-down reconcilia con el KPI sin leer filas ilimitadas en el cliente;
6. los casos de `ADMIN_V2_FINANCIAL_REFERENCE_CASES_2026-09-08.md` forman parte
   de la certificación;
7. los indicadores `Q4_blocked` no se sustituyen por estimaciones silenciosas.
