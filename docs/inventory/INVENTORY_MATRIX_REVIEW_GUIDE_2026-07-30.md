# Guía de revisión de la matriz de inventario

Fecha: 2026-07-30

Fuente: Supabase `vivo-ops-prod`, extracción de solo lectura.

Esta guía acompaña el contrato canónico y las matrices CSV. Los valores
`canonical_*_candidate` son clasificaciones automáticas para orientar la
revisión; no son decisiones aprobadas ni cambios en producción.

## Principio de arquitectura

Inventario se diseña como un dominio central compartido. Las pantallas de Master,
Admin, cocina, Counter y asesor serán adaptaciones operativas del mismo libro y no
sistemas paralelos.

- Master consulta el estado esperado actual, declara entradas futuras, revisa
  inventarios completos y analiza diferencias y trazabilidad.
- Admin dispone de esa misma consulta y además configura productos, ítems internos,
  recetas, modalidades de consumo, frecuencias, alertas y reversos.
- Cocina captura rápidamente recepciones, conteos, producciones, mermas y averías.
- Los productos comerciales y los consumibles internos pueden existir por separado.
- Un ítem declara por separado su modo de seguimiento y los disparadores que pueden
  consumirlo; puede admitir venta y producción sobre la misma existencia.
- El objetivo progresivo es controlar todos los consumibles relevantes sin forzar
  una fórmula falsa por pedido.

## 1. Archivos

| Archivo | Filas | Contenido |
| --- | ---: | --- |
| `INVENTORY_PRODUCT_MATRIX_2026-07-30.csv` | 153 | Catálogo, composición, enlaces actuales y columnas para decisión |
| `INVENTORY_ITEM_MATRIX_2026-07-30.csv` | 75 | Ítems físicos, unidades, saldos, usos y recetas |
| `INVENTORY_COMPONENT_MATRIX_2026-07-30.csv` | 233 | Relaciones detalladas entre padres y componentes |
| `INVENTORY_RECIPE_MATRIX_2026-07-30.csv` | 3 | Insumos de las dos recetas existentes |
| `INVENTORY_PREFRIED_DECISIONS_2026-07-30.csv` | 6 | Reglas confirmadas y pendientes por familia prefrita |
| `INVENTORY_CANONICAL_RECIPE_BACKLOG_2026-08-03.csv` | 12 | Recetas canónicas y parámetros de implementación |
| `INVENTORY_OPEN_DECISIONS_2026-08-03.md` | 4 frentes | Lista técnica de trabajo, sin preguntas repetidas |
| `INVENTORY_IMPLEMENTATION_ARCHITECTURE_2026-08-03.md` | — | Configurador universal, encaje con Supabase y brechas justificadas |
| `INVENTORY_MINIMAL_MIGRATION_PLAN_2026-08-04.md` | — | Reutilización columna por columna, cinco tablas justificadas y fases de limpieza |

## 2. Candidatos automáticos del catálogo

| Candidato | Productos |
| --- | ---: |
| `self` | 60 |
| `direct` | 21 |
| `components` | 32 |
| `review_ambiguous` | 14 |
| `unconfigured` | 26 |

Hay 50 productos marcados para revisión prioritaria. Un producto puede necesitar
revisión por más de una razón.

Las causas principales son:

- componentes y enlaces activos simultáneos;
- ausencia de resolución de inventario;
- producto con inventario deshabilitado que necesita una política explícita;
- diferencias entre campos heredados;
- más de un autoenlace.

## 3. Orden recomendado de revisión

### Grupo 1: prefritos y salsas

Se revisa primero porque ya existen decisiones operativas expresas y porque la
configuración actual contradice parte del contrato.

#### Prefritos

Hallazgos actuales:

- `Mini tequeño crudo` (ítem 1) es materia prima y tiene saldo negativo.
- `Mini tequeño prefrito` (ítem 2) tiene saldo 250, pero está huérfano: no tiene
  enlace de producto ni receta.
