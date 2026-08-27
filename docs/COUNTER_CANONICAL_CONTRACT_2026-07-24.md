# Contrato canónico de Counter / Mostrador - VIVO Ops

Fecha: 2026-07-24

Estado: **aprobado como Bloque 0 funcional**.

Este documento define el alcance, las autoridades, los estados y las reglas
operativas del módulo `/app/counter`.

No certifica que la implementación actual ya cumpla estas reglas. Su propósito es
servir como contrato previo para auditar, construir y validar el módulo por
bloques.

## 1. Precedencia y documentos relacionados

Este contrato especializa para Counter las normas generales de:

- `docs/OPERATIONAL_DATA_FRESHNESS_POLICY_2026-07-17.md`
- `docs/FINANCIAL_CANONICAL_FLOW_2026-06-04.md`
- `docs/FINANCIAL_GOVERNANCE_POLICY_2026-06-16.md`
- `docs/FINANCIAL_OPERATIONS_MANUAL_2026-06-18.md`
- `docs/FINANCIAL_CLOSURE_IMPLEMENTATION_PLAN_2026-06-16.md`
- `docs/MASTER_ADMIN_SEPARATION_AUDIT_2026-07-17.md`

Si un handoff o una descripción anterior contradice este documento dentro del
alcance de Counter, prevalece este contrato por ser la decisión operativa más
reciente. Las fuentes contables generales continúan regidas por los documentos
financieros canónicos.

Decisión posterior que prevalece sobre referencias financieras antiguas:

```text
Cerrar un punto de venta no genera automáticamente un traspaso al banco.
El cierre del punto y el ingreso bancario son hechos distintos.
```

## 2. Identidad del módulo

Regla central:

```text
Counter es el mostrador y la caja registradora operativa del local.
No es Master, no es Administración y no es un dashboard financiero.
```

La persona que opera Counter debe poder resolver, con rapidez y trazabilidad:

1. pedidos que cocina terminó;
2. retiros pickup;
3. salida de delivery hacia un motorizado;
4. cambio entregado para un delivery;
5. retorno y liquidación de dinero del motorizado;
6. cobros simples o mixtos;
7. ventas presenciales nuevas;
8. pedidos agendados;
9. consultas precisas de órdenes actuales o históricas;
10. movimientos diarios y cierres de las cajas y puntos autorizados.

Counter no debe convertirse en una pantalla de análisis, conciliación bancaria,
administración de cuentas o control general del negocio.

## 3. Principios invariables

### 3.1 Separación de responsabilidades

- Counter ejecuta el trabajo físico y de caja del mostrador.
- Master controla la operación general, los motorizados, las excepciones y las
  decisiones que Counter no puede tomar.
- Administración gobierna permisos, cuentas, autorizaciones financieras y
  ajustes administrativos.
- El asesor mantiene la comunicación y la cobranza de sus clientes cuando la
  orden le pertenece.
- Cocina prepara y marca el avance productivo.

### 3.2 Estados independientes

La preparación o entrega física de una orden no demuestra que esté pagada.

El pago de una orden no demuestra que haya sido entregada.

La devolución de dinero de un motorizado no debe confundirse con la entrega
física al cliente.

### 3.3 Trazabilidad

Toda acción sensible debe registrar, como mínimo:

- usuario ejecutor;
- fecha y hora;
- orden, cliente, cuenta o cierre afectado;
- estado anterior y estado resultante;
- monto, moneda, tasa y método cuando exista dinero;
- motivo obligatorio cuando exista reducción, devolución, excepción o ajuste;
- autorizador cuando la acción requiera aprobación.

No se deben borrar hechos financieros u operativos para corregirlos. Se deben
reversar, rechazar, anular o compensar dejando huella.

### 3.4 Verdad financiera

`money_movements` es la fuente de verdad del dinero.

`payment_reports` representa reporte o evidencia y no afecta saldos por sí solo.

Solo un `money_movement` con `status = confirmed` afecta:

- saldo de una cuenta;
- saldo financiero de una orden;
- cierre de caja o punto;
- cobranza confirmada.

