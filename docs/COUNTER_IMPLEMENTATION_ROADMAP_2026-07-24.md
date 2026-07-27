# Hoja de ruta de implementación de Counter / Mostrador - VIVO Ops

Fecha: 2026-07-24

Documento rector:

- `docs/COUNTER_CANONICAL_CONTRACT_2026-07-24.md`

Estado:

- Bloque 0 funcional: cerrado.
- Bloque 1: cerrado en su alcance de autoridad y perímetro de seguridad.
- Bloque 2: cerrado en su alcance de persistencia y comandos atómicos.
- Bloque 3: cerrado en su alcance de lecturas ligeras y exactas.
- Bloque 4: cerrado en su alcance de motor de caja registradora.
- Bloque 5: cerrado en su alcance de pickup operativo.
- Bloque 6: cerrado en su alcance de delivery y liquidación.
- Bloques 7 a 12: no iniciados.

Evidencia del Bloque 1:

- `docs/COUNTER_BLOCK_1_AUTHORITY_AUDIT_2026-07-24.md`

Evidencia del Bloque 2:

- `docs/COUNTER_BLOCK_2_PERSISTENCE_AUDIT_2026-07-24.md`
- `docs/COUNTER_BLOCK_2_ATOMIC_PERSISTENCE_2026-07-24.sql`
- `docs/COUNTER_BLOCK_2_TRANSACTION_TESTS_2026-07-24.sql`
- `docs/COUNTER_BLOCK_2_ROLLBACK_2026-07-24.sql`

Evidencia del Bloque 3:

- `docs/COUNTER_BLOCK_3_READ_MODEL_AUDIT_2026-07-25.md`
- `docs/COUNTER_BLOCK_3_LIGHT_READ_MODEL_2026-07-25.sql`
- `docs/COUNTER_BLOCK_3_ROLLBACK_2026-07-25.sql`

Evidencia del Bloque 4:

- `docs/COUNTER_BLOCK_4_REGISTER_AUDIT_2026-07-25.md`
- `docs/COUNTER_BLOCK_4_REGISTER_ENGINE_2026-07-25.sql`
- `docs/COUNTER_BLOCK_4_HARDENING_2026-07-25.sql`
- `docs/COUNTER_BLOCK_4_REFUND_GUARD_2026-07-25.sql`
- `docs/COUNTER_BLOCK_4_ADVISOR_FIXES_2026-07-25.sql`
- `docs/COUNTER_BLOCK_4_ROLLBACK_2026-07-25.sql`

Evidencia del Bloque 5:

- `docs/COUNTER_BLOCK_5_PICKUP_AUDIT_2026-07-26.md`
- `docs/COUNTER_BLOCK_5_PICKUP_OPERATION_2026-07-26.sql`
- `docs/COUNTER_BLOCK_5_READ_HARDENING_2026-07-26.sql`
- `docs/COUNTER_BLOCK_5_COMPLETION_GUARD_2026-07-26.sql`
- `docs/COUNTER_BLOCK_5_ROLLBACK_2026-07-26.sql`

Evidencia del Bloque 6:

- `docs/COUNTER_BLOCK_6_DELIVERY_AUDIT_2026-07-27.md`
- `docs/COUNTER_BLOCK_6_DELIVERY_OPERATION_2026-07-27.sql`
- `docs/COUNTER_BLOCK_6_DIGITAL_CHANGE_EXECUTION_2026-07-27.sql`
- `docs/COUNTER_BLOCK_6_DISPATCH_IDEMPOTENCY_2026-07-27.sql`
- `docs/COUNTER_BLOCK_6_ROLLBACK_2026-07-27.sql`

Esta hoja de ruta convierte el contrato canónico de Counter en una secuencia de
trabajo. No autoriza por sí sola cambios en producción, despliegues, migraciones
remotas, commits o modificaciones de otros módulos.

## 1. Regla de ejecución

Los bloques se trabajan en orden.

```text
Primero autoridad y consistencia.
Después datos ligeros.
Después capacidades operativas completas.
Al final sincronización, rendimiento, diseño y certificación.
```

No se inicia un bloque nuevo hasta que el anterior:

