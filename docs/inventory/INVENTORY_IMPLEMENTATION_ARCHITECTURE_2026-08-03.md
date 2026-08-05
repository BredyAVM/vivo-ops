# Arquitectura de implementación de inventario

Fecha: 2026-08-03

Estado: arquitectura aprobada; clasificación, políticas y recetas canónicas
aplicadas sin activar el motor canónico.

## 1. Resultado buscado

Inventario será el centro de verdad de cantidades. El catálogo podrá crecer sin
programar excepciones por nombre y sin levantar por chat los consumibles futuros.
Administración podrá crear o reutilizar productos, ítems, presentaciones, recetas
y reglas desde un configurador genérico.

El alcance inicial fue reconciliado contra el catálogo vivo: 143 productos y 76
ítems. Los ítems futuros se incorporarán desde el sistema.

## 2. Qué ya existe y se reutiliza

La revisión en vivo de Supabase confirmó estas estructuras:

| Estructura | Autoridad canónica propuesta | Decisión |
| --- | --- | --- |
| `products` | Identidad y oferta comercial | Reutilizar |
| `product_components` | Plantilla de componentes fijos, seleccionables y opcionales | Reutilizar |
| `order_item_components` | Selección comercial real del pedido | Reutilizar y completar su uso |
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

- referencia a operación atómica;
- referencia de origen estructurada;
- movimiento reversado, cuando aplique;
- saldo resultante opcional para auditoría;
- prohibición de borrar hechos contabilizados.

## 7. Estructuras nuevas justificadas por brechas reales

No se crean todavía. La revisión muestra que las tablas actuales no pueden
representar correctamente estas capacidades:

| Capacidad | Por qué no cabe de forma segura en lo actual |
| --- | --- |
| Presentaciones múltiples por ítem | `inventory_items` solo admite un nombre y factor de empaque |
| Operación atómica e idempotente | un hecho puede producir varios movimientos y hoy no existe encabezado común |
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

Los historiales, líneas de conteo, recetas y movimientos detallados se consultan
bajo demanda dentro del Centro de Inventario. Las proyecciones no reemplazan el
kardex ni se convierten en una segunda autoridad de stock.