Ninguna pantalla de Counter debe calcular un saldo de orden mediante una fórmula
local alternativa. Debe consumir el resultado financiero canónico.

## 4. Modelo canónico de estados

El sistema debe representar tres ejes separados. Los nombres de esta sección son
conceptuales y no obligan a reutilizar un único campo o enum de base de datos.

### 4.1 Cumplimiento físico

Secuencia general:

```text
agendada/creada -> en cocina -> lista -> en camino -> entregada
```

- Pickup no utiliza necesariamente `en camino`.
- En pickup, Counter marca la entrega cuando entrega físicamente al cliente.
- En delivery, Counter marca la salida al motorizado y Master marca la entrega al
  cliente después de recibir la notificación del motorizado.
- Una cancelación es una decisión separada y exclusiva de Master o
  Administración.

### 4.2 Estado financiero de la orden

Estados conceptuales:

```text
sin pago -> pago parcial -> pago reportado pendiente -> pagada
```

También pueden existir:

- saldo pendiente a cargo del cliente;
- saldo a favor del cliente;
- devolución pendiente;
- reverso o anulación formal.

El estado financiero se deriva de movimientos confirmados, aplicaciones de fondo
y devoluciones o reversos canónicos.

### 4.3 Liquidación de efectivo de delivery

Estados conceptuales:

```text
no requerida
cambio entregado / esperando retorno
retorno parcial
liquidada
discrepancia de custodia
```

Una orden puede estar físicamente entregada y continuar varios días en la cola de
liquidaciones porque el motorizado todavía no devolvió el dinero.

No se debe mantener artificialmente la orden como “no entregada” para representar
esa deuda de custodia.

## 5. Matriz de autoridad

| Acción | Counter | Autoridad adicional |
| --- | --- | --- |
| Consultar cola operativa | Sí | No |
| Buscar clientes u órdenes históricas | Sí | No |
| Crear cliente con nombre y teléfono | Sí | No |
| Crear venta pickup o delivery | Sí | No |
| Elegir modalidad durante una venta nueva | Sí | No |
| Cambiar pickup por delivery o viceversa en una orden existente | No | Solo Master |
| Corregir fecha/hora de pickup antes de estar listo | Sí, con motivo | No |
| Corregir fecha/hora de delivery | No | Solo Master |
| Enviar una venta inmediata nueva a cocina | Sí | No |
| Crear una venta agendada | Sí | Master decide su envío posterior a cocina |
| Modificar productos de un pickup aún no preparado | Sí, con trazabilidad | No |
| Modificar un pickup ya preparado o empacado | Sí, con trazabilidad | No |
| Modificar productos de un delivery existente | No | Master |
| Cancelar una orden | No | Master o Administración |
| Aplicar un descuento arbitrario | No | No permitido |
| Aplicar una regla general de descuento vigente para Counter | Sí | La regla activa es la autorización |
| Registrar efectivo o punto permitido | Sí | Según regla de cuenta |
| Reportar pago móvil, transferencia u otro pago bancario | Sí | Master/Admin confirma |
| Confirmar un pago bancario | No | Master/Admin |
| Entregar pickup | Sí | Según reglas de pago |
| Asignar motorizado | No | Master |
| Entregar una orden ya asignada al motorizado y registrar ETA | Sí | No |
| Marcar delivery entregado al cliente final | No | Master |
| Liquidar efectivo devuelto por motorizado | Sí | No |
| Ejecutar cambio digital | No | Asesor; Master si no existe asesor |
| Cerrar un remanente que el cliente deja voluntariamente, hasta USD 1 | Sí, con trazabilidad | No |
| Cerrar un excedente cedido superior a USD 1 | No | Administración revisa |
| Devolver saldo originado por reducción de pickup | Sí, después de autorización | Master/Admin autoriza |
| Crear gasto operativo manual de hasta USD 20 equivalentes | Sí | No |
| Crear gasto operativo manual superior a USD 20 equivalentes | Sí, como solicitud pendiente | Administración confirma |
| Cerrar caja o punto con diferencia cero | Sí | No |
| Cerrar caja o punto con diferencia | No | Debe resolverse formalmente antes |

## 6. Clientes y ventas nuevas