1. tenga alcance confirmado;
2. esté implementado sin mezclar tareas del bloque siguiente;
3. pase sus verificaciones técnicas;
4. pase sus escenarios funcionales;
5. no introduzca regresiones conocidas;
6. sea aceptado para continuar.

Cada bloque debe poder revisarse, probarse y revertirse de forma independiente.

## 2. Protección frente a trabajo concurrente

Antes de comenzar cualquier bloque:

- revisar `git status`;
- identificar cambios ajenos ya presentes;
- no sobrescribir ni reformatear archivos fuera del alcance;
- no tocar `/app/master/dashboard`;
- no hacer refactors oportunistas de otros módulos;
- acordar cualquier cambio inevitable en un helper compartido;
- separar los cambios de base de datos de su aplicación remota;
- no desplegar ni hacer commit sin autorización.

Si otro módulo cambia simultáneamente una tabla o helper requerido por Counter,
el bloque se detiene en el punto de integración y se revisa compatibilidad antes
de continuar.

## 3. Método interno de cada bloque

Todos los bloques siguen esta mini-secuencia:

### A. Auditoría focalizada

- comparar implementación actual contra el contrato;
- listar archivos, funciones, tablas, políticas y flujos afectados;
- medir el comportamiento inicial cuando aplique;
- distinguir lo reutilizable de lo que debe corregirse.

### B. Diseño mínimo

- definir el cambio más pequeño que complete el bloque;
- evitar duplicar lógica canónica existente;
- precisar estados, permisos, transacciones e índices;
- acordar cualquier migración antes de aplicarla.

### C. Implementación

- comenzar por servidor/base de datos;
- continuar por acciones y dominio;
- integrar después la interfaz;
- mantener compatibilidad con datos existentes;
- añadir trazabilidad e idempotencia en la misma entrega.

### D. Verificación

- probar permisos con un usuario que tenga únicamente rol Counter;
- probar éxito, rechazo, reintento y concurrencia;
- ejecutar lint y build;
- validar consultas y saldos cuando aplique;
- comprobar que `/app/master/dashboard` no cambió.

### E. Cierre del bloque

- presentar evidencia de los escenarios aprobados;
- registrar pendientes reales, sin esconderlos en el bloque siguiente;
- actualizar esta ruta con el resultado;
- continuar solo después de la aceptación.

## 4. Definición general de terminado

Una función de Counter no está terminada solo porque exista un botón.

Debe cumplirse todo lo siguiente:

- la UI ofrece la acción correcta;
- la acción de servidor valida rol, estado y datos frescos;
- RLS/RPC permiten al Counter puro ejecutar exactamente lo autorizado;
- los roles no autorizados son rechazados;
- la operación es atómica o deja una recuperación explícita;
- un reintento no duplica pedidos, pagos, cambios ni cierres;
- el estado financiero proviene de la fuente canónica;
- la acción deja auditoría;
- la consulta está acotada e indexada;
- existen estados claros de carga, éxito, error y reintento;
- los escenarios de aceptación pasan.

## 5. Secuencia completa

| Bloque | Nombre | Resultado principal |
| --- | --- | --- |
| 0 | Contrato canónico | Alcance y reglas aprobadas |
| 1 | Autoridad y perímetro de seguridad | Counter puro puede hacer solo lo permitido |
| 2 | Persistencia y comandos atómicos | Estados y movimientos no quedan a medias |
| 3 | Capa de lectura ligera y exacta | Counter abre rápido sin perder precisión |
| 4 | Motor de caja registradora | Cobros, pagos mixtos, cambio y devoluciones |
| 5 | Pickup operativo | Modificar, cobrar y entregar pickup correctamente |
| 6 | Delivery y liquidación | Despachar, dar cambio y liquidar retornos |
| 7 | Venta directa y agenda | Registrar cliente y crear pedidos nuevos |
| 8 | Consulta histórica y recuperación | Informar, corregir agenda y cobrar órdenes viejas |
| 9 | Cajas, puntos y cierres | Operación diaria exacta de efectivo/POS |
| 10 | Sincronización, alertas y resiliencia | Datos vivos sin recargar toda la página |
| 11 | Experiencia operativa y acabado visual | Interfaz rápida, clara y enfocada |
| 12 | Certificación integral y salida controlada | Módulo validado de extremo a extremo |