- `Mini Tequeños Fritos` (producto 5) descuenta actualmente 25 piezas crudas.
- `Mini Tequeños Pre-Fritos` (producto 6) se autoenlaza con otro ítem prefrito,
  pero no existe una receta crudo -> prefrito.
- `Tequeños Regulares Fritos` (producto 20) descuenta crudo directamente.
- `Tequeños Regulares Pre-Fritos` (producto 21) se autoenlaza, pero tampoco tiene
  receta de producción.

Decisión canónica corregida y confirmada:

```text
crudo -> fritura normal -> producto frito vendido

crudo -> preparación + enfriamiento -> prefrito almacenado
      -> venta de la presentación prefrita
```

El prefrito requiere existencia real para pedidos inmediatos. La receta tendrá
un tiempo inicial de referencia de 240 minutos hasta que el producto se enfríe
lo suficiente para empacarse y quedar disponible. El producto frito normal no
consume prefrito: consume crudo directamente.

No quedan datos de prefritos que bloqueen el contrato inicial. La capacidad
simultánea puede configurarse más adelante si se desea automatizar la planificación;
mientras tanto, el Master conserva la decisión final sobre cada solicitud.

Decisiones recibidas el 2026-07-30:

- crudo contado en piezas;
- prefrito almacenado en servicios;
- mini tequeños: 25 piezas por servicio;
- empanadas y cachitas: 20 piezas por servicio;
- mandocas y bombys: 25 piezas por servicio;
- stock objetivo: 10 servicios por familia;
- tiempo de preparación: aproximadamente 240 minutos;
- vida útil: aproximadamente 3 meses;
- presentaciones de crudo confirmadas: mini tequeños 200, empanadas 150 y
  cachitas 150, mandocas 100, bombys 150 y tequeños regulares 100;
- tequeños regulares: servicio de 5 piezas, prefrito solo bajo demanda y sin
  inventario prefrito objetivo;
- Dondys: crudos en lotes de 30, sin prefrito y vendidos en cantidades de 6, 3
  o 1 pieza, además de su uso en combos y Vivo Box.

Diez servicios se registró como stock objetivo orientativo, no como lote mínimo,
reserva de crudos ni reposición obligatoria. Puede mantenerse menos cuando el crudo
se prioriza para ventas fritas. Toda presentación prefrita, incluidos los tequeños
regulares bajo demanda, utiliza 240 minutos de anticipación. El asesor puede
agendar con advertencia y el Master define finalmente si se confirma.

Regla de fraccionamiento confirmada:

- el medio servicio se habilita explícitamente por producto;
- lo admiten mini tequeños, empanadas, cachitas, mandocas, bombys y Dondys
  fritos;
- no lo admiten los mixtos fritos ni los tequeños regulares;
- el medio servicio consume `floor(piezas_por_servicio / 2)` piezas crudas;
- para los servicios de 25 piezas, el medio servicio contiene y descuenta 12;
- el catálogo y la interfaz ya describen el redondeo hacia abajo, pero la regla
  canónica debe validarse también en la futura deducción de inventario;
- la captura actual del asesor permite cantidades decimales en productos no
  configurables sin comprobar que sean fritos. Esta es una brecha a corregir
  posteriormente, sin modificar ahora asesor, counter, cocina ni master.

Las diez composiciones mixtas auditadas fueron confirmadas. Cada mixto consume
directamente las cantidades crudas registradas actualmente (combinaciones de 12,
10 o 12 piezas por componente) y solo puede venderse en servicios completos.

#### Salsa tártara

Configuración actual:

```text
Receta 1:
1 kg Mayonesa
+ 0,05 Kg Menjurje
-> 1 Kg Salsa Tartara

Receta 2:
0,13 Kg Salsa Tartara
-> 1 pieza Salsa Tártara 5oz
```