### 6.1 Cliente obligatorio

Toda venta debe conservar un `client_id`. Como regla general, no existen ventas
sin identificar ni se crean registros genéricos nuevos a “consumidor final”.

Antes de crear cualquier orden, sin importar su monto, Counter debe:

1. buscar al cliente por teléfono o nombre;
2. seleccionar el registro existente cuando corresponda;
3. crear el cliente si no existe;
4. guardar obligatoriamente nombre y teléfono.

La búsqueda debe evitar duplicados por diferencias de formato telefónico,
mayúsculas, minúsculas o acentos.

Existe una sola excepción operativa: el registro especial, existente y activo
`ANONIMO` puede seleccionarse cuando una persona ya se retiró del mostrador sin
dejar nombre ni teléfono y la orden todavía debe cargarse. Counter no crea otro
cliente anónimo ni reemplaza con datos inventados los datos faltantes.

El teléfono técnico del registro `ANONIMO` es solamente un identificador interno:
la interfaz no debe presentarlo como teléfono confirmado del comprador. La orden
queda trazada al operador de Counter y no hereda asesor, fondo ni atribución
comercial aparente del historial compartido de ese registro.

### 6.2 Venta inmediata

- Counter puede crear pickup o delivery.
- La orden debe usar productos activos, precios vigentes y tasa aplicable.
- La venta para consumo inmediato entra a cocina sin aprobación previa de Master.
- Debe usar la misma semántica de productos, componentes, combos, precios y
  snapshots que el resto del sistema.

### 6.3 Venta agendada

- Counter puede crear una orden para otra fecha y hora.
- La orden queda agendada/creada.
- Master controla el envío posterior a cocina.
- Counter no debe convertir una agenda futura en una precarga pesada de la
  pantalla principal.

## 7. Descuentos

Counter:

- conserva descuentos ya aprobados y registrados en una orden;
- puede aplicar descuentos generales cuya regla esté activa y expresamente
  habilitada para Counter o asesor;
- no puede inventar un porcentaje, condición o excepción;
- no obtiene autoridad por la existencia histórica de un descuento.

El porcentaje histórico de 20 % no constituye una autorización vigente. Los
límites y condiciones deben provenir de reglas generales activables y
desactivables.

La acción final debe validar la regla y recalcular en servidor. Una mala cobranza
debe quedar atribuida al operador para revisión administrativa; no se debe crear
un recobro silencioso ni alterar dinero sin trazabilidad.

## 8. Modificaciones de órdenes

### 8.1 Pickup antes de estar preparado

Counter puede agregar, reducir o eliminar productos.

Reglas:

- toda modificación de una orden existente queda auditada;
- una reducción o eliminación exige motivo;
- los totales y el saldo financiero se recalculan con la lógica canónica;
- cocina debe recibir el cambio aplicable sin duplicar la orden;
- Counter nunca puede cancelar completamente la orden.

### 8.2 Pickup ya preparado o empacado

Counter puede modificarlo directamente porque atiende al cliente presente en
mostrador. No requiere autorización de Master para agregar, aumentar, reducir o
retirar productos.

Reglas:

- toda reducción o retiro exige un motivo;
- Counter no puede cancelar completamente la orden;
- el total y el saldo financiero se recalculan en servidor;
- si la modificación agrega o aumenta productos, el pedido vuelve a cocina para
  preparar y verificar el cambio;
- una reducción de un pedido ya listo se informa a cocina y conserva la
  trazabilidad del operador;
- si la reducción produce un saldo a favor, su devolución mantiene la regla de
  autorización financiera definida para reembolsos.

### 8.3 Delivery

Counter no modifica productos de una orden delivery existente.

El asesor canaliza la solicitud y Master decide el cambio.

Counter tampoco cambia la modalidad pickup/delivery de una orden existente.

### 8.4 Órdenes entregadas

Una orden entregada es de solo lectura operativa para Counter, salvo el registro
de pagos pendientes.

Counter no puede cambiar:

- productos;
- fecha u hora;
- modalidad;
- preparación;
- estado de entrega;
- datos administrativos.

Las correcciones administrativas corresponden a Master o Administración.

