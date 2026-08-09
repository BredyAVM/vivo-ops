# Bloques 17–18: certificación previa a la apertura

## Resultado

El 8 de agosto de 2026 se repitió contra el proyecto Vivo Ops el simulacro
integral con el catálogo real y la separación de Yukipack por sabor. El resultado
técnico fue **PASS**.

La prueba alcanzó temporalmente:

- 48 de 48 ítems transaccionales con apertura aceptada;
- 13 de 13 recetas canónicas activas;
- modo canónico y `operational_ready = true`;
- entrada esperada de seis unidades frente a cinco recibidas, acreditando solo
  las cinco físicas;
- preparación prefrita con consumo inmediato del crudo y disponibilidad solo
  después de cuatro horas;
- preparación inmediata de salsa con consumo y salida atómicos;
- disponibilidad informativa para Asesor sin bloqueo de envío;
- entrega de una orden de Master con consumo canónico en la misma transacción.

El script terminó en `ROLLBACK`. La verificación independiente posterior confirmó:

- cero órdenes y movimientos de prueba persistidos;
- cero aperturas aceptadas en producción;
- cero recetas canónicas activas en producción;
- modo real todavía `legacy`;
- `structural_ready = true`;
- ninguna orden real bloqueada o modificada.

La preparación agregó configuración y funciones mediante migraciones, pero no
creó tablas ni columnas. Tampoco escribió saldos físicos, conteos, lotes,
movimientos, recetas nuevas u órdenes reales.

## Conteo físico recibido y normalizado

Estas respuestas quedan registradas para no volver a solicitarlas.

### Prefritos

| Ítem canónico | Conteo físico | Unidad canónica |
|---|---:|---|
| Mini tequeño prefrito | 7 | servicios de 25 piezas |
| Empanadas Pre-Fritas | 8 | servicios de 20 piezas |
| Cachitas Pre-Fritas | 10 | servicios de 20 piezas |
| Mandocas Pre-Fritas | 3 | servicios de 25 piezas |
| Bombys Pre-Fritos | 2 | servicios de 25 piezas |
| Tequeños Regulares Pre-Fritos | 0 | servicios de 5 piezas |

### Bebidas

Todas las cantidades son unidades individuales.

| Ítem canónico | Cantidad |
|---|---:|
| Pepsi 2 Lts | 4 |
| Pepsi 1,5 Lts | 8 |
| Pepsi 1 Lt | 9 |
| Malta Lata | 15 |
| Pepsi Lata | 29 |
| Lipton Durazno 1,5 Lts | 5 |
| Lipton Limón 1,5 Lts | 4 |
| Yukery Naranja 1,5 Lts | 5 |
| Yukery Manzana 1,5 Lts | 9 |
| Yukery Pera 1,5 Lts | 7 |
| Yukipack Manzana | 14 |
| Yukipack Pera | 14 |
| Yukipack Durazno | 22 |
| Coca-Cola 2 Lts | 16 |
| Coca-Cola Sin Azúcar 2 Lts | 0 |
| Coca-Cola 1,5 Lts | 20 |
| Coca-Cola 1 Lt | 0 |
| Coca-Cola Sin Azúcar 1 Lt | 0 |
| Coca-Cola Lata | 13 |
| Frescolita 2 Lts | 0 |
| Frescolita 1,5 Lts | 1 |
| Chinotto 2 Lts | 0 |
| Chinotto 1,5 Lts | 2 |
| Fanta Naranja 1,5 Lts | 6 |
| Jugo del Valle 1,5 Lts | 0 |

Yukipack quedó resuelto como un producto comercial con tres sabores físicos.
El saldo genérico legado no se trasladó ni se sumó.

### Crudos y bases

| Conteo informado | Conversión | Cantidad canónica |
|---|---|---:|
| Mini: 8 bolsas | 8 × 200 piezas | 1.600 piezas |
| Regulares: 18 unidades | sin conversión | 18 piezas |
| Empanadas: 5 bolsas | 5 × 150 piezas | 750 piezas |
| Cachitas: 3 bolsas | 3 × 150 piezas | 450 piezas |
| Mandocas: 4,25 bolsas | 4,25 × 100 piezas | 425 piezas |
| Bombys: 3,5 bolsas | 3,5 × 150 piezas | 525 piezas |
| Dondys: 4 bolsas + 5 unidades | 4 × 30 + 5 piezas | 125 piezas |
| Mayonesa: 1,25 potes de 3,3 kg | 1,25 × 3,3 kg | 4,125 kg |
| Menjurje: 7 potes de 1 kg | 7 × 1 kg | 7 kg |

`Aceite: 1,75` también quedó registrado, pero no existe hoy como producto
canónico elegible y no se agregó durante este bloque.

### Salsas listas

| Ítem canónico | Cantidad |
|---|---:|
| Salsa Tártara 5 oz | 10 |
| Salsa Tártara 2 oz | 10 |
| Salsa Tártara 1 oz | 10 |
| Aderezo Mostaza Miel 5 oz | 5 |
| Aderezo Mostaza Miel 2 oz | 3 |

Los productos del conteo de cierre que no aparecen en la relación se interpretan
como cero. `Aderezo a granel: un poquito` sí apareció en el conteo original, por
lo que todavía requiere una fracción exacta antes de usarlo en una apertura real;
el simulacro reversible utilizó cero únicamente como valor técnico para esa línea.

## Conteos periódicos fuera del corte

`Cajas grandes` no pertenece al inventario de cierre por turno. Conserva su
programa quincenal y su alerta de procura, pero no participa en los 48 ítems de
apertura transaccional. La referencia de “más de 150” no se convirtió en un saldo
exacto ni se guardó.

## Estado para una apertura real

El motor y la representación del catálogo están certificados, pero no se ejecutó
la apertura. El estado productivo correcto es `structure_ready_opening_pending`:

- 0 de 48 aperturas aceptadas;
- 0 de 13 recetas activas;
- pedidos sin bloqueo de inventario;
- decisión final todavía en Master.

Antes de una apertura real se necesita sustituir la cantidad no auditable del
aderezo a granel por una fracción exacta y obtener la autorización explícita para
ejecutar el conteo formal. Después, Master revisará el reporte completo y
Administración activará las recetas.

## Evidencia reproducible

- `docs/inventory/INVENTORY_BLOCK_18_TRANSACTION_TESTS_2026-08-08.sql` certifica
  sabores, catálogo ligero, disponibilidad no bloqueante y resolución física.
- `docs/inventory/INVENTORY_BLOCK_17_FULL_REHEARSAL_2026-08-08.sql` certifica el
  recorrido integral de 48 ítems y siempre termina en `ROLLBACK`.

No se cambió código del módulo de Master, Counter ni Cocina. La única adaptación
de interfaz fue la lectura mínima del catálogo de Asesor; Counter recibe los
componentes por su función ligera existente.