## 6. Bloque 0 - Contrato canónico

Estado: **cerrado**.

Entregables existentes:

- contrato funcional;
- matriz de autoridad;
- separación entre entrega, pago y liquidación;
- reglas de pickup, delivery, caja, búsqueda y venta;
- contrato de ligereza y exactitud.

No se reabre durante la programación salvo que aparezca una contradicción de
negocio que requiera decisión expresa.

## 7. Bloque 1 - Autoridad y perímetro de seguridad

Estado: **cerrado el 2026-07-24**.

La migración remota `20260724230435_counter_block1_authority_boundary` fue
aplicada y la frontera de autoridad se verificó con una sesión controlada de
Counter puro. La prueba positiva de despacho sobre un delivery real `ready` y
asignado se repetirá antes de certificar el Bloque 6, porque al cerrar este
bloque no existía una orden elegible en la base.

### Objetivo

Hacer que un usuario con únicamente rol `counter` pueda leer y ejecutar las
competencias aprobadas, sin heredar poder de Master o Administración.

### Trabajo

- inventariar políticas RLS, grants, RPC y validaciones actuales;
- codificar la matriz canónica de acciones por rol;
- alinear helpers de dominio, Server Actions y base de datos;
- crear permisos de lectura acotados para órdenes operativas, clientes, pagos,
  cuentas permitidas y liquidaciones;
- crear permisos de escritura únicamente mediante comandos autorizados;
- impedir cancelación, cambio de modalidad, asignación de motorizado, confirmación
  bancaria y edición de delivery;
- impedir acceso administrativo a bancos y cuentas de Floresta;
- verificar autorización dentro de cada operación sensible;
- indexar columnas utilizadas por las políticas RLS.

Las políticas no pueden depender solo de `TO authenticated` ni de ocultar
controles en la interfaz.

Si se necesita una función privilegiada:

- debe tener una justificación concreta;
- validar `auth.uid()` y rol dentro de la función;
- usar `search_path` seguro;
- limitar `EXECUTE`;
- evitar una función `SECURITY DEFINER` pública y genérica.

### Entregables

- mapa RLS/RPC antes y después;
- permisos Counter implementados;
- pruebas positivas y negativas por rol;
- listado explícito de tablas y funciones expuestas.

### Criterios de salida

- un Counter puro ve su bandeja operativa;
- puede invocar solamente acciones aprobadas;
- no necesita rol Master/Admin para funcionar;
- no puede confirmar pagos bancarios;
- no puede cancelar ni cambiar modalidad;
- no puede administrar bancos;
- Master, Admin, asesor, cocina y motorizado conservan sus límites actuales.

### Fuera de alcance

- rediseño visual;
- cobros mixtos nuevos;
- nuevo modelo de liquidación;
- optimización general de consultas.

## 8. Bloque 2 - Persistencia y comandos atómicos

Estado: **cerrado el 2026-07-25**.

Se aplicaron las migraciones
`20260725204313_counter_block2_atomic_persistence`,
`20260725204543_counter_block2_closure_diagnostics` y
`20260725204741_counter_block2_exact_confirmation_timestamps`.

La auditoría final redujo el diseño a tres tablas nuevas. Las autorizaciones
reutilizan `money_movements`; no se creó una tabla ni una columna financiera
paralela. Las pruebas transaccionales, de rollback, reintento, cierre consecutivo
y concurrencia pasaron.

### Objetivo

Crear la base transaccional para que órdenes, pagos, cambios, devoluciones y
liquidaciones no queden parcialmente registradas.

### Trabajo

- formalizar los tres ejes: cumplimiento físico, estado financiero y liquidación
  de delivery;
- auditar `delivery_trips` y decidir si se amplía o si se crea una estructura
  específica de liquidación, sin duplicar conceptos;
- persistir cambio entregado, retorno esperado, retornos parciales, responsable y
  estado de custodia;
- representar autorizaciones de devolución y gastos superiores al límite;
- definir claves de idempotencia para acciones monetarias y de estado;
- crear restricciones que impidan montos, estados o vínculos inválidos;
- indexar claves foráneas y filtros operativos;
- convertir operaciones compuestas en transacciones cortas;
- bloquear filas en orden consistente cuando una operación toque varias cuentas;
- evitar llamadas externas dentro de transacciones;
- corregir el cálculo que pueda omitir movimientos posteriores a un cierre o
  baseline del mismo día.

