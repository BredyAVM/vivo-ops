# Contrato canónico de inventario - VIVO Ops

Fecha: 2026-07-30

Estado: **borrador v1 para validación operativa producto por producto**.

Este documento define la lógica compartida de inventario para catálogo, asesor,
Master, cocina, Counter y administración. No certifica que la implementación
actual cumpla estas reglas y no autoriza por sí solo cambios de esquema.

El objetivo es establecer un único centro de verdad antes de construir pantallas
o integrar nuevos flujos.

## 1. Alcance y límites

Este contrato cubre:

- entradas de mercancía;
- inventario físico;
- consumo por ventas;
- productos que se descuentan a sí mismos;
- productos que consumen otros ítems;
- combos y componentes seleccionados;
- preparaciones y recetas;
- prefritos;
- salsas a granel y porcionadas;
- mermas y averías;
- ajustes y conteos físicos;
- demanda futura, reservas y reposiciones proyectadas;
- horizonte operativo;
- alertas;
- reportes;
- permisos por rol.

Este contrato no redefine:

- precios;
- pagos;
- cuentas;
- comisiones;
- cierres financieros;
- estados generales de cocina o Counter, salvo el punto exacto donde ocurre un
  hecho físico de inventario.

Finanzas no participa en el libro de cantidades. Más adelante una recepción
puede relacionarse con una compra, pero cantidad física y dinero siguen siendo
autoridades distintas.

## 2. Auditoría base

Fuente: proyecto Supabase `vivo-ops-prod`.

Corte de lectura: 2026-07-30. La base es operativa y puede cambiar después de
este corte.

| Hallazgo | Valor |
| --- | ---: |
| Productos | 153 |
| Productos activos | 111 |
| Productos con `inventory_enabled` | 125 |
| Componentes comerciales | 233 |
| Enlaces producto-inventario | 110 |
| Ítems físicos | 75 |
| Ítems con saldo negativo | 56 |
| Movimientos | 3.605 |
| Tipos de movimiento utilizados | 1 (`sale_out`) |
| Recetas | 2 |
| Componentes de receta | 3 |
| Selecciones persistidas en `order_item_components` | 0 |
| Productos con componentes y enlaces activos simultáneos | 14 |
| Productos habilitados sin enlace ni componentes | 1 |
| Diferencias `type` / `is_combo` | 10 |
| Diferencias `inventory_enabled` / `is_inventory_item` | 3 |
| Productos autoenlazados cuyo saldo difiere del ítem físico | 53 |
| Nombres de ítem duplicados sin distinguir mayúsculas | 2 |

Conclusión:

```text
Las tablas actuales forman una base reutilizable.
Los saldos actuales y la trazabilidad histórica no son una línea base confiable.
```

No se deben crear nuevas tablas hasta terminar la matriz del catálogo y mapear
cada brecha contra las estructuras existentes.

## 3. Separación de conceptos

### 3.1 Producto de catálogo

Es lo que el cliente compra o selecciona. Vive conceptualmente en `products`.

No es necesariamente una existencia física.

### 3.2 Ítem de inventario

Es algo que existe, se almacena y puede contarse. Vive conceptualmente en
`inventory_items`.

Ejemplos:

- refresco de dos litros;
- tequeño crudo;
- servicio de tequeños prefritos;
- base de mayonesa;
- mezcla de verduras;
- salsa tártara a granel;
- salsa tártara porcionada;
- vaso o tapa, si se decide inventariarlos.

### 3.3 Composición comercial

Define qué incluye o permite elegir un producto o combo. La estructura existente
es `product_components`.

No determina por sí sola el movimiento físico. Cada componente elegido debe
resolver después su propia política de inventario.

### 3.4 Política de inventario del producto

Define cómo una unidad vendida llega a uno o más ítems físicos. La estructura
actual reutilizable es `product_inventory_links`.

### 3.5 Receta

Define una transformación física:

```text
insumos -> producto preparado
```

Las estructuras actuales reutilizables son `inventory_recipes` e
`inventory_recipe_components`.

### 3.6 Libro de movimientos

Registra hechos físicos. La estructura actual es `inventory_movements`.

Una reserva, una promesa futura o una producción planificada no son movimientos
físicos.

### 3.7 Seguimiento y disparadores de consumo del ítem

No todo ítem controlado debe descontarse automáticamente de una orden y un mismo
ítem puede consumirse por más de un hecho. Por ejemplo, una salsa a granel puede
venderse directamente o convertirse en porciones. Por eso no se usa una sola
enumeración que mezcle método de control y motivo de salida.

Cada ítem declara primero su modo de seguimiento:

| Modo de seguimiento | Cómo se controla | Ejemplos |
| --- | --- | --- |
| `transactional` | Entradas, salidas, transformaciones y conteos actualizan el libro | bebidas, crudos, prefritos, salsas |
| `periodic_count` | Entradas y conteos físicos; el consumo no atribuido se infiere entre conteos | cajas y empaques de uso variable |
| `not_tracked` | No representa una existencia física independiente | delivery y alias comerciales heredados |

Además, un ítem `transactional` declara uno o varios disparadores permitidos:

| Disparador | Hecho que genera la salida |
| --- | --- |
| `sale` | Venta o despacho del mismo ítem o de un producto enlazado |
| `production` | Uso como insumo de una receta, fritura o transformación |
| `manual_issue` | Uso interno conocido registrado expresamente |

Los conteos, pérdidas, devoluciones y ajustes son controles universales del libro,
no disparadores comerciales exclusivos. Un ítem puede declarar, por ejemplo,
`sale + production` sin duplicar su existencia.

`periodic_count` no significa que el ítem no se consuma. Significa que su consumo
no puede atribuirse de forma determinista a cada pedido.

Esta distinción evita inventar fórmulas de empaque que no representan la
operación real.

El modo de seguimiento no determina por sí solo cada cuánto se cuenta. Un ítem
puede pertenecer a uno o más programas de conteo: por turno para operación y,
además, a una revisión mensual general.

### 3.8 Dominio central y vistas por módulo

Inventario debe funcionar como un dominio propio y un único centro de verdad,
aunque no necesariamente aparezca como una aplicación aislada para todos los
usuarios. Master, Admin, cocina, Counter y otros módulos consumen proyecciones del
mismo libro, las mismas políticas y los mismos conteos, adaptadas a su operación.

Por tanto:

- ninguna pantalla mantiene un saldo paralelo;
- Master y Admin pueden consultar el mismo estado físico y la misma trazabilidad;
- cocina recibe flujos rápidos de recepción, conteo, producción y pérdidas;
- Counter y asesor reciben disponibilidad o acciones pertinentes, no el libro
  administrativo completo;
- una corrección o conteo se registra una vez y se refleja en todas las vistas;
- los permisos cambian acciones y nivel de detalle, no la definición del stock.

La complejidad justifica un apartado funcional de inventario con navegación
propia. Ese apartado puede exponerse dentro de cada módulo mediante vistas por rol,
sin duplicar reglas ni convertir Master, cocina o Admin en centros de verdad
independientes.

## 4. Política obligatoria para todo producto

Todo producto del catálogo debe tener una política explícita. No se permite que
`inventory_enabled = false` signifique simplemente "todavía no configurado".

Esta obligación aplica a productos comerciales. Los suministros internos, como
cajas, se clasifican por modo de seguimiento y no necesitan estar enlazados a
una venta.

Políticas canónicas:

### 4.1 `self`

El producto vendido descuenta exactamente un ítem equivalente.

Ejemplo:

```text
1 refresco de dos litros vendido
-> -1 refresco de dos litros
```

### 4.2 `direct`

El producto vendido consume uno o más ítems distintos.

Ejemplo:

```text
1 ración preparada por pedido
-> -10 piezas crudas
```

### 4.3 `components`

El producto padre se expande usando los componentes realmente seleccionados.
Cada hijo aplica su propia política.

Un combo con esta política no debe descontar simultáneamente enlaces directos en
el padre, salvo una regla adicional explícita y revisada, como un empaque propio.

La expansión debe ser genérica y admitir los modos comerciales existentes:

- `fixed`: componente que siempre se incluye;
- `selectable`: componente cuya cantidad o variedad elige el cliente;
- componente opcional: solo se incluye cuando fue aceptado en la orden;
- composición ajustable: utiliza la configuración vigente al crear la orden y
  congela el resultado seleccionado.

El motor continúa expandiendo cada componente hasta llegar a ítems físicos. Por
ejemplo, una selección de mini tequeños fritos termina consumiendo las piezas
crudas correspondientes; el combo padre no mantiene stock propio.

### 4.4 `none`

Solo para conceptos que no representan una salida física:

- envío;
- servicio;
- recargo;
- descuento;
- otro concepto expresamente no inventariable.

`none` es una decisión de negocio, no un valor por defecto.

Las líneas de delivery se mantienen en `products` porque forman parte del
catálogo comercial y posteriormente de una orden. Sin embargo:

- no crean un `inventory_item`;
- no requieren `product_inventory_links`;
- no generan movimientos;
- no tienen saldo, nivel crítico ni disponibilidad de inventario;
- no participan en recetas, reservas o reposiciones.

Su disponibilidad se gobierna por las reglas operativas y comerciales de zona,
no por inventario.

### 4.5 Prohibiciones

- No relacionar productos e ítems por coincidencia de nombre.
- No permitir más de una política principal activa.
- No crear ciclos indirectos entre composiciones.
- No interpretar `is_combo`, `inventory_enabled`, `is_inventory_item` o
  `inventory_deduction_mode` por separado como autoridad canónica durante la
  transición.

### 4.6 Alta, importación y migración de productos nuevos

El motor no puede depender de nombres conocidos ni de una lista cerrada del
catálogo actual. Cualquier producto creado mañana, importado desde otra fuente o
migrado desde un catálogo externo debe pasar por el mismo asistente de
configuración de inventario.

El mismo flujo debe funcionar con un catálogo vacío: permite crear primero la
existencia física y luego el producto comercial, o crear un producto que reutilice
existencias, componentes y recetas ya configurados.

Un producto nuevo comienza inactivo para ventas hasta declarar una política:

1. `self`: descuenta un ítem físico existente o uno nuevo expresamente aprobado;
2. `direct`: declara los ítems físicos y cantidades que consume;
3. `components`: declara componentes fijos, seleccionables y opcionales;
4. `none`: justifica que no representa una salida física.

El alta debe preguntar, según la política elegida:

- ítem físico canónico o búsqueda de coincidencias existentes;
- unidad base y presentaciones de entrada;
- cantidad consumida por venta, servicio completo y medio servicio;
- modo de seguimiento y disparadores de consumo;
- receta, insumos, rendimiento y tiempo cuando exista preparación;
- si el resultado se almacena o se produce bajo demanda;
- stock objetivo, umbral crítico y vida útil cuando apliquen;
- disponibilidad inmediata o programada;
- componentes, límites y reglas de selección;
- etapa del consumo;
- vigencia y fecha de activación.

Administración debe poder crear y configurar por separado:

- un producto comercial que consume inventario;
- un producto comercial `none` que no representa una salida física;
- un ítem físico interno que no se vende, como un consumible;
- una receta o transformación;
- sus presentaciones de compra o recepción;
- su modo de seguimiento, disparadores de consumo, programas de conteo y política
  de reposición.

No todo ítem inventariado necesita existir como producto vendible y no todo
producto del catálogo necesita tener existencia propia.

Antes de activar el producto, el sistema debe resolver una venta de prueba hasta
sus hojas físicas y comprobar que:

- no quedan ramas sin política;
- no hay ciclos;
- no existen dos rutas que descuenten lo mismo;
- las cantidades terminan en unidades válidas;
- las recetas y tiempos requeridos están completos;
- todo ítem nuevo fue creado deliberadamente después de buscar los existentes.

Una importación masiva no activa productos automáticamente. Conserva el
identificador externo, deja cada fila en revisión y permite mapearla a un producto
o ítem existente. Las decisiones pueden aplicarse por plantilla o familia, pero
cada resultado debe validarse. Así, agregar una bebida, una nueva receta, una
promoción o un tipo de evento no requiere programar una excepción por nombre.

## 5. Unidades y presentaciones

Cada ítem físico tiene una única unidad base estable:

- pieza;
- botella;
- lata;
- gramo;
- mililitro;
- servicio;
- porción.

Las presentaciones son conversiones de entrada o producción:

```text
2 paquetes de 24 latas -> +48 latas
4 envases de 1 kg -> +4.000 gramos
```

El empaque es una ayuda de captura y compra, no una restricción de recepción. Una
entrada puede combinar empaques completos, fracciones de empaque y unidades
sueltas:

```text
total_unidades_base
= (cantidad_empaques x unidades_por_empaque)
+ unidades_sueltas
```

Ejemplos confirmados:

```text
1,5 cajas de Pepsi lata x 24 = 36 latas

3 bolsas de mini tequeños x 200
+ 153 piezas sueltas
= 753 mini tequeños crudos
```

La interfaz debe mostrar la conversión y el total antes de confirmar. El
movimiento se registra una sola vez por el total en unidad base, conservando como
metadatos la presentación y las unidades sueltas capturadas.

Reglas:

- entradas, recetas, ventas, mermas y conteos terminan expresados en la unidad
  base;
- un ítem con movimientos no cambia su unidad base reinterpretando el historial;
- `kg` y `Kg` deben normalizarse;
- no se convierten kilogramos y galones sin una equivalencia medida;
- se admiten fracciones de caja, paquete, bolsa o recipiente cuando su conversión
  produzca una cantidad válida;
- bebidas y productos crudos pueden recibirse directamente como unidades sueltas;
- piezas, botellas y latas nunca terminan con saldo fraccionario;
- si una fracción de empaque no produce unidades enteras, se debe capturar la
  cantidad mediante unidades sueltas o corregir la conversión;
- peso o volumen pueden usar decimales con precisión definida.

## 6. Producción y recetas

Una receta debe definir como mínimo:

- salida física;
- cantidad de salida estándar;
- insumos y cantidades;
- tiempo de preparación;
- tamaño o múltiplo de lote;
- rendimiento esperado;
- estado y vigencia.

Para planificación de volumen también se requiere:

- capacidad simultánea;
- tiempo entre lotes, cuando aplique;
- margen de seguridad;
- vida útil o tiempo máximo de conservación, cuando sea operativo.

El tiempo pertenece a la receta, no al producto comercial.

### 6.1 Producción atómica

Completar un lote debe registrar, en una sola operación:

```text
-insumos
+salida real
```

El resultado real puede diferir del estándar. La diferencia debe ser trazable
como rendimiento o merma; no se fabrica un saldo teórico.

### 6.2 Preparación inmediata

Una receta inmediata permite que sus insumos contribuyan a la disponibilidad
actual.

Ejemplo: salsa preparada desde bases disponibles.

### 6.3 Preparación programada

Una receta con horas de anticipación solo aporta capacidad futura. Los insumos no
equivalen a producto disponible ahora.

Ejemplo: prefritos que solo quedan disponibles después de completar la
preparación, el enfriamiento y el empacado. El lapso operativo inicial es de
aproximadamente cuatro horas.

### 6.4 Venta de productos crudos

Los productos crudos estándar permanecen disponibles para venta a clientes
mayoristas. No constituyen una existencia paralela: la venta cruda, la fritura
normal y la preparación de prefritos consumen el mismo ítem físico crudo.

Reglas:

- una venta cruda descuenta la cantidad de piezas declarada por el producto;
- una tarifa mayorista o condición especial de cliente no crea otro saldo;
- bolsas y servicios comerciales son conversiones del mismo ítem base;
- si nace una receta distinta, como la empanada especial de restaurante, debe
  contar con su propia identidad física y no mezclarse con una receta estándar;
- la regla de eventos permanece separada: el producto puede freírse en cocina o en
  el sitio, pero no se entrega crudo al cliente del evento.

## 7. Prefritos

Cuando el producto prefrito se prepara, almacena y cuenta antes de venderse, es
un ítem físico independiente. El prefrito es una presentación separada y no una
etapa obligatoria para producir el frito normal.

```text
crudo -> fritura normal -> producto frito vendido

crudo -> preparación prefrita -> enfriamiento -> empacado
      -> servicio prefrito almacenado -> venta como prefrito
```

Ejemplo:

```text
100 piezas crudas
-> 10 servicios prefritos
Tiempo: 240 minutos
```

Reglas:

- el stock inmediato es el número de servicios prefritos existentes;
- la unidad física canónica del prefrito almacenado es `servicio`;
- cada servicio declara cuántas piezas contiene;
- las piezas crudas representan capacidad futura;
- la venta de un producto frito normal consume piezas crudas directamente;
- la venta de una presentación prefrita consume el servicio prefrito almacenado;
- una venta no puede transformar crudos en prefritos silenciosamente;
- cocina debe completar primero la producción;
- una producción puede vincularse a uno o más pedidos futuros;
- el rendimiento real de servicios debe registrarse;
- el asesor puede agendar y enviar una solicitud aunque el stock inmediato no
  alcance;
- la insuficiencia genera una advertencia, pero no bloquea al asesor;
- el Master decide finalmente si confirma, condiciona, devuelve o rechaza según
  el prefrito existente, el crudo disponible y la producción prevista.

Decisiones operativas confirmadas:

| Familia | Presentación de crudo | Piezas por servicio prefrito | Stock objetivo |
| --- | ---: | ---: | ---: |
| Mini tequeños | 200 piezas | 25 | 10 servicios |
| Empanadas | 150 piezas | 20 | 10 servicios |
| Cachitas | 150 piezas | 20 | 10 servicios |
| Mandocas | 100 piezas | 25 | 10 servicios |
| Bombys | 150 piezas | 25 | 10 servicios |

Los tequeños regulares llegan en lotes de 100 piezas y su servicio contiene 5
piezas. Pueden prepararse como prefritos, pero únicamente bajo demanda: su stock
objetivo prefrito es cero y no forman parte de la reposición permanente de diez
servicios.

La presentación de crudo describe cómo se recibe o empaca. No obliga a producir
todo el paquete en una sola operación.

Regla de reposición:

```text
Cuando el stock prefrito baja de 10 servicios,
el sistema sugiere producir la diferencia para regresar a 10.
```

Diez servicios es un objetivo operativo, no una reserva automática de materia
prima ni una reposición obligatoria. Cocina o el Master pueden posponerla y
mantener temporalmente menos prefritos cuando el crudo deba priorizarse para la
venta frita. La sugerencia no descuenta ni compromete crudos hasta que la
producción sea aprobada y ejecutada.

La receta se expresa por servicio y registra la cantidad real producida sin
obligar a completar la bolsa recibida ni a producir exactamente diez. El lote
mínimo y la capacidad simultánea no bloquean el contrato inicial; podrán añadirse
después como parámetros de planificación. Mientras no estén configurados, la
decisión final permanece en el Master.

Tiempo estándar inicial:

```text
240 minutos
```

El tiempo incluye preparación, enfriamiento y empacado, y aplica a cualquier
prefrito, incluidos los tequeños regulares bajo demanda. Un pedido requerido antes
de completar esas cuatro horas puede enviarse al Master, pero se muestra como
dependiente de producción y no como existencia inmediata.

Vida útil operativa inicial:

```text
aproximadamente 3 meses
```

Para hacer cumplir la vida útil, una producción prefrita debe conservar lote,
fecha de producción, cantidad restante y vencimiento. El esquema actual solo
mantiene saldo agregado, por lo que el control de lotes y vencimientos permanece
como brecha de diseño.

### 7.1 Presentaciones prefritas nuevas

Al crear una presentación prefrita nueva se debe solicitar:

- nombre;
- componentes crudos;
- piezas de cada componente por servicio;
- cantidad de servicios que se producirán;
- stock objetivo;
- umbral de reposición;
- tiempo de preparación;
- vida útil;
- unidad y empaque;
- producto o productos comerciales que consumirán ese stock.

Ejemplo:

```text
1 servicio de mixto prefrito
= 3 mini tequeños crudos
+ 3 empanadas crudas
+ 3 cachitas crudas
+ 3 bombys crudos
```

Producir diez servicios registra:

```text
-30 mini tequeños crudos
-30 empanadas crudas
-30 cachitas crudas
-30 bombys crudos
+10 servicios de mixto prefrito
```

El servicio mixto queda almacenado como stock propio. No se descuenta
silenciosamente desde los servicios prefritos individuales.

### 7.2 Producto prefrito y producto frito

Una presentación vendida como prefrita consume un servicio prefrito. Una
presentación frita normal consume directamente las piezas crudas declaradas por
su receta; no consume el stock prefrito.

Los mixtos fritos también deben consumir directamente sus componentes crudos.
Su composición exacta se revisa por producto.

#### Medios servicios fritos

