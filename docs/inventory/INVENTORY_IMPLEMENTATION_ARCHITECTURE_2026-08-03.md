# Arquitectura de implementación de inventario

Fecha: 2026-08-03

Estado: arquitectura aprobada; clasificación, políticas, recetas, motor
atómico, resolución de ventas y compromisos fechados aplicados. La apertura y
el corte operativo siguen pendientes.

## 1. Resultado buscado

Inventario será el centro de verdad de cantidades. El catálogo podrá crecer sin
programar excepciones por nombre y sin levantar por chat los consumibles futuros.
Administración podrá crear o reutilizar productos, ítems, presentaciones, recetas
y reglas desde un configurador genérico.

El alcance inicial fue reconciliado contra 143 productos y 76 ítems. Después de
las incorporaciones auditadas de los bloques siguientes, el catálogo vivo tiene
144 productos listos y 77 ítems; los ítems futuros se incorporarán desde el
sistema.

## 2. Qué ya existe y se reutiliza

La revisión en vivo de Supabase confirmó estas estructuras:

| Estructura | Autoridad canónica propuesta | Decisión |
| --- | --- | --- |
| `products` | Identidad y oferta comercial | Reutilizar |
| `product_components` | Plantilla de componentes fijos, seleccionables y opcionales | Reutilizar |
| `order_item_components` | Selección comercial real del pedido | Reutilizada; snapshot automático desde el Bloque 6 |
| `inventory_items` | Identidad física y unidad base | Reutilizar |
| `product_inventory_links` | Resolución de producto a hojas físicas | Reutilizar |
| `inventory_recipes` | Encabezado de transformación | Reutilizar y ampliar |
| `inventory_recipe_components` | Insumos y cantidades de receta | Reutilizar |
| `inventory_movements` | Kardex de hechos físicos | Reutilizar y reforzar |

No existen funciones de base de datos que ejecuten los comandos de inventario. La
implementación actual realiza inserciones de movimientos y actualizaciones de
saldo desde acciones de servidor separadas.

## 3. Problemas que no deben heredarse

- `products` conserva saldo, empaque y umbral además de `inventory_items`; esa
  duplicación no puede seguir siendo autoridad física.
- `inventory_deduction_mode` solo admite `self` o `composition` y además lo
  consume directamente el motor heredado; no puede reciclarse como clasificación
  canónica sin cambiar primero ese consumidor.
- el descuento actual todavía busca ítems por nombre cuando falta un enlace;
- las selecciones configurables pueden interpretarse desde texto guardado en notas;
- un enlace `self` puede ignorar su cantidad configurada durante el descuento;
- venta, producción y ajustes escriben movimiento y saldo en operaciones separadas;
- revertir una entrega puede borrar movimientos originales;
- editar un ítem permite sustituir `current_stock_units` sin crear ajuste trazable;
- `order_item_components` existe, pero no contenía filas en el corte auditado;
- las políticas RLS actuales permiten escribir inventario a Master y Admin, pero
  todavía no representan los comandos limitados que cocina necesita.

Estas brechas explican por qué los saldos actuales no deben usarse como apertura.

## 4. Configurador universal

El alta funciona igual para un catálogo vacío, un producto nuevo o un consumible
interno agregado meses después.

### Paso 1. Naturaleza del registro

Elegir una sola opción:

- producto comercial;
- ítem físico interno no vendible;
- producto comercial e ítem físico equivalente;
- plantilla comercial sin salida física propia.

### Paso 2. Identidad física

Antes de crear un ítem, buscar y mostrar coincidencias existentes. El usuario debe
reutilizar una identidad o confirmar deliberadamente una nueva. Nunca se enlaza por
coincidencia automática de nombre.

El ítem declara:

- nombre operativo;
- unidad base estable;
- familia;
- modo `transactional`, `periodic_count` o `not_tracked`;
- disparadores `sale`, `production` y/o `manual_issue`;
- umbral y objetivo opcionales;
- disponibilidad y vida útil cuando apliquen.