Los detalles del esquema se deciden después de comparar la estructura existente.
No se crea una segunda fuente de verdad financiera.

### Comandos base esperados

- registrar operación monetaria de orden;
- aplicar varias líneas de pago y cambio de forma atómica;
- solicitar/autorizar/ejecutar devolución;
- despachar delivery;
- registrar retorno parcial o total;
- solicitar/aprobar gasto operativo;
- cerrar caja o punto con validación exacta.

Cada comando se expone al rol correspondiente en el bloque funcional que lo use.

### Entregables

- diseño de datos aprobado;
- migración versionada y reversible;
- comandos transaccionales;
- pruebas de idempotencia, rollback y concurrencia;
- diagnóstico de índices y restricciones.

### Criterios de salida

- una falla intermedia no deja pagos sin movimiento o movimientos sin vínculo;
- repetir una solicitud no duplica dinero;
- la liquidación sobrevive al cambio de turno y fecha;
- los saldos del mismo día incluyen movimientos posteriores al último cierre;
- no se rompe la verdad de `money_movements`.

## 9. Bloque 3 - Capa de lectura ligera y exacta

Estado: **cerrado el 2026-07-25**.

Se aplicaron las migraciones
`20260725221330_counter_block3_light_read_model` y
`20260725223121_counter_block3_pending_settlement_read`, más el ajuste
`20260725224226_counter_block3_normalized_search`. No se crearon tablas ni
índices nuevos; la apertura quedó reducida a configuración y cola en paralelo.

### Objetivo

Eliminar la carga masiva actual y entregar lecturas pequeñas, precisas y
especializadas.

### Lecturas separadas

1. Bandeja operativa activa.
2. Detalle de una orden seleccionada.
3. Búsqueda de clientes.
4. Búsqueda histórica de órdenes.
5. Resumen y movimientos de caja/punto.
6. Liquidaciones pendientes.
7. Catálogo y reglas semi-estables.

Una lectura no debe arrastrar datos de otra zona cerrada.

### Trabajo

- reemplazar la cascada de consultas de la página por lecturas compuestas
  acotadas;
- cargar inicialmente solo filas operativas activas;
- cargar items, reportes y detalle al seleccionar una orden;
- eliminar consultas N+1 mediante joins o cargas por lote;
- usar paginación por cursor en históricos y movimientos;
- crear índices compuestos o parciales que coincidan con filtros reales;
- obtener saldos exactos mediante una consulta agregada desde el último
  cierre/baseline más movimientos confirmados;
- cachear catálogo y reglas con invalidación, no datos vivos;
- revalidar precio, tasa, descuento y permisos al ejecutar una acción;
- medir planes con `EXPLAIN (ANALYZE, BUFFERS)` sobre datos representativos.

### Presupuesto inicial de consultas

Guardrail de diseño, sujeto a medición documentada:

- apertura de Counter: máximo cuatro lecturas lógicas;
- abrir una orden: una lectura compuesta de detalle;
- búsqueda: una lectura paginada por solicitud;
- abrir caja: resumen exacto más una página de movimientos;
- refresco vivo: solo delta o recurso afectado.

No se permite un `router.refresh()` periódico que vuelva a ejecutar toda la ruta.

### Entregables

- contrato de cada lectura y sus campos;
- índices justificados por consultas reales;
- medición antes/después;
- estados de carga y error independientes;
- página inicial sin precarga de caja, catálogo completo e histórico innecesario.

### Criterios de salida

- Counter abre con datos activos acotados;
- abrir una zona carga solo esa zona;
- la búsqueda profunda conserva precisión;
- los saldos coinciden con el ledger canónico;
- el costo no crece linealmente con todo el histórico.

## 10. Bloque 4 - Motor de caja registradora

Estado: **cerrado el 2026-07-25**.

Se aplicaron las migraciones remotas:

- `20260725234348_counter_block4_register_engine`;
- `20260725234507_counter_block4_hardening`;
- `20260725234706_counter_block4_refund_guard`;
- `20260726202857_counter_block4_financial_search_path`.