Hallazgos:

- `Kg` y `kg` no están normalizados;
- la receta declara 1,05 kg de entrada y 1 kg de salida sin una merma explícita;
- el producto `Salsa Tártara 5oz` (id 24) no tiene enlace activo, aunque existe
  un ítem producido con ese nombre;
- 1 oz y 2 oz se autoenlazan a unidades separadas, pero no tienen receta desde la
  salsa a granel;
- `Salsa Tártara Galón` se maneja como una pieza independiente;
- la cantidad de 0,13 kg debe validarse contra la porción operativa llamada
  "5oz".

Decisión canónica ya acordada:

- pueden coexistir bases, salsa a granel y unidades listas;
- la capacidad inmediata puede considerar las bases;
- una transformación real evita contar dos veces granel y porciones;
- las unidades listas se descuentan como unidades;
- el servicio directo desde granel descuenta peso o volumen.

Dato que falta confirmar:

- si las tapas se inventariarán como ítems separados.

Decisiones recibidas posteriormente:

- fórmula: 0,050 kg de menjurje por cada kg real de mayonesa;
- la mayonesa se cuenta por recipiente y su contenido neto varía por marca o
  lote; un galón puede declarar 4 kg o alrededor de 3,760 kg y un recipiente
  llamado kilo puede declarar aproximadamente 940 o 960 g;
- la salida de una preparación se registra por los recipientes que realmente
  quedaron llenos, no por un rendimiento matemático fijo;
- la tártara se conserva en envases de 1 kg, de galón, en porciones de 1, 2 y 5
  oz o como remanente preparado;
- normalmente se mantienen listas las tres porciones;
- la disponibilidad desde mayonesa y menjurje es inmediata;
- `Salsa Tártara 5oz Obsequio` comparte el mismo stock físico de la presentación
  normal de 5 oz;
- un galón preparado puede convertirse posteriormente en porciones menores;
- un envase tipo kilo rinde aproximadamente 8 a 9 porciones de 5 oz; para
  disponibilidad proyectada se confirmó usar siempre 8 como rendimiento
  conservador, sin importar la marca;
- del rendimiento conservador se derivan 20 porciones de 2 oz y 40 porciones de
  1 oz por recipiente tipo kilo, equivalentes respectivamente a 0,050 y 0,025
  recipiente por porción;
- la salsa por galón o kilo puede venderse a un cliente mayorista mediante
  activación comercial temporal, pero el ítem físico permanece estable;
- los recipientes abiertos de tártara se cuentan como equivalentes fraccionarios
  en incrementos operativos de 0,25, 0,50 y 0,75;
- los vasos se inventariarán como suministros de `periodic_count`; no se descuentan
  automáticamente por cada salsa vendida;
- el menjurje se almacena en recipientes tipo kilo y también se expresa como
  cantidad de recipientes equivalentes, incluyendo fracciones como 2,50;
- el libro conserva el consumo preciso de receta y el conteo físico posterior
  puede originar un ajuste trazable si existe diferencia.

#### Mostaza miel

- llega terminada en envases de 1 kg;
- se mantienen porciones listas de 2 y 5 oz;
- rendimiento operativo inicial: 8 envases de 5 oz por kg;
- rendimiento proporcional derivado: aproximadamente 20 envases de 2 oz por kg;
- hace falta crear o seleccionar el ítem canónico del aderezo a granel de 1 kg,
  ya que el inventario auditado solo contiene las porciones terminadas.

### Grupo 2: bebidas

Decisiones confirmadas:

- todas las bebidas se cuentan y descuentan individualmente por pieza;
- Pepsi lata y Malta lata llegan en cajas de 24;
- Coca-Cola lata llega en cajas de 12;
- las botellas de 1 L, 1,5 L y 2 L llegan en paquetes de 6;
- las cajas o paquetes se convierten a piezas al registrar la recepción;
- `Coca-Cola 1,5 L Mayor` comparte el ítem físico de `Coca-Cola 1,5 L`;
- los duplicados promocionales de Pepsi lata y Malta lata comparten los ítems
  normales;