### Paso 3. Presentaciones

Cada presentación declara nombre, factor hacia la unidad base y si permite unidades
sueltas. Pueden coexistir varias presentaciones para el mismo ítem; una caja, bolsa,
galón o recipiente no crea otra existencia.

### Paso 4. Política comercial

Todo producto selecciona exactamente una política:

| Política | Configuración obligatoria |
| --- | --- |
| `self` | un ítem equivalente y cantidad por venta |
| `direct` | uno o más ítems físicos y cantidades |
| `components` | reglas fijas/seleccionables y resolución de cada componente |
| `none` | motivo explícito de no consumo físico |

Variantes de precio, cliente, campaña u obsequio reutilizan la misma hoja física.

### Paso 5. Receta, si existe

Configurar insumos, salida, rendimiento, múltiplo, tiempo, disponibilidad inmediata
o programada, almacenamiento, objetivo y vida útil. El tiempo pertenece a la
receta. Una sugerencia de producción no reserva insumos hasta ser aprobada.

### Paso 6. Conteo y procura

La periodicidad, mínimo, objetivo, tolerancia y responsable son parámetros
editables. Pueden quedar sin programación inicial y activarse después. Esto permite
incorporar consumibles futuros sin redefinir la arquitectura.

### Paso 7. Validación previa a activar

El producto permanece inactivo hasta que una simulación de venta confirme:

- una sola política principal;
- todas las ramas resueltas a ítems físicos o a `none`;
- ausencia de ciclos y doble descuento;
- cantidades válidas en unidad base;
- receta completa cuando exista preparación;
- componentes seleccionables con límites coherentes;
- ningún enlace implícito por nombre.

## 5. Reglas del pedido

- el asesor puede agendar y enviar una solicitud aunque la proyección sea
  insuficiente;
- la solicitud tentativa no descuenta ni reserva;
- el Master reevalúa y decide si confirma, condiciona, devuelve o rechaza;
- confirmar congela la composición comercial y la resolución física usadas;
- dentro del horizonte de 10 días, la confirmación crea asignaciones fechadas;
- el movimiento físico ocurre en la etapa configurada, no al crear la solicitud;
- producción o reposición futura queda como dependencia explícita del pedido.

Para prefritos, el objetivo de 10 servicios es orientativo, la anticipación es de
240 minutos y el crudo puede priorizarse para venta frita. Los regulares mantienen
objetivo cero y se preparan bajo demanda.

## 6. Extensiones mínimas de estructuras existentes

Estas capacidades caben como columnas o restricciones adicionales en tablas
existentes y no justifican una tabla paralela:

### `products`

- usar `inventory_policy` para representar `self`, `direct`, `components` y
  `none`;
- usar `inventory_configuration_status` para distinguir borrador, listo y
  pendientes técnicos;
- declarar `allows_half_service` explícitamente;
- mantener `inventory_enabled` e `inventory_deduction_mode` como compatibilidad
  heredada hasta el cambio coordinado del motor;
- dejar de considerar `current_stock_units`, empaque y umbral del producto como
  autoridad física;
- validar que una política activa tenga su configuración completa.

### `inventory_items`

- `tracking_mode`;
- `consumption_triggers`;
- `availability_mode`;
- `target_stock_units`;
- `shelf_life_days`;
- referencia opcional a identidad sucesora para alias migrados.

`current_stock_units` queda como proyección rápida del kardex, nunca como campo de
edición libre.

### `product_inventory_links`

- conservar cantidades explícitas para `self` y `direct`;
- declarar etapa física de deducción;
- versionar la configuración para preparar enlaces sin activar el motor heredado;
- impedir enlaces duplicados dentro de una versión;
- prohibir la ruta por nombre.

### `inventory_recipes`

- tiempo de anticipación;
- modo de disponibilidad;
- múltiplo de producción;
- vida útil;
- vigencia o versión para no reinterpretar producción histórica.