El motor procesa pagos, cambio, fondo y obligaciones digitales mediante una
sola intención idempotente. Los pagos pendientes siguen en `payment_reports`,
el dinero confirmado en `money_movements` y el fondo en
`client_fund_movements`. Solo se agregó una estructura específica para cambio
digital todavía no entregado.

### Objetivo

Construir un único motor confiable para cobrar cualquier orden permitida.

### Trabajo

- múltiples líneas de pago;
- efectivo USD/VES;
- puntos habilitados;
- pagos parciales;
- tasa y moneda de origen;
- cambio desde varias cajas;
- cambio combinado entre efectivo y digital;
- excedente a fondo del cliente;
- saldo restante de la orden;
- reportes digitales pendientes de Master/Admin;
- reglas de entrega según asesor asignado;
- autorización y ejecución de devoluciones;
- prevención de duplicados;
- resumen previo a confirmar;
- comprobante operativo posterior.

La confirmación debe enviarse como una sola intención idempotente. La interfaz no
debe ejecutar una secuencia de mutaciones financieras independientes.

### Reglas de bloqueo

- efectivo/punto esperado en Counter debe quedar confirmado antes de entregar,
  salvo excepción autorizada;
- pago digital pendiente con asesor no bloquea por sí solo;
- pago digital pendiente sin asesor sí bloquea hasta confirmación de Master;
- reporte pendiente nunca se muestra como dinero confirmado.

### Entregables

- componente de pago reutilizable;
- comando transaccional de pago/cambio;
- flujo de devolución autorizada;
- visualización clara de pagado, parcial, pendiente y saldo a favor;
- pruebas financieras por moneda y método.

### Criterios de salida

- pagos mixtos y parciales cuadran con el estado canónico;
- el cambio real afecta las cajas correctas;
- la parte digital permanece pendiente hasta confirmarse;
- un doble clic o reintento no duplica dinero;
- una devolución no crea deuda negativa ficticia.

## 11. Bloque 5 - Pickup operativo

Estado: **cerrado el 2026-07-26**.

Se aplicaron las migraciones
`20260726220533_counter_block5_pickup_operation`,
`20260726222410_counter_block5_trigger_safe_item_mutations`,
`20260726222552_counter_block5_timeline_recipient_types` y
`20260726223553_counter_block5_read_hardening` y
`20260726224452_counter_block5_completion_guard`.

El flujo permite corregir agenda, enviar a cocina, modificar un pickup activo y
entregarlo. Los pedidos listos o con precio protegido generan una solicitud
para Master Ops y no mutan hasta ser aprobados. La cola continúa ligera: las
solicitudes se leen únicamente al abrir el detalle y mediante un RPC acotado.
Las pruebas transaccionales terminaron en rollback y no dejaron artefactos.

### Objetivo

Completar el ciclo de un pickup desde agenda/cocina hasta entrega.

### Trabajo

- distinguir agendado, en cocina, listo y entregado;
- mostrar primero el pedido y la acción vigente;
- corregir fecha/hora de pickup antes de estar listo;
- enviar a cocina un pickup que deba prepararse ahora;
- agregar, reducir o eliminar productos antes de estar preparado;
- exigir motivo en reducciones/eliminaciones;
- devolver a cocina cuando una adición requiera preparación;
- solicitar autorización de Master para modificar un pedido ya preparado;
- impedir cancelación desde Counter;
- integrar el motor de cobro;
- marcar entrega física de pickup;
- conservar auditoría y avisos a cocina/asesor.

### Entregables

- flujo de modificación permitido por estado;
- autorización de excepción para pedido listo;
- entrega pickup con validación financiera;
- pruebas de interacción con cocina y saldo.

### Criterios de salida

- Counter no modifica unilateralmente un pickup empacado;
- no duplica la entrada a cocina;
- una reducción recalcula el saldo y genera devolución si aplica;
- una orden entregada queda inmutable salvo pagos;
- Counter nunca cancela.

## 12. Bloque 6 - Delivery y liquidación

Estado: **cerrado el 2026-07-27**.

Se aplicaron las migraciones
`20260727160408_counter_block_6_delivery_dispatch`,
`20260727160452_counter_block_6_delivery_read_model`,
`20260727161933_counter_block_6_digital_change_execution` y
`20260727162100_counter_block_6_dispatch_idempotency`.

