# Auditoría y cierre del bloque fuerte de Master Ops

Fecha: 2026-08-10

## Alcance y frontera

El bloque se ejecutó sobre `/app/master/ops` y superficies compartidas de lectura o
formato. No se modificó ningún archivo de `/app/master/dashboard`.

La consola pesada sigue siendo la consola administrativa y de respaldo en
producción. Master Ops conserva una carga inicial operativa; pagos e inventario
se abren mediante rutas separadas con `prefetch={false}`.

## Estado por frente

| Frente | Estado | Evidencia operativa |
| --- | --- | --- |
| Modificación avanzada | Cerrado | `created`, `queued`, `confirmed`, `in_kitchen` y `ready` admiten edición por Master/Admin. Los estados posteriores a salida del local no. |
| Auditoría de edición | Cerrado | En estados avanzados se exige motivo; se registra ajuste y evento, y Cocina recibe el aviso cuando la orden estaba en preparación. |
| Inventario al editar | Cerrado en la frontera actual | Editar una orden no ejecuta un descuento físico. La sincronización de compromisos es informativa/no bloqueante y la venta física se registra al entregar. |
| Cambio de operador | Cerrado | Botón `Cerrar sesión` en Master Ops; usa cierre local de Supabase y elimina la preferencia de módulo del equipo compartido. |
| Copia para verificar pagos | Cerrado | Cada reporte del detalle tiene `Copiar` con orden, cliente, monto, hora, cuenta, pagador, referencia, reportante y notas; omite el estado pendiente. |
| Finanzas operativas | Cerrado para este bloque | `/app/master/ops/finance` contiene cola, conteos, filtros, búsqueda, historial reciente y acceso al detalle para decidir. |
| Inventario operativo | Cerrado parcialmente y auditado | El adaptador permite consultar saldo/stock bajo, solicitar conteo, aceptar y pedir reconteo. Enlaza alertas y recepciones esperadas canónicas. |

## Modificación avanzada: resultado de la auditoría

La restricción reportada ya había quedado eliminada por el commit `f276065`
(`Allow advanced order edits in master ops`). La auditoría de este bloque confirmó
la cadena completa:

1. `canEditMasterOpsOrder` admite `confirmed`, `in_kitchen` y `ready`, además de
   los estados iniciales.
2. El editor pide un motivo de al menos cuatro caracteres cuando la orden ya
   avanzó.
3. `prepareMasterOpsOrderSave` vuelve a leer orden, líneas, catálogo y tasa; evita
   guardar sobre una versión vieja.
4. La mutación exige rol Master/Admin y vuelve a comprobar el estado real.
5. Se conserva el estado operativo, se reemplazan las líneas y se registra un
   evento `order_modified` más un ajuste `master_full_edit` o `admin_full_edit`.
6. Una orden entregada o cancelada no puede editarse desde Master Ops. Una orden
   que ya salió a delivery tampoco se presenta como editable.

No se creó una mutación paralela ni se relajaron permisos de Asesor.

## Finanzas ligera

La ruta nueva `/app/master/ops/finance`:

- no se consulta al cargar la pantalla principal;
- muestra conteos globales de reportes pendientes, confirmados y rechazados;
- filtra por estado y busca por orden, cliente, referencia, cuenta, pagador o
  reportante dentro de una ventana acotada;
- muestra el equivalente USD como referencia, sin alterar el monto reportado;
- reutiliza el mismo texto compacto de verificación;
- abre `/app/master/ops?openOrder=...&tab=pagos` para confirmar o rechazar con la
  semántica ya existente.

Quedan deliberadamente fuera: configuración de cuentas, estados de cuenta,
conciliaciones, cierres, líneas base y ajustes contables administrativos.

### Estado: trazabilidad financiera cronologica cerrada

Cuando se devuelve al cliente dinero que tenía en fondo, la salida ya queda
registrada en caja y en el libro contable, pero no aparece dentro de la orden
usada como referencia con una presentación equivalente a la de los pagos. Eso
impide que Master, Asesor y otros usuarios autorizados entiendan visualmente la
secuencia completa sin consultar la contabilidad.

Implementado el 2026-08-10:

- `read_order_financial_activity(bigint)` combina, sin mutar, hechos confirmados
  de `money_movements` y `client_fund_movements`;
- limita la lectura al Master/Admin o al asesor atribuido a la orden;
- presenta en orden cronologico pagos recibidos, fondo aplicado, cambio
  entregado, fondo neto guardado, restauraciones/reversiones, devoluciones por
  cancelacion y devoluciones posteriores del fondo;