La venta por medio servicio es una capacidad explícita de cada producto, no una
consecuencia automática de ser frito. Los productos crudos y prefritos no
admiten medio servicio.

Servicios confirmados que sí admiten medio servicio:

- mini tequeños fritos;
- empanadas fritas;
- cachitas fritas;
- mandocas fritas;
- bombys fritos;
- Dondys, cuyo servicio de 6 queda en 3 piezas.

Servicios confirmados que no admiten medio servicio:

- tequeños regulares fritos;
- todos los mixtos fritos.

La cantidad física consumida por medio servicio se calcula por piezas enteras:

```text
piezas de medio servicio = floor(piezas del servicio completo / 2)
```

Por tanto:

- un servicio de 25 piezas consume 12 piezas cuando se vende como medio servicio;
- un servicio de 20 piezas consume 10 piezas;
- para cantidades como 1,5 servicios se consume un servicio completo más la
  cantidad explícita del medio servicio.

El inventario nunca registra media pieza ni aplica redondeo contable posterior.
Cada producto debe declarar `allows_half_service`; la regla debe formar parte de
la receta de deducción y no solo del texto que se muestra en cocina o en el
resumen del pedido.

### 7.3 Dondys

Los Dondys llegan crudos en bolsas o lotes de 30 piezas y no tienen etapa
prefrita. Se venden en presentaciones de 6, 3 o 1 pieza y también participan en
combos y Vivo Box. Cada venta o componente debe consumir del mismo inventario
crudo canónico la cantidad exacta de piezas incluida.

En el centro de inventario, el único saldo físico se identifica como `Dondys
Crudos`, pertenece a la familia `Crudos`, se cuenta en UND y admite la
presentación de entrada `Bolsa de 30`. En el catálogo, `Dondys`, `Dondy (und)` y
sus variantes promocionales pertenecen a la familia comercial `Fritos`. Esta
distinción no crea dos existencias: todos descuentan del mismo Dondy crudo.

El producto de 3 piezas corresponde a medio servicio del producto `Dondys` de 6.
La presentación de 1 pieza es otro producto comercial independiente (`Dondy
(und)`), aunque ambos descuentan del mismo inventario crudo.

## 8. Salsas

Las salsas admiten varias etapas inventariables cuando cada etapa se almacena y
se cuenta:

```text
base de mayonesa
+ mezcla de verduras
-> salsa tártara a granel
-> salsa tártara porcionada
-> venta
```

Pueden coexistir:

- bases;
- preparado intermedio;
- salsa terminada a granel;
- unidades listas.

Ejemplo:

```text
Existencia física:
1.200 g de tártara a granel
6 salsas listas

Capacidad:
20 porciones desde granel
6 listas
26 equivalentes inmediatos
```

Los 20 equivalentes no son 20 unidades físicas hasta registrar el
porcionamiento.

La disponibilidad inmediata puede incluir:

```text
unidades listas
+ porciones obtenibles del granel
+ porciones producibles inmediatamente desde bases
```

La capacidad desde bases se calcula con el ingrediente limitante.

Cuando una venta se prepara directamente desde los insumos, la transformación y
el consumo deben quedar enlazados en una operación trazable.

### 8.1 Salsa tártara

Fórmula operativa confirmada:

```text
por cada 1 kg real de mayonesa utilizada
+ 0,050 kg de menjurje
```

Esta es una proporción de formulación, no una promesa de rendimiento terminado.
La mayonesa se recibe en recipientes comerciales cuyo contenido neto varía por
marca y lote: un envase llamado galón puede declarar 4 kg o aproximadamente
3,760 kg, y un envase llamado kilo puede declarar aproximadamente 940 o 960 g.
El contenido neto declarado puede conservarse como dato del lote de entrada,
pero el negocio cuenta físicamente recipientes.

La salsa preparada puede coexistir en varias presentaciones físicas:

- envases de 1 kg;
- envases de galón;
- porciones listas de 1 oz;
- porciones listas de 2 oz;
- porciones listas de 5 oz;
- remanente de tártara preparada a granel.

La producción se registra por rendimiento real. Por ejemplo:

```text
Entrada:
-1 envase de mayonesa del lote utilizado
-cantidad correspondiente de menjurje

Salida real declarada:
+2 envases de tártara tipo kilo
+N porciones de 5 oz
+M porciones de 2 oz
+remanente, si se decide contabilizarlo
```

No se calcula automáticamente un único peso de salida ni se obliga a que la suma
nominal de los recipientes coincida exactamente con la etiqueta de la mayonesa.
Las unidades canónicas del producto terminado son los recipientes efectivamente
llenos. El envase tipo kilo conserva su nombre operativo aunque su capacidad real
pueda rondar 940 o 960 g.

Normalmente se mantienen porciones listas de 1, 2 y 5 oz. Si faltan porciones
listas pero existen mayonesa y menjurje suficientes, cualquiera de las tres se
considera de disponibilidad inmediata. La confirmación comercial debe mostrar
capacidad equivalente; el movimiento físico de transformación se registra
cuando realmente se prepara o porciona.

`Salsa Tártara 5oz` y `Salsa Tártara 5oz Obsequio` son dos productos comerciales
que consumen exactamente el mismo ítem físico de salsa de 5 oz. La diferencia de
precio no crea un inventario separado.

Un envase de galón puede conservarse como stock preparado y luego convertirse en
porciones menores. El sistema debe evitar contar simultáneamente el galón y las
porciones obtenidas de él.

Rendimiento operativo observado:

```text
1 envase de tártara tipo kilo -> aproximadamente 8 a 9 porciones de 5 oz
```

Para promesas futuras, mientras no exista un rendimiento más preciso por lote,
debe utilizarse el extremo conservador de 8 porciones. Para el saldo existente se
usan siempre los recipientes que fueron realmente llenados y contados.

Decisión confirmada: el rendimiento canónico conservador será siempre 8
porciones de 5 oz por cada envase tipo kilo de tártara, sin variar por marca.

Los recipientes abiertos o remanentes se cuentan como equivalentes fraccionarios
del recipiente completo. Las fracciones operativas admitidas son:

```text
0,25 = un cuarto de envase
0,50 = medio envase
0,75 = tres cuartos de envase
1,00 = un envase completo
```

Por ejemplo, `2,50` representa dos recipientes completos y medio recipiente. La
fracción representa contenido utilizable, no cantidad de envases vacíos.

Los productos comerciales por galón o por kilo pueden activarse solo para el
cliente mayorista que los compra. Su activación comercial temporal no elimina el
ítem físico ni su trazabilidad de inventario.

### 8.2 Aderezo mostaza miel

El aderezo llega terminado en envases de 1 kg. Se porciona y se mantienen
unidades listas de 2 y 5 oz.

Rendimiento operativo inicial:

```text
1 envase de 1 kg -> aproximadamente 8 porciones de 5 oz
1 envase de 1 kg -> aproximadamente 20 porciones de 2 oz
```

El rendimiento de 2 oz se deriva proporcionalmente del rendimiento operativo
confirmado de 5 oz (`8 x 5 / 2 = 20`). No se usa una conversión teórica de onzas
a gramos para reemplazar este rendimiento real. Cuando se porciona, se descuenta
el envase o peso a granel y se crean las unidades listas correspondientes.

### 8.3 Menjurje

El menjurje se almacena y cuenta en recipientes tipo kilo. El saldo operativo se
expresa como recipientes equivalentes y puede contener fracciones, por ejemplo
`2,50` recipientes.

Para la receta, un recipiente completo equivale nominalmente a 1 kg y el consumo
se registra con la precisión necesaria (`0,050` recipientes por cada kg real de
mayonesa). El conteo físico puede expresarse en cuartos de recipiente. Si el
conteo no coincide con el saldo calculado, la diferencia se registra como ajuste
o merma y nunca se sobrescribe el historial.

## 9. Momento del consumo

El consumo ocurre cuando ocurre el hecho físico, no universalmente al entregar
la orden.

Etapas conceptuales:

- `kitchen`: insumos consumidos durante preparación;
- `production`: transformación por lote;
- `packing`: empaques o porciones utilizados;
- `fulfillment`: bebida o terminado que sale al cliente o motorizado.

Reglas:

- una operación se registra una sola vez;
- una cancelación anterior al consumo no genera movimiento;
- una cancelación posterior no borra el consumo;
- si algo vuelve físicamente y es reutilizable, se registra retorno;
- si no puede reutilizarse, se registra merma;
- ninguna cancelación elimina movimientos históricos.

## 10. Libro físico y tipos de movimiento

El libro debe ser inmutable. Una corrección genera un movimiento compensatorio.

Tipos conceptuales mínimos:

- `opening_balance`;
- `purchase_receipt`;
- `production_input`;
- `production_output`;
- `sale_consumption`;
- `internal_consumption`;
- `customer_return`;
- `supplier_return`;
- `waste`;
- `damage`;
- `quality_control_consumption`;
- `stock_count_adjustment`;
- `administrative_adjustment`;
- `reversal`.

`waste` debe conservar una clasificación operativa que permita distinguir merma
y avería sin crear productos o ítems paralelos.

Cada movimiento debe registrar:

- ítem;
- cantidad en unidad base;
- tipo;
- actor;
- fecha real;
- motivo;
- referencia de orden, recepción, producción, conteo o reverso;
- grupo de operación;
- clave de idempotencia.

`inventory_items.current_stock_units` es una proyección rápida. No se edita
directamente.

`products.current_stock_units` no es autoridad y debe retirarse o derivarse
durante la migración.

Para un ítem de `periodic_count`, el libro contiene como mínimo:

- recepciones;
- conteos;
- diferencias encontradas;
- mermas o salidas manuales conocidas, cuando existan.

No se crea un movimiento ficticio por cada orden. La diferencia entre el saldo
anterior, las entradas y el nuevo conteo permite observar el consumo no
atribuido del período.

## 11. Números que no deben mezclarse

### 11.1 Existencia física

Lo que existe ahora según movimientos y conteos.

### 11.2 Asignado o reservado

Existencia real comprometida con órdenes confirmadas cercanas.

No es una salida física.

### 11.3 Disponible operativo

```text
existencia física - asignaciones aplicables
```

### 11.4 Capacidad producible inmediata

Cantidad obtenible ahora mediante recetas declaradas inmediatas.

### 11.5 Capacidad futura

Cantidad obtenible después de producción o reposición.

### 11.6 Demanda futura

Pedidos o contratos requeridos en otra fecha. No modifica el saldo físico.

### 11.7 Proyección