- el umbral crítico inicial es 10 piezas para cada bebida y se activa con
  disponibilidad menor o igual a 10;
- el umbral es editable por ítem físico, aunque la edición se exponga desde el
  catálogo de productos.

Pendiente antes de activar saldos:

- consolidar los ítems duplicados sin perder el historial;
- realizar conteo físico inicial, porque casi todos los saldos auditados son
  negativos;
- ajustar umbrales individualmente cuando exista información de rotación y
  despacho de proveedores.

Regla general de entradas confirmada:

- el empaque no obliga a recibir cajas o bolsas completas;
- una recepción puede mezclar empaques, fracciones y unidades sueltas;
- `1,5` cajas de 24 se convierte en 36 piezas;
- tres bolsas de mini tequeños de 200 más 153 piezas sueltas se convierten en 753
  piezas crudas;
- el saldo canónico queda en piezas individuales y la conversión utilizada se
  conserva como dato de la recepción.

### Grupo 3: mixtos, combos y promociones

Hay 14 productos con componentes y enlaces activos simultáneos.

El caso debe resolverse distinguiendo:

- componentes comerciales elegidos;
- efecto físico de cada componente;
- consumos adicionales propios del padre, si realmente existen.

No se deben conservar ambos mecanismos por comodidad si producen el mismo
descuento.

Decisiones confirmadas para packs y combos:

- Single Pack 6, 8 y 10: selección libre de la cantidad indicada entre mini
  tequeños, empanadas, cachitas, mandocas y bombys;
- la salsa de 1 oz del Single Pack es opcional;
- Vivo Box 6, 8 y 10: cantidad seleccionable indicada más 1 Dondy y 1 salsa de 2
  oz obligatorios, ambos fuera del total de piezas seleccionables;
- Baby, Sexy y Rumba normales conservan sus composiciones fijas auditadas;
- las versiones Ajustadas cambian componentes según necesidad y no deben tener
  stock propio;
- cada pedido debe congelar los componentes realmente utilizados antes de
  resolver el inventario;
- el motor debe expandir las reglas `fixed`, `selectable` y opcionales existentes
  sin condicionar por nombre de producto;
- una edición futura del catálogo solo afecta pedidos nuevos.

Brechas auditadas:

- los Ajustados tienen simultáneamente componentes y autoenlaces a inventarios
  propios, lo que debe consolidarse en política `components`;
- los Vivo Box apuntan a un producto Dondy histórico/inactivo y deben resolver al
  mismo ítem físico crudo canónico que `Dondy (und)`;
- Baby Mix posee componentes y enlaces directos al mismo tiempo; debe conservarse
  una sola ruta de resolución para evitar doble descuento.

#### Eventos y colegios

`Pack para Eventos` tiene actualmente un límite de 110 piezas y cuatro opciones
seleccionables. Ese límite no representa la operación real. `Pack para Colegios`
no tiene componentes y se autoenlaza a un inventario propio que tampoco
representa una existencia física.

Decisión de diseño propuesta:

- sustituir ambos usos futuros por `Evento personalizado`;
- permitir crear otras plantillas de evento desde catálogo con el mismo motor;
- permitir cantidades abiertas de productos físicos;
- interpretar las cantidades configuradas como piezas exactas;
- permitir por componente fritura desde cocina o fritura en el sitio;
- incluir salsas, bebidas y otros productos físicos cuando se soliciten;
- incluir stand, montaje, personal u otros servicios como productos de política
  `none`, con precio pero sin inventario;
- congelar componentes, instrucciones de empaque y precio negociado en la orden;
- conservar los productos antiguos solo para interpretar el historial;
- aplicar reservas dentro de 10 días y alertas de capacidad antes del horizonte.

