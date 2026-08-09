# Bloque 17: simulacro y certificación previa a la apertura

## Resultado

El 8 de agosto de 2026 se ejecutó contra el proyecto Vivo Ops un simulacro
integral con el catálogo real. El resultado técnico fue **PASS**.

La prueba alcanzó temporalmente:

- 47 de 47 ítems con apertura aceptada;
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

- cero órdenes de prueba persistidas;
- cero movimientos de prueba persistidos;
- cero aperturas aceptadas en producción;
- cero recetas canónicas activas en producción;
- modo real todavía `legacy`;
- ninguna orden real bloqueada o modificada.

No se creó ninguna tabla, columna, migración ni bandera adicional. El certificado
es reproducible y deriva su resultado del estado real.

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

Yukipack fue contado como Manzana 14, Pera 14 y Durazno 22: total físico 50.
El catálogo vigente tiene un único ítem genérico `Yukypack`, por lo que ese total
no se autoriza como apertura definitiva hasta resolver cómo conservar la
disponibilidad por sabor.

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

`Aceite: 1,75` también quedó registrado, pero no existe hoy como ítem canónico
elegible y no se agregó durante este bloque. `Aderezo: un poquito` quedó como
cantidad no auditable y no se convirtió artificialmente.

## Pendientes para una apertura real

El motor está certificado, pero la apertura operativa sigue en **NO-GO** hasta
resolver los 11 ítems que no tienen una cantidad canónica exacta y utilizable:

| ID | Ítem | Pendiente |
|---:|---|---|
| 75 | Yukypack | Definir inventario por sabor o aceptar explícitamente un saldo genérico. |
| 48 | Cajas grandes | Conteo físico exacto. |
| 18 | Tequeños Regulares Pre-Fritos | Confirmar el conteo, incluso si es cero. |
| 22 | Aderezo Mostaza Miel 2oz | Conteo de porciones listas. |
| 23 | Aderezo Mostaza Miel 5oz | Conteo de porciones listas. |
| 78 | Aderezo Mostaza Miel a granel | Reemplazar “un poquito” por una fracción exacta del envase. |
| 9 | Salsa Tártara 1oz | Conteo de porciones listas. |
| 21 | Salsa Tártara 2oz | Conteo de porciones listas. |
| 8 | Salsa Tártara 5oz | Conteo de porciones listas. |
| 7 | Salsa Tártara a granel | Conteo exacto en recipientes y fracción. |
| 68 | Salsa Tártara Galón | Conteo exacto en recipientes y fracción. |

La ausencia de una línea en el conteo recibido no se interpreta como cero. Para
la prueba reversible se usó el total técnico de 50 en Yukypack y cero como valor
sintético en los otros 10 pendientes. Ninguno se guardó ni representa una
decisión operativa.

## Criterio de aprobación final

La apertura real solo puede ejecutarse cuando:

1. los 11 pendientes tengan una representación y un conteo exactos;
2. el Centro de Inventario siga mostrando estructura completa y sin errores de
   resolución de órdenes;
3. Administración presente el conteo ciego completo;
4. Master revise el reporte de los 47 ítems y acepte o solicite reconteos;
5. Administración active las 13 recetas después de la aceptación;
6. una auditoría final devuelva `ready_for_canonical_operation`.

La orden de prueba del simulacro fue una fixture transaccional necesaria para
certificar la integración. No se cambió código de Master, Counter ni Cocina.

## Evidencia reproducible

El protocolo ejecutable está en
`docs/inventory/INVENTORY_BLOCK_17_FULL_REHEARSAL_2026-08-08.sql`. Usa bloqueo
asesor transaccional, tiempos máximos y una verificación posterior al `ROLLBACK`.