```text
saldo proyectado en t
= existencia real
+ entradas y producciones firmes disponibles antes de t
- compromisos requeridos antes de t
```

Un saldo negativo en una fecha futura representa un faltante proyectado, nunca
un movimiento ni un saldo físico negativo creado anticipadamente.

## 12. Flujo asesor y Master

### 12.1 Asesor

El flujo comercial selecciona primero la fecha y hora objetivo. Solo después
solicita y presenta el catálogo, porque la disponibilidad se evalúa para ese
`target_at`, no como una cifra general sin fecha. Counter aplica el mismo orden.

El asesor ve información mínima:

```text
Disponible sin afectar pedidos confirmados: 50.
La solicitud puede ser enviada al Master para revisión.
```

Una insuficiencia proyectada no impide enviar la solicitud.

La lectura es informativa: distingue disponibilidad protegida, dependencia de
reposición o producción y próxima disponibilidad conocida. Master conserva la
decisión final sobre la solicitud.

El contrato compartido es `inventory_catalog_availability_v1(target_at,
product_ids, surface)`. Siempre devuelve `inventory_blocks_submission = false`.
Los productos configurables piden primero su composición; los combos fijos se
resuelven hasta sus hojas físicas.

### 12.2 Demanda tentativa

La orden enviada por el asesor:

- aparece en la proyección;
- no reserva;
- no descuenta;
- espera decisión del Master.

### 12.3 Confirmación del Master

El Master reevalúa con datos actuales y puede:

- confirmar con existencia;
- confirmar dependiendo de producción o reposición;
- registrar una existencia o suministro que no estaba cargado;
- modificar cantidad u hora;
- devolver al asesor;
- rechazar;
- aprobar bajo riesgo con motivo.

La confirmación debe ser atómica para evitar que dos aprobaciones utilicen la
misma capacidad.

### 12.4 Confirmación dependiente

Si un pedido se confirma usando una fuente futura, la dependencia es estructural,
no una nota libre.

Ejemplo:

```text
Pedido confirmado
-> depende de 150 unidades
-> reposición esperada mañana a las 12:00
```

El Master debe ver la fuente, cantidad usada, hora y margen restante.

### 12.5 Estado de implementación auditado el 2026-08-10

La lectura informativa ya existe, pero la decisión estructurada todavía no se
persiste. `inventory_preview_order_commitment_v1(order_id)` calcula de forma
transitoria `available`, `insufficient`, `relies_on_incoming`,
`outside_horizon`, `requires_opening` o `no_inventory_effect`. Sin embargo:

- `approve_order` recibe únicamente `order_id`;
- `reapprove_queued_order` recibe `order_id` y una nota general, no una decisión
  de inventario;
- `inventory_materialize_order_commitment_v1` crea todos los compromisos con
  `depends_on_flow_id = null`;
- no existe en `orders`, `inventory_planned_flows` ni en una relación auxiliar
  un modo de aprobación, motivo de riesgo o distribución cuantificada entre una
  orden y sus fuentes futuras.

Por ello, ninguna interfaz debe presentar todavía `Aprobar bajo riesgo` o
`Condicionar a reposición/producción` como una decisión persistida. Tampoco debe
reconstruir la relación por coincidencia de producto, cantidad o fecha.

El bloque que habilite esa decisión debe, como mínimo:

1. reevaluar la capacidad dentro de la misma transacción que confirma o
   re-confirma la orden;
2. recibir un modo explícito (`with_stock`, `depends_on_future` o
   `approved_at_risk`) y exigir motivo para el último;
3. guardar por cada compromiso la fuente futura y la cantidad realmente
   asignada, admitiendo más de una fuente cuando corresponda;
4. registrar actor, fecha, motivo, resultado de capacidad y un evento visible
   para Master y Asesor;
5. definir qué ocurre al editar la orden y al reprogramar, cancelar, recibir o
   completar una fuente;
6. mantener la regla no bloqueante: una insuficiencia advierte y exige decisión,
   pero no puede impedir por sí sola el flujo autorizado por Master.

Hasta que ese comando atómico exista, Master Ops conserva la aprobación actual
y muestra inventario solamente como información operativa.

## 13. Reposiciones y ventanas de disponibilidad

Una indisponibilidad declarada por el Master tiene prioridad sobre una
estimación automática.

Estados conceptuales:

1. disponible;
2. disponibilidad por confirmar;
3. no disponible hasta una fecha;
4. no disponible sin fecha definida.

Ejemplo:

```text
Tequeños no disponibles
Disponibles nuevamente: viernes 12:00
Cantidad esperada: 100 servicios
Fuente: producción
```

La regla se aplica al ítem físico y se propaga a productos y combos.

Si un componente obligatorio no está disponible, el producto padre no está
disponible. Si es opcional, se deshabilita solo esa opción.

### 13.1 Cantidad conocida

Una reposición con fecha y cantidad permite reservar capacidad futura hasta
agotar esa cantidad.

### 13.2 Cantidad desconocida

Una fecha sin cantidad permite recibir solicitudes sujetas a confirmación, pero
no crea disponibilidad ilimitada.

### 13.3 Llegada anticipada

Cuando la mercancía llega, se registra una `purchase_receipt`. La expectativa se
concilia con la recepción para no contar dos veces.

Una llegada real anticipada vuelve a calcular disponibilidad desde su hora real.

La expectativa y la recepción tienen autoridades distintas:

- Master declara lo que se espera, con fecha, presentación y cantidad;
- cocina registra exclusivamente lo que recibió físicamente;
- solo la recepción real aumenta el saldo disponible.

Cada recepción cierra por completo la expectativa a la que se asocia, aunque la
cantidad real sea menor o mayor. Ejemplo:

```text
Master esperaba: 5 bolsas
Cocina recibió: 4 bolsas
Entrada real: 4 bolsas
Expectativa restante automática: 0
```

La bolsa faltante no permanece proyectada. Si fábrica confirma que todavía la
producirá o enviará, Master debe crear una expectativa nueva. Esto evita que una
proyección desactualizada invente disponibilidad futura.

La diferencia entre esperado y recibido puede conservarse para auditoría y
notificación, pero no es saldo, deuda de inventario ni recepción pendiente. Si
llega más de lo esperado, se ingresa todo lo recibido y también se cierra la
expectativa. Cocina puede registrar una recepción no planificada sin expectativa
previa.

Después de conciliar se recalculan inmediatamente los pedidos que dependían de la
expectativa. Si la cantidad real no los cubre, se notifica al Master conforme a
la regla de incumplimiento.

### 13.4 Incumplimiento

Se notifica inmediatamente al Master cuando:

- vence la hora y no llega la reposición;
- llega menos;
- cambia la fecha;
- se cancela;
- una producción termina tarde;
- la producción rinde menos;
- una merma o conteo reduce capacidad comprometida.

El sistema identifica los pedidos afectados. No los cancela automáticamente. El
Master decide si consigue otra fuente, reprograma, modifica o devuelve al asesor.

## 14. Asignación temporal y prioridad

Todos los eventos se evalúan por su hora de necesidad operativa, no solo por la
hora de entrega al cliente.

Ejemplo:

```text
Entrega al cliente: 12:00
Necesidad en cocina: 11:30
Disponibilidad del insumo: 12:00
Resultado: no viable para esa entrega
```

Los compromisos confirmados se ordenan por hora requerida. El Master puede
cambiar prioridad, dejando auditoría.

Para aprobar una solicitud nueva se simula la línea de tiempo completa de
existencias, entradas firmes y compromisos. La aprobación normal solo procede si
el saldo relevante no queda negativo.

## 15. Horizonte operativo de diez días

VIVO Ops usará inicialmente un horizonte móvil configurable de 10 días.

```text
Requerido dentro de 10 días
-> entra en disponibilidad, reservas y alertas operativas

Requerido a más de 10 días
-> permanece como demanda futura
-> no reduce disponibilidad actual
```

La entrada al horizonte se calcula desde la hora de necesidad operativa.

### 15.1 Contratos y eventos grandes

Un contrato futuro crea demanda fechada, no un descuento.

Ejemplo:

```text
Stock físico actual: 550
Contrato dentro de 30 días: 2.000
Disponible actual: 550, salvo otros compromisos cercanos
Demanda futura: 2.000
```

Cuando entra al horizonte:

- se revisa su plan de abastecimiento;
- se calculan lotes, insumos y tiempos;
- se alerta si está descubierto;
- no se coloca el stock físico en negativo.

### 15.2 Alerta anticipada de capacidad

Un volumen que requiera más de 10 días puede alertar antes sin afectar el stock.

Se separan:

- horizonte de afectación operativa: 10 días;
- horizonte de alerta de capacidad: dinámico.

## 16. Nivel crítico

Cada ítem físico puede tener un nivel crítico.

La alerta usa disponibilidad proyectada, no solo saldo físico:

```text
existencia física
- compromisos aplicables
+ entradas firmes aplicables
```

Cuando llega al umbral, el Master debe definir:

- cuándo se repone;
- cuánto se espera;
- fuente;
- grado de certeza.

El nivel crítico alerta; no inventa stock ni desactiva automáticamente el
producto.

Para ítems de `periodic_count`, el nivel crítico se calcula principalmente desde
el último conteo válido y las entradas posteriores. También pueden definirse:

- frecuencia de conteo;
- stock objetivo;
- cantidad sugerida de reposición;
- consumo promedio observado entre conteos.

La alerta confirmada de un ítem de conteo periódico se evalúa inmediatamente al
confirmar cada conteo y después de cada entrada o ajuste. El umbral y su comparador
son configurables por ítem (`<` o `<=`), porque “por debajo de 100” no significa lo
mismo que “100 o menos”. Entre conteos puede mostrarse una alerta predictiva basada
en el ritmo histórico, pero debe etiquetarse como estimación y nunca alterar el
saldo físico.

El consumo observado entre dos conteos puede derivarse sin atribuirlo a pedidos:

```text
saldo físico del conteo anterior
+ entradas netas posteriores
- saldo físico del conteo actual
= consumo observado del período
```

La política de reposición debe evolucionar por ítem y admitir, cuando se conozcan:

- umbral crítico y stock objetivo;
- tiempo de entrega o preparación;
- días habituales de despacho o fabricación;
- presentación, múltiplo y mínimo de compra;
- proveedor o fuente habitual;
- consumo promedio y cobertura estimada en días;
- responsable y destinatarios de la alerta.

Estas reglas permiten generar una alerta de procura o producción antes del
agotamiento. La alerta propone una acción; nunca crea una recepción ni modifica
stock por sí sola.