## 9. Consulta y búsqueda profunda

La búsqueda general debe cubrir dos necesidades.

### 9.1 Información al cliente

Counter puede localizar una orden por:

- número corto `orders.id`;
- nombre del cliente;
- teléfono;
- datos equivalentes del receptor cuando existan.

Debe poder informar:

- qué se pidió;
- para qué fecha y hora;
- si está agendado, en cocina, listo, en camino o entregado;
- modalidad pickup/delivery;
- estado de pago visible a nivel operativo.

### 9.2 Resolución operativa

Desde un resultado abierto, Counter puede:

- corregir fecha/hora de un pickup permitido;
- enviar a cocina un pickup agendado que deba prepararse ahora, sin duplicarlo;
- cargar pagos de órdenes presentes, futuras o entregadas;
- reportar evidencia de un pago digital para confirmación.

Las acciones disponibles dependen del estado y de la matriz de autoridad. El hecho
de encontrar una orden histórica no habilita su edición.

### 9.3 Contrato de carga

- La pantalla inicial no carga el histórico completo.
- La búsqueda se ejecuta bajo demanda.
- Los resultados son paginados, limitados y ligeros.
- El expediente completo se carga al seleccionar una orden.
- La búsqueda por nombre debe ser insensible a acentos y mayúsculas.
- El teléfono debe compararse también en formato normalizado.
- El identificador operativo principal mostrado es el número corto
  `orders.id`.

## 10. Cobros

### 10.1 Cobro operativo

Counter debe permitir:

- una o varias líneas de pago;
- métodos y cuentas permitidos por reglas vigentes;
- USD y VES;
- uso de la tasa aplicable;
- efectivo y punto;
- pagos parciales;
- pagos de órdenes futuras, activas, en delivery o ya entregadas;
- pagos de órdenes antiguas recuperadas mediante la búsqueda;
- excedente a fondo del cliente cuando corresponda;
- cambio desde una o varias cuentas autorizadas.

La forma de pago indicada al crear la orden es una **referencia operativa**, no
una restricción del medio que Counter puede recibir. El cliente puede cambiarla
al momento de pagar. Counter debe registrar el método, la cuenta, la moneda, el
monto y la evidencia que realmente recibió, sin exigir que coincidan con la
indicación original y sin reescribir el historial de la orden.

Esta libertad aplica a toda orden no cancelada con saldo pendiente, sin importar
su modalidad, fecha o estado operativo. Incluye pickup, delivery, órdenes
agendadas, antiguas y entregadas. Una orden cancelada permanece fuera del cobro
de Counter y cualquier regularización corresponde a Master/Administración.

El cambio de método no cambia las reglas de confirmación. Efectivo y punto solo
se confirman directamente cuando la cuenta y la regla vigentes lo permiten. Los
pagos bancarios o digitales pueden ser cargados por Counter, pero permanecen
pendientes hasta la confirmación de Master/Admin.

Registrar un movimiento particular no obliga a cerrar financieramente toda la
orden. Un cobro o una entrega de cambio puede quedar terminado mientras el saldo
restante continúa bajo cobranza del asesor.

Para cobros en bolívares, Counter no calcula el monto desde el total USD de la
orden. Antes o durante el día de entrega debe mostrar y registrar el `pending_bs`
exacto de la cotización financiera canónica. La tasa snapshot proviene de
`extra_fields.pricing.fx_rate`; queda prohibido inferirla mediante
`total_bs / total_usd`, porque ese cociente incorpora redondeos de los
equivalentes USD por línea. Esto aplica igualmente a Punto, efectivo VES,
órdenes mixtas y pagos parciales. Después del día de entrega prevalece la regla
de cobranza dolarizada: saldo USD pendiente por la tasa vigente de la fecha de
operación.

Cuando un pago confirmado y realizado antes o durante el día de entrega cubre
el `pending_bs` exacto, la orden queda pagada tanto en Bs como en su equivalente
USD. Una diferencia creada exclusivamente porque el total USD y el equivalente
USD del pago se redondearon por separado no constituye deuda, no requiere un
pago adicional y no puede reaparecer al consultar la orden en días posteriores.

### 10.2 Efectivo y punto