- muestra moneda, monto original, equivalente USD cuando aplica, cuenta, fecha,
  actor, referencia y nota disponibles;
- conserva los reportes de pago debajo como evidencia separada; la secuencia
  muestra solo movimientos confirmados y no confunde un reporte pendiente con
  dinero real;
- no crea pagos, reportes ni asientos nuevos y no altera el saldo financiero de
  la orden.

Caso de control `orders.id = 1744`:

1. pago recibido: USD 100,00;
2. cambio entregado: USD 20,00;
3. excedente neto guardado en fondo: USD 40,40;
4. fondo devuelto posteriormente: VES 30.608,66, equivalente a USD 40,40.

Counter habia generado un credito temporal de USD 60,40 y una reversion de USD
20,00 por el cambio fisico. La proyeccion agrupa ambos asientos del mismo momento
y muestra el hecho de negocio correcto: USD 40,40 realmente guardados. La falla
era de trazabilidad visual, no de persistencia contable.

## Inventario: acciones de Master confirmadas

El contrato canónico asigna a Master las siguientes capacidades y ya existe una
superficie ejecutable para ellas:

- consultar saldo y stock bajo;
- solicitar un conteo ciego puntual a Cocina;
- revisar el conteo y aceptar o pedir reconteo selectivo;
- consultar alertas completas y marcarlas en gestión;
- crear, reprogramar o cancelar una recepción esperada, sin aumentar stock;
- consultar recepciones reales, movimientos, mermas y averías;
- abrir el historial completo de conteos.

Master no registra la recepción física, no corrige movimientos, no revierte
mermas/averías y no configura políticas. Esas fronteras se mantienen.

### Pendientes dependientes de la evolución de inventario

Siguen pendientes y deben avanzar solamente sobre la lectura canónica ya
estabilizada:

1. mostrar existencia física, comprometida, disponible y proyección por fecha;
2. resumir en el adaptador las entradas/producciones esperadas y su certeza;
3. mostrar dependencias concretas entre una orden y una fuente futura;
4. ofrecer la decisión estructurada de aprobar bajo riesgo o condicionar una
   orden a reposición/producción;
5. agregar un contador compacto de alertas de inventario en la cabecera de
   Operación cuando la API final de alertas quede estabilizada.

Implementado el 2026-08-10: el adaptador de inventario de Master consume
`inventory_reporting_workspace_v1` para mostrar por ítem el último conteo
físico, cantidad contada, responsable, fecha y antigüedad. El dato se calcula en
la lectura canónica y solo se carga al abrir `/app/master/ops/inventory`.

Hasta entonces, Master abre las superficies canónicas `Alertas activas` y
`Entradas esperadas`; no se creó una copia local de esos datos.

## Pendientes acumulados

1. Ampliar la trazabilidad ya instalada para devoluciones de fondo al cambio
   entregado, devoluciones por cancelación y demás salidas monetarias ligadas a
   una orden, sin duplicar el movimiento contable.
2. Existencia física, comprometida, disponible y proyección por fecha.
3. Resumen de entradas/producciones esperadas y su certeza.
4. Dependencias estructuradas entre órdenes y fuentes futuras.
5. Decisión estructurada de aprobar bajo riesgo o condicionar una orden a
   reposición/producción.
6. Contador compacto de alertas de inventario en la cabecera de Operación cuando
   la API final quede estabilizada.

La configuración financiera, conciliaciones, cierres y auditoría contable
completa continúan fuera de Master Ops. No son requisitos para cerrar su piloto
operativo ligero.

## Verificación técnica

- ESLint dirigido sobre los archivos modificados: aprobado.
- `npm run build`: aprobado con la ruta dinámica de finanzas incluida.
- No se incluyeron en los commits los cambios concurrentes de Counter ni su
  migración de pagos.
- No se cambió `/app/master/dashboard`.

## Prueba operativa recomendada

1. Iniciar como Master, cerrar sesión y comprobar que otro operador puede entrar
   en el mismo equipo.
2. Abrir una orden `in_kitchen`, modificar una línea con motivo y comprobar
   productos, evento y conservación del estado.
3. Abrir una orden `ready`, agregar o corregir una línea y comprobar el aviso a
   Cocina antes de continuar la entrega.
4. Copiar un reporte de pago y pegarlo en WhatsApp; debe comenzar con
   `Verificar pago` y no contener `PENDIENTE`.
5. Abrir `Pagos`, cambiar filtros, buscar una referencia y entrar a `Revisar pago`.
6. Abrir `Inventario`, luego `Alertas activas` y `Entradas esperadas`; todas las
   rutas deben regresar a Master Ops para un usuario Master.