El configurador actual ya trata `detail_units_limit = 0` como ausencia de límite
y permite cantidades enteras por componente, por lo que existe una base técnica
reutilizable. Todavía deben revisarse el snapshot físico y la captura comercial
del precio antes de implementar; no se modifica Master ni finanzas en esta fase.

La modalidad de preparación cambia la etapa, pero no el origen físico:

- frito desde cocina: consume crudo al prepararse;
- frito en el sitio: reserva crudo, lo despacha al evento y agrega un servicio no
  inventariable de fritura.

No se contempla entregar producto crudo al cliente dentro del flujo de eventos.
Ambas modalidades descuentan normalmente del inventario crudo de cada familia.

Un evento puede combinar productos fritos desde cocina con otros para freír en
el sitio. Para la fritura en sitio puede despacharse una cantidad de seguridad
mayor a la solicitada. El cierre debe conciliar enviado, utilizado, devuelto
utilizable y averiado; la devolución aumenta inventario y la avería no puede
descontarse una segunda vez después de la salida provisional.

La salsa es opcional por evento. Puede enviarse en porciones listas o en envases
tipo kilo a granel. Los recipientes adicionales solicitados durante el servicio
se agregan a la misma conciliación y el remanente retornado se expresa como
0,25, 0,50 o 0,75 del envase. El consumo es la diferencia entre lo enviado y lo
devuelto; una contaminación o pérdida se clasifica como avería.

#### Yukipack

El producto cargado como `Yukypack` es un jugo individual de 250 cm³ en envase de
cartón, no un combo. La denominación canónica confirmada es `Yukipack`. Debe usar
política `self`, unidad `pieza`, umbral inicial 10 y recepción por caja de 24 o
unidades sueltas. El ítem 75 será la identidad física canónica y el 73 se migrará
como alias histórico.

La tabla `order_item_components` existe, pero la auditoría no encontró filas
persistidas. Debe revisarse antes de decidir cualquier cambio de esquema.

### Grupo 4: beneficios del mes

Varios productos activos de beneficio no tienen resolución de inventario. Un
precio promocional o un obsequio no elimina el consumo físico.

Decisión confirmada:

- promociones, obsequios, cumpleaños, aniversario, Loyal, LC y Cliente Nuevo no
  tienen inventario físico propio;
- cada producto consume la presentación o composición que declara;
- cuando coincide con el producto normal, comparte su ítem físico;
- cuando la composición cambia, se congelan y expanden los componentes reales;
- los quince productos activos de Beneficio del Mes deben enlazarse a las mismas
  existencias crudas, prefritas o fritas resueltas para sus versiones normales;
- los Single Pack promocionales utilizan la selección real del pedido;
- los Dondys promocionales consumen el mismo Dondy crudo;
- la salsa de obsequio comparte la salsa física normal de 5 oz.

Resolución de inactivos revisados:

- los dos productos `Desayuno Woman Premium` quedan históricos y no reactivables;
  su composición no se considera confiable y cualquier oferta futura se crea
  como producto nuevo;
- Chiki Mix 6, 8 y 10 funciona igual que Single Pack 6, 8 y 10, respectivamente;
- `Empanadas de Cerdo Crudas` es estacional y probablemente se reactive en el
  último trimestre. Se confirmó que corresponde a la línea Pulled Pork: bolsa de
  100 piezas crudas, venta únicamente frita en servicios de 20 y sin inventario
  prefrito. Admite medio servicio de 10. El enlace actual de una pieza es
  incorrecto;
- existe además una empanada de cerdo especial para un restaurante, fabricada
  bajo demanda aproximadamente una vez al mes, recibida o producida por cantidad
  exacta y empacada en servicios completos de 20. Se entrega cruda, tiene receta
  distinta de Pulled Pork, usa un ítem separado, stock objetivo cero y un plazo
  habitual de 10 días.