El Bloque 3 reutilizó `lead_time_minutes`, `production_multiple`, `version` e
`is_active`. Las recetas canónicas están versionadas e inactivas porque el comando
heredado de Master todavía escribe movimiento y saldo en operaciones separadas.
Solo se activarán junto con el comando atómico.

### `inventory_movements`

- `operation_id` reutilizado como clave idempotente de la operación atómica;
- referencia de origen estructurada;
- `reversal_of_movement_id` reutilizado para el movimiento reversado;
- saldo resultante opcional para auditoría;
- prohibición de borrar hechos contabilizados.

## 7. Estructuras nuevas justificadas por brechas reales

No se crean todavía. La revisión muestra que las tablas actuales no pueden
representar correctamente estas capacidades:

| Capacidad | Por qué no cabe de forma segura en lo actual |
| --- | --- |
| Presentaciones múltiples por ítem | `inventory_items` solo admite un nombre y factor de empaque |
| Operación atómica e idempotente | resuelta en el Bloque 4 reutilizando `inventory_movements.operation_id`; no requirió otra tabla |
| Lotes y vencimiento | el saldo agregado no identifica producción, fecha ni cantidad restante |
| Asignaciones y dependencias futuras | una promesa no es un movimiento físico |
| Reposiciones esperadas y conciliación | la entrada real debe reemplazar, no acumular ciegamente, la expectativa |
| Conteos ciegos, líneas y reconteos | un movimiento aislado no conserva sesión, esperado, contado y revisión |
| Programas de conteo con múltiples ítems | la periodicidad no pertenece a un único movimiento ni a un producto comercial |

Los nombres definitivos y el número exacto de tablas se decidirán en la migración.
La preferencia será una estructura pequeña por concepto estable, con claves
foráneas y RLS, evitando columnas JSON opacas para relaciones críticas.

## 8. Comandos canónicos

Las pantallas no actualizan saldo directamente. Deben invocar comandos atómicos e
idempotentes para:

- recibir mercancía;
- confirmar producción;
- registrar salida de venta;
- registrar avería, merma, daño o prueba de calidad;
- confirmar conteo;
- devolver mercancía de evento;
- revertir una operación autorizada.

Cada comando valida permisos, bloquea los ítems afectados en orden estable, inserta
todos los movimientos, actualiza la proyección de saldo y confirma todo en una sola
transacción. Reintentar la misma clave idempotente devuelve el resultado previo.

## 9. Aplicación al catálogo existente

No quedan decisiones de negocio bloqueantes. La migración debe ejecutar las reglas
ya asentadas en las matrices:

- crear el insumo a granel de mostaza miel y sus recetas;
- corregir la línea Pulled Pork y separar la receta del restaurante;
- reconfigurar Evento/Colegio y persistir su snapshot;
- migrar alias a sus identidades canónicas sin sumar saldos;
- mantener históricos sin inventario operativo;
- conservar el control periódico configurable de `Cajas grandes`;
- realizar conteo físico y `opening_balance` antes de activar saldos.

## 10. Permisos

- Asesor: consulta disponibilidad y envía solicitudes; no mueve stock.
- Master: consulta, agenda expectativas, decide pedidos y solicita reconteos; no
  revierte pérdidas.
- Cocina: recibe, produce, cuenta y reporta pérdidas mediante comandos limitados.
- Admin: configura catálogo e inventario, aprueba correcciones y ejecuta reversos.
- Counter: consume proyecciones y acciones operativas necesarias, sin administrar
  el libro.

Las políticas RLS deben proteger filas y los comandos privilegiados deben validar
la identidad y el rol dentro de la función; no basta con `TO authenticated`.

## 11. Frontera de aplicación y lecturas operativas

El centro de verdad de inventario vive en la ruta independiente `/app/inventory`.
No forma parte de la dashboard heredada ni del módulo operativo de Master. Su
código y sus consultas se cargan únicamente cuando el usuario entra al centro.