Efectivo y punto pueden confirmarse automáticamente solo cuando:

- la cuenta está habilitada para Counter;
- la regla de pago lo permite;
- la operación supera todas las validaciones de servidor.

Si el pago esperado es efectivo o punto a cobrar en Counter, la entrega requiere
ese cobro confirmado, salvo una autorización explícita de Master/Admin.

### 10.3 Pagos digitales o bancarios

Counter puede cargar datos y evidencia de:

- pago móvil;
- transferencia;
- Zelle;
- wallets habilitadas, como Binance o PayPal;
- cualquier otro método permitido por reglas vigentes;
- cualquier cuenta reportable habilitada por reglas.

Counter no confirma estos pagos. El reporte queda pendiente hasta que Master/Admin
lo valide y genere el movimiento financiero canónico.

Regla de entrega:

- Si la orden tiene asesor asignado, el pago digital pendiente no bloquea por sí
  solo la entrega física. El asesor conserva el seguimiento de cobranza.
- Si el cliente no tiene asesor asignado, Counter no entrega la orden hasta que
  Master confirme el pago digital.

En ambos casos, la interfaz debe mostrar claramente que el reporte todavía no
equivale a dinero confirmado.

### 10.4 Pagos parciales

Cuando el cliente paga solo una parte:

- se registra exclusivamente lo recibido;
- el movimiento recibido puede quedar cerrado;
- la orden conserva su saldo pendiente;
- el asesor mantiene la cobranza posterior cuando le corresponda.

Una deuda del cliente no debe confundirse con una diferencia de custodia del
motorizado.

## 11. Cambio y devoluciones

### 11.1 Cambio ordinario

El cambio puede:

- entregarse en una o varias monedas;
- salir de una o varias cajas autorizadas;
- dividirse entre efectivo y un método digital;
- entregarse parcialmente y conservar una parte pendiente.

Cada salida real de efectivo debe generar un egreso confirmado y vinculado a la
orden.

La experiencia del operador puede ser una atención continua, pero los hechos
financieros no se agrupan en un único movimiento:

1. cada ingreso recibido se confirma como una operación independiente;
2. el excedente confirmado se resguarda primero en el fondo del cliente;
3. cada entrega de cambio desde una caja se confirma como otra operación
   independiente, con su propio comprobante y grupo de movimiento;
4. si se usa otra caja o moneda, se registra una nueva entrega;
5. la parte que no se entregue permanece en el fondo del cliente, salvo que el
   cliente manifieste que deja voluntariamente el remanente;
6. Counter puede cerrar directamente una diferencia cedida de hasta `1.00 USD`;
   el cierre debita solo ese remanente del fondo temporal, no genera salida de
   caja, no cambia el precio de la orden y deja auditoría idempotente;
7. una diferencia cedida superior a `1.00 USD` requiere revisión administrativa.

Los pagos mixtos siguen la misma regla: Counter registra y cierra un medio de
pago antes de continuar con el siguiente. Todas las operaciones permanecen
vinculadas a la misma orden, pero una corrección o anulación administrativa debe
afectar exclusivamente el ingreso o la entrega seleccionada. Cada operación
individual sí es atómica entre su movimiento de caja y su reflejo en el fondo.

La sesión visual no termina al confirmar un ingreso ni una salida de cambio.
Counter debe conservar abierta y fijada la misma orden —incluidas las órdenes
recuperadas por búsqueda de días anteriores— hasta que el operador elija
explícitamente terminar. Después de cada paso debe mostrar el saldo todavía a
favor y permitir entregar desde otra caja, usar otra moneda, dejar el remanente
en el fondo o registrar que el cliente deja una diferencia permitida. Counter no
debe obligar a entregar cambio cuando el cliente manifiesta que no lo desea.

### 11.2 Cambio digital

Counter no ejecuta transferencias bancarias para entregar cambio.

- Si el cliente tiene asesor, el asesor entrega el cambio digital y mantiene al
  cliente informado.
- Si el cliente no tiene asesor, Master ejecuta el cambio digital y entrega el
  comprobante.
- Counter registra la necesidad y su relación con la orden.
- La parte digital permanece pendiente hasta existir ejecución y confirmación
  trazable.