No se creó ninguna tabla. El bloque reutiliza la custodia del Bloque 2, las
lecturas con cursor del Bloque 3, el ledger y las obligaciones digitales del
Bloque 4. Las pruebas transaccionales con rollback aprobaron salida,
idempotencia, cambio mixto, retorno parcial entre turnos, deuda separada,
discrepancia y límite de autoridad sobre la entrega final.

### Objetivo

Completar la salida al motorizado y la custodia del dinero hasta su liquidación,
incluso entre días y operadores distintos.

### Trabajo

- exigir motorizado/partner asignado por Master;
- entregar el pedido al motorizado;
- registrar ETA;
- cambiar a `en camino`;
- dejar que Master marque la entrega final;
- registrar cambio en efectivo por cuenta y moneda;
- registrar cambio digital gestionado por asesor o Master;
- calcular retorno esperado sin inventar movimientos;
- recibir retorno total o parcial;
- distinguir deuda del cliente de faltante del motorizado;
- mantener pendientes entre turnos;
- mostrar liquidaciones antiguas abiertas;
- aplicar el mismo contrato a motorizados internos y externos.

### Entregables

- bandeja de delivery listo;
- operación de despacho idempotente;
- registro persistente de cambio y custodia;
- flujo de retorno/liquidación;
- alertas de parcialidad y discrepancia.

### Criterios de salida

- una orden sin asignación no sale;
- ETA queda disponible para el asesor;
- el egreso de cambio coincide con lo entregado físicamente;
- la orden puede estar entregada y la liquidación seguir abierta;
- el siguiente operador ve el retorno pendiente;
- un faltante de custodia no se convierte en deuda del cliente.

## 13. Bloque 7 - Venta directa y agenda

### Objetivo

Atender a una persona que llega sin orden previa.

### Trabajo

- búsqueda previa obligatoria de cliente;
- creación con nombre y teléfono cuando no exista;
- prevención de duplicados;
- catálogo activo y productos configurables;
- combos y componentes canónicos;
- precios y tasa vigentes;
- descuento únicamente por regla activa;
- factura, nota de entrega, receptor y dirección cuando apliquen;
- elección pickup/delivery durante la creación;
- venta inmediata hacia cocina;
- venta futura hacia agenda;
- atribución de la venta a Mostrador;
- integración con el motor de cobro.

La creación de cliente, orden, items y evento inicial debe ser atómica o tener una
recuperación explícita que no deje órdenes incompletas.

### Entregables

- flujo de buscar/crear cliente;
- compositor de venta directa;
- creación inmediata y agendada;
- cobro opcional en el mismo flujo;
- pruebas de productos simples, combos y configurables.

### Criterios de salida

- no se crean ventas anónimas;
- la venta inmediata aparece una sola vez en cocina;
- la agendada no entra prematuramente a cocina;
- una regla de descuento vencida es rechazada al confirmar;
- una orden nueva conserva snapshots y semántica comunes.

## 14. Bloque 8 - Consulta histórica y recuperación operativa

### Objetivo

Permitir que Counter informe con precisión y actúe solo cuando el contrato lo
autorice sobre una orden fuera de la bandeja activa.

### Trabajo

- buscar por número corto, nombre y teléfono;
- normalizar teléfono;
- buscar nombre sin depender de acentos;
- paginar por cursor;
- mostrar fecha, hora, productos, modalidad, preparación, entrega y pago;
- abrir el expediente completo bajo demanda;
- corregir fecha/hora de pickup permitido;
- enviar a cocina sin duplicar;
- cobrar orden futura, antigua o ya entregada;
- reportar pago digital pendiente;
- bloquear edición operativa de órdenes entregadas/canceladas;
- derivar acciones disponibles desde estado y rol.

### Entregables

- buscador profundo;
- detalle histórico operativo;
- acciones contextuales;
- flujo de cobro de deuda antigua.

### Criterios de salida

- una orden antigua precisa puede localizarse sin precargar el histórico;
- el número mostrado es `orders.id`;
- Counter puede cobrar una orden entregada;
- no puede cambiar productos, fecha, modalidad ni entrega de una orden cerrada;
- los resultados no exponen auditoría financiera administrativa.