Llegar al nivel crítico genera una necesidad de compra o reposición. La solicitud
no aumenta existencias; solo una recepción real lo hace.

### 16.1 Centro de alertas de inventario

Las alertas de inventario deben concentrarse en un apartado propio, agrupadas por
tipo de trabajo. Los módulos pueden mostrar un indicador y enlazar al caso, pero no
deben repetir toda la información ni mezclar todos los avisos en una sola lista.

Bandejas canónicas:

1. `Conteos y diferencias`:
   - conteo vencido u omitido;
   - diferencia superior al umbral de revisión;
   - variación inexplicada;
   - reconteo solicitado;
   - investigación sin resolver.
2. `Procura`:
   - existencia confirmada bajo el mínimo;
   - cruce predictivo del mínimo antes del próximo conteo;
   - gestión de compra todavía no iniciada;
   - reposición esperada vencida, incompleta o cancelada.
3. `Producción y abastecimiento`:
   - prefrito o preparado bajo su objetivo;
   - fecha máxima para iniciar una receta;
   - producción esperada en riesgo;
   - compromiso dependiente de una fuente que puede incumplirse.
4. `Configuración y calidad de datos`, visible principalmente para Admin:
   - ítem sin política, unidad, frecuencia o responsable;
   - producto con resolución ambigua o doble ruta de descuento;
   - conteo inicial pendiente o información excesivamente desactualizada.

La magnitud que convierte una diferencia en alerta destacada no será global. Cada
ítem o familia puede configurar una tolerancia absoluta, porcentual o ambas. Toda
diferencia sigue visible en el reporte aunque no alcance esa tolerancia.

Cada alerta tiene como mínimo:

- categoría, severidad e ítems afectados;
- hecho que la originó y vínculo al reporte o movimiento;
- responsable o área encargada;
- estado `new`, `acknowledged`, `in_progress`, `waiting_supply`, `resolved` o
  `dismissed_with_reason`;
- fecha de creación, vencimiento cuando aplique y última actualización;
- historial de decisiones y notas.

Una notificación comunica que ocurrió algo —por ejemplo, se entregó un inventario—;
una alerta representa una condición que requiere atención. Abrir o aceptar una
notificación no resuelve automáticamente la alerta relacionada.

Para evitar saturación:

- el resumen muestra cantidades por bandeja y únicamente los casos prioritarios;
- la vista detallada contiene todos los casos activos con filtros por fecha, ítem,
  área, severidad, estado y responsable;
- varios eventos del mismo problema se agrupan en un caso sin perder su historial;
- lo resuelto sale de la bandeja activa y permanece en trazabilidad;
- Master ve las bandejas operativas completas;
- Admin ve además configuración, calidad de datos y acciones de reverso;
- cocina ve solo tareas que debe ejecutar, como conteos y reconteos.

### 16.2 Decisiones iniciales para bebidas

Todas las bebidas se cuentan individualmente por botella o lata y cada venta
descuenta una pieza del mismo ítem físico. Las cajas y paquetes son conversiones
de recepción, no existencias paralelas:

| Presentación recibida | Conversión inicial |
| --- | ---: |
| Caja de Pepsi lata | 24 piezas |
| Caja de Malta lata | 24 piezas |
| Caja de Coca-Cola lata | 12 piezas |
| Caja de Yukipack 250 cm³ | 24 piezas |
| Paquete de botellas de 1 L | 6 piezas |
| Paquete de botellas de 1,5 L | 6 piezas |
| Paquete de botellas de 2 L | 6 piezas |

`Coca-Cola 1,5 L` y `Coca-Cola 1,5 L Mayor` son productos comerciales con precio
distinto, pero consumen el mismo ítem físico. Los productos promocionales o
históricos que duplican `Pepsi lata` o `Malta lata` también consumen el ítem
normal correspondiente y no mantienen saldos propios.

`Yukipack` es un jugo individual de 250 cm³ en envase pequeño de cartón. No es un
combo ni un paquete compuesto: se cuenta y descuenta a sí mismo por unidad,
utiliza el umbral inicial de 10 y puede recibirse por caja de 24 o por unidades
sueltas. El nombre actual `Yukypack` se normalizará a la denominación confirmada
`Yukipack`.

El umbral inicial para cada bebida es 10 piezas. La alerta se activa cuando la
disponibilidad llega a 10 o menos y debe comunicar que quedan las últimas diez o
la cantidad real inferior.

El umbral pertenece al ítem físico, porque varios productos comerciales pueden
compartirlo. Puede exponerse y editarse desde la ficha del producto del catálogo,
pero todas las presentaciones enlazadas deben ver el mismo valor. Más adelante el
Master podrá ajustarlo por rotación, frecuencia de despacho y confiabilidad del
proveedor.

## 17. Combos y snapshot de pedido

`product_components` describe la oferta comercial.

`order_item_components` debe conservar lo que el cliente eligió realmente.

No se deben codificar selecciones canónicas únicamente dentro de
`order_items.notes`.

Al confirmar una orden debe congelarse su requerimiento físico:

- producto vendido;
- componentes seleccionados;
- ítems requeridos;
- cantidades;
- etapa;
- hora requerida;
- política y receta vigentes.

Una modificación posterior del catálogo no cambia silenciosamente pedidos ya
confirmados.

Reglas operativas confirmadas para los productos actuales:

- `Single Pack 6`, `8` y `10` permiten distribuir libremente el total indicado
  entre mini tequeños, empanadas, cachitas, mandocas y bombys;
- la salsa tártara de 1 oz es opcional y solo se descuenta cuando el cliente la
  solicita;
- `Vivo Box 6`, `8` y `10` permiten seleccionar respectivamente 6, 8 o 10 piezas
  de las cinco familias anteriores y agregan siempre, fuera de ese total, 1 Dondy
  y 1 salsa tártara de 2 oz;
- el Dondy fijo debe resolver al ítem crudo canónico aunque la configuración
  histórica apunte a un producto promocional o inactivo;
- Baby, Sexy y Rumba normales son composiciones fijas;
- las versiones Ajustadas pueden cambiar sus componentes según la disponibilidad
  operativa y deben consumir la composición real vigente para esa orden;
- ningún Single Pack, Vivo Box o combo mantiene inventario propio por el mero
  hecho de ser un producto padre.

Para soportar futuros productos sin agregar lógica especial por nombre, una
composición solo puede activarse si:

- su total seleccionable y sus componentes obligatorios son válidos;
- todos sus componentes resuelven a un ítem físico o a una política `none`
  explícita;
- no crea ciclos de componentes;
- sus componentes opcionales quedan identificados en el pedido;
- su expansión no duplica enlaces directos del producto padre.

`order_item_components` debe congelar la selección comercial. Además, el pedido
confirmado debe conservar un snapshot de los requerimientos físicos resueltos,
porque una edición posterior de una versión Ajustada no puede cambiar reservas,
alertas ni consumos históricos.

### 17.2 Promociones, obsequios y beneficios

Un producto promocional conserva su identidad comercial, precio, elegibilidad y
motivo, pero no crea inventario físico propio por esa razón.

Esta regla aplica a productos identificados como:

- Beneficio del Mes;
- obsequio;
- cumpleaños;
- aniversario;
- Loyal;
- LC;
- Cliente Nuevo;
- otras promociones equivalentes.

Cada uno consume el producto o la composición que declara. Si representa la
misma presentación que un producto normal, comparte exactamente el mismo ítem
físico. Si declara componentes diferentes, se expanden esos componentes reales y
se congelan en el pedido.

Ejemplos:

- una salsa 5 oz de obsequio consume la misma salsa 5 oz normal;
- un Dondy de cumpleaños consume una pieza del Dondy crudo canónico;
- un Single Pack Loyal consume las piezas seleccionadas por el cliente;
- un prefrito de Beneficio del Mes consume el mismo servicio prefrito de la
  familia normal;
- un combo Ajustado consume su composición explícita vigente.

Queda prohibido mantener saldos separados para una promoción cuando la única
diferencia sea precio, campaña o cliente elegible.

Decisiones sobre productos históricos:

- `Desayuno Woman Premium + Salsa tártara 2oz` y su variante con bebida quedan
  como productos históricos no reactivables. No se intentará reconstruir una
  composición de inventario que no fue persistida de forma confiable;
- si se ofrece nuevamente un desayuno similar, se crea un producto nuevo con sus
  componentes explícitos;
- `Chiki Mix 6`, `8` y `10` son promociones históricas equivalentes a los Single
  Pack correspondientes y heredan su selección libre y salsa opcional;
- `Crema de Leche 2oz` y `Crema de Leche 5oz` quedan como ítems históricos no
  operativos: no se cuentan, no reciben saldo inicial y no generan alertas;
- `Empanadas de Cerdo Crudas` es un producto estacional que puede reactivarse en
  el último trimestre. Antes de reactivarlo debe completarse su presentación,
  cantidad por servicio y política física.

Un producto histórico sin composición confiable puede seguir apareciendo en
pedidos anteriores, pero no genera reconstrucciones retroactivas ni nuevos
movimientos de inventario.

### 17.3 Empanadas de cerdo

Existen dos líneas distintas y no deben confundirse por nombre o precio.

#### Temporada Pulled Pork

- producto estacional;
- el crudo llega en bolsas de 100 piezas;
- la unidad de inventario es `pieza cruda`;
- se vende únicamente frita;
- cada servicio contiene 20 piezas;
- admite servicio completo de 20 y medio servicio de 10;
- no mantiene inventario prefrito;
- la venta de un servicio frito consume 20 piezas crudas directamente.

La fila actual `Empanadas de Cerdo Crudas` tiene `units_per_service = 20`, pero su
autoenlace descuenta solo 1 pieza. Antes de reactivarla debe corregirse el nombre
comercial y reemplazar el autoenlace por la receta de 20 piezas crudas para la
versión frita.

#### Producto especial para restaurante

- producto comercial distinto, con precio especial;
- receta física distinta de Pulled Pork y, por tanto, ítem crudo separado;
- se fabrica o procura bajo demanda aproximadamente una vez al mes;
- se prepara la cantidad solicitada, sin bolsa o lote fijo obligatorio;
- la recepción o producción se registra por piezas exactas;
- se empaca en servicios de 20 piezas;
- el restaurante las recibe crudas;
- se trabaja inicialmente solo con servicios completos de 20;
- anticipación operativa habitual: 10 días;
- stock objetivo ordinario: 0;
- su disponibilidad futura depende de una producción o entrada firme, no de
  inventario supuesto.