La entrada desde `/app/master/dashboard` usa navegación sin precarga. Mientras se
termina el motor canónico, la dashboard conserva sus lecturas heredadas porque
todavía sostienen comprometidos, disponibilidad y edición del catálogo. No se
agregará allí ninguna nueva pantalla ni consulta pesada de inventario.

Cuando el motor esté listo, Master y los demás módulos consumirán proyecciones
pequeñas adaptadas a cada operación:

- existencia y disponibilidad actual;
- compromisos dentro del horizonte operativo;
- alertas que requieren acción del rol;
- resumen del último conteo.

Counter y Asesor deben seleccionar primero la fecha y hora de entrega. Después
consumen una proyección pequeña para ese `target_at` y presentan el catálogo con
advertencias informativas. Esa lectura no bloquea el envío de la orden ni carga
el Centro de Inventario completo; Master continúa tomando la decisión final.

La frontera instalada para esa integración es
`inventory_catalog_availability_v1`. Las superficies `advisor_availability` y
`counter_inventory` reciben solo datos comerciales; los detalles de ítems
físicos quedan limitados a Master y Administración.

Los historiales, líneas de conteo, recetas y movimientos detallados se consultan
bajo demanda dentro del Centro de Inventario. Las proyecciones no reemplazan el
kardex ni se convierten en una segunda autoridad de stock.

## 12. Apertura física y corte derivado

El Bloque 7 queda preparado sin agregar tablas ni columnas. La activación se
deriva exclusivamente de los conteos existentes: todos los ítems canónicos,
activos y rastreados deben tener una apertura aceptada y no revertida.

El corte tiene tres modos: `legacy` antes del primer conteo, `opening` durante la
ventana física controlada y `canonical` al aceptar la apertura completa. En modo
canónico, la transición de una orden a `delivered` y su consumo físico pertenecen
a la misma transacción. La atomicidad protege la integridad del libro, pero no
convierte la disponibilidad en una prohibición operativa: si la venta produce un
saldo negativo, la entrega se confirma y el `sale_out` conserva el hecho físico.

El estado productivo auditado el 10 de agosto de 2026 es `canonical`: la apertura
controlada ya fue aceptada y las recetas requeridas están activas. Esta activación
no cambia la regla no bloqueante de órdenes.

## 13. Auditoría de preparación e integración

El corte no se decide por una bandera manual. La lectura
`inventory_cutover_readiness_v1` deriva dos niveles:

- `structural_ready`: catálogo activo, vínculos, componentes, recetas, órdenes,
  guardas y roles son coherentes;
- `operational_ready`: además están aceptadas todas las aperturas, activadas las
  recetas canónicas y cerrados los reconteos y producciones pendientes.

La auditoría es de solo lectura y nunca bloquea órdenes. La secuencia de entrega
a otros módulos es Master, Cocina, Asesor y Counter. Asesor y Counter deben
seleccionar fecha/hora antes de consultar disponibilidad y siempre presentan la
respuesta como advertencia informativa sujeta a la decisión final de Master.

## 14. Simulacro y certificación previa a la apertura

La certificación del corte se ejecuta sobre el catálogo real dentro de una sola
transacción reversible. Debe cubrir apertura completa, activación de recetas,
entrada reconciliada, producción inmediata y diferida, disponibilidad no
bloqueante y consumo de una orden entregada. La transacción usa bloqueo asesor y
tiempos máximos para impedir simulacros concurrentes o esperas prolongadas.

El protocolo siempre termina en `ROLLBACK` y luego verifica, en una transacción
independiente, que no persista ninguna fixture. Superar el simulacro acredita el
motor, pero no autoriza una apertura real: los 47 saldos físicos deben estar
representados con cantidades exactas y Master conserva la revisión final.