## 15. Bloque 9 - Cajas, puntos y cierres

### Objetivo

Completar la operación diaria de Caja Dark/DAR USD, Caja Dark/DAR VES y puntos
activos.

### Trabajo

- excluir cuentas de Floresta y bancos administrativos;
- mostrar saldo exacto, entradas, salidas y movimientos del día;
- mostrar autor de cada movimiento;
- registrar gasto manual de hasta USD 20 equivalentes;
- impedir división artificial para evadir el límite;
- registrar gastos mayores como pendientes;
- permitir confirmación solamente por Administración;
- integrar movimientos de cualquier rol en el saldo;
- cerrar con diferencia cero;
- bloquear diferencia no explicada;
- separar cierre POS de traspaso bancario;
- conservar movimientos posteriores al cierre/baseline del mismo día.

La carga de caja se realiza al abrir su espacio, no al abrir Counter.

### Entregables

- panel modular de cajas/puntos;
- movimiento menor y solicitud mayor;
- saldo exacto por cuenta;
- cierre de efectivo/POS;
- mensajes de diferencia y aprobación pendientes.

### Criterios de salida

- las cuentas visibles son únicamente las autorizadas;
- un movimiento pendiente no afecta saldo;
- un cierre incluye movimientos confirmados de todos los roles;
- ninguna diferencia distinta de cero cierra;
- cerrar POS no crea transferencia bancaria.

## 16. Bloque 10 - Sincronización, alertas y resiliencia

### Objetivo

Mantener la pantalla viva sin repetir toda la carga ni perder acciones ante fallas
de red.

### Trabajo

- sustituir el refresco global de 30 segundos;
- actualizar bandeja, detalle, pagos, caja y liquidaciones por recurso;
- usar Realtime, eventos, push o polling ligero según el dato;
- revalidar únicamente etiquetas o recursos afectados;
- avisar cuando el detalle abierto quedó desactualizado;
- impedir sobrescritura silenciosa de un estado más nuevo;
- ofrecer reintentos idempotentes;
- crear alertas y sonido para pedidos listos;
- evitar sonidos duplicados;
- recuperar conexión sin duplicar acciones;
- registrar métricas de consultas, errores y tiempos.

### Entregables

- estrategia de sincronización por tipo de dato;
- suscripciones focalizadas;
- estados de conexión/frescura;
- alertas visuales y sonoras;
- medición de invocaciones antes/después.

### Criterios de salida

- una orden lista aparece sin recargar toda la ruta;
- el sistema no multiplica consultas cuando la pestaña permanece abierta;
- un reintento no duplica dinero ni estado;
- Counter puede reconocer datos viejos o conexión caída;
- caja e históricos no se actualizan si sus paneles están cerrados.

## 17. Bloque 11 - Experiencia operativa y acabado visual

### Objetivo

Convertir las capacidades ya estables en una interfaz rápida y amigable para una
cajera que trabaja continuamente frente al mostrador.

### Trabajo

- conservar lista izquierda y área de trabajo;
- reducir filtros a los realmente operativos;
- priorizar número corto, cliente, modalidad, hora y acción;
- mostrar el pedido antes que controles secundarios;
- hacer compactas las acciones no vigentes;
- diseñar estados vacíos, carga, error, autorización y espera;
- facilitar teclado, foco y lectura rápida;
- evitar modales encadenados;
- mantener visible el contexto al abrir venta, caja o búsqueda;
- mejorar contraste, tamaño de objetivos y accesibilidad;
- extraer componentes a medida que cada capacidad madure;
- reducir el límite cliente y el bundle de `CounterClient.tsx`;
- probar resoluciones reales del equipo del local.

La separación del archivo monolítico debe seguir límites funcionales:

- shell/bandeja;
- detalle de orden;
- caja registradora;
- pickup;
- delivery;
- venta directa;
- búsqueda histórica;
- caja y cierres;
- alertas.

### Entregables

- arquitectura de componentes;
- layout operativo final;
- interacción consistente;
- comparación visual y de bundle antes/después.

### Criterios de salida