El pedido del restaurante genera demanda futura sobre este ítem específico. Una
producción planificada puede cubrir esa demanda, pero no aumenta el stock físico
hasta que la cantidad haya sido realmente fabricada y recibida. Al despachar el
pedido se descuentan las piezas crudas entregadas.

### 17.1 Eventos y pedidos abiertos

`Pack para Eventos` no representa una receta fija de 110 piezas. Representa una
cotización configurable para un evento o institución, con cantidades abiertas y
condiciones particulares.

Modelo canónico propuesto:

- un producto comercial `Evento personalizado`, con política `components`;
- sin límite fijo de piezas;
- selección de cantidades enteras de cada producto físico requerido;
- componentes adicionales opcionales de salsa o bebida cuando correspondan;
- conceptos comerciales no físicos como stand, montaje, personal o servicio,
  cada uno con política `none`;
- modalidad de preparación por cada grupo de piezas;
- instrucciones de empaque y servicio congeladas en la orden;
- precio total negociado independiente de la resolución física del inventario.

`Evento personalizado` es el configurador base, no el único tipo permitido. El
catálogo debe permitir crear posteriormente otros productos o plantillas de
evento con componentes fijos, seleccionables u opcionales, sin agregar lógica de
inventario por nombre.

Modalidades confirmadas para un componente de evento:

| Modalidad | Requerimiento físico | Momento operativo |
| --- | --- | --- |
| `fried_before_dispatch` | piezas crudas de la familia | se fríen en cocina antes del despacho |
| `fried_on_site` | piezas crudas de la familia | se trasladan crudas y se fríen en el evento |

No existe modalidad de entrega cruda al cliente para eventos. Las dos modalidades
válidas reservan y descuentan las mismas piezas crudas, pero cambian la hora en
que deben estar disponibles, el lugar de preparación y la capacidad operativa
requerida. Cuando se fríe en el sitio se agrega un concepto comercial de servicio
de fritura con política `none`; el cobro del servicio no duplica el consumo de
producto.

Un mismo evento puede combinar ambas modalidades en componentes diferentes.

En este configurador, la cantidad seleccionada de un producto frito representa
piezas concretas para el evento, no servicios comerciales completos. Por ejemplo:

```text
Evento personalizado
- 500 mini tequeños fritos
- 300 empanadas para freír en el sitio
- 100 cachitas fritas desde cocina
- servicio de fritura en sitio [none]
- 1 servicio de stand [none]
```

El inventario resuelve las 900 piezas a sus crudos correspondientes. El stand
forma parte de la cotización y de la operación, pero no genera saldo ni consumo
de inventario.

Si en el futuro se desea controlar el retorno físico del stand, freidoras u
otros equipos, eso corresponde a activos retornables y no debe mezclarse con el
kardex de consumibles de esta primera fase.

El precio negociado no cambia las cantidades físicas. El repositorio ya contiene
mecanismos de precio administrativo especial; cualquier ampliación del flujo de
cotización corresponde al módulo comercial y debe diseñarse aparte antes de
modificar Master o finanzas.

`Pack para Eventos` y `Pack para Colegios` pueden mantenerse inactivos como
referencia histórica después de migrar al configurador abierto. Los pedidos
históricos no se reinterpretan.

La modalidad de preparación debe quedar estructurada junto con cada componente
del pedido; no debe depender únicamente de texto libre. La auditoría encontró la
tabla `order_item_components`, pero no contiene selecciones persistidas y el
flujo actual no la utiliza de forma canónica. Antes de proponer columnas o tablas
nuevas se debe auditar su esquema completo y decidir si puede alojar esta
información y el snapshot físico.

Para eventos lejanos se conserva la regla temporal acordada: la demanda puede
generar una alerta anticipada de capacidad, pero solo afecta la disponibilidad
operativa y las reservas dentro del horizonte de 10 días.

#### Salida, devolución y avería en fritura en sitio

Para un evento puede despacharse una cantidad de seguridad superior a la
cantidad presupuestada. Todo lo que sale queda temporalmente fuera de la
disponibilidad del local.

Al cerrar el evento se concilia:

```text
cantidad enviada
= cantidad utilizada
+ cantidad devuelta utilizable
+ cantidad averiada o perdida
```

La devolución utilizable vuelve al inventario mediante un movimiento positivo
referenciado al mismo evento. La avería se registra por separado y nunca vuelve
como existencia disponible.

La salsa en eventos es opcional. Puede configurarse como porciones listas o como
recipientes preparados a granel, especialmente envases tipo kilo. Para salsa a
granel se concilia por recipientes equivalentes:

```text
salsa consumida
= recipientes enviados
- recipientes devueltos utilizables
```

Ejemplo:

```text
1,00 envase tipo kilo enviado
-0,25 envase retornado
=0,75 envase consumido en el evento
```

Si durante el evento se solicita otro recipiente, se registra una salida
adicional vinculada al mismo evento. El remanente se cuenta con las fracciones
canónicas de 0,25, 0,50 o 0,75. Si se pierde o contamina, se clasifica como
avería en la conciliación.

Mientras no exista un modelo de ubicaciones o custodia, una implementación
posible sobre el libro actual es:

1. registrar salida provisional del evento;
2. registrar el retorno utilizable;
3. al conciliar, reclasificar la salida neta entre consumo y avería sin volver a
   descontarla.

La reclasificación debe ser atómica para evitar doble consumo. Antes de definir
la función exacta se auditan las capacidades de `inventory_movements` y sus tipos
existentes.

## 18. Entradas, conteos, mermas y ajustes

### 18.1 Entradas

Una recepción real registra cantidad, presentación, conversión, proveedor o
fuente, actor y fecha.

Master crea, modifica o cancela expectativas. Cocina es quien recibe físicamente
la mercancía y registra la recepción real. Al seleccionar una expectativa, cocina
confirma las bolsas, paquetes y unidades efectivamente recibidas; no confirma la
cantidad proyectada por defecto.

La captura debe permitir simultáneamente:

- cantidad de cajas, paquetes, bolsas o recipientes;
- conversión aplicada a cada presentación;
- fracción de presentación, cuando corresponda;
- cantidad de unidades sueltas adicionales;
- total calculado en la unidad base canónica.

La conversión se congela en la recepción porque puede cambiar por proveedor,
marca o lote. El usuario siempre puede omitir el empaque e ingresar directamente
la cantidad individual.

Una expectativa de recepción no aumenta inventario.

### 18.2 Conteo físico

El conteo registra:

- programa, turno o motivo del conteo;
- hora de corte y hora de confirmación;
- saldo esperado;
- movimientos netos desde el último conteo físico aplicable;
- saldo contado;
- diferencia;
- responsable;
- motivo;
- movimiento de ajuste resultante.

No reemplaza ni borra el historial.

Los conteos pueden organizarse por programa:

- por turno para ítems críticos y de alta rotación;
- diario;
- semanal;
- quincenal;
- mensual para cierre y revisión general;
- personalizado cuando un área lo necesite.

Un conteo físico es un solo hecho, aunque pueda servir simultáneamente para una
revisión diaria, semanal o mensual.

Cada programa declara:

- nombre y área;
- frecuencia y momento de vencimiento;
- ítems incluidos;
- responsable o permiso requerido;
- quién revisa diferencias;
- si es obligatorio y qué ocurre cuando se omite.

Los conteos operativos serán ciegos: durante la captura la persona no ve el saldo
esperado ni la diferencia calculada. Después de enviar, el sistema compara el
conteo con el saldo esperado y presenta el resultado según sus permisos.

El saldo esperado de cada línea se reconstruye desde su último conteo físico
confirmado más todas las entradas, salidas, producciones, consumos, devoluciones y
ajustes posteriores hasta la hora en que esa línea fue contada. Cada línea conserva
su propia `counted_at`. Así, el conteo no exige detener la operación: los movimientos
ocurridos después de contar una línea siguen aplicándose normalmente y no se pierden
cuando se confirma el ajuste.

Si aparece una diferencia, el conteo entra primero en revisión de cocina:

1. se conserva el primer conteo sin sobrescribirlo;
2. el sistema muestra el ítem y la diferencia detectada;
3. cocina puede realizar un segundo conteo físico;
4. si el reconteo resuelve la diferencia, se conserva también como evidencia;
5. si persiste, cocina confirma el resultado y agrega una clasificación o nota;
6. la confirmación final genera inmediatamente el ajuste de conteo y alinea el
   stock y la disponibilidad con la cantidad realmente contada;
7. Master y Admin reciben el caso para revisión posterior, sin que esa revisión
   sea una condición para aplicar el conteo.

Una diferencia persistente debe admitir motivos como:

- posible bolsa con menos o más piezas que su presentación declarada;
- recepción no registrada o registrada con cantidad incorrecta;
- devolución o movimiento no registrado;
- error de conteo ya descartado mediante reconteo;
- causa desconocida;
- otra, con nota.

La nota no es obligatoria cuando el reconteo corrige el problema. Cuando cocina
afirma conocer o sospechar una causa, debe registrarla. `Causa desconocida` sigue
siendo una opción válida y no obliga a inventar una explicación.

Para una bolsa sospechosa, el caso puede enlazarse a la recepción, presentación o
lote correspondiente y registrar la cantidad nominal y la cantidad contada. Por
ejemplo:

```text
Bolsa nominal: 200 piezas
Conteo verificado: 187 piezas
Diferencia: -13
Hipótesis: bolsa incompleta desde fábrica
```

Master o Administración pueden comparar el caso con los registros de fabricación,
marcarlo como revisado, solicitar otra verificación o dejarlo
`under_investigation`. El estado de revisión no suspende ni revierte el efecto del
conteo. Se conservan los conteos, explicación, decisión, actor y fecha para
analizar recurrencias por producto, lote o fuente.

Después de la confirmación final, la persona que realizó el inventario queda como
responsable del dato y ya no modifica ese conteo. Master puede solicitar un nuevo
conteo, pero no editar el resultado ni restaurar el saldo esperado anterior. El
último conteo físico confirmado continúa siendo la autoridad hasta que se confirme
otro. El nuevo conteo crea un registro y un movimiento nuevos, conservando el
historial completo. Solo Admin puede revertir un ajuste ya aplicado y debe hacerlo
mediante un reverso trazable.

La revisión existe en dos niveles:

- el cierre completo puede quedar `accepted` cuando Master está conforme;
- cada línea conserva su estado individual y Master puede seleccionar uno o varios
  ítems para `recount_requested` sin obligar a repetir el resto del inventario.

Cuando se solicita un reconteo, se crea una tarea dirigida a cocina con los ítems
seleccionados, el solicitante, la fecha y una nota opcional. La nueva captura vuelve
a ser ciega y muestra únicamente esos ítems. Al confirmarla, actualiza de inmediato
sus saldos y queda enlazada con el conteo original. Las demás líneas aceptadas no se
tocan. El estado agregado del cierre puede ser `accepted`, `recount_requested`,
`partially_reviewed` o `under_investigation`, pero la autoridad de stock siempre
permanece en el último conteo confirmado de cada ítem.

Un ítem puede pertenecer a varios programas. La periodicidad pertenece al ítem
físico y a sus programas, no a cada variante comercial. Puede mostrarse y
editarse desde la ficha de un producto, pero productos promocionales o mayoristas
que comparten el mismo ítem deben ver la misma configuración.

Programa inicial confirmado `Cierre por turno`:

- piezas crudas;
- servicios prefritos almacenados;
- salsas a granel y porcionadas;
- bebidas.

`Por turno` identifica el momento operativo del conteo, no un calendario rígido
de Turno 1 y Turno 2. Cocina inicia un conteo cada vez que ocurre una entrega o
cambio de guardia. Una fecha puede tener uno, dos, tres o más conteos, según lo
que realmente ocurrió. Solo puede existir uno abierto a la vez para la misma
fecha; al presentarlo puede iniciarse el siguiente.

El sistema no alerta por un supuesto segundo o tercer turno faltante. Al terminar
la fecha operativa, únicamente alerta si no se registró ningún conteo por turno.
La omisión continúa siendo informativa y nunca bloquea órdenes.

Al confirmar este programa, Master recibe una notificación que abre el reporte
completo del cierre, incluso cuando no haya diferencias. No se muestra solamente
una lista de alertas. El encabezado identifica fecha operativa, área, responsable, hora de
inicio, hora de cierre y estado de revisión. La tabla contiene todos los ítems
inventariados y, por cada uno:

- último conteo físico anterior;
- total de movimientos del sistema desde ese conteo hasta `counted_at`;
- saldo esperado a la hora del conteo;
- cantidad física contada;
- diferencia absoluta y porcentual;
- ajuste aplicado;
- movimientos ocurridos después de `counted_at` y saldo al cierre, cuando existan;
- responsable y hora de esa línea;
- estado de revisión y vínculo a reconteos relacionados.

Estas columnas son una fotografía inmutable del cierre. Al abrir el reporte más
tarde puede mostrarse además el `saldo vigente ahora`, claramente separado, para
que movimientos posteriores no parezcan una alteración del inventario entregado.

Master puede aceptar el reporte completo o seleccionar líneas específicas y pedir
su reconteo. La aceptación significa conformidad de supervisión y deja evidencia;
no es la acción que aplica el stock.

Además de los programas periódicos, existe el `conteo puntual` o `spot_count`. Se
usa cuando Master solicita personalmente verificar uno o varios ítems —por ejemplo,
contar mandocas antes de responder sobre un pedido— sin exigir un inventario total.
Cocina inicia el registro, selecciona solamente los ítems solicitados y puede
marcar su origen como `solicitud verbal de Master`. El resultado:

- se captura de forma ciega;
- queda registrado con responsable, hora y motivo;
- ajusta inmediatamente el inventario de los ítems contados;
- notifica a Master y aparece en el mismo historial de conteos;
- establece una nueva línea base física solo para esos ítems;
- no da por cumplido ni reemplaza el cierre por turno completo que corresponda.

Las cajas, vasos y otros suministros todavía no creados se clasificarán como
`periodic_count` y se asignarán individualmente a programas semanales,
quincenales, mensuales u otros. No se descuentan automáticamente por pedido.

El cierre de turno muestra únicamente los ítems asignados a ese programa. Los
conteos de supervisor se generan por separado y no bloquean el cierre normal de
cocina.

El conteo por turno es obligatorio, pero su omisión no bloquea pedidos, ventas ni
otras operaciones. Mientras el local siga abierto, un vencimiento genera una
alerta al Master para que solicite su realización. Si el local o turno ya cerró,
el programa queda con estado `missed` o `vencido_no_realizado`.

Un conteo omitido no se inventa ni se completa retroactivamente como si hubiera
ocurrido. El siguiente conteo se realiza normalmente y los reportes conservan el
vacío de control. Master puede gestionar el recordatorio, pero no falsear la hora
ni el responsable del conteo.

El conteo físico final reemplaza inmediatamente la proyección operativa en ambas
direcciones: si se encuentra menos, reduce el stock y la disponibilidad; si se
encuentra más, los aumenta. Este efecto y el movimiento de ajuste deben confirmarse
atómicamente. No existe un saldo positivo provisional pendiente de aprobación ni
una autorización de Master para reconocer el resultado contado. Si una revisión
posterior determina que debe repetirse el inventario, el nuevo conteo sustituye al
anterior mediante otro movimiento; nunca se sobrescribe el historial.

En suministros de uso variable, como cajas, el conteo es la autoridad operativa
para reposición. No se exige una relación uno-a-uno con las órdenes.

Ejemplo confirmado para cajas y vasos:

- son ítems físicos independientes por tipo o presentación;
- no se descuentan por salsa ni por pedido, porque el empaque real es variable;
- pueden tener un programa quincenal u otra frecuencia configurada;
- el reporte compara cada conteo con el anterior y muestra consumo observado,
  tendencia y cobertura estimada;
- cada presentación tiene su propio mínimo y objetivo;
- si el mínimo de una caja específica es 100, la condición “por debajo de 100”
  activa la alerta al confirmar un conteo de 99 o menos;
- la alerta inicia gestión de procura; puede pasar por `reconocida`, `en gestión`
  o `reposición esperada`, pero la condición crítica solo se resuelve cuando una
  recepción o conteo posterior saque al ítem del umbral;
- una compra esperada puede registrarse como planificación, pero solamente la
  recepción real aumenta el inventario.

### 18.3 Merma y avería

No son sinónimos y no deben mezclarse con diferencias inexplicadas de conteo.

#### 18.3.1 Avería

Una avería es una pieza que ya se frió, pero no cumple el estándar de calidad:
se abrió, quedó con mala apariencia o no puede entregarse al cliente. Puede tener
origen en fábrica o en la preparación, pero esa causa no es obligatoria.

Reglas confirmadas:

- cocina la registra desde su aplicación al cerrar el turno;
- producto o familia y cantidad son obligatorios;
- nota y causa son opcionales;
- no se exige fotografía;
- el movimiento afecta el inventario inmediatamente;
- el Master puede revisar, pero solo Admin puede corregir mediante reverso;
- la avería no espera aprobación para dejar de estar disponible;
- una avería representa consumo adicional de crudo: si se frieron reemplazos
  para completar una orden, no puede quedar escondida dentro del consumo normal
  de la venta.

#### 18.3.2 Merma

Una merma es una pieza cruda que, antes de freírse, presenta una forma o aspecto
que hace presumir que no cumplirá el estándar. No necesariamente está dañada. Se
aparta en una bolsa y deja de estar disponible para pedidos.

Se cuenta y registra una sola vez al cerrar cada turno. En ese momento se descuenta
definitivamente del inventario utilizable con clasificación `merma`. Aunque las
piezas permanezcan temporalmente en una bolsa, desde ese momento quedan fuera del
inventario controlado de VIVO Ops.

No se rastrea cuándo la bolsa sale hacia fábrica, no existe un cierre posterior y
no se genera otro movimiento. Lo relevante para operación y reporte es cuántas
mermas produjo cada turno y de qué familia fueron.

#### 18.3.3 Producto dañado

`dañado` es una clasificación adicional para producto inutilizable por accidente,
contaminación, vencimiento u otra condición distinta de la apariencia preventiva
de una merma o del fallo después de freír.

No se crea otro producto ni otro ítem físico llamado “dañado”. Se registra una
salida del mismo ítem con clasificación `damage`. La nota puede ser opcional al
inicio; producto y cantidad siempre son obligatorios.

#### 18.3.4 Prueba de calidad

Las piezas que cocina fríe y consume para comprobar la calidad son un consumo
operativo legítimo, no una venta, avería, merma ni diferencia inexplicada.

Debe existir la categoría `quality_control_sample`. Cocina puede reportar la
cantidad exacta durante el turno o junto con el cierre. No requiere fotografía ni
una explicación adicional y consume directamente las piezas crudas
correspondientes.

#### 18.3.5 Cierre de turno de cocina

Después de cada turno, cocina registra:

- conteo físico de existencias dentro de su alcance;
- averías del turno;
- mermas del turno;
- dañados conocidos;
- cantidad exacta de pruebas de calidad realizadas;
- nota opcional.

El sistema calcula la diferencia entre saldo esperado y contado después de
aplicar estos hechos conocidos. Una diferencia restante se registra como
`unexplained_variance` pendiente de revisión; no se convierte automáticamente en
avería ni merma.

### 18.4 Ajuste administrativo

Solo corrige una diferencia justificada. No se usa para registrar compras,
producción, devoluciones o consumos que tienen su propio tipo.

## 19. Permisos

| Capacidad | Asesor | Master | Cocina | Counter | Admin |
| --- | --- | --- | --- | --- | --- |
| Ver disponibilidad comercial | Sí | Sí | Sí, según operación | Sí, según operación | Sí |
| Enviar solicitud sobre disponibilidad | Sí | No aplica | No | Según flujo | Sí |
| Confirmar compromiso o excepción | No | Sí | No | No | Sí |
| Declarar ventana de disponibilidad | No | Sí | No | No | Sí |
| Registrar producción | No | Supervisar | Sí | No | Sí |
| Registrar consumo de cocina | No | Supervisar | Sí/automático | No | Sí |
| Registrar despacho de terminado | No | Supervisar | No | Sí/automático | Sí |
| Declarar recepción esperada | No | Sí | No | No | Sí |
| Registrar recepción real | No | No | Sí | No | Sí |
| Registrar avería, dañado o prueba de calidad | No | Consulta | Sí, efecto inmediato | No | Sí |
| Registrar merma del turno | No | Consulta | Sí, efecto inmediato | No | Sí |
| Capturar y confirmar conteo asignado | No | Según asignación | Sí, en su alcance | Según asignación | Sí |
| Ejecutar conteo periódico asignado | No | Según asignación | Según asignación | Según asignación | Sí |
| Registrar conteo puntual solicitado | No | Consulta | Sí, en su alcance | Según asignación | Sí |
| Revisar conteo y solicitar reconteo | No | Sí | No | No | Sí |
| Crear ajuste administrativo directo | No | No | No | No | Sí |
| Revertir ajuste de conteo | No | No | No | No | Sí |
| Revertir avería, merma, dañado o prueba | No | No | No | No | Sí |
| Configurar ítems, recetas y políticas | No | Consulta/propuesta | No | No | Sí |