El Bloque 17 certificó técnicamente el recorrido completo cuando producción aún
permanecía en `legacy`. El Bloque 19 instaló la apertura controlada con responsables
reales y la operación posterior completó esa apertura. La auditoría del 10 de
agosto de 2026 confirma el catálogo canónico activo.

## 15. Variantes físicas y frontera de la apertura operativa

Un producto comercial puede ser una sola opción visible y, a la vez, descontar
existencias físicas separadas. Yukipack establece el patrón canónico: el producto
padre se configura con componentes seleccionables y cada sabor enlaza su propio
ítem físico. Las opciones internas no aparecen como productos sueltos, pero sí
están disponibles al construir el detalle de la orden. La selección queda
congelada en `order_item_components`, por lo que compromisos y ventas descuentan
el sabor realmente solicitado.

El corte que conecta ventas con inventario exige apertura aceptada únicamente a
los ítems con `tracking_mode = transactional`. Los consumibles de conteo periódico
conservan saldo, periodicidad, alertas de procura e historial, pero no bloquean el
corte de productos ni se descuentan por orden. Cada programa periódico inicia con
su propio conteo físico cuando corresponda.

Después de separar Yukipack en Manzana, Pera y Durazno, la apertura de productos
incluye 48 ítems transaccionales. `Cajas grandes` continúa fuera de ese conjunto
como ítem quincenal. Esta separación no autoriza todavía la apertura real ni
convierte referencias aproximadas en cantidades físicas.

## 16. Entrega controlada de la apertura real

Los valores certificados pueden precargarse en la interfaz, pero la escritura y
la revisión deben conservar las sesiones reales de sus responsables. Administración
presenta el lote y Master lo acepta o solicita reconteos; ningún script suplanta
sus identidades para dejar una aprobación artificial en el historial.

La precarga se invalida si cambia el número, ID o nombre de cualquiera de los 48
ítems. Después de la aceptación completa, Administración activa las 13 recetas
canónicas mediante un único comando atómico e idempotente. Solo entonces la
auditoría alcanza `ready_for_canonical_operation`. Esta transición no cambia la
regla no bloqueante de órdenes ni incorpora consumibles periódicos al descuento
por ventas.

## 17. Entrega canónica con existencia insuficiente

La entrega confirmada por Master es un hecho comercial y físico que inventario
debe registrar, no vetar. `inventory_commit_order_sale_v1` resuelve los ítems,
bloquea las filas en orden estable e inserta todos los movimientos `sale_out` en
la misma transacción de `delivered`, incluso cuando una de las existencias no
alcanza y el saldo resultante queda por debajo de cero.

El saldo negativo es deliberadamente visible. Un guardián genérico del balance
abre una alerta crítica de control para cualquier ítem operativo negativo, sin
depender de umbrales, recetas o vínculos comerciales. Permite que Máster,
Administración y Cocina coordinen reposición, conteo o reconteo. No se rellena
saldo, no se omite el consumo y no se crea una segunda autoridad.

El comando explícito de consumo sigue rechazando violaciones estructurales que
harían imposible un asiento válido: ítem inexistente o no operativo, ausencia de
apertura, resolución inválida, operación duplicada o falta de autorización. En
el flujo automático de órdenes, esas excepciones ya no se propagan: se registra
una incidencia crítica y la orden continúa. La insuficiencia cuantitativa no es
una violación estructural; produce el `sale_out` y permite saldo negativo.

Este contrato quedó corregido en producción mediante
`20260810145845_inventory_nonblocking_order_delivery_v1`; el diagnóstico y alcance
del incidente están en
`INVENTORY_HOTFIX_NONBLOCKING_DELIVERY_2026-08-10.md`.

## 18. Frontera completamente no bloqueante con órdenes

Inventario es un centro de verdad y observación, no un mecanismo de veto del
proceso comercial durante esta etapa de evaluación. Los cuatro puntos automáticos
conectados a órdenes son:

1. congelación de componentes al guardar una partida;
2. actualización de compromisos al modificar una partida;
3. ciclo de compromisos al aprobar, reprogramar, cancelar o entregar;
4. consumo físico al pasar una orden a `delivered`.

Cada punto ejecuta su trabajo dentro de un bloque tolerante. Si el inventario
falla, la escritura comercial se conserva y se crea un evento del grupo
`inventory` en `order_timeline_events`, dirigido a Máster y Administración.
El refresco del Centro de Alertas convierte esos eventos en alertas de sistema.
Si incluso el registro de la incidencia fallara, esa falla se reduce a una
advertencia interna y tampoco revierte la orden.

La entrega conserva dos resultados distintos:

- si la resolución es válida, se insertan los `sale_out`, aun con saldo
  negativo;
- si no puede construirse un asiento válido, la orden se entrega, no se inventa
  un movimiento y queda una incidencia crítica pendiente de conciliación.

El disparador de entrega usa una clave determinista por orden. Una repetición
reproduce la misma operación y evita descuentos dobles. La migración canónica es
`20260810152823_inventory_order_flow_nonblocking_v2`; sustituye la intención
del archivo histórico no aplicado
`20260807214500_inventory_non_blocking_order_policy_v1.sql`, que no debe
ejecutarse porque todavía contenía una guarda de existencia insuficiente.

## 19. Contexto automático de entrega y certificación V1

La autorización del comando público de consumo tiene dos fronteras distintas.
Una llamada RPC manual conserva la restricción por rol: Administración y Master
pueden conciliar una venta entregada, y Counter únicamente su retiro `walk_in`
propio. La llamada que nace dentro del trigger de transición a `delivered` no es
una acción manual: debe registrar el hecho físico para cualquier origen de orden
que el flujo comercial haya autorizado.

La función distingue ambos contextos mediante la profundidad real del trigger.
Esto no otorga a Counter acceso manual sobre órdenes de Asesor; solamente evita
que la identidad de quien ejecutó la entrega impida el asiento automático. El
actor real se conserva en el movimiento. La migración vigente es
`20260811014500_inventory_order_sale_trigger_context_v3.sql`.

El Bloque 33 certificó la arquitectura para el piloto V1 y concilió las nueve
entregas históricas afectadas por la frontera anterior. La evidencia y el guion
reversible están en:

- `INVENTORY_BLOCK_33_V1_CERTIFICATION_2026-08-10.md`;
- `INVENTORY_BLOCK_33_TRANSACTION_TESTS_2026-08-10.sql`.

La certificación no convierte inventario en un veto. Los mínimos todavía no
definidos, los conteos por adoptar y los ajustes posteriores de rutas de alerta
son configuración operativa; ninguna de esas tareas puede frenar una orden.

## 20. Fase 1 operativa de Inventario General

La Fase 1 reorganiza exclusivamente el dominio administrativo `/app/inventory`.
No modifica las pantallas de Máster, Cocina, Asesor, Counter ni Finanzas. La
portada usa `inventory_reporting_workspace_v1(10)` como lectura única de saldo,
compromisos, entradas, capacidad, mínimos y último conteo. La consulta se ejecuta
al abrir Inventario General y no forma parte de la carga inicial de la dashboard.

Cada ítem conserva una frecuencia principal en
`inventory_items.primary_count_frequency`. Un valor nulo se presenta como
`Solo por solicitud`: queda fuera de los cierres programados, pero puede contarse
puntualmente. Una frecuencia programada requiere un responsable en
`primary_count_role`.

Los mínimos, objetivos, temporalidad y estados no crean otra entidad. Se
reutilizan `low_stock_threshold`, `target_stock_units`, `is_temporary` e
`is_active`. Las funciones `inventory_set_product_active_status_v1` e
`inventory_set_item_active_status_v1` permiten un retiro reversible, conservan
historial y saldo, validan dependencias activas y nunca bloquean órdenes. Los
productos abiertos en órdenes existentes conservan su snapshot comercial.