- la acción normal se entiende sin formación técnica;
- el pedido seleccionado permanece legible;
- no se muestra información financiera administrativa;
- las acciones peligrosas requieren confirmación clara;
- la estética no agrega consultas ni duplica estado.

## 18. Bloque 12 - Certificación integral y salida controlada

### Objetivo

Demostrar que Counter cumple el contrato completo antes de considerarlo terminado.

### Matrices de prueba

#### Roles

- Counter puro;
- Master;
- Administración;
- asesor;
- cocina;
- motorizado.

#### Ciclos operativos

- pickup pagado;
- pickup con efectivo pendiente;
- pickup con pago digital y asesor;
- pickup con pago digital sin asesor;
- modificación antes de preparar;
- modificación de preparado con autorización;
- devolución en efectivo y saldo a favor;
- delivery sin asignación;
- delivery con ETA;
- cambio mixto efectivo/digital;
- retorno el mismo día;
- retorno parcial;
- retorno al día siguiente;
- faltante de custodia;
- venta inmediata;
- venta agendada;
- cliente nuevo obligatorio;
- búsqueda histórica;
- pago de orden entregada;
- gasto menor;
- gasto mayor pendiente;
- cierre de caja;
- cierre POS sin transferencia.

#### Consistencia y fallas

- doble clic;
- timeout;
- pérdida de conexión;
- reintento;
- dos operadores sobre la misma orden;
- dos cierres concurrentes;
- pago confirmado mientras Counter tiene el detalle abierto;
- cambio de tasa o regla antes de confirmar.

#### Rendimiento

- primera carga;
- apertura de detalle;
- búsqueda profunda;
- caja/punto;
- refresco en reposo;
- tamaño del bundle cliente;
- planes de consultas e índices;
- crecimiento con histórico representativo.

### Verificación final

- lint;
- build;
- pruebas de base de datos;
- pruebas de permisos;
- pruebas funcionales en navegador;
- conciliación de saldos;
- revisión de logs;
- `git diff` limitado al alcance aprobado;
- confirmación de que `/app/master/dashboard` no cambió.

### Salida

El despliegue, migración remota o activación se realiza solo con autorización
expresa.

Debe existir:

- orden de aplicación de migraciones;
- respaldo o estrategia de reverso;
- usuario Counter puro para prueba;
- ventana de validación;
- observación inicial de errores y consultas;
- criterio explícito para revertir.

## 19. Dependencias entre bloques

La dependencia principal es lineal:

```text
0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> 12
```

Se permite preparar pruebas o inventarios del bloque siguiente, pero no integrar
su comportamiento antes de cerrar el actual.

Razones:

- sin Bloque 1, la UI puede ofrecer acciones que Counter no puede ejecutar;
- sin Bloque 2, los flujos de dinero pueden quedar a medias;
- sin Bloque 3, cada función nueva aumenta el costo de carga;
- Bloques 4-9 construyen capacidades sobre esas bases;
- Bloque 10 optimiza sincronización cuando los eventos ya son estables;
- Bloque 11 pule una operación ya correcta;
- Bloque 12 certifica el conjunto, no piezas aisladas.

## 20. Archivos y áreas esperadas

El inventario exacto se confirma al iniciar cada bloque. Áreas probables:

- `src/app/app/counter/page.tsx`
- `src/app/app/counter/CounterClient.tsx`
- `src/app/app/counter/actions.ts`
- nuevos componentes internos exclusivos de Counter;
- `src/lib/domain/*`
- `src/lib/orders/*`
- `src/lib/payments/*`
- `src/lib/finance/*`
- SQL/migraciones versionadas;
- documentación y evidencia de prueba.

Área prohibida durante esta ruta:

- `src/app/app/master/dashboard/*`

Un helper compartido solo se modifica si:

1. Counter realmente necesita el contrato común;
2. no puede resolverse correctamente en un helper del dominio;
3. se revisan todos sus consumidores;
4. se demuestra no regresión.

## 21. Próximo paso

El siguiente trabajo autorizado debe ser exclusivamente:

```text
Bloque 5 - Pickup operativo
```

Debe consumir el motor de caja ya cerrado y concentrarse en las reglas de
modificación, autorización y entrega física de pickup sin ampliar el alcance a
delivery ni a `/app/master/dashboard`.