### Grupo 5: conceptos no físicos

Decisión confirmada:

```text
Las líneas de delivery usan política none.
```

Permanecen en el catálogo y pueden formar parte de una orden, pero no crean
ítems, enlaces, movimientos, disponibilidad ni reposición de inventario.

La matriz contiene 17 filas cuyo nombre identifica delivery: 7 activas y 10
inactivas o históricas. La decisión `none` se conserva también en las históricas
para interpretar correctamente pedidos anteriores.

### Grupo 6: empaques y suministros de consumo variable

Las cajas, bolsas u otros suministros cuya utilización depende del pedido no se
deben descontar automáticamente.

Se clasifican como `periodic_count`:

- las recepciones aumentan existencia;
- los conteos establecen la existencia operativa;
- las diferencias reflejan consumo no atribuido;
- el nivel crítico genera una necesidad de reposición;
- no bloquean una orden por una fórmula de empaque inexistente.

Para cajas y vasos queda confirmado además:

- cada tipo o presentación mantiene su propio ítem, frecuencia, mínimo y objetivo;
- pueden contarse quincenalmente aunque otro suministro se cuente semanal o
  mensualmente;
- el consumo del período se infiere comparando conteos y entradas, no simulando
  salidas por pedido;
- el historial muestra evolución, consumo promedio y cobertura estimada;
- si una presentación tiene mínimo 100 con comparador `<`, un conteo de 99 o menos
  genera inmediatamente una alerta de procura;
- reconocer la alerta o registrar una compra esperada cambia su seguimiento, pero
  no elimina la condición crítica antes de la recepción real;
- entre conteos puede existir una alerta predictiva claramente identificada como
  estimación;
- una planificación de compra no aumenta el stock; la recepción real sí.

Si en el futuro una presentación adquiere una regla estable, puede cambiarse a
consumo por producción o empaque desde una fecha determinada.

Las cajas, vasos y otros suministros aún no cargados se asignarán a programas de
conteo semanales, quincenales, mensuales u otros según el ítem. El supervisor del
área será una responsabilidad o permiso asignable, no un nuevo rol global por
defecto. La aplicación auditada no tiene actualmente un rol `supervisor`.

### Programas de conteo confirmados

- por turno: crudos, prefritos almacenados, salsas y bebidas;
- periódicos: cajas, vasos y otros suministros;
- un ítem puede pertenecer también a una revisión mensual general;
- el cierre de turno solo muestra su lista asignada;
- la frecuencia se configura sobre el ítem físico aunque se exponga desde el
  catálogo de productos;
- la captura es ciega: no muestra saldo esperado durante el conteo;
- el saldo esperado de cada ítem parte de su último conteo confirmado y suma los
  movimientos registrados hasta la hora exacta en que se contó esa línea;
- si existe diferencia, cocina puede realizar un segundo conteo antes de confirmar;
- se conservan tanto el primer conteo como el reconteo;
- una diferencia persistente admite motivo, nota y referencia a una bolsa,
  recepción o lote sospechoso;
- una bolsa nominal de 200 puede registrar su cantidad física verificada y quedar
  pendiente de comparación con los libros de fábrica;
- una explicación conocida o sospechada debe registrarse; también se permite
  `causa desconocida`;
- el conteo final confirmado ajusta inmediatamente el stock y la disponibilidad,
  tanto si la diferencia es negativa como si es positiva;
- el usuario que confirma el inventario queda identificado como responsable de
  esas cantidades;
- Master revisa el caso después del ajuste y puede aceptarlo, dejarlo en
  investigación o solicitar un nuevo conteo, pero no edita ni aprueba el saldo;
- al terminar el cierre, Master recibe una notificación y abre un reporte con todos
  los ítems inventariados, no solamente los que tienen diferencias;
- cada línea muestra último conteo, movimientos posteriores, esperado, contado,
  diferencia, ajuste aplicado y saldo al cierre;