La siguiente fase pertenece a Máster: debe consumir una proyección reducida para
monitorear, registrar entradas esperadas y decidir suspensiones comerciales
explícitas. Después se adapta Cocina a sus listas por frecuencia. Esas fases no
deben trasladar el configurador administrativo completo a sus módulos.

## 21. Fase 2 operativa del Módulo Máster

Máster consume una adaptación reducida del centro canónico. Su pantalla inicial
prioriza decisiones: riesgo actual, disponibilidad sin afectar compromisos,
entradas esperadas y conteos pendientes. La configuración estructural de
productos, recetas, frecuencias, mínimos y ciclos de vida permanece en
Inventario General.

Las reposiciones esperadas reutilizan `inventory_planned_flows` y nunca suman
existencia física. Cocina confirma después la cantidad que realmente ingresó.
Una expectativa con cantidad desconocida comunica una fecha posible, pero no
crea capacidad ilimitada.

La indisponibilidad declarada reutiliza el tipo existente
`declared_unavailability`. Es la única señal capaz de producir
`inventory_blocks_submission = true`, y solo cuando Máster o Administración la
crean explícitamente. Los saldos bajos, cero o negativos, faltantes proyectados,
aperturas pendientes y dependencias de reposición continúan siendo avisos no
bloqueantes.

La suspensión se evalúa para la fecha objetivo, se propaga a componentes fijos
obligatorios, conserva el saldo físico y no cancela órdenes existentes. Asesor
y Counter deberán consumir este indicador en sus propias fases visuales; la
Fase 2 no modifica sus interfaces.

El detalle de orden de `/app/master/ops` incorpora una pestaña Inventario que
consume `inventory_preview_order_commitment_v1`. La lectura es tolerante: un
error del inventario no impide cargar el pedido ni ejecutar su flujo operativo.
La certificación completa está en
`INVENTORY_PHASE_2_MASTER_CERTIFICATION_2026-08-11.md`.

## 22. Fase 3 operativa de Cocina

Cocina consume la misma autoridad mediante rutas cargadas bajo demanda. La
entrada prioriza el conteo y mantiene separadas recepción, producción, calidad
y alertas. La cola `/app/kitchen` no precarga el centro de inventario.

El programa de cada ítem continúa definido exclusivamente por
`inventory_items.primary_count_frequency` y `primary_count_role`. Los turnos
usan `per_shift`; los ciclos adicionales usan `daily`, `weekly`, `biweekly` o
`monthly`. No existe una tabla paralela de calendarios. Un ítem con frecuencia
nula queda disponible únicamente para conteo solicitado o puntual.

Cada fecha operativa de Caracas admite un Turno 1 y un Turno 2. Su apertura es
atómica e idempotente y captura quién abrió y quién presentó. El vencimiento
genera una alerta de control, pero el conteo tardío continúa permitido. Los
ciclos periódicos vencidos se agrupan por frecuencia y se resuelven al contar.

La captura es ciega y exige una cantidad para todas las líneas; cero es válido.
Las presentaciones y fracciones se convierten a la unidad canónica. Presentar
ajusta inmediatamente el saldo y deja el reporte disponible para aceptación o
reconteo selectivo de Máster.

Las migraciones vigentes son:

- `20260811153310_kitchen_inventory_shifts_v1.sql`;
- `20260811153622_inventory_kitchen_count_schedule_v1.sql`.

La certificación completa y su prueba reversible están en:

- `INVENTORY_PHASE_3_KITCHEN_CERTIFICATION_2026-08-11.md`;
- `INVENTORY_PHASE_3_KITCHEN_TRANSACTION_TESTS_2026-08-11.sql`.

Esta fase no modifica órdenes, Counter, Asesor, Finanzas ni la dashboard
heredada. Una diferencia, saldo negativo o conteo vencido sigue siendo una
señal no bloqueante.