RLS y funciones deben validar la misma autoridad. Ocultar un botón no es un
permiso.

## 20. Consistencia transaccional

Operaciones compuestas deben ejecutarse en base de datos como una unidad:

- bloquear ítems afectados en orden estable;
- validar actor y rol;
- revalidar configuración y estado;
- comprobar idempotencia;
- insertar movimientos;
- actualizar proyecciones;
- registrar dependencias y auditoría;
- confirmar todo o revertir todo.

No se permite:

- insertar un movimiento y actualizar saldo en llamadas independientes;
- descontar ítems uno por uno dejando una operación parcial;
- borrar movimientos para "resetear";
- confirmar dos pedidos sobre la misma capacidad por una carrera.

## 21. Reportes mínimos

### Vista operativa de Master

El apartado de inventario de Master debe incluir:

- lista operativa de ítems físicos, agrupable por familia y con los productos del
  catálogo que dependen de cada uno;
- último conteo físico, fecha, responsable y antigüedad por ítem;
- saldo esperado actual, calculado desde el último conteo más todos los movimientos
  posteriores;
- existencia física, asignado, disponible sin afectar confirmados y proyección;
- entradas o producciones esperadas por fecha, cantidad, fuente y certeza;
- nivel crítico, cobertura estimada y alertas de procura o producción;
- historial de sesiones: inventarios de hoy, ayer o cualquier período;
- detalle completo de cada sesión, diferencias, reconteos, explicaciones, actores,
  ajustes, revisiones y reversos.

El “saldo esperado ahora” no es otro inventario manual ni un campo editado por
Master. Es una proyección reproducible del libro:

```text
último conteo físico confirmado
+ entradas y producciones posteriores
+ devoluciones utilizables posteriores
- ventas y consumos posteriores
- pérdidas posteriores
+/- ajustes posteriores
```

### Vista de Administración

Administración consulta todo lo disponible para Master y, adicionalmente:

- crea y configura productos comerciales, ítems internos, recetas y presentaciones;
- define el modo de seguimiento y si el consumo ocurre por venta, producción o
  uso manual;
- asigna programas por turno, diarios, semanales, quincenales, mensuales o
  personalizados;
- configura umbrales, objetivos y reglas de reposición;
- administra permisos y responsables;
- investiga trazabilidad y ejecuta ajustes o reversos autorizados.

La vista administrativa debe permitir ampliar gradualmente la cobertura hasta
incluir los consumibles relevantes del negocio. Incorporar un ítem nuevo no obliga
a inventar una relación con pedidos: se selecciona la modalidad que represente su
consumo real.

### Operación actual

- existencia física;
- asignado;
- disponible sin afectar confirmados;
- nivel crítico;
- disponibilidad declarada;
- capacidad inmediata.

### Proyección de 10 días

- demanda confirmada;
- demanda tentativa separada;
- entradas y producciones esperadas;
- pedidos dependientes;
- faltantes por fecha;
- hora máxima de acción.

### Producción

- lotes esperados y reales;
- rendimiento;
- insumos consumidos;
- salida;
- merma;
- pedidos cubiertos.

### Pérdidas operativas y control de calidad

- averías por producto y turno;
- mermas por producto y turno;
- producto dañado;
- piezas utilizadas en pruebas de calidad;
- diferencias inexplicadas pendientes de revisión;
- tasa de avería sobre piezas preparadas, sin exigir causa por cada registro.

### Cumplimiento de conteos

- programas vigentes;
- conteos previstos, entregados, vencidos y omitidos;
- responsable y área;
- reporte completo de cada cierre con todos los ítems contados;
- último conteo anterior, movimientos netos, saldo esperado, saldo contado,
  diferencia, ajuste y saldo al cierre por línea;
- saldo vigente al consultar, separado de la fotografía histórica del cierre;
- aceptación general y estado de revisión por ítem;
- conteos puntuales y reconteos vinculados con su solicitud de origen;
- diferencias pendientes de revisión;
- último conteo válido por ítem;
- días desde el último conteo;
- comparación entre conteos por turno, semanales, quincenales y mensuales.

El reporte debe distinguir `vencido`, `omitido con local cerrado` y `realizado
fuera de hora`, sin convertir ninguno de esos estados en bloqueo comercial.

### Investigación de diferencias

- primer conteo y reconteo;
- diferencia persistente;
- motivo declarado o desconocido;
- recepción, presentación o lote sospechoso;
- cantidad nominal y cantidad verificada;
- estado sin revisar, aceptado, reconteo solicitado o en investigación;
- revisión de Master o Admin y reconteo o reverso posterior, si corresponde;
- recurrencia por producto, lote, turno y fuente;
- ajustes y reversos relacionados.

### Kardex

- saldo anterior;
- movimiento;
- saldo resultante;
- actor;
- referencia;
- reverso relacionado.

## 22. Reutilización y brechas

### Estructuras reutilizables

- `products`;
- `product_components`;
- `inventory_items`;
- `product_inventory_links`;
- `inventory_recipes`;
- `inventory_recipe_components`;
- `inventory_movements`;
- `order_item_components`.

### Capacidades no representadas canónicamente

- tiempo y capacidad de receta;
- snapshot físico del pedido;
- requerimiento fechado;
- reserva o asignación;
- horizonte operativo;
- reposición futura;
- ventana de indisponibilidad;
- producción planificada;
- dependencia pedido-suministro;
- conciliación expectativa-recepción;
- programas de conteo, pertenencia de ítems y responsables;
- proyecciones compartidas y vistas adaptadas por rol;
- política de reposición, responsables y alertas de procura;
- reversos estructurados e idempotencia del libro.

No se decide todavía si cada brecha requiere columna, tabla, vista o función.
Primero se revisa la matriz completa y el modelo de órdenes.

## 23. Migración y línea base

Antes de activar el nuevo centro de verdad:

1. clasificar todos los productos;
2. normalizar ítems y unidades;
3. resolver duplicados;
4. definir recetas, rendimientos y tiempos;
5. resolver los productos con composición y enlaces ambiguos;
6. desactivar relaciones por nombre;
7. realizar conteo físico;
8. registrar `opening_balance`;
9. conservar movimientos anteriores como historial legado;
10. activar comandos canónicos e integraciones por etapas.

No se reconstruye una historia falsa para explicar saldos anteriores.

## 24. Criterios de aceptación del contrato

El contrato estará listo para implementación cuando:

- todo producto tenga una política aprobada;
- todo ítem tenga unidad base;
- todo ítem tenga modo de seguimiento y disparadores coherentes;
- todas las recetas activas tengan insumos, rendimiento y tiempo;
- la etapa de consumo esté definida;
- la disponibilidad inmediata o programada esté definida;
- los productos ambiguos estén resueltos;
- se acuerde el modelo de requerimientos, reservas, reposiciones y dependencias;
- se apruebe la matriz de permisos;
- se acuerden categorías de alerta, tolerancias, responsables y estados de
  seguimiento;
- exista un plan de conteo inicial;
- se acuerden pruebas de escenarios.

## 25. Escenarios obligatorios de prueba

- bebida que se descuenta a sí misma;
- producto vendido que consume crudo;
- prefrito producido con cuatro horas;
- salsa inmediata desde bases;
- salsa a granel convertida en unidades;
- combo con selección real;
- producto agotado sin fecha;
- reposición con fecha y cantidad;
- reposición con fecha y cantidad desconocida;
- llegada anticipada;
- llegada menor a la esperada;
- pedido que depende de reposición;
- dos pedidos compitiendo por la misma existencia;
- contrato grande fuera del horizonte;
- entrada al horizonte de 10 días;
- cancelación antes y después del consumo;
- producción con rendimiento menor;
- merma;
- cierre por turno con reporte de todos los ítems;
- reconteo solicitado para un solo ítem;
- conteo puntual solicitado por Master;
- conteo y ajuste inmediato positivo o negativo;
- suministro de empaque controlado solo por conteo;
- alerta de reposición desde nivel crítico;
- alerta de diferencia grande agrupada con su investigación;
- procura reconocida y en gestión sin aumentar existencia;
- reverso idempotente.

## 26. Venta protegida hasta agotar el saldo

La lectura normal de inventario continúa siendo informativa y no impide crear,
aprobar, preparar, despachar ni entregar órdenes. La única restricción por
cantidad es una decisión explícita de Máster denominada **Vender solo hasta
agotar el saldo**.

Esta decisión se aplica a una familia física, no solamente a una presentación
comercial. Para Minis, Empanadas, Cachitas, Mandocas y Bombys, la capacidad
vendible de producto frito suma:

1. las unidades crudas libres;
2. el equivalente de los servicios prefritos disponibles;
3. menos la reserva de seguridad indicada por Máster.

El sistema asigna primero el crudo y utiliza prefrito únicamente para cubrir el
faltante. La asignación queda guardada en el snapshot de la orden para que el
compromiso y la salida física descuenten la misma fuente. Los combos fijos se
evalúan por sus componentes y los productos configurables por la selección real
hecha por el usuario.

Máster puede vincular una entrada esperada de cantidad conocida. Antes de esa
fecha solo se vende el saldo protegido; desde la fecha prevista vuelve a
considerarse la reposición. Si la entrada se cancela o falla, la familia no se
reabre automáticamente. Si no hay una fecha confirmada, la protección permanece
indefinida hasta que Máster la libere o se registre la recepción correspondiente.

Un conteo físico siempre prevalece. Si reduce el saldo por avería, merma u otra
diferencia y deja compromisos en riesgo, el sistema conserva la orden y genera
la alerta para Máster; no reescribe la realidad ni bloquea el flujo operativo.

La regla reutiliza `inventory_planned_flows`, `products.extra_fields` y
`orders.extra_fields`; no introduce tablas ni columnas nuevas. Las migraciones
vigentes son:

- `20260829170122_inventory_protected_family_sales_v1.sql`;
- `20260829203000_inventory_protected_family_reserve_fix_v1.sql`.