- si el reporte se abre más tarde, el saldo vigente se muestra aparte para no
  confundir movimientos nuevos con una modificación del cierre histórico;
- Master puede aceptar el cierre completo o pedir reconteo de uno o varios ítems
  específicos, sin repetir las líneas con las que está conforme;
- mientras se realiza el nuevo conteo, la última cantidad física confirmada sigue
  siendo la autoridad operativa;
- el reconteo crea un nuevo registro y movimiento, sin borrar el caso anterior;
- cocina puede registrar un conteo puntual de uno o varios ítems solicitado
  personalmente por Master; actualiza esos ítems, notifica el resultado y no
  sustituye el inventario completo del cambio de guardia;
- solo Admin puede revertir un ajuste aplicado, mediante un reverso trazable;
- un conteo vencido alerta al Master mientras el local permanece abierto;
- si el turno cierra sin conteo, queda marcado como no realizado;
- la omisión nunca bloquea pedidos ni otras operaciones.

### Grupo 7: productos inactivos

Se clasifican después de los activos. Deben conservar suficiente información
para interpretar pedidos históricos, pero no requieren prioridad operativa.

### Grupo 8: alta de productos nuevos

El catálogo auditado no será una lista cerrada. Todo producto nuevo o importado
debe pasar por un asistente genérico que obligue a elegir `self`, `direct`,
`components` o `none`, configurar sus unidades, receta, componentes, tiempo,
disponibilidad y umbral, y validar una venta de prueba antes de activarlo.

Este asistente también debe funcionar desde un catálogo vacío y permitir crear
la existencia física, sus presentaciones de entrada y el producto comercial en
una secuencia guiada.

Una importación externa queda inactiva y en revisión. Debe buscar y mapear ítems
existentes antes de crear duplicados. El motor nunca debe contener excepciones
por nombre de producto.

### Grupo 9: averías, mermas y pruebas de cocina

Decisiones confirmadas:

- cocina reporta después de cada turno desde su aplicación;
- avería: pieza ya frita que no cumple el estándar de calidad;
- merma: pieza cruda de aspecto dudoso que se aparta en una bolsa;
- dañado: producto inutilizable por accidente, contaminación, vencimiento u otra
  condición;
- prueba de calidad: consumo operativo esperado para verificar el producto;
- producto y cantidad son obligatorios;
- causa, nota y fotografía no son obligatorias;
- los registros de cocina afectan disponibilidad inmediatamente y el Master
  revisa, pero solo Admin puede revertirlos; no existe aprobación previa;
- la merma se cuenta y descuenta una sola vez por turno; no se rastrea ni se
  registra cuándo la bolsa sale posteriormente hacia fábrica;
- las pruebas de calidad se reportan por su cantidad exacta;
- el cierre de turno aplica primero ventas, averías, mermas, dañados y pruebas;
  cualquier diferencia restante queda como variación inexplicada para revisión.

### Grupo 10: expectativas y recepciones

- Master declara cantidades y fechas esperadas;
- cocina registra la mercancía físicamente recibida;
- la recepción real puede expresarse en bolsas, paquetes y unidades sueltas;
- una recepción cierra completamente su expectativa aunque llegue menos o más;
- no se arrastra automáticamente la diferencia como cantidad todavía esperada;
- si fábrica confirma un saldo adicional, Master crea una expectativa nueva;
- la diferencia se conserva como dato de auditoría y puede alertar pedidos
  dependientes, pero nunca aumenta inventario;
- cocina puede recibir mercancía no planificada;
- el conteo confirmado aplica inmediatamente; Master o Admin revisan la variación
  y pueden solicitar un reconteo, pero no aprueban el saldo;
- únicamente Admin revierte averías, mermas, dañados y pruebas de calidad.

### Centro de alertas confirmado

El centro de inventario separará los pendientes activos en:

- conteos y diferencias;
- procura;
- producción y abastecimiento;
- configuración y calidad de datos, principalmente para Admin.

El reporte conserva todas las diferencias, pero una tolerancia configurable por
ítem o familia determina cuáles se destacan como anomalía. El resumen muestra solo
prioridades y cantidades por bandeja; los detalles, filtros e historial se abren
dentro de inventario. Casos repetidos se agrupan sin perder eventos y los resueltos
salen de la bandeja activa, pero permanecen auditables.

## 4. Cómo completar las matrices

### Producto

Completar:

- `canonical_policy_decision`;
- `canonical_inventory_target`;
- `canonical_quantity`;
- `canonical_deduction_stage`;
- `canonical_availability_mode`;
- `canonical_recipe_or_source`;
- `canonical_lead_time_minutes`;
- `canonical_critical_threshold`;
- `decision_notes`.

Valores recomendados:

```text
policy: self | direct | components | none
stage: kitchen | production | packing | fulfillment
availability: on_hand_only | immediate_recipe | scheduled_recipe
```

### Ítem

Completar:

- rol físico;
- modo de seguimiento;
- disparadores de consumo permitidos;
- unidad base;
- conversión de presentación;
- modo de disponibilidad;
- nivel crítico;
- frecuencia de conteo;
- stock objetivo;
- conteo inicial.

Modos de seguimiento recomendados:

```text
transactional
periodic_count
not_tracked
```

Disparadores combinables para ítems transaccionales:

```text
sale
production
manual_issue
```

### Receta

Completar:

- tiempo;
- disponibilidad inmediata o programada;
- lote mínimo;
- múltiplo;
- capacidad simultánea;
- margen;
- vida útil;
- vigencia.

## 5. Regla de avance

Una fila no se considera aprobada hasta que:

- el producto comercial resuelva a un efecto físico;
- la unidad sea inequívoca;
- no exista doble descuento;
- el momento del consumo esté definido;
- la disponibilidad inmediata o futura esté definida;
- una persona responsable valide cantidades y rendimientos.

Ninguna columna canónica de estas matrices ha sido aplicada a Supabase.

## 6. Pendientes actuales

### Consolidación de la matriz

La pasada del 2026-08-03 dejó:

- 153 de 153 productos con política y estado canónicos;
- 75 de 75 ítems clasificados como confirmados, migración, configuración parcial o
  decisión de negocio explícita;
- 233 de 233 relaciones de componentes con resolución canónica;
- las 3 filas de recetas existentes consolidadas;
- 12 reglas en el backlog canónico de recetas.

Las preguntas reales quedaron reducidas al archivo
`INVENTORY_OPEN_DECISIONS_2026-08-03.md`.

### Información operativa todavía necesaria

- salsas: decisión separada sobre tapas;
- cajas, vasos y demás suministros: catálogo de presentaciones, unidad, frecuencia,
  mínimo, objetivo y responsable;
- alertas de diferencia: tolerancia absoluta o porcentual por familia;
- programas de conteo: hora, lista exacta y persona o permiso responsable;
- procura: proveedor o fuente, tiempo de entrega, múltiplos y destinatarios de la
  alerta cuando esos datos se conozcan.

### Diseño técnico previo a implementación

- mapear cada capacidad faltante contra tablas, columnas, vistas o funciones
  existentes antes de proponer estructuras nuevas;
- resolver ítems duplicados, unidades inconsistentes y dobles rutas de descuento;
- comprobar cómo conservar la selección real de combos y eventos, porque
  `order_item_components` no contiene registros en la auditoría;
- diseñar comandos transaccionales e idempotentes para movimientos, conteos,
  reservas, recepciones, producción y reversos;
- definir RLS y permisos con el mismo alcance del contrato;
- preparar la estrategia de migración, conteo físico inicial y `opening_balance`;
- ejecutar los escenarios de prueba antes de integrar Master, cocina, Counter o
  asesor.