### 11.3 Devolución por reducción de pickup

Si una modificación autorizada reduce una orden ya pagada:

- el sistema reconoce un saldo a favor o devolución pendiente;
- Counter no devuelve dinero sin autorización de Master/Admin;
- después de la autorización, Counter puede entregar efectivo disponible como una
  operación de cambio vinculada a la orden;
- si no existe efectivo suficiente, el saldo puede mantenerse a favor;
- el asesor puede gestionar la devolución por otro método;
- si no existe asesor, Master gestiona la devolución digital;
- la devolución confirmada debe quedar reflejada en el estado financiero
  canónico.

No se debe ocultar el saldo a favor, convertirlo en deuda negativa ni simular una
cuenta que no recibió o entregó dinero.

## 12. Pickup

Flujo normal:

1. cocina marca la orden lista;
2. Counter la ve en su cola activa;
3. Counter identifica al cliente y abre el detalle;
4. revisa el estado financiero y el responsable de cobranza;
5. cobra efectivo/punto cuando le corresponde;
6. puede reportar evidencia digital;
7. entrega físicamente;
8. marca el pickup entregado.

Cuando la orden indique que retira otra persona, Counter debe mostrar su nombre
y teléfono de forma destacada tanto en la cola como en el detalle, y debe
verificarla antes de confirmar la entrega. El receptor autorizado no sustituye
la identidad del cliente titular de la orden.

El estado “listo” significa preparado, no entregado.

Las reglas de bloqueo de pago se aplican según el responsable de cobranza y el
tipo de pago, no mediante una equivalencia universal entre “pagado” y
“entregable”.

## 13. Delivery

### 13.1 Preparación y salida

1. cocina marca la orden lista;
2. Master asigna el motorizado o partner;
3. Counter verifica la asignación;
4. Counter prepara y registra el cambio en efectivo que salga de caja;
5. Counter entrega físicamente el pedido al motorizado;
6. Counter pregunta y registra el ETA informado por el motorizado;
7. la orden pasa a `en camino`;
8. el ETA queda disponible para que el asesor informe al cliente.

Si la orden tiene un receptor distinto, Counter debe ver claramente su nombre y
teléfono antes de entregar el pedido al motorizado. Estos datos acompañan la
instrucción de entrega sin cambiar al cliente titular de la orden.

Sin motorizado o partner asignado, Counter no despacha la orden.

### 13.2 Entrega física

Master marca la orden entregada después de recibir la notificación del
motorizado.

Counter no marca el delivery como entregado al cliente final.

### 13.3 Cambio para delivery

El cambio debe quedar prescrito en la orden antes del despacho. El asesor lo
registra al tomar el pedido. Si la necesidad se conoce después por teléfono,
Master corrige la instrucción de pago antes de que Counter entregue dinero al
motorizado. Counter no crea una instrucción monetaria basándose solamente en
una conversación externa al sistema.

El campo canónico no guarda cuánto cambio se entregará. Guarda **con cuánto
pagará el cliente**. Counter calcula la diferencia contra el saldo vigente de
la orden y registra por separado el efectivo o cambio digital realmente
asignado.

Ejemplo:

```text
Total de la orden: USD 37
Efectivo que entregará el cliente: USD 50
Cambio requerido: USD 13
```

La orden conserva un total comercial de USD 37. Los USD 50 son el cobro bruto
que queda bajo custodia del motorizado y los USD 13 son una salida vinculada de
cambio. Cuando el motorizado retorna los USD 50, el efecto neto de caja es USD
37; la orden nunca se reescribe como una venta de USD 50.

Si Counter entrega USD 10 en efectivo y el asesor enviará USD 3 por pago móvil:

- se registra egreso de USD 10 en la caja seleccionada;
- se registra USD 3 como cambio digital pendiente;
- la orden conserva la trazabilidad de ambos componentes;
- el motorizado mantiene la obligación de retornar los USD 50 recibidos.

No se debe fingir una salida de USD 13 desde caja si físicamente solo salieron
USD 10.

### 13.4 Retorno y liquidación

Cuando el motorizado regresa:

- Counter registra el monto realmente recibido;
- el ingreso entra en la caja efectiva seleccionada;
- la liquidación puede ser total o parcial;
- el saldo de custodia pendiente permanece visible aunque cambie el operador o
  pase al día siguiente;
- conductores internos y externos siguen la misma regla.

Si el motorizado recibió USD 50 del cliente y devuelve menos, la diferencia es de
custodia del motorizado y debe escalarse. No es deuda del cliente.

Si el cliente solo pagó una parte y eso fue lo que el motorizado recibió, puede
cerrarse la custodia por el monto efectivamente recibido mientras la orden
continúa con saldo pendiente bajo cobranza.

Un delivery que no maneja efectivo ni cambio no necesita liquidación de caja.

### 13.5 Continuidad entre turnos

Las liquidaciones pendientes:

- no desaparecen por cambio de día;
- no pertenecen únicamente al operador que las inició;
- deben aparecer al siguiente operador hasta resolverse;
- deben conservar el egreso de cambio y cualquier retorno parcial.

Una liquidación abierta no impide cerrar una caja si el efectivo contado coincide
con los movimientos confirmados. El retorno futuro se registra cuando el dinero
realmente entra.

## 14. Cajas y puntos

### 14.1 Cuentas visibles y operables

Counter administra directamente solo:

- Caja Dark/DAR USD;
- Caja Dark/DAR VES;
- puntos de venta activos expresamente habilitados para Counter.

Las cuentas de Floresta no forman parte de las cajas directas de Counter.

Counter puede reportar un pago hacia una cuenta bancaria permitida, pero no debe
ver ni administrar su estado de cuenta, saldo completo, conciliación o
configuración.

### 14.2 Movimientos manuales

Counter puede confirmar directamente un gasto o movimiento operativo manual de
hasta USD 20 por movimiento, o su equivalente en VES a la tasa activa.

Ejemplos:

- agua;
- compra puntual menor;
- gasto inmediato del local.

Reglas:

- el movimiento debe describir el concepto real;
- no puede dividirse artificialmente un gasto para evadir el límite;
- un movimiento manual superior a USD 20 puede ser registrado por Counter como
  solicitud pendiente;
- solo Administración lo confirma;
- hasta ser confirmado no afecta el saldo de caja.

El límite de USD 20 no aplica a cobros, cambios o devoluciones vinculados
formalmente a una orden. Esas operaciones se respaldan por la orden y por sus
propias reglas de autorización.

### 14.3 Cierre

Counter puede cerrar una caja o punto únicamente con diferencia cero.

El saldo esperado debe incluir todos los movimientos confirmados de la cuenta,
sin importar si fueron creados por Counter, Master o Administración.

Si existe diferencia:

- el cierre se bloquea;
- debe identificarse el movimiento real faltante o la causa;
- Counter puede registrar un gasto real dentro de su límite;
- un movimiento superior al límite espera aprobación administrativa;
- una diferencia inexplicada requiere resolución formal, no un ajuste ficticio.

Cerrar un punto no genera un movimiento automático hacia el banco.

## 15. Contrato de datos ligeros y exactos

### 15.1 Pantalla inicial

Debe cargar solo la información necesaria para responder:

```text
¿Qué tiene que atender Counter ahora?
```

Incluye:

- órdenes operativas activas;
- datos resumidos necesarios para distinguirlas;
- alertas y liquidaciones abiertas relevantes.

No incluye por defecto:

- histórico largo de órdenes;
- movimientos históricos de cuentas;
- todas las cuentas bancarias;
- catálogos completos innecesarios;
- reportes financieros generales;
- sumas globales del negocio.

### 15.2 Detalle bajo demanda

- El detalle completo de una orden se carga al abrirla.
- La búsqueda histórica se ejecuta al solicitarla.
- Caja y puntos cargan movimientos cuando se abre esa zona o se solicita
  actualización.
- Los listados largos deben paginarse.
- No debe existir un refresco ciego que repita toda la carga de la ruta cuando
  solo cambió una orden o alerta.

### 15.3 Frescura

Son datos vivos:

- estado de preparación;
- estado de entrega;
- pagos pendientes/confirmados;
- saldo operativo de cajas y puntos;
- liquidaciones de delivery.

Pueden actualizarse mediante Realtime, eventos, push, revalidación focalizada o
polling ligero. El mecanismo elegido no debe multiplicar consultas completas.

El catálogo y las reglas pueden cachearse por periodos razonables, pero toda
acción que afecte precio, descuento, permisos o dinero debe revalidar en servidor
contra datos vigentes.

### 15.4 Operaciones progresivas

Cobrar y despachar son operaciones enfocadas, no extensiones verticales del
expediente. Al iniciarlas deben abrir una superficie propia y presentar una
sola decisión principal por pantalla.

- el cobro muestra primero método y monto;
- el cambio solo aparece cuando corresponde o el operador lo solicita;
- el despacho solicita primero el ETA;
- la selección de caja aparece únicamente cuando realmente sale cambio;
- toda operación termina con una confirmación breve;
- pagos mixtos, cambio digital, varias cajas y notas permanecen disponibles
  como opciones secundarias, sin competir con el camino normal.

### 15.5 Exactitud con trazabilidad

Los snapshots, cierres, acumulados o proyecciones pueden acelerar consultas, pero
no sustituyen el historial canónico.

Reglas:

- un saldo rápido debe poder reconciliarse con movimientos confirmados;
- una búsqueda precisa puede consultar más profundidad bajo demanda;
- no se sacrifica exactitud por mostrar menos datos inicialmente;
- no se recorre todo el histórico en cada apertura de pantalla;
- los límites temporales no pueden omitir movimientos posteriores a un cierre o
  baseline del mismo día.

## 16. Seguridad y consistencia técnica

La implementación futura debe cumplir:

- permisos reales de Counter en servidor y base de datos;
- RLS y RPC alineados con la matriz de autoridad;
- ninguna autorización basada solo en ocultar botones;
- ninguna clave privilegiada expuesta al cliente;
- funciones privilegiadas con autorización explícita del usuario y operación;
- acciones monetarias idempotentes;
- operaciones compuestas atómicas cuando una falla parcial pueda dejar orden,
  pago, cambio o liquidación inconsistentes;
- validación fresca de cuenta, regla, tasa, precio y estado antes de confirmar;
- auditoría del actor y autorizador;
- protección contra doble clic, reintentos y registros duplicados.

Una acción no está implementada correctamente si la interfaz la ofrece pero RLS o
la función de base de datos impide que un usuario con rol Counter puro la ejecute.

## 17. Criterios de aceptación del Bloque 0

El contrato se considera completo porque define:

- propósito y límites del módulo;
- responsabilidades de Counter, Master, Administración y asesor;
- separación entre entrega, pago y liquidación;
- reglas de pickup y delivery;
- cambios en efectivo y digitales;
- cobros mixtos, parciales e históricos;
- modificaciones, cancelaciones y devoluciones;
- clientes obligatoriamente identificados;
- venta inmediata y agendada;
- buscador histórico bajo demanda;
- cajas, puntos, movimientos menores y cierres;
- ligereza, frescura y exactitud;
- trazabilidad, permisos y consistencia.

La implementación de los bloques posteriores debe demostrar estas reglas mediante
pruebas funcionales y financieras. Ninguna decisión visual puede debilitar este
contrato.

## 18. Prohibiciones expresas

Counter no debe:

- convertirse en dashboard financiero;
- tocar o replicar `/app/master/dashboard` para resolver su operación;
- ver estados de cuenta bancarios completos;
- conciliar bancos;
- confirmar pagos bancarios;
- asignar motorizados;
- marcar un delivery como entregado al cliente final;
- cambiar modalidad de una orden existente;
- modificar productos de delivery;
- cancelar órdenes;
- alterar órdenes entregadas, salvo registrar pagos;
- aplicar descuentos arbitrarios;
- cerrar caja o punto con diferencia;
- ocultar saldos a favor o diferencias de custodia;
- tratar un reporte pendiente como dinero confirmado;
- precargar históricos largos;
- duplicar cálculos financieros o de precios;
- transferir automáticamente el cierre de punto al banco.
