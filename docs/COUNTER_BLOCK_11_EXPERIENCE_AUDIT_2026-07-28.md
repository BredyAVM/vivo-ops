# Auditoría del Bloque 11 de Counter - Experiencia operativa

Fecha: 2026-07-28

## Resultado

El Bloque 11 reorganiza `/app/counter` como una superficie diaria de mostrador,
sin agregar consultas, tablas, RPC, migraciones ni capacidades financieras
administrativas.

La bandeja conserva la lista izquierda y el área de trabajo. La lectura prioriza:

1. número corto;
2. cliente;
3. acción vigente;
4. modalidad;
5. hora o agenda;
6. estado operativo;
7. pago como dato secundario.

## Arquitectura resultante

- `CounterClient.tsx`
  - shell, bandeja y selección;
  - sincronización y alertas;
  - apertura bajo demanda de cada superficie;
  - coordinación de comandos ya existentes.
- `CounterOrderWorkspace.tsx`
  - detalle legible de la orden;
  - pickup, agenda y modificación;
  - salida y liquidación de delivery;
  - cobro, devolución y confirmación de entrega.
- `CounterQuickSaleWorkspace.tsx`
  - cliente obligatorio;
  - venta inmediata o agendada;
  - productos, configuración, descuento y datos de entrega.
- `CounterCashWorkspace.tsx`
  - cajas DAR y puntos;
  - movimientos operativos;
  - solicitudes mayores y cierres.
- `CounterHistoricalSearchWorkspace.tsx`
  - búsqueda profunda paginada;
  - apertura de expediente y cobro.
- `CounterDeliveryWorkspace.tsx`, `CounterPaymentEngine.tsx` y
  `CounterRefundPanel.tsx`
  - mantienen los límites funcionales ya creados en bloques anteriores.

Venta, caja, histórico y detalle de orden se cargan únicamente cuando se abren.
La división es de JavaScript y presentación: no duplica estado financiero ni
crea una segunda fuente de verdad.

## Cambios de experiencia

- cuatro filtros operativos:
  - `Atender ahora`;
  - `Pickup`;
  - `Delivery`;
  - `Seguimiento`;
- `Seguimiento` reúne agenda y cocina sin mezclar esas consultas con la cola de
  entrega;
- la tarjeta muestra la acción esperada antes que el total;
- el pedido aparece antes del recorrido operativo;
- el recorrido queda plegado como información secundaria;
- venta directa conserva visible la orden que estaba seleccionada;
- caja, liquidaciones y búsqueda siguen abriéndose sin perder la bandeja;
- `/` enfoca la búsqueda local;
- flechas arriba y abajo recorren las órdenes de la vista;
- filtros y selección exponen su estado a tecnologías de asistencia;
- objetivos principales tienen al menos 44 px de alto y foco visible;
- errores y confirmaciones usan regiones semánticas de estado;
- la entrega pickup exige una confirmación explícita en línea;
- la salida delivery conserva su revisión específica existente;
- no se agregaron modales encadenados.

## Comparación de peso

Medición sobre `next build`, chunks JavaScript crudos sin compresión:

| Medida | Antes | Después | Cambio |
| --- | ---: | ---: | ---: |
| JavaScript inicial asociado a `/app/counter` | 414.463 B | 339.694 B | -74.769 B (-18,0 %) |
| `CounterClient.tsx` | 6.064 líneas / 245.258 B | 2.365 líneas / 86.793 B | -61,0 % líneas / -64,6 % bytes |

Superficies diferidas resultantes:

| Superficie | Chunk crudo |
| --- | ---: |
| Detalle de orden, pickup y delivery | 80.649 B |
| Venta directa | 35.010 B |
| Caja y cierres | 22.627 B |
| Búsqueda histórica | 6.667 B |

Los nombres hash de los chunks pueden cambiar entre compilaciones. La medición
compara el conjunto inicial declarado por el manifiesto cliente de la ruta.

## Consultas y persistencia

- no hay una consulta nueva por estética;
- seleccionar una orden conserva la carga exacta bajo demanda ya existente;
- abrir venta conserva la carga única del catálogo ya existente;
- abrir caja conserva la lectura exacta por recurso ya existente;
- histórico continúa sin precarga y solo consulta al ejecutar una búsqueda;
- no se modificaron acciones server, SQL, políticas ni esquema.

## Validación

- ESLint focalizado de los cinco archivos de Counter modificados: aprobado sin
  errores ni advertencias;
- TypeScript `--noEmit`: aprobado;
- `next build`: aprobado;
- revisión de chunks del manifiesto cliente: aprobada;
- revisión de alcance: no se modificó `/app/master/dashboard`;
- migraciones requeridas: ninguna.

La sesión de navegador disponible no tenía autenticación de Counter y redirigió
a `/login`. Por esa razón, la aceptación visual firmada en el monitor real del
local queda expresamente incluida en la certificación integral del Bloque 12;
no se usó un bypass de autenticación ni se alteró el programa para simularla.

## Cierre

El Bloque 11 queda cerrado en implementación y validación técnica. El siguiente
paso es el Bloque 12: matriz integral, prueba autenticada con operador y salida
controlada.
